/**
 * @jest-environment node
 *
 * tests/reply-detect.test.js
 *
 * checkCustomerReplyForQuote(q) (index.html): reads a quote's Gmail thread via
 * /thread-messages, ignores auto/bounce messages (m.auto), sets
 * q.custReplyPending = (last real message is from the customer), and returns
 * { newReply, changed }.
 *
 * The CRITICAL behaviour locked down here is the persist guard: it only calls
 * saveQuotationToBackend(q) when `changed && isFullQuote && !q.hasUnsavedEdits`,
 * where isFullQuote = !!(q.tableHTML || (q.lineItems && q.lineItems.length)). That
 * guard is what stops a lightweight list-summary sweep from PutCommand-overwriting
 * (and wiping) a stored quote's line items.
 *
 * The real function is extracted by brace-matching from index.html and eval'd; the
 * browser globals it closes over (fetch, API_BASE_URL, safeJsonParse,
 * saveQuotationToBackend) are stubbed on `global` so it runs under Node.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull a top-level function out of source by brace-matching; keep a leading `async`.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}
function loadFn(name) {
    // eslint-disable-next-line no-eval
    return eval('(' + extractFunction(html, name) + ')');
}

const checkCustomerReplyForQuote = loadFn('checkCustomerReplyForQuote');

// Every POST to the field-only flag route, so tests can assert what was persisted.
let flagPosts = [];

// Stub global.fetch for the /thread-messages read. `entry` is the messages[] to
// return, or the sentinels 'fail' (res.ok false), 'throw' (network error), or
// 'badshape' (ok but no messages array). The flag route is answered separately —
// the thread sentinels must not make the persist call fail too.
function stubFetch(entry) {
    global.fetch = jest.fn(function (url, opts) {
        if (String(url).includes('/cust-reply-pending')) {
            flagPosts.push({ url: String(url), pending: JSON.parse(opts.body).pending });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
        }
        if (entry === 'throw') return Promise.reject(new Error('network down'));
        if (entry === 'fail') return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) });
        if (entry === 'badshape') return Promise.resolve({ ok: true, json: () => Promise.resolve({ notMessages: true }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: entry || [] }) });
    });
}

const you = () => ({ direction: 'you', body: 'our quotation' });
const cust = () => ({ direction: 'customer', from: 'buyer@acme.com', body: 'Thanks, please revise item 2.' });
const bounce = () => ({ direction: 'customer', auto: true, from: 'mailer-daemon@x.com', body: 'Delivery failed' });

beforeEach(() => {
    global.API_BASE_URL = '';
    global.safeJsonParse = async (res) => res.json();
    global.saveQuotationToBackend = jest.fn();
    flagPosts = [];   // per-test recorder; without this it accumulates across the file
});
afterEach(() => {
    delete global.fetch;
    delete global.API_BASE_URL;
    delete global.safeJsonParse;
    delete global.saveQuotationToBackend;
    jest.clearAllMocks();
});

describe('checkCustomerReplyForQuote — customer reply detection', () => {
    test('A. SUMMARY quote (no lineItems / no tableHTML), customer last: persists via the FIELD-ONLY route', async () => {
        stubFetch([you(), cust()]);
        const q = { id: 'q1', threadId: 't1' }; // list summary: no tableHTML, no lineItems
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(true);
        expect(res).toEqual({ newReply: true, changed: true });
        // The whole point: a summary sweep must never save (would wipe stored items).
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('B. FULL quote (has lineItems), customer last: persists exactly once', async () => {
        stubFetch([you(), cust()]);
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a', unitRate: 100 }] };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(true);
        expect(res).toEqual({ newReply: true, changed: true });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();   // never the heavy save
        expect(flagPosts).toEqual([{ url: '/quotations/q1/cust-reply-pending', pending: true }]);
    });

    test('B2. FULL quote via tableHTML (no lineItems array) also persists', async () => {
        stubFetch([you(), cust()]);
        const q = { id: 'q1', threadId: 't1', tableHTML: '<table>...</table>' };
        const res = await checkCustomerReplyForQuote(q);

        expect(res.changed).toBe(true);
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
        expect(flagPosts).toHaveLength(1);
    });

    test('C. FULL quote with hasUnsavedEdits: STILL persists — the flag route cannot touch edits', async () => {
        stubFetch([you(), cust()]);
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }], hasUnsavedEdits: true };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(true);
        expect(res).toEqual({ newReply: true, changed: true });
        // The whole-object save WOULD have clobbered the unsaved edits, which is why the old
        // code skipped persisting here entirely — and why the badge kept vanishing.
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
        expect(flagPosts).toEqual([{ url: '/quotations/q1/cust-reply-pending', pending: true }]);
    });

    test('D. Last real message is from us: pending stays false, nothing changed', async () => {
        stubFetch([cust(), you()]);
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }] };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(false);
        expect(res).toEqual({ newReply: false, changed: false });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('E. Auto/bounce message is last but a customer reply precedes it: the bounce is ignored', async () => {
        stubFetch([you(), cust(), bounce()]);
        const q = { id: 'q1', threadId: 't1' };
        const res = await checkCustomerReplyForQuote(q);

        // real = [you, cust]; last real is the customer -> pending
        expect(q.custReplyPending).toBe(true);
        expect(res).toEqual({ newReply: true, changed: true });
    });

    test('E2. Only our message then a bounce: pending false (bounce ignored, we spoke last)', async () => {
        stubFetch([you(), bounce()]);
        const q = { id: 'q1', threadId: 't1' };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(false);
        expect(res).toEqual({ newReply: false, changed: false });
    });

    test('F. No threadId and no gmailMessageId: no-op, nothing fetched', async () => {
        global.fetch = jest.fn();
        const q = {};
        const res = await checkCustomerReplyForQuote(q);

        expect(res).toEqual({ newReply: false, changed: false });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('G1. res.ok false: returns not-changed, does not throw or persist', async () => {
        stubFetch('fail');
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }] };
        const res = await checkCustomerReplyForQuote(q);

        expect(res).toEqual({ newReply: false, changed: false });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('G2. network error is swallowed: returns not-changed, does not throw', async () => {
        stubFetch('throw');
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }] };
        await expect(checkCustomerReplyForQuote(q)).resolves.toEqual({ newReply: false, changed: false });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('G3. malformed response (no messages array): treated as not-changed', async () => {
        stubFetch('badshape');
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }] };
        const res = await checkCustomerReplyForQuote(q);

        expect(res).toEqual({ newReply: false, changed: false });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });
});

describe('checkCustomerReplyForQuote — request routing & flag transitions', () => {
    test('uses threadId in the query when present', async () => {
        stubFetch([you(), cust()]);
        const q = { threadId: 'THR-9', gmailMessageId: 'MSG-1' };
        await checkCustomerReplyForQuote(q);

        const url = global.fetch.mock.calls[0][0];
        expect(url).toContain('/thread-messages?');
        expect(url).toContain('threadId=THR-9');
        expect(url).not.toContain('messageId=');
    });

    test('falls back to messageId when there is no threadId', async () => {
        stubFetch([you(), cust()]);
        const q = { gmailMessageId: 'MSG-42' };
        await checkCustomerReplyForQuote(q);

        const url = global.fetch.mock.calls[0][0];
        expect(url).toContain('messageId=MSG-42');
        expect(url).not.toContain('threadId=');
    });

    test('clearing a previously-pending flag counts as changed but not a new reply (and a full quote re-persists)', async () => {
        // Thread now ends with our message; the quote was previously flagged pending.
        stubFetch([cust(), you()]);
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }], custReplyPending: true };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(false);
        expect(res).toEqual({ newReply: false, changed: true });
        // A CLEAR persists too — otherwise the badge would linger after you replied.
        expect(flagPosts).toEqual([{ url: '/quotations/q1/cust-reply-pending', pending: false }]);
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('already-pending and still pending: unchanged, no persist', async () => {
        stubFetch([you(), cust()]);
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }], custReplyPending: true };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(true);
        expect(res).toEqual({ newReply: false, changed: false });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('empty thread (no messages): pending false, unchanged', async () => {
        stubFetch([]);
        const q = { id: 'q1', threadId: 't1', lineItems: [{ lineItemId: 'a' }] };
        const res = await checkCustomerReplyForQuote(q);

        expect(q.custReplyPending).toBe(false);
        expect(res).toEqual({ newReply: false, changed: false });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });

    test('empty lineItems array is NOT a full quote (guard uses length): no persist even on a change', async () => {
        stubFetch([you(), cust()]);
        const q = { id: 'q1', threadId: 't1', lineItems: [] }; // length 0 -> summary-like
        const res = await checkCustomerReplyForQuote(q);

        expect(res).toEqual({ newReply: true, changed: true });
        expect(global.saveQuotationToBackend).not.toHaveBeenCalled();
    });
});
