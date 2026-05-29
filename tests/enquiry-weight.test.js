/**
 * Tests for:
 *  - weight-calculator.js  pure functions (CSV parsing, size key normalisation, kg/m lookup)
 *  - enquiry-preparer.js   pure functions (quotation normalisation, size/spec extraction, row model)
 *  - POST /api/extract-enquiry-items  (new lightweight enquiry endpoint)
 */

// ─── Mocks required so server.js loads without real cloud credentials ─────────
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
    ScanCommand: jest.fn(p => ({ _type: 'Scan', ...p })),
    GetCommand: jest.fn(p => ({ _type: 'Get', ...p })),
    PutCommand: jest.fn(p => ({ _type: 'Put', ...p })),
    QueryCommand: jest.fn(p => ({ _type: 'Query', ...p })),
    UpdateCommand: jest.fn(p => ({ _type: 'Update', ...p })),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({
    Storage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })),
}));
const mockOpenAICreate = jest.fn();
jest.mock('openai', () =>
    jest.fn(() => ({
        files: { create: jest.fn() },
        responses: { create: mockOpenAICreate },
        chat: { completions: { create: jest.fn() } },
    }))
);

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-key';
process.env.DYNAMODB_TABLE = 'test-table';
process.env.AWS_S3_BUCKET_NAME = '';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.GOOGLE_CLOUD_BUCKET_NAME = '';

const request = require('supertest');
const app = require('../server');
const { _test: weight } = require('../weight-calculator');
const { _test: enquiry } = require('../enquiry-preparer');

beforeEach(() => jest.clearAllMocks());

// =============================================================================
// weight-calculator: normalizeSizeKey
// =============================================================================
describe('weight-calculator: normalizeSizeKey', () => {
    test('lowercases and trims whitespace', () => {
        expect(weight.normalizeSizeKey('  6" NB  ')).toBe('6" nb');
    });

    test('collapses multiple spaces to one', () => {
        expect(weight.normalizeSizeKey('6"  NB')).toBe('6" nb');
    });

    test('returns empty string for empty input', () => {
        expect(weight.normalizeSizeKey('')).toBe('');
    });

    test('returns empty string for null / undefined', () => {
        expect(weight.normalizeSizeKey(null)).toBe('');
        expect(weight.normalizeSizeKey(undefined)).toBe('');
    });
});

// =============================================================================
// weight-calculator: parsePipeWeightCsv
// =============================================================================
describe('weight-calculator: parsePipeWeightCsv', () => {
    test('parses a simple two-column CSV', () => {
        const csv = '6" NB, 28.26\n4" NB, 14.04';
        const map = weight.parsePipeWeightCsv(csv);
        expect(map['6" nb']).toBeCloseTo(28.26);
        expect(map['4" nb']).toBeCloseTo(14.04);
    });

    test('skips blank lines', () => {
        const csv = '6" NB, 28.26\n\n4" NB, 14.04\n';
        const map = weight.parsePipeWeightCsv(csv);
        expect(Object.keys(map).length).toBe(2);
    });

    test('skips comment lines starting with #', () => {
        const csv = '# size,kg/m\n6" NB, 28.26';
        const map = weight.parsePipeWeightCsv(csv);
        expect(Object.keys(map).length).toBe(1);
    });

    test('skips rows with non-numeric weight', () => {
        const csv = '6" NB, N/A\n4" NB, 14.04';
        const map = weight.parsePipeWeightCsv(csv);
        expect(map['6" nb']).toBeUndefined();
        expect(map['4" nb']).toBeCloseTo(14.04);
    });

    test('returns empty map for empty input', () => {
        expect(weight.parsePipeWeightCsv('')).toEqual({});
    });

    test('normalises key casing', () => {
        const csv = '6" NB, 28.26';
        const map = weight.parsePipeWeightCsv(csv);
        expect(map['6" nb']).toBeCloseTo(28.26);
    });
});

// =============================================================================
// weight-calculator: parseNumber
// =============================================================================
describe('weight-calculator: parseNumber', () => {
    test('parses a plain decimal string', () => {
        expect(weight.parseNumber('28.26')).toBeCloseTo(28.26);
    });

    test('strips commas from thousands separators', () => {
        expect(weight.parseNumber('1,234.5')).toBeCloseTo(1234.5);
    });

    test('returns NaN for non-numeric strings', () => {
        expect(Number.isFinite(weight.parseNumber('N/A'))).toBe(false);
        expect(Number.isFinite(weight.parseNumber(''))).toBe(false);
    });

    test('returns NaN for null / undefined', () => {
        expect(Number.isFinite(weight.parseNumber(null))).toBe(false);
        expect(Number.isFinite(weight.parseNumber(undefined))).toBe(false);
    });

    test('parses a numeric value directly', () => {
        expect(weight.parseNumber(42)).toBeCloseTo(42);
    });
});

