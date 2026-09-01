/**
 * @jest-environment node
 *
 * tests/freight-tab.test.js
 *
 * Freight tab module (freight-tab-weight-editor.js):
 *  - behavioral tests of the pure helpers exported on module._test
 *    (parseFreightAmount, trimReplyForStorage, rememberedTransportersForRoute)
 *  - source-guard tests that assert key markers still exist in the browser module
 *    and in index.html, following the tests/approval-edit.test.js pattern.
 */

const fs = require('fs');
const path = require('path');

const FWE_PATH = path.join(__dirname, '..', 'freight-tab-weight-editor.js');
const INDEX_PATH = path.join(__dirname, '..', 'index.html');

const { parseFreightAmount, trimReplyForStorage, rememberedTransportersForRoute, weightOf, secWeight, _setSuggest } =
    require('../freight-tab-weight-editor')._test;

describe('parseFreightAmount — pull a rupee amount out of a transporter reply', () => {
    test.each([
        ['Rs 18,500 all inclusive', 18500],
        ['₹18500/- door delivery', 18500],
        ['INR 18,500.00 per trip', 18500],
        ['We can do 18,500/- flat', 18500],
        ['Rs.2000', 2000],
        ['Best rate Rs 9,750 and transit 2 days', 9750],
    ])('parses %j -> %i', (text, expected) => {
        expect(parseFreightAmount(text)).toBe(expected);
    });

    test('no currency marker and no /- suffix -> 0 (never guesses)', () => {
        expect(parseFreightAmount('we can do 18500 per trip')).toBe(0);
        expect(parseFreightAmount('call me to discuss')).toBe(0);
        expect(parseFreightAmount('')).toBe(0);
        expect(parseFreightAmount(null)).toBe(0);
    });

    test('takes the first amount when several appear', () => {
        expect(parseFreightAmount('Rs 12,000 base, Rs 3,000 extra')).toBe(12000);
    });
});

describe('trimReplyForStorage — keep persisted reply bodies small', () => {
    test('short reply is returned unchanged', () => {
        const r = 'Rate is Rs 18,500/-. Transit 3 days.';
        expect(trimReplyForStorage(r)).toBe(r);
    });

    test('strips the quoted enquiry chain below "On ... wrote:"', () => {
        const reply = 'Rate is Rs 18,500/-.\n\nOn Thu, 3 Jul 2026 DSC Pipes wrote:\n> Please share your best rate';
        const out = trimReplyForStorage(reply);
        expect(out).toContain('Rs 18,500/-');
        expect(out).not.toContain('wrote:');
        expect(out).not.toContain('Please share your best rate');
    });

    test('truncates very long bodies and marks them', () => {
        const long = 'x'.repeat(5000);
        const out = trimReplyForStorage(long);
        expect(out.length).toBeLessThan(long.length);
        expect(out).toMatch(/\[truncated\]$/);
    });
});

describe('rememberedTransportersForRoute — route-aware ranking', () => {
    const fixture = {
        transporters: [
            { email: 'ravi@sri.in', count: 3, lastUsed: '2026-07-03' },
            { email: 'vrl@mum.in', count: 1, lastUsed: '2026-07-02' },
            { email: 'gopal@hyd.in', count: 1, lastUsed: '2026-07-01' },
            { email: 'northex@del.in', count: 2, lastUsed: '2026-07-01' },
        ],
        routes: [
            { pickup: 'Chennai', drop: 'Hyderabad', transporters: [
                { email: 'ravi@sri.in', count: 2, lastUsed: '2026-07-03' },
                { email: 'gopal@hyd.in', count: 1, lastUsed: '2026-07-01' },
            ] },
            { pickup: 'Chennai', drop: 'Mumbai', transporters: [
                { email: 'vrl@mum.in', count: 1, lastUsed: '2026-07-02' },
            ] },
        ],
        pickups: [], drops: [],
    };
    beforeEach(() => _setSuggest(JSON.parse(JSON.stringify(fixture))));

    const emails = list => list.map(t => t.email);

    test('no route entered -> global list ranked by usage', () => {
        expect(emails(rememberedTransportersForRoute('', '', ''))).toEqual(
            ['ravi@sri.in', 'northex@del.in', 'vrl@mum.in', 'gopal@hyd.in']
        );
    });

    test('exact pickup+drop puts that route\'s transporters first', () => {
        const out = emails(rememberedTransportersForRoute('', 'Chennai', 'Hyderabad'));
        expect(out.slice(0, 2)).toEqual(['ravi@sri.in', 'gopal@hyd.in']);
        // the rest of the global list follows, deduped
        expect(out).toContain('vrl@mum.in');
        expect(new Set(out).size).toBe(out.length);
    });

    test('different drop surfaces that route first', () => {
        expect(emails(rememberedTransportersForRoute('', 'Chennai', 'Mumbai'))[0]).toBe('vrl@mum.in');
    });

    test('same pickup, unknown drop falls back to pickup matches then global', () => {
        // No exact "Chennai/Delhi" route, but pickup Chennai routes should lead
        const out = emails(rememberedTransportersForRoute('', 'Chennai', 'Delhi'));
        expect(out.slice(0, 3)).toEqual(expect.arrayContaining(['ravi@sri.in', 'gopal@hyd.in', 'vrl@mum.in']));
        expect(out[0]).not.toBe('northex@del.in'); // global-only entry comes after route matches
    });

    test('unknown route -> global fallback', () => {
        expect(emails(rememberedTransportersForRoute('', 'Nowhere', 'Noplace'))).toEqual(
            ['ravi@sri.in', 'northex@del.in', 'vrl@mum.in', 'gopal@hyd.in']
        );
    });

    test('typed text filters within the route', () => {
        expect(emails(rememberedTransportersForRoute('gop', 'Chennai', 'Hyderabad'))).toEqual(['gopal@hyd.in']);
    });

    test('route key ignores case and whitespace', () => {
        expect(emails(rememberedTransportersForRoute('', '  chennai ', 'HYDERABAD')).slice(0, 2))
            .toEqual(['ravi@sri.in', 'gopal@hyd.in']);
    });

    test('no cache loaded -> empty (never throws)', () => {
        _setSuggest(null);
        expect(rememberedTransportersForRoute('a', 'Chennai', 'Hyderabad')).toEqual([]);
    });
});

