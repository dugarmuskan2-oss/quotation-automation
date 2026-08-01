/**
 * Tests for Phase 5 "read the Gmail thread" + the in-card conversation panel
 * (commits edc8b85 / 905c7ee) and backlog #5 (send quote from the conversation).
 *
 * Backend pure parsers (utils/gmail._test — already exported, no source change):
 *   - wrapBase64      — RFC 2045 76-char line wrapping
 *   - stripHtmlToText — HTML email body -> readable text
 *   - extractBodyText — pick the best readable body out of a Gmail payload tree
 *     (this feeds the last-message direction that drives custReplyPending)
 *
 * Backend routes (supertest + a mocked ../utils/gmail):
 *   - GET /api/resolve-thread
 *   - GET /api/thread-messages   (threadId given, or messageId resolved first)
 *
 * Frontend conversation panel + custReplyPending producer: source guards.
 *
 * replySubject / buildRawMessage / POST /api/send-email are already covered by
 * tests/email-compose.test.js + tests/gmail-send.test.js and are not retested.
 */

const fs = require('fs');
const path = require('path');

// ── Mock the Gmail module so the routes don't hit the network ────────────────
const mockLookupMessageThread = jest.fn();
const mockFetchThreadMessages = jest.fn();
jest.mock('../utils/gmail', () => ({
    sendEmail: jest.fn(),
    lookupMessageThread: mockLookupMessageThread,
    fetchThreadMessages: mockFetchThreadMessages,
    searchContactSuggestions: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const createGmailRouter = require('../routes/gmail');

// The real pure helpers (the mock above replaces the module for the router only).
const { wrapBase64, extractBodyText, stripHtmlToText } = jest.requireActual('../utils/gmail')._test;

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', createGmailRouter());
    return app;
}

describe('wrapBase64 — 76-char line wrapping (RFC 2045)', () => {
    test('inserts CRLF after exactly 76 characters', () => {
        const out = wrapBase64('x'.repeat(76));
        expect(out).toBe('x'.repeat(76) + '\r\n');
    });
    test('wraps every 76-char block', () => {
        const out = wrapBase64('x'.repeat(80));
        expect(out).toBe('x'.repeat(76) + '\r\n' + 'xxxx');
    });
    test('short / null strings are unchanged', () => {
        expect(wrapBase64('short')).toBe('short');
        expect(wrapBase64(null)).toBe('');
    });
});

describe('stripHtmlToText — HTML body to readable text', () => {
    test('strips tags', () => {
        expect(stripHtmlToText('<p>Hello</p>')).toBe('Hello');
    });
    test('decodes &nbsp; to a space', () => {
        expect(stripHtmlToText('a&nbsp;b')).toBe('a b');
    });
    test('removes <style> blocks entirely', () => {
        expect(stripHtmlToText('<style>p{color:red}</style>Hello')).toBe('Hello');
    });
    test('paragraph breaks become newlines (opening tag leaves a leading space)', () => {
        expect(stripHtmlToText('<p>A</p><p>B</p>')).toBe('A\n B');
    });
    test('null / plain text', () => {
        expect(stripHtmlToText(null)).toBe('');
        expect(stripHtmlToText('plain text')).toBe('plain text');
    });
});

describe('extractBodyText — best readable body from a Gmail payload', () => {
    test('top-level text/plain', () => {
        expect(extractBodyText({ mimeType: 'text/plain', body: { data: b64('Hello') } })).toBe('Hello');
    });
    test('a text/plain child wins over an html sibling', () => {
        const payload = { parts: [
            { mimeType: 'text/html', body: { data: b64('<p>HTML</p>') } },
            { mimeType: 'text/plain', body: { data: b64('PLAIN') } },
        ] };
        expect(extractBodyText(payload)).toBe('PLAIN');
    });
    test('html-only recurses through stripHtmlToText', () => {
        expect(extractBodyText({ mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } })).toBe('Hi');
    });
    test('digs into deeply nested multipart', () => {
        const payload = { parts: [ { parts: [ { mimeType: 'text/plain', body: { data: b64('DEEP') } } ] } ] };
        expect(extractBodyText(payload)).toBe('DEEP');
    });
    test('null / empty payload -> empty string', () => {
        expect(extractBodyText(null)).toBe('');
        expect(extractBodyText({})).toBe('');
    });
});

describe('GET /api/resolve-thread', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLookupMessageThread.mockResolvedValue({ threadId: 't9', fromEmail: 'a@b.com', subject: 'Hi' });
    });

    test('missing messageId -> 400', async () => {
        const res = await request(makeApp()).get('/api/resolve-thread');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/messageId is required/);
    });

    test('resolves and returns the thread info JSON', async () => {
        const res = await request(makeApp()).get('/api/resolve-thread?messageId=abc');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ threadId: 't9', fromEmail: 'a@b.com', subject: 'Hi' });
        expect(mockLookupMessageThread).toHaveBeenCalledWith('abc');
    });

    test('a lookup failure -> 500', async () => {
        mockLookupMessageThread.mockRejectedValueOnce(new Error('boom'));
        const res = await request(makeApp()).get('/api/resolve-thread?messageId=abc');
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Could not read original email thread/);
    });
});

