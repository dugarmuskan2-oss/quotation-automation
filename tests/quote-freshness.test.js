/*
    The card freshness check — what cures "the revision app shows what was loaded prior".

    Details load the first time a card opens; checkQuoteFreshness is what notices, on every
    later open, that the quote changed on another device (or under a colleague's hands) and
    refreshes the card — WITHOUT ever silently clobbering unsaved edits made here.

    The real function is extracted from index.html and run against a scripted fetch and a
    minimal DOM stand-in, so the compare, the assign and the banner branch all actually run.
*/
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(src, name) {
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

// A folder-content element that records banners; enough DOM for the function's needs.
function fakeFolderEl(opts) {
    const el = {
        children: [],
        contains: () => !!(opts && opts.editing),
        querySelector: function (sel) {
            if (sel === '.stale-quote-note') return this.children.find((c) => c.className === 'stale-quote-note') || null;
            return null;
        },
        prepend: function (node) { this.children.unshift(node); },
    };
    return el;
}

// Build the two functions with every collaborator supplied as a spy.
function loadFreshness(world) {
    const calls = { fetches: 0, rerenders: [] };
    const stubs = {
        approvedQuotations: world.quotes,
        idsMatch: (a, b) => String(a) === String(b),
        API_BASE_URL: '/api',
        escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        renderApprovalFolderContent: (id, el) => { calls.rerenders.push(String(id)); },
        document: {
            createElement: () => ({ className: '', style: {}, innerHTML: '' }),
            activeElement: {},
        },
        fetch: (url) => {
            calls.fetches++;
            const r = world.server;
            if (r === 'down') return Promise.reject(new Error('network'));
            if (r === 'http-error') return Promise.resolve({ ok: false });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ quotation: r }) });
        },
    };
    const body = extractFunction(html, 'checkQuoteFreshness') + '\n' + extractFunction(html, 'reloadQuotationCard');
    const keys = Object.keys(stubs);
    // eslint-disable-next-line no-new-func
    const out = new Function(...keys, body + '\nreturn { checkQuoteFreshness: checkQuoteFreshness, reloadQuotationCard: reloadQuotationCard };')(
        ...keys.map((k) => stubs[k]));
    return { ...out, calls };
}

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

