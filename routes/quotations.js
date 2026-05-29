'use strict';

/**
 * routes/quotations.js
 *
 * Quotation persistence: save, list, get by ID, get by quote number,
 * next quote number counter.
 */

const express = require('express');
const router  = express.Router();

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

const QUOTATIONS_LIST_LIMIT = 600;

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
    if (!item || item.id === 'QUOTE_NUMBER_COUNTER') return null;
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
                Key: { id: 'QUOTE_NUMBER_COUNTER' },
                UpdateExpression: 'SET #v = if_not_exists(#v, :start) + :inc, #t = :type',
                ExpressionAttributeNames: { '#v': 'value', '#t': 'type' },
                ExpressionAttributeValues: { ':start': 107, ':inc': 1, ':type': 'counter' },
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
                    _entity:   'QUOTATION',
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

    // List quotations (GSI fast path, scan fallback)
    router.get('/quotations', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const requestedLimit  = Math.min(QUOTATIONS_LIST_LIMIT, Math.max(1, parseInt(req.query.limit,  10) || QUOTATIONS_LIST_LIMIT));
            const requestedOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
            const { QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

            let items = [], lastKey = null, pages = 0, mode = 'gsi';
            const t0 = Date.now();

            try {
                do {
                    const params = {
                        TableName:                 ddbTableName,
                        IndexName:                 'entity-updatedAt-index',
                        KeyConditionExpression:    '#ent = :ent',
                        ExpressionAttributeNames:  { ...SUMMARY_EXPR_NAMES, '#ent': '_entity' },
                        ExpressionAttributeValues: { ':ent': 'QUOTATION' },
                        ScanIndexForward:          false,
                        ProjectionExpression:      SUMMARY_PROJECTION,
                    };
                    if (lastKey) params.ExclusiveStartKey = lastKey;
                    const result = await ddbDocClient.send(new QueryCommand(params));
                    items   = items.concat(result.Items || []);
                    lastKey = result.LastEvaluatedKey || null;
                    pages++;
                } while (lastKey);
            } catch (gsiError) {
                const missing = gsiError.name === 'ResourceNotFoundException' ||
                    (gsiError.name === 'ValidationException' && gsiError.message?.includes('index'));
                if (!missing) throw gsiError;
                console.warn('[quotations] GSI not found, falling back to scan. Create entity-updatedAt-index to speed this up.');
                mode = 'scan'; items = []; lastKey = null; pages = 0;
                do {
                    const params = { TableName: ddbTableName, ProjectionExpression: SUMMARY_PROJECTION, ExpressionAttributeNames: SUMMARY_EXPR_NAMES };
                    if (lastKey) params.ExclusiveStartKey = lastKey;
                    const result = await ddbDocClient.send(new ScanCommand(params));
                    items   = items.concat(result.Items || []);
                    lastKey = result.LastEvaluatedKey || null;
                    pages++;
                } while (lastKey);
            }

            const tQuery = Date.now();
            let quotations = items.map(quotationFromItem).filter(Boolean);
            if (mode === 'scan') {
                quotations.sort((a, b) =>
                    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
            }

            const total          = quotations.length;
            const pagedQuotations = quotations.slice(requestedOffset, requestedOffset + requestedLimit);
            const hasMore        = (requestedOffset + pagedQuotations.length) < total;
            const tDone          = Date.now();

            res.set('X-Query-Ms',    String(tQuery - t0));
            res.set('X-Total-Ms',    String(tDone  - t0));
            res.set('X-Query-Pages', String(pages));
            res.set('X-Item-Count',  String(items.length));
            res.set('X-Query-Mode',  mode);
            console.log(`[quotations] mode=${mode} queryMs=${tQuery-t0} totalMs=${tDone-t0} pages=${pages} items=${items.length}`);

            res.json({ quotations: pagedQuotations, hasMore, total, limit: requestedLimit, offset: requestedOffset });
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

            while (pages < 200) {
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
