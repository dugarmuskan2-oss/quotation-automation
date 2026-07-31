'use strict';

/**
 * routes/quotations.js
 *
 * Quotation persistence: save, list, get by ID, get by quote number,
 * next quote number counter.
 */

const express = require('express');

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
    'gmailMessageId', 'billTo', 'shipTo', 'grandTotal', '#snt',
    '#eva', '#rev', '#crp', 'revisionCount',
    // Admin margin-allocation flow (desk renders from the list summary alone)
    'adminStatus', 'adminNote', 'itemSummary', 'isNewCompany', 'regretSentAt',
    'preparedBy', 'sentAt', 'registerMeta',
    // Reply-sweep ("Check all replies"): the transporter enquiry threads + the customer
    // thread id + the transporter-reply flag, so awaiting quotes are found from the list
    // alone (these fields are small and only present on quotes that actually have them).
    'freightEnquiries', 'threadId', 'transporterReplyIn',
    // Soft-delete flag so accidental/junk quotes stay filtered out of the lists on reload.
    'deleted',
    // Revision asks + plain notes added from a quote card. revisionRequests must be here so the
    // Revision filter and its count badge work from the list alone, without fetching every quote.
    'revisionRequests', 'extraNotes',
];
const SUMMARY_PROJECTION = [
    'id', 'updatedAt', 'createdAt',
    ...SUMMARY_NESTED_PATHS.map(seg => '#p.' + seg),
    ...SUMMARY_NESTED_PATHS.map(seg => '#d.' + seg),
].join(', ');
const SUMMARY_EXPR_NAMES = { '#p': 'payload', '#d': 'data', '#sv': 'saved', '#snt': 'sent', '#eva': 'everApproved', '#rev': 'revised', '#crp': 'custReplyPending' };

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

// ── Enquiry-register helpers (pure; exported via _test) ───────────────────────

/**
 * Resolve the register window from query params: exact ?from/?to ISO bounds
 * (in-app view — the client sends its LOCAL month edges), else ?month=YYYY-MM
 * as a UTC calendar month. Returns { start, end } or null (caller falls back
 * to the rolling ?days window).
 */
function registerRangeOf(query) {
    const from = new Date(String(query.from || ''));
    const to   = new Date(String(query.to || ''));
    if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && from < to) {
        return { start: from.toISOString(), end: to.toISOString() };
    }
    const m = /^(\d{4})-(\d{2})$/.exec(String(query.month || ''));
    if (!m) return null;
    const year = parseInt(m[1], 10), month = parseInt(m[2], 10) - 1;
    if (month < 0 || month > 11) return null;
    return {
        start: new Date(Date.UTC(year, month, 1)).toISOString(),
        end:   new Date(Date.UTC(year, month + 1, 1)).toISOString(),
    };
}

function registerStatusOf(q) {
    if (q.adminStatus === 'regretted') return 'REGRET';
    // Sent overrides "awaiting margin": a quote sent without going through the desk is Sent,
    // not still pending margin allocation.
    if (q.sent && q.revised) return 'REVISION SENT';
    if (q.sent) return 'SENT';
    if (q.adminStatus === 'awaiting') return 'MARGIN ALLOCATION PENDING';
    return 'PENDING';
}

