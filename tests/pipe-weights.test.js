/**
 * @jest-environment node
 *
 * tests/pipe-weights.test.js
 *
 * Pipe-weight lookup module (utils/pipeWeights.js). CommonJS — required directly.
 * These tests EXECUTE the real module against inline fixtures with real known
 * kg/m values (no inline copy of the logic under test). The only string-match
 * block is the small source-guard on routes/rates.js at the very bottom, for the
 * wiring (require + SPREADSHEET_EXTS + the /pipe-weights route) that can't run here.
 */

const fs = require('fs');
const path = require('path');

const PW = require('../utils/pipeWeights');
const { normSize, normClass, weightKey, findCol } = PW._test;

// ── Inline fixtures (real-shaped price-list rows; real kg/m values) ────────────

// Seamless list: size comes from Inch, class from SCH, kg/m from the KG/MTR column.
// The raw "Size" column holds opaque codes (S1/S2/S3) that must NOT be used as size.
const SEAMLESS_ROWS = [
    ['Size', 'Inch', 'NB', 'OD', 'SCH', 'Thickness', 'Price/M', 'Price/KG', 'KG/MTR'],
    ['S1', '2"', '50', '60.3', 'SCH40', '3.91', '100', '50', '5.44'],
    ['S2', '2"', '50', '60.3', 'SCH80', '5.54', '120', '55', '7.48'],
    ['S3', '1/2"', '15', '21.3', 'SCH80', '3.73', '80', '40', '1.62'],
];

// GI list: class from Light/Medium/Heavy. Note the 1" Heavy row's Size code is the
// odd "1XHY" — keying off Inch+Class must bypass that quirk. Rows with a blank / zero
// / negative kg/m must be skipped entirely.
const GI_ROWS = [
    ['Size', 'Inch', 'NB', 'OD', 'Light/Medium/Heavy', 'Wall', 'Cost/Meter', 'Price', 'KG/MTR'],
    ['1XHY', '1"', '25', '33.7', 'Heavy', '4.05', '90', '45', '2.93'],
    ['G2', '2"', '50', '60.3', 'Heavy', '4.50', '110', '55', '6.19'],
    ['G3', '2-1/2"', '65', '76.1', 'Medium', '3.65', '130', '60', '6.42'],
    ['G4', '3"', '80', '88.9', 'Heavy', '4.05', '140', '65', ''],    // blank kg/m -> skip
    ['G5', '4"', '100', '114.3', 'Heavy', '4.50', '160', '70', '0'], // zero -> skip
    ['G6', '5"', '125', '141.3', 'Heavy', '4.85', '180', '75', '-4'],// negative -> skip
    ['', '', '', '', '', '', '', '', ''],                            // blank size -> skip
];

const ERW_ROWS = [
    ['Inch', 'Light/Medium/Heavy', 'KG/MTR'],
    ['2"', 'Medium', '5.41'],
];

describe('parseCsv — quoted fields, embedded commas, doubled quotes, CRLF/LF', () => {
    test('handles embedded commas, doubled "" quotes, and CRLF rows', () => {
        // Field with a doubled inch quote + parenthetical, a size that ends in ",
        // and a thousands value that contains a comma — all inside quotes.
        const csv =
            'Size,Inch,Price\r\n' +
            '"31/2"" X 80 (X)","3-1/2""","60,600"\r\n' +
            'A,2,100';
        const rows = PW.parseCsv(csv);
        expect(rows).toEqual([
            ['Size', 'Inch', 'Price'],
            ['31/2" X 80 (X)', '3-1/2"', '60,600'],
            ['A', '2', '100'],
        ]);
        // The embedded comma must stay inside its field, not split it.
        expect(rows[1][2]).toBe('60,600');
        expect(rows[1]).toHaveLength(3);
        // Doubled "" collapses to a single literal quote.
        expect(rows[1][1]).toBe('3-1/2"');
        expect(rows[1][1]).not.toContain('""');
    });

    test('LF and CRLF line endings parse identically', () => {
        const lf = PW.parseCsv('a,b\nc,d');
        const crlf = PW.parseCsv('a,b\r\nc,d\r\n');
        expect(lf).toEqual([['a', 'b'], ['c', 'd']]);
        expect(crlf).toEqual(lf);
        // A trailing CRLF must NOT emit a spurious empty row.
        expect(crlf).toHaveLength(2);
    });

    test('a single field with no trailing newline is still captured', () => {
        expect(PW.parseCsv('a')).toEqual([['a']]);
    });

    test('null / empty input -> no rows', () => {
        expect(PW.parseCsv(null)).toEqual([]);
        expect(PW.parseCsv('')).toEqual([]);
    });
});

