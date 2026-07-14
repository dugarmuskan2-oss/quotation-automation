/**
 * @jest-environment node
 *
 * tests/freight-terms-sync.test.js
 *
 * "Freight state auto-updates the terms freight + price-basis lines" (commit
 * a7cbc70). The pure rewriter applyFreightTermsState edits the "Freight: ..."
 * line to extra / included / FOR, and strips the "Price basis: ..." line while
 * freight is present (stashing it on the quote so it can be restored). The DOM
 * callers (detectQuoteFreightState / syncFreightTermForQuote /
 * syncFreightTermForCreation) are covered with source guards.
 *
 * applyFreightTermsState is fully pure; extracted by name + eval'd (same as
 * tests/revision-signature.test.js).
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
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

// eslint-disable-next-line no-new-func
const applyFreightTermsState = new Function('return ' + extractFunction(html, 'applyFreightTermsState'))();

describe('applyFreightTermsState — rewrite the "Freight:" line', () => {
    test('"extra" -> FOR when freight is folded into the rates', () => {
        expect(applyFreightTermsState('1. Freight: extra', 'for', {})).toBe('1. Freight: FOR');
    });
    test('"extra" -> included when freight is a separate line', () => {
        expect(applyFreightTermsState('Freight: extra', 'included', {})).toBe('Freight: included');
    });
    test('FOR -> extra when freight is removed', () => {
        expect(applyFreightTermsState('Freight: FOR', 'extra', {})).toBe('Freight: extra');
    });
    test('is case-insensitive and only swaps the trailing word', () => {
        expect(applyFreightTermsState('FREIGHT: Included', 'for', {})).toBe('FREIGHT: FOR');
    });
    test('tolerates a short qualifier between "Freight" and the colon', () => {
        expect(applyFreightTermsState('3. Freight charges : extra', 'for', {})).toBe('3. Freight charges : FOR');
    });
    test('a very long prefix before the colon does NOT match (left as-is)', () => {
        const t = 'Freight for delivery to the site location: extra';
        expect(applyFreightTermsState(t, 'for', {})).toBe(t);
    });
    test('no freight line at all -> returned unchanged (drives the caller no-op)', () => {
        const t = '1. Payment: 100% advance\n2. Delivery: 2 weeks';
        expect(applyFreightTermsState(t, 'for', {})).toBe(t);
    });
    test('null / undefined terms -> empty string', () => {
        expect(applyFreightTermsState(null, 'for', {})).toBe('');
        expect(applyFreightTermsState(undefined, 'extra', {})).toBe('');
    });
});

describe('applyFreightTermsState — price-basis stash + restore', () => {
    test('going to FOR strips the Price basis line and stashes it on the quote', () => {
        const q = {};
        const input = 'Price basis: Ex-godown Chennai\nFreight: extra';
        const out = applyFreightTermsState(input, 'for', q);
        expect(out).toBe('Freight: FOR');
        expect(q._priceBasisLine).toBe('Price basis: Ex-godown Chennai\n');
    });

    test('going to included also strips + stashes the Price basis line', () => {
        const q = {};
        const out = applyFreightTermsState('Price basis: Ex-godown Chennai\nFreight: extra', 'included', q);
        expect(out).toBe('Freight: included');
        expect(q._priceBasisLine).toBe('Price basis: Ex-godown Chennai\n');
    });

    test('back to extra restores the stashed line ABOVE the freight line and clears the stash', () => {
        const q = { _priceBasisLine: 'Price basis: Ex-godown Chennai\n' };
        const out = applyFreightTermsState('Freight: FOR', 'extra', q);
        expect(out).toBe('Price basis: Ex-godown Chennai\nFreight: extra');
        expect(q._priceBasisLine).toBe('');
    });

    test('round-trip FOR -> extra returns to the original terms', () => {
        const q = {};
        const original = 'Price basis: Ex-godown Chennai\nFreight: extra';
        const folded = applyFreightTermsState(original, 'for', q);
        const restored = applyFreightTermsState(folded, 'extra', q);
        expect(restored).toBe(original);
    });

    test('does not double-stash when the price-basis line is already stashed', () => {
        const q = { _priceBasisLine: 'Price basis: ORIGINAL\n' };
        applyFreightTermsState('Price basis: NEWER\nFreight: extra', 'for', q);
        expect(q._priceBasisLine).toBe('Price basis: ORIGINAL\n');   // first stash preserved
    });
});

describe('source guard — the DOM callers that drive the rewriter', () => {
    test('applyFreightTermsState exists (extractor anchor)', () => {
        expect(html).toContain('function applyFreightTermsState(termsText, state, quotation) {');
    });
    test('syncFreightTermForQuote no-ops when nothing changed and writes back otherwise', () => {
        expect(html).toContain('if (updated === current) return;   // no freight/price-basis lines, or already correct');
        expect(html).toContain('quotation.termsText = updated;');
    });
    test('detectQuoteFreightState reads FOR first, then the freight line amount', () => {
        expect(html).toContain('if (quotation && quotation.freightDistributedIntoMargin === true) return \'for\';');
        expect(html).toContain('.freight-row .freight-amount-input[data-field="lineTotal"]');
    });
    test('the creation-section sync detects the FOR class and stashes on the textarea dataset', () => {
        expect(html).toContain("if (scope.querySelector('.freight-row.freight-distributed')) {");
        expect(html).toContain("ta.dataset.priceBasisLine = stash._priceBasisLine || '';");
    });
});
