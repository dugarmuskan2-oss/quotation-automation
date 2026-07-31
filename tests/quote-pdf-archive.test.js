/**
 * @jest-environment node
 *
 * tests/quote-pdf-archive.test.js
 *
 * PDF archiving behind the Copy-Link shared page (routes/quotations.js):
 *   POST /quotations/:id/archive-pdf  — stash the exact PDF that was emailed, per version
 *   GET  /quotations/:id/pdf?version= — stream an archived PDF back
 *
 * Both routes talk to FILE STORAGE only, never to DynamoDB, so a fake storage object
 * (recording upload / streamToResponse calls) is the whole surface under test. The
 * DynamoDB fake is kept alongside it purely to prove the archive write leaves the
 * stored payload — lineItems, tableHTML, revisions — completely untouched.
 *
 * Deliberate note on the brief vs. reality (asserted below, not assumed):
 *  - archive-pdf does NOT record `archivedPdfVersions` on the stored payload; it only
 *    uploads the bytes and returns the key. The version list is recorded CLIENT-side by
 *    archiveQuotationPdf() in index.html, which is the real function exercised here
 *    (extracted + eval'd, no inline copy) for the "records the version / no duplicate"
 *    cases.
 *  - archive-pdf never looks the quote up, so an unknown id is NOT a 404 — it archives
 *    happily under that id's prefix. The 404 in this feature belongs to GET .../pdf,
 *    which 404s per *version* (the caller then falls back to the rebuilt view).
 *
 * renderSharedQuotePage is DOM-bound (no jsdom here), so the "embed the archived PDF
 * only when the version is listed, else fall back to revisionFullQuoteHtml" contract
 * gets a source guard.
 */

'use strict';

jest.mock('@aws-sdk/lib-dynamodb', () => {
    const tag = (t) => class { constructor(input) { this.input = input; this.__type = t; } };
    return {
        DynamoDBDocumentClient: { from: jest.fn() },
        GetCommand: tag('Get'), PutCommand: tag('Put'),
        UpdateCommand: tag('Update'), QueryCommand: tag('Query'), ScanCommand: tag('Scan'),
        DeleteCommand: tag('Delete'),
    };
});

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const createQuotationsRouter = require('../routes/quotations');

// ── Fakes ─────────────────────────────────────────────────────────────────────

// Storage fake. `files` maps "<folder>/<name>" -> Buffer, mirroring how storage.upload
// composes a key from (buffer, fileName, folder) and how streamToResponse reads one back.
function makeStorage(over) {
    const files = {};
    const storage = {
        files,
        upload: jest.fn(async (buffer, fileName, folder) => {
            files[folder + '/' + fileName] = buffer;
            return folder + '/' + fileName;
        }),
        streamToResponse: jest.fn(async (key, res) => {
            const buf = files[key];
            if (!buf) throw new Error('Not found: ' + key);
            res.end(buf);
        }),
    };
    return Object.assign(storage, over);
}

function makeApp(store, storage) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    const ddbDocClient = {
        send: jest.fn(async (cmd) => {
            if (cmd.__type === 'Get') return { Item: store[cmd.input.Key.id] };
            if (cmd.__type === 'Put') { store[cmd.input.Item.id] = cmd.input.Item; return {}; }
            throw new Error('unexpected command: ' + cmd.__type);
        }),
    };
    app.use('/api', createQuotationsRouter({ ddbDocClient, ddbTableName: 'T', storage }));
    app.__ddb = ddbDocClient;
    return app;
}

// A quote whose payload carries the heavy fields an archive write must never disturb.
function seed() {
    const store = {};
    store['q1'] = {
        id: 'q1',
        updatedAt: '2026-07-01T00:00:00.000Z',
        payload: {
            id: 'q1', quoteNumber: 'DSC-300', companyName: 'Acme',
            lineItems: [{ lineItemId: 'a', originalDescription: '2" NB X Heavy -- GI', quantity: '10', unitRate: '100' }],
            tableHTML: '<table><tr><td>rows</td></tr></table>',
            headerHTML: '<div>header</div>',
            termsText: 'Net 30',
            revisions: [{ revNo: 1, createdAt: '2026-06-01T00:00:00.000Z' }],
            revisionCount: 1,
        },
    };
    return store;
}

