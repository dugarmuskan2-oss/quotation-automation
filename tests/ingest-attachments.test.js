/**
 * tests/ingest-attachments.test.js
 *
 * Attachment coverage on Gmail ingest (gmail-ingest/ingestLogic.js), driven
 * through an in-memory ctx. Proves the fixes to "does the app fetch ALL
 * attachments?":
 *   - EVERY enquiry image reaches the AI (not just the first) — multi-photo
 *     requirements come through whole.
 *   - Every PDF is uploaded to OpenAI.
 *   - Excel/Word text is folded into the enquiry body.
 *   - Retention persists EVERY attachment of every type (including unreadable
 *     ones like .zip) so they stay viewable on the quote card.
 */

const { processOneEmail } = require('../gmail-ingest/ingestLogic');

const b64 = (s) => Buffer.from(s).toString('base64');

function makeCtx() {
    const state = { generateOpts: null, uploaded: [], saved: null, retained: [] };
    let fileSeq = 0;
    const ctx = {
        getInstructionsContent: async () => 'INSTRUCTIONS',
        getDefaultTermsContent: async () => 'TERMS',
        generateQuotationData: async (opts) => {
            state.generateOpts = opts;
            return { customerName: 'Cust', companyName: 'Co', lineItems: [] };
        },
        getNextQuoteNumber: async () => 108,
        saveQuotation: async (q) => { state.saved = q; },
        uploadEnquiryFileToOpenAI: async (f) => { state.uploaded.push(f.originalname); return 'file_' + (++fileSeq); },
        extractTextFromAttachment: async ({ originalname }) => 'ROWS FROM ' + originalname,
        saveEnquiryFile: async ({ fileName }) => { state.retained.push(fileName); return 'enquiries/' + fileName; },
    };
    return { ctx, state };
}

const MULTI_ATTACHMENT_EMAIL = {
    id: 'msg-multi',
    body: '',   // empty body — forces reliance on attachments
    attachments: [
        { name: 'requirement.pdf', contentType: 'application/pdf', base64: b64('PDF ONE') },
        { name: 'annexure.pdf',    contentType: 'application/pdf', base64: b64('PDF TWO') },
        { name: 'sizes.xlsx',      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: b64('XLS') },
        { name: 'page1.jpg',       contentType: 'image/jpeg', base64: b64('IMG 1') },
        { name: 'page2.jpg',       contentType: 'image/jpeg', base64: b64('IMG 2') },
        { name: 'page3.jpg',       contentType: 'image/jpeg', base64: b64('IMG 3') },
        { name: 'bundle.zip',      contentType: 'application/zip', base64: b64('ZIP') },
    ],
};

describe('Gmail ingest — every image reaches the AI', () => {
    test('all THREE photos are sent (multi-page requirement), not just the first', async () => {
        const { ctx, state } = makeCtx();
        const r = await processOneEmail(ctx, MULTI_ATTACHMENT_EMAIL);
        expect(r.success).toBe(true);
        const urls = state.generateOpts.enquiryImageDataUrls;
        expect(Array.isArray(urls)).toBe(true);
        expect(urls).toHaveLength(3);
        urls.forEach((u) => expect(u.startsWith('data:image/jpeg;base64,')).toBe(true));
        // the legacy single-image field is no longer used
        expect(state.generateOpts.enquiryImageDataUrl).toBeUndefined();
    });

    test('the empty-body placeholder mentions the image count', async () => {
        const { ctx, state } = makeCtx();
        // images-only, empty body → the placeholder tells the AI to read all pages
        await processOneEmail(ctx, { id: 'imgs', body: '', attachments: [
            { name: 'p1.jpg', contentType: 'image/jpeg', base64: b64('A') },
            { name: 'p2.jpg', contentType: 'image/jpeg', base64: b64('B') },
        ] });
        expect(state.generateOpts.emailContent).toMatch(/2 attached images/);
    });

    test('a single image still works (data url passed as a 1-element array)', async () => {
        const { ctx, state } = makeCtx();
        await processOneEmail(ctx, { id: 'm1', body: '', attachments: [{ name: 'p.jpg', contentType: 'image/jpeg', base64: b64('ONE') }] });
        expect(state.generateOpts.enquiryImageDataUrls).toHaveLength(1);
    });
});

describe('Gmail ingest — PDFs and Excel/Word', () => {
    test('every PDF is uploaded to OpenAI', async () => {
        const { ctx, state } = makeCtx();
        await processOneEmail(ctx, MULTI_ATTACHMENT_EMAIL);
        expect(state.uploaded).toEqual(['requirement.pdf', 'annexure.pdf']);
        expect(state.generateOpts.enquiryFileIds).toHaveLength(2);
    });

    test('Excel text is folded into the enquiry body', async () => {
        const { ctx, state } = makeCtx();
        await processOneEmail(ctx, MULTI_ATTACHMENT_EMAIL);
        expect(state.generateOpts.emailContent).toMatch(/ROWS FROM sizes\.xlsx/);
    });
});

describe('Gmail ingest — retention keeps EVERY attachment', () => {
    test('all seven attachments are persisted, including the unreadable .zip', async () => {
        const { ctx, state } = makeCtx();
        await processOneEmail(ctx, MULTI_ATTACHMENT_EMAIL);
        expect(state.retained).toHaveLength(7);
        // retained file names carry the original name; the zip is there too
        expect(state.retained.some((n) => n.includes('bundle.zip'))).toBe(true);
        // and they are recorded on the saved quote for the card to view
        expect(state.saved.enquiryFiles).toHaveLength(7);
        const names = state.saved.enquiryFiles.map((f) => f.name);
        expect(names).toEqual(expect.arrayContaining(['requirement.pdf', 'page3.jpg', 'bundle.zip']));
    });
});
