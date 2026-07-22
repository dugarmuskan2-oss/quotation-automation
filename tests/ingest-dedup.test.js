/**
 * tests/ingest-dedup.test.js
 *
 * Exercises the REAL Gmail-ingest orchestration (gmail-ingest/ingestLogic.js) through
 * an injected mock context, to prove two things the business cares about:
 *   1. Every legitimate enquiry produces exactly one quote — including edge cases.
 *   2. The same Gmail message never produces a second quote (no duplicates),
 *      even when the app is hit by rapid / concurrent re-sends.
 *
 * The mock `reserveGmailMessageId` models DynamoDB's atomic conditional write
 * (only the first claim of a message id wins). The mock `findQuotationByGmailMessageId`
 * models the OLD non-atomic scan, so we can also demonstrate the bug the fix removed.
 *
 * No external services are touched — the ctx is fully in-memory.
 */

const { processAllEmails, processOneEmail } = require('../gmail-ingest/ingestLogic');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** base64-encode a short string (valid attachment payload for the decoder). */
const b64 = (s) => Buffer.from(s).toString('base64');

/** Build a fresh in-memory ingest context + shared state. */
function makeCtx({ atomic = true, generateThrows = false, aiDelayMs = 5, uploadFileId = 'file_test' } = {}) {
    const state = {
        saved: [],           // saved quotations
        reserved: new Set(), // message ids currently claimed (models the marker table)
        counter: 107,        // quote-number counter
        generateCalls: 0,
        generateArgs: [],    // opts passed into each generateQuotationData call
    };

    const ctx = {
        getInstructionsContent: async () => 'SOME INSTRUCTIONS',
        getDefaultTermsContent: async () => 'TERMS',
        generateQuotationData: async (opts) => {
            state.generateArgs.push(opts);
            state.generateCalls += 1;
            await tick(aiDelayMs); // simulate the ~30-60s AI step (widens any race window)
            if (generateThrows) throw new Error('AI failed');
            return {
                customerName: 'R.Perumal',
                companyName: 'Real Food Products',
                lineItems: [
                    { identifiedPipeType: 'GI', originalDescription: '2 inch', quantity: '100', unitRate: '50', marginPercent: '10', finalRate: '55' },
                ],
            };
        },
        getNextQuoteNumber: async () => { state.counter += 1; return state.counter; },
        saveQuotation: async (q) => { state.saved.push(q); },
        uploadEnquiryFileToOpenAI: async () => uploadFileId,
        extractTextFromAttachment: async ({ originalname } = {}) => '[extracted text of ' + (originalname || 'file') + ']',
    };

    if (atomic) {
        // Atomic claim: check-and-set happens with no await in between, exactly like
        // DynamoDB PutItem with ConditionExpression 'attribute_not_exists(id)'.
        ctx.reserveGmailMessageId = async (id) => {
            if (state.reserved.has(id)) return false;
            state.reserved.add(id);
            return true;
        };
        ctx.releaseGmailMessageId = async (id) => { state.reserved.delete(id); };
    } else {
        // Legacy non-atomic guard: scan existing quotes (with a delay), then decide.
        ctx.findQuotationByGmailMessageId = async (id) => {
            await tick(1);
            return state.saved.find((q) => q.gmailMessageId === id) || null;
        };
    }

    return { ctx, state };
}

const email = (id, over = {}) => ({ id, subject: 'Enquiry', from: 'a@b.com', body: 'Please quote 2 inch GI pipe', attachments: [], ...over });

