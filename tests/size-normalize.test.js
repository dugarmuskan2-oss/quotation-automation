/**
 * @jest-environment node
 *
 * tests/size-normalize.test.js
 *
 * utils/sizeNormalize.js — sizes the AI left in millimetres, and XXS written so it reads as XS.
 * Cases are the staff corrections of 14–16 Oct 2026 (DSC-2958, 2936, 2944, 2938).
 */

const fs = require('fs');
const path = require('path');
const N = require('../utils/sizeNormalize');
const { ENQUIRY_READING_RULES } = require('../utils/enquiryReading');
const { parseDescription } = require('../utils/pipeWeights');

const run = (descs, text) => {
    const lines = descs.map(d => ({ originalDescription: d }));
    const r = N.normalizeLineSizes(lines, text || '');
    return { r, out: lines.map(l => l.originalDescription), lines };
};

describe('a size written in mm becomes inches', () => {
    test('NB in mm: "NB 40 * SCH 160" written 40X160 is 1-1/2" (DSC-2958)', () => {
        const { out, lines } = run(['40X160', '50X160', '100X120', '200X40', '150X40']);
        expect(out).toEqual(['11/2X160', '2X160', '4X120', '8X40', '6X40']);
        expect(lines[0].enquirySize).toBe('NB 40 mm');
    });
    test('OD in mm: "OD 48 mm x 4" written 48X4 is 1-1/2" (DSC-2936)', () => {
        const { out, lines } = run(['48X4', '60.3X5.54', '27X3.50MM']);
        expect(out).toEqual(['11/2X4', '2X5.54', '3/4X3.50MM']);
        expect(lines[0].enquirySize).toBe('OD 48 mm');
    });
    test('the nearest OD wins: 33.4 is 1", 42.2 is 1-1/4"', () => {
        expect(N.inchFromMm('33.4').inch).toBe('1');
        expect(N.inchFromMm('42.2').inch).toBe('11/4');
    });
    test('NB is tried before OD: 32 is 1-1/4" (32 NB), not 1" (33.4 OD)', () => {
        expect(N.inchFromMm('32').inch).toBe('11/4');
    });
    test('a size that may be inches is left alone (20, 10, 12, 22, 1/2, 11/2)', () => {
        // 22 is within 1 mm of the 1/2" OD (21.3), and is still a 22" pipe.
        const { out, r } = run(['20X160', '10X40', '12X2.5', '22X20', '1/2X80', '11/2X80']);
        expect(out).toEqual(['20X160', '10X40', '12X2.5', '22X20', '1/2X80', '11/2X80']);
        expect(r.mmToInch).toBe(0);
    });
    test('a mm figure matching no NB and no OD is not guessed (38 stays 38)', () => {
        expect(run(['38X4']).out).toEqual(['38X4']);
        expect(N.inchFromMm('45')).toBeNull();      // 42.4 and 48.3 are both more than 1 mm away
    });
    test('the converted size is what the price lookup reads', () => {
        const { out } = run(['40X160']);
        expect(parseDescription(out[0])).toEqual({ size: '11/2', cls: '160' });
    });
});

describe('XXS is not read as XS', () => {
    test('"1/2XXS" becomes "1/2XXXS" when the enquiry only says XXS (DSC-2938)', () => {
        const { out, r } = run(['1/2XXS', '3/4XXS', '2XXXS'], 'REV.A,33,PIPE,0.5,,S-XXS,,,CS A106-B SMLS');
        expect(out).toEqual(['1/2XXXS', '3/4XXXS', '2XXXS']);
        expect(r.xxs).toBe(2);
        expect(parseDescription(out[0]).cls).toBe('XXS');
    });
    test('when the enquiry says XS anywhere, "1/2XXS" is left as XS', () => {
        expect(run(['1/2XXS'], '1/2" SCH XS 10 m, 2" SCH XXS 5 m').out).toEqual(['1/2XXS']);
    });
    test('no XXS in the enquiry → left as XS', () => {
        expect(run(['1/2XXS'], '1/2 inch XS pipe').out).toEqual(['1/2XXS']);
        expect(N.enquiryMeansXxs('')).toBe(false);
    });
});

describe('the AI is told, and the server applies it before walls and prices', () => {
    test('prompt rules: sizes in inches, XXS written with three X', () => {
        expect(ENQUIRY_READING_RULES).toMatch(/always the NOMINAL size in INCHES/);
        expect(ENQUIRY_READING_RULES).toMatch(/XXS is written "1\/2XXXS"/);
    });
    test('server.js order: sizes → walls → prices', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const a = src.indexOf('normalizeLineSizes(quotationData.lineItems, enquiryText)');
        const b = src.indexOf('await setSchedulesFromEnquiryWalls(quotationData.lineItems');
        const c = src.indexOf('await priceLinesFromPriceList(quotationData.lineItems)');
        expect(a).toBeGreaterThan(-1);
        expect(b).toBeGreaterThan(a);
        expect(c).toBeGreaterThan(b);
    });
});

describe('STD / XS on small seamless sizes read as Sch 40 / Sch 80', () => {
    const run2 = (rows, text) => {
        const lines = rows.map(([d, t]) => ({ originalDescription: d, identifiedPipeType: t || 'Seamless' }));
        const r = N.normalizeLineSizes(lines, text || '');
        return { r, out: lines.map(l => l.originalDescription) };
    };
    test('STD up to 10" is Sch 40; XS up to 8" is Sch 80 (DSC-2938)', () => {
        const { out, r } = run2([['3XSTD'], ['10XSTD'], ['1XXS'], ['8XXS'], ['11/2XXS']]);
        expect(out).toEqual(['3X40', '10X40', '1X80', '8X80', '11/2X80']);
        expect(r.stdXs).toBe(5);
    });
    test('above those sizes they are different pipes and are left alone', () => {
        expect(run2([['12XSTD'], ['10XXS'], ['14XSTD']]).out).toEqual(['12XSTD', '10XXS', '14XSTD']);
    });
    test('XXS is never turned into Sch 80', () => {
        expect(run2([['1XXXS'], ['1/2XXS']], 'S-XXS only').out).toEqual(['1XXXS', '1/2XXXS']);
    });
    test('only seamless lines — an ERW "STD" is left for staff', () => {
        expect(run2([['4XSTD', 'ERW']]).out).toEqual(['4XSTD']);
    });
    test('SMLS counts as seamless in the pipe-type rule', () => {
        expect(ENQUIRY_READING_RULES).toMatch(/abbreviations: SMLS/);
    });
});
