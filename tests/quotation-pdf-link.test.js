/**
 * @jest-environment node
 *
 * tests/quotation-pdf-link.test.js
 *
 * The "Copy Link -> PDF preview" feature. Each quote card has a 🔗 Copy Link
 * button that copies a "?quote=ID&view=pdf" URL; opening that URL boots the page
 * in preview mode and shows ONLY that quote's PDF (not the editable card).
 *
 * The two pure helpers (buildQuotationPdfLink, getPreviewLinkQuoteId) live inline
 * in the browser-only SPA (index.html), so this test extracts them by name
 * (brace-matching) and evals them with a fake `window` — same approach as
 * tests/revision-signature.test.js / tests/description-format.test.js. The rest
 * of the wiring (button render, preview render path, save-gate bypass, app-boot
 * short-circuit) is checked with source guards. If any of these functions are
 * renamed, update the names / guard strings here.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

// Pull a top-level `function name(...) { ... }` out of source by brace-matching.
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

// Load an extracted function with a set of injected globals (e.g. a fake window).
function loadFn(name, sandbox) {
    const src = extractFunction(html, name);
    const keys = Object.keys(sandbox);
    const vals = keys.map(function(k) { return sandbox[k]; });
    // eslint-disable-next-line no-new-func
    const factory = new Function(keys.join(','), src + '\nreturn ' + name + ';');
    return factory.apply(null, vals);
}

const fakeWindow = (origin, pathname, search) => ({
    location: { origin: origin, pathname: pathname, search: search === undefined ? '' : search },
});

describe('buildQuotationPdfLink — builds the shareable ?quote=..&view=pdf URL', () => {
    test('root-served app: origin + "/" + query', () => {
        const build = loadFn('buildQuotationPdfLink', { window: fakeWindow('https://app.example.com', '/') });
        expect(build('DSC-108')).toBe('https://app.example.com/?quote=DSC-108&view=pdf');
    });

    test('always ends with the view=pdf marker (so the opener knows to show the PDF)', () => {
        const build = loadFn('buildQuotationPdfLink', { window: fakeWindow('https://app.example.com', '/') });
        expect(build('DSC-108').endsWith('&view=pdf')).toBe(true);
    });

    test('preserves a non-root path (e.g. app served under a subfolder)', () => {
        const build = loadFn('buildQuotationPdfLink', { window: fakeWindow('https://x.io', '/quotation/') });
        expect(build('42')).toBe('https://x.io/quotation/?quote=42&view=pdf');
    });

    test('URL-encodes ids containing spaces / ampersands (no query breakage)', () => {
        const build = loadFn('buildQuotationPdfLink', { window: fakeWindow('https://app.example.com', '/') });
        expect(build('DSC 1&2')).toBe('https://app.example.com/?quote=DSC%201%262&view=pdf');
    });

    test('handles a numeric backend id', () => {
        const build = loadFn('buildQuotationPdfLink', { window: fakeWindow('https://app.example.com', '/') });
        expect(build(1783593483622)).toBe('https://app.example.com/?quote=1783593483622&view=pdf');
    });

    test('uses the live origin, so localhost and the deployed site each build their own link', () => {
        const local = loadFn('buildQuotationPdfLink', { window: fakeWindow('http://localhost:3000', '/') });
        const prod = loadFn('buildQuotationPdfLink', { window: fakeWindow('https://quotes.dscpipes.com', '/') });
        expect(local('DSC-9')).toBe('http://localhost:3000/?quote=DSC-9&view=pdf');
        expect(prod('DSC-9')).toBe('https://quotes.dscpipes.com/?quote=DSC-9&view=pdf');
    });
});

describe('getPreviewLinkQuoteId — reads the quote id only from a genuine preview link', () => {
    const idFor = (search) => loadFn('getPreviewLinkQuoteId', { window: fakeWindow('http://x', '/', search) })();

    test('returns the id when view=pdf and quote are both present', () => {
        expect(idFor('?quote=1783593483622&view=pdf')).toBe('1783593483622');
    });

    test('order of params does not matter', () => {
        expect(idFor('?view=pdf&quote=DSC-108')).toBe('DSC-108');
    });

    test('view flag is case-insensitive', () => {
        expect(idFor('?quote=7&view=PDF')).toBe('7');
    });

    test('decodes an encoded id', () => {
        expect(idFor('?view=pdf&quote=DSC%201%262')).toBe('DSC 1&2');
    });

    test('no view=pdf -> not a preview link -> empty (app boots normally)', () => {
        expect(idFor('?quote=123')).toBe('');
    });

    test('a different view value -> empty', () => {
        expect(idFor('?quote=123&view=card')).toBe('');
    });

    test('view=pdf but no quote -> empty (nothing to show)', () => {
        expect(idFor('?view=pdf')).toBe('');
    });

    test('empty query string -> empty', () => {
        expect(idFor('')).toBe('');
    });

    test('never throws on messy input', () => {
        expect(() => idFor('?%%%&&view=pdf')).not.toThrow();
    });
});

describe('source guard — the 🔗 Copy Link button is rendered on the quote card', () => {
    test('renderApprovalFolderContent builds a Copy Link button wired to copyQuotationPdfLink', () => {
        expect(html).toContain('copyQuotationPdfLink(');
        expect(html).toContain('🔗 Copy Link');
    });

    test('the button is passed through buildApprovalSplitLayout into the action row', () => {
        expect(html).toContain('sendButtonHTML, copyLinkButtonHTML });');
        expect(html).toContain('${copyLinkButtonHTML || \'\'}');
    });
});

describe('source guard — a preview link shows ONLY the PDF and skips the editable card', () => {
    test('downloadQuotationPdf has a preview branch that returns a blob URL to embed', () => {
        expect(html).toContain('const isPreview = !!(options && options.preview);');
        expect(html).toContain("return { blobUrl: String(doc.output('bloburl')), filename };");
    });

    test('preview bypasses the unsaved-edits save gate (read-only view of a saved quote)', () => {
        expect(html).toContain('!isPreview && !canDownloadQuotation(quotation)');
    });

    test('preview does not read the folder DOM (renders from stored data)', () => {
        expect(html).toContain("const folderContent = isPreview ? null : document.getElementById('folder-content-' + quotationId);");
    });

    test('showPreviewPdf embeds the PDF in a full-screen iframe (not a navigation away)', () => {
        expect(html).toContain('function showPreviewPdf');
        expect(html).toContain("createElement('iframe')");
    });
});

describe('source guard — a preview link short-circuits the normal app boot', () => {
    test('handleQuotationPdfPreviewLink gates the initialization block', () => {
        expect(html).toContain('function handleQuotationPdfPreviewLink');
        expect(html).toContain('if (handleQuotationPdfPreviewLink()) {');
    });

    test('the preview handler fetches the single quote by id', () => {
        expect(html).toContain('/quotations/${encodeURIComponent(quoteId)}');
    });
});
