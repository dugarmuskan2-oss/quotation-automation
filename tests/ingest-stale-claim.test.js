/**
 * tests/ingest-stale-claim.test.js
 *
 * A Gmail claim left behind by a run that was cut off must not block the email for ever.
 * 9–12 Oct 2026: five labelled enquiries were skipped as "Already imported (duplicate)" on every
 * Create Quotations run, because Vercel killed the request mid-generation and the claim was never
 * released. Now a claim with no quote after GMAIL_CLAIM_STALE_MS is retaken, and a claim whose
 * quote was saved is marked done so it is never mistaken for a stale one.
 *
 * Covers server.js isStaleGmailClaim (the decision) and ingestLogic marking the claim done.
 */

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

const { isStaleGmailClaim } = require('../server')._test;
const { GMAIL_CLAIM_STALE_MS } = require('../utils/constants');
const { processOneEmail } = require('../gmail-ingest/ingestLogic');

const NOW = Date.parse('2026-10-13T08:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

describe('isStaleGmailClaim', () => {
    test('a claim older than the limit with no quote is stale', () => {
        expect(isStaleGmailClaim({ createdAt: ago(GMAIL_CLAIM_STALE_MS + 1000) }, NOW)).toBe(true);
    });
    test('a fresh claim is another run still working — not stale', () => {
        expect(isStaleGmailClaim({ createdAt: ago(60 * 1000) }, NOW)).toBe(false);
    });
    test('a claim marked done is never stale, however old', () => {
        expect(isStaleGmailClaim({ createdAt: ago(30 * 24 * 3600 * 1000), done: true }, NOW)).toBe(false);
    });
    test('a claim with no readable time is stale (it cannot be in progress)', () => {
        expect(isStaleGmailClaim({ createdAt: 'garbage' }, NOW)).toBe(true);
    });
    test('no claim at all is not "stale" (nothing to retake)', () => {
        expect(isStaleGmailClaim(null, NOW)).toBe(false);
    });
    test('the limit is longer than Vercel\'s 60 s, so a live run is never retaken', () => {
        expect(GMAIL_CLAIM_STALE_MS).toBeGreaterThan(60 * 1000);
    });
});

describe('ingest marks the claim done once the quote is saved', () => {
    function ctx(overrides) {
        const calls = [];
        return {
            calls,
            getInstructionsContent: async () => 'I',
            getDefaultTermsContent: async () => 'T',
            generateQuotationData: async () => ({ companyName: 'X', lineItems: [] }),
            getNextQuoteNumber: async () => 2950,
            saveQuotation: async () => {},
            reserveGmailMessageId: async () => true,
            releaseGmailMessageId: async (id) => calls.push(['release', id]),
            markGmailMessageDone: async (id, q) => calls.push(['done', id, q]),
            ...overrides,
        };
    }
    const email = { id: 'msg1', subject: 'Enquiry', from: 'a@b.com', body: '2" ERW pipe 100 m' };

    test('saved → done, with the quote id', async () => {
        const c = ctx();
        const r = await processOneEmail(c, email);
        expect(r.success).toBe(true);
        expect(c.calls).toEqual([['done', 'msg1', r.id]]);
    });
    test('save fails → released, never marked done', async () => {
        const c = ctx({ saveQuotation: async () => { throw new Error('DB down'); } });
        const r = await processOneEmail(c, email);
        expect(r.success).toBe(false);
        expect(c.calls).toEqual([['release', 'msg1']]);
    });
});