describe('checkQuoteFreshness — the card follows the server copy', () => {
    const baseQuote = () => ({
        id: 71, quoteNumber: 'DSC-71', tableHTML: '<table>old</table>',
        grandTotal: '100', updatedAt: '2026-08-10T10:00:00Z', _detailsUpdatedAt: '2026-08-10T10:00:00Z',
    });

    test('an unchanged server copy leaves the card exactly alone', async () => {
        const q = baseQuote();
        const w = loadFreshness({ quotes: [q], server: { ...baseQuote() } });
        const el = fakeFolderEl();
        w.checkQuoteFreshness('71', el);
        await settle();
        expect(q.grandTotal).toBe('100');
        expect(w.calls.rerenders).toEqual([]);
        expect(el.children).toHaveLength(0);
    });

    test('a NEWER copy with no local edits refreshes the model and re-renders the card', async () => {
        const q = baseQuote();
        const fresh = { ...baseQuote(), updatedAt: '2026-08-13T09:00:00Z', grandTotal: '250', tableHTML: '<table>new</table>' };
        delete fresh._detailsUpdatedAt;
        const w = loadFreshness({ quotes: [q], server: fresh });
        w.checkQuoteFreshness('71', fakeFolderEl());
        await settle();
        expect(q.grandTotal).toBe('250');                       // the revision made elsewhere arrived
        expect(q.tableHTML).toBe('<table>new</table>');
        expect(q._detailsUpdatedAt).toBe('2026-08-13T09:00:00Z');
        expect(w.calls.rerenders).toEqual(['71']);              // redrawn through the normal path
    });

    test('a newer copy with UNSAVED EDITS here banners instead of clobbering', async () => {
        const q = { ...baseQuote(), hasUnsavedEdits: true };
        const fresh = { ...baseQuote(), updatedAt: '2026-08-13T09:00:00Z', grandTotal: '250' };
        const w = loadFreshness({ quotes: [q], server: fresh });
        const el = fakeFolderEl();
        w.checkQuoteFreshness('71', el);
        await settle();
        expect(q.grandTotal).toBe('100');                       // untouched — their edits outrank it
        expect(q.hasUnsavedEdits).toBe(true);
        expect(w.calls.rerenders).toEqual([]);
        expect(el.children).toHaveLength(1);
        expect(el.children[0].className).toBe('stale-quote-note');
        expect(el.children[0].innerHTML).toContain('older copy');
    });

    test('typing inside the card counts as editing, even before any change lands', async () => {
        const q = baseQuote();
        const fresh = { ...baseQuote(), updatedAt: '2026-08-13T09:00:00Z', grandTotal: '250' };
        const w = loadFreshness({ quotes: [q], server: fresh });
        const el = fakeFolderEl({ editing: true });
        w.checkQuoteFreshness('71', el);
        await settle();
        expect(q.grandTotal).toBe('100');
        expect(el.children[0].className).toBe('stale-quote-note');
    });

    test('the banner is never stacked twice', async () => {
        const q = { ...baseQuote(), hasUnsavedEdits: true };
        const fresh = { ...baseQuote(), updatedAt: '2026-08-13T09:00:00Z' };
        const w = loadFreshness({ quotes: [q], server: fresh });
        const el = fakeFolderEl();
        w.checkQuoteFreshness('71', el);
        await settle();
        w.checkQuoteFreshness('71', el);
        await settle();
        expect(el.children.filter((c) => c.className === 'stale-quote-note')).toHaveLength(1);
    });

    test('the banner button quotes the id with SINGLE quotes — double quotes truncated the onclick to a dead button', async () => {
        const q = { ...baseQuote(), hasUnsavedEdits: true };
        const fresh = { ...baseQuote(), updatedAt: '2026-08-13T09:00:00Z' };
        const w = loadFreshness({ quotes: [q], server: fresh });
        const el = fakeFolderEl();
        w.checkQuoteFreshness('71', el);
        await settle();
        expect(el.children[0].innerHTML).toContain("reloadQuotationCard('71')");
        expect(el.children[0].innerHTML).not.toContain('reloadQuotationCard("');
    });

    test('a failed or errored check changes nothing — the card already shows a copy', async () => {
        for (const server of ['down', 'http-error']) {
            const q = baseQuote();
            const w = loadFreshness({ quotes: [q], server });
            const el = fakeFolderEl();
            w.checkQuoteFreshness('71', el);
            await settle();
            expect(q.grandTotal).toBe('100');
            expect(el.children).toHaveLength(0);
            expect(w.calls.rerenders).toEqual([]);
        }
    });

    test('a card with no details yet is left to the lazy loader (no fetch at all)', async () => {
        const q = { ...baseQuote(), tableHTML: '' };
        const w = loadFreshness({ quotes: [q], server: { ...baseQuote() } });
        w.checkQuoteFreshness('71', fakeFolderEl());
        await settle();
        expect(w.calls.fetches).toBe(0);
    });

    test('an OLDER server copy never rolls the card back', async () => {
        // A replica lagging, or a cached response: refreshing "back" would undo a saved edit.
        const q = { ...baseQuote(), _detailsUpdatedAt: '2026-08-13T12:00:00Z', grandTotal: '999' };
        const fresh = { ...baseQuote(), updatedAt: '2026-08-11T00:00:00Z', grandTotal: '5' };
        const w = loadFreshness({ quotes: [q], server: fresh });
        w.checkQuoteFreshness('71', fakeFolderEl());
        await settle();
        expect(q.grandTotal).toBe('999');
        expect(w.calls.rerenders).toEqual([]);
    });
});

describe('reloadQuotationCard — the banner button really reloads', () => {
    test('drops this tab\'s copy and re-renders through the lazy path', () => {
        const q = { id: 71, tableHTML: '<table>old</table>', hasUnsavedEdits: true, _detailsUpdatedAt: 'x' };
        const w = loadFreshness({ quotes: [q], server: { } });
        // Its document.getElementById comes from the page; supply via a shim on the stubbed document.
        const el = fakeFolderEl();
        w.reloadQuotationCard = new Function('approvedQuotations', 'idsMatch', 'document', 'renderApprovalFolderContent',
            extractFunction(html, 'reloadQuotationCard') + '\nreturn reloadQuotationCard;')(
            [q], (a, b) => String(a) === String(b), { getElementById: () => el }, (id) => { q._rerendered = String(id); });
        w.reloadQuotationCard('71');
        expect(q.tableHTML).toBe('');                 // forces the lazy fetch
        expect(q.hasUnsavedEdits).toBe(false);
        expect(q._detailsUpdatedAt).toBeUndefined();
        expect(q._rerendered).toBe('71');
    });
});

describe('source guards — the wiring the extraction cannot see', () => {
    test('a reopen with details in hand still checks freshness (the toggle path)', () => {
        // The check first shipped only inside renderApprovalFolderContent — which a plain
        // close/reopen never calls, so it silently never ran. The toggle's open branch must
        // call it whenever there is no lazy marker.
        const toggle = extractFunction(html, 'toggleQuotationFolder');
        expect(toggle).toContain('checkQuoteFreshness(quotationId, folderContent)');
    });

    test('the lazy fetch stamps WHICH version the details are', () => {
        expect(html).toContain("quotation._detailsUpdatedAt = result.quotation.updatedAt || ''");
    });

    test('the freshness marker never persists to the backend', () => {
        expect(html).toContain('delete q._detailsUpdatedAt;');
    });
});