describe('weightOf — qty × kg/m for one row', () => {
    test('multiplies quantity by kg/m', () => {
        expect(weightOf({ qty: 10, kgm: 2.5 })).toBe(25);
    });
    test('a null / missing quantity contributes 0', () => {
        expect(weightOf({ qty: null, kgm: 5 })).toBe(0);
        expect(weightOf({ kgm: 5 })).toBe(0);
    });
    test('a zero / missing kg/m contributes 0', () => {
        expect(weightOf({ qty: 10, kgm: 0 })).toBe(0);
        expect(weightOf({ qty: 10 })).toBe(0);
        expect(weightOf({})).toBe(0);
    });
});

describe('secWeight — section total that excludes soft-deleted rows (backlog #1)', () => {
    const st = {
        rows: [
            { sec: 0, qty: 10, kgm: 2 },                  // 20
            { sec: 0, qty: 5, kgm: 4, removed: true },    // excluded (soft-deleted)
            { sec: 0, qty: null, kgm: 5 },                // 0 (no qty)
            { sec: 1, qty: 3, kgm: 1 },                   // other section
        ],
    };
    test('sums only the non-removed rows in the requested section', () => {
        expect(secWeight(st, 0)).toBe(20);
    });
    test('a soft-deleted row is kept out of the total', () => {
        const withoutRemoved = { rows: st.rows.filter(r => !r.removed) };
        // the visible total is the same whether or not the removed row exists
        expect(secWeight(st, 0)).toBe(secWeight(withoutRemoved, 0));
    });
    test('only totals the requested section', () => {
        expect(secWeight(st, 1)).toBe(3);
    });
    test('a section whose rows are all removed totals 0', () => {
        const allRemoved = { rows: [{ sec: 2, qty: 9, kgm: 9, removed: true }] };
        expect(secWeight(allRemoved, 2)).toBe(0);
    });
    test('an empty section totals 0', () => {
        expect(secWeight(st, 99)).toBe(0);
    });
});

describe('source guards — soft-delete weights (backlog #1)', () => {
    const src = fs.readFileSync(FWE_PATH, 'utf8');

    test('a removed row is soft-deleted (kept visible, excluded from the total)', () => {
        expect(src).toContain('if (r) r.removed = true;   // soft-delete: keep visible, exclude from total');
        expect(src).toContain('if (r) r.removed = false;');
    });
    test('the removed row renders struck-through with an "Add back" button', () => {
        expect(src).toContain('text-decoration:line-through;color:#9b988e;');
        expect(src).toContain('<button class="fwe-restore fwe-link"');
        expect(src).toContain('Add back');
        expect(src).toContain("mountEl.querySelectorAll('.fwe-restore').forEach(function (b) {");
    });
    test('the section total, print and enquiry scopes all filter out removed rows', () => {
        expect(src).toContain('.filter(function (r) { return !r.removed; }).reduce');
        expect(src).toContain('var rows = st.rows.filter(function (r) { return !r.removed; });');
        expect(src).toContain('var rows = secRows(st, sec).filter(function (r) { return !r.removed; });');
    });
});