// =============================================================================
// weight-calculator: makeResolveKgPerMeter
// =============================================================================
describe('weight-calculator: makeResolveKgPerMeter', () => {
    const map = { '6" nb': 28.26, '4" nb': 14.04 };
    const resolve = weight.makeResolveKgPerMeter(map);

    test('returns value from map when item has no direct weight', () => {
        expect(resolve({}, '6" nb')).toBeCloseTo(28.26);
    });

    test('returns undefined for unknown size key', () => {
        expect(resolve({}, '99" nb')).toBeUndefined();
    });

    test('prefers kgPerMeter field on the item over map lookup', () => {
        expect(resolve({ kgPerMeter: 99.9 }, '6" nb')).toBeCloseTo(99.9);
    });

    test('prefers kg_per_meter alias', () => {
        expect(resolve({ kg_per_meter: 55.5 }, '6" nb')).toBeCloseTo(55.5);
    });

    test('ignores non-finite item weight and falls back to map', () => {
        expect(resolve({ kgPerMeter: 'N/A' }, '6" nb')).toBeCloseTo(28.26);
    });
});

// =============================================================================
// enquiry-preparer: extractSizeFromDescription
// =============================================================================
describe('enquiry-preparer: extractSizeFromDescription', () => {
    test('extracts inch × mm wall-thickness pattern', () => {
        expect(enquiry.extractSizeFromDescription('6" X 6.35 MM ERW Pipe'))
            .toBe('6" X 6.35 MM');
    });

    test('is case-insensitive for the × separator', () => {
        expect(enquiry.extractSizeFromDescription('8" x 8.18 mm Seamless'))
            .toBe('8" X 8.18 MM');
    });

    test('returns first line when no inch-mm pattern found', () => {
        expect(enquiry.extractSizeFromDescription('Checkered Plate\n3X4'))
            .toBe('Checkered Plate');
    });

    test('returns empty string for empty input', () => {
        expect(enquiry.extractSizeFromDescription('')).toBe('');
    });

    test('returns empty string for null', () => {
        expect(enquiry.extractSizeFromDescription(null)).toBe('');
    });
});

// =============================================================================
// enquiry-preparer: inferProductSpecFromText
// =============================================================================
describe('enquiry-preparer: inferProductSpecFromText', () => {
    test('extracts IS standard', () => {
        expect(enquiry.inferProductSpecFromText('ERW Pipe IS:1239 Grade B'))
            .toContain('IS 1239');
    });

    test('extracts API 5L standard', () => {
        expect(enquiry.inferProductSpecFromText('Line Pipe API 5L Grade X42'))
            .toContain('API 5L');
    });

    test('extracts ASTM standard', () => {
        expect(enquiry.inferProductSpecFromText('ASTM A106 Grade B pipe'))
            .toContain('ASTM A106');
    });

    test('extracts grade token (GR.)', () => {
        expect(enquiry.inferProductSpecFromText('Pipe Grade B'))
            .toContain('GR. B');
    });

    test('extracts PSL level', () => {
        const result = enquiry.inferProductSpecFromText('API 5L PSL2 X52');
        expect(result).toContain('PSL2');
    });

    test('returns empty string when no standards or grades found', () => {
        expect(enquiry.inferProductSpecFromText('Checkered Plate 3X4')).toBe('');
        expect(enquiry.inferProductSpecFromText('')).toBe('');
    });
});

// =============================================================================
// enquiry-preparer: normalizeQuotation
// =============================================================================
describe('enquiry-preparer: normalizeQuotation', () => {
    test('returns null for null input', () => {
        expect(enquiry.normalizeQuotation(null)).toBeNull();
    });

    test('returns null for non-object input', () => {
        expect(enquiry.normalizeQuotation('string')).toBeNull();
        expect(enquiry.normalizeQuotation(42)).toBeNull();
    });

    test('normalises a standard quotation', () => {
        const result = enquiry.normalizeQuotation({
            quoteNumber: 'Q-001',
            customerName: 'Test Co',
            lineItems: [
                { originalDescription: '6" NB ERW Pipe', quantity: '100', unit: 'MTRS' }
            ]
        });
        expect(result.quoteNumber).toBe('Q-001');
        expect(result.customerName).toBe('Test Co');
        expect(result.lineItems).toHaveLength(1);
        expect(result.lineItems[0].description).toBe('6" NB ERW Pipe');
        expect(result.lineItems[0].quantity).toBe('100');
        expect(result.lineItems[0].unit).toBe('MTRS');
    });

    test('filters out items with neither description nor quantity', () => {
        const result = enquiry.normalizeQuotation({
            lineItems: [
                { originalDescription: '', quantity: '' },
                { originalDescription: 'Pipe', quantity: '10' }
            ]
        });
        expect(result.lineItems).toHaveLength(1);
    });

    test('passes through AI-extracted productSpec and size', () => {
        const result = enquiry.normalizeQuotation({
            lineItems: [{
                originalDescription: '3X4 Checkered Plate',
                productSpec: 'Checkered Plate',
                size: '3X4',
                quantity: '50',
                unit: 'MTRS'
            }]
        });
        expect(result.lineItems[0].productSpec).toBe('Checkered Plate');
        expect(result.lineItems[0].size).toBe('3X4');
    });

    test('falls back to identifiedPipeType when productSpec absent', () => {
        const result = enquiry.normalizeQuotation({
            lineItems: [{
                originalDescription: '6" ERW',
                identifiedPipeType: 'ERW Pipe IS:1239',
                quantity: '10'
            }]
        });
        expect(result.lineItems[0].productSpec).toBe('ERW Pipe IS:1239');
    });

    test('reads quoteNumber from nested header', () => {
        const result = enquiry.normalizeQuotation({
            header: { quoteNumber: 'Q-999', billTo: 'Acme' }
        });
        expect(result.quoteNumber).toBe('Q-999');
        expect(result.customerName).toBe('Acme');
    });

    test('returns empty lineItems array when none provided', () => {
        const result = enquiry.normalizeQuotation({ quoteNumber: 'Q-001' });
        expect(result.lineItems).toEqual([]);
    });
});