const PDF_BYTES = Buffer.from('%PDF-1.4 archived original', 'utf8');
const PDF_B64 = PDF_BYTES.toString('base64');

// superagent has no parser for application/pdf — buffer the raw bytes ourselves.
function binaryParser(res, cb) {
    res.setEncoding('binary');
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => cb(null, Buffer.from(data, 'binary')));
}

// ── POST /quotations/:id/archive-pdf ──────────────────────────────────────────

describe('POST /quotations/:id/archive-pdf', () => {
    test('stores the decoded PDF under quote-pdfs/<id>/<versionKey>.pdf and returns the key', async () => {
        const storage = makeStorage();
        const res = await request(makeApp(seed(), storage))
            .post('/api/quotations/q1/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v2' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, key: 'quote-pdfs/q1/v2.pdf' });

        expect(storage.upload).toHaveBeenCalledTimes(1);
        const [buffer, fileName, folder] = storage.upload.mock.calls[0];
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.equals(PDF_BYTES)).toBe(true);        // exact bytes, decoded from base64
        expect(fileName).toBe('v2.pdf');
        expect(folder).toBe('quote-pdfs/q1');
        expect(storage.files['quote-pdfs/q1/v2.pdf'].equals(PDF_BYTES)).toBe(true);
    });

    test('the version key is sanitised into the filename (no path escapes)', async () => {
        const storage = makeStorage();
        const res = await request(makeApp(seed(), storage))
            .post('/api/quotations/q1/archive-pdf')
            .send({ base64: PDF_B64, versionKey: '../../etc/passwd v3' });

        expect(res.status).toBe(200);
        expect(storage.upload.mock.calls[0][1]).toBe('.._.._etc_passwd_v3.pdf');
        expect(res.body.key).toBe('quote-pdfs/q1/.._.._etc_passwd_v3.pdf');
    });

    test('heavy payload fields survive the archive write untouched (DynamoDB is never called)', async () => {
        const store = seed();
        const storage = makeStorage();
        const app = makeApp(store, storage);
        const before = JSON.parse(JSON.stringify(store['q1']));

        const res = await request(app).post('/api/quotations/q1/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v1' });
        expect(res.status).toBe(200);

        expect(app.__ddb.send).not.toHaveBeenCalled();          // storage-only route
        expect(store['q1']).toEqual(before);                    // nothing rewritten
        expect(store['q1'].payload.lineItems).toHaveLength(1);
        expect(store['q1'].payload.tableHTML).toBe('<table><tr><td>rows</td></tr></table>');
        expect(store['q1'].payload.revisions).toHaveLength(1);

        // and the quote still reads back whole through the real GET route
        const got = await request(app).get('/api/quotations/q1');
        expect(got.status).toBe(200);
        expect(got.body.quotation.tableHTML).toBe('<table><tr><td>rows</td></tr></table>');
        expect(got.body.quotation.headerHTML).toBe('<div>header</div>');
        expect(got.body.quotation.termsText).toBe('Net 30');
        expect(got.body.quotation.lineItems[0].originalDescription).toBe('2" NB X Heavy -- GI');
        // the route records nothing server-side — the version list is a client-side field
        expect(got.body.quotation.archivedPdfVersions).toBeUndefined();
    });

    test('re-archiving the same version overwrites the one key — no second entry appears', async () => {
        const storage = makeStorage();
        const app = makeApp(seed(), storage);

        const first = await request(app).post('/api/quotations/q1/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v2' });
        const second = await request(app).post('/api/quotations/q1/archive-pdf')
            .send({ base64: Buffer.from('%PDF-1.4 re-sent', 'utf8').toString('base64'), versionKey: 'v2' });

        expect(first.body.key).toBe('quote-pdfs/q1/v2.pdf');
        expect(second.body.key).toBe(first.body.key);                       // same key, idempotent
        expect(Object.keys(storage.files)).toEqual(['quote-pdfs/q1/v2.pdf']); // one file, not two
        expect(storage.files['quote-pdfs/q1/v2.pdf'].toString()).toBe('%PDF-1.4 re-sent');
    });

    test.each([
        ['empty body', {}],
        ['no base64', { versionKey: 'v1' }],
        ['no versionKey', { base64: PDF_B64 }],
        ['blank base64', { base64: '', versionKey: 'v1' }],
        ['blank versionKey', { base64: PDF_B64, versionKey: '' }],
    ])('400 when the body is invalid — %s', async (_label, body) => {
        const storage = makeStorage();
        const res = await request(makeApp(seed(), storage)).post('/api/quotations/q1/archive-pdf').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('base64 and versionKey are required');
        expect(storage.upload).not.toHaveBeenCalled();
    });

    test('400 when no body is sent at all', async () => {
        const res = await request(makeApp(seed(), makeStorage())).post('/api/quotations/q1/archive-pdf');
        expect(res.status).toBe(400);
    });

    test('501 when file storage is not configured', async () => {
        const res = await request(makeApp(seed(), null)).post('/api/quotations/q1/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v1' });
        expect(res.status).toBe(501);
        expect(res.body.error).toBe('File storage not configured');
    });

    test('500 when the upload itself fails', async () => {
        const storage = makeStorage({ upload: jest.fn(async () => { throw new Error('bucket down'); }) });
        const res = await request(makeApp(seed(), storage)).post('/api/quotations/q1/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v1' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to archive PDF');
        expect(res.body.details).toBe('bucket down');
    });

    // REALITY CHECK: the route never loads the quote, so there is no 404 here. An unknown
    // id simply archives under its own prefix. (The 404 lives on GET .../pdf, below.)
    test('an unknown quote id is NOT a 404 — it archives under that id, since the route never loads the quote', async () => {
        const store = seed();
        const storage = makeStorage();
        const app = makeApp(store, storage);
        const res = await request(app).post('/api/quotations/does-not-exist/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v0' });

        expect(res.status).toBe(200);
        expect(res.body.key).toBe('quote-pdfs/does-not-exist/v0.pdf');
        expect(app.__ddb.send).not.toHaveBeenCalled();
        expect(store['does-not-exist']).toBeUndefined();
    });
});

