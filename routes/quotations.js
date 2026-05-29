'use strict';

/**
 * routes/quotations.js
 *
 * Quotation persistence: save, list, get by ID, get by quote number,
 * next quote number counter.
 */

const express = require('express');
const router  = express.Router();

const {
    ENTITY_QUOTATION,
    QUOTE_COUNTER_ID,
    QUOTE_COUNTER_START,
    QUOTATIONS_GSI_INDEX,
} = require('../utils/constants');

// Local constants
const MAX_SCAN_PAGES     = 200;
const DEFAULT_PAGE_SIZE  = 100;   // items returned per page

// Summary fields projected from DynamoDB — keeps scan/query pages small
const SUMMARY_NESTED_PATHS = [
    'id', 'quoteNumber', 'companyName', 'projectName',
    'customerName', 'quotationDate', '#sv',
    'assignedTo', 'checkedBy', 'emailLink',
    'gmailMessageId', 'billTo', 'shipTo', 'grandTotal',
];
const SUMMARY_PROJECTION = [
    'id', 'updatedAt', 'createdAt',
    ...SUMMARY_NESTED_PATHS.map(seg => (seg === '#sv' ? '#p.#sv' : '#p.' + seg)),
    ...SUMMARY_NESTED_PATHS.map(seg => (seg === '#sv' ? '#d.#sv' : '#d.' + seg)),
].join(', ');
const SUMMARY_EXPR_NAMES = { '#p': 'payload', '#d': 'data', '#sv': 'saved' };

const QUOTATIONS_LIST_LIMIT = 600;   // hard cap — never return more than this per page

// ── Cursor helpers ────────────────────────────────────────────────────────────

/**
 * Encode a DynamoDB LastEvaluatedKey (or a plain offset object) into a
 * URL-safe opaque string the client can pass back as ?cursor=.
 */
