/*
    Tests for the flow-sweep work: the Freight panel keeping step with the quote, the in-place
    repaint that replaced the full re-render, the Bcc/Cc senders, the register's filing date, and
    the search box's month-name promise.

    These are the parts where a regression is silent — a wrong weight reaches a transporter, a
    quote drops out of its month, a supplier sees who else was asked — so each test names the
    real-world failure it is guarding, not just the function.
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// hasBadRecipient defers to the app's own validator, which lives in index.html. Without it in
// scope the guard silently passes everything — so supply the real rule here, or these tests
// would "pass" against a function that can never report a bad address.
global.isValidEmailAddress = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

const freight = require(path.join(ROOT, 'freight-tab-weight-editor.js'))._test;
const enquiryTabSrc = fs.readFileSync(path.join(ROOT, 'quote-enquiry-tab.js'), 'utf8');
const freightSrc = fs.readFileSync(path.join(ROOT, 'freight-tab-weight-editor.js'), 'utf8');

// ── Freight panel: staying in step with the quote ────────────────────────────
// The rows used to be seeded ONCE and cached for the life of the page, so editing quantities or
// adding/removing items on the Quote tab left the freight weight computed from the old figures —
// and with qty locked read-only there was no way to correct it. That weight is what a transporter
// is quoted on, so it silently priced the wrong shipment.
describe('syncRowsWithQuote — the panel follows the quote without losing your work', () => {
    const { syncRowsWithQuote, quoteRowId } = freight;

    const quoteWith = (items) => ({ lineItems: items });
    const li = (id, desc, qty, kgm, type) => ({
        lineItemId: id, originalDescription: desc, quantity: qty, kgPerMeter: kgm, identifiedPipeType: type,
    });

    test('a quantity changed on the Quote tab reaches the panel', () => {
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 5.4, 'GI')]), st);
        expect(st.rows[0].qty).toBe(100);

        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 250, 5.4, 'GI')]), st);
        expect(st.rows).toHaveLength(1);
        expect(st.rows[0].qty).toBe(250);
    });

    test('a line added on the Quote tab appears; a line deleted there stops adding weight', () => {
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 5.4), li('a2', '3" GI', 50, 8)]), st);
        expect(st.rows.map((r) => r.id)).toEqual(['a1', 'a2']);

        // a2 deleted on the Quote tab, a3 added.
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 5.4), li('a3', '1" ERW', 40, 2)]), st);
        expect(st.rows.map((r) => r.id)).toEqual(['a1', 'a3']);
    });

    test('a row the user added here by hand survives a re-sync', () => {
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 5.4)]), st);
        st.rows.push({ id: 'w1', d: 'Packing timber', qty: 3, kgm: 12, sec: 1 });   // no fromQuote

        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 5.4)]), st);
        expect(st.rows.map((r) => r.id)).toEqual(['a1', 'w1']);
        expect(st.rows[1].d).toBe('Packing timber');
    });

    test('a quantity TYPED here for sizing is not wiped when the quote still has none', () => {
        // The panel opens qty for editing precisely when the quote has no quantity. Overwriting
        // it from the (still empty) quote would erase the only number the weight can use.
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', '', 5.4)]), st);
        expect(st.rows[0].qty).toBeNull();

        st.rows[0].qty = 80;                                    // user types it
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', '', 5.4)]), st);
        expect(st.rows[0].qty).toBe(80);

        // …but once the quote DOES carry a quantity, the quote wins.
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 120, 5.4)]), st);
        expect(st.rows[0].qty).toBe(120);
    });

    test('a description follows the quote on SAVE only — never mid-edit', () => {
        // The panel used to follow the quote on every render, so a half-typed size on the Quote
        // tab reached the freight weight before anyone had committed to it.
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', 'Original text', 10, 1), li('a2', 'Follows me', 10, 1)]), st, { onSave: true });

        syncRowsWithQuote(quoteWith([li('a1', 'Original text', 10, 1), li('a2', 'Changed too', 10, 1)]), st);
        expect(st.rows[1].d).toBe('Follows me');            // a render must not move it

        syncRowsWithQuote(quoteWith([li('a1', 'Original text', 10, 1), li('a2', 'Changed too', 10, 1)]), st, { onSave: true });
        expect(st.rows[1].d).toBe('Changed too');           // the save does
    });

    test('a description edited here is kept — until the quote row itself changes', () => {
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', 'Original text', 10, 1)]), st, { onSave: true });
        st.rows[0].d = 'My own wording';
        st.rows[0].dEdited = true;

        // A save that leaves this row alone must not touch the wording.
        syncRowsWithQuote(quoteWith([li('a1', 'Original text', 10, 1)]), st, { onSave: true });
        expect(st.rows[0].d).toBe('My own wording');

        // But once the row really changes, the quote wins: the hand-written label described a
        // pipe that is no longer on the quote, so keeping it would mislabel the freight.
        syncRowsWithQuote(quoteWith([li('a1', 'Changed on quote', 10, 1)]), st, { onSave: true });
        expect(st.rows[0].d).toBe('Changed on quote');
        expect(st.rows[0].dEdited).toBe(false);
    });

    test('a changed row loses the weight that belonged to the OLD size', () => {
        // The bug this guards: change 2" to 8" and the panel kept 2"'s kg/m, so the freight was
        // billed on the wrong pipe. A blank goes red; a wrong number shows nothing.
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', '2" NB X Heavy', 100, 6.19, 'ERW')]), st, { onSave: true });
        expect(st.rows[0].kgm).toBe(6.19);

        syncRowsWithQuote(quoteWith([li('a1', '8" NB X 10 MM', 100, '', 'ERW')]), st, { onSave: true });
        expect(st.rows[0].kgm).toBeNull();
        expect(st.rows[0].qty).toBe(100);                   // quantity is not collateral damage

        // A pipe-type swap at the same size is also a different pipe, and a different weight.
        const st2 = { rows: [] };
        syncRowsWithQuote(quoteWith([li('b1', '2" NB X Heavy', 100, 6.19, 'ERW')]), st2, { onSave: true });
        syncRowsWithQuote(quoteWith([li('b1', '2" NB X Heavy', 100, '', 'GI')]), st2, { onSave: true });
        expect(st2.rows[0].kgm).toBeNull();

        // When the quote itself supplies the new weight, that is what the panel takes.
        const st3 = { rows: [] };
        syncRowsWithQuote(quoteWith([li('c1', '2" NB X Heavy', 100, 6.19, 'ERW')]), st3, { onSave: true });
        syncRowsWithQuote(quoteWith([li('c1', '8" NB X 10 MM', 100, 85.29, 'ERW')]), st3, { onSave: true });
        expect(st3.rows[0].kgm).toBe(85.29);
    });

    test('a kg/m typed here is kept while the quote has none, and follows the quote when it has', () => {
        const st = { rows: [] };
        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 0)]), st);
        st.rows[0].kgm = 5.4;                                    // user fills the gap

        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 0)]), st);
        expect(st.rows[0].kgm).toBe(5.4);

        syncRowsWithQuote(quoteWith([li('a1', '2" GI', 100, 6.1)]), st);
        expect(st.rows[0].kgm).toBe(6.1);
    });

    test('lines with no lineItemId get a STABLE id, so they re-match instead of duplicating', () => {
        // The old fallback minted a fresh 'w'+seq id on every seed, so these lines could never be
        // matched again — each sync would have piled on another copy of the same item.
        const noId = [{ originalDescription: 'No id line', quantity: 10, kgPerMeter: 2 }];
        expect(quoteRowId(noId[0], 0)).toBe('q0');

        const st = { rows: [] };
        syncRowsWithQuote(quoteWith(noId), st);
        syncRowsWithQuote(quoteWith(noId), st);
        syncRowsWithQuote(quoteWith(noId), st);
        expect(st.rows).toHaveLength(1);
    });

    test('an explicit lineItemId is preferred over the positional id', () => {
        expect(quoteRowId({ lineItemId: 'abc' }, 3)).toBe('abc');
    });
});

// ── The in-place repaint ─────────────────────────────────────────────────────
// Editing a weight field used to rebuild the whole tab on blur, which destroyed the button the
// user was mid-click on. These builders exist so the derived numbers can be patched in place.
describe('the derived-value builders the in-place repaint writes', () => {
    const { rowWeightHtml, sectionTitleHtml, totalRowHtml } = freight;
    const rows = (list) => ({ rows: list, split: false });

    test('rowWeightHtml names WHICH value is missing, rather than showing a wrong number', () => {
        expect(rowWeightHtml({ qty: null, kgm: 5 })).toContain('no qty');
        expect(rowWeightHtml({ qty: 10, kgm: 0 })).toContain('not counted');
        expect(rowWeightHtml({ qty: 100, kgm: 5.4 })).toBe('540 kg');
    });

    test('the section heading carries the total only once every row is complete', () => {
        expect(sectionTitleHtml(rows([{ sec: 1, qty: 100, kgm: 5.4 }]), 1))
            .toBe('Weight &middot; 540 kg (0.54 Tonn)');
        // One row missing kg/m: a partial total would understate what the transporter is quoted.
        expect(sectionTitleHtml(rows([{ sec: 1, qty: 100, kgm: 5.4 }, { sec: 1, qty: 50, kgm: 0 }]), 1))
            .toBe('Weight');
    });

    test('an incomplete section prompts for the missing field instead of a total', () => {
        const out = totalRowHtml(rows([{ sec: 1, qty: null, kgm: 5.4 }]), 1);
        expect(out).toContain('missing quantity');
        expect(out).not.toContain('Total weight');
    });

    test('a complete welded section shows the total AND the 7% tolerance line', () => {
        const out = totalRowHtml(rows([{ sec: 1, qty: 100, kgm: 5.4, d: '2" NB -- GI' }]), 1);
        expect(out).toContain('Total weight');
        expect(out).toContain('With tolerance (7%)');
        expect(out).toContain('502 kg');            // 540 x 0.93
    });

    test('an all-seamless section shows NO tolerance line (billed at exact weight)', () => {
        const out = totalRowHtml(rows([{ sec: 1, qty: 100, kgm: 5.4, d: '3" NB X Sch 40' }]), 1);
        expect(out).toContain('Total weight');
        expect(out).not.toContain('tolerance');
    });

    test('a MIXED section deducts the 7% from the welded part ONLY', () => {
        // The case that actually pins the rule. An all-welded section reads the same whether the
        // factor is applied per-row or to the whole total, so only a mixed one can tell them
        // apart — deducting 7% from seamless would under-bill every mixed shipment.
        const out = totalRowHtml(rows([
            { sec: 1, qty: 100, kgm: 1, d: '3" NB X Sch 40' },      // seamless: 100 kg, kept whole
            { sec: 1, qty: 100, kgm: 1, d: '2" NB X Heavy -- ERW' },// welded:  100 kg -> 93 kg
        ]), 1);
        expect(out).toContain('Total weight');
        expect(out).toContain('200 kg');     // exact total
        expect(out).toContain('193 kg');     // 100 + 93, NOT 186
        expect(out).not.toContain('186 kg');
    });

    test('an empty section renders nothing at all', () => {
        expect(totalRowHtml(rows([]), 1)).toBe('');
    });
});

// ── The enquiry weight gate ──────────────────────────────────────────────────
describe('a typed weight counts even when it equals the partial calculated sum', () => {
    const { enqWeightUsable, enqScopeWeight } = freight;

    // A scope with one counted row (540) and one that contributes nothing.
    const partial = {
        split: false,
        rows: [{ sec: 1, qty: 100, kgm: 5.4 }, { sec: 1, qty: 50, kgm: 0 }],
        enquiry: { forSec: 0, weightOverride: null },
    };

    test('the calculated sum alone is NOT usable while a row is uncounted', () => {
        expect(enqScopeWeight(partial)).toBe(540);
        expect(enqWeightUsable(partial)).toBe(false);
    });

    test('typing that same 540 IS usable — it is the only weight we have', () => {
        // The old rule discarded any typed value equal to the calculated sum, treating it as
        // "not an override". With an incomplete scope that left Send disabled and the warning up,
        // with no way forward at all.
        const typed = Object.assign({}, partial, { enquiry: { forSec: 0, weightOverride: 540 } });
        expect(enqWeightUsable(typed)).toBe(true);
    });

    test('a complete scope that totals zero is still not a usable weight', () => {
        // "Weight: 0 kg" tells a transporter nothing and cannot be priced.
        const zero = { split: false, rows: [{ sec: 1, qty: 0, kgm: 5.4 }], enquiry: { forSec: 0, weightOverride: null } };
        expect(enqWeightUsable(zero)).toBe(false);
    });
});

// ── Recipients: Bcc is the list, Cc is the copy ──────────────────────────────
describe('hasBadRecipient — a typo in Cc must block the send, not just that copy', () => {
    const { hasBadRecipient } = freight;

    test('a bad address in Bcc is caught', () => {
        expect(hasBadRecipient({ bcc: ['ravi@transport.com', 'not-an-address'], cc: [] })).toBe(true);
    });

    test('a bad address in Cc is caught too', () => {
        expect(hasBadRecipient({ bcc: ['ravi@transport.com'], cc: ['oops'] })).toBe(true);
    });

    test('all-valid passes', () => {
        expect(hasBadRecipient({ bcc: ['ravi@transport.com'], cc: ['ops@dscpipes.com'] })).toBe(false);
    });

    test('missing cc/bcc arrays do not throw (state from before these boxes existed)', () => {
        expect(() => hasBadRecipient({ bcc: ['a@b.com'] })).not.toThrow();
        expect(() => hasBadRecipient({})).not.toThrow();
    });
});

// Source guards: the send shape is what keeps recipients hidden from each other and keeps each
// reply in its own thread. A behavioural test cannot reach it (it needs a live fetch), so pin the
// two rules that matter in the source.
describe('source guards — one email per recipient, that recipient alone on Bcc', () => {
    // The rule: addresses in BCC are hidden from each other — one email each, that address
    // alone on it. Addresses in CC are open BY DESIGN (one email, everyone visible), so the
    // cc-only branch is allowed; what must never happen is the hidden list glued into one
    // message's Bcc, which would expose every supplier to the others.
    test('the supplier enquiry posts one email per Bcc address, with only that address on it', () => {
        expect(enquiryTabSrc).toContain('Promise.all(sends.map(function (addr) {');
        expect(enquiryTabSrc).toMatch(/: \{ to: '', cc: extra\.cc, bcc: addr,/);      // Bcc branch
        expect(enquiryTabSrc).toMatch(/\? \{ to: '', cc: addr, bcc: '',/);            // open Cc branch
        expect(enquiryTabSrc).not.toMatch(/bcc: recipients\.join/);
        expect(enquiryTabSrc).not.toMatch(/bcc: extra\.cc/);
    });

    test('the freight enquiry does the same', () => {
        expect(freightSrc).toContain('Promise.all(sends.map(function (addr) {');
        expect(freightSrc).toMatch(/: \{ to: '', cc: extra\.cc, bcc: addr,/);
        expect(freightSrc).toMatch(/\? \{ to: '', cc: addr, bcc: '',/);
        expect(freightSrc).not.toMatch(/bcc: recipients\.join/);
        expect(freightSrc).not.toMatch(/bcc: extra\.cc/);
    });

    test('both composers render a Bcc recipient box and a Cc box, and no To box', () => {
        expect(enquiryTabSrc).toContain('Bcc &mdash; suppliers / dealers');
        expect(enquiryTabSrc).not.toContain('To &mdash; suppliers / dealers');
        expect(freightSrc).toContain('Bcc — transporters');
        expect(freightSrc).not.toContain('To — transporters');
    });

    test('the recipient list is `bcc`, so nothing still reads a `to` list at send time', () => {
        expect(freightSrc).toContain('var recipients = enq.bcc.slice();');
        expect(enquiryTabSrc).toContain('var recipients = st.bcc.slice();');
    });
});

// ── The Enquiry tab's table after a reload ───────────────────────────────────
describe('the Enquiry tab re-seeds its rows whenever it has none', () => {
    test('the seed is NOT skipped just because enquiries have already been sent', () => {
        // Source guard: after a reload the in-page rows are empty but the sent threads come back
        // from the server. The old `&& !threads.length` left the table blank, Send disabled (it
        // needs a row) and "Create enquiry" gone — so emailing one more supplier meant retyping
        // every line by hand.
        expect(enquiryTabSrc).toContain('if (!st.rows.length) st.rows = buildRowsFromQuote(quotation);');
        expect(enquiryTabSrc).not.toContain('if (!st.rows.length && !threads.length)');
    });
});

// ── The freight enquiry message ──────────────────────────────────────────────
describe('the draft is only "hand-edited" when it really differs', () => {
    test('sending does not mark an untouched message as edited', () => {
        // Marking it unconditionally froze the body at the first send: a later route, kg/m or
        // shipment change never reached it, so the subject line and the text disagreed and a
        // second transporter could be sent the first shipment's details.
        expect(freightSrc).toMatch(
            /enq\.messageEdited = \(String\(bodyText\)\.trim\(\) !== buildEnquiryDraft\(q, st\)\.trim\(\)\);/);
        expect(freightSrc).not.toContain('enq.message = bodyText; enq.messageEdited = true;');
    });

    test('typing does not latch it either — it is compared, not set', () => {
        expect(freightSrc).toMatch(
            /enq\.messageEdited = \(msg\.value\.trim\(\) !== buildEnquiryDraft\(q, st\)\.trim\(\)\);/);
    });
});