function registerRowOf(q) {
    return {
        id: q.id != null ? String(q.id) : '',
        quoteNumber: q.quoteNumber || '',
        enquiryDate: q.createdAt || q.updatedAt || '',
        status: registerStatusOf(q),
        company: q.companyName || q.projectName || '',
        contact: q.customerName || '',
        preparedBy: q.preparedBy || '',
        checkedBy: q.checkedBy || '',        // auto-fills the register's Checked By column
        sentDate: q.sentAt || '',            // "Sent On" column — filled once sent
        value: q.grandTotal || '',           // "Value" column — quote total
        gmailMessageId: q.gmailMessageId || '',
        // Manual workflow fields, typed in the in-app register
        registerMeta: (q.registerMeta && typeof q.registerMeta === 'object') ? q.registerMeta : {},
    };
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

// Text search over a quote summary's visible fields (company / bill-to / contact / quote
// number) — mirrors the client's matchesApprovalSearch so results feel consistent.
function normalizeSearchQuery(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim(); }
function quoteSummaryMatches(x, q) {
    const hay = normalizeSearchQuery([x.companyName, x.projectName, x.customerName, x.quoteNumber].filter(Boolean).join(' '));
    return hay.indexOf(q) >= 0;
}
// A quote's calendar month ('YYYY-MM', UTC) from when it was created.
// A quote's calendar month, 'YYYY-MM'. Mirrors approvalMonthOf in index.html.
// quotationDate (the DD.MM.YY the app prints on the quote) is preferred over createdAt so the
// month a quote is filed under always matches the date shown on it. Bucketing on the UTC slice of
// createdAt instead meant a quote saved between midnight and 05:30 IST on the 1st was dated the
// new month but filed under the previous one — pick that month and the quote was missing.
function monthOfDateValue(value) {
    if (!value) return '';
    const dmy = String(value).trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
    if (dmy) {
        const month = Number(dmy[2]);
        if (month < 1 || month > 12) return '';
        const year = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3];
        return year + '-' + String(month).padStart(2, '0');
    }
    const t = new Date(value);
    return isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 7);
}
function quoteMonth(x) {
    if (!x) return '';
    return monthOfDateValue(x.quotationDate) || monthOfDateValue(x.createdAt) || monthOfDateValue(x.updatedAt);
}
// Page cap for the whole-table scans behind search and the month/freight filters. Items carry
// tableHTML, so they average ~31 KB and a 1 MB scan page holds only ~33 of them — 40 pages reached
// barely 1,300 of ~1,900 quotes, silently hiding the oldest from every filter. Sized for ~6,600
// quotes; both endpoints report `truncated` rather than quietly returning a short list.
const FULL_SCAN_MAX_PAGES = 200;
// One path segment of a storage key. Anything outside [A-Za-z0-9._-] becomes '_', so a value
// taken from the URL can never contain '/' or '..' and walk out of its intended prefix.
function safeStorageSegment(v) {
    return String(v == null ? '' : v).replace(/[^a-zA-Z0-9._-]/g, '_');
}
// Has freight activity — a transporter enquiry was SENT for this quote, whether or not it still
// needs attention. Entries are only ever pushed for emails that actually sent, so any entry counts.
// Deliberately does not require threadId: a genuinely sent enquiry stores '' when the send response
// carries no thread id. Mirrors quoteHasFreightActivityClient in index.html.
function quoteHasFreightActivity(x) {
    if (x && x.transporterReplyIn) return true;
    return !!(x && Array.isArray(x.freightEnquiries) && x.freightEnquiries.length > 0);
}
// Needs a revision — the admin asked for a change that has not been sent to the customer yet.
// Done asks are KEPT (History shows what was asked), so this counts only the open ones.
// Mirrors quoteNeedsRevisionClient in index.html.
function quoteNeedsRevision(x) {
    return !!(x && Array.isArray(x.revisionRequests) && x.revisionRequests.some(function (r) { return r && !r.done; }));
}