describe('source guards — freight module markers must not silently disappear', () => {
    const src = fs.readFileSync(FWE_PATH, 'utf8');

    test.each([
        'function parseFreightAmount',
        'function trimReplyForStorage',
        'function rememberedTransportersForRoute',
        'function sendFreightEnquiry',
        'function checkFreightReplies',
        'weightOverride',
        'fwe-enq-send',
        'Request freight',
        'transporterReplyIn',
    ])('contains marker: %s', (marker) => {
        expect(src).toContain(marker);
    });

    // Route first, then recipients — filling pickup/drop is what makes the recipient box
    // suggest the transporters used for that route. The recipient field is now labelled Bcc
    // (each transporter is Bcc'd on their own email, so nobody sees anyone else).
    test('pickup/drop fields render before the recipient field (route-first order)', () => {
        expect(src.indexOf('Pickup point')).toBeGreaterThan(-1);
        expect(src.indexOf('Pickup point')).toBeLessThan(src.indexOf('Bcc — transporters'));
    });

    test('escapes email-derived text in the Print output (no raw r.d/name)', () => {
        expect(src).toContain('escTxt(r.d || \'\')');
        expect(src).toContain('escTxt(name)');
    });
});

describe('source guards — index.html hooks the freight features depend on', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');

    test('attachContactAutocomplete accepts the localSuggest param', () => {
        expect(html).toContain('function attachContactAutocomplete(field, input, addFn, localSuggest)');
    });

    test('the list rebuild preserves the active tab across re-render', () => {
        expect(html).toContain('activeTab: contentEl.dataset.activeTab');
        expect(html).toContain('if (folder.activeTab) contentEl.dataset.activeTab = folder.activeTab');
    });

    // The save-time weight sync is tested for behaviour in flow-sweep, but that proves only that
    // the function works — not that anything calls it. These pin the wiring, and they check WHERE
    // the call sits, not just that it exists: a plain toContain would pass happily with the call
    // stranded inside the `if (!ok)` failure branch, which is the one place it must never run
    // (syncing after a rejected write would blank a weight on a change the server never stored).
    const bodyOfFunction = (name) => {
        const i = html.indexOf('function ' + name + '(');
        if (i === -1) throw new Error('function not found in index.html: ' + name);
        const open = html.indexOf('{', i);
        let depth = 0;
        for (let k = open; k < html.length; k++) {
            if (html[k] === '{') depth++;
            else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
        }
        throw new Error('unterminated function body: ' + name);
    };

    ['saveQuotationChanges', 'saveQuotation'].forEach((fn) => {
        test(fn + ' calls the weight sync, on the success side of the write', () => {
            const body = bodyOfFunction(fn);
            const call = body.indexOf('window.syncFreightWeightsOnQuoteSaved(quotation)');
            expect(call).toBeGreaterThan(-1);

            const failBranch = body.indexOf('if (!ok) {');
            expect(failBranch).toBeGreaterThan(-1);
            const bailOut = body.indexOf('return;', failBranch);
            expect(bailOut).toBeGreaterThan(-1);
            // Both the branch and its `return;` come first, so the call is unreachable on failure.
            expect(bailOut).toBeLessThan(call);
        });
    });

    test('the freight module exposes the hook index.html calls, and asks for the save-only sync', () => {
        const src = fs.readFileSync(FWE_PATH, 'utf8');
        expect(src).toContain('window.syncFreightWeightsOnQuoteSaved = function');
        expect(src).toContain('syncRowsWithQuote(q, st, { onSave: true })');
    });
});

