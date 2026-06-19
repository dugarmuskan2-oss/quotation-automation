/**
 * Tests for the Gmail email sending feature.
 *
 * Backend (API route):
 *   POST /api/send-email
 *   - field validation (missing bodyHtml, missing to when no replyToMessageId)
 *   - happy path: sends email and returns messageId + threadId
 *   - replyToMessageId path: calls lookupMessageThread, auto-fills to/subject, threads the reply
 *   - thread lookup failure returns 500
 *   - sendEmail failure returns 500
 *
 * Frontend (inline copies of pure logic from index.html):
 *   - sentBadgeHTML renders only when quotation.sent is true
 *   - checkedBy gate blocks send when Checked By field is empty
 *   - buildButtonBar includes the sendButtonHTML slot
 */

// ─── Mock external services BEFORE loading the app ───────────────────────────

const mockSendEmail = jest.fn();
const mockLookupMessageThread = jest.fn();
jest.mock('../utils/gmail', () => ({
    sendEmail: mockSendEmail,
    lookupMessageThread: mockLookupMessageThread,
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
    ScanCommand:   jest.fn(p => p),
    GetCommand:    jest.fn(p => p),
    PutCommand:    jest.fn(p => p),
    QueryCommand:  jest.fn(p => p),
    UpdateCommand: jest.fn(p => p),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({
    Storage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })),
}));
jest.mock('openai', () =>
    jest.fn(() => ({
        files: { create: jest.fn() },
        responses: { create: jest.fn() },
        chat: { completions: { create: jest.fn() } },
    }))
);

process.env.NODE_ENV          = 'test';
process.env.OPENAI_API_KEY    = 'test-key';
process.env.DYNAMODB_TABLE    = 'test-table';
process.env.AWS_S3_BUCKET_NAME         = '';
process.env.AWS_ACCESS_KEY_ID          = '';
process.env.AWS_SECRET_ACCESS_KEY      = '';
process.env.GOOGLE_CLOUD_BUCKET_NAME   = '';
process.env.GMAIL_CLIENT_ID            = 'test-client-id';
process.env.GMAIL_CLIENT_SECRET        = 'test-client-secret';
process.env.GMAIL_REFRESH_TOKEN        = 'test-refresh-token';

const request = require('supertest');
const app     = require('../server');

beforeEach(() => {
    mockSendEmail.mockReset();
    mockLookupMessageThread.mockReset();
});

// =============================================================================
// POST /api/send-email — validation
// =============================================================================
describe('POST /api/send-email — validation', () => {
    test('returns 400 when bodyHtml is missing', async () => {
        const res = await request(app)
            .post('/api/send-email')
            .send({ to: 'a@b.com', subject: 'Hi' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/bodyHtml/);
    });

    test('returns 400 when both to and replyToMessageId are missing', async () => {
        const res = await request(app)
            .post('/api/send-email')
            .send({ subject: 'Hi', bodyHtml: '<p>Hi</p>' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/to.*replyToMessageId/i);
    });

    test('returns 400 when subject is missing and no replyToMessageId to infer it', async () => {
        const res = await request(app)
            .post('/api/send-email')
            .send({ to: 'a@b.com', bodyHtml: '<p>Hi</p>' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/subject/i);
    });
});

// =============================================================================
// POST /api/send-email — happy path (plain send, no thread)
// =============================================================================
describe('POST /api/send-email — plain send', () => {
    beforeEach(() => {
        mockSendEmail.mockResolvedValue({ messageId: 'msg-123', threadId: 'thread-456' });
    });

    test('returns 200 with messageId and threadId', async () => {
        const res = await request(app)
            .post('/api/send-email')
            .send({ to: 'a@b.com', subject: 'Test', bodyHtml: '<p>Hi</p>' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.messageId).toBe('msg-123');
        expect(res.body.threadId).toBe('thread-456');
    });

    test('passes pdfBase64 and pdfFilename through to sendEmail', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ to: 'a@b.com', subject: 'Q', bodyHtml: '<p>Q</p>', pdfBase64: 'abc==', pdfFilename: 'q.pdf' });
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
            pdfBase64: 'abc==',
            pdfFilename: 'q.pdf',
        }));
    });

    test('does not call lookupMessageThread when replyToMessageId is absent', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ to: 'a@b.com', subject: 'Q', bodyHtml: '<p>Q</p>' });
        expect(mockLookupMessageThread).not.toHaveBeenCalled();
    });

    test('returns sentTo in response', async () => {
        const res = await request(app)
            .post('/api/send-email')
            .send({ to: 'customer@acme.com', subject: 'Q', bodyHtml: '<p>Q</p>' });
        expect(res.body.sentTo).toBe('customer@acme.com');
    });
});

// =============================================================================
// POST /api/send-email — reply-to-thread path
// =============================================================================
describe('POST /api/send-email — replyToMessageId', () => {
    const threadInfo = {
        threadId:     'thread-999',
        rfcMessageId: '<original@gmail.com>',
        fromEmail:    'customer@acme.com',
        subject:      'Enquiry for pipes',
    };

    beforeEach(() => {
        mockLookupMessageThread.mockResolvedValue(threadInfo);
        mockSendEmail.mockResolvedValue({ messageId: 'msg-reply', threadId: 'thread-999' });
    });

    test('calls lookupMessageThread with the provided message id', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(mockLookupMessageThread).toHaveBeenCalledWith('orig-msg-id');
    });

    test('auto-fills to from original sender when not provided', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'customer@acme.com',
        }));
    });

    test('auto-fills subject as "Re: {original subject}" when not provided', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
            subject: 'Re: Enquiry for pipes',
        }));
    });

    test('passes threadId to sendEmail for in-thread delivery', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 'thread-999',
        }));
    });

    test('passes In-Reply-To and References headers', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
            inReplyTo:  '<original@gmail.com>',
            references: '<original@gmail.com>',
        }));
    });

    test('caller-supplied to overrides auto-detected sender', async () => {
        await request(app)
            .post('/api/send-email')
            .send({ to: 'override@example.com', replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'override@example.com',
        }));
    });
});