describe('buildWeightMap — seamless list (size=Inch, class=SCH, kg=KG/MTR)', () => {
    const map = PW.buildWeightMap(SEAMLESS_ROWS);

    test('keys on Inch+SCH with real kg/m values', () => {
        expect(map['2|40']).toBe(5.44);
        expect(map['2|80']).toBe(7.48);
        expect(map['1/2|80']).toBe(1.62);
    });

    test('only the three data rows are indexed (Size codes never leak in as keys)', () => {
        expect(Object.keys(map).sort()).toEqual(['1/2|80', '2|40', '2|80']);
        expect(map).not.toHaveProperty('s1|40'); // raw "Size" code must not become a key
    });
});

describe('buildWeightMap — GI list (class=Light/Medium/Heavy) + the 1XHY quirk', () => {
    const map = PW.buildWeightMap(GI_ROWS);

    test('keys on Inch+Class with real kg/m values', () => {
        expect(map['2|h']).toBe(6.19);
        expect(map['21/2|m']).toBe(6.42);
    });

    test('the 1" Heavy row is indexed by Inch+Class, not its "1XHY" Size code', () => {
        expect(map['1|h']).toBe(2.93);
        expect(map).not.toHaveProperty('1xhy|h');
    });

    test('rows with blank / zero / negative kg/m are skipped', () => {
        expect(map).not.toHaveProperty('3|h'); // blank kg/m
        expect(map).not.toHaveProperty('4|h'); // 0
        expect(map).not.toHaveProperty('5|h'); // -4
        // exactly the three valid rows survive
        expect(Object.keys(map)).toHaveLength(3);
    });

    test('the all-blank trailing row (blank size) is skipped', () => {
        expect(map).not.toHaveProperty('|h');
        expect(map).not.toHaveProperty('|');
    });
});

describe('buildWeightMap — "no KG header" falls back to the LAST column', () => {
    test('uses the last column for kg/m, not an earlier numeric (Price) column', () => {
        const rows = [
            ['Inch', 'Class', 'Price', 'Weight'], // no KG/MTR header
            ['2"', 'Heavy', '999', '6.19'],
        ];
        const map = PW.buildWeightMap(rows);
        expect(map['2|h']).toBe(6.19);   // last column
        expect(map['2|h']).not.toBe(999); // NOT the earlier Price column
    });

    test('parses comma-grouped kg/m numbers (strips thousands comma)', () => {
        const rows = [
            ['Inch', 'Class', 'KG/MTR'],
            ['20"', 'Heavy', '1,234.5'],
        ];
        expect(PW.buildWeightMap(rows)['20|h']).toBe(1234.5);
    });

    test('non-array / header-only input -> empty map', () => {
        expect(PW.buildWeightMap(null)).toEqual({});
        expect(PW.buildWeightMap([])).toEqual({});
        expect(PW.buildWeightMap([['Inch', 'Class', 'KG/MTR']])).toEqual({});
    });
});

describe('parseDescription — pull { size, cls } from a quote-line description', () => {
    test('"2" NB X SCH 40" -> size 2, cls 40', () => {
        expect(PW.parseDescription('2" NB X SCH 40')).toEqual({ size: '2', cls: '40' });
    });

    test('"2-1/2" NB X Heavy -- GI" -> size 2-1/2, cls heavy', () => {
        expect(PW.parseDescription('2-1/2" NB X Heavy -- GI')).toEqual({ size: '2-1/2', cls: 'heavy' });
    });

    test('"1/2" NB X Sch 80" -> size 1/2, cls 80', () => {
        expect(PW.parseDescription('1/2" NB X Sch 80')).toEqual({ size: '1/2', cls: '80' });
    });

    test('a description with no numeric size -> empty size', () => {
        expect(PW.parseDescription('NB X Heavy').size).toBe('');
    });
});

describe('lookupKgPerMeter — match a quote line to its list, or null', () => {
    const maps = {
        seamless: PW.buildWeightMap(SEAMLESS_ROWS),
        gi: PW.buildWeightMap(GI_ROWS),
        erw: PW.buildWeightMap(ERW_ROWS),
    };

    test('Seamless + "2" NB X SCH 40" -> 5.44', () => {
        expect(PW.lookupKgPerMeter(maps, 'Seamless', '2" NB X SCH 40')).toBe(5.44);
    });

    test('GI + "1" NB X Heavy -- GI" -> 2.93 (bypasses the "1XHY" Size code)', () => {
        // The sheet row for 1" Heavy has Size code "1XHY"; keying on Inch+Class still finds it.
        expect(PW.lookupKgPerMeter(maps, 'GI', '1" NB X Heavy -- GI')).toBe(2.93);
    });

    test('GI + "2" NB X Heavy -- GI" -> 6.19 and GI + Medium 2-1/2" -> 6.42', () => {
        expect(PW.lookupKgPerMeter(maps, 'GI', '2" NB X Heavy -- GI')).toBe(6.19);
        expect(PW.lookupKgPerMeter(maps, 'GI', '2-1/2" NB X Medium -- GI')).toBe(6.42);
    });

    test('ERW + "2" NB X Medium" -> 5.41', () => {
        expect(PW.lookupKgPerMeter(maps, 'ERW', '2" NB X Medium')).toBe(5.41);
    });

    test('a size not present in the sheet -> null', () => {
        expect(PW.lookupKgPerMeter(maps, 'Seamless', '8" NB X SCH 40')).toBeNull();
    });

    test('unknown pipe type or no size -> null (never throws)', () => {
        expect(PW.lookupKgPerMeter(maps, 'PVC', '2" NB X SCH 40')).toBeNull();
        expect(PW.lookupKgPerMeter(maps, 'GI', 'NB X Heavy')).toBeNull();
        expect(PW.lookupKgPerMeter(undefined, 'GI', '2" NB X Heavy')).toBeNull();
    });
});