describe('GET /api/thread-messages', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLookupMessageThread.mockResolvedValue({ threadId: 't9' });
        mockFetchThreadMessages.mockResolvedValue({ threadId: 't1', messages: [{ id: 'm1', direction: 'customer' }] });
    });

    test('threadId given -> skips lookup, fetches that thread', async () => {
        const res = await request(makeApp()).get('/api/thread-messages?threadId=t1');
        expect(res.status).toBe(200);
        expect(res.body.messages).toHaveLength(1);
        expect(mockFetchThreadMessages).toHaveBeenCalledWith('t1');
        expect(mockLookupMessageThread).not.toHaveBeenCalled();
    });

    test('messageId only -> resolves the threadId first, then fetches', async () => {
        const res = await request(makeApp()).get('/api/thread-messages?messageId=m1');
        expect(res.status).toBe(200);
        expect(mockLookupMessageThread).toHaveBeenCalledWith('m1');
        expect(mockFetchThreadMessages).toHaveBeenCalledWith('t9');
    });

    test('neither threadId nor messageId -> 400', async () => {
        const res = await request(makeApp()).get('/api/thread-messages');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/threadId or messageId is required/);
    });

    test('a fetch failure -> 500', async () => {
        mockFetchThreadMessages.mockRejectedValueOnce(new Error('nope'));
        const res = await request(makeApp()).get('/api/thread-messages?threadId=t1');
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Could not read the thread/);
    });
});

describe('source guard — conversation panel + custReplyPending producer', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    test('the panel is shown only for thread-linked quotes', () => {
        expect(html).toContain('const hasThread = !!(quotation.gmailMessageId || quotation.threadId);');
    });
    test('the "Check for replies" button and thread container are wired', () => {
        expect(html).toContain('loadThreadIntoPanel(${JSON.stringify(quotation.id)})');
        expect(html).toContain('id="thread-${quotation.id}" class="thread-messages"');
    });
    test('the reply composer (backlog #5) is wired', () => {
        expect(html).toContain('reply-box-${quotation.id}');
        expect(html).toContain('function sendQuoteReply');
    });
    test('custReplyPending is derived from the last message direction', () => {
        expect(html).toContain("quotation.custReplyPending = !!(last && last.direction === 'customer');");
    });

    test('the pure parsers stay exposed on utils/gmail._test', () => {
        const gmailSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'gmail.js'), 'utf8');
        // Asserted name by name, not as one exact line: the point is that these parsers stay
        // reachable from tests, and pinning the whole literal fails the moment anything else is
        // added to the export (it did, when Gmail labelling arrived).
        const exportLine = (gmailSrc.match(/module\.exports\._test = \{[^}]*\}/) || [''])[0];
        ['buildRawMessage', 'extractInlineImages', 'wrapBase64', 'extractBodyText', 'stripHtmlToText', 'isAutoOrSystemMessage']
            .forEach((name) => expect(exportLine).toContain(name));
    });
});
