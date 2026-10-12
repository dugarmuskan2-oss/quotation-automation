/**
 * @jest-environment node
 *
 * tests/quantity-units.test.js
 *
 * Quantities asked in kg, and items that are not pipes (utils/quantityUnits.js).
 * DSC-2823 asked for 2,497 kg and came out as 6 m on every line; an angle and a square bar were
 * filed as "MS ERW Pipe". The rules pinned here:
 *   - kg becomes metres ONLY by the price list's kg/m. No kg/m → quantity blank and red, never guessed.
 *   - The enquiry's own figure is kept beside it ("2497 kg").
 *   - Lines asked in metres or pieces are left alone.
 *   - Angles, bars, plates, fittings … go under "Other items", never a pipe type.
 */

const QU = require('../utils/quantityUnits');
const fs = require('fs');
const path = require('path');

describe('convertKgQuantities', () => {
    const kgmOf = map => li => map[li.originalDescription];

    test('kg → metres by the price list kg/m, rounded to 2 places', () => {
        const lines = [{ originalDescription: 'A', quantity: '2,497' }];
        const out = QU.convertKgQuantities(lines, ['kg'], kgmOf({ A: 5.44 }));
        expect(lines[0].quantity).toBe('459.01');          // 2497 / 5.44
        expect(lines[0].enquiryQty).toBe('2497 kg');
        expect(lines[0].quantityMissing).toBeUndefined();
        expect(out).toEqual({ converted: 1, missing: 0 });
    });

    test('no kg/m in the price list → quantity blank and flagged, never 6 m', () => {
        const lines = [{ originalDescription: 'B', quantity: '876' }];
        const out = QU.convertKgQuantities(lines, ['KGS'], kgmOf({}));
        expect(lines[0].quantity).toBe('');
        expect(lines[0].quantityMissing).toBe(true);
        expect(lines[0].enquiryQty).toBe('876 kg');
        expect(out).toEqual({ converted: 0, missing: 1 });
    });

    test('a zero or unreadable kg figure is blank too', () => {
        const lines = [{ originalDescription: 'A', quantity: '0' }, { originalDescription: 'A', quantity: 'approx' }];
        QU.convertKgQuantities(lines, ['kg', 'kg'], kgmOf({ A: 5 }));
        expect(lines.map(l => l.quantity)).toEqual(['', '']);
        expect(lines.every(l => l.quantityMissing)).toBe(true);
    });

    test('lines asked in metres or pieces are untouched', () => {
        const lines = [{ originalDescription: 'A', quantity: '120' }, { originalDescription: 'A', quantity: '4' }];
        QU.convertKgQuantities(lines, ['m', 'nos'], kgmOf({ A: 5 }));
        expect(lines.map(l => l.quantity)).toEqual(['120', '4']);
        expect(lines.some(l => 'enquiryQty' in l)).toBe(false);
    });

    test('each line uses its OWN unit (units are matched by position)', () => {
        const lines = [{ originalDescription: 'A', quantity: '100' }, { originalDescription: 'A', quantity: '100' }];
        QU.convertKgQuantities(lines, ['m', 'kg'], kgmOf({ A: 4 }));
        expect(lines.map(l => l.quantity)).toEqual(['100', '25']);
    });
});

describe('keepMissingQuantitiesBlank', () => {
    test('after pricing, a missing quantity stays blank — not 0 — and has no total', () => {
        const lines = [{ quantityMissing: true, quantity: '0', lineTotal: '0' }, { quantity: '5', lineTotal: '1000' }];
        QU.keepMissingQuantitiesBlank(lines);
        expect(lines[0]).toMatchObject({ quantity: '', lineTotal: '' });
        expect(lines[1]).toMatchObject({ quantity: '5', lineTotal: '1000' });
    });
});

describe('normaliseUnit', () => {
    test.each([['KG', 'kg'], ['Kgs', 'kg'], ['kilograms', 'kg'], ['Mtrs', 'm'], ['metres', 'm'], ['RMT', 'm'],
        ['Nos', 'nos'], ['pcs', 'nos'], ['lengths', 'nos'], ['MT', ''], ['', ''], [null, '']])('%s → %s', (u, want) => {
        expect(QU.normaliseUnit(u)).toBe(want);
    });
});

describe('items that are not pipes', () => {
    test.each(['ISA 75x75x6', 'MS Square Bar 20mm', 'Round bar 25', 'MS Plate 10mm', 'ISMC 100', '2" Elbow', 'Flange 4"'])(
        '%s is not a pipe', d => expect(QU.isNonPipeItem(d)).toBe(true));

    test.each(['2" NB X Heavy -- ERW', '1-1/2" NB X Sch 40', 'GI Pipe 25 NB Medium', 'ERW pipe 50NB'])(
        '%s is a pipe', d => expect(QU.isNonPipeItem(d)).toBe(false));

    test('non-pipe lines move to "Other items"; pipes keep their type', () => {
        const lines = [
            { originalDescription: 'ISA 75x75x6', identifiedPipeType: 'MS ERW Pipe' },
            { originalDescription: '2" NB X Heavy -- ERW', identifiedPipeType: 'MS ERW Pipe' },
            { originalDescription: 'Square bar 20', identifiedPipeType: 'Other items' },
        ];
        expect(QU.markNonPipeItems(lines)).toBe(1);
        expect(lines.map(l => l.identifiedPipeType)).toEqual(['Other items', 'MS ERW Pipe', 'Other items']);
    });
});

describe('the AI is told the same rules, and the server applies them in order', () => {
    test('the prompt forbids the AI converting kg itself', () => {
        expect(QU.UNIT_AND_ITEM_RULES).toMatch(/NEVER convert kg to metres yourself/);
        expect(QU.UNIT_AND_ITEM_RULES).toMatch(/"Other items"/);
    });

    test('server.js converts kg BEFORE pricing and re-blanks missing quantities AFTER', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const iConvert = src.indexOf('convertKgQuantities(quotationData.lineItems');
        const iPrice = src.indexOf('await priceLinesFromPriceList(quotationData.lineItems)');
        const iBlank = src.indexOf('keepMissingQuantitiesBlank(quotationData.lineItems)');
        expect(iConvert).toBeGreaterThan(-1);
        expect(iPrice).toBeGreaterThan(iConvert);
        expect(iBlank).toBeGreaterThan(iPrice);
        expect(src).toMatch(/markNonPipeItems\(quotationData\.lineItems\)/);
    });
});
