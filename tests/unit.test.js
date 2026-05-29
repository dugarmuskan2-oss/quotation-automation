/**
 * Unit tests — pure functions that don't need a server or database.
 * These run instantly and test individual pieces of logic in isolation.
 */

// Mock out all external services so the server module loads without
// needing real AWS / OpenAI credentials
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({})) },
    ScanCommand: jest.fn(),
    GetCommand: jest.fn(),
    PutCommand: jest.fn(),
    QueryCommand: jest.fn(),
    UpdateCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })) }));
jest.mock('openai', () => jest.fn(() => ({ files: {}, responses: {}, chat: { completions: {} } })));

const { _test } = require('../server');
const { isWordEnquiryFile, isExcelEnquiryFile, isImageEnquiryFile, getImageDataUrl, quotationSummaryFromDdbItem } = _test;

// ---------------------------------------------------------------------------
// isWordEnquiryFile
// ---------------------------------------------------------------------------
describe('isWordEnquiryFile', () => {
    test('returns true for .docx files', () => {
        expect(isWordEnquiryFile('enquiry.docx')).toBe(true);
    });

    test('returns true for .doc files', () => {
        expect(isWordEnquiryFile('enquiry.doc')).toBe(true);
    });

    test('returns true for .rtf files', () => {
        expect(isWordEnquiryFile('enquiry.rtf')).toBe(true);
    });

    test('returns false for PDFs', () => {
        expect(isWordEnquiryFile('rates.pdf')).toBe(false);
    });

    test('returns false for images', () => {
        expect(isWordEnquiryFile('photo.png')).toBe(false);
    });

    test('handles missing filename gracefully', () => {
        expect(isWordEnquiryFile(null)).toBe(false);
        expect(isWordEnquiryFile('')).toBe(false);
        expect(isWordEnquiryFile(undefined)).toBe(false);
    });

    test('is case-insensitive', () => {
        expect(isWordEnquiryFile('ENQUIRY.DOCX')).toBe(true);
        expect(isWordEnquiryFile('Enquiry.Doc')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// isExcelEnquiryFile
// ---------------------------------------------------------------------------
describe('isExcelEnquiryFile', () => {
    test('returns true for .xlsx files', () => {
        expect(isExcelEnquiryFile('rates.xlsx')).toBe(true);
    });

    test('returns true for .csv files', () => {
        expect(isExcelEnquiryFile('data.csv')).toBe(true);
    });

    test('returns false for Word files', () => {
        expect(isExcelEnquiryFile('enquiry.docx')).toBe(false);
    });

    test('handles missing filename gracefully', () => {
        expect(isExcelEnquiryFile(null)).toBe(false);
        expect(isExcelEnquiryFile('')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// isImageEnquiryFile
// ---------------------------------------------------------------------------
describe('isImageEnquiryFile', () => {
    test('returns true for .png files', () => {
        expect(isImageEnquiryFile('photo.png')).toBe(true);
    });

    test('returns true for .jpg and .jpeg files', () => {
        expect(isImageEnquiryFile('photo.jpg')).toBe(true);
        expect(isImageEnquiryFile('photo.jpeg')).toBe(true);
    });

    test('returns true for .webp files', () => {
        expect(isImageEnquiryFile('photo.webp')).toBe(true);
    });

    test('returns false for PDFs', () => {
        expect(isImageEnquiryFile('document.pdf')).toBe(false);
    });

    test('handles missing filename gracefully', () => {
        expect(isImageEnquiryFile(null)).toBe(false);
        expect(isImageEnquiryFile('')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getImageDataUrl
// ---------------------------------------------------------------------------
describe('getImageDataUrl', () => {
    test('returns a base64 data URL for a PNG buffer', () => {
        const fakeBuffer = Buffer.from('fake-image-data');
        const result = getImageDataUrl({ buffer: fakeBuffer, originalname: 'test.png' });
        expect(result).toMatch(/^data:image\/png;base64,/);
    });

    test('returns a base64 data URL for a JPEG buffer', () => {
        const fakeBuffer = Buffer.from('fake-image-data');
        const result = getImageDataUrl({ buffer: fakeBuffer, originalname: 'test.jpg' });
        expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    test('returns null when no buffer or path is provided', () => {
        const result = getImageDataUrl({ originalname: 'test.png' });
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// quotationSummaryFromDdbItem
// ---------------------------------------------------------------------------
describe('quotationSummaryFromDdbItem', () => {
    test('returns null for null input', () => {
        expect(quotationSummaryFromDdbItem(null)).toBeNull();
    });

    test('returns null for the internal counter record', () => {
        expect(quotationSummaryFromDdbItem({ id: 'QUOTE_NUMBER_COUNTER' })).toBeNull();
    });

    test('returns null if item has no payload or data', () => {
        expect(quotationSummaryFromDdbItem({ id: 'abc123' })).toBeNull();
    });

    test('merges payload fields into the result', () => {
        const item = {
            id: 'abc123',
            payload: { customerName: 'John Smith', quoteNumber: 'Q-001' },
        };
        const result = quotationSummaryFromDdbItem(item);
        expect(result).not.toBeNull();
        expect(result.customerName).toBe('John Smith');
        expect(result.quoteNumber).toBe('Q-001');
    });

    test('falls back to item.id if merged result has no id', () => {
        const item = {
            id: 'abc123',
            payload: { customerName: 'Jane Doe' },
        };
        const result = quotationSummaryFromDdbItem(item);
        expect(result.id).toBe('abc123');
    });

    test('picks up createdAt and updatedAt from top-level item', () => {
        const item = {
            id: 'abc123',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-06-01T00:00:00Z',
            payload: { customerName: 'Test' },
        };
        const result = quotationSummaryFromDdbItem(item);
        expect(result.createdAt).toBe('2024-01-01T00:00:00Z');
        expect(result.updatedAt).toBe('2024-06-01T00:00:00Z');
    });
});