// ── GET /quotations/:id/pdf ───────────────────────────────────────────────────

describe('GET /quotations/:id/pdf', () => {
    test('streams the archived bytes back as application/pdf', async () => {
        const storage = makeStorage();
        const app = makeApp(seed(), storage);
        await request(app).post('/api/quotations/q1/archive-pdf').send({ base64: PDF_B64, versionKey: 'v2' });

        const res = await request(app).get('/api/quotations/q1/pdf?version=v2').buffer().parse(binaryParser);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.body.equals(PDF_BYTES)).toBe(true);
        expect(storage.streamToResponse).toHaveBeenCalledWith('quote-pdfs/q1/v2.pdf', expect.anything());
    });

    test('defaults to the "current" version when ?version is missing', async () => {
        const storage = makeStorage();
        const app = makeApp(seed(), storage);
        await request(app).post('/api/quotations/q1/archive-pdf').send({ base64: PDF_B64, versionKey: 'current' });

        const res = await request(app).get('/api/quotations/q1/pdf').buffer().parse(binaryParser);
        expect(res.status).toBe(200);
        expect(storage.streamToResponse.mock.calls[0][0]).toBe('quote-pdfs/q1/current.pdf');
        expect(res.body.equals(PDF_BYTES)).toBe(true);
    });

    test('the ?version value is sanitised before it becomes a storage key', async () => {
        const storage = makeStorage();
        const app = makeApp(seed(), storage);
        const res = await request(app).get('/api/quotations/q1/pdf?version=' + encodeURIComponent('../secret v1'));
        expect(res.status).toBe(404);
        expect(storage.streamToResponse.mock.calls[0][0]).toBe('quote-pdfs/q1/.._secret_v1.pdf');
    });

    test('404 (with an error body) for a version that was never archived', async () => {
        const storage = makeStorage();
        const app = makeApp(seed(), storage);
        await request(app).post('/api/quotations/q1/archive-pdf').send({ base64: PDF_B64, versionKey: 'v2' });

        const res = await request(app).get('/api/quotations/q1/pdf?version=v9');
        expect(res.status).toBe(404);
        // NOTE: the route sets Content-Type: application/pdf BEFORE streaming, and express's
        // res.json() will not override an already-set type — so this JSON 404 still carries a
        // pdf content type. That makes supertest parse the body as a binary buffer rather than
        // text (res.text is undefined), hence reading it via res.body here. Callers only check
        // res.ok before falling back to the rebuilt view, so it is harmless, but it is real.
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
        expect(JSON.parse(Buffer.from(res.body).toString('utf8')).error)
            .toBe('No archived PDF for this version');
    });

    test('404 for an unknown quote id (nothing was ever archived under it)', async () => {
        const storage = makeStorage();
        const res = await request(makeApp(seed(), storage)).get('/api/quotations/nope/pdf?version=v1');
        expect(res.status).toBe(404);
        expect(storage.streamToResponse.mock.calls[0][0]).toBe('quote-pdfs/nope/v1.pdf');
    });

    test('404 with an empty body when file storage is not configured', async () => {
        const res = await request(makeApp(seed(), null)).get('/api/quotations/q1/pdf?version=v1');
        expect(res.status).toBe(404);
        expect(res.text).toBe('');
    });
});

