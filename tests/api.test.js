/**
 * Functional (API) tests — sends real HTTP requests to the Express app
 * and checks the responses. External services (DynamoDB, OpenAI) are
 * replaced with fakes so no real credentials are needed.
 */

// ─── Mock external services BEFORE loading the app ───────────────────────────

// Fake DynamoDB client — we control what it returns in each test
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
    ScanCommand: jest.fn(params => ({ _type: 'Scan', ...params })),
    GetCommand: jest.fn(params => ({ _type: 'Get', ...params })),
    PutCommand: jest.fn(params => ({ _type: 'Put', ...params })),
    QueryCommand: jest.fn(params => ({ _type: 'Query', ...params })),
    UpdateCommand: jest.fn(params => ({ _type: 'Update', ...params })),
}));

// Fake S3 / GCS — not used in these tests
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({
    Storage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })),
}));

// Fake OpenAI — returns a canned quotation JSON response
const mockOpenAICreate = jest.fn();
jest.mock('openai', () =>
    jest.fn(() => ({
        files: { create: jest.fn() },
        responses: { create: mockOpenAICreate },
        chat: { completions: { create: jest.fn() } },
    }))
);

// Set required env vars before the server module loads.
// Override anything that might come from .env so no real cloud services are used.
process.env.NODE_ENV = 'test';          // prevents server from binding to a port
process.env.OPENAI_API_KEY = 'test-key';
process.env.DYNAMODB_TABLE = 'test-table';
process.env.AWS_S3_BUCKET_NAME = '';    // disable S3 so loadRateIndex falls back to local file
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.GOOGLE_CLOUD_BUCKET_NAME = ''; // disable GCS too

const request = require('supertest');
const app = require('../server');

// ─── Helper: a minimal DynamoDB item that looks like a saved quotation ────────
function fakeDdbQuotation(overrides = {}) {
    return {
        id: 'test-id-001',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        payload: {
            customerName: 'Test Customer',
            quoteNumber: 'Q-001',
            lineItems: [],
        },
        ...overrides,
    };
}

// Reset mock call counts between tests
beforeEach(() => {
    jest.clearAllMocks();
});

// =============================================================================
// GET /api/health
// =============================================================================
describe('GET /api/health', () => {
    test('returns 200 and status ok', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });
});

// =============================================================================
// GET /api/quotations
// =============================================================================
describe('GET /api/quotations', () => {
    test('returns a list of quotations', async () => {
        // DynamoDB scan returns one page with two items
        mockDdbSend.mockResolvedValueOnce({
            Items: [fakeDdbQuotation(), fakeDdbQuotation({ id: 'test-id-002', payload: { customerName: 'Another Customer', quoteNumber: 'Q-002', lineItems: [] } })],
            LastEvaluatedKey: null,
        });

        const res = await request(app).get('/api/quotations');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.quotations)).toBe(true);
        expect(res.body.quotations.length).toBe(2);
        expect(res.body.total).toBe(2);
    });

    test('respects limit and offset query params', async () => {
        // Return 5 items from DynamoDB
        const items = Array.from({ length: 5 }, (_, i) =>
            fakeDdbQuotation({ id: `id-${i}`, payload: { customerName: `Customer ${i}`, quoteNumber: `Q-00${i}`, lineItems: [] } })
        );
        mockDdbSend.mockResolvedValueOnce({ Items: items, LastEvaluatedKey: null });

        // Ask for 2 items starting at offset 2
        const res = await request(app).get('/api/quotations?limit=2&offset=2');
        expect(res.status).toBe(200);
        expect(res.body.quotations.length).toBe(2);
        expect(res.body.total).toBe(5);
        expect(res.body.hasMore).toBe(true);
    });

    test('returns empty list when no quotations exist', async () => {
        mockDdbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: null });

        const res = await request(app).get('/api/quotations');
        expect(res.status).toBe(200);
        expect(res.body.quotations).toEqual([]);
        expect(res.body.total).toBe(0);
        expect(res.body.hasMore).toBe(false);
    });

    test('returns 500 when DynamoDB throws an error', async () => {
        mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB connection failed'));

        const res = await request(app).get('/api/quotations');
        expect(res.status).toBe(500);
        expect(res.body.error).toBeDefined();
    });
});