// ── Pasted address lists ─────────────────────────────────────────────────────
// A list copied out of Outlook or Gmail arrives as `Name <addr>, "Firm, Ltd" <addr>`. The old
// split was on /[,;\s]+/, which turned "BOMBAY HARDWARE <a@b.com>" into three chips — two of
// them junk — and left the angle brackets on the third. Worse, in the Enquiry tab the whole
// paste became ONE chip, and one chip means one email: every supplier on it would have seen
// the others. The parsing must stay identical in both modules, so the same cases run against
// each (see the twin block in tests/enquiry-tab.test.js).
describe('splitAddressList / bareAddress — pasting addresses out of an email client', () => {
    const { splitAddressList, bareAddress } = require('../freight-tab-weight-editor')._test;
    const chipsFrom = (raw) => splitAddressList(raw).map(bareAddress);

    test('the real five-supplier paste becomes five bare addresses', () => {
        const pasted = 'BOMBAY HARDWARE <bhpisales@bombayhardware.com>, '
            + 'retchennai madrassteels <retchennai@madrassteels.in>, '
            + 'Shree Mahaveer <mahaveer_tube@rediffmail.com>, '
            + '"Shri Vardhman Tube Co." <shrivardhmantube@rediffmail.com>, '
            + '"Jindal PIPE INDUSTRIES (ALL DETAILS)" <jindal_pipes@yahoo.com>';
        expect(chipsFrom(pasted)).toEqual([
            'bhpisales@bombayhardware.com',
            'retchennai@madrassteels.in',
            'mahaveer_tube@rediffmail.com',
            'shrivardhmantube@rediffmail.com',
            'jindal_pipes@yahoo.com',
        ]);
    });

    test('a comma inside a quoted firm name does not split it in two', () => {
        expect(chipsFrom('"Jindal Pipes, Chennai" <a@b.com>, Second <c@d.com>'))
            .toEqual(['a@b.com', 'c@d.com']);
    });

    test('a comma inside the angle brackets does not split either', () => {
        expect(splitAddressList('One <a@b.com>, Two <c@d.com>')).toHaveLength(2);
    });

    test('semicolons and newlines separate too — Outlook uses both', () => {
        expect(chipsFrom('a@b.com; c@d.com')).toEqual(['a@b.com', 'c@d.com']);
        expect(chipsFrom('a@b.com\nc@d.com')).toEqual(['a@b.com', 'c@d.com']);
    });

    test('a transporter name typed on its own keeps its spaces and stays one chip', () => {
        // The name is how the contact dropdown is searched — splitting it breaks that.
        expect(chipsFrom('Ravi Transport')).toEqual(['Ravi Transport']);
    });

    test('a plain address is returned untouched', () => {
        expect(chipsFrom('a@b.com')).toEqual(['a@b.com']);
    });

    test('empty and whitespace-only input yield no chips', () => {
        expect(splitAddressList('')).toEqual([]);
        expect(splitAddressList('  ,  ; ')).toEqual([]);
    });
});

// ── Send can only fire once ──────────────────────────────────────────────────
// After a successful send the transporters are cleared but a Cc'd colleague is not, and the
// old test (bcc.length || cc.length) left Send blue. A second, impatient press then emailed
// that colleague ALONE, listed them under "Sent to / Awaiting reply" as if they were a
// transporter, and recorded them in the directory as a firm that had been asked.
describe('canSendEnquiry — the one gate behind the Send button', () => {
    const { canSendEnquiry } = require('../freight-tab-weight-editor')._test;
    // One row with a real weight, so the weight gate is satisfied and only the send state varies.
    const stWith = (enq) => ({
        split: false,
        rows: [{ sec: 1, qty: 10, kgm: 2.5 }],
        enquiry: Object.assign({ bcc: [], cc: [], sending: false, justSent: false, weightOverride: null, forSec: 0 }, enq),
    });

    test('a transporter in Bcc and a good weight -> Send is live', () => {
        expect(canSendEnquiry(stWith({ bcc: ['ravi@sri.in'] }))).toBe(true);
    });

    test('nobody to send to -> dead', () => {
        expect(canSendEnquiry(stWith({}))).toBe(false);
    });

    test('a send already in flight -> dead (no double click)', () => {
        expect(canSendEnquiry(stWith({ bcc: ['ravi@sri.in'], sending: true }))).toBe(false);
    });

    test('after a clean send, a leftover Cc colleague does NOT keep Send live', () => {
        // This is the state freightSendAll leaves behind: recipients cleared, copies kept.
        expect(canSendEnquiry(stWith({ bcc: [], cc: ['office@dscpipes.com'], justSent: true }))).toBe(false);
    });

    test('adding another transporter after that send brings it back', () => {
        expect(canSendEnquiry(stWith({ bcc: ['vrl@mum.in'], cc: ['office@dscpipes.com'], justSent: false }))).toBe(true);
    });

    test('an incomplete weight still blocks it, whatever else is true', () => {
        const st = stWith({ bcc: ['ravi@sri.in'] });
        st.rows = [{ sec: 1, qty: null, kgm: 2.5 }];   // no quantity -> weight cannot be calculated
        expect(canSendEnquiry(st)).toBe(false);
    });
});

