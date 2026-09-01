/*
    The Cc/Bcc send semantics, run for real (extracted senders + a stubbed fetch):

      - Bcc = hidden recipients: one email PER address, that address alone on it.
      - Cc  = open copies; and with Bcc EMPTY the Cc addresses ARE the send — one
        email, everyone visible, the way Cc works in every mail client.

    A regression here is outward-facing: the wrong shape either exposes every supplier
    to the others, or silently emails nobody.
*/
const fs = require('fs');
const path = require('path');

const enquirySrc = fs.readFileSync(path.join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');
const freightSrc = fs.readFileSync(path.join(__dirname, '..', 'freight-tab-weight-editor.js'), 'utf8');

// Brace-matched extraction, same approach as the other browser-module suites.
function cut(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

// Give the sender its collaborators as spies, run it, and wait out its promise chain.
// `fetchResults` maps a request's bcc/cc to { ok, body } so failures can be scripted.
function harness(src, fnName, deps) {
    const calls = { posts: [], usage: [], persisted: 0, rendered: 0 };
    const stubs = {
        apiBase: () => '/api',
        fetch: (url, opts) => {
            const p = JSON.parse(opts.body);
            calls.posts.push(p);
            const fail = deps.failFor && deps.failFor(p);
            return Promise.resolve({
                ok: !fail,
                json: () => Promise.resolve(fail ? { error: 'scripted failure' } : { success: true, threadId: 'thr-' + calls.posts.length }),
            });
        },
        render: () => { calls.rendered++; },
    };
    const body = cut(src, fnName);
    if (fnName === 'doSend') {
        Object.assign(stubs, {
            messageToHtml: () => '<p>body</p>',
            trimSentBodyForStorage: (h) => h,
            getThreads: (q) => { if (!q.supplierEnquiries) q.supplierEnquiries = []; return q.supplierEnquiries; },
            getSentBodies: (q) => { if (!q.enquirySentBodies) q.enquirySentBodies = {}; return q.enquirySentBodies; },
            enquiryBodyKey: (t) => 'send:' + t.sentAt,
            persistThreads: () => { calls.persisted++; },
            recordSupplierUsage: (addrs) => { calls.usage.push(...addrs); },
        });
    } else {
        Object.assign(stubs, {
            enqTextToHtml: () => '<p>body</p>',
            trimSentBodyForStorage: (h) => h,
            getEnquiryThreads: (q) => { if (!q.freightEnquiries) q.freightEnquiries = []; return q.freightEnquiries; },
            getSentBodies: (q) => { if (!q.enquirySentBodies) q.enquirySentBodies = {}; return q.enquirySentBodies; },
            enquiryBodyKey: (t) => 'send:' + t.sentAt,
            persistEnquiryThreads: () => { calls.persisted++; },
            recordFreightUsage: (addrs) => { calls.usage.push(...addrs); },
        });
    }
    const keys = Object.keys(stubs);
    // chipAddrs is a real collaborator of the sender (it decides whether a chip is one firm's
    // several people or a single address), so the REAL one is extracted and run — stubbing it
    // would leave the per-firm Cc behaviour untested.
    const chipAddrsSrc = cut(src, 'chipAddrs');
    // eslint-disable-next-line no-new-func
    const fn = new Function(...keys, chipAddrsSrc + '\n' + body + '\nreturn ' + fnName + ';')(...keys.map((k) => stubs[k]));
    return {
        calls,
        run: async (...args) => {
            fn(...args);
            // The sender resolves through a Promise.all chain — a couple of macrotask
            // turns lets every .then land before we assert.
            await new Promise((r) => setTimeout(r, 0));
            await new Promise((r) => setTimeout(r, 0));
        },
    };
}

// ── Supplier enquiry (doSend) ────────────────────────────────────────────────
describe('supplier enquiry — Bcc mode is unchanged by the Cc-only feature', () => {
    test('two Bcc suppliers -> two emails, each with ONLY its own supplier hidden on it', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const q = {}, st = { bcc: ['a@steel.com', 'b@steel.com'], cc: [], sending: true };
        await h.run(q, null, st, 'Enq', st.bcc.slice(), { cc: 'ops@dscpipes.com' });

        expect(h.calls.posts).toHaveLength(2);
        expect(h.calls.posts.map((p) => p.bcc).sort()).toEqual(['a@steel.com', 'b@steel.com']);
        h.calls.posts.forEach((p) => {
            expect(p.to).toBe('');
            expect(p.cc).toBe('ops@dscpipes.com');       // the copy rides on every email
            expect(p.bcc).not.toContain(',');            // never the whole list on one message
        });
        expect(q.supplierEnquiries).toHaveLength(2);      // one thread per supplier
        expect(st.bcc).toEqual([]);                       // recipients cleared…
        expect(st.sent.startsWith('ok:')).toBe(true);
    });

    test('two people at ONE supplier ride on one email; a second supplier stays separate', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const firmA = 'rakesh@kalpatarusteel.com, nikhil@kalpatarusteel.com';
        const firmB = 'sunil@msc.in';
        const q = {}, st = { bcc: [firmA, firmB], cc: [], sending: true };
        await h.run(q, null, st, 'Enq', st.bcc.slice(), { cc: '' });

        expect(h.calls.posts).toHaveLength(2);              // one per FIRM, not per person
        const toA = h.calls.posts.find((x) => (x.cc + x.bcc).includes('kalpataru'));
        const toB = h.calls.posts.find((x) => (x.cc + x.bcc).includes('msc.in'));
        expect(toA.cc).toBe('rakesh@kalpatarusteel.com, nikhil@kalpatarusteel.com');
        expect(toA.bcc).toBe('');                           // colleagues see each other
        expect(toB.bcc).toBe('sunil@msc.in');               // a lone supplier stays hidden
        // Neither supplier learns the other was asked — the whole point of one email each.
        expect(toA.cc + toA.bcc).not.toContain('msc.in');
        expect(toB.cc + toB.bcc).not.toContain('kalpataru');
    });

    test('a failed recipient stays in the Bcc box for retry; the rest are recorded', async () => {
        const h = harness(enquirySrc, 'doSend', { failFor: (p) => p.bcc === 'bad@steel.com' });
        const q = {}, st = { bcc: ['a@steel.com', 'bad@steel.com'], cc: [], sending: true };
        await h.run(q, null, st, 'Enq', st.bcc.slice(), { cc: '' });

        expect(q.supplierEnquiries.map((t) => t.email)).toEqual(['a@steel.com']);
        expect(st.bcc).toEqual(['bad@steel.com']);
        expect(st.sent.startsWith('err:')).toBe(true);
    });
});

