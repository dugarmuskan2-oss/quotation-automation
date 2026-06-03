/**
 * Unit tests for print-button functionality (index.html client-side logic).
 *
 * Covers:
 *   canDownloadQuotation     — gate check (no unsaved edits) ~line 5451
 *   getBlockedAlertMessage   — "Print" vs "Download" alert text ~line 7743
 *   getFolderDisplayName     — quotation display-name builder ~line 6850
 *   getPdfFilename           — filename with safe-char replacement ~line 8089
 *   applyPdfOutput           — autoPrint+window.open vs doc.save routing ~line 8090
 *   buildPrintButtonHTML     — button HTML (onclick, label) ~line 6003
 *   buildButtonBar           — printButtonHTML slot order in layout ~line 5816
 *
 * NOTE: The pure functions below are intentionally duplicated from index.html
 * because index.html is not a Node module.  Whenever the originals change,
 * update the copies here too (line numbers are noted above for quick lookup).
 */

'use strict';

// ─── Inline copies of the pure functions under test ──────────────────────────

/** index.html ~5451 */
function canDownloadQuotation(quotation) {
    return !(quotation && quotation.hasUnsavedEdits === true);
}

/** index.html ~7743 — message shown when the gate blocks */
function getBlockedAlertMessage(options) {
    return (options && options.print) ? 'Please save changes to Print' : 'Please save changes to Download';
}

/** index.html ~6850 */
function getFolderDisplayName(quotation) {
    const companyName = (quotation.companyName || quotation.projectName || '').trim();
    const kindAttn    = (quotation.customerName || '').trim();
    const quoteNumber = (quotation.quoteNumber  || '').trim();
    const parts = [companyName, kindAttn, quoteNumber].filter(Boolean);
    return parts.length ? parts.join(' - ') : (quotation.customerName || 'Quotation');
}

/** index.html ~8089 */
function getPdfFilename(quotation) {
    return `Quotation-${getFolderDisplayName(quotation).replace(/[/\\?%*:|"<>]/g, '-')}.pdf`;
}

/**
 * Mirrors the final output block of downloadQuotationPdf (index.html ~8090).
 * Accepts a mock jsPDF doc so tests don't need a real PDF renderer.
 * Returns { mode, blobUrl? } so callers can assert without side-effects.
 */
function applyPdfOutput(doc, options, filename) {
    if (options && options.print) {
        doc.autoPrint();
        const blobUrl = doc.output('bloburl');
        return { mode: 'print', blobUrl };
    } else {
        doc.save(filename);
        return { mode: 'download' };
    }
}

/** index.html ~6003 */
function buildPrintButtonHTML(quotationId) {
    return `<button class="save-btn" type="button" onclick="event.stopPropagation(); printQuotationPdf(${JSON.stringify(quotationId)})">🖨️ Print</button>`;
}

/**
 * Mirrors the button-bar <div> inside buildApprovalSplitLayout (index.html ~5816).
 * Kept minimal so it can be tested without the surrounding DOM helpers.
 */
