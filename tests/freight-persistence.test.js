/**
 * @jest-environment node
 *
 * tests/freight-persistence.test.js
 *
 * Guards the fix for "the Freight button only ever shows one quote". The button was
 * right — the records were missing. persistEnquiryThreads used to save the WHOLE
 * quote, so it had to refuse in two cases:
 *   - q.hasUnsavedEdits    (a save would smuggle in the user's in-progress edits)
 *   - a summary-only object (a PutCommand would wipe lineItems / tableHTML)
 * Both refusals were correct and both were SILENT: the enquiry email really went
 * out, and the record was dropped on the next reload.
 *
 * It now posts to POST /quotations/:id/freight-enquiries, a field-only merge into
 * the stored payload, so neither refusal is needed. These tests execute the real
 * persistEnquiryThreads with a fake fetch (it is browser-only and IIFE-scoped, so
 * it is extracted by name, like tests/shared-quote-page.test.js does for index.html),
 * plus source guards for the surrounding contract.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FREIGHT_PATH = path.join(__dirname, '..', 'freight-tab-weight-editor.js');
const ROUTES_PATH = path.join(__dirname, '..', 'routes', 'quotations.js');
const freightSrc = fs.readFileSync(FREIGHT_PATH, 'utf8');
const routesSrc = fs.readFileSync(ROUTES_PATH, 'utf8');

// Pull a top-level `function name(...) { ... }` out of source by brace-matching.
function extractFunction(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

// Build persistEnquiryThreads with its REAL dependency (getEnquiryThreads) and a
// stubbed apiBase/fetch/console, returning the calls fetch received.
function loadPersist() {
    // getSentBodies travels too: the persist payload now carries the sent-enquiry bodies
    // alongside the threads (they are stored in their own top-level map, not in the threads).
    const body = ['getEnquiryThreads', 'getSentBodies', 'persistEnquiryThreads']
        .map((n) => extractFunction(freightSrc, n)).join('\n');
    const calls = [];
    const errors = [];
    let respond = { ok: true, status: 200 };
    // eslint-disable-next-line no-new-func
    const factory = new Function('calls', 'errors', 'getResponse', `
        function apiBase() { return '/api'; }
        var fetch = function (url, opts) {
            calls.push({ url: url, opts: opts });
            return Promise.resolve(getResponse());
        };
        var console = { error: function () { errors.push(Array.prototype.slice.call(arguments).join(' ')); } };
        ${body}
        return persistEnquiryThreads;
    `);
    return {
        persist: factory(calls, errors, () => respond),
        calls,
        errors,
        setResponse: (r) => { respond = r; },
    };
}

const body = (call) => JSON.parse(call.opts.body);

describe('persistEnquiryThreads — saves the enquiry record every time', () => {
    test('posts the threads to the field-merge route', async () => {
        const { persist, calls } = loadPersist();
        const q = { id: 'q1', freightEnquiries: [{ email: 't@x.com', threadId: 't1', replied: false }] };
        persist(q);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('/api/quotations/q1/freight-enquiries');
        expect(calls[0].opts.method).toBe('POST');
        expect(calls[0].opts.headers['Content-Type']).toBe('application/json');
        expect(body(calls[0]).freightEnquiries).toEqual(q.freightEnquiries);
    });

    // The two regressions: both of these used to return without saving anything.
    test('SAVES even when the user has unsaved edits (used to bail out silently)', () => {
        const { persist, calls } = loadPersist();
        persist({ id: 'q1', hasUnsavedEdits: true, freightEnquiries: [{ email: 'a@b.c', threadId: 't1' }] });
        expect(calls).toHaveLength(1);
        expect(body(calls[0]).freightEnquiries).toHaveLength(1);
    });

    test('SAVES for a summary-only quote with no lineItems/tableHTML (used to bail out silently)', () => {
        const { persist, calls } = loadPersist();
        persist({ id: 'q1', freightEnquiries: [{ email: 'a@b.c', threadId: '' }] });
        expect(calls).toHaveLength(1);
    });

    test('an entry with an EMPTY threadId is still persisted — it was genuinely sent', () => {
        const { persist, calls } = loadPersist();
        persist({ id: 'q1', freightEnquiries: [{ email: 'a@b.c', threadId: '', sentAt: '2026-07-31T00:00:00Z' }] });
        expect(body(calls[0]).freightEnquiries[0].threadId).toBe('');
    });

    test('sends transporterReplyIn as a real boolean — both when set and when cleared', () => {
        const set = loadPersist();
        set.persist({ id: 'q1', transporterReplyIn: true, freightEnquiries: [{ threadId: 't1', replied: true }] });
        expect(body(set.calls[0]).transporterReplyIn).toBe(true);

        // The two "price taken" paths clear the flag before persisting; false must be written,
        // not omitted, or the needs-attention highlight would never clear on another device.
        const cleared = loadPersist();
        cleared.persist({ id: 'q1', transporterReplyIn: false, freightEnquiries: [{ threadId: 't1', replied: true }] });
        expect(body(cleared.calls[0]).transporterReplyIn).toBe(false);

        const absent = loadPersist();
        absent.persist({ id: 'q1', freightEnquiries: [] });
        expect(body(absent.calls[0]).transporterReplyIn).toBe(false);
    });

    test('materialises a missing freightEnquiries array rather than throwing', () => {
        const { persist, calls } = loadPersist();
        persist({ id: 'q1' });
        expect(body(calls[0]).freightEnquiries).toEqual([]);
    });

    test('a quote with no id is skipped (nothing to address the write to)', () => {
        const { persist, calls } = loadPersist();
        persist({ freightEnquiries: [{ threadId: 't1' }] });
        persist(null);
        expect(calls).toHaveLength(0);
    });

    test('id 0 is still saved — it is a valid id, only null/undefined are skipped', () => {
        const { persist, calls } = loadPersist();
        persist({ id: 0, freightEnquiries: [] });
        expect(calls).toHaveLength(1);
    });

    test('the quote id is URL-encoded', () => {
        const { persist, calls } = loadPersist();
        persist({ id: 'a b/c', freightEnquiries: [] });
        expect(calls[0].url).toBe('/api/quotations/a%20b%2Fc/freight-enquiries');
    });

    test('a failed save is reported, never swallowed', async () => {
        const { persist, errors, setResponse } = loadPersist();
        setResponse({ ok: false, status: 500 });
        persist({ id: 'q1', freightEnquiries: [] });
        await new Promise((r) => setImmediate(r));
        expect(errors.join(' ')).toContain('not saved');
        expect(errors.join(' ')).toContain('500');
    });
});

describe('source guards — the contract that made the records disappear', () => {
    const src = extractFunction(freightSrc, 'persistEnquiryThreads');

    test('no longer refuses to save on unsaved edits or a summary-only object', () => {
        expect(src).not.toContain('hasUnsavedEdits');
        expect(src).not.toContain('tableHTML');
    });

    test('does not fall back to a whole-object save anywhere in the freight module', () => {
        // A whole-object PutCommand over a list summary is what wiped stored line items.
        expect(freightSrc).not.toContain('saveQuotationToBackend');
    });

    test('every caller persists after setting the reply flag, so the posted value is current', () => {
        // Both clear paths set the flag false immediately before persisting.
        expect(freightSrc).toContain('q.transporterReplyIn = false;   // price picked');
        expect(freightSrc).toContain('q.transporterReplyIn = true;   // flags');
    });
});

describe('source guards — server side', () => {
    test('the field-merge route exists and writes only the freight fields', () => {
        expect(routesSrc).toContain("router.post('/quotations/:id/freight-enquiries'");
        // Merges into the stored list rather than replacing it, so a sender who never loaded a
        // colleague's enquiry cannot erase it. Written through the conditional-retry helper so a
        // simultaneous send cannot be lost either.
        expect(routesSrc).toContain('payload.freightEnquiries = Array.from(merged.values());');
        expect(routesSrc).toContain('await mutateStoredQuotation(req.params.id, function (payload) {');
        // Guarded so an omitted flag is left alone rather than being coerced to false.
        expect(routesSrc).toContain("if (typeof transporterReplyIn === 'boolean') payload.transporterReplyIn = transporterReplyIn;");
    });

    test('the route never assigns lineItems or tableHTML', () => {
        const start = routesSrc.indexOf("router.post('/quotations/:id/freight-enquiries'");
        const routeSrc = routesSrc.slice(start, routesSrc.indexOf('router.post', start + 10));
        expect(routeSrc).not.toContain('payload.lineItems');
        expect(routeSrc).not.toContain('payload.tableHTML');
    });

    test('whole-table scans reach past the old 40-page cap and report truncation', () => {
        // ~31 KB items mean ~33 per 1 MB page, so 40 pages reached only ~1,300 of ~1,900
        // quotes — the oldest were silently invisible to search and the month/freight filters.
        expect(routesSrc).toContain('const FULL_SCAN_MAX_PAGES = 200;');
        expect(routesSrc).not.toContain('pages < 40');
        expect(routesSrc.match(/pages < FULL_SCAN_MAX_PAGES/g) || []).toHaveLength(2);
        expect(routesSrc.match(/truncated: !!scanKey/g) || []).toHaveLength(2);
    });
});