// ── index.html: the client half (real functions / source guards) ───────────────

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');

// Pull a top-level `function name(...) { ... }` out of source by brace-matching.
// Keeps a leading `async ` — archiveQuotationPdf is async, and dropping the keyword
// leaves its `await` in a plain function, which is a SyntaxError.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}
function loadFns(names) {
    const body = names.map((n) => extractFunction(indexSrc, n)).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn ' + names[names.length - 1] + ';')();
}

// The REAL archiveQuotationPdf, with its real currentRevisionNumber dependency. Its free
// variables (API_BASE_URL / fetch / saveQuotationToBackend) resolve against the global.
const archiveQuotationPdf = loadFns(['currentRevisionNumber', 'archiveQuotationPdf']);

describe('archiveQuotationPdf (index.html) — records the archived version on the quote', () => {
    let saved;
    beforeEach(() => {
        global.API_BASE_URL = 'http://localhost:3000/api';
        global.fetch = jest.fn(async () => ({ ok: true }));
        saved = jest.fn();
        global.saveQuotationToBackend = saved;
    });
    afterEach(() => {
        delete global.API_BASE_URL; delete global.fetch; delete global.saveQuotationToBackend;
    });

    test('posts base64 + the current version key, then records it and persists once', async () => {
        const q = { id: 'q1', revisionCount: 2 };
        await archiveQuotationPdf(q, PDF_B64);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://localhost:3000/api/quotations/q1/archive-pdf');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body)).toEqual({ base64: PDF_B64, versionKey: 'v2' });

        expect(q.archivedPdfVersions).toEqual(['v2']);
        expect(saved).toHaveBeenCalledTimes(1);
        expect(saved.mock.calls[0][0]).toBe(q);
    });

    test('re-archiving the same version does not duplicate the entry (and does not re-save)', async () => {
        const q = { id: 'q1', revisionCount: 2 };
        await archiveQuotationPdf(q, PDF_B64);
        await archiveQuotationPdf(q, PDF_B64);
        await archiveQuotationPdf(q, PDF_B64);

        expect(q.archivedPdfVersions).toEqual(['v2']);   // recorded once
        expect(global.fetch).toHaveBeenCalledTimes(3);   // bytes still re-uploaded (overwrite)
        expect(saved).toHaveBeenCalledTimes(1);          // persisted only when the list changed
    });

    test('a new revision appends its own version key', async () => {
        const q = { id: 'q1', revisionCount: 2 };
        await archiveQuotationPdf(q, PDF_B64);
        q.revisionCount = 3;
        await archiveQuotationPdf(q, PDF_B64);
        expect(q.archivedPdfVersions).toEqual(['v2', 'v3']);
        expect(saved).toHaveBeenCalledTimes(2);
    });

    test('version key falls back to the revisions array length when there is no counter', async () => {
        const q = { id: 'q 1/2', revisions: [{}, {}] };
        await archiveQuotationPdf(q, PDF_B64);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).versionKey).toBe('v2');
        expect(global.fetch.mock.calls[0][0]).toContain('/quotations/q%201%2F2/archive-pdf');  // id is encoded
    });

    test('a failed archive records nothing (no phantom version on the quote)', async () => {
        global.fetch = jest.fn(async () => ({ ok: false }));
        const q = { id: 'q1', revisionCount: 1 };
        await archiveQuotationPdf(q, PDF_B64);
        expect(q.archivedPdfVersions).toBeUndefined();
        expect(saved).not.toHaveBeenCalled();
    });

    test('a thrown fetch is swallowed — archiving never breaks the send', async () => {
        global.fetch = jest.fn(async () => { throw new Error('offline'); });
        const q = { id: 'q1', revisionCount: 1 };
        await expect(archiveQuotationPdf(q, PDF_B64)).resolves.toBeUndefined();
        expect(q.archivedPdfVersions).toBeUndefined();
    });

    test('no quote or no bytes — nothing is sent', async () => {
        await archiveQuotationPdf(null, PDF_B64);
        await archiveQuotationPdf({ id: 'q1' }, '');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

// renderSharedQuotePage writes document.title + overlay.innerHTML, so it cannot run here
// (no jsdom). Guard the branch that matters: a past version embeds the archived PDF ONLY
// when its key is listed in archivedPdfVersions, otherwise it rebuilds the quote view.
describe('source guard — shared page embeds an archived PDF only when the version is listed', () => {
    const render = extractFunction(indexSrc, 'renderSharedQuotePage');

    test('the archived list is read off the quote, defaulting to []', () => {
        expect(render).toMatch(/const archived = Array\.isArray\(quotation\.archivedPdfVersions\) \? quotation\.archivedPdfVersions : \[\]/);
    });

    test('a past version key is built as "v" + revNo and looked up in that list', () => {
        expect(render).toMatch(/const vkey = 'v' \+ \(r\.revNo != null \? r\.revNo : i\)/);
        expect(render).toMatch(/archived\.indexOf\(vkey\) >= 0/);
    });

    test('listed -> the /pdf?version= iframe; not listed -> the rebuilt revisionFullQuoteHtml', () => {
        expect(render).toMatch(/\(archived\.indexOf\(vkey\) >= 0\)[\s\S]{0,220}?\/pdf\?version=/);
        expect(render).toMatch(/\/pdf\?version=' \+ encodeURIComponent\(vkey\)[\s\S]{0,80}?: revisionFullQuoteHtml\(quotation, r\)/);
    });

    test('the embedded URL is the archive route on API_BASE_URL, with the quote id encoded', () => {
        expect(render).toContain("base + '/quotations/' + encodeURIComponent(String(quotation.id)) + '/pdf?version='");
        expect(render).toMatch(/const base = \(typeof API_BASE_URL === 'string' \? API_BASE_URL : ''\)/);
    });

    test('the CURRENT version is never served from the archive — it renders live', () => {
        expect(render).toMatch(/pdfFrame\('about:blank', 'sq-pdf-current'\)/);
        expect(render).toMatch(/downloadQuotationPdf\(quotation\.id, \{ preview: true \}\)/);
    });

    test('the send path archives the exact emailed PDF', () => {
        expect(indexSrc).toMatch(/archiveQuotationPdf\(quotation, pdfResult\.base64\)/);
    });
});