// The owner's absolute rule is that transporters must never see each other. With Bcc empty,
// two or more addresses in Cc go out as ONE open email — the grey note said so in the same
// grey as everything else.
describe('ccOpenEmailRisk / ccNoteText — warn before an open email, not after', () => {
    const { ccOpenEmailRisk, ccNoteText, ccAddressCount } = require('../freight-tab-weight-editor')._test;

    test('Bcc empty and two firms in Cc -> risky', () => {
        expect(ccOpenEmailRisk({ bcc: [], cc: ['a@x.com', 'b@y.com'] })).toBe(true);
    });

    test('Bcc filled -> Cc is only a copy, not the send', () => {
        expect(ccOpenEmailRisk({ bcc: ['ravi@sri.in'], cc: ['a@x.com', 'b@y.com'] })).toBe(false);
    });

    test('one address in Cc -> nobody to be exposed to', () => {
        expect(ccOpenEmailRisk({ bcc: [], cc: ['a@x.com'] })).toBe(false);
    });

    test('the risky note names the count and says what to do', () => {
        const note = ccNoteText({ bcc: [], cc: ['a@x.com', 'b@y.com', 'c@z.com'] });
        expect(note).toContain('3');
        expect(note).toContain('ONE open email');
        expect(note).toContain('Bcc');
    });

    test('the safe note does not shout', () => {
        expect(ccNoteText({ bcc: ['ravi@sri.in'], cc: ['a@x.com'] })).not.toContain('Careful');
    });

    // One chip can hold a whole firm — "a@x.com, b@x.com" arrives as ONE chip when it is
    // pasted or picked from the directory. Counting chips printed a number the reader could
    // see was wrong: two names on screen and a warning saying "these 1 will go out".
    test('one chip holding two people counts as two, and is a risk', () => {
        const enq = { bcc: [], cc: ['a@x.com, b@x.com'] };
        expect(ccAddressCount(enq)).toBe(2);
        expect(ccOpenEmailRisk(enq)).toBe(true);
        expect(ccNoteText(enq)).toContain('these 2 ');
    });

    test('two chips holding three people between them print 3, not 2', () => {
        const enq = { bcc: [], cc: ['a@x.com, b@x.com', 'c@y.com'] };
        expect(ccAddressCount(enq)).toBe(3);
        expect(ccNoteText(enq)).toContain('these 3 ');
    });

    test('one chip holding one person is still not a risk', () => {
        expect(ccOpenEmailRisk({ bcc: [], cc: ['solo@x.com'] })).toBe(false);
        expect(ccAddressCount({ bcc: [], cc: ['solo@x.com'] })).toBe(1);
    });
});

// The red Cc warning is written once by render(), but chips change without one. It is
// repainted by the SAME function that re-checks the Send button, so the two can never
// disagree — and deleting the repaint used to leave every test green while the warning
// froze on screen saying the opposite of the truth.
describe('syncComposerLive — Send and the Cc warning are repainted together', () => {
    const { syncComposerLive } = require('../freight-tab-weight-editor')._test;

    const composer = () => {
        const sendBtn = { disabled: null };
        const note = { textContent: 'untouched', style: { color: 'untouched' } };
        return {
            sendBtn, note,
            querySelector: (sel) => sel === '.fwe-enq-send' ? sendBtn
                : sel === '.fwe-cc-note' ? note : null,
        };
    };
    // One row with a real weight, so only the recipient state varies.
    const stWith = (enq) => ({
        split: false,
        rows: [{ sec: 1, qty: 10, kgm: 2.5 }],
        enquiry: Object.assign({ bcc: [], cc: [], sending: false, justSent: false, weightOverride: null, forSec: 0 }, enq),
    });

    test('two firms in Cc with Bcc empty -> the warning turns red and says Careful', () => {
        const m = composer();
        syncComposerLive(m, stWith({ cc: ['a@x.com', 'b@y.com'] }));
        expect(m.note.textContent).toContain('Careful');
        expect(m.note.style.color).toBe('#A32D2D');
    });

    test('moving them to Bcc takes the red away again', () => {
        const m = composer();
        syncComposerLive(m, stWith({ cc: ['a@x.com', 'b@y.com'] }));
        syncComposerLive(m, stWith({ bcc: ['a@x.com', 'b@y.com'], cc: [] }));
        expect(m.note.textContent).not.toContain('Careful');
        expect(m.note.style.color).toBe('#9b988e');
    });

    test('the same repaint sets the Send button: live with a transporter…', () => {
        const m = composer();
        syncComposerLive(m, stWith({ bcc: ['ravi@sri.in'] }));
        expect(m.sendBtn.disabled).toBe(false);
    });

    test('…and dead once that enquiry has gone out', () => {
        const m = composer();
        syncComposerLive(m, stWith({ bcc: [], cc: ['office@dscpipes.com'], justSent: true }));
        expect(m.sendBtn.disabled).toBe(true);
    });

    test('a composer with neither element on the page -> no throw', () => {
        expect(() => syncComposerLive({ querySelector: () => null }, stWith({}))).not.toThrow();
    });
});