function buildButtonBar({ approveButtonHTML, saveButtonHTML, printButtonHTML, downloadButtonHTML }) {
    return `<div style="margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap;">
        ${approveButtonHTML}
        ${saveButtonHTML  || ''}
        ${printButtonHTML || ''}
        ${downloadButtonHTML}
    </div>`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// =============================================================================
// canDownloadQuotation
// =============================================================================
describe('canDownloadQuotation', () => {
    test('returns true when hasUnsavedEdits is not set', () => {
        expect(canDownloadQuotation({ id: '1' })).toBe(true);
    });

    test('returns true when hasUnsavedEdits is false', () => {
        expect(canDownloadQuotation({ id: '1', hasUnsavedEdits: false })).toBe(true);
    });

    test('returns false when hasUnsavedEdits is true', () => {
        expect(canDownloadQuotation({ id: '1', hasUnsavedEdits: true })).toBe(false);
    });

    test('returns true for null (nothing to block)', () => {
        expect(canDownloadQuotation(null)).toBe(true);
    });

    test('returns true for undefined', () => {
        expect(canDownloadQuotation(undefined)).toBe(true);
    });

    test('hasUnsavedEdits string "true" does NOT block — must be boolean', () => {
        // The check is strict ===; a stray string value should not block.
        expect(canDownloadQuotation({ hasUnsavedEdits: 'true' })).toBe(true);
    });
});

// =============================================================================
// getBlockedAlertMessage  — "Print" vs "Download" wording
// =============================================================================
describe('getBlockedAlertMessage', () => {
    test('says "Print" when options.print is true', () => {
        expect(getBlockedAlertMessage({ print: true })).toBe('Please save changes to Print');
    });

    test('says "Download" when options is null', () => {
        expect(getBlockedAlertMessage(null)).toBe('Please save changes to Download');
    });

    test('says "Download" when options is undefined', () => {
        expect(getBlockedAlertMessage(undefined)).toBe('Please save changes to Download');
    });

    test('says "Download" when options.print is false', () => {
        expect(getBlockedAlertMessage({ print: false })).toBe('Please save changes to Download');
    });

    test('says "Download" when options is an empty object', () => {
        expect(getBlockedAlertMessage({})).toBe('Please save changes to Download');
    });
});

// =============================================================================
// getFolderDisplayName
// =============================================================================
describe('getFolderDisplayName', () => {
    test('joins companyName, customerName and quoteNumber with " - "', () => {
        expect(getFolderDisplayName({
            companyName: 'Acme', customerName: 'John', quoteNumber: 'Q-001',
        })).toBe('Acme - John - Q-001');
    });

    test('falls back to projectName when companyName is absent', () => {
        expect(getFolderDisplayName({
            projectName: 'Bridge Project', customerName: 'Jane', quoteNumber: 'Q-002',
        })).toBe('Bridge Project - Jane - Q-002');
    });

    test('companyName takes precedence over projectName', () => {
        expect(getFolderDisplayName({
            companyName: 'DSC', projectName: 'Old Project',
        })).toBe('DSC');
    });

    test('omits empty parts — no leading/trailing " - "', () => {
        expect(getFolderDisplayName({ companyName: 'DSC', quoteNumber: 'Q-100' })).toBe('DSC - Q-100');
    });

    test('returns customerName alone when only that field is set', () => {
        expect(getFolderDisplayName({ customerName: 'Only Customer' })).toBe('Only Customer');
    });

    test('returns "Quotation" fallback when all fields are empty', () => {
        expect(getFolderDisplayName({})).toBe('Quotation');
    });

    test('trims whitespace from each part', () => {
        expect(getFolderDisplayName({ companyName: '  DSC  ', quoteNumber: '  Q-5  ' }))
            .toBe('DSC - Q-5');
    });
});

// =============================================================================
// getPdfFilename  — safe character replacement
// =============================================================================
describe('getPdfFilename', () => {
    test('wraps display name with "Quotation-" prefix and ".pdf" suffix', () => {
        expect(getPdfFilename({ companyName: 'Acme', quoteNumber: 'Q-001' }))
            .toMatch(/^Quotation-.+\.pdf$/);
    });

    test('replaces forward slash (common in DSC quote numbers)', () => {
        const name = getPdfFilename({ quoteNumber: 'DSC/2024/001' });
        expect(name).not.toContain('/');
    });

    test('replaces backslash', () => {
        expect(getPdfFilename({ companyName: 'A\\B' })).not.toContain('\\');
    });

    test('replaces colon', () => {
        expect(getPdfFilename({ companyName: 'A:B' })).not.toContain(':');
    });

    test('replaces asterisk', () => {
        expect(getPdfFilename({ companyName: 'A*B' })).not.toContain('*');
    });

    test('replaces pipe', () => {
        expect(getPdfFilename({ companyName: 'A|B' })).not.toContain('|');
    });

    test('replaces question-mark', () => {
        expect(getPdfFilename({ companyName: 'A?B' })).not.toContain('?');
    });

    test('replaces percent sign', () => {
        expect(getPdfFilename({ companyName: 'A%B' })).not.toContain('%');
    });

    test('replaces angle brackets', () => {
        const name = getPdfFilename({ companyName: 'A<B>C' });
        expect(name).not.toContain('<');
        expect(name).not.toContain('>');
    });

    test('replaces double-quote', () => {
        expect(getPdfFilename({ companyName: 'A"B' })).not.toContain('"');
    });

    test('produces the correct filename for a real DSC quote number', () => {
        expect(getPdfFilename({ companyName: 'DSC Pipes', quoteNumber: 'DSC/2024/1726' }))
            .toBe('Quotation-DSC Pipes - DSC-2024-1726.pdf');
    });

    test('uses "Quotation" fallback name when quotation is empty', () => {
        expect(getPdfFilename({})).toBe('Quotation-Quotation.pdf');
    });
});

// =============================================================================
// applyPdfOutput  — print mode (autoPrint + bloburl)
// =============================================================================
describe('applyPdfOutput — print mode', () => {
    let doc;

    beforeEach(() => {
        doc = {
            autoPrint: jest.fn(),
            output:    jest.fn().mockReturnValue('blob:http://localhost/fake'),
            save:      jest.fn(),
        };
    });

    test('calls doc.autoPrint() exactly once', () => {
        applyPdfOutput(doc, { print: true }, 'x.pdf');
        expect(doc.autoPrint).toHaveBeenCalledTimes(1);
    });

    test('calls doc.output("bloburl")', () => {
        applyPdfOutput(doc, { print: true }, 'x.pdf');
        expect(doc.output).toHaveBeenCalledWith('bloburl');
    });

    test('does NOT call doc.save()', () => {
        applyPdfOutput(doc, { print: true }, 'x.pdf');
        expect(doc.save).not.toHaveBeenCalled();
    });

    test('returns { mode: "print", blobUrl }', () => {
        const result = applyPdfOutput(doc, { print: true }, 'x.pdf');
        expect(result.mode).toBe('print');
        expect(result.blobUrl).toBe('blob:http://localhost/fake');
    });
});

// =============================================================================
// applyPdfOutput  — download mode (doc.save)
// =============================================================================
describe('applyPdfOutput — download mode', () => {
    let doc;

    beforeEach(() => {
        doc = {
            autoPrint: jest.fn(),
            output:    jest.fn(),
            save:      jest.fn(),
        };
    });

    test('calls doc.save(filename) when options is null', () => {
        applyPdfOutput(doc, null, 'Quotation-Acme.pdf');
        expect(doc.save).toHaveBeenCalledWith('Quotation-Acme.pdf');
    });

    test('calls doc.save(filename) when options is undefined', () => {
        applyPdfOutput(doc, undefined, 'Quotation-Acme.pdf');
        expect(doc.save).toHaveBeenCalledWith('Quotation-Acme.pdf');
    });

    test('calls doc.save(filename) when options.print is false', () => {
        applyPdfOutput(doc, { print: false }, 'Quotation-Acme.pdf');
        expect(doc.save).toHaveBeenCalledWith('Quotation-Acme.pdf');
    });

    test('does NOT call autoPrint() or output() in download mode', () => {
        applyPdfOutput(doc, null, 'x.pdf');
        expect(doc.autoPrint).not.toHaveBeenCalled();
        expect(doc.output).not.toHaveBeenCalled();
    });

    test('returns { mode: "download" }', () => {
        expect(applyPdfOutput(doc, null, 'x.pdf').mode).toBe('download');
    });
});

// =============================================================================
// buildPrintButtonHTML
// =============================================================================
describe('buildPrintButtonHTML', () => {
    test('renders the 🖨️ Print label', () => {
        expect(buildPrintButtonHTML('abc')).toContain('🖨️ Print');
    });

    test('calls printQuotationPdf with a string id', () => {
        expect(buildPrintButtonHTML('abc')).toContain('printQuotationPdf("abc")');
    });

    test('calls printQuotationPdf with a numeric id (JSON-safe)', () => {
        expect(buildPrintButtonHTML(42)).toContain('printQuotationPdf(42)');
    });

    test('stops event propagation', () => {
        expect(buildPrintButtonHTML('x')).toContain('event.stopPropagation()');
    });

    test('is a <button> with class "save-btn"', () => {
        const html = buildPrintButtonHTML('x');
        expect(html).toMatch(/<button[^>]+class="save-btn"/);
        expect(html).toMatch(/<\/button>/);
    });

    test('has type="button" (prevents accidental form submit)', () => {
        expect(buildPrintButtonHTML('x')).toContain('type="button"');
    });
});

// =============================================================================
// buildButtonBar  — printButtonHTML slot in the layout
// =============================================================================
describe('buildButtonBar — printButtonHTML slot', () => {
    const base = {
        approveButtonHTML:  '<button id="a">Approve</button>',
        saveButtonHTML:     '<button id="s">Save</button>',
        downloadButtonHTML: '<button id="d">Download</button>',
    };

    test('renders printButtonHTML when provided', () => {
        const html = buildButtonBar({ ...base, printButtonHTML: '<button id="p">Print</button>' });
        expect(html).toContain('<button id="p">Print</button>');
    });

    test('renders empty string — not "undefined" — when printButtonHTML is omitted', () => {
        const html = buildButtonBar({ ...base });
        expect(html).not.toContain('undefined');
    });

    test('still renders all three other buttons when print is omitted', () => {
        const html = buildButtonBar({ ...base });
        expect(html).toContain('Approve');
        expect(html).toContain('Save');
        expect(html).toContain('Download');
    });

    test('order: approve → save → print → download', () => {
        const html = buildButtonBar({
            approveButtonHTML:  '<s-a>',
            saveButtonHTML:     '<s-s>',
            printButtonHTML:    '<s-p>',
            downloadButtonHTML: '<s-d>',
        });
        const pos = {
            a: html.indexOf('<s-a>'),
            s: html.indexOf('<s-s>'),
            p: html.indexOf('<s-p>'),
            d: html.indexOf('<s-d>'),
        };
        expect(pos.a).toBeLessThan(pos.s);
        expect(pos.s).toBeLessThan(pos.p);
        expect(pos.p).toBeLessThan(pos.d);
    });
});
