/**
 * Functional test for the rate-file interleaving fix.
 *
 * THE BUG THIS GUARDS AGAINST: if all rate PDFs are attached to the OpenAI
 * request unlabeled and dumped at the end, GPT cannot tell them apart and
 * reads every rate from the first file — so GI items get ERW rates, seamless
 * items get 0, etc.
 *
 * THE CONTRACT: every rate file in the OpenAI request must be immediately
 * preceded by an input_text part naming its pipe type (GI / ERW / Seamless),
 * so GPT can associate each file's content with the correct type.
 *
 * This test captures the exact `input` array passed to openai.responses.create
 * and asserts that structure. If a future refactor reverts to dumping files
 * unlabeled at the end, this test fails.
 */

'use strict';

// ─── Mock external services BEFORE loading the app (mirrors api.test.js) ──────
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
    ScanCommand: jest.fn(), GetCommand: jest.fn(), PutCommand: jest.fn(),
    QueryCommand: jest.fn(), UpdateCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })) }));

const mockOpenAICreate = jest.fn();
jest.mock('openai', () => jest.fn(() => ({
    files: { create: jest.fn() },
    responses: { create: mockOpenAICreate },
    chat: { completions: { create: jest.fn() } },
})));

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-key';
process.env.DYNAMODB_TABLE = 'test-table';
process.env.AWS_S3_BUCKET_NAME = '';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.GOOGLE_CLOUD_BUCKET_NAME = '';

const request = require('supertest');
const app = require('../server');
const storage = require('../storage');

// Three rate files in the order the index returns them (ERW first — the file
// that previously "won" and supplied rates for everything).
const FAKE_MAPPINGS = [
    { openaiFileId: 'file-ERW', originalName: 'ERW Price List for Chat GPT.pdf', s3Key: 'rates/ERW Price List for Chat GPT.pdf' },
    { openaiFileId: 'file-GI',  originalName: 'GI Price List for CHAT GPT.pdf',  s3Key: 'rates/GI Price List for CHAT GPT.pdf' },
    { openaiFileId: 'file-SML', originalName: 'Seamless Price List for Chat GPT.pdf', s3Key: 'rates/Seamless Price List for Chat GPT.pdf' },
];

function getUserContent() {
    // The single call to openai.responses.create
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    const arg = mockOpenAICreate.mock.calls[0][0];
    const userMsg = arg.input.find(m => m.role === 'user');
    expect(userMsg).toBeTruthy();
    return userMsg.content;
}

describe('rate-file interleaving in the OpenAI request', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(storage, 'getAllRateMappings').mockResolvedValue(FAKE_MAPPINGS);
        mockOpenAICreate.mockResolvedValue({ output_text: JSON.stringify({ lineItems: [] }) });
    });

    afterEach(() => jest.restoreAllMocks());

    test('all three rate files are attached', async () => {
        await request(app).post('/api/generate-quotation')
            .send({ emailContent: '2 inch GI pipe heavy', instructions: 'extract' });

        const content = getUserContent();
        const fileIds = content.filter(p => p.type === 'input_file').map(p => p.file_id);
        expect(fileIds).toEqual(expect.arrayContaining(['file-ERW', 'file-GI', 'file-SML']));
        expect(fileIds).toHaveLength(3);
    });

    test('every rate file is IMMEDIATELY preceded by an input_text part', async () => {
        await request(app).post('/api/generate-quotation')
            .send({ emailContent: '2 inch GI pipe heavy', instructions: 'extract' });

        const content = getUserContent();
        content.forEach((part, i) => {
            if (part.type === 'input_file') {
                expect(i).toBeGreaterThan(0);
                expect(content[i - 1].type).toBe('input_text'); // never two files back-to-back
            }
        });
    });

    test('the label before each file names the correct pipe type', async () => {
        await request(app).post('/api/generate-quotation')
            .send({ emailContent: '2 inch GI pipe heavy', instructions: 'extract' });

        const content = getUserContent();
        // Map each file_id → the text of the part immediately before it
        const labelFor = {};
        content.forEach((part, i) => {
            if (part.type === 'input_file') labelFor[part.file_id] = content[i - 1].text;
        });

        expect(labelFor['file-ERW']).toMatch(/ERW/i);
        expect(labelFor['file-GI']).toMatch(/\bGI\b/i);
        expect(labelFor['file-SML']).toMatch(/seamless/i);

        // Cross-contamination guard: the GI label must not also claim to be ERW/Seamless
        expect(labelFor['file-GI']).not.toMatch(/seamless/i);
        expect(labelFor['file-ERW']).not.toMatch(/galvani/i);
    });

    test('files are NOT all dumped at the very end (the original bug)', async () => {
        await request(app).post('/api/generate-quotation')
            .send({ emailContent: '2 inch GI pipe heavy', instructions: 'extract' });

        const content = getUserContent();
        // In the buggy layout the last 3 parts were all input_file with no labels
        // between them. Assert at least one input_text sits between the files.
        const lastThree = content.slice(-3).map(p => p.type);
        expect(lastThree.filter(t => t === 'input_file').length).toBeLessThan(3);
    });

    test('each file gets its own distinct label (no file shares or misses a label)', async () => {
        await request(app).post('/api/generate-quotation')
            .send({ emailContent: '2 inch GI pipe heavy', instructions: 'extract' });

        const content = getUserContent();
        const labels = [];
        content.forEach((part, i) => {
            if (part.type === 'input_file') labels.push(content[i - 1].text);
        });
        // 3 files → 3 labels, all distinct
        expect(labels).toHaveLength(3);
        expect(new Set(labels).size).toBe(3);
    });
});