// The ranking is scored on the pickup, drop and weight that were in the box when Ask AI was
// pressed. Change any of them and the list is about a different job — but it stayed on screen,
// clickable, and a click on it sends a real enquiry.
describe('staleDirPanel — an out-of-date ranking is taken off the screen', () => {
    const { staleDirPanel } = require('../freight-tab-weight-editor')._test;
    // Minimal stand-in for the panel: staleDirPanel only ever reads/writes .innerHTML.
    const mountWith = (html) => {
        const panel = { innerHTML: html };
        return { panel, querySelector: (sel) => (sel === '.fwe-dir-panel' ? panel : null) };
    };

    test('an open ranking is replaced by "press Ask AI again"', () => {
        const m = mountWith('<div class="pd-card">Ravi Transport — Runs Chennai to Hosur regularly</div>');
        staleDirPanel(m);
        expect(m.panel.innerHTML).not.toContain('Ravi Transport');
        expect(m.panel.innerHTML).toContain('Ask AI again');
    });

    test('a panel that was never opened stays empty (no note out of nowhere)', () => {
        const m = mountWith('');
        staleDirPanel(m);
        expect(m.panel.innerHTML).toBe('');
    });

    test('no panel on the page -> does nothing, never throws', () => {
        expect(() => staleDirPanel({ querySelector: () => null })).not.toThrow();
    });
});

// Wired straight to oninput, the FIRST character of a re-typed town blanked the whole Ask AI
// list under the user's hands. Typing is not a decision — wait for a pause.
describe('staleDirPanelSoon — typing does not blank the ranking, changing it does', () => {
    const { staleDirPanelSoon } = require('../freight-tab-weight-editor')._test;
    const mountWith = (html) => {
        const panel = { innerHTML: html };
        return { panel, querySelector: (sel) => (sel === '.fwe-dir-panel' ? panel : null) };
    };
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('one keystroke leaves the list alone', () => {
        const m = mountWith('<div class="pd-card">Ravi Transport</div>');
        staleDirPanelSoon(m);
        expect(m.panel.innerHTML).toContain('Ravi Transport');
    });

    test('after the typing stops, the list is taken off the screen', () => {
        const m = mountWith('<div class="pd-card">Ravi Transport</div>');
        staleDirPanelSoon(m);
        jest.advanceTimersByTime(700);
        expect(m.panel.innerHTML).not.toContain('Ravi Transport');
        expect(m.panel.innerHTML).toContain('Ask AI again');
    });

    test('each further keystroke restarts the pause — typing a whole town keeps the list', () => {
        const m = mountWith('<div class="pd-card">Ravi Transport</div>');
        for (let i = 0; i < 6; i++) { staleDirPanelSoon(m); jest.advanceTimersByTime(500); }
        expect(m.panel.innerHTML).toContain('Ravi Transport');
        jest.advanceTimersByTime(700);
        expect(m.panel.innerHTML).toContain('Ask AI again');
    });

    test('no mount -> does nothing, never throws', () => {
        expect(() => staleDirPanelSoon(null)).not.toThrow();
    });
});

// The wiring itself, not just the pieces: deleting staleDirPanelSoon (or the draft refresh, or
// the Send re-check) out of the route handler left every test green last time.
describe('onRouteEdited — what typing a pickup or drop actually does', () => {
    const { onRouteEdited } = require('../freight-tab-weight-editor')._test;
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const routeMount = () => {
        const panel = { innerHTML: '<div class="pd-card">Ravi Transport — runs Chennai to Hosur</div>' };
        const msg = { value: 'stale draft' };
        const sendBtn = { disabled: null };
        const note = { textContent: '', style: { color: '' } };
        return {
            panel, msg, sendBtn, note,
            querySelector: (sel) => sel === '.fwe-dir-panel' ? panel
                : sel === '.fwe-enq-msg' ? msg
                : sel === '.fwe-enq-send' ? sendBtn
                : sel === '.fwe-cc-note' ? note : null,
        };
    };
    const stWith = (over) => ({
        split: false,
        rows: [{ sec: 1, qty: 10, kgm: 2.5 }],
        enquiry: Object.assign({
            bcc: ['ravi@sri.in'], cc: [], pickup: 'Chennai', drop: 'Hosur',
            message: '', messageEdited: false, weightOverride: null,
            sending: false, justSent: false, forSec: 0,
        }, over),
    });

    test('the draft follows the new route', () => {
        const m = routeMount();
        onRouteEdited({}, stWith({ drop: 'Hosur' }), m);
        expect(m.msg.value).toContain('Drop: Hosur');
        expect(m.msg.value).not.toBe('stale draft');
    });

    test('a message the user wrote themselves is left alone', () => {
        const m = routeMount();
        m.msg.value = 'My own wording';
        onRouteEdited({}, stWith({ messageEdited: true }), m);
        expect(m.msg.value).toBe('My own wording');
    });

    test('the ranking survives the keystroke, then goes once the typing stops', () => {
        const m = routeMount();
        onRouteEdited({}, stWith({}), m);
        expect(m.panel.innerHTML).toContain('Ravi Transport');
        jest.advanceTimersByTime(700);
        expect(m.panel.innerHTML).toContain('Ask AI again');
    });

    test('Send is re-checked on the way through', () => {
        const m = routeMount();
        onRouteEdited({}, stWith({}), m);
        expect(m.sendBtn.disabled).toBe(false);
        const m2 = routeMount();
        onRouteEdited({}, stWith({ justSent: true, bcc: [], cc: ['office@dscpipes.com'] }), m2);
        expect(m2.sendBtn.disabled).toBe(true);
    });

    test('editing the route does NOT bring a spent Send button back', () => {
        // Only a new recipient does. A route edit changes what the enquiry says, not who it
        // is for — and with the transporters cleared, Send would fire at the Cc'd colleague.
        const st = stWith({ justSent: true, bcc: [], cc: ['office@dscpipes.com'] });
        onRouteEdited({}, st, routeMount());
        expect(st.enquiry.justSent).toBe(true);
    });
});

