/**
 * @jest-environment node
 *
 * tests/revision-signature.test.js
 *
 * The "no changes -> no revision" guard. `Save as Revision` only creates a new
 * version when the quote actually differs from the version the customer has.
 * The comparison is a pure fingerprint (`revisionSignature`) that strips number
 * formatting so ₹250000 and ₹2,50,000 compare equal — this is the exact bug that
 * made the first attempt at this guard misfire.
 *
 * `revisionSignature` lives inline in the browser-only SPA (index.html), so this
 * test extracts it by name (brace-matching) and evals it — same approach as
 * tests/description-format.test.js. If the function is renamed, update EXTRACT_NAME.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const EXTRACT_NAME = 'revisionSignature';

// Pull a top-level `function name(...) { ... }` out of source by brace-matching.
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

const html = fs.readFileSync(INDEX_PATH, 'utf8');
// eslint-disable-next-line no-eval
const revisionSignature = eval('(' + extractFunction(html, EXTRACT_NAME) + ')');

const item = (desc, lineTotal) => ({ originalDescription: desc, lineTotal });

describe('revisionSignature — same quote must fingerprint the same', () => {
    test('identical items + total -> equal signatures', () => {
        const a = [item('2" NB Heavy GI', 120000), item('Freight', 18500)];
        const b = [item('2" NB Heavy GI', 120000), item('Freight', 18500)];
        expect(revisionSignature(a, 138500)).toBe(revisionSignature(b, 138500));
    });

    test('number formatting is ignored (₹250000 === ₹2,50,000)', () => {
        const plain = [item('Pipe', 250000)];
        const grouped = [item('Pipe', '2,50,000')];
        expect(revisionSignature(plain, 250000)).toBe(revisionSignature(grouped, '2,50,000'));
    });

    test('currency symbols / stray spacing do not matter', () => {
        const a = [item('Pipe', '₹ 1,20,000')];
        const b = [item('Pipe', 120000)];
        expect(revisionSignature(a, '₹1,20,000')).toBe(revisionSignature(b, 120000));
    });

    test('description differences ignore case and surrounding whitespace', () => {
        const a = [item('2" NB Heavy GI', 100)];
        const b = [item('  2" nb heavy gi ', 100)];
        expect(revisionSignature(a, 100)).toBe(revisionSignature(b, 100));
    });

    test('reads description OR originalDescription', () => {
        const a = [{ description: 'Pipe', lineTotal: 500 }];
        const b = [{ originalDescription: 'Pipe', lineTotal: 500 }];
        expect(revisionSignature(a, 500)).toBe(revisionSignature(b, 500));
    });
});

describe('revisionSignature — real changes must fingerprint differently', () => {
    const base = [item('Pipe', 100000)];

    test('a changed line total differs', () => {
        expect(revisionSignature(base, 100000))
            .not.toBe(revisionSignature([item('Pipe', 105000)], 105000));
    });

    test('a changed grand total differs', () => {
        expect(revisionSignature(base, 100000))
            .not.toBe(revisionSignature(base, 118500));
    });

    test('an added freight line differs', () => {
        const withFreight = base.concat([item('Freight', 18500)]);
        expect(revisionSignature(base, 100000))
            .not.toBe(revisionSignature(withFreight, 118500));
    });

    test('a removed line differs', () => {
        const two = [item('Pipe A', 100000), item('Pipe B', 50000)];
        expect(revisionSignature(two, 150000))
            .not.toBe(revisionSignature([item('Pipe A', 100000)], 100000));
    });

    test('a changed description differs', () => {
        expect(revisionSignature(base, 100000))
            .not.toBe(revisionSignature([item('Different pipe', 100000)], 100000));
    });
});

describe('revisionSignature — never throws on messy input', () => {
    test('handles null / non-array items and null total', () => {
        expect(() => revisionSignature(null, null)).not.toThrow();
        expect(() => revisionSignature(undefined, undefined)).not.toThrow();
        expect(revisionSignature([], 0)).toBe(revisionSignature(null, null));
    });

    test('handles items with missing fields', () => {
        expect(() => revisionSignature([{}, { lineTotal: 5 }], '')).not.toThrow();
    });
});

describe('source guard — the guard is actually wired into Save as Revision', () => {
    test('createRevisionFromBaseline consults currentDiffersFromBaseline and can bail', () => {
        expect(html).toContain('function currentDiffersFromBaseline');
        expect(html).toContain('if (!currentDiffersFromBaseline(quotation, baseline)) return false');
    });

    test('saveQuotationChanges uses the return value (no revision when unchanged)', () => {
        expect(html).toContain('madeRevision = createRevisionFromBaseline(quotation)');
        expect(html).toContain('nothing new to save as a revision');
    });
});