describe('Gmail ingest — every enquiry is created (including edge cases)', () => {
    test('a single normal enquiry creates exactly one quote, tagged with its message id', async () => {
        const { ctx, state } = makeCtx();
        const res = await processAllEmails(ctx, [email('MSG_A')]);

        expect(res.created).toBe(1);
        expect(state.saved).toHaveLength(1);
        expect(state.saved[0].gmailMessageId).toBe('MSG_A');
        expect(state.saved[0].quoteNumber).toBe('DSC-108'); // counter 107 -> 108
        expect(state.saved[0].grandTotal).toBe('5500');       // 100 * 55
    });

    test('a batch of distinct enquiries all get created (nothing dropped)', async () => {
        const { ctx, state } = makeCtx();
        const ids = ['M1', 'M2', 'M3', 'M4', 'M5'];
        const res = await processAllEmails(ctx, ids.map((id) => email(id)));

        expect(res.created).toBe(5);
        expect(new Set(state.saved.map((q) => q.gmailMessageId))).toEqual(new Set(ids));
    });

    test('EDGE: an email with no id is rejected and nothing is saved', async () => {
        const { ctx, state } = makeCtx();
        const res = await processOneEmail(ctx, email(''));

        expect(res.success).toBe(false);
        expect(res.error).toMatch(/Missing email id/);
        expect(state.saved).toHaveLength(0);
    });

    test('EDGE: an empty email (no body, no attachments) is rejected AND its claim is released so it can be retried', async () => {
        const { ctx, state } = makeCtx();

        const first = await processOneEmail(ctx, email('MSG_EMPTY', { body: '' }));
        expect(first.success).toBe(false);
        expect(res_err(first)).toMatch(/no body and no supported attachment/i);
        expect(state.saved).toHaveLength(0);
        expect(state.reserved.has('MSG_EMPTY')).toBe(false); // claim was released

        // The same message, now with real content, must succeed (not blocked as a "duplicate").
        const retry = await processOneEmail(ctx, email('MSG_EMPTY', { body: 'Now with a real enquiry' }));
        expect(retry.success).toBe(true);
        expect(state.saved).toHaveLength(1);
        expect(state.saved[0].gmailMessageId).toBe('MSG_EMPTY');
    });

    test('EDGE: if quote generation throws, the claim is released so a later run retries successfully', async () => {
        const failing = makeCtx({ generateThrows: true });
        const bad = await processOneEmail(failing.ctx, email('MSG_RETRY'));
        expect(bad.success).toBe(false);
        expect(failing.state.saved).toHaveLength(0);
        expect(failing.state.reserved.has('MSG_RETRY')).toBe(false); // released → retryable
    });
});

describe('Gmail ingest — duplicates are never created', () => {
    test('the same enquiry sent again (sequentially) does not create a second quote', async () => {
        const { ctx, state } = makeCtx();

        const first = await processOneEmail(ctx, email('DUP_1'));
        const second = await processOneEmail(ctx, email('DUP_1'));

        expect(first.success).toBe(true);
        expect(second.success).toBe(false);
        expect(second.error).toMatch(/Already imported/);
        expect(state.saved).toHaveLength(1);
    });

    test('a duplicate inside one batch [A, A, B] creates only A and B', async () => {
        const { ctx, state } = makeCtx();
        const res = await processAllEmails(ctx, [email('A'), email('A'), email('B')]);

        expect(res.created).toBe(2);
        expect(new Set(state.saved.map((q) => q.gmailMessageId))).toEqual(new Set(['A', 'B']));
    });

    test('THE REAL BUG: 3 reports firing at once for the same enquiry create only ONE quote', async () => {
        const { ctx, state } = makeCtx(); // atomic guard (the fix)
        const results = await Promise.all([
            processOneEmail(ctx, email('RACE')),
            processOneEmail(ctx, email('RACE')),
            processOneEmail(ctx, email('RACE')),
        ]);

        const created = results.filter((r) => r.success).length;
        expect(created).toBe(1);
        expect(state.saved).toHaveLength(1);
        expect(state.counter).toBe(108); // counter advanced exactly once
    });

    test('CONTROL: the OLD non-atomic check would have created duplicates under the same race', async () => {
        const { ctx, state } = makeCtx({ atomic: false }); // legacy scan-then-save
        const results = await Promise.all([
            processOneEmail(ctx, email('RACE')),
            processOneEmail(ctx, email('RACE')),
            processOneEmail(ctx, email('RACE')),
        ]);

        const created = results.filter((r) => r.success).length;
        // Demonstrates why the fix was needed: the old guard lets more than one through.
        expect(created).toBeGreaterThan(1);
        expect(state.saved.length).toBeGreaterThan(1);
    });
});

