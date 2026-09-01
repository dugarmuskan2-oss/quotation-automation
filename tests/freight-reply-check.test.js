/**
 * @jest-environment node
 *
 * tests/freight-reply-check.test.js
 *
 * checkFreightRepliesForQuote — the headless transporter-reply checker used by the
 * global "Check all replies" sweep. It reads each awaiting thread from Gmail
 * (/thread-messages); a reply is any message the account did NOT send
 * (direction === 'customer'). On a reply it marks the thread replied, pulls out
 * the price, and sets the transporterReplyIn needs-attention flag. Exposed via the
 * freight module's _test export; global.fetch is stubbed so it runs under Node.
 */
'use strict';

const { checkFreightRepliesForQuote } = require('../freight-tab-weight-editor')._test;

// Stub global.fetch. `spec` maps threadId -> messages[] | 'fail' | 'throw'.
function stubFetch(spec) {
    global.fetch = jest.fn(function (url) {
        const m = /threadId=([^&]+)/.exec(url);
        const tid = m ? decodeURIComponent(m[1]) : '';
        const entry = spec[tid];
        if (entry === 'throw') return Promise.reject(new Error('network down'));
        if (entry === 'fail') return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: entry || [] }) });
    });
}

const you = (body) => ({ direction: 'you', body: body || 'our enquiry' });
const cust = (body) => ({ direction: 'customer', from: 'ravi@roadlines.com', date: 'Wed, 22 Jul 2026', body: body });

afterEach(() => { delete global.fetch; });

describe('checkFreightRepliesForQuote', () => {
    test('detects a transporter reply: marks replied, parses the price, sets the flag', async () => {
        stubFetch({ t1: [you(), cust('Best rate Rs 18,500/- all inclusive.')] });
        const q = { hasUnsavedEdits: true, freightEnquiries: [{ email: 'a@b.com', threadId: 't1', replied: false, amount: 0, replyText: '' }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 1, newReplies: 1, failed: 0 });
        expect(q.freightEnquiries[0].replied).toBe(true);
        expect(q.freightEnquiries[0].amount).toBe(18500);
        expect(q.freightEnquiries[0].replyText).toContain('18,500');
        expect(q.transporterReplyIn).toBe(true);
    });

    test('ignores auto-replies / bounces (auto:true) — not counted as a reply', async () => {
        stubFetch({ t1: [you(), { direction: 'customer', auto: true, from: 'mailer-daemon@x.com', body: 'Delivery failed' }] });
        const q = { hasUnsavedEdits: true, freightEnquiries: [{ email: 'a@b.com', threadId: 't1', replied: false }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 1, newReplies: 0, failed: 0 });
        expect(q.freightEnquiries[0].replied).toBe(false);
        expect(q.transporterReplyIn).toBeUndefined();
    });

    test('a thread with only our own messages -> no reply counted', async () => {
        stubFetch({ t1: [you(), you('gentle follow-up')] });
        const q = { hasUnsavedEdits: true, freightEnquiries: [{ email: 'a@b.com', threadId: 't1', replied: false }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 1, newReplies: 0, failed: 0 });
        expect(q.freightEnquiries[0].replied).toBe(false);
        expect(q.transporterReplyIn).toBeUndefined();
    });

    test('a failed Gmail read leaves the thread awaiting (retried next sweep)', async () => {
        stubFetch({ t1: 'fail' });
        const q = { hasUnsavedEdits: true, freightEnquiries: [{ email: 'a@b.com', threadId: 't1', replied: false }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res.newReplies).toBe(0);
        expect(q.freightEnquiries[0].replied).toBe(false);
    });

    test('a network error is swallowed (thread stays awaiting)', async () => {
        stubFetch({ t1: 'throw' });
        const q = { hasUnsavedEdits: true, freightEnquiries: [{ email: 'a@b.com', threadId: 't1', replied: false }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res.newReplies).toBe(0);
        expect(q.freightEnquiries[0].replied).toBe(false);
    });

    test('only awaiting threads that have a threadId are checked', async () => {
        stubFetch({ t2: [you(), cust('Rs 9,000/- door to door')] });
        const q = { hasUnsavedEdits: true, freightEnquiries: [
            { email: 'a@b.com', threadId: 't1', replied: true },    // already replied -> skip
            { email: 'c@d.com', threadId: '', replied: false },     // no threadId -> skip
            { email: 'e@f.com', threadId: 't2', replied: false },   // awaiting -> checked
        ]};
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 1, newReplies: 1, failed: 0 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(q.freightEnquiries[2].amount).toBe(9000);
    });

    test('no awaiting threads -> nothing fetched', async () => {
        global.fetch = jest.fn();
        const q = { freightEnquiries: [{ threadId: 't1', replied: true }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 0, newReplies: 0 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('missing freightEnquiries -> no-op', async () => {
        global.fetch = jest.fn();
        const res = await checkFreightRepliesForQuote({});
        expect(res).toEqual({ checked: 0, newReplies: 0 });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('a failed read is not a quiet inbox', () => {
    // "No new replies." was said whether nobody had answered or Gmail never answered US.
    // Right now every read WILL fail — the Gmail read permission is still outstanding — so
    // every transporter looked like they were ignoring the owner, their reply rates sat at
    // 0%, and the Partner Directory ranked them on that number.
    test('a thread whose read fails is counted as failed, not as "no reply"', async () => {
        stubFetch({ t1: 'throw' });
        const q = { freightEnquiries: [{ email: 'a@b.com', threadId: 't1', replied: false }] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 1, newReplies: 0, failed: 1 });
        expect(q.freightEnquiries[0].replied).toBe(false);   // still awaiting, for the retry
        expect(q.transporterReplyIn).toBeUndefined();        // and NOT flagged as answered
    });

    test('a non-ok response counts as failed too, not as silence', async () => {
        stubFetch({ t1: 'fail' });
        const res = await checkFreightRepliesForQuote({ freightEnquiries: [{ threadId: 't1', replied: false }] });
        expect(res).toEqual({ checked: 1, newReplies: 0, failed: 1 });
    });

    test('a real reply alongside a failed read is still counted as a reply', async () => {
        // The mixed case is what pins it: counting truthiness would make BOTH look like
        // replies, and counting only the failures would lose the real one.
        stubFetch({ t1: 'throw', t2: [you(), cust('Rs 21,000 all in.')] });
        const q = { freightEnquiries: [
            { email: 'a@b.com', threadId: 't1', replied: false },
            { email: 'c@d.com', threadId: 't2', replied: false },
        ] };
        const res = await checkFreightRepliesForQuote(q);
        expect(res).toEqual({ checked: 2, newReplies: 1, failed: 1 });
        expect(q.freightEnquiries[0].replied).toBe(false);
        expect(q.freightEnquiries[1].replied).toBe(true);
    });
});
