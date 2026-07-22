/**
 * @jest-environment node
 *
 * tests/enquiry-files-preview.test.js
 *
 * buildEnquiryFilesChipsHTML — the ATTACHED FILES row on the quote card:
 * clickable chips for retained/uploaded originals (enquiryFiles) + non-clickable
 * amber info chips for originals that weren't forwarded (enquiryFileNotes, e.g.
 * an oversized PDF whose text was extracted). Extracted from index.html and
 * eval'd (same approach as tests/revision-signature.test.js).
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

function loadFns(names, sandbox) {
    const body = names.map((n) => extractFunction(html, n)).join('\n');
    const keys = Object.keys(sandbox || {});
    // eslint-disable-next-line no-new-func
    return new Function(keys.join(','), body + '\nreturn ' + names[names.length - 1] + ';').apply(null, keys.map((k) => sandbox[k]));
}

const build = loadFns(
    ['escapeHtml', 'enquiryFileViewUrl', 'isImageEnquiryAttachment', 'buildEnquiryFilesChipsHTML'],
    { API_BASE_URL: '/api' }
);

const imgFile = { name: 'photo.jpg', key: 'enquiries/1-photo.jpg', contentType: 'image/jpeg' };
const pdfFile = { name: 'quote.pdf', key: 'enquiries/1-quote.pdf', contentType: 'application/pdf' };

describe('buildEnquiryFilesChipsHTML — clickable file chips', () => {
    test('no files and no notes -> empty (older quotes render nothing)', () => {
        expect(build({})).toBe('');
        expect(build({ enquiryFiles: [], enquiryFileNotes: [] })).toBe('');
    });

    test('a retained file is a clickable link to the view route', () => {
        const h = build({ enquiryFiles: [pdfFile] });
        expect(h).toContain('ATTACHED FILES');
        // escapeHtml turns the & separator into &amp; inside the attribute
        expect(h).toContain('<a href="/api/view-enquiry-file?key=enquiries%2F1-quote.pdf&amp;name=quote.pdf"');
        expect(h).toContain('quote.pdf');
        expect(h).toContain('📄');
    });

    test('an image file gets the image icon', () => {
        expect(build({ enquiryFiles: [imgFile] })).toContain('🖼️');
    });
});

describe('buildEnquiryFilesChipsHTML — non-clickable info chips', () => {
    const note = { name: 'huge.pdf', note: 'text extracted (original too large to attach)' };

    test('a note renders as an amber chip showing the name and note, with no link', () => {
        const h = build({ enquiryFileNotes: [note] });
        expect(h).toContain('ATTACHED FILES');
        expect(h).toContain('FAEEDA');                 // amber background = info chip
        expect(h).toContain('huge.pdf');
        expect(h).toContain('text extracted');
        expect(h).not.toContain('href');               // info chip is not a link
    });

    test('notes show even when there are no real files', () => {
        expect(build({ enquiryFiles: [], enquiryFileNotes: [note] })).toContain('huge.pdf');
    });

    test('real files come first, then the info chips', () => {
        const h = build({ enquiryFiles: [pdfFile], enquiryFileNotes: [note] });
        expect(h.indexOf('quote.pdf')).toBeLessThan(h.indexOf('huge.pdf'));
        expect(h).toContain('<a href');                // the real file is still clickable
    });
});

describe('buildEnquiryFilesChipsHTML — XSS safety', () => {
    test('malicious file/note names are escaped', () => {
        const h = build({
            enquiryFiles: [{ name: '<img src=x onerror=alert(1)>.pdf', key: 'enquiries/x', contentType: 'application/pdf' }],
            enquiryFileNotes: [{ name: '<script>evil()</script>', note: '<b>bad</b>' }],
        });
        // the dangerous markup must be neutralised — no live tags, only escaped text
        expect(h).not.toContain('<script>evil');
        expect(h).not.toContain('<img src=x');
        expect(h).toContain('&lt;script&gt;');
        expect(h).toContain('&lt;img');
    });
});