describe('mapForPipeType — choose the right list by keyword in the type', () => {
    const maps = { seamless: { s: 1 }, gi: { g: 1 }, erw: { e: 1 } };

    test('picks by "seamless" / "erw" / "gi" (and "galvan")', () => {
        expect(PW.mapForPipeType(maps, 'Seamless Sch 40')).toBe(maps.seamless);
        expect(PW.mapForPipeType(maps, 'ERW Medium')).toBe(maps.erw);
        expect(PW.mapForPipeType(maps, 'GI')).toBe(maps.gi);
        expect(PW.mapForPipeType(maps, 'Galvanised iron')).toBe(maps.gi);
    });

    test('"seamless" is not misread as GI (order matters)', () => {
        expect(PW.mapForPipeType(maps, 'Seamless')).not.toBe(maps.gi);
    });

    test('unknown type -> null; missing list -> null', () => {
        expect(PW.mapForPipeType(maps, 'Copper')).toBeNull();
        expect(PW.mapForPipeType({}, 'GI')).toBeNull();
    });
});

describe('_test.normSize — compact size token', () => {
    test('"2-1/2" and "2 1/2" both collapse to "21/2"', () => {
        expect(normSize('2-1/2')).toBe('21/2');
        expect(normSize('2 1/2')).toBe('21/2');
    });

    test('strips ", inch, and nb noise', () => {
        expect(normSize('2"')).toBe('2');
        expect(normSize('2 inch')).toBe('2');
        expect(normSize('50 NB')).toBe('50');
        expect(normSize('nominal 1/2"')).toBe('1/2');
    });

    test('null-safe', () => {
        expect(normSize(null)).toBe('');
    });
});

describe('_test.normClass — canonical class token', () => {
    test.each([
        ['Heavy', 'h'],
        ['Medium', 'm'],
        ['Light', 'l'],
        ['SCH 40', '40'],
        ['40', '40'],
        ['SCH80', '80'],
        ['XXS', 'xxs'],
    ])('%s -> %s', (input, expected) => {
        expect(normClass(input)).toBe(expected);
    });

    test('Heavy and Medium never collide', () => {
        expect(normClass('Heavy')).not.toBe(normClass('Medium'));
    });
});

describe('_test.weightKey & findCol', () => {
    test('weightKey joins normalised size|class', () => {
        expect(weightKey('2"', 'SCH 40')).toBe('2|40');
        expect(weightKey('2-1/2', 'Heavy')).toBe('21/2|h');
    });

    test('findCol matches case/space-insensitively and returns -1 when absent', () => {
        expect(findCol([' Inch ', 'KG/MTR'], [/^inch$/])).toBe(0);
        expect(findCol(['Size', 'Inch', 'KG/MTR'], [/kg\s*\/?\s*(m|mtr|meter|metre)/])).toBe(2);
        expect(findCol(['Size', 'Weight'], [/kg\s*\/?\s*(m|mtr|meter|metre)/])).toBe(-1);
    });
});

// ── Source guard: the wiring in routes/rates.js that can't run headlessly ──────
describe('source guard — routes/rates.js wires up the weight sheet import', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'rates.js'), 'utf8');

    test('requires ../utils/pipeWeights (buildWeightMap + parseCsv)', () => {
        expect(src).toContain("require('../utils/pipeWeights')");
        expect(src).toContain('buildWeightMap');
        expect(src).toContain('parseCsv');
    });

    test('SPREADSHEET_EXTS covers .csv/.xlsx/.xls', () => {
        expect(src).toContain('SPREADSHEET_EXTS');
        expect(src).toContain("'.csv'");
        expect(src).toContain("'.xlsx'");
        expect(src).toContain("'.xls'");
    });

    test('registers a GET /pipe-weights route', () => {
        expect(src).toContain("router.get('/pipe-weights'");
    });
});

