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

const fs = require('fs');
const path = require('path');
const FWE_PATH = path.join(__dirname, '..', 'freight-tab-weight-editor.js');
const { checkFreightRepliesForQuote, saveRepliesThenTellDirectory, finishReplyCheck, enquiryThreadsHtml } =
    require('../freight-tab-weight-editor')._test;

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

// The Partner Directory's "replied %" is what ranks a transporter. Telling it about a reply
// whose "replied" flag never SAVED counts that same reply again on the next sweep after a
// reload, and a one-man firm ends up reading "Asked 1 time · replied 200%".
describe('a reply reaches the directory only once it is saved', () => {
    let recordUsage;
    // `saveOk` decides what the freight-enquiries write answers; the thread read is fixed.
    function stubReplyAndSave(saveOk) {
        global.fetch = jest.fn(function (url) {
            if (/freight-enquiries/.test(url)) return Promise.resolve({ ok: saveOk, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [you(), cust('Rs 18,500/-')] }) });
        });
    }
    beforeEach(() => {
        recordUsage = jest.fn();
        global.window = { partnerDirectory: { recordUsage } };
    });
    afterEach(() => { delete global.window; });

    const quote = () => ({ id: 'q1', freightEnquiries: [{ email: 'ravi@sri.in', threadId: 't1', replied: false }] });

    test('save succeeds -> the directory is told once', async () => {
        stubReplyAndSave(true);
        const res = await checkFreightRepliesForQuote(quote());
        expect(res.newReplies).toBe(1);
        expect(recordUsage).toHaveBeenCalledTimes(1);
        expect(recordUsage.mock.calls[0][0]).toMatchObject({ kind: 'reply', emails: ['ravi@sri.in'] });
    });

    test('save fails -> the directory is NOT told, so the retry cannot double-count', async () => {
        stubReplyAndSave(false);
        const res = await checkFreightRepliesForQuote(quote());
        expect(res.newReplies).toBe(1);          // still reported to the sweep
        expect(recordUsage).not.toHaveBeenCalled();
    });

    test('the interactive Check button goes through the same gate', () => {
        // Both checkers have to record a reply the same way. The rule lives in ONE function,
        // and this is what stops a second, unconditional call being added beside it: the name
        // may appear exactly twice — where it is defined, and inside that one gate.
        const src = fs.readFileSync(FWE_PATH, 'utf8');
        expect(src.split('tellDirectoryReplied')).toHaveLength(3);
        expect(src).toContain('function saveRepliesThenTellDirectory(q, replied, onSaveFailed)');
        expect(src.split('saveRepliesThenTellDirectory(q, waiting')).toHaveLength(3);
    });

    test('save fails -> the person is told, not just the console', async () => {
        const told = jest.fn();
        stubReplyAndSave(false);
        const ok = await saveRepliesThenTellDirectory({ id: 'q1', freightEnquiries: [] }, [], told);
        expect(ok).toBe(false);
        expect(told).toHaveBeenCalled();          // the Freight tab prints this on screen
        expect(recordUsage).not.toHaveBeenCalled();
    });

    test('the caller waits for the save, so a failed write cannot land after the sweep says done', async () => {
        stubReplyAndSave(true);
        await checkFreightRepliesForQuote(quote());
        // Two thread reads? No — one read plus the save. Proves the save is inside the promise
        // the caller awaited, not fired off and forgotten.
        const saves = global.fetch.mock.calls.filter(c => /freight-enquiries/.test(c[0]));
        expect(saves).toHaveLength(1);
    });
});

// Check 4: a failure has to LOOK like a failure. The line saying the reply had not been saved
// was painted after the approval list had been rebuilt — and the rebuild replaces this card,
// so the message went into an element that was no longer on the page. The quote then looked
// like it had safely recorded a reply it had not.
describe('a reply that could not be saved is said where the user is looking', () => {
    // The save answers `saveOk`; nothing else is fetched here.
    function stubSave(saveOk) {
        global.fetch = jest.fn(() => Promise.resolve({ ok: saveOk, json: () => Promise.resolve({}) }));
    }
    afterEach(() => { delete global.fetch; delete global.window; });

    // A quote with one transporter who has answered, and the composer state that draws them.
    const quote = () => ({
        id: 'q1',
        freightEnquiries: [{ email: 'ravi@sri.in', threadId: 't1', replied: true, replyText: 'Rs 18,500/-', amount: 18500 }],
    });
    const state = () => ({ enquiry: { checkResult: '', openReplies: {} } });

    // The card on screen, plus the list rebuild that throws it away.
    function screen(q, st) {
        const card = { alive: true, shown: '' };
        const seen = [];
        const repaint = jest.fn(() => {
            card.shown = enquiryThreadsHtml(q, st);
            if (card.alive) seen.push(card.shown);     // only counts if the card is still on the page
        });
        const rebuild = jest.fn(() => { card.alive = false; card.shown = ''; });
        return { card, seen, repaint, rebuild };
    }

    test('the failure line is painted into the live card, before the list replaces it', async () => {
        stubSave(false);
        const q = quote(), st = state();
        const s = screen(q, st);
        await finishReplyCheck(q, st, q.freightEnquiries, s.repaint, s.rebuild);
        expect(s.seen).toHaveLength(1);
        expect(s.seen[0]).toContain('saving it failed');
        expect(s.seen[0]).toContain('Reload the page');
        expect(s.card.alive).toBe(false);   // the list did rebuild — just afterwards
    });

    test('the repaint happens before the rebuild, never after', async () => {
        stubSave(false);
        const q = quote(), st = state();
        const s = screen(q, st);
        await finishReplyCheck(q, st, q.freightEnquiries, s.repaint, s.rebuild);
        expect(s.repaint.mock.invocationCallOrder[0])
            .toBeLessThan(s.rebuild.mock.invocationCallOrder[0]);
    });

    test('a save that worked says nothing alarming', async () => {
        stubSave(true);
        const q = quote(), st = state();
        const s = screen(q, st);
        await finishReplyCheck(q, st, q.freightEnquiries, s.repaint, s.rebuild);
        expect(st.enquiry.checkResult).toBe('');
        expect(s.seen[0]).not.toContain('saving it failed');
    });

    test('the message has a home in the markup — it renders where the replies are listed', () => {
        const q = quote(), st = state();
        st.enquiry.checkResult = 'A reply came in, but saving it failed. Reload the page and check again.';
        const html = enquiryThreadsHtml(q, st);
        expect(html).toContain('saving it failed');
        expect(html).toContain('ravi@sri.in');   // …in the same block as the transporter it is about
    });

    test('nothing is painted after the rebuild, in the source itself', () => {
        const src = fs.readFileSync(FWE_PATH, 'utf8');
        const fn = src.slice(src.indexOf('function finishReplyCheck'));
        expect(fn.indexOf('repaint();')).toBeGreaterThan(-1);
        expect(fn.indexOf('repaint();')).toBeLessThan(fn.indexOf('rebuildList();'));
        // …and the list rebuild is defined once and handed over once. Any other call site
        // would be a rebuild that escapes the ordering above.
        expect(src.split('function refreshApprovalList()')).toHaveLength(2);
        expect(src.split(/refreshApprovalList\b(?!Preserving)/)).toHaveLength(3);
    });
});
