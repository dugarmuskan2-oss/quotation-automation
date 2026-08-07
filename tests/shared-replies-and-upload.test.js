/*
    Two things the customer or the user actually sees:

      - the shared Copy Link page's timeline, where a supplier/transporter reply used to be a
        dead label that never showed what was said;
      - the enquiry upload, where a photographed enquiry was refused instead of shrunk.

    Both are extracted from index.html and run for real, so the escaping and the branch
    conditions are exercised rather than described.
*/
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull a named function out of index.html by brace matching (same approach as the other
// index.html suites — the code is browser-only and cannot be required).
function extractFunction(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}
function loadFns(names, extras) {
    const body = names.map((n) => extractFunction(html, n)).join('\n');
    const keys = Object.keys(extras || {});
    // eslint-disable-next-line no-new-func
    const factory = new Function(...keys, body + '\nreturn ' + names[names.length - 1] + ';');
    return factory(...keys.map((k) => extras[k]));
}

// ── The shared page's enquiry timeline ───────────────────────────────────────
describe('buildSharedEnquiryEvents — a reply is readable, not just recorded', () => {
    const buildSharedEnquiryEvents = loadFns(
        ['escapeHtml', 'buildSharedEnquiryEvents'],
        { formatRevisionDate: (d) => String(d).slice(0, 10) },
    );

    const freightThread = {
        email: 'ravi@transport.com', threadId: 't1', sentAt: '2026-08-04T09:00:00Z',
        replied: true, replyAt: '2026-08-05T11:00:00Z', amount: 42000,
        replyText: 'Our rate Chennai to Hyderabad is Rs 42,000 all inclusive.\nDelivery in 3 days.',
    };
    const supplierThread = {
        email: 'manish@jcopipe.com', threadId: 't2', sentAt: '2026-08-04T10:00:00Z',
        replied: true, replyAt: '2026-08-05T12:00:00Z',
        replyText: '2" NB Medium ERW — Rs 148/mtr ex-works. Validity 7 days.',
    };

    test('a freight reply becomes clickable and carries the transporter\'s own words', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({ freightEnquiries: [freightThread] }, sink).map((e) => e.html).join('');
        expect(out).toContain('Freight rate received');
        expect(out).toContain('view reply');
        const body = sink.find((b) => b.title === 'Freight rate received');
        expect(body).toBeTruthy();
        expect(body.html).toContain('42,000 all inclusive');
        expect(body.html).toContain('Delivery in 3 days');
    });

    test('a supplier reply does the same', () => {
        const sink = [];
        buildSharedEnquiryEvents({ supplierEnquiries: [supplierThread] }, sink);
        const body = sink.find((b) => b.title === 'Supplier offer received');
        expect(body.html).toContain('Validity 7 days');
    });

    test('the reply keeps its line breaks instead of collapsing into one paragraph', () => {
        const sink = [];
        buildSharedEnquiryEvents({ freightEnquiries: [freightThread] }, sink);
        expect(sink[0].html).toContain('pre-wrap');
    });

    test('a reply is ESCAPED — a supplier\'s text cannot inject markup into the shared page', () => {
        const sink = [];
        buildSharedEnquiryEvents({
            supplierEnquiries: [Object.assign({}, supplierThread, {
                replyText: '<img src=x onerror=alert(1)> best rate',
            })],
        }, sink);
        expect(sink[0].html).not.toContain('<img');
        expect(sink[0].html).toContain('&lt;img');
    });

    test('a thread with NO stored reply text stays a plain line, offering nothing to open', () => {
        // Enquiries answered before the reply was stored have nothing to show; a "view reply"
        // link that opens an empty box is worse than no link.
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [Object.assign({}, freightThread, { replyText: '' })],
        }, sink).map((e) => e.html).join('');
        expect(out).toContain('Freight rate received');
        expect(out).not.toContain('view reply');
        expect(sink.filter((b) => b.title === 'Freight rate received')).toHaveLength(0);
    });

    test('a sent enquiry still says "view enquiry", not "view reply"', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            supplierEnquiries: [supplierThread],
            enquirySentBodies: { 'send:2026-08-04T10:00:00Z': '<p>the enquiry we sent</p>' },
        }, sink).map((e) => e.html).join('');
        expect(out).toContain('view enquiry');
        expect(sink.some((b) => b.html.includes('the enquiry we sent'))).toBe(true);
    });

    test('an unanswered enquiry produces a sent event and no reply event', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: 'a@b.com', sentAt: '2026-08-04T09:00:00Z', replied: false }],
        }, []);
        expect(events).toHaveLength(1);
        expect(events[0].html).toContain('Freight enquiry sent');
    });
});

// ── The oversized enquiry file ───────────────────────────────────────────────
describe('isImageFileName — decides what can be shrunk rather than refused', () => {
    const isImageFileName = loadFns(['isImageFileName']);

    test('the photo formats a scanned enquiry actually arrives in are recognised', () => {
        ['scan.jpg', 'SCAN.JPEG', 'photo.png', 'shot.HEIC', 'x.webp', 'y.bmp', 'z.gif']
            .forEach((n) => expect(isImageFileName(n)).toBe(true));
    });

    test('a PDF is not an image — it must fall through to the size check', () => {
        // Silently trying to canvas-shrink a PDF would send an empty file to the AI.
        ['enquiry.pdf', 'sheet.xlsx', 'letter.docx', 'notes.txt', ''].forEach((n) =>
            expect(isImageFileName(n)).toBe(false));
    });

    test('an extension buried mid-name does not count', () => {
        expect(isImageFileName('report.pdf.summary')).toBe(false);
        expect(isImageFileName('my.png.pdf')).toBe(false);
    });
});

describe('source guards — the upload path shrinks first, then refuses', () => {
    test('the image shrink runs BEFORE the size gate, or a big photo is still turned away', () => {
        const shrink = html.indexOf('await shrinkEnquiryImage(file)');
        const gate = html.indexOf('file.size > MAX_ENQUIRY_FILE_BYTES');
        expect(shrink).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(-1);
        expect(shrink).toBeLessThan(gate);
    });

    test('the shrink is attempted only for images, and only when they are big', () => {
        expect(html).toMatch(/if \(file && isImageFileName\(file\.name\) && file\.size > ENQUIRY_IMAGE_TARGET_BYTES\)/);
    });

    test('a failed shrink sends the original rather than losing the file', () => {
        expect(html).toMatch(/try \{ file = await shrinkEnquiryImage\(file\); \} catch \(e\) \{[^}]*\}/);
    });

    test('the client limit matches the server\'s, so the message it prints is true', () => {
        const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const clientMb = /const MAX_ENQUIRY_FILE_BYTES = (\d+) \* 1024 \* 1024;/.exec(html);
        const serverMb = /const MAX_UPLOAD_SIZE_BYTES = (\d+) \* 1024 \* 1024;/.exec(server);
        expect(clientMb).toBeTruthy();
        expect(serverMb).toBeTruthy();
        expect(clientMb[1]).toBe(serverMb[1]);
    });

    test('the server names the size instead of answering "Internal Server Error"', () => {
        const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        expect(server).toContain("err.code === 'LIMIT_FILE_SIZE'");
        expect(server).toMatch(/status\(413\)/);
    });
});