// ── The AI's own size format, and the large-bore rows ────────────────────────
// Two faults kept this lookup from ever firing on a real quote:
//   1. parseDescription only understood the DISPLAY form (`2" NB X Heavy`), but what it is
//      handed is the AI's own code (`2XH`, `8X6.35`). It matched nothing and nobody noticed,
//      because nothing called it.
//   2. Every 8"-and-up row keys to the same "8|" — those rows carry no class, only a wall
//      thickness — so all but the last silently overwrote each other.
describe('the AI\'s size format and the large-bore rows', () => {
    const PW2 = require('../utils/pipeWeights');

    // Exactly the column layout of the real ERW sheet, including the empty class cells.
    const SHEET = [
        'Size,Inch,NB,OD,Light/Medium/Heavy,Wall Thickness (mm),Cost/Meter,Price,KG/MTR',
        '2XH,2,50,60.3,Heavy,4.5,373,391,6.19',
        '21/2XH,2-1/2,65,76.1,Heavy,5,479,503,7.93',
        '5XH,5,125,139.7,Heavy,5.4,1078,1132,17.9',
        '6XH,6,150,165.1,Heavy,5.4,1284,1348,21.3',
        '8X4.8,8,200,219.1,,4.8,1496,1570,25.4',
        '8X6.0,8,200,219.1,,6,1902,1997,31.56',
        '8X6.35,8,200,219.1,,6.35,2070,2173,33.34',
        '10X6.35,10,250,273,,6.35,2614,2745,41.8',
    ].join('\n');
    const maps = { erw: PW2.buildWeightMap(PW2.parseCsv(SHEET)) };
    const kg = (d) => PW2.lookupKgPerMeter(maps, 'ERW', d);

    test('the three 8" rows are separate rows, not one', () => {
        expect(kg('8X4.8')).toBe(25.4);
        expect(kg('8X6.0')).toBe(31.56);
        expect(kg('8X6.35')).toBe(33.34);
    });

    test.each([
        ['2XH', 6.19], ['21/2XH', 7.93], ['5XH', 17.9], ['6XH', 21.3], ['10X6.35', 41.8],
    ])('the AI\'s own code %s resolves', (code, want) => {
        expect(kg(code)).toBe(want);
    });

    test.each([
        ['2" NB X Heavy -- ERW', 6.19],
        ['2-1/2" NB X Heavy -- ERW', 7.93],
        ['6" NB X HEAVY -- ERW', 21.3],
        ['8" NB X 6.35mm thk -- ERW', 33.34],
    ])('the display form %s resolves to the same row', (desc, want) => {
        expect(kg(desc)).toBe(want);
    });

    test('a size the sheet does not carry returns null — never a computed guess', () => {
        expect(kg('99XH')).toBeNull();
        expect(kg('3XH')).toBeNull();          // real size, absent from THIS cut of the sheet
    });

    describe('fillBlankKgPerMeter', () => {
        test('fills blanks, leaves supplied weights alone, and counts what it did', () => {
            const items = [
                { originalDescription: '6XH', identifiedPipeType: 'ERW', kgPerMeter: '' },
                { originalDescription: '8X6.35', identifiedPipeType: 'ERW', kgPerMeter: '' },
                { originalDescription: '2XH', identifiedPipeType: 'ERW', kgPerMeter: '6.19' },
                { originalDescription: '99XH', identifiedPipeType: 'ERW', kgPerMeter: '' },
            ];
            expect(PW2.fillBlankKgPerMeter(maps, items)).toEqual({ filled: 2, unknown: 1, alreadySet: 1 });
            expect(items[0].kgPerMeter).toBe('21.3');
            expect(items[1].kgPerMeter).toBe('33.34');
            expect(items[2].kgPerMeter).toBe('6.19');    // untouched
            expect(items[3].kgPerMeter).toBe('');        // still blank, so the app shows it red
        });

        test('a weight the AI already gave is never overwritten, even when the sheet disagrees', () => {
            const items = [{ originalDescription: '6XH', identifiedPipeType: 'ERW', kgPerMeter: '99' }];
            PW2.fillBlankKgPerMeter(maps, items);
            expect(items[0].kgPerMeter).toBe('99');
        });

        test('no table, or no items, changes nothing and never throws', () => {
            expect(PW2.fillBlankKgPerMeter(null, [{ kgPerMeter: '' }])).toEqual({ filled: 0, unknown: 0, alreadySet: 0 });
            expect(PW2.fillBlankKgPerMeter({}, [{ kgPerMeter: '' }])).toEqual({ filled: 0, unknown: 0, alreadySet: 0 });
            expect(PW2.fillBlankKgPerMeter(maps, null)).toEqual({ filled: 0, unknown: 0, alreadySet: 0 });
        });
    });
});