describe('supplier enquiry — Cc-only is ONE open email (the screenshot case)', () => {
    test('Bcc empty + Cc filled -> one email, addresses visible in Cc, nothing hidden', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const q = {}, st = { bcc: [], cc: ['bala@mahaseam.com', 'mk@mahaseam.com'], sending: true };
        await h.run(q, null, st, 'Enq', [], { cc: st.cc.join(', ') });

        expect(h.calls.posts).toHaveLength(1);            // ONE email, not one per address
        expect(h.calls.posts[0]).toMatchObject({
            to: '', cc: 'bala@mahaseam.com, mk@mahaseam.com', bcc: '',
        });
    });

    test('one thread for the one email — reply tracking still has something to watch', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const q = {}, st = { bcc: [], cc: ['bala@mahaseam.com', 'mk@mahaseam.com'], sending: true };
        await h.run(q, null, st, 'Enq', [], { cc: st.cc.join(', ') });

        expect(q.supplierEnquiries).toHaveLength(1);
        expect(q.supplierEnquiries[0].email).toBe('bala@mahaseam.com, mk@mahaseam.com');
        expect(q.supplierEnquiries[0].threadId).toBe('thr-1');
        expect(h.calls.persisted).toBe(1);
    });

    test('supplier memory learns each address individually, not one comma-glued entry', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const st = { bcc: [], cc: ['bala@mahaseam.com', 'mk@mahaseam.com'], sending: true };
        await h.run({}, null, st, 'Enq', [], { cc: st.cc.join(', ') });

        expect(h.calls.usage).toEqual(['bala@mahaseam.com', 'mk@mahaseam.com']);
    });

    test('the Cc list clears after ITS send — it acted as the recipients', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const st = { bcc: [], cc: ['bala@mahaseam.com'], sending: true };
        await h.run({}, null, st, 'Enq', [], { cc: 'bala@mahaseam.com' });
        expect(st.cc).toEqual([]);
        expect(st.sent).toContain('open email');
    });

    test('…but a Bcc send keeps the Cc list — there it was only a copy', async () => {
        const h = harness(enquirySrc, 'doSend', {});
        const st = { bcc: ['a@steel.com'], cc: ['ops@dscpipes.com'], sending: true };
        await h.run({}, null, st, 'Enq', st.bcc.slice(), { cc: 'ops@dscpipes.com' });
        expect(st.cc).toEqual(['ops@dscpipes.com']);
    });

    test('a failed Cc-only send keeps the addresses in the box and records nothing', async () => {
        const h = harness(enquirySrc, 'doSend', { failFor: () => true });
        const q = {}, st = { bcc: [], cc: ['bala@mahaseam.com'], sending: true };
        await h.run(q, null, st, 'Enq', [], { cc: 'bala@mahaseam.com' });

        expect(st.cc).toEqual(['bala@mahaseam.com']);     // still there to retry
        expect((q.supplierEnquiries || [])).toHaveLength(0);
        expect(st.sent.startsWith('err:')).toBe(true);
    });
});

