/**
 * Tests for quotation email composition and MIME building.
 *
 * Backend (real helpers via utils/gmail `_test` export):
 *   - buildRawMessage / extractInlineImages: base64 HTML body, data: image → inline
 *     CID rewrite, multipart/related (HTML + images) nested in multipart/mixed (+ PDF).
 *   - replySubject (routes/gmail): avoids "Re: Re:" doubling.
 *
 * Frontend (inline copies of pure logic from index.html):
 *   - fillEmailPlaceholders: [Name]/[Company]/[Quote Number] substitution.
 *   - buildQuotationEmailBodyHtml: single greeting (strips a duplicate), signature injected.
 *   - sticky-approval gate: everApproved lets an edited quote send without re-approval.
 */

const { _test } = require('../utils/gmail');
const { buildRawMessage, extractInlineImages } = _test;
const { replySubject } = require('../routes/gmail');

// Decode a base64url raw message back to the MIME string.
function decodeRaw(b64url) {
    return Buffer.from(b64url, 'base64url').toString('utf8');
}

const TINY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// =============================================================================
// extractInlineImages
// =============================================================================
describe('extractInlineImages', () => {
    test('rewrites a data: image to a cid: reference and collects the image', () => {
        const { html, inlineImages } = extractInlineImages(
            `<p>Hi</p><img src="data:image/png;base64,${TINY_PNG}">`
        );
        expect(html).toContain('src="cid:img1@dscpipes"');
        expect(html).not.toContain('data:image');
        expect(inlineImages).toHaveLength(1);
        expect(inlineImages[0].contentType).toBe('image/png');
        expect(inlineImages[0].base64).toBe(TINY_PNG);
    });

    test('leaves remote http(s) image URLs untouched', () => {
        const src = '<img src="https://example.com/logo.png">';
        const { html, inlineImages } = extractInlineImages(src);
        expect(html).toBe(src);
        expect(inlineImages).toHaveLength(0);
    });

    test('handles multiple data: images with distinct cids', () => {
        const { html, inlineImages } = extractInlineImages(
            `<img src="data:image/png;base64,${TINY_PNG}"><img src="data:image/gif;base64,${TINY_PNG}">`
        );
        expect(inlineImages).toHaveLength(2);
        expect(html).toContain('cid:img1@dscpipes');
        expect(html).toContain('cid:img2@dscpipes');
    });

    test('returns empty list when there are no images', () => {
        const { inlineImages } = extractInlineImages('<p>no images here</p>');
        expect(inlineImages).toHaveLength(0);
    });
});

// =============================================================================
// buildRawMessage — MIME structure
// =============================================================================
describe('buildRawMessage — plain HTML (no image, no PDF)', () => {
    const raw = decodeRaw(buildRawMessage({ to: 'a@b.com', subject: 'Hi', bodyHtml: '<p>Hello = world &amp; café</p>' }));

    test('is a single text/html part, not multipart', () => {
        expect(raw).toMatch(/Content-Type: text\/html/);
        expect(raw).not.toMatch(/multipart/);
    });

    test('body is base64-encoded and round-trips special chars', () => {
        const b64 = raw.split('Content-Transfer-Encoding: base64')[1].split('\r\n\r\n')[1].replace(/\r\n/g, '');
        expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('<p>Hello = world &amp; café</p>');
    });

    test('subject is RFC 2047 base64 word-encoded', () => {
        const enc = raw.split('=?UTF-8?B?')[1].split('?=')[0];
        expect(Buffer.from(enc, 'base64').toString('utf8')).toBe('Hi');
    });
});

describe('buildRawMessage — HTML with an inline data: image', () => {
    const raw = decodeRaw(buildRawMessage({
        to: 'a@b.com', subject: 'Sig',
        bodyHtml: `<p>Hi</p><img src="data:image/png;base64,${TINY_PNG}">`,
    }));

    test('wraps body + image in multipart/related', () => {
        expect(raw).toMatch(/Content-Type: multipart\/related/);
    });

    test('image carries Content-ID and inline disposition', () => {
        expect(raw).toMatch(/Content-ID: <img1@dscpipes>/);
        expect(raw).toMatch(/Content-Disposition: inline/);
    });

    test('no multipart/mixed when there is no PDF', () => {
        expect(raw).not.toMatch(/multipart\/mixed/);
    });
});

describe('buildRawMessage — HTML + inline image + PDF', () => {
    const raw = decodeRaw(buildRawMessage({
        to: 'a@b.com', subject: 'Full',
        bodyHtml: `<p>Hi</p><img src="data:image/png;base64,${TINY_PNG}">`,
        pdfBase64: 'JVBERi0xLjQK', pdfFilename: 'Quotation-DSC-1.pdf',
    }));

    test('top level is multipart/mixed', () => {
        expect(raw).toMatch(/Content-Type: multipart\/mixed/);
    });

    test('contains a nested multipart/related and the PDF part', () => {
        expect(raw).toMatch(/Content-Type: multipart\/related/);
        expect(raw).toMatch(/Content-Type: application\/pdf/);
        expect(raw).toMatch(/filename="Quotation-DSC-1\.pdf"/);
    });
});

describe('buildRawMessage — HTML + PDF, no image', () => {
    const raw = decodeRaw(buildRawMessage({
        to: 'a@b.com', subject: 'Q', bodyHtml: '<p>Q</p>',
        pdfBase64: 'JVBERi0xLjQK', pdfFilename: 'q.pdf',
    }));

    test('is multipart/mixed with html + pdf, no related', () => {
        expect(raw).toMatch(/Content-Type: multipart\/mixed/);
        expect(raw).toMatch(/Content-Type: application\/pdf/);
        expect(raw).not.toMatch(/multipart\/related/);
    });

    test('threads the reply when inReplyTo/references given', () => {
        const threaded = decodeRaw(buildRawMessage({
            to: 'a@b.com', subject: 'Q', bodyHtml: '<p>Q</p>',
            inReplyTo: '<orig@mail>', references: '<orig@mail>',
        }));
        expect(threaded).toMatch(/In-Reply-To: <orig@mail>/);
        expect(threaded).toMatch(/References: <orig@mail>/);
    });
});

