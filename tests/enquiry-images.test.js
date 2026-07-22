/**
 * tests/enquiry-images.test.js
 *
 * Every enquiry photo reaches the AI. handleGenerateQuotation (via the exported
 * generateQuotationData) must push an input_image part for EACH image — a
 * photographed requirement spanning several photos must not lose page 2+.
 * Mirrors tests/rate-file-interleaving.test.js: all external services mocked
 * before loading the app; the OpenAI input array is captured and asserted.
 */

'use strict';

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
process.env.GOOGLE_CLOUD_BUCKET_NAME = '';

const app = require('../server');
const { generateQuotationData } = require('../server')._test;
const storage = require('../storage');

const IMG = (n) => `data:image/jpeg;base64,AAAA${n}`;

function userImageParts() {
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    const arg = mockOpenAICreate.mock.calls[0][0];
    const userMsg = arg.input.find((m) => m.role === 'user');
    return userMsg.content.filter((p) => p.type === 'input_image');
}

describe('handleGenerateQuotation — every enquiry image becomes an input_image', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(storage, 'getAllRateMappings').mockResolvedValue([
            { openaiFileId: 'file-SML', originalName: 'Seamless Price List.pdf', s3Key: 'rates/Seamless Price List.pdf' },
        ]);
        mockOpenAICreate.mockResolvedValue({ output_text: JSON.stringify({ lineItems: [] }) });
    });
    afterEach(() => jest.restoreAllMocks());

    test('all THREE photos are sent (multi-page requirement)', async () => {
        await generateQuotationData({ emailContent: 'see photos', instructions: 'extract', enquiryImageDataUrls: [IMG(1), IMG(2), IMG(3)] });
        const imgs = userImageParts();
        expect(imgs).toHaveLength(3);
        expect(imgs.map((p) => p.image_url)).toEqual([IMG(1), IMG(2), IMG(3)]);
    });

    test('the legacy single enquiryImageDataUrl still works', async () => {
        await generateQuotationData({ emailContent: 'see photo', instructions: 'extract', enquiryImageDataUrl: IMG(9) });
        const imgs = userImageParts();
        expect(imgs).toHaveLength(1);
        expect(imgs[0].image_url).toBe(IMG(9));
    });

    test('array + legacy single are combined', async () => {
        await generateQuotationData({ emailContent: 'x', instructions: 'extract', enquiryImageDataUrls: [IMG(1)], enquiryImageDataUrl: IMG(2) });
        expect(userImageParts()).toHaveLength(2);
    });

    test('no images -> no input_image parts', async () => {
        await generateQuotationData({ emailContent: '2 inch GI heavy', instructions: 'extract' });
        expect(userImageParts()).toHaveLength(0);
    });

    test('images and enquiry PDF file ids coexist', async () => {
        await generateQuotationData({ emailContent: 'x', instructions: 'extract', enquiryFileIds: ['file-A', 'file-B'], enquiryImageDataUrls: [IMG(1), IMG(2)] });
        const arg = mockOpenAICreate.mock.calls[0][0];
        const content = arg.input.find((m) => m.role === 'user').content;
        expect(content.filter((p) => p.type === 'input_image')).toHaveLength(2);
        const enquiryFileIds = content.filter((p) => p.type === 'input_file').map((p) => p.file_id);
        expect(enquiryFileIds).toEqual(expect.arrayContaining(['file-A', 'file-B']));
    });
});