// =============================================================================
// enquiry-preparer: buildEnquiryRowModel
// =============================================================================
describe('enquiry-preparer: buildEnquiryRowModel', () => {
    test('uses AI-extracted size and productSpec directly', () => {
        const model = enquiry.buildEnquiryRowModel({
            description: '3X4 Checkered Plate 100 MTRS',
            productSpec: 'Checkered Plate',
            size: '3X4',
            quantity: '100',
            unit: 'MTRS'
        });
        expect(model.productSpec).toBe('Checkered Plate');
        expect(model.size).toBe('3X4');
        expect(model.qty).toBe('100');
        expect(model.uom).toBe('MTRS');
    });

    test('falls back to description when size not provided', () => {
        const model = enquiry.buildEnquiryRowModel({
            description: 'MS Angle',
            quantity: '20'
        });
        expect(model.size).toBe('MS Angle');
    });

    test('infers spec from standards in description when productSpec absent', () => {
        const model = enquiry.buildEnquiryRowModel({
            description: 'ERW Pipe IS:1239 Grade B',
            quantity: '100'
        });
        expect(model.productSpec).toContain('IS 1239');
    });

    test('defaults UOM and make to empty string (no defaults)', () => {
        const model = enquiry.buildEnquiryRowModel(null);
        expect(model.uom).toBe('');
        expect(model.makeRequiredByUs).toBe('');
    });

    test('uses unit from fromLineItem', () => {
        const model = enquiry.buildEnquiryRowModel({
            description: 'Pipe',
            quantity: '5',
            unit: 'NOS'
        });
        expect(model.uom).toBe('NOS');
    });
});

// =============================================================================
// POST /api/extract-enquiry-items
// =============================================================================
describe('POST /api/extract-enquiry-items', () => {
    const fakeAIResponse = {
        output_text: JSON.stringify({
            lineItems: [
                {
                    originalDescription: '3X4 Checkered Plate',
                    productSpec: 'Checkered Plate',
                    size: '3X4',
                    quantity: '50',
                    unit: 'MTRS'
                },
                {
                    originalDescription: '6" NB ERW Pipe IS:1239 Gr B',
                    productSpec: 'ERW Pipe IS:1239 Gr B',
                    size: '6" NB',
                    quantity: '200',
                    unit: 'MTRS'
                }
            ]
        })
    };

    test('returns 400 when no content is provided', async () => {
        const res = await request(app)
            .post('/api/extract-enquiry-items')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    test('calls OpenAI and returns line items', async () => {
        mockOpenAICreate.mockResolvedValueOnce(fakeAIResponse);

        const res = await request(app)
            .post('/api/extract-enquiry-items')
            .field('emailContent', '3X4 Checkered Plate 50 MTRS\n6" NB ERW Pipe IS:1239 Gr B 200 MTRS');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.lineItems)).toBe(true);
        expect(res.body.lineItems).toHaveLength(2);
        expect(res.body.lineItems[0].productSpec).toBe('Checkered Plate');
        expect(res.body.lineItems[0].size).toBe('3X4');
        expect(res.body.lineItems[1].productSpec).toBe('ERW Pipe IS:1239 Gr B');
    });

    test('returns 500 when OpenAI throws', async () => {
        mockOpenAICreate.mockRejectedValueOnce(new Error('OpenAI unavailable'));

        const res = await request(app)
            .post('/api/extract-enquiry-items')
            .field('emailContent', 'Some pipe enquiry');

        expect(res.status).toBe(500);
        expect(res.body.error).toBeDefined();
    });

    test('handles malformed AI JSON gracefully via regex fallback', async () => {
        mockOpenAICreate.mockResolvedValueOnce({
            output_text: 'Here is the result: {"lineItems":[{"originalDescription":"Plate","productSpec":"Plate","size":"3X4","quantity":"10","unit":"NOS"}]}'
        });

        const res = await request(app)
            .post('/api/extract-enquiry-items')
            .field('emailContent', 'Plate 3X4 10 NOS');

        expect(res.status).toBe(200);
        expect(res.body.lineItems).toHaveLength(1);
    });
});