// =============================================================================
// replySubject — no "Re: Re:" doubling
// =============================================================================
describe('replySubject', () => {
    test('prefixes a bare subject with "Re: "', () => {
        expect(replySubject('Quotation DSC-1')).toBe('Re: Quotation DSC-1');
    });

    test('does not double an existing Re:', () => {
        expect(replySubject('Re: Quotation DSC-1')).toBe('Re: Quotation DSC-1');
    });

    test('treats the existing prefix case-insensitively', () => {
        expect(replySubject('RE: hello')).toBe('RE: hello');
    });

    test('handles empty/undefined input', () => {
        expect(replySubject('')).toBe('Re: ');
        expect(replySubject(undefined)).toBe('Re: ');
    });
});

// =============================================================================
// Frontend pure logic — inline copies from index.html
// =============================================================================

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** index.html — fillEmailPlaceholders */
function fillEmailPlaceholders(text, quotation) {
    const name = (quotation.customerName || '').trim() || 'Sir/Madam';
    const company = (quotation.companyName || '').trim();
    const quoteNo = (quotation.quoteNumber || '').trim();
    return String(text || '')
        .replace(/\[\s*name\s*\]/gi, name)
        .replace(/\[\s*company\s*\]/gi, company)
        .replace(/\[\s*quote\s*(?:number|no\.?)?\s*\]/gi, quoteNo);
}

/** index.html — buildQuotationEmailBodyHtml (defaultEmailMessage/defaultSignature passed in for testing) */
function buildQuotationEmailBodyHtml(quotation, defaultEmailMessage, defaultSignature) {
    const name = (quotation.customerName || '').trim();
    const greeting = name ? `Dear ${name},` : 'Dear Sir/Madam,';
    let msg = (defaultEmailMessage || 'Please find attached our quotation as requested.').trim();
    msg = msg.replace(/^\s*dear\b[^,\n]*,\s*/i, '');
    msg = fillEmailPlaceholders(msg, quotation);
    const safeMsg = escapeHtml(msg).replace(/\n/g, '<br>');
    const signatureHtml = fillEmailPlaceholders((defaultSignature || 'Regards,<br>DSC Pipes'), quotation);
    return `<p>${escapeHtml(greeting)}</p><p>${safeMsg}</p><div>${signatureHtml}</div>`;
}

/** index.html — send gate: a quote must have been approved at least once */
function approvedAtLeastOnce(quotation) {
    return quotation.saved === true || quotation.everApproved === true;
}

describe('fillEmailPlaceholders', () => {
    const q = { customerName: 'Rajesh', companyName: 'Acme', quoteNumber: 'DSC-1900' };

    test('substitutes [Name], [Company], [Quote Number]', () => {
        expect(fillEmailPlaceholders('Hi [Name] from [Company] re [Quote Number]', q))
            .toBe('Hi Rajesh from Acme re DSC-1900');
    });

    test('[Name] falls back to Sir/Madam when no customer name', () => {
        expect(fillEmailPlaceholders('Dear [Name]', { quoteNumber: 'X' })).toBe('Dear Sir/Madam');
    });

    test('is case-insensitive and tolerates spaces', () => {
        expect(fillEmailPlaceholders('[ name ] / [QUOTE NO]', q)).toBe('Rajesh / DSC-1900');
    });
});

describe('buildQuotationEmailBodyHtml', () => {
    test('renders a single greeting even when the message also has one', () => {
        const html = buildQuotationEmailBodyHtml(
            { customerName: '', quoteNumber: 'DSC-1' },
            'Dear [Name],\n\nPlease find attached.', 'Regards,<br>DSC Pipes'
        );
        // exactly one "Dear ..."
        expect(html.match(/Dear /g)).toHaveLength(1);
        expect(html).toContain('Dear Sir/Madam,');
        expect(html).not.toContain('[Name]');
    });

    test('uses the customer name in the greeting when present', () => {
        const html = buildQuotationEmailBodyHtml({ customerName: 'Priya' }, 'Body', 'Regards,<br>DSC Pipes');
        expect(html).toContain('Dear Priya,');
    });

    test('injects the signature HTML (not escaped) at the end', () => {
        const html = buildQuotationEmailBodyHtml(
            { customerName: 'A' }, 'Body', 'Regards,<br>DSC Pipes Pvt Ltd'
        );
        expect(html).toContain('<div>Regards,<br>DSC Pipes Pvt Ltd</div>');
    });

    test('escapes the message body but fills its placeholders', () => {
        const html = buildQuotationEmailBodyHtml(
            { customerName: 'A', quoteNumber: 'DSC-9' }, 'Quote [Quote Number] <test>', 'sig'
        );
        expect(html).toContain('Quote DSC-9 &lt;test&gt;');
    });
});

describe('sticky-approval send gate (everApproved)', () => {
    test('blocks a never-approved draft', () => {
        expect(approvedAtLeastOnce({ saved: false })).toBe(false);
    });

    test('allows a currently-saved quote', () => {
        expect(approvedAtLeastOnce({ saved: true })).toBe(true);
    });

    test('allows an edited quote that was approved before (saved cleared, everApproved set)', () => {
        expect(approvedAtLeastOnce({ saved: false, everApproved: true })).toBe(true);
    });
});