// ── Freight enquiry (freightSendAll) ─────────────────────────────────────────
describe('freight enquiry — the same two modes', () => {
    test('Bcc mode: one email per transporter, hidden, shipment scope on each thread', async () => {
        const h = harness(freightSrc, 'freightSendAll', {});
        const q = {}, enq = { bcc: ['ravi@transport.com', 'suresh@carriers.com'], cc: [], sending: true };
        await h.run(q, { }, null, enq, enq.bcc.slice(), 'Freight', 'body', 2, { cc: '' });

        expect(h.calls.posts).toHaveLength(2);
        h.calls.posts.forEach((p) => { expect(p.to).toBe(''); expect(p.bcc).not.toContain(','); });
        expect(q.freightEnquiries.map((t) => t.forSec)).toEqual([2, 2]);
        expect(enq.bcc).toEqual([]);
    });

    test('two people at ONE firm ride on one email, Cc’d so they see each other', async () => {
        const h = harness(freightSrc, 'freightSendAll', {});
        const firm = 'manoj@sgroadlines.com, accounts@sgroadlines.com';
        const q = {}, enq = { bcc: [firm], cc: [], sending: true };
        await h.run(q, { }, null, enq, [firm], 'Freight', 'body', 0, { cc: 'ops@dscpipes.com' });

        expect(h.calls.posts).toHaveLength(1);              // ONE email, not one per person
        const p = h.calls.posts[0];
        expect(p.bcc).toBe('');                             // not hidden from each other…
        expect(p.cc).toContain('manoj@sgroadlines.com');    // …both openly on it
        expect(p.cc).toContain('accounts@sgroadlines.com');
        expect(p.cc).toContain('ops@dscpipes.com');         // our own copy still rides along
    });

    test('two FIRMS stay separate emails — neither can see the other was asked', async () => {
        const h = harness(freightSrc, 'freightSendAll', {});
        const firmA = 'manoj@sgroadlines.com, accounts@sgroadlines.com';
        const firmB = 'prabhu@sakthicargo.com';
        const q = {}, enq = { bcc: [firmA, firmB], cc: [], sending: true };
        await h.run(q, { }, null, enq, [firmA, firmB], 'Freight', 'body', 0, { cc: '' });

        expect(h.calls.posts).toHaveLength(2);
        const toA = h.calls.posts.find((x) => (x.cc + x.bcc).includes('sgroadlines'));
        const toB = h.calls.posts.find((x) => (x.cc + x.bcc).includes('sakthicargo'));
        // The pair are grouped and visible to each other; the lone firm stays hidden on Bcc.
        expect(toA.cc).toBe('manoj@sgroadlines.com, accounts@sgroadlines.com');
        expect(toB.bcc).toBe('prabhu@sakthicargo.com');
        // The rule that matters: no firm's address appears on the other firm's email.
        expect(toA.cc + toA.bcc).not.toContain('sakthicargo');
        expect(toB.cc + toB.bcc).not.toContain('sgroadlines');
        // Both people at the grouped firm are still remembered individually.
        expect(h.calls.usage).toContain('manoj@sgroadlines.com');
        expect(h.calls.usage).toContain('accounts@sgroadlines.com');
    });

    test('Cc-only: one open email; one thread carrying the shipment scope', async () => {
        const h = harness(freightSrc, 'freightSendAll', {});
        const q = {}, enq = { bcc: [], cc: ['ravi@transport.com', 'suresh@carriers.com'], sending: true };
        await h.run(q, { }, null, enq, [], 'Freight', 'body', 1, { cc: enq.cc.join(', ') });

        expect(h.calls.posts).toHaveLength(1);
        expect(h.calls.posts[0]).toMatchObject({ to: '', cc: 'ravi@transport.com, suresh@carriers.com', bcc: '', label: 'freight' });
        expect(q.freightEnquiries).toHaveLength(1);
        expect(q.freightEnquiries[0].forSec).toBe(1);
        expect(enq.cc).toEqual([]);
        expect(h.calls.usage).toEqual(['ravi@transport.com', 'suresh@carriers.com']);
    });
});

// ── The gates that let a Cc-only send through ────────────────────────────────
describe('source guards — either box is a recipient source', () => {
    test('the supplier Send button accepts Bcc OR Cc, and its guard matches', () => {
        expect(enquirySrc).toContain('(st.bcc.length || st.cc.length) && !st.sending');
        expect(enquirySrc).toContain('if ((!st.bcc.length && !st.cc.length) || st.sending');
    });

    test('the freight gates all accept Bcc OR Cc', () => {
        // The click guard, unchanged.
        expect(freightSrc).toContain('!(enq.bcc.length || enq.cc.length) || enq.sending');
        // The button's own condition moved into canSendEnquiry when a just-sent lock was added,
        // so the guard follows it there. Cc alone must still count as a recipient: a chip that
        // holds a whole firm goes in Cc, and requiring Bcc would grey Send out for it.
        expect(freightSrc).toContain('return !!(enq.bcc.length || enq.cc.length) && !enq.sending');
        // ...and both places that decide whether Send is live ask that one function.
        expect(freightSrc.match(/canSendEnquiry\(st\)/g).length).toBeGreaterThanOrEqual(3);
    });

    test('the server fills its own address into To for EVERY no-To shape', () => {
        const gmail = fs.readFileSync(path.join(__dirname, '..', 'utils', 'gmail.js'), 'utf8');
        expect(gmail).toContain('if (!to && (bcc || cc)) to = await getOwnAddress();');
    });
});