function encodeCursor(key) {
    if (!key) return null;
    return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/**
 * Decode the cursor back to a JS object.
 * Returns null if cursor is missing, empty, or corrupt — callers treat
 * null as "start from the beginning."
 */
function decodeCursor(cursor) {
    if (!cursor) return null;
    try {
        return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// ── Merge helpers ─────────────────────────────────────────────────────────────

const HEADER_KEYS = [
    'quoteNumber', 'companyName', 'projectName', 'customerName', 'quotationDate',
    'assignedTo', 'checkedBy', 'grandTotal', 'billTo', 'shipTo', 'emailLink', 'gmailMessageId',
];
const NON_EMPTY_KEYS = ['lineItems', 'tableHTML', 'headerHTML', 'termsText'];

function isEmptyStringish(v) {
    if (v == null) return true;
    if (typeof v === 'string') return v.trim() === '';
    return false;
}

function mergePayloadAndData(data, payload) {
    const merged = { ...(data || {}), ...(payload || {}) };
    HEADER_KEYS.forEach(key => {
        if (!isEmptyStringish(merged[key])) return;
        const dv = data?.[key], pv = payload?.[key];
        if (!isEmptyStringish(dv)) merged[key] = dv;
        else if (!isEmptyStringish(pv)) merged[key] = pv;
    });
    NON_EMPTY_KEYS.forEach(key => {
        const cur = merged[key];
        const dv  = data?.[key], pv = payload?.[key];
        const curEmpty     = cur == null || (Array.isArray(cur) && cur.length === 0);
        const dvNonEmpty   = Array.isArray(dv) && dv.length > 0;
        const pvNonEmpty   = Array.isArray(pv) && pv.length > 0;
        if (curEmpty && (dvNonEmpty || pvNonEmpty)) { merged[key] = dvNonEmpty ? dv : pv; return; }
        if (isEmptyStringish(cur) && !isEmptyStringish(dv)) { merged[key] = dv; return; }
        if (isEmptyStringish(cur) && !isEmptyStringish(pv)) { merged[key] = pv; }
    });
    return merged;
}

function quotationFromItem(item) {
    if (!item || item.id === QUOTE_COUNTER_ID) return null;
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : null;
    const data    = item.data    && typeof item.data    === 'object' ? item.data    : null;
    if (!payload && !data) return null;
    const merged = mergePayloadAndData(data, payload);
    if (merged.id    == null)  merged.id        = item.id;
    if (!merged.createdAt && item.createdAt) merged.createdAt = item.createdAt;
    if (!merged.updatedAt && item.updatedAt) merged.updatedAt = item.updatedAt;
    return merged;
}

// In-memory cache: normalised quoteNumber → id
const quoteNumberCache = new Map();
const CACHE_MAX = 2000;

function normalizeQN(v) { return String(v || '').trim().toLowerCase(); }
function cacheSet(key, id) {
    if (!key || !id) return;
    if (quoteNumberCache.size >= CACHE_MAX) {
        const first = quoteNumberCache.keys().next().value;
        if (first) quoteNumberCache.delete(first);
    }
    quoteNumberCache.set(key, String(id));
}

// ── Routes ────────────────────────────────────────────────────────────────────

module.exports = function createQuotationsRouter({ ddbDocClient, ddbTableName }) {

    function requireDdb(res) {
        if (!ddbDocClient || !ddbTableName) {
            res.status(500).json({ error: 'DynamoDB not configured. Set DYNAMODB_TABLE in environment variables.' });
            return false;
        }
        return true;
    }

    // Next quote number (atomic increment)
    router.get('/next-quote-number', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const result = await ddbDocClient.send(new UpdateCommand({
                TableName: ddbTableName,
                Key: { id: QUOTE_COUNTER_ID },
                UpdateExpression: 'SET #v = if_not_exists(#v, :start) + :inc, #t = :type',
                ExpressionAttributeNames: { '#v': 'value', '#t': 'type' },
                ExpressionAttributeValues: { ':start': QUOTE_COUNTER_START, ':inc': 1, ':type': 'counter' },
                ReturnValues: 'UPDATED_NEW',
            }));
            const value = result?.Attributes?.value;
            if (!value) return res.status(500).json({ error: 'Failed to generate next quote number' });
            res.json({ value });
        } catch (error) {
            console.error('Error generating next quote number:', error);
            res.status(500).json({ error: 'Failed to generate next quote number', details: error.message });
        }
    });

    // Save a quotation
    router.post('/save-quotation', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { quotation } = req.body || {};
            if (!quotation || !quotation.id) return res.status(400).json({ error: 'Quotation with id is required' });

            const { PutCommand } = require('@aws-sdk/lib-dynamodb');
            const now     = new Date().toISOString();
            const updated = { ...quotation, createdAt: quotation.createdAt || now, updatedAt: now };

            await ddbDocClient.send(new PutCommand({
                TableName: ddbTableName,
                Item: {
                    id:        String(updated.id),
                    _entity:   ENTITY_QUOTATION,
                    updatedAt: updated.updatedAt,
                    createdAt: updated.createdAt,
                    payload:   updated,
                },
            }));
            res.json({ success: true });
        } catch (error) {
            console.error('Error saving quotation:', error);
            res.status(500).json({ error: 'Failed to save quotation', details: error.message });
        }
    });

    // List quotations — cursor-based, one DynamoDB call per page.
    //
    // GSI fast path: passes Limit directly to DynamoDB, gets back
    // LastEvaluatedKey which becomes the next cursor (~80 ms per page).
    //
    // Scan fallback (only if GSI is missing): fetches ALL items, sorts them
    // in JS, then encodes a plain offset as the cursor.  Slow but correct.
    router.get('/quotations', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const limit      = Math.min(QUOTATIONS_LIST_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));
            const offset     = Math.max(0, parseInt(req.query.offset, 10) || 0);
            const cursorData = decodeCursor(req.query.cursor);
            const { QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

            const t0 = Date.now();
            let mode = 'gsi', items = [], nextKey = null, pages = 0;

            try {
                // ── GSI fast path ─────────────────────────────────────────────
                // cursorData is either null (first page) or a DynamoDB key object.
                // Scan-fallback cursors carry a `_scan_offset` sentinel — don't
                // feed those back to DynamoDB.
                let startKey = (cursorData && !cursorData._scan_offset) ? cursorData : null;

                // DynamoDB caps each response at 1 MB of raw item data regardless
                // of `Limit`.  Large quotation payloads (20–30 KB each) can reduce
                // a page to ~40 items even when we asked for 100.  Loop until we
                // have `limit` items OR DynamoDB says there are no more pages.
                const MAX_INNER_PAGES = 10;
                while (items.length < limit && pages < MAX_INNER_PAGES) {
                    const remaining = limit - items.length;
                    const params = {
                        TableName:                 ddbTableName,
                        IndexName:                 QUOTATIONS_GSI_INDEX,
                        KeyConditionExpression:    '#ent = :ent',
                        ExpressionAttributeNames:  { ...SUMMARY_EXPR_NAMES, '#ent': '_entity' },
                        ExpressionAttributeValues: { ':ent': ENTITY_QUOTATION },
                        ScanIndexForward:          false,
                        ProjectionExpression:      SUMMARY_PROJECTION,
                        Limit:                     remaining,
                    };
                    if (startKey) params.ExclusiveStartKey = startKey;

                    const result = await ddbDocClient.send(new QueryCommand(params));
                    items   = items.concat(result.Items || []);
                    nextKey = result.LastEvaluatedKey || null;
                    pages++;
                    if (!nextKey) break;   // no more pages
                    startKey = nextKey;    // advance cursor for next inner call
                }

            } catch (gsiError) {
                const missing = gsiError.name === 'ResourceNotFoundException' ||
                    (gsiError.name === 'ValidationException' && gsiError.message?.includes('index'));
                if (!missing) throw gsiError;

                console.warn(`[quotations] GSI not found, falling back to scan. Create ${QUOTATIONS_GSI_INDEX} to speed this up.`);
                mode = 'scan';

                // ── Scan fallback — fetch all, sort, slice ────────────────────
                let allItems = [], scanKey = null;
                do {
                    const params = { TableName: ddbTableName, ProjectionExpression: SUMMARY_PROJECTION, ExpressionAttributeNames: SUMMARY_EXPR_NAMES };
                    if (scanKey) params.ExclusiveStartKey = scanKey;
                    const result = await ddbDocClient.send(new ScanCommand(params));
                    allItems = allItems.concat(result.Items || []);
                    scanKey  = result.LastEvaluatedKey || null;
                    pages++;
                } while (scanKey);

                const scanOffset = cursorData?._scan_offset || 0;
                const sorted = allItems
                    .map(quotationFromItem).filter(Boolean)
                    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

                const page       = sorted.slice(scanOffset, scanOffset + limit);
                const nextOffset = scanOffset + page.length;
                nextKey = nextOffset < sorted.length ? { _scan_offset: nextOffset } : null;

                const tQuery = Date.now();
                const tDone  = Date.now();
                res.set('X-Query-Ms',    String(tQuery - t0));
                res.set('X-Total-Ms',    String(tDone  - t0));
                res.set('X-Query-Pages', String(pages));
                res.set('X-Item-Count',  String(allItems.length));
                res.set('X-Query-Mode',  mode);
                console.log(`[quotations] mode=${mode} queryMs=${tQuery-t0} pages=${pages} items=${allItems.length}`);
                return res.json({ quotations: page, hasMore: !!nextKey, nextCursor: encodeCursor(nextKey), limit, total: sorted.length });
            }

            const tQuery = Date.now();
            const allQuotations = items.map(quotationFromItem).filter(Boolean);
            const total      = allQuotations.length;
            // Apply optional offset-based slice (used when ?offset= is provided
            // directly; cursor-based callers leave offset=0).
            const quotations = offset > 0
                ? allQuotations.slice(offset, offset + limit)
                : allQuotations;
            const nextCursor = encodeCursor(nextKey);
            const hasMore    = !!nextCursor || (offset + quotations.length < total);
            const tDone      = Date.now();

            res.set('X-Query-Ms',    String(tQuery - t0));
            res.set('X-Total-Ms',    String(tDone  - t0));
            res.set('X-Query-Pages', String(pages));
            res.set('X-Item-Count',  String(total));
            res.set('X-Query-Mode',  mode);
            console.log(`[quotations] mode=${mode} queryMs=${tQuery-t0} totalMs=${tDone-t0} pages=${pages} items=${total}`);

            res.json({ quotations, hasMore, nextCursor, limit, total });
        } catch (error) {
            console.error('Error loading quotations:', error);
            res.status(500).json({ error: 'Failed to load quotations', details: error.message });
        }
    });

    // Get quotation by quote number (fast lookup with in-memory cache)
    router.get('/quotations/by-number/:quoteNumber', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const qn  = String(req.params.quoteNumber || '').trim();
            if (!qn) return res.status(400).json({ error: 'quoteNumber is required' });

            const key    = normalizeQN(qn);
            const cached = quoteNumberCache.get(key);
            if (cached) return res.json({ found: true, id: cached, cached: true });

            const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
            const exprNames = { ...SUMMARY_EXPR_NAMES, '#qn': 'quoteNumber' };
            let lastKey = null, pages = 0, scanned = 0;
            const t0 = Date.now();

            while (pages < MAX_SCAN_PAGES) {
                pages++;
                const params = {
                    TableName: ddbTableName,
                    ProjectionExpression: SUMMARY_PROJECTION,
                    ExpressionAttributeNames: exprNames,
                    FilterExpression: '(#p.#qn = :qn OR #d.#qn = :qn)',
                    ExpressionAttributeValues: { ':qn': qn },
                };
                if (lastKey) params.ExclusiveStartKey = lastKey;
                const result = await ddbDocClient.send(new ScanCommand(params));
                scanned += result.ScannedCount || 0;
                const found = (result.Items || []).map(quotationFromItem).filter(Boolean)[0];
                if (found) {
                    const id = String(found.id);
                    cacheSet(key, id);
                    console.log(`[quotations-by-number] qn=${qn} found id=${id} pages=${pages} scanned=${scanned} ms=${Date.now()-t0}`);
                    return res.json({ found: true, id, cached: false });
                }
                lastKey = result.LastEvaluatedKey || null;
                if (!lastKey) break;
            }

            console.log(`[quotations-by-number] qn=${qn} not-found pages=${pages} scanned=${scanned} ms=${Date.now()-t0}`);
            res.json({ found: false });
        } catch (error) {
            console.error('Error looking up quotation by number:', error);
            res.status(500).json({ error: 'Failed to lookup quotation', details: error.message });
        }
    });

    // Get single quotation by ID (full data including heavy fields)
    router.get('/quotations/:id', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { GetCommand } = require('@aws-sdk/lib-dynamodb');
            const result = await ddbDocClient.send(new GetCommand({
                TableName: ddbTableName,
                Key: { id: String(req.params.id) },
            }));
            if (!result.Item) return res.status(404).json({ error: 'Quotation not found' });
            const quotation = quotationFromItem(result.Item);
            if (!quotation)  return res.status(404).json({ error: 'Quotation not found' });
            res.json({ quotation });
        } catch (error) {
            console.error('Error fetching quotation:', error);
            res.status(500).json({ error: 'Failed to fetch quotation', details: error.message });
        }
    });

    return router;
};

// Export helper so server.js internal functions can reuse it
module.exports.quotationFromItem = quotationFromItem;