describe('Gmail ingest — enquiries that live in an attachment (little/no body) still get created', () => {
    test('a PDF-only enquiry (no body text) creates a quote', async () => {
        const { ctx, state } = makeCtx();
        const att = { name: 'enquiry.pdf', contentType: 'application/pdf', base64: b64('%PDF-1.4 fake pdf') };
        const res = await processOneEmail(ctx, email('PDF_ONLY', { body: '', attachments: [att] }));

        expect(res.success).toBe(true);
        expect(state.saved).toHaveLength(1);
        expect(state.saved[0].gmailMessageId).toBe('PDF_ONLY');
    });

    test('an image-only enquiry (no body, upload returns nothing) still creates a quote', async () => {
        const { ctx, state } = makeCtx({ uploadFileId: null });
        const att = { name: 'enquiry.jpg', contentType: 'image/jpeg', base64: b64('fake-image-bytes') };
        const res = await processOneEmail(ctx, email('IMG_ONLY', { body: '', attachments: [att] }));

        expect(res.success).toBe(true);
        expect(state.saved).toHaveLength(1);
    });

    test('an Excel-only enquiry (no body, text extracted from the sheet) creates a quote', async () => {
        const { ctx, state } = makeCtx();
        const att = { name: 'requirement.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: b64('fake-xlsx-bytes') };
        const res = await processOneEmail(ctx, email('XLS_ONLY', { body: '', attachments: [att] }));

        expect(res.success).toBe(true);
        expect(state.saved).toHaveLength(1);
    });

    test('a PDF-only enquiry sent twice is still de-duplicated to one quote', async () => {
        const { ctx, state } = makeCtx();
        const att = { name: 'enquiry.pdf', contentType: 'application/pdf', base64: b64('%PDF-1.4 fake pdf') };
        const first = await processOneEmail(ctx, email('PDF_DUP', { body: '', attachments: [att] }));
        const second = await processOneEmail(ctx, email('PDF_DUP', { body: '', attachments: [att] }));

        expect(first.success).toBe(true);
        expect(second.success).toBe(false);
        expect(second.error).toMatch(/Already imported/);
        expect(state.saved).toHaveLength(1);
    });
});

/** Build an attachment payload of a given name/type. */
const attach = (name, contentType, payload) => ({ name, contentType, base64: b64(payload || name) });

describe('Gmail ingest — multiple files in one email', () => {
    test('three PDFs on one email → one quote, and all three are sent to quote generation', async () => {
        const { ctx, state } = makeCtx();
        const atts = [
            attach('a.pdf', 'application/pdf', 'pdf-a'),
            attach('b.pdf', 'application/pdf', 'pdf-b'),
            attach('c.pdf', 'application/pdf', 'pdf-c'),
        ];
        const res = await processOneEmail(ctx, email('MULTI_PDF', { body: '', attachments: atts }));

        expect(res.success).toBe(true);
        expect(state.saved).toHaveLength(1);
        expect(state.generateArgs[0].enquiryFileIds).toHaveLength(3); // all three PDFs used
    });

    test('a mixed bundle (PDF + Excel + Word + image) on one email → one quote using all of it', async () => {
        const { ctx, state } = makeCtx();
        const atts = [
            attach('quote.pdf', 'application/pdf', 'pdf'),
            attach('requirement.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'),
            attach('spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'),
            attach('photo.jpg', 'image/jpeg', 'img'),
        ];
        const res = await processOneEmail(ctx, email('MIXED', { body: '', attachments: atts }));
        const gen = state.generateArgs[0];

        expect(res.success).toBe(true);
        expect(state.saved).toHaveLength(1);
        expect(gen.enquiryFileIds).toHaveLength(1);             // the PDF
        expect(gen.enquiryImageDataUrls).toHaveLength(1);       // the image
        expect(gen.emailContent).toContain('requirement.xlsx'); // Excel text folded in
        expect(gen.emailContent).toContain('spec.docx');        // Word text folded in
    });

    test('several spreadsheets/word docs → all of their text is folded into the enquiry', async () => {
        const { ctx, state } = makeCtx();
        const atts = [
            attach('sizes.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x1'),
            attach('rates.csv', 'text/csv', 'x2'),
            attach('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'w1'),
        ];
        const res = await processOneEmail(ctx, email('MULTI_DOCS', { body: '', attachments: atts }));
        const gen = state.generateArgs[0];

        expect(res.success).toBe(true);
        expect(gen.emailContent).toContain('sizes.xlsx');
        expect(gen.emailContent).toContain('rates.csv');
        expect(gen.emailContent).toContain('notes.docx');
    });

    test('several photos on one email → ALL of them are sent to the AI (page 2+ not dropped)', async () => {
        const { ctx, state } = makeCtx();
        const atts = [
            attach('first.jpg', 'image/jpeg', 'FIRST-IMAGE'),
            attach('second.jpg', 'image/jpeg', 'SECOND-IMAGE'),
        ];
        const res = await processOneEmail(ctx, email('MULTI_IMG', { body: '', attachments: atts }));
        const gen = state.generateArgs[0];

        expect(res.success).toBe(true);
        expect(gen.enquiryImageDataUrls).toHaveLength(2);       // both photos
        const joined = gen.enquiryImageDataUrls.join('|');
        expect(joined).toContain(b64('FIRST-IMAGE'));
        expect(joined).toContain(b64('SECOND-IMAGE'));
    });

    test('a multi-file email sent twice is still de-duplicated to one quote', async () => {
        const { ctx, state } = makeCtx();
        const atts = [attach('a.pdf', 'application/pdf', 'pdf-a'), attach('b.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x')];
        await processOneEmail(ctx, email('MULTI_DUP', { body: '', attachments: atts }));
        const second = await processOneEmail(ctx, email('MULTI_DUP', { body: '', attachments: atts }));

        expect(second.success).toBe(false);
        expect(state.saved).toHaveLength(1);
    });
});

describe('Gmail ingest — every supported file type is recognised', () => {
    const supported = [
        ['PDF',   'invoice.pdf',      'application/pdf'],
        ['Excel xlsx', 'req.xlsx',    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['Excel xls',  'req.xls',     'application/vnd.ms-excel'],
        ['CSV',   'rates.csv',        'text/csv'],
        ['Word docx', 'spec.docx',    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['Word doc',  'spec.doc',     'application/msword'],
        ['RTF',   'note.rtf',         'application/rtf'],
        ['PNG',   'pic.png',          'image/png'],
        ['JPEG',  'pic.jpg',          'image/jpeg'],
        ['GIF',   'pic.gif',          'image/gif'],
        ['WEBP',  'pic.webp',         'image/webp'],
    ];

    test.each(supported)('a %s-only enquiry (no body) creates a quote', async (_label, name, contentType) => {
        const { ctx, state } = makeCtx();
        const res = await processOneEmail(ctx, email('T_' + name, { body: '', attachments: [attach(name, contentType, 'bytes')] }));
        expect(res.success).toBe(true);
        expect(state.saved).toHaveLength(1);
    });

    test('an UNSUPPORTED-only attachment (e.g. .zip) with no body is rejected, not turned into a blank quote', async () => {
        const { ctx, state } = makeCtx();
        const res = await processOneEmail(ctx, email('ZIP_ONLY', { body: '', attachments: [attach('archive.zip', 'application/zip', 'zip')] }));
        expect(res.success).toBe(false);
        expect(res_err(res)).toMatch(/no body and no supported attachment/i);
        expect(state.saved).toHaveLength(0);
        expect(state.reserved.has('ZIP_ONLY')).toBe(false); // released → retryable if content arrives later
    });

    test('an attachment with no data (missing base64) is skipped without crashing', async () => {
        const { ctx, state } = makeCtx();
        const res = await processOneEmail(ctx, email('EMPTY_ATT', { body: 'Please quote', attachments: [{ name: 'x.pdf', contentType: 'application/pdf' }] }));
        expect(res.success).toBe(true); // body still carries the enquiry
        expect(state.saved).toHaveLength(1);
    });
});

/** Small helper so the empty-email assertion reads cleanly. */
function res_err(r) { return r && r.error ? String(r.error) : ''; }
