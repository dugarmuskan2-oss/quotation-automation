/**
 * @jest-environment node
 *
 * tests/check-all-replies.test.js
 *
 * The global "Check all replies" sweep (index.html): the bounded concurrency pool
 * (runWithConcurrency) and the candidate filters (quoteAwaitsFreightReply /
 * quoteHasCustomerThread), extracted by name and eval'd. Plus source guards for the
 * top button, the auto-check-on-load wiring (background = freight-only), and the
 * DynamoDB list projection that carries the sweep fields.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const routesQuotations = fs.readFileSync(path.join(__dirname, '..', 'routes', 'quotations.js'), 'utf8');

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

const runWithConcurrency = loadFn('runWithConcurrency');
const quoteAwaitsFreightReply = loadFn('quoteAwaitsFreightReply');
const quoteHasCustomerThread = loadFn('quoteHasCustomerThread');

describe('runWithConcurrency — bounded parallel worker', () => {
    test('runs every item and returns results in order', async () => {
        const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
        expect(out).toEqual([10, 20, 30, 40, 50]);
    });

    test('never exceeds the concurrency limit, but does run in parallel', async () => {
        let inFlight = 0, maxInFlight = 0;
        await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
        });
        expect(maxInFlight).toBeLessThanOrEqual(3);
        expect(maxInFlight).toBeGreaterThan(1);
    });

    test('a throwing worker yields null for that item; the others still run', async () => {
        const out = await runWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('x'); return n; });
        expect(out).toEqual([1, null, 3]);
    });

    test('empty list -> empty results, no work done', async () => {
        const worker = jest.fn();
        const out = await runWithConcurrency([], 5, worker);
        expect(out).toEqual([]);
        expect(worker).not.toHaveBeenCalled();
    });
});

describe('quoteAwaitsFreightReply — freight candidate filter', () => {
    test('true when a thread is unreplied and has a threadId', () => {
        expect(quoteAwaitsFreightReply({ freightEnquiries: [{ threadId: 't', replied: false }] })).toBe(true);
    });
    test('false when every thread has replied', () => {
        expect(quoteAwaitsFreightReply({ freightEnquiries: [{ threadId: 't', replied: true }] })).toBe(false);
    });
    test('false when the awaiting thread has no threadId (cannot be checked)', () => {
        expect(quoteAwaitsFreightReply({ freightEnquiries: [{ threadId: '', replied: false }] })).toBe(false);
    });
    test('false with no freight enquiries', () => {
        expect(quoteAwaitsFreightReply({})).toBe(false);
        expect(quoteAwaitsFreightReply({ freightEnquiries: [] })).toBe(false);
    });
});

describe('quoteHasCustomerThread — customer candidate filter', () => {
    test('true when sent with a threadId or a gmailMessageId', () => {
        expect(quoteHasCustomerThread({ sent: true, threadId: 't' })).toBe(true);
        expect(quoteHasCustomerThread({ sent: true, gmailMessageId: 'm' })).toBe(true);
    });
    test('false when not sent, or sent with no thread', () => {
        expect(quoteHasCustomerThread({ sent: false, threadId: 't' })).toBe(false);
        expect(quoteHasCustomerThread({ sent: true })).toBe(false);
    });
});

describe('source guards — button, auto-check, and projection wiring', () => {
    test('the top "Check all replies" button is rendered and wired', () => {
        expect(html).toContain('id="checkAllRepliesBtn"');
        expect(html).toContain('onclick="checkAllReplies()"');
    });
    test('auto-check runs in the background after the list loads', () => {
        expect(html).toContain('checkAllReplies({ background: true })');
    });
    test('background mode is freight-only (customer threads only on an explicit click)', () => {
        expect(html).toContain('const customerQuotes = background ? [] : approvedQuotations.filter(quoteHasCustomerThread);');
    });
    test('the sweep calls the freight module\'s headless checker', () => {
        expect(html).toContain('window.checkFreightRepliesForQuote');
    });
    test('the DynamoDB list projection carries the sweep fields', () => {
        expect(routesQuotations).toContain("'freightEnquiries', 'threadId', 'transporterReplyIn'");
    });
});
