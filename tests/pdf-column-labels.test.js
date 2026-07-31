/**
 * @jest-environment node
 *
 * tests/pdf-column-labels.test.js
 *
 * getPdfColLabelsFromTable (index.html) — the column header labels the PDF /
 * print output uses. It reads the live quote table's <thead>, drops the columns
 * that must never be printed (BASE RATE, MARGIN %, ACTIONS) and maps what's left
 * onto the 5 PDF columns: S.NO, ITEMS, QTY, RATE, AMOUNT.
 *
 * THE REGRESSION THIS LOCKS DOWN: a user renamed the rate column to
 * "Rate per (KGS)" and the PDF still printed the hard-coded "Rate per Mtr (Rs.)".
 * The old matcher was /RATE\s*PER\s*(MTR|MTRS|METER|KG|UNIT|\w+)/i, which needed a
 * WORD character immediately after "RATE PER" — a bracket is not one, so the match
 * failed and the default silently won. It is now matched with plain /RATE/i (safe,
 * because BASE RATE is already excluded from the candidate list before the pick).
 *
 * jsdom is NOT installed, so the REAL extracted function is driven through a
 * minimal hand-rolled DOM stub implementing exactly the surface it touches:
 * tableEl.querySelector('thead tr'), headerRow.querySelectorAll('th') (a real
 * Array, so Array.from works), th.querySelector('input'), input.value /
 * input.getAttribute('value'), th.textContent and th.classList.contains().
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

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

// Concatenate the named functions (declarations hoist, so order is irrelevant) and
// return the LAST one. getPdfColLabelsFromTable is self-contained — no stubs needed.
function loadFns(names) {
    const body = names.map(function (n) { return extractFunction(html, n); }).join('\n');
    // eslint-disable-next-line no-new-func
    const factory = new Function(body + '\nreturn ' + names[names.length - 1] + ';');
    return factory();
}

const getPdfColLabelsFromTable = loadFns(['getPdfColLabelsFromTable']);

// The documented fallbacks, straight from the function.
const DEFAULTS = ['S. NO', 'ITEMS AND DESCRIPTION', 'QTY (Mtrs)', 'Rate per Mtr (Rs.)', 'AMOUNT (Rs.)'];

// =============================================================================
// Minimal DOM stub
// =============================================================================

// A column spec is either a plain string (its textContent) or
// { text, className, input: { value, attr } }.
function makeTh(spec) {
    const s = (typeof spec === 'string') ? { text: spec } : (spec || {});
    const classes = String(s.className || '').split(/\s+/).filter(Boolean);
    const input = s.input ? {
        value: s.input.value === undefined ? '' : s.input.value,
        getAttribute: function (name) {
            return (name === 'value' && s.input.attr !== undefined) ? s.input.attr : null;
        }
    } : null;
    return {
        textContent: s.text === undefined ? '' : s.text,
        classList: { contains: function (c) { return classes.indexOf(c) !== -1; } },
        querySelector: function (sel) { return sel === 'input' ? input : null; }
    };
}

function makeTable(specs) {
    const ths = (specs || []).map(makeTh);
    const headerRow = {
        // A REAL array, so Array.from / forEach in the function under test work.
        querySelectorAll: function (sel) { return sel === 'th' ? ths.slice() : []; }
    };
    return {
        querySelector: function (sel) { return sel === 'thead tr' ? headerRow : null; }
    };
}

function makeTableWithoutThead() {
    return { querySelector: function () { return null; } };
}

// The real shipped header row, with the rate column renamed by the user.
const KG_TABLE = [
    'S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)',
    'BASE RATE', 'MARGIN %', 'Rate per (KGS)', 'AMOUNT', 'ACTIONS'
];

// =============================================================================
// 1. The regression: a bracketed unit must survive
// =============================================================================
describe('the "Rate per (KGS)" regression', () => {
    test('a bracketed rate unit is printed as typed, not replaced by the default', () => {
        expect(getPdfColLabelsFromTable(makeTable(KG_TABLE))).toEqual([
            'S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)', 'Rate per (KGS)', 'AMOUNT'
        ]);
    });

    test('the returned rate label is NOT the "Rate per Mtr (Rs.)" default', () => {
        const cols = getPdfColLabelsFromTable(makeTable(KG_TABLE));
        expect(cols[3]).not.toBe(DEFAULTS[3]);
        expect(cols[3]).toBe('Rate per (KGS)');
    });

    test('source guard: the rate column is matched with /RATE/i, not the old word-anchored pattern', () => {
        const fn = extractFunction(html, 'getPdfColLabelsFromTable');
        expect(fn).toContain('pick(/RATE/i)');
        expect(fn).not.toContain('RATE\\s*PER\\s*(MTR');
        expect(html).not.toContain('RATE\\s*PER\\s*(MTR|MTRS|METER|KG|UNIT|\\w+)');
    });
});

// =============================================================================
// 2. Any unit the user types comes through
// =============================================================================
describe('rate column — whatever unit the user types', () => {
    test.each([
        ['Rate per (KGS)'],
        ['Rate per (Mtrs)'],
        ['Rate per (MT)'],
        ['Rate per KG'],
        ['RATE PER TON'],
        ['Rate per Mtr (Rs.)'],
        ['Rate/KG']
    ])('%s is used verbatim as the PDF rate header', (rateLabel) => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)',
            'BASE RATE', 'MARGIN %', rateLabel, 'AMOUNT', 'ACTIONS'
        ]));
        expect(cols[3]).toBe(rateLabel);
    });
});

// =============================================================================
// 3. The stock header row still works
// =============================================================================
describe('the default header row', () => {
    test('the shipped "Rate per Mtr (Rs.)" / "QTY (Mtrs)" row round-trips unchanged', () => {
        expect(getPdfColLabelsFromTable(makeTable([
            'S. NO', 'ITEMS AND DESCRIPTION', 'QTY (Mtrs)',
            'BASE RATE', 'MARGIN %', 'Rate per Mtr (Rs.)', 'AMOUNT (Rs.)', 'ACTIONS'
        ]))).toEqual(DEFAULTS);
    });

    test.each([
        ['QTY (KGS)'],
        ['QTY (Mtrs)'],
        ['QTY (MT)'],
        ['QTY']
    ])('%s comes through as the PDF quantity header', (qtyLabel) => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO', 'ITEMS AND DESCRIPTION', qtyLabel,
            'BASE RATE', 'MARGIN %', 'Rate per (KGS)', 'AMOUNT', 'ACTIONS'
        ]));
        expect(cols[2]).toBe(qtyLabel);
    });
});

// =============================================================================
// 4. Columns that must never reach the PDF
// =============================================================================
describe('excluded columns', () => {
    test('BASE RATE, MARGIN % and ACTIONS never appear in the 5 PDF columns', () => {
        const cols = getPdfColLabelsFromTable(makeTable(KG_TABLE));
        expect(cols).toHaveLength(5);
        expect(cols).not.toContain('BASE RATE');
        expect(cols).not.toContain('MARGIN %');
        expect(cols).not.toContain('ACTIONS');
    });

    test('BASE RATE is not mistaken for the rate column even though it contains "RATE"', () => {
        // No rate column at all — BASE RATE sits right where a /RATE/i match could grab it.
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)', 'BASE RATE', 'MARGIN %', 'AMOUNT', 'ACTIONS'
        ]));
        expect(cols[3]).toBe(DEFAULTS[3]);
        expect(cols).toEqual(['S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)', 'Rate per Mtr (Rs.)', 'AMOUNT']);
    });

    test('the exclusions are case- and spacing-insensitive ("Base Rate", "margin", "Actions")', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)',
            'Base  Rate', 'margin', 'Rate per (KGS)', 'AMOUNT', 'Actions'
        ]));
        expect(cols).toEqual(['S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)', 'Rate per (KGS)', 'AMOUNT']);
    });
});

// =============================================================================
// 5. Class-based exclusion (labels the text pattern can't catch)
// =============================================================================
describe('col-base-rate / col-margin class exclusion', () => {
    test('a th classed col-base-rate is skipped even when its text does not match the exclude pattern', () => {
        // "Base Rate (Rs.)" is NOT caught by the anchored ^BASE\s*RATE$ text rule, and it
        // sits BEFORE the real rate column — only the class check keeps /RATE/i off it.
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            'QTY (KGS)',
            { text: 'Base Rate (Rs.)', className: 'col-base-rate' },
            { text: 'Margin (%)', className: 'col-margin' },
            'Rate per (KGS)',
            'AMOUNT'
        ]));
        expect(cols).toEqual(['S. NO', 'ITEMS AND DESCRIPTION', 'QTY (KGS)', 'Rate per (KGS)', 'AMOUNT']);
        expect(cols).not.toContain('Base Rate (Rs.)');
        expect(cols).not.toContain('Margin (%)');
    });

    test('other classes on a th do not exclude it', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            'QTY (KGS)',
            { text: 'Rate per (KGS)', className: 'col-rate sortable' },
            'AMOUNT'
        ]));
        expect(cols[3]).toBe('Rate per (KGS)');
    });
});

// =============================================================================
// 6. Fallbacks
// =============================================================================
describe('fallbacks to the documented defaults', () => {
    test('a missing column falls back individually, the present ones are kept', () => {
        const cols = getPdfColLabelsFromTable(makeTable(['ITEMS AND DESCRIPTION', 'AMOUNT (Rs.)']));
        expect(cols).toEqual(['S. NO', 'ITEMS AND DESCRIPTION', 'QTY (Mtrs)', 'Rate per Mtr (Rs.)', 'AMOUNT (Rs.)']);
    });

    test('an empty header row falls back to every default', () => {
        expect(getPdfColLabelsFromTable(makeTable([]))).toEqual(DEFAULTS);
    });

    test('a table with no thead falls back to every default', () => {
        expect(getPdfColLabelsFromTable(makeTableWithoutThead())).toEqual(DEFAULTS);
    });

    test('a null table falls back to every default', () => {
        expect(getPdfColLabelsFromTable(null)).toEqual(DEFAULTS);
    });

    test('a blank label is ignored and its column falls back', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO', 'ITEMS AND DESCRIPTION', { text: '   ' }, 'Rate per (KGS)', 'AMOUNT'
        ]));
        expect(cols[2]).toBe(DEFAULTS[2]);
    });
});

// =============================================================================
// 7. Where the label text is read from
// =============================================================================
describe('reading the label off a th', () => {
    test("an editable header's input value beats its textContent", () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            { text: 'QTY (Mtrs)', input: { value: 'QTY (KGS)' } },
            { text: 'Rate per Mtr (Rs.)', input: { value: 'Rate per (KGS)' } },
            'AMOUNT'
        ]));
        expect(cols[2]).toBe('QTY (KGS)');
        expect(cols[3]).toBe('Rate per (KGS)');
    });

    test('an empty input.value falls back to the value ATTRIBUTE', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            'QTY (KGS)',
            { text: 'ignored text', input: { value: '', attr: 'Rate per (TON)' } },
            'AMOUNT'
        ]));
        expect(cols[3]).toBe('Rate per (TON)');
    });

    test('an input with no value and no attribute blanks the column, so it falls back', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            { text: 'QTY (KGS)', input: { value: '' } },
            'Rate per (KGS)',
            'AMOUNT'
        ]));
        expect(cols[2]).toBe(DEFAULTS[2]);
    });

    test('input values are trimmed', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            'QTY (KGS)',
            { text: 'x', input: { value: '   Rate per (KGS)  ' } },
            'AMOUNT'
        ]));
        expect(cols[3]).toBe('Rate per (KGS)');
    });

    test('a th with no input uses textContent, with whitespace collapsed', () => {
        const cols = getPdfColLabelsFromTable(makeTable([
            'S. NO',
            'ITEMS AND DESCRIPTION',
            { text: '  QTY \n   (KGS)  ' },
            { text: 'Rate\tper\n(KGS)' },
            'AMOUNT'
        ]));
        expect(cols[2]).toBe('QTY (KGS)');
        expect(cols[3]).toBe('Rate per (KGS)');
    });
});