// Ask AI re-reads the directory before it writes, so its list lands late. Typing a new town
// while it loads cleared the panel — and then the stale list was painted back over the
// clearing, live and clickable, ranked for a route that no longer existed.
describe('dirPanelSlot — a late Ask AI list cannot land back on a cleared panel', () => {
    const { dirPanelSlot, staleDirPanel } = require('../freight-tab-weight-editor')._test;

    // Enough DOM to model the one thing that matters: clearing the panel detaches its children.
    beforeEach(() => {
        global.document = {
            createElement: () => {
                const el = { className: '', innerHTML: '' };
                Object.defineProperty(el, 'outerHTML', {
                    get: () => '<div class="' + el.className + '">' + el.innerHTML + '</div>',
                });
                return el;
            },
        };
    });
    afterEach(() => { delete global.document; });

    const panelMount = () => {
        const panel = {
            own: '', kids: [],
            get innerHTML() { return this.own + this.kids.map(k => k.outerHTML).join(''); },
            set innerHTML(v) { this.kids = []; this.own = v; },
            appendChild(k) { this.kids.push(k); return k; },
        };
        return { panel, querySelector: (sel) => (sel === '.fwe-dir-panel' ? panel : null) };
    };

    test('the list Ask AI writes shows in the panel', () => {
        const m = panelMount();
        const slot = dirPanelSlot(m);
        slot.innerHTML = '<div class="pd-card">Ravi Transport</div>';   // the async write
        expect(m.panel.innerHTML).toContain('Ravi Transport');
    });

    test('a list that arrives after the panel was cleared never reaches the screen', () => {
        const m = panelMount();
        const slot = dirPanelSlot(m);
        slot.innerHTML = '<p>Reading your directory…</p>';   // renderSuggestPanel, straight away
        staleDirPanel(m);                                    // the user typed a new drop town
        slot.innerHTML = '<div class="pd-card">Ravi Transport</div>';   // …and the list lands late
        expect(m.panel.innerHTML).not.toContain('Ravi Transport');
        expect(m.panel.innerHTML).toContain('Ask AI again');
    });

    test('no panel on the page -> nothing to write into', () => {
        expect(dirPanelSlot({ querySelector: () => null })).toBe(null);
    });
});