// =============================================================================
// GET /api/quotations/:id
// =============================================================================
describe('GET /api/quotations/:id', () => {
    test('returns a quotation by ID', async () => {
        mockDdbSend.mockResolvedValueOnce({ Item: fakeDdbQuotation() });

        const res = await request(app).get('/api/quotations/test-id-001');
        expect(res.status).toBe(200);
        // Route wraps the result in { quotation: {...} }
        expect(res.body.quotation.id).toBe('test-id-001');
        expect(res.body.quotation.customerName).toBe('Test Customer');
    });

    test('returns 404 when quotation does not exist', async () => {
        mockDdbSend.mockResolvedValueOnce({ Item: null });

        const res = await request(app).get('/api/quotations/nonexistent-id');
        expect(res.status).toBe(404);
    });
});

// =============================================================================
// POST /api/generate-quotation
// =============================================================================
describe('POST /api/generate-quotation', () => {
    // A valid OpenAI response — output_text is the first format the server checks
    const fakeOpenAIResponse = {
        output_text: JSON.stringify({
            customerName: 'Test Customer',
            companyName: 'Test Co',
            lineItems: [{ originalDescription: '6" pipe', quantity: '10', unitRate: '50' }],
        })
    };

    test('returns 400 when no content is provided', async () => {
        const res = await request(app)
            .post('/api/generate-quotation')
            .send({ instructions: 'Use standard margins' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no content/i);
    });

    test('returns 400 when no instructions are provided', async () => {
        const res = await request(app)
            .post('/api/generate-quotation')
            .send({ emailContent: 'Please quote for 10x 6" pipes' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no instructions/i);
    });

    test('returns 400 when instructions are empty string', async () => {
        const res = await request(app)
            .post('/api/generate-quotation')
            .send({ emailContent: 'Please quote for 10x 6" pipes', instructions: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no instructions/i);
    });

    test('calls OpenAI and returns quotation data when valid input is given', async () => {
        // OpenAI returns a canned quotation response
        mockOpenAICreate.mockResolvedValueOnce(fakeOpenAIResponse);

        const res = await request(app)
            .post('/api/generate-quotation')
            .send({
                emailContent: 'Please quote for 10x 6" pipes',
                instructions: 'Use standard margins of 15%',
            });

        expect(res.status).toBe(200);
        expect(res.body.customerName).toBe('Test Customer');
        expect(Array.isArray(res.body.lineItems)).toBe(true);
    });
});

// =============================================================================
// POST /api/save-quotation
// =============================================================================
describe('POST /api/save-quotation', () => {
    test('returns 400 when no quotation data is provided', async () => {
        const res = await request(app).post('/api/save-quotation').send({});
        expect(res.status).toBe(400);
    });

    test('saves quotation and returns success', async () => {
        mockDdbSend.mockResolvedValueOnce({}); // PutCommand success

        // The route expects { quotation: { id, ... } } — not a flat body
        const res = await request(app)
            .post('/api/save-quotation')
            .send({
                quotation: {
                    id: 'test-id-001',
                    customerName: 'Test Customer',
                    quoteNumber: 'Q-001',
                    lineItems: [],
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('returns 500 when DynamoDB throws an error', async () => {
        mockDdbSend.mockRejectedValueOnce(new Error('Write failed'));

        const res = await request(app)
            .post('/api/save-quotation')
            .send({ quotation: { id: 'x', customerName: 'Test', quoteNumber: 'Q-001', lineItems: [] } });

        expect(res.status).toBe(500);
    });
});

// =============================================================================
// Unknown routes
// =============================================================================
describe('Unknown routes', () => {
    test('returns 404 for undefined routes', async () => {
        const res = await request(app).get('/api/does-not-exist');
        expect(res.status).toBe(404);
    });
});
