/**
 * @jest-environment node
 *
 * tests/admin-margins.test.js
 *
 * The admin "Margins to allocate" desk turns a per-pipe-type margin decision
 * into stamped line items (stampAdminMargins) and a tiny summary the list can
 * render without heavy fields (buildItemSummary). Both are pure — unit-tested
 * directly from utils/calculations.js.
 */

'use strict';

const { stampAdminMargins, buildItemSummary } = require('../utils/calculations');

const item = (over) => Object.assign({
    lineItemId: 'li', originalDescription: 'd', identifiedPipeType: '',
    quantity: '10', unitRate: '100', marginPercent: '', kgPerMeter: '',
}, over);

describe('buildItemSummary — the desk\'s at-a-glance summary', () => {
    test('empty / non-array -> zeroed summary', () => {
        expect(buildItemSummary([])).toEqual({ count: 0, types: [], noRate: 0 });
        expect(buildItemSummary(null)).toEqual({ count: 0, types: [], noRate: 0 });
        expect(buildItemSummary(undefined)).toEqual({ count: 0, types: [], noRate: 0 });
    });

    test('counts items and collects distinct pipe types in first-seen order', () => {
        const s = buildItemSummary([
            item({ identifiedPipeType: 'Seamless Sch 40' }),
            item({ identifiedPipeType: 'ERW' }),
            item({ identifiedPipeType: 'Seamless heavy' }),   // duplicate type
            item({ identifiedPipeType: 'GI medium' }),
        ]);
        expect(s.count).toBe(4);
        expect(s.types).toEqual(['Seamless', 'ERW', 'GI']);
    });

    test('noRate counts items missing a usable rate (blank, zero, negative, NaN)', () => {
        const s = buildItemSummary([
            item({ unitRate: '100' }),   // ok
            item({ unitRate: '' }),      // missing
            item({ unitRate: '0' }),     // zero
            item({ unitRate: '-5' }),    // negative
            item({ unitRate: 'abc' }),   // NaN
        ]);
        expect(s.count).toBe(5);
        expect(s.noRate).toBe(4);
    });

    test('unknown pipe type is not added to types', () => {
        expect(buildItemSummary([item({ identifiedPipeType: 'mystery' })]).types).toEqual([]);
    });
});

describe('stampAdminMargins — applies the admin margin decision per pipe type', () => {
    test('Seamless price mode quotes at list rate (margin 0)', () => {
        const [out] = stampAdminMargins(
            [item({ identifiedPipeType: 'Seamless Sch 40', unitRate: '250' })],
            { seamless: { mode: 'price' } }
        );
        expect(out.marginPercent).toBe('0');
        expect(out.finalRate).toBe('250');   // round(250 * 1.00)
    });

    test('Seamless cost mode uses costRate + pct margin', () => {
        const [out] = stampAdminMargins(
            [item({ identifiedPipeType: 'Seamless', unitRate: '999', costRate: '200' })],
            { seamless: { mode: 'cost', pct: 10 } }
        );
        expect(out.unitRate).toBe('200.00');   // base swapped to the cost column
        expect(out.marginPercent).toBe('10');
        expect(out.finalRate).toBe('220');     // round(200 * 1.10)
    });

    test('Seamless cost mode with no costRate keeps the existing rate', () => {
        const [out] = stampAdminMargins(
            [item({ identifiedPipeType: 'Seamless', unitRate: '150' })],
            { seamless: { mode: 'cost', pct: 20 } }
        );
        expect(out.unitRate).toBe('150.00');
        expect(out.marginPercent).toBe('20');
        expect(out.finalRate).toBe('180');     // round(150 * 1.20)
    });

    test('ERW and GI take their own pct from the cost column', () => {
        const [erw, gi] = stampAdminMargins(
            [item({ identifiedPipeType: 'ERW', unitRate: '50' }), item({ identifiedPipeType: 'GI', unitRate: '40' })],
            { erw: { pct: 12 }, gi: { pct: 25 } }
        );
        expect(erw.marginPercent).toBe('12');
        expect(erw.finalRate).toBe('56');       // round(50 * 1.12)
        expect(gi.marginPercent).toBe('25');
        expect(gi.finalRate).toBe('50');        // round(40 * 1.25)
    });

    test('missing / negative pct normalises to 0', () => {
        const [a, b] = stampAdminMargins(
            [item({ identifiedPipeType: 'ERW', unitRate: '80' }), item({ identifiedPipeType: 'GI', unitRate: '80' })],
            { erw: { pct: -5 }, gi: {} }
        );
        expect(a.marginPercent).toBe('0');
        expect(b.marginPercent).toBe('0');
    });

    test('unknown pipe type is left untouched for staff to decide', () => {
        const input = item({ identifiedPipeType: 'special alloy', marginPercent: '7' });
        const [out] = stampAdminMargins([input], { seamless: { mode: 'price' } });
        // returned as-is: not recalculated, original margin preserved, no forced finalRate
        expect(out.marginPercent).toBe('7');
        expect(out.identifiedPipeType).toBe('special alloy');
    });

    test('never mutates the input items', () => {
        const input = item({ identifiedPipeType: 'ERW', unitRate: '50', marginPercent: '' });
        const snapshot = JSON.stringify(input);
        stampAdminMargins([input], { erw: { pct: 30 } });
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    test('non-array input -> empty array', () => {
        expect(stampAdminMargins(null, {})).toEqual([]);
        expect(stampAdminMargins(undefined, { erw: { pct: 1 } })).toEqual([]);
    });
});