describe('source guards — Send cannot fire twice, and a changed route stales the ranking', () => {
    const src = fs.readFileSync(FWE_PATH, 'utf8');

    test('the flag is set only on the branch where every email succeeded', () => {
        const clean = src.indexOf('if (!failed.length) {');
        const partial = src.indexOf('} else if (sentOk.length) {', clean);
        const flag = src.indexOf('enq.justSent = true;');
        expect(clean).toBeGreaterThan(-1);
        expect(flag).toBeGreaterThan(clean);
        expect(flag).toBeLessThan(partial);   // a partial failure must leave Send usable
    });

    test('the guard behind the click checks it too, not just the button', () => {
        expect(src).toContain('|| enq.sending || enq.justSent || hasBadRecipient(enq)) return;');
    });

    test('every copy of the disabled test goes through the one helper', () => {
        expect(src).toContain('function canSendEnquiry(st)');
        expect(src).toContain("class=\"fwe-enq-send\"' + (canSendEnquiry(st) ? '' : ' disabled')");
        // There is now exactly ONE place that re-enables the live button — syncComposerLive,
        // which every live path (chip change, weight edit, route edit) goes through. A second
        // hand-written copy is what let justSent be forgotten in one of them.
        expect(src.split('sendBtn.disabled = !canSendEnquiry(st);')).toHaveLength(2);
        expect(src).not.toContain('sendBtn.disabled = !(');
    });

    test('editing the route or the typed weight stales the ranking', () => {
        // The route boxes fire on every keystroke, so they go through the debounced staler;
        // the weight boxes fire on change, so they stale immediately.
        expect(src).toContain('enq.pickup = pk.value; onRouteEdited(q, st, mountEl);');
        expect(src).toContain('enq.drop = dp.value; onRouteEdited(q, st, mountEl);');
        expect(src).toContain('staleDirPanelSoon(mountEl);');
        expect(src).toContain("if (f === 'kgm' || f === 'qty') staleDirPanel(mountEl);");
        expect(src).toContain('staleDirPanel(mountEl);       // a part-load ranking is wrong once the weight moves');
    });

    // The keystroke-away bug: enquiryChanged() cleared justSent and was wired to the message
    // box's oninput, so typing one character after a send re-armed Send. With the transporters
    // already cleared, a second press emailed the Cc'd colleague ALONE.
    test('justSent is cleared in exactly one place, and that place is the recipients handler', () => {
        expect(src.split('enq.justSent = false;')).toHaveLength(2);
        const fn = src.indexOf('function recipientsChanged(isTransporterList)');
        expect(fn).toBeGreaterThan(-1);
        const end = src.indexOf('\n        }', fn);
        const body = src.slice(fn, end);
        expect(body).toContain('enq.justSent = false;');
    });

    test('the message, route and weight handlers cannot re-arm Send', () => {
        // Everything between the address boxes and the Send button's own click handler: the
        // pickup, drop, kg, kg-reset and message handlers all live in here.
        const from = src.indexOf('warmFreightSuggestions();');
        const to = src.indexOf('if (sendBtn) sendBtn.onclick');
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);
        expect(src.slice(from, to)).not.toContain('recipientsChanged');
    });

    test('adding or removing a recipient is what brings Send back', () => {
        expect(src).toContain('function recipientsChanged(isTransporterList)');
        // add ×2, chip ×, Backspace — each says WHICH box it belongs to.
        expect(src.split('recipientsChanged(isTransporterList);')).toHaveLength(5);
        expect(src).not.toContain('recipientsChanged();');
        // …and the on-screen line agrees with the rule.
        expect(src).toContain('Add another transporter above to send it again.');
    });
});

// Both modules carry their own copy (as they already do for chipAddrs). If the two ever drift,
// the same paste behaves differently on the Freight tab and the Enquiry tab.
describe('the two modules parse addresses identically', () => {
    const F = require('../freight-tab-weight-editor')._test;
    const Q = require('../quote-enquiry-tab')._test;
    const CASES = [
        'BOMBAY HARDWARE <bhpisales@bombayhardware.com>, "Jindal PIPE INDUSTRIES (ALL DETAILS)" <jindal_pipes@yahoo.com>',
        'a@b.com; c@d.com',
        'Ravi Transport',
        '"Firm, Ltd" <x@y.com>',
        '',
    ];
    test.each(CASES)('same result for %p', (raw) => {
        expect(F.splitAddressList(raw).map(F.bareAddress))
            .toEqual(Q.splitAddressList(raw).map(Q.bareAddress));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The double-send hole, third time of asking
// ─────────────────────────────────────────────────────────────────────────────

describe('only a new TRANSPORTER brings a spent Send back', () => {
    // This hole has now moved twice rather than closed. First it was the message box:
    // typing one character after a send re-armed Send, and the transporters were already
    // cleared, so the second press emailed the Cc'd colleague ALONE and recorded them as a
    // transporter who had been asked. That was fixed by moving the re-arm into the recipients
    // handler — but that handler binds BOTH address boxes, so adding a Cc did exactly the same
    // thing. Only the transporter box may re-arm Send.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'freight-tab-weight-editor.js'), 'utf8');

    test('the re-arm is gated on which box changed, not merely on a box changing', () => {
        expect(src).toContain('function recipientsChanged(isTransporterList) {');
        expect(src).toContain('if (isTransporterList && enq.justSent) {');
    });

    test('the transporter box declares itself the transporter list', () => {
        expect(src).toMatch(/bindAddressField\(field, chipsBox, input, enq\.bcc, true\)/);
    });

    test('and the Cc box declares that it is NOT', () => {
        // The half that was missed. Without the explicit false, the flag is undefined —
        // which happens to work, and would silently start re-arming again the moment
        // someone gave the parameter a default.
        expect(src).toMatch(/ccField\.querySelector\('\.fwe-enq-input'\), enq\.cc, false\)/);
    });

    test('every call inside the binder passes the flag through', () => {
        // A single bare recipientsChanged() anywhere in the binder re-opens the hole for
        // whichever box that line belongs to.
        expect(src).not.toContain('recipientsChanged();');
        // Call sites only — the trailing semicolon excludes the declaration itself.
        expect(src.split('recipientsChanged(isTransporterList);').length - 1).toBe(4);
    });
});
