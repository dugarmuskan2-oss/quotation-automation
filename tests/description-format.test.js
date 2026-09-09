/**
 * Tests for formatItemDescriptionByPipeType (index.html) — the function that
 * converts a normalized size code (e.g. "2XH", "25XHY", "65XM") into the
 * human-readable quotation format (e.g. "2" NB X Heavy -- ERW").
 *
 * WHY this matters: client enquiries arrive in wildly varied notations.
 * GPT normalizes them to a size code, then this function formats them. The
 * critical property is CONVERGENCE — the same physical pipe described many
 * ways must always produce ONE identical output string.
 *
 * The function and its helpers live in index.html (not a module), so we
 * extract the contiguous block of pure functions and eval it. If the block
 * boundaries in index.html change, update the markers below.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Extract the real functions from index.html ──────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const START = 'function normalizeFractionText';
const END = 'function createDefaultPipeHeaderRow';
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);

if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not locate the description-format function block in index.html — update START/END markers in this test.');
}

// eslint-disable-next-line no-eval
const sandbox = {};
(function () {
    const block = html.slice(startIdx, endIdx);
    // Expose the top-level function/const declarations on `sandbox`
    // eslint-disable-next-line no-eval
    eval(block + '\nsandbox.formatItemDescriptionByPipeType = formatItemDescriptionByPipeType;');
}).call(sandbox);

const format = sandbox.formatItemDescriptionByPipeType;
const f = (code, type) => format({ originalDescription: code, identifiedPipeType: type });

// =============================================================================
// Heavy / Medium / Light — inch notation
// =============================================================================
describe('class formatting — inch notation', () => {
    test('Heavy: 2XH ERW', () => expect(f('2XH', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('Medium: 2XM ERW', () => expect(f('2XM', 'ERW')).toBe('2" NB X Medium -- ERW'));
    test('Light: 2XL ERW', () => expect(f('2XL', 'ERW')).toBe('2" NB X Light -- ERW'));
    test('Heavy GI', () => expect(f('3XH', 'GI')).toBe('3" NB X Heavy -- GI'));
    test('Medium GI', () => expect(f('3XM', 'GI')).toBe('3" NB X Medium -- GI'));
    test('Light GI', () => expect(f('3XL', 'GI')).toBe('3" NB X Light -- GI'));
});

// =============================================================================
// Garbled AI codes — a doubled "X" separator (regression: DSC-2196 stored "1XXHY")
// =============================================================================
describe('garbled AI codes — doubled "X" is tolerated (frontend)', () => {
    test('1XXHY ERW -> Heavy', () => expect(f('1XXHY', 'ERW')).toBe('1" NB X Heavy -- ERW'));
    test('2XXH ERW -> Heavy', () => expect(f('2XXH', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('11/4XXH ERW -> 1-1/4 Heavy', () => expect(f('11/4XXH', 'ERW')).toBe('1-1/4" NB X Heavy -- ERW'));
    test('21/2XXH ERW -> 2-1/2 Heavy', () => expect(f('21/2XXH', 'ERW')).toBe('2-1/2" NB X Heavy -- ERW'));
    test('3XX5 ERW -> 5mm thk', () => expect(f('3XX5', 'ERW')).toBe('3" NB X 5mm thk -- ERW'));
    test('4XX5.4 ERW -> 5.4mm thk', () => expect(f('4XX5.4', 'ERW')).toBe('4" NB X 5.4mm thk -- ERW'));
    test('clean 2XH is unchanged (no regression)', () => expect(f('2XH', 'ERW')).toBe('2" NB X Heavy -- ERW'));
});

// The Gmail-ingest formatter (server-side, runs at ingest + on table rebuild) must decode
// identically — it mirrors the frontend one.
const ingestFormat = require('../gmail-ingest/descriptionFormatter').formatItemDescriptionByPipeType;
const gi = (code, type) => ingestFormat({ originalDescription: code, identifiedPipeType: type });
describe('garbled AI codes — Gmail-ingest formatter mirrors the fix', () => {
    test('1XXHY -> Heavy', () => expect(gi('1XXHY', 'ERW')).toBe('1" NB X Heavy -- ERW'));
    test('2XXH -> Heavy', () => expect(gi('2XXH', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('4XX5.4 -> 5.4mm thk', () => expect(gi('4XX5.4', 'ERW')).toBe('4" NB X 5.4mm thk -- ERW'));
    // Seamless "XXS" (extra-extra-strong) must NOT be collapsed to "XS" BY THE DOUBLED-X
    // COLLAPSE — the earlier `x{2,}` -> 'X' step, which explicitly skips seamless for this
    // exact reason (see the comment above it). It is skipped correctly: "2XXS" reaches the
    // matcher untouched. Named-schedule matching is a separate step downstream, and there the
    // regex that pulls the class token off the number itself consumes only one "X" as the
    // separator, so "XXS" arrives at that regex as "X" + "XS" and comes out "XS" — a real
    // quirk, present identically in index.html's own reference implementation for the same
    // input, so not something to silently diverge on here. Recorded rather than hidden.
    test('seamless "2XXS": the doubled-X collapse correctly leaves it alone', () => {
        expect(gi('2XXS', 'Seamless')).toBe('2" NB X Sch XS');   // matches index.html exactly
    });
});

// =============================================================================
// Spelled-out and abbreviated class tokens
// =============================================================================
describe('class token variants', () => {
    test('heavy spelled out', () => expect(f('2 X Heavy', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('hvy abbreviation', () => expect(f('2XHVY', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('HY (rate-file variant for 1")', () => expect(f('1XHY', 'GI')).toBe('1" NB X Heavy -- GI'));
    test('med abbreviation', () => expect(f('2XMED', 'ERW')).toBe('2" NB X Medium -- ERW'));
    test('medium spelled out', () => expect(f('2 X Medium', 'GI')).toBe('2" NB X Medium -- GI'));
    test('lgt abbreviation', () => expect(f('2XLGT', 'GI')).toBe('2" NB X Light -- GI'));
    test('light spelled out', () => expect(f('2 X Light', 'ERW')).toBe('2" NB X Light -- ERW'));
});

// =============================================================================
// Class LETTERS (A/B/C) — un-normalized codes GPT sometimes emits
// C Class = Heavy, B Class = Medium, A Class = Light
// =============================================================================
describe('class letters A/B/C', () => {
    test('XC (C class) → Heavy, with mm→inch', () => expect(f('125XC', 'ERW')).toBe('5" NB X Heavy -- ERW'));
    test('100XC → 4" Heavy', () => expect(f('100XC', 'ERW')).toBe('4" NB X Heavy -- ERW'));
    test('65XC → 2-1/2" Heavy', () => expect(f('65XC', 'ERW')).toBe('2-1/2" NB X Heavy -- ERW'));
    test('50XC → 2" Heavy GI', () => expect(f('50XC', 'GI')).toBe('2" NB X Heavy -- GI'));
    test('XB (B class) → Medium', () => expect(f('50XB', 'GI')).toBe('2" NB X Medium -- GI'));
    test('XA (A class) → Light', () => expect(f('50XA', 'ERW')).toBe('2" NB X Light -- ERW'));
    test('inch + C class: 2XC → 2" Heavy', () => expect(f('2XC', 'ERW')).toBe('2" NB X Heavy -- ERW'));
});

// Exact regression case from the reported screenshot: rows that GPT left
// un-normalized (raw mm NB + C class letter) showed as raw codes. Every one
// must now format with mm→inch and C→Heavy. (The rate ₹0 on these rows is a
// separate, accepted GPT-matching limitation — see note below.)
describe('regression: screenshot codes (mm + C class) all format', () => {
    const expected = {
        '40XC':  '1-1/2" NB X Heavy -- ERW',
        '50XC':  '2" NB X Heavy -- ERW',
        '65XC':  '2-1/2" NB X Heavy -- ERW',
        '100XC': '4" NB X Heavy -- ERW',
        '125XC': '5" NB X Heavy -- ERW',
    };
    Object.entries(expected).forEach(([code, want]) => {
        test(`${code} → ${want}`, () => expect(f(code, 'ERW')).toBe(want));
    });

    test('none of the screenshot codes render as raw (must contain " NB X ")', () => {
        Object.keys(expected).forEach(code => {
            expect(f(code, 'ERW')).toContain('" NB X ');
        });
    });
});

// Convergence: class letter and class word must produce the same output
describe('convergence: class letter == class word', () => {
    test('C class == Heavy', () => {
        expect(f('50XC', 'ERW')).toBe(f('50XH', 'ERW'));
    });
    test('B class == Medium', () => {
        expect(f('50XB', 'ERW')).toBe(f('50XM', 'ERW'));
    });
    test('A class == Light', () => {
        expect(f('50XA', 'ERW')).toBe(f('50XL', 'ERW'));
    });
});

// =============================================================================
// NB millimetre codes must convert to inch
// =============================================================================
describe('NB mm → inch conversion', () => {
    test('25mm → 1"', () => expect(f('25XH', 'ERW')).toBe('1" NB X Heavy -- ERW'));
    test('25XHY → 1" (mm + HY variant)', () => expect(f('25XHY', 'GI')).toBe('1" NB X Heavy -- GI'));
    test('32mm → 1-1/4"', () => expect(f('32XM', 'ERW')).toBe('1-1/4" NB X Medium -- ERW'));
    test('40mm → 1-1/2"', () => expect(f('40XH', 'GI')).toBe('1-1/2" NB X Heavy -- GI'));
    test('50mm → 2"', () => expect(f('50XH', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('65mm → 2-1/2"', () => expect(f('65XM', 'GI')).toBe('2-1/2" NB X Medium -- GI'));
    test('80mm → 3"', () => expect(f('80XH', 'ERW')).toBe('3" NB X Heavy -- ERW'));
    test('100mm → 4"', () => expect(f('100XH', 'GI')).toBe('4" NB X Heavy -- GI'));
    test('150mm → 6"', () => expect(f('150XM', 'ERW')).toBe('6" NB X Medium -- ERW'));
});

// =============================================================================
// CONVERGENCE — the same physical pipe in different notations must be identical.
// This is the core guarantee against careless-input inconsistency.
// =============================================================================
describe('convergence: same pipe, different notations → identical output', () => {
    const groups = {
        '1" Heavy GI':      [['25XHY', 'GI'], ['25XH', 'GI'], ['1XH', 'GI'], ['1XHY', 'GI']],
        '2.5" Medium GI':   [['65XM', 'GI'], ['21/2XM', 'GI'], ['2-1/2XM', 'GI']],
        '2" Heavy ERW':     [['50XH', 'ERW'], ['2XH', 'ERW']],
        '1.25" Medium ERW': [['32XM', 'ERW'], ['11/4XM', 'ERW'], ['1-1/4XM', 'ERW']],
        '1.5" Heavy GI':    [['40XH', 'GI'], ['11/2XH', 'GI']],
        '4" Heavy ERW':     [['100XH', 'ERW'], ['4XH', 'ERW']],
        '2" Light ERW':     [['50XL', 'ERW'], ['2XL', 'ERW']],
    };

    Object.entries(groups).forEach(([label, members]) => {
        test(label + ' converges', () => {
            const outputs = members.map(([code, type]) => f(code, type));
            const unique = [...new Set(outputs)];
            // All members must produce exactly one shared output string
            expect(unique).toHaveLength(1);
        });
    });
});

// =============================================================================
// Seamless schedules
// =============================================================================
describe('seamless schedule formatting', () => {
    test('numeric schedule 40', () => expect(f('2X40', 'Seamless')).toBe('2" NB X Sch 40'));
    test('numeric schedule 80 with fraction', () => expect(f('11/4X80', 'Seamless')).toBe('1-1/4" NB X Sch 80'));
    // Named ANSI schedules — must format like numeric ones, not stay raw
    test('XS named schedule', () => expect(f('2XXS', 'Seamless')).toBe('2" NB X Sch XS'));
    test('XXS named schedule', () => expect(f('2XXXS', 'Seamless')).toBe('2" NB X Sch XXS'));
    test('STD named schedule', () => expect(f('2XSTD', 'Seamless')).toBe('2" NB X Sch STD'));
    test('XXS on a fractional size', () => expect(f('1/2XXXS', 'Seamless')).toBe('1/2" NB X Sch XXS'));
    test('named schedule is uppercased', () => expect(f('2Xstd', 'Seamless')).toBe('2" NB X Sch STD'));
});

// =============================================================================
// mm × explicit thickness (large bore)
// =============================================================================
describe('mm × explicit thickness', () => {
    test('200 × 6mm ERW', () => expect(f('200X6', 'ERW')).toBe('8" NB X 6mm thk -- ERW'));
    test('300 × 8mm GI', () => expect(f('300X8', 'GI')).toBe('12" NB X 8mm thk -- GI'));
});

// =============================================================================
// Robustness — must not throw on empty / odd input
// =============================================================================
describe('robustness', () => {
    test('empty description returns empty', () => expect(f('', 'ERW')).toBe(''));
    test('null description does not throw', () => {
        expect(() => format({ identifiedPipeType: 'ERW' })).not.toThrow();
    });
    test('unknown pipe type returns raw code unchanged', () => {
        // No GI/ERW/Seamless → returns raw description
        expect(f('2XH', 'PVC')).toBe('2XH');
    });
});

// =============================================================================
// REGRESSION: 6", 8" and 10" pipe were being read as 6mm/8mm/10mm NB and
// converted down to 1/8", 1/4" and 3/8" — a real pipe on a real quote shown
// to the customer as roughly a sixteenth of its actual size.
//
// NB_MM_TO_INCH exists to convert a genuine mm-NB code (customers often write
// "125 NB", "65 NB") into inches — 125XC and 65XC in the tests above are real,
// deliberately-fixed cases of that. The table was applied to EVERY number it
// contains, including 6, 8 and 10 — and 6, 8 and 10 are ALSO completely
// ordinary bare-inch sizes, which this business quotes constantly. Nobody
// writes "6 NB" to mean an eighth-inch instrumentation tube in this trade;
// live data confirms it every time: 6XH/6XM appear on quotes across the whole
// history and their stored kg/m always matches the 6" weight, never 1/8"'s —
// DSC-1789's 6XH carries kgPerMeter 21.30, the known 6" ERW Heavy weight used
// as a control value throughout this repo's own pipe-weight tests.
//
// utils/pipeWeights.js — the size matcher already proven against the real
// price lists elsewhere in this repo — treats these numbers as inches too,
// with no mm conversion for any of them. This suite is what makes this
// function agree with that one, rather than silently disagreeing about what
// a "6" on a quote means.
//
// The larger table entries (25 and up) are NOT touched: nobody writes "25XH"
// meaning a 25-inch pipe in the Light/Medium/Heavy system (it doesn't exist
// at that size), so those conversions stay exactly as the tests above require.
// =============================================================================
describe('REGRESSION: 6/8/10 must read as inches, not mm-NB', () => {
    test('6XH is a 6 inch pipe, not 1/8 inch', () => expect(f('6XH', 'ERW')).toBe('6" NB X Heavy -- ERW'));
    test('6XM is a 6 inch pipe, not 1/8 inch', () => expect(f('6XM', 'ERW')).toBe('6" NB X Medium -- ERW'));
    test('6XH on GI', () => expect(f('6XH', 'GI')).toBe('6" NB X Heavy -- GI'));
    test('8X6.35 is an 8 inch pipe wall thickness, not 1/4 inch', () => expect(f('8X6.35', 'ERW')).toBe('8" NB X 6.35mm thk -- ERW'));
    test('10X6.35 is a 10 inch pipe wall thickness, not 3/8 inch', () => expect(f('10X6.35', 'ERW')).toBe('10" NB X 6.35mm thk -- ERW'));
    test('8X40 (seamless schedule) is an 8 inch pipe, not 1/4 inch', () => expect(f('8X40', 'Seamless')).toBe('8" NB X Sch 40'));
    test('8X80 (seamless schedule) is an 8 inch pipe, not 1/4 inch', () => expect(f('8X80', 'Seamless')).toBe('8" NB X Sch 80'));
    test('10X80 (seamless schedule) is a 10 inch pipe, not 3/8 inch', () => expect(f('10X80', 'Seamless')).toBe('10" NB X Sch 80'));
    test('6X40 (seamless schedule) is a 6 inch pipe, not 1/8 inch', () => expect(f('6X40', 'Seamless')).toBe('6" NB X Sch 40'));

    // The larger NB codes must still convert — this is what protects the ORIGINAL
    // reported bug (the "screenshot codes" above) from coming back while fixing this one.
    test('125XC still converts: it is 125mm NB, not a 125 inch pipe', () => expect(f('125XC', 'ERW')).toBe('5" NB X Heavy -- ERW'));
    test('50XH still converts: it is 50mm NB, not a 50 inch pipe', () => expect(f('50XH', 'ERW')).toBe('2" NB X Heavy -- ERW'));
    test('150XM still converts: it is 150mm NB, not a 150 inch pipe', () => expect(f('150XM', 'ERW')).toBe('6" NB X Medium -- ERW'));
});

// =============================================================================
// CONVERGENCE — frontend and Gmail-ingest formatter must produce the same output.
//
// The whole class of bug this file guards against: index.html's copy and
// gmail-ingest/descriptionFormatter.js's copy are two hand-written mirrors of the same logic,
// not one shared module — a manual-paste quote goes through one, a Gmail-ingested quote goes
// through the other. That is how the 6/8/10 bug above stayed invisible for three months:
// Gmail-ingested quotes happened to use the OTHER copy, which never had the bug — so a real
// customer's 6" pipe read correctly on one quote and as 1/8" on another, with nothing to say
// why. This suite runs the SAME code through both and requires them to agree, so the next
// feature added to one side cannot go quietly missing from the other the way NB-mm conversion,
// the A/B/C class letters and Light-class matching all did.
// =============================================================================
describe('CONVERGENCE: the frontend and Gmail-ingest formatters must agree', () => {
    const cases = [
        ['2XH', 'ERW'], ['2XM', 'ERW'], ['2XL', 'ERW'], ['3XH', 'GI'],
        ['1XHY', 'GI'], ['2XLGT', 'GI'], ['2 X Light', 'ERW'],
        ['50XC', 'ERW'], ['50XB', 'GI'], ['50XA', 'ERW'], ['125XC', 'ERW'],
        ['65XM', 'GI'], ['100XH', 'GI'], ['150XM', 'ERW'],
        ['6XH', 'ERW'], ['6XM', 'ERW'], ['6XH', 'GI'],
        ['8X6.35', 'ERW'], ['10X6.35', 'ERW'],
        ['8X40', 'Seamless'], ['8X80', 'Seamless'], ['6X40', 'Seamless'], ['10X80', 'Seamless'],
        ['4X80', 'Seamless'], ['2XSTD', 'Seamless'],
        ['1XXHY', 'ERW'], ['2XXH', 'ERW'], ['4XX5.4', 'ERW'],
        ['', 'ERW'], ['2XH', 'PVC'],
    ];
    cases.forEach(([code, type]) => {
        test(`${code || '(empty)'} / ${type}`, () => expect(gi(code, type)).toBe(f(code, type)));
    });
});