module.exports = function createQuotationsRouter({ ddbDocClient, ddbTableName, storage }) {

    const router = express.Router();   // fresh router per call — a factory must not share module-level state

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

            const { PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
            const now = new Date().toISOString();

            // One read of the stored quote, serving two guards below. Best-effort: a read failure
            // just means we save what the client sent, exactly as before.
            let stored = null;
            try {
                const existing = await ddbDocClient.send(new GetCommand({ TableName: ddbTableName, Key: { id: String(quotation.id) } }));
                stored = (existing && existing.Item && existing.Item.payload) || null;
            } catch (e) { /* first save, or a read blip — fall through and save what we have */ }

            // Guard 1 — accidental item wipes: if the incoming payload has NO line items and NO
            // tableHTML (e.g. a bare list-summary object saved by mistake) but the STORED quote has
            // them, keep the stored heavy fields rather than overwriting them to empty.
            const incomingHasBody = (Array.isArray(quotation.lineItems) && quotation.lineItems.length) || quotation.tableHTML;
            if (!incomingHasBody && stored && ((Array.isArray(stored.lineItems) && stored.lineItems.length) || stored.tableHTML)) {
                if (!(Array.isArray(quotation.lineItems) && quotation.lineItems.length)) quotation.lineItems = stored.lineItems;
                if (!quotation.tableHTML) quotation.tableHTML = stored.tableHTML;
                if (!quotation.headerHTML) quotation.headerHTML = stored.headerHTML;
                console.warn('save-quotation: preserved stored items/tableHTML for', quotation.id, '(incoming payload had none)');
            }

            // Guard 2 — fields the SERVER owns. Each is written only by its own field-merge route, so
            // a whole-object save must never carry them: a browser that loaded the quote before the
            // value existed holds `undefined` and would silently erase it. That really happened — a
            // revision the admin asked for was deleted (not marked done) the moment any stale tab
            // pressed Save/Approve/Send or ran the reply sweep, taking the wording with it. The same
            // overwrite un-deleted soft-deleted quotes and dropped freight enquiry records.
            // Always take the stored values; ignore whatever the client sent.
            const SERVER_OWNED = ['revisionRequests', 'extraNotes', 'deleted', 'deletedAt', 'freightEnquiries', 'transporterReplyIn'];
            if (stored) {
                SERVER_OWNED.forEach(function (field) {
                    if (Object.prototype.hasOwnProperty.call(stored, field)) quotation[field] = stored[field];
                    else delete quotation[field];
                });
            }

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

    // ── Enquiry register (Google Sheet mirror) ───────────────────────────────
    // Feeds the Apps Script that fills the register sheet. Secured with the
    // same X-Ingest-Secret the Gmail ingest uses. Status: REGRET | SENT | PENDING.

    const REGISTER_MAX_ROWS = 2000;

    // Read-only, same exposure as GET /api/quotations (no secret gate — the
    // in-app Register section fetches this from the browser; the optional
    // Google-Sheet mirror script calls it the same way).
    router.get('/enquiry-register', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            // Window options, most specific first:
            //   ?from=ISO&to=ISO — exact [from, to) bounds (the in-app view sends
            //     the viewer's LOCAL month bounds so month edges match the screen)
            //   ?month=YYYY-MM   — calendar month in UTC (legacy)
            //   ?days=N          — rolling window (the Google-Sheet mirror script)
            const range = registerRangeOf(req.query);
            const days = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 62));
            const cutoff = range ? range.start : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
            const cutoffEnd = range ? range.end : null;
            const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
            const rows = [];
            let startKey = null, pages = 0, reachedCutoff = false;
            while (!reachedCutoff && rows.length < REGISTER_MAX_ROWS && pages < 30) {
                const params = {
                    TableName:                 ddbTableName,
                    IndexName:                 QUOTATIONS_GSI_INDEX,
                    KeyConditionExpression:    '#ent = :ent',
                    ExpressionAttributeNames:  { ...SUMMARY_EXPR_NAMES, '#ent': '_entity' },
                    ExpressionAttributeValues: { ':ent': ENTITY_QUOTATION },
                    ScanIndexForward:          false,
                    ProjectionExpression:      SUMMARY_PROJECTION,
                    // Summary items are tiny (~0.5 KB) — a large page keeps a
                    // 6-month register to a single DynamoDB round trip.
                    Limit:                     1000,
                };
                if (startKey) params.ExclusiveStartKey = startKey;
                const page = await ddbDocClient.send(new QueryCommand(params));
                pages++;
                (page.Items || []).forEach(item => {
                    const q = quotationFromItem(item);
                    if (!q) return;
                    // Soft-deleted quotes are hidden everywhere else; the register was the one
                    // place a junk/accidental entry stayed visible — counted in the monthly
                    // headline and mirrored into the Google Sheet.
                    if (q.deleted) return;
                    if ((q.updatedAt || '') < cutoff) { reachedCutoff = true; return; }
                    const created = q.createdAt || q.updatedAt || '';
                    if (created >= cutoff && (!cutoffEnd || created < cutoffEnd)) rows.push(registerRowOf(q));
                });
                startKey = page.LastEvaluatedKey || null;
                if (!startKey) break;
            }
            res.json({ rows, days, generatedAt: new Date().toISOString() });
        } catch (error) {
            console.error('Error building enquiry register:', error);
            res.status(500).json({ error: 'Failed to build enquiry register', details: error.message });
        }
    });

    // ── Admin margin-allocation actions ──────────────────────────────────────
    // Both act server-side on the STORED payload so the desk (which only holds
    // list summaries) can never clobber heavy fields with a whole-object save.

    async function loadStoredQuotation(id) {
        const { GetCommand } = require('@aws-sdk/lib-dynamodb');
        const result = await ddbDocClient.send(new GetCommand({
            TableName: ddbTableName,
            Key: { id: String(id) },
        }));
        const payload = result.Item && result.Item.payload;
        return (payload && typeof payload === 'object') ? { item: result.Item, payload } : null;
    }

    async function storeQuotationPayload(item, payload) {
        const { PutCommand } = require('@aws-sdk/lib-dynamodb');
        const now = new Date().toISOString();
        payload.updatedAt = now;
        await ddbDocClient.send(new PutCommand({
            TableName: ddbTableName,
            Item: { ...item, updatedAt: now, payload },
        }));
    }

    // Read-modify-write that cannot lose a concurrent update. `mutate(payload)` is applied to a
    // FRESH read each attempt and the write only lands if the record has not changed underneath
    // (conditional on updatedAt); otherwise it re-reads and re-applies. Without this, two people
    // adding a revision note — or sending a freight enquiry — within the same moment each read the
    // same record and the second write silently discarded the first one's entry, while both were
    // told it succeeded. Returns the stored payload, or null if the quote does not exist.
    async function mutateStoredQuotation(id, mutate, attempts) {
        const { PutCommand } = require('@aws-sdk/lib-dynamodb');
        const tries = attempts || 5;
        for (let i = 0; i < tries; i++) {
            const stored = await loadStoredQuotation(id);
            if (!stored) return null;
            const prevUpdatedAt = stored.item.updatedAt;
            mutate(stored.payload);
            const now = new Date().toISOString();
            stored.payload.updatedAt = now;
            try {
                await ddbDocClient.send(new PutCommand({
                    TableName: ddbTableName,
                    Item: { ...stored.item, updatedAt: now, payload: stored.payload },
                    // Only write if nobody else has written since our read.
                    ...(prevUpdatedAt
                        ? { ConditionExpression: 'updatedAt = :prev', ExpressionAttributeValues: { ':prev': prevUpdatedAt } }
                        : { ConditionExpression: 'attribute_not_exists(id) OR attribute_not_exists(updatedAt)' }),
                }));
                return stored.payload;
            } catch (err) {
                const clash = err && (err.name === 'ConditionalCheckFailedException'
                    || (err.__type || '').indexOf('ConditionalCheckFailed') >= 0);
                if (!clash || i === tries - 1) throw err;
                // Someone else won the race — loop and re-apply on top of their version.
            }
        }
        return null;
    }

    // Apply the admin's margins + note: stamp line items, rebuild the table
    // snapshot with the same builder ingest uses, move the quote to 'ready'.
    router.post('/quotations/:id/apply-admin-margins', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { adminMargins, adminNote, isNewCompany, assignedTo } = req.body || {};
            const stored = await loadStoredQuotation(req.params.id);
            if (!stored) return res.status(404).json({ error: 'Quotation not found' });

            const { stampAdminMargins, buildItemSummary } = require('../utils/calculations');
            const { buildTableHTMLFromLineItems } = require('../gmail-ingest/htmlBuilder');
            const payload = stored.payload;

            payload.lineItems = stampAdminMargins(payload.lineItems, adminMargins);
            const { tableHTML, grandTotalFormatted } = buildTableHTMLFromLineItems(payload.lineItems);
            payload.tableHTML   = tableHTML;
            payload.grandTotal  = grandTotalFormatted;
            payload.itemSummary = buildItemSummary(payload.lineItems);
            payload.adminMargins = adminMargins || null;
            payload.adminNote    = String(adminNote || '');
            payload.isNewCompany = !!isNewCompany;
            if (assignedTo !== undefined) payload.assignedTo = String(assignedTo || '');
            payload.adminStatus  = 'ready';

            await storeQuotationPayload(stored.item, payload);
            res.json({ success: true, quotation: payload });
        } catch (error) {
            console.error('Error applying admin margins:', error);
            res.status(500).json({ error: 'Failed to apply admin margins', details: error.message });
        }
    });

    // Regret / undo-regret. Flag-only mutation; the regret email itself is sent
    // by the client through the existing /api/send-email reply flow.
    router.post('/quotations/:id/regret', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { undo, emailSent } = req.body || {};
            const stored = await loadStoredQuotation(req.params.id);
            if (!stored) return res.status(404).json({ error: 'Quotation not found' });

            const payload = stored.payload;
            if (undo) {
                payload.adminStatus = 'awaiting';
                delete payload.regretSentAt;
            } else {
                payload.adminStatus  = 'regretted';
                payload.regretSentAt = emailSent ? new Date().toISOString() : '';
            }
            await storeQuotationPayload(stored.item, payload);
            res.json({ success: true, quotation: payload });
        } catch (error) {
            console.error('Error updating regret status:', error);
            res.status(500).json({ error: 'Failed to update regret status', details: error.message });
        }
    });

    // Add a revision ask, or a plain note, from a quote card. Field-only merge into the STORED
    // payload (same reasoning as the freight route below), so it can be used on a quote the client
    // holds only as a list summary and can never smuggle in the user's in-progress edits.
    //
    // Two separate arrays on purpose: only revisionRequests drives the Revision filter and its
    // count badge, so a note can never put a quote into the revision list by accident.
    router.post('/quotations/:id/revision-request', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const text = String((req.body && req.body.text) || '').trim();
            const kind = (req.body && req.body.kind) === 'note' ? 'note' : 'revision';
            const addedBy = String((req.body && req.body.addedBy) || '').trim();
            if (!text) return res.status(400).json({ error: 'text is required' });

            const entry = { id: 'rr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), text, addedAt: new Date().toISOString() };
            if (addedBy) entry.addedBy = addedBy;
            if (kind !== 'note') entry.done = false;
            // Conditional retry: two people adding an ask at the same moment must BOTH keep theirs.
            const saved = await mutateStoredQuotation(req.params.id, function (payload) {
                if (kind === 'note') {
                    if (!Array.isArray(payload.extraNotes)) payload.extraNotes = [];
                    payload.extraNotes.push(entry);
                } else {
                    if (!Array.isArray(payload.revisionRequests)) payload.revisionRequests = [];
                    payload.revisionRequests.push(entry);
                }
            });
            if (!saved) return res.status(404).json({ error: 'Quotation not found' });
            res.json({ success: true, kind, entry });
        } catch (error) {
            console.error('Error adding revision request:', error);
            res.status(500).json({ error: 'Failed to add', details: error.message });
        }
    });

    // Mark every open revision ask on a quote as done. Called when the revised quote is SENT to the
    // customer — the ask is only satisfied once the customer actually has the new version. Done asks
    // are kept, not deleted, so History still shows what was asked and when.
    router.post('/quotations/:id/revision-requests-done', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const stored = await loadStoredQuotation(req.params.id);
            if (!stored) return res.status(404).json({ error: 'Quotation not found' });

            const payload = stored.payload;
            const now = new Date().toISOString();
            let cleared = 0;
            (Array.isArray(payload.revisionRequests) ? payload.revisionRequests : []).forEach(function (r) {
                if (r && !r.done) { r.done = true; r.doneAt = now; cleared++; }
            });
            if (cleared) await storeQuotationPayload(stored.item, payload);
            res.json({ success: true, cleared });
        } catch (error) {
            console.error('Error clearing revision requests:', error);
            res.status(500).json({ error: 'Failed to clear', details: error.message });
        }
    });

    // Persist the transporter-enquiry records for a quote. Field-only merge into the STORED
    // payload, so it is safe to call at any time: it cannot save the user's in-progress edits
    // (no-autosave rule) and cannot clobber lineItems/tableHTML when the client only holds a
    // list summary. The client used to do this with a whole-object save, which had to bail out
    // in both those cases — silently losing the record of enquiries that had really been emailed.
    router.post('/quotations/:id/freight-enquiries', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { freightEnquiries, transporterReplyIn } = req.body || {};
            if (!Array.isArray(freightEnquiries)) {
                return res.status(400).json({ error: 'freightEnquiries must be an array' });
            }
            // MERGE, don't replace. The client posts its own view of the list, which will not
            // include an enquiry a colleague sent moments earlier — a straight replace made the
            // app forget an email that really went out: it stopped watching that thread for a
            // reply and the quote dropped off the Freight list. Entries are keyed by threadId
            // where there is one, else by transporter + send time. Incoming wins on a match, so
            // reply/amount updates still land.
            const saved = await mutateStoredQuotation(req.params.id, function (payload) {
                const keyOf = (t) => (t && t.threadId)
                    ? 'tid:' + t.threadId
                    : 'es:' + String((t && t.email) || '').toLowerCase() + '|' + String((t && t.sentAt) || '');
                const merged = new Map();
                (Array.isArray(payload.freightEnquiries) ? payload.freightEnquiries : []).forEach(function (t) {
                    if (t) merged.set(keyOf(t), t);
                });
                freightEnquiries.forEach(function (t) { if (t) merged.set(keyOf(t), t); });
                payload.freightEnquiries = Array.from(merged.values());
                if (typeof transporterReplyIn === 'boolean') payload.transporterReplyIn = transporterReplyIn;
            });
            if (!saved) return res.status(404).json({ error: 'Quotation not found' });
            res.json({ success: true, count: (saved.freightEnquiries || []).length });
        } catch (error) {
            console.error('Error saving freight enquiries:', error);
            res.status(500).json({ error: 'Failed to save freight enquiries', details: error.message });
        }
    });

    // Soft-delete a quote — for accidental / junk entries on the desk. Recoverable:
    // sets deleted=true and the lists filter it out; `undo:true` restores it. Only flags
    // the payload (never touches lineItems / tableHTML), so nothing heavy is lost.
    router.post('/quotations/:id/delete', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const { undo } = req.body || {};
            const stored = await loadStoredQuotation(req.params.id);
            if (!stored) return res.status(404).json({ error: 'Quotation not found' });
            const payload = stored.payload;
            if (undo) { delete payload.deleted; delete payload.deletedAt; }
            else { payload.deleted = true; payload.deletedAt = new Date().toISOString(); }
            await storeQuotationPayload(stored.item, payload);
            res.json({ success: true });
        } catch (error) {
            console.error('Error soft-deleting quotation:', error);
            res.status(500).json({ error: 'Failed to delete quotation', details: error.message });
        }
    });

    // ── Archive a version's PDF, and serve it back ─────────────────────────────
    // The client generates the exact PDF (the same one it emails the customer) and posts
    // its base64 here; we stash it in file storage keyed by quote + version, so History
    // and the shared link can show the real original later instead of rebuilding it.
    router.post('/quotations/:id/archive-pdf', async (req, res) => {
        if (!storage || !storage.upload) return res.status(501).json({ error: 'File storage not configured' });
        try {
            const { base64, versionKey } = req.body || {};
            if (!base64 || !versionKey) return res.status(400).json({ error: 'base64 and versionKey are required' });
            const name = String(versionKey).replace(/[^a-zA-Z0-9._-]/g, '_') + '.pdf';
            // Sanitise the id the same way as the version. Unsanitised it let "../../.." in the URL
            // walk the composed key out of quote-pdfs/ entirely and write arbitrary bytes anywhere
            // the process could reach (nothing under /api is auth-gated).
            const prefix = 'quote-pdfs/' + safeStorageSegment(req.params.id);
            await storage.upload(Buffer.from(base64, 'base64'), name, prefix);
            res.json({ success: true, key: prefix + '/' + name });
        } catch (error) {
            console.error('Error archiving quote PDF:', error);
            res.status(500).json({ error: 'Failed to archive PDF', details: error.message });
        }
    });

    // Serve an archived version PDF (embedded by History / the shared link). 404 when a
    // version was never archived — the caller then falls back to the rebuilt view.
    router.get('/quotations/:id/pdf', async (req, res) => {
        if (!storage || !storage.streamToResponse) return res.status(404).end();
        const version = safeStorageSegment(req.query.version || 'current');
        // Same sanitising as the write path — an unsanitised id here could read any file the
        // process can reach and stream it back as a PDF.
        const key = 'quote-pdfs/' + safeStorageSegment(req.params.id) + '/' + version + '.pdf';
        try {
            res.setHeader('Content-Type', 'application/pdf');
            await storage.streamToResponse(key, res);
        } catch (error) {
            if (!res.headersSent) res.status(404).json({ error: 'No archived PDF for this version' });
        }
    });

    // Search ALL quotes (not just the loaded pages) by company / bill-to / contact / number.
    // Summary-only projection + capped, so it stays light; the client calls it debounced and
    // only when the user is actually searching. Scans the table (fine for user-initiated search
    // at this scale) — reach for a search index only at tens of thousands of quotes.
    router.get('/quotations-search', async (req, res) => {
        if (!requireDdb(res)) return;
        const q = normalizeSearchQuery(req.query.q);
        if (!q) return res.json({ quotations: [] });
        try {
            const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
            let items = [], scanKey = null, pages = 0;
            do {
                const params = {
                    TableName: ddbTableName,
                    ProjectionExpression: SUMMARY_PROJECTION,
                    ExpressionAttributeNames: { ...SUMMARY_EXPR_NAMES, '#ent': '_entity' },
                    FilterExpression: '#ent = :ent',
                    ExpressionAttributeValues: { ':ent': ENTITY_QUOTATION },
                };
                if (scanKey) params.ExclusiveStartKey = scanKey;
                const result = await ddbDocClient.send(new ScanCommand(params));
                items = items.concat(result.Items || []);
                scanKey = result.LastEvaluatedKey || null;
                pages++;
            } while (scanKey && pages < FULL_SCAN_MAX_PAGES);
            if (scanKey) console.warn('Quote search: scan hit the page cap — older quotes were not searched');
            const matches = items.map(quotationFromItem).filter(Boolean)
                .filter(function (x) { return quoteSummaryMatches(x, q); })
                .sort(function (a, b) { return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0); })
                .slice(0, 100);
            res.json({ quotations: matches, truncated: !!scanKey });
        } catch (error) {
            console.error('Quote search failed:', error);
            res.status(500).json({ error: 'Search failed', details: error.message });
        }
    });

    // Filter ALL quotes (not just loaded pages) by month (created) and/or freight activity —
    // powers the approval list's month dropdown + freight button. Summary-only, capped.
    router.get('/quotations-filter', async (req, res) => {
        if (!requireDdb(res)) return;
        const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : '';
        const freight = String(req.query.freight || '') === '1';
        const revision = String(req.query.revision || '') === '1';
        if (!month && !freight && !revision) return res.json({ quotations: [] });
        try {
            const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
            let items = [], scanKey = null, pages = 0;
            do {
                const params = {
                    TableName: ddbTableName,
                    ProjectionExpression: SUMMARY_PROJECTION,
                    ExpressionAttributeNames: { ...SUMMARY_EXPR_NAMES, '#ent': '_entity' },
                    FilterExpression: '#ent = :ent',
                    ExpressionAttributeValues: { ':ent': ENTITY_QUOTATION },
                };
                if (scanKey) params.ExclusiveStartKey = scanKey;
                const result = await ddbDocClient.send(new ScanCommand(params));
                items = items.concat(result.Items || []);
                scanKey = result.LastEvaluatedKey || null;
                pages++;
            } while (scanKey && pages < FULL_SCAN_MAX_PAGES);
            if (scanKey) console.warn('Quote filter: scan hit the page cap — older quotes were not considered');
            let list = items.map(quotationFromItem).filter(Boolean);
            if (month)    list = list.filter(function (x) { return quoteMonth(x) === month; });
            if (freight)  list = list.filter(quoteHasFreightActivity);
            if (revision) list = list.filter(quoteNeedsRevision);
            list.sort(function (a, b) { return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0); });
            const RESULT_CAP = 1000;
            if (list.length > RESULT_CAP) console.warn('Quote filter: ' + list.length + ' matches, returning the newest ' + RESULT_CAP);
            res.json({ quotations: list.slice(0, RESULT_CAP), truncated: !!scanKey || list.length > RESULT_CAP });
        } catch (error) {
            console.error('Quote filter failed:', error);
            res.status(500).json({ error: 'Filter failed', details: error.message });
        }
    });

    // Save the register's manual workflow fields (Given for checking to,
    // Sent By, BIGIN checks). Flag-only merge — never clobbers heavy fields.
    const REGISTER_META_FIELDS = ['givenForCheckingTo', 'sentBy', 'statusManual', 'biginUploaded', 'phoneCheckedInBigin', 'emailCheckedInBigin'];

    router.post('/quotations/:id/register-meta', async (req, res) => {
        if (!requireDdb(res)) return;
        try {
            const stored = await loadStoredQuotation(req.params.id);
            if (!stored) return res.status(404).json({ error: 'Quotation not found' });

            const payload = stored.payload;
            const meta = (payload.registerMeta && typeof payload.registerMeta === 'object') ? payload.registerMeta : {};
            const updates = (req.body && typeof req.body.registerMeta === 'object') ? req.body.registerMeta : {};
            REGISTER_META_FIELDS.forEach(field => {
                if (updates[field] !== undefined) meta[field] = String(updates[field] || '');
            });
            payload.registerMeta = meta;

            await storeQuotationPayload(stored.item, payload);
            res.json({ success: true, registerMeta: meta });
        } catch (error) {
            console.error('Error saving register meta:', error);
            res.status(500).json({ error: 'Failed to save register fields', details: error.message });
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
// Pure helpers exposed for unit testing (see tests/register.test.js).
module.exports._test = { registerRangeOf, registerStatusOf, registerRowOf };
