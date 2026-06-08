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
