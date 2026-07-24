/**
 * @jest-environment node
 *
 * tests/margin-desk.test.js
 *
 * The "Margins to allocate" admin desk (index.html):
 *   - buildMarginDeskRow(q) — the collapsible desk card for a quote awaiting margin.
 *     Extracted (with its helpers escapeHtml + adminMarginsOf) and eval'd; the DOM-only
 *     preview/chips helpers are injected as stubs so it runs under Node.
 *   - renderMarginDesk() — drives the real desk filter (adminStatus === 'awaiting'
 *     && !q.sent). A fake `document` + a stub buildMarginDeskRow let us assert which
 *     quotes survive the filter (a SENT quote drops off).
 *   - mdkToggleCard(id) / mdkExpandedIds — expand/collapse + lazy-load wiring.
 *   - mdkManageStaff() — opens the collapsed Config panel (toggleConfigSection) BEFORE
 *     scrolling to #staffListChips, so scrollIntoView can reach a shown element.
 *
 * These all live inline in the browser-only SPA (index.html); extracted by name and
 * eval'd via the loadFns factory (same pattern as tests/revision-history.test.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

// Pull a top-level function out of source by brace-matching; keep a leading `async`.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
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

// Concatenate the named functions and return the last one, with `sandbox` values
// bound as the free variables the code references (globals it would read in the SPA).
function loadFns(names, sandbox) {
    const body = names.map(function (n) { return extractFunction(html, n); }).join('\n');
    const keys = Object.keys(sandbox || {});
    // eslint-disable-next-line no-new-func
    const factory = new Function(keys.join(','), body + '\nreturn ' + names[names.length - 1] + ';');
    return factory.apply(null, keys.map(function (k) { return sandbox[k]; }));
}

// buildMarginDeskRow + its real helpers, with the DOM-bound preview/chips helpers stubbed.
function makeDeskRow(opts) {
    opts = opts || {};
    return loadFns(['escapeHtml', 'adminMarginsOf', 'buildMarginDeskRow'], {
        defaultMarginsByPipeType: opts.defaults || { erw: '', gi: '', seamless: '' },
        mdkExpandedIds: opts.expandedIds || {},
        staffList: opts.staffList || [],
        buildEmailContentPreviewHTML: function (q) { return '<div class="preview">' + (q.emailContent || '') + '</div>'; },
        buildEnquiryFilesChipsHTML: function () { return '<div class="chips"></div>'; },
    });
}

describe('buildMarginDeskRow — header, summary and collapsed/expanded state', () => {
    const baseQuote = {
        id: 'q1',
        companyName: 'Tata Steel',
        quoteNumber: 'DSC-108',
        itemSummary: { count: 3, types: ['ERW', 'Seamless'], noRate: 1 },
        // emailContent undefined -> desk shows the "Loading enquiry…" placeholder
    };

    test('renders the quote company, number and item summary', () => {
        const build = makeDeskRow();
        const h = build(baseQuote);
        expect(h).toContain('Tata Steel - DSC-108');
        expect(h).toContain('3 items');
        expect(h).toContain('ERW + Seamless');
        expect(h).toContain('Awaiting margin');
        expect(h).toContain('id="mdk-row-q1"');
        expect(h).toContain("mdkToggleCard('q1')");
    });

    test('falls back to projectName then "Quotation" when there is no company', () => {
        const build = makeDeskRow();
        const withProject = build({ id: 'q2', projectName: 'Metro Depot', quoteNumber: 'DSC-9', itemSummary: { count: 1, types: ['GI'], noRate: 0 } });
        expect(withProject).toContain('Metro Depot - DSC-9');
        const bare = build({ id: 'q3', quoteNumber: 'DSC-10', itemSummary: { count: 0, types: [], noRate: 0 } });
        expect(bare).toContain('Quotation - DSC-10');
        // no types -> the em-dash placeholder in the meta cell specifically (guards the real
        // `s.types.join(' + ') || '—'` fallback — a loose '— ' would match unrelated label text).
        expect(bare).toContain('0 items · —</span>');
    });

    test('collapsed by default: caret ▶ and body hidden', () => {
        const build = makeDeskRow();
        const h = build(baseQuote);
        expect(h).toContain('id="mdk-caret-q1">▶');
        expect(h).toContain('id="mdk-body-q1" style="display:none;"');
    });

    test('reflects expanded state from mdkExpandedIds: caret ▼ and body shown', () => {
        const build = makeDeskRow({ expandedIds: { q1: true } });
        const h = build(baseQuote);
        expect(h).toContain('id="mdk-caret-q1">▼');
        expect(h).toContain('id="mdk-body-q1" style="display:block;"');
    });

    test('an unloaded enquiry shows the loading placeholder (no preview yet)', () => {
        const build = makeDeskRow();
        const h = build(baseQuote);
        expect(h).toContain('Loading enquiry…');
        expect(h).not.toContain('class="preview"');
    });

    test('a loaded enquiry renders the preview + a View-in-Gmail link', () => {
        const build = makeDeskRow();
        const h = build(Object.assign({}, baseQuote, { emailContent: 'Need 100m of 2" pipe', emailLink: 'https://mail.google.com/x' }));
        expect(h).toContain('class="preview"');
        expect(h).toContain('View in Gmail');
        expect(h).toContain('https://mail.google.com/x');
        expect(h).not.toContain('Loading enquiry…');
    });
});

describe('buildMarginDeskRow — "not in price list" warning pill', () => {
    const q = (noRate) => ({ id: 'q1', companyName: 'Acme', quoteNumber: 'DSC-1', itemSummary: { count: 2, types: ['ERW'], noRate: noRate } });

    test('no warning when every item has a rate', () => {
        const h = makeDeskRow()(q(0));
        expect(h).not.toContain('not in price list');
    });
    test('singular "item" for one missing rate', () => {
        const h = makeDeskRow()(q(1));
        expect(h).toContain('⚠ 1 item not in price list');
    });
    test('plural "items" for more than one', () => {
        const h = makeDeskRow()(q(3));
        expect(h).toContain('⚠ 3 items not in price list');
    });
});

describe('buildMarginDeskRow — per-type margin controls reflect adminMargins', () => {
    test('Seamless in cost mode shows the Cost+ segment on + its percent', () => {
        const build = makeDeskRow();
        const h = build({
            id: 'q1', companyName: 'Acme', quoteNumber: 'DSC-1',
            itemSummary: { count: 2, types: ['Seamless', 'ERW'], noRate: 0 },
            adminMargins: { seamless: { mode: 'cost', pct: '5' }, erw: { pct: '3' }, gi: { pct: '' } },
        });
        // ERW is a plain Cost + input carrying its stored percent
        expect(h).toContain('value="3"');
        expect(h).toContain("mdkSetPct('q1','erw',this.value)");
        // Seamless cost mode: the percent input is shown and the "Cost +" button is active
        expect(h).toContain('value="5"');
        expect(h).toContain("mdkSetPct('q1','seamless',this.value)");
        expect(h).toContain("mdkSetMode('q1','cost')");
    });

    test('Seamless defaults to "Price list" mode when no adminMargins are saved', () => {
        const build = makeDeskRow();
        const h = build({ id: 'q1', companyName: 'Acme', quoteNumber: 'DSC-1', itemSummary: { count: 1, types: ['Seamless'], noRate: 0 } });
        expect(h).toContain('Price list');
        // price mode -> no cost-plus percent input for seamless
        expect(h).not.toContain("mdkSetPct('q1','seamless',this.value)");
    });
});

describe('buildMarginDeskRow — new-company assign block', () => {
    test('hidden until "New company?" is checked', () => {
        const build = makeDeskRow({ staffList: ['Alice', 'Bob'] });
        const h = build({ id: 'q1', companyName: 'Acme', quoteNumber: 'DSC-1', itemSummary: { count: 1, types: ['GI'], noRate: 0 } });
        expect(h).toContain('New company?');
        expect(h).not.toContain('mdkManageStaff()');
    });

    test('when isNewCompany, the checkbox is checked and staff list + Manage button appear', () => {
        const build = makeDeskRow({ staffList: ['Alice', 'Bob'] });
        const h = build({
            id: 'q1', companyName: 'Acme', quoteNumber: 'DSC-1',
            itemSummary: { count: 1, types: ['GI'], noRate: 0 },
            isNewCompany: true, assignedTo: 'Bob',
        });
        // Pin "checked" to the checkbox element itself, not a loose substring anywhere.
        expect(h).toContain('type="checkbox" style="width:14px;height:14px;" checked ');
        expect(h).toContain('mdkManageStaff()');
        expect(h).toContain('>Alice<');
        expect(h).toContain('>Bob<');
        // the assigned staffer's option is preselected
        expect(h).toMatch(/<option selected>Bob<\/option>/);
    });
});

describe('buildMarginDeskRow — HTML escaping of untrusted quote fields', () => {
    test('company name and admin note are escaped', () => {
        const build = makeDeskRow();
        const h = build({
            id: 'q1', companyName: 'Tom & "Jerry" <Co>', quoteNumber: 'DSC-1',
            itemSummary: { count: 1, types: ['GI'], noRate: 0 },
            adminNote: 'quote 6" ERW <b>less 5%</b>',
        });
        expect(h).toContain('Tom &amp; &quot;Jerry&quot; &lt;Co&gt;');
        expect(h).not.toContain('<Co>');
        expect(h).toContain('quote 6&quot; ERW &lt;b&gt;less 5%&lt;/b&gt;');
    });
});

describe('renderMarginDesk — the desk filter is adminStatus === "awaiting" && !q.sent', () => {
    // Fake DOM section + a stub buildMarginDeskRow that just tags each rendered quote,
    // so we can read back exactly which quotes survived the real filter.
    function runDesk(quotes) {
        const section = { style: {}, innerHTML: '' };
        const doc = { getElementById: function (id) { return id === 'marginDeskSection' ? section : null; } };
        const render = loadFns(['renderMarginDesk'], {
            document: doc,
            approvedQuotations: quotes,
            buildMarginDeskRow: function (q) { return '[row:' + q.id + ']'; },
            ensureDeskEnquiryLoaded: function () {},
            mdkExpandedIds: {},
        });
        render();
        return section;
    }

    test('keeps awaiting-and-unsent quotes; drops sent / regretted / approved ones', () => {
        const section = runDesk([
            { id: 'a', adminStatus: 'awaiting', sent: false },   // keep
            { id: 'b', adminStatus: 'awaiting', sent: true },    // drop — already sent
            { id: 'c', adminStatus: 'regretted', sent: false },  // drop — not awaiting
            { id: 'd', adminStatus: 'approved', sent: false },   // drop — not awaiting
            { id: 'e', adminStatus: 'awaiting' },                // keep — sent undefined is falsy
        ]);
        expect(section.style.display).toBe('block');
        expect(section.innerHTML).toContain('[row:a]');
        expect(section.innerHTML).toContain('[row:e]');
        expect(section.innerHTML).not.toContain('[row:b]');
        expect(section.innerHTML).not.toContain('[row:c]');
        expect(section.innerHTML).not.toContain('[row:d]');
        // header count reflects the two survivors
        expect(section.innerHTML).toContain('2 waiting');
    });

    test('a sent quote drops off the desk entirely', () => {
        const section = runDesk([{ id: 'b', adminStatus: 'awaiting', sent: true }]);
        expect(section.style.display).toBe('none');
        expect(section.innerHTML).toBe('');
    });

    test('no waiting quotes -> section hidden and emptied', () => {
        const section = runDesk([{ id: 'd', adminStatus: 'approved', sent: false }]);
        expect(section.style.display).toBe('none');
        expect(section.innerHTML).toBe('');
    });
});

describe('mdkToggleCard / mdkExpandedIds — expand/collapse + lazy enquiry load', () => {
    function setup() {
        const expandedIds = {};
        const body = { style: {} };
        const caret = {};
        const quote = { id: 'x', emailContent: undefined };
        const ensureDeskEnquiryLoaded = jest.fn();
        const doc = {
            getElementById: function (id) {
                if (id === 'mdk-body-x') return body;
                if (id === 'mdk-caret-x') return caret;
                return null;
            },
        };
        const toggle = loadFns(['mdkToggleCard'], {
            mdkExpandedIds: expandedIds,
            document: doc,
            mdkQuote: function () { return quote; },
            ensureDeskEnquiryLoaded: ensureDeskEnquiryLoaded,
        });
        return { toggle, expandedIds, body, caret, quote, ensureDeskEnquiryLoaded };
    }

    test('first click expands: flag set, body shown, caret ▼, enquiry lazy-loaded once', () => {
        const s = setup();
        s.toggle('x');
        expect(s.expandedIds.x).toBe(true);
        expect(s.body.style.display).toBe('block');
        expect(s.caret.textContent).toBe('▼');
        expect(s.ensureDeskEnquiryLoaded).toHaveBeenCalledTimes(1);
        expect(s.ensureDeskEnquiryLoaded).toHaveBeenCalledWith(s.quote);
    });

    test('second click collapses: flag cleared, body hidden, caret ▶, no extra load', () => {
        const s = setup();
        s.toggle('x');           // expand
        s.toggle('x');           // collapse
        expect(s.expandedIds.x).toBe(false);
        expect(s.body.style.display).toBe('none');
        expect(s.caret.textContent).toBe('▶');
        // collapsing must NOT re-fetch the enquiry
        expect(s.ensureDeskEnquiryLoaded).toHaveBeenCalledTimes(1);
    });
});

describe('mdkManageStaff — open the collapsed Config panel BEFORE scrolling', () => {
    function run(configDisplay, opts) {
        opts = opts || {};
        const toggleConfigSection = jest.fn(function () { configContent.style.display = 'block'; });
        const scrollIntoView = jest.fn();
        const configContent = { style: { display: configDisplay } };
        const chips = opts.noChips ? null : { scrollIntoView: scrollIntoView };
        const doc = {
            getElementById: function (id) {
                if (id === 'configContent') return configContent;
                if (id === 'staffListChips') return chips;
                return null;
            },
        };
        const manage = loadFns(['mdkManageStaff'], { document: doc, toggleConfigSection: toggleConfigSection });
        manage();
        return { toggleConfigSection, scrollIntoView };
    }

    test('when Config is collapsed (display:none), it toggles open THEN scrolls', () => {
        const { toggleConfigSection, scrollIntoView } = run('none');
        expect(toggleConfigSection).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        // ordering: the open must happen before the scroll (else scrollIntoView hits a hidden node)
        expect(toggleConfigSection.mock.invocationCallOrder[0])
            .toBeLessThan(scrollIntoView.mock.invocationCallOrder[0]);
    });

    test('an empty display string also counts as collapsed -> toggles open', () => {
        const { toggleConfigSection, scrollIntoView } = run('');
        expect(toggleConfigSection).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test('when Config is already open (display:block), it does NOT toggle, but still scrolls', () => {
        const { toggleConfigSection, scrollIntoView } = run('block');
        expect(toggleConfigSection).not.toHaveBeenCalled();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test('a missing #staffListChips is tolerated (no throw)', () => {
        expect(() => run('block', { noChips: true })).not.toThrow();
    });
});

describe('source guards — desk filter + manage-staff ordering (DOM-bound bits)', () => {
    test('renderMarginDesk keeps only awaiting, not-yet-sent quotes', () => {
        expect(html).toContain("q.adminStatus === 'awaiting' && !q.sent");
    });
    test('mdkManageStaff opens the collapsed Config panel via toggleConfigSection first', () => {
        // Scope the ordering check to the function body — these strings recur elsewhere.
        const fnSrc = extractFunction(html, 'mdkManageStaff');
        expect(fnSrc).toContain("const content = document.getElementById('configContent');");
        expect(fnSrc).toContain("typeof toggleConfigSection === 'function'");
        expect(fnSrc).toContain('toggleConfigSection();');
        // and only then reaches for the staff chips
        const toggleIdx = fnSrc.indexOf('toggleConfigSection();');
        const scrollIdx = fnSrc.indexOf("getElementById('staffListChips')");
        expect(toggleIdx).toBeGreaterThan(-1);
        expect(scrollIdx).toBeGreaterThan(toggleIdx);
    });
    test('the desk row is wired to mdkToggleCard and carries the Awaiting-margin pill', () => {
        expect(html).toContain('function mdkToggleCard(id)');
        expect(html).toContain('onclick="mdkToggleCard(');
        expect(html).toContain('Awaiting margin');
    });
});
