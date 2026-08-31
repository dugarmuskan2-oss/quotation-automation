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