// =============================================================================
// POST /api/send-email — error paths
// =============================================================================
describe('POST /api/send-email — errors', () => {
    test('returns 500 when thread lookup throws', async () => {
        mockLookupMessageThread.mockRejectedValue(new Error('Insufficient Permission'));
        const res = await request(app)
            .post('/api/send-email')
            .send({ replyToMessageId: 'orig-msg-id', bodyHtml: '<p>Q</p>' });
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Insufficient Permission/);
    });

    test('returns 500 when sendEmail throws', async () => {
        mockSendEmail.mockRejectedValue(new Error('Gmail API down'));
        const res = await request(app)
            .post('/api/send-email')
            .send({ to: 'a@b.com', subject: 'Q', bodyHtml: '<p>Q</p>' });
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Gmail API down/);
    });
});

// =============================================================================
// Frontend pure logic — inline copies from index.html
// =============================================================================

/** index.html — sentBadgeHTML logic inside buildAllApprovedQuotationsHTMLForList */
function buildSentBadgeHTML(quotation) {
    return quotation.sent ? `<span class="saved-badge sent-badge">&#10003; SENT</span>` : '';
}

/** index.html — checkedBy gate at top of sendQuotationToCustomer */
function checkedByGate(quotation, domValue) {
    const checkedBy = (domValue || '').toString().trim() || (quotation.checkedBy || '').trim();
    return checkedBy.length > 0;
}

/** index.html — buildApprovalSplitLayout button bar (now includes sendButtonHTML) */
function buildButtonBar({ approveButtonHTML, saveButtonHTML, printButtonHTML, downloadButtonHTML, sendButtonHTML }) {
    return `<div style="margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap;">
        ${approveButtonHTML}
        ${saveButtonHTML   || ''}
        ${printButtonHTML  || ''}
        ${downloadButtonHTML}
        ${sendButtonHTML   || ''}
    </div>`;
}

// sentBadgeHTML
describe('buildSentBadgeHTML', () => {
    test('returns non-empty HTML when sent is true', () => {
        expect(buildSentBadgeHTML({ sent: true })).toContain('SENT');
    });

    test('contains the sent-badge class', () => {
        expect(buildSentBadgeHTML({ sent: true })).toContain('sent-badge');
    });

    test('returns empty string when sent is false', () => {
        expect(buildSentBadgeHTML({ sent: false })).toBe('');
    });

    test('returns empty string when sent is undefined', () => {
        expect(buildSentBadgeHTML({})).toBe('');
    });
});

// checkedBy gate
describe('checkedByGate — send blocked until Checked By is filled', () => {
    test('returns false when both dom value and stored checkedBy are empty', () => {
        expect(checkedByGate({}, '')).toBe(false);
    });

    test('returns false when checkedBy is whitespace only', () => {
        expect(checkedByGate({ checkedBy: '   ' }, '   ')).toBe(false);
    });

    test('returns true when dom value is filled', () => {
        expect(checkedByGate({}, 'Riya')).toBe(true);
    });

    test('returns true when stored checkedBy is filled and dom is empty', () => {
        expect(checkedByGate({ checkedBy: 'Riya' }, '')).toBe(true);
    });

    test('dom value takes precedence over stored value', () => {
        expect(checkedByGate({ checkedBy: 'Old' }, 'New')).toBe(true);
    });

    test('returns false when quotation has no checkedBy and dom is absent', () => {
        expect(checkedByGate({ companyName: 'DSC' }, null)).toBe(false);
    });
});

// sendButtonHTML slot in buildButtonBar
describe('buildButtonBar — sendButtonHTML slot', () => {
    const base = {
        approveButtonHTML:  '<button id="a">Approve</button>',
        saveButtonHTML:     '<button id="s">Save</button>',
        printButtonHTML:    '<button id="p">Print</button>',
        downloadButtonHTML: '<button id="d">Download</button>',
    };

    test('renders sendButtonHTML when provided', () => {
        const html = buildButtonBar({ ...base, sendButtonHTML: '<button id="send">Send</button>' });
        expect(html).toContain('<button id="send">Send</button>');
    });

    test('renders empty string — not "undefined" — when sendButtonHTML is omitted', () => {
        expect(buildButtonBar({ ...base })).not.toContain('undefined');
    });

    test('send button appears after download button', () => {
        const html = buildButtonBar({ ...base, sendButtonHTML: '<s-send>' });
        expect(html.indexOf('<s-send>')).toBeGreaterThan(html.indexOf('<button id="d">'));
    });

    test('all other buttons still render when send is absent', () => {
        const html = buildButtonBar({ ...base });
        expect(html).toContain('Approve');
        expect(html).toContain('Save');
        expect(html).toContain('Print');
        expect(html).toContain('Download');
    });
});
