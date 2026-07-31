/**
 * @jest-environment node
 *
 * tests/shared-quote-page.test.js
 *
 * The "Copy Link" internal shared-quote page (index.html): the pure builders that
 * turn a quotation object into HTML / a version object —
 *   - buildCurrentVersionRev  (current-version rev object from a quote)
 *   - buildSharedWeightHtml    (Weight section HTML)
 *   - buildSharedFreightHtml   (Freight section HTML)
 * These live inline in the browser-only SPA; extracted by name and eval'd together
 * with their REAL pure dependencies (escapeHtml, sqFmtKg, currentRevisionNumber),
 * so the assertions exercise actual code — no inline copies.
 *
 * renderSharedQuotePage builds document.title + overlay.innerHTML, so it is
 * DOM-bound and gets a focused source guard (it must stack ALL versions and
 * include the Weight + Freight sections).
 */
'use strict';

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

// Concatenate the named functions (declarations hoist, so order is irrelevant) and
// return the LAST one. Real dependencies are included by name, not stubbed.
function loadFns(names) {
    const body = names.map(function (n) { return extractFunction(html, n); }).join('\n');
    // eslint-disable-next-line no-new-func
    const factory = new Function(body + '\nreturn ' + names[names.length - 1] + ';');
    return factory();
}

const buildCurrentVersionRev = loadFns(['currentRevisionNumber', 'buildCurrentVersionRev']);
const buildSharedWeightHtml = loadFns(['escapeHtml', 'sqFmtKg', 'buildSharedWeightHtml']);
const buildSharedFreightHtml = loadFns(['escapeHtml', 'buildSharedFreightHtml']);

describe('buildCurrentVersionRev — current-version rev object from a quote', () => {
    test('maps every field for a fully-populated quote', () => {
        const q = {
            revisionCount: 2,
            updatedAt: '2026-07-14T10:00:00.000Z',
            createdAt: '2026-07-01T10:00:00.000Z',
            grandTotal: '12345',
            termsText: 'Net 30',
            companyName: 'Acme Pipes',
            customerName: 'Ravi',
            quotationDate: '14/07/2026',
            projectName: 'Metro Line',
            shipTo: 'Site B',
            contactDetails: '9876543210',
            preparedBy: 'Asha',
            checkedBy: 'Dev',
            lineItems: [{ originalDescription: 'Pipe', lineTotal: '12345' }],
        };
        const rev = buildCurrentVersionRev(q);
        expect(rev.revNo).toBe(2); // from currentRevisionNumber (real)
        expect(rev.createdAt).toBe('2026-07-14T10:00:00.000Z'); // updatedAt wins
        expect(rev.grandTotal).toBe('12345');
        expect(rev.termsText).toBe('Net 30');
        expect(rev.header).toEqual({
            companyName: 'Acme Pipes',
            customerName: 'Ravi',
            quotationDate: '14/07/2026',
            projectName: 'Metro Line',
            shipTo: 'Site B',
            contactDetails: '9876543210',
            preparedBy: 'Asha',
            checkedBy: 'Dev',
        });
        expect(rev.lineItems).toEqual([{ originalDescription: 'Pipe', lineTotal: '12345' }]);
    });

    test('revNo comes from the real currentRevisionNumber (revisions.length fallback)', () => {
        expect(buildCurrentVersionRev({ revisions: [{}, {}, {}] }).revNo).toBe(3);
    });

    test('createdAt falls back updatedAt -> createdAt -> empty string', () => {
        expect(buildCurrentVersionRev({ createdAt: 'c' }).createdAt).toBe('c');
        expect(buildCurrentVersionRev({}).createdAt).toBe('');
    });

    test('contactDetails falls back contactDetails -> mobileNumber -> phoneNumber', () => {
        expect(buildCurrentVersionRev({ mobileNumber: '111' }).header.contactDetails).toBe('111');
        expect(buildCurrentVersionRev({ phoneNumber: '222' }).header.contactDetails).toBe('222');
        expect(buildCurrentVersionRev({ contactDetails: '333', mobileNumber: '111' }).header.contactDetails).toBe('333');
    });

    test('empty/missing quote -> graceful zeroed object, lineItems is always an array', () => {
        const rev = buildCurrentVersionRev({});
        expect(rev.revNo).toBe(0);
        expect(rev.termsText).toBe('');
        expect(rev.lineItems).toEqual([]);
        expect(rev.header.companyName).toBe('');
        expect(rev.header.checkedBy).toBe('');
    });

    test('non-array lineItems is coerced to []', () => {
        expect(buildCurrentVersionRev({ lineItems: 'nope' }).lineItems).toEqual([]);
    });
});

describe('buildSharedWeightHtml — Weight section HTML', () => {
    test('empty state when no line item carries a kg/m value', () => {
        const out = buildSharedWeightHtml({ lineItems: [{ quantity: '100' }, { quantity: '50', kgPerMeter: '0' }] });
        expect(out).toBe('<p style="color:#999;">No weight (kg/m) recorded for this quote.</p>');
    });

    test('no lineItems at all -> empty state, not a crash', () => {
        expect(buildSharedWeightHtml({})).toContain('No weight (kg/m) recorded');
        expect(buildSharedWeightHtml({ lineItems: [] })).toContain('No weight (kg/m) recorded');
        expect(buildSharedWeightHtml({ lineItems: 'nope' })).toContain('No weight (kg/m) recorded');
    });

    test('builds a table, totals the weight, and prints the 7% tolerance (real rounding)', () => {
        const out = buildSharedWeightHtml({
            lineItems: [{ originalDescription: 'Pipe A', quantity: '100', kgPerMeter: '2.5' }],
        });
        expect(out).toContain('<table class="sq-tbl">');
        expect(out).toContain('Pipe A');
        // 100 * 2.5 = 250 total weight
        expect(out).toContain('Total weight: 250 kg');
        // tolerance = round(250 * 0.93) = round(232.5) = 233
        expect(out).toContain('With tolerance (7%): 233 kg');
    });

    test('rows with no kg/m render an em-dash but do not remove other rows or the table', () => {
        const out = buildSharedWeightHtml({
            lineItems: [
                { originalDescription: 'Has weight', quantity: '10', kgPerMeter: '4' },
                { originalDescription: 'No weight', quantity: '5' },
            ],
        });
        expect(out).toContain('<table class="sq-tbl">');
        expect(out).toContain('Has weight');
        expect(out).toContain('No weight');
        expect(out).toContain('&mdash;'); // the no-kg row's kg/m + weight cells
        // total is only the weighted row: 10 * 4 = 40
        expect(out).toContain('Total weight: 40 kg');
    });

    test('commas are stripped from quantity/kg-m before math', () => {
        const out = buildSharedWeightHtml({
            lineItems: [{ originalDescription: 'Bulk', quantity: '1,000', kgPerMeter: '2' }],
        });
        // 1000 * 2 = 2000
        expect(out).toContain('Total weight: 2,000 kg');
    });

    test('falls back to `description` when `originalDescription` is absent, and escapes HTML', () => {
        const out = buildSharedWeightHtml({
            lineItems: [{ description: '2" <b>pipe</b>', quantity: '1', kgPerMeter: '3' }],
        });
        expect(out).toContain('2&quot; &lt;b&gt;pipe&lt;/b&gt;');
        expect(out).not.toContain('<b>pipe</b>');
    });
});

describe('buildSharedFreightHtml — Freight section HTML', () => {
    test('empty state when there is no freight line, no FOR flag and no enquiries', () => {
        expect(buildSharedFreightHtml({})).toBe('<p style="color:#999;">No freight details for this quote.</p>');
        expect(buildSharedFreightHtml({ freightEnquiries: [], lineItems: [] }))
            .toContain('No freight details for this quote.');
    });

    test('shows the in-quote freight amount from the freight line item', () => {
        const out = buildSharedFreightHtml({
            lineItems: [
                { originalDescription: 'Pipe', lineTotal: '9000' },
                { originalDescription: 'Freight', lineTotal: '1500' },
            ],
        });
        expect(out).toContain('Freight in the quote:');
        expect(out).toContain('1500');
        expect(out).toContain('&#8377;'); // ₹ rupee symbol
    });

    test('the freight line lookup is case/whitespace-insensitive and uses finalRate as a fallback', () => {
        const out = buildSharedFreightHtml({
            lineItems: [{ originalDescription: '  FREIGHT ', finalRate: '750' }],
        });
        expect(out).toContain('Freight in the quote:');
        expect(out).toContain('750');
    });

    test('FOR flag adds the "built into the rates" note', () => {
        const out = buildSharedFreightHtml({ freightDistributedIntoMargin: true });
        expect(out).toContain('Freight is built into the rates (FOR');
    });

    test('renders a transporter enquiry table with Replied/Awaiting status and rounded rates', () => {
        const out = buildSharedFreightHtml({
            freightEnquiries: [
                { email: 'ravi@roadlines.com', replied: true, amount: 1499.6 },
                { email: 'slow@transport.com', replied: false },
            ],
        });
        expect(out).toContain('<table class="sq-tbl">');
        expect(out).toContain('ravi@roadlines.com');
        expect(out).toContain('Replied');
        expect(out).toContain('slow@transport.com');
        expect(out).toContain('Awaiting');
        // round(1499.6) = 1500
        expect(out).toContain('1,500');
        // the awaiting row has no amount -> em-dash
        expect(out).toContain('&mdash;');
    });

    test('escapes a transporter email that contains markup', () => {
        const out = buildSharedFreightHtml({
            freightEnquiries: [{ email: '<script>x</script>@evil.com', replied: false }],
        });
        expect(out).toContain('&lt;script&gt;');
        expect(out).not.toContain('<script>x</script>');
    });

    test('non-array freightEnquiries / lineItems are tolerated (no crash)', () => {
        expect(buildSharedFreightHtml({ freightEnquiries: 'x', lineItems: 'y' }))
            .toContain('No freight details for this quote.');
    });
});

describe('source guard — renderSharedQuotePage stacks all versions + Weight/Freight sections', () => {
    const src = extractFunction(html, 'renderSharedQuotePage');

    test('current version renders as a live PDF; past versions use the archived PDF or the rebuilt view', () => {
        expect(src).toContain('buildCurrentVersionRev(quotation)');
        expect(src).toContain('sq-pdf-current');                                 // current = live PDF frame
        expect(src).toContain('downloadQuotationPdf(quotation.id, { preview: true })');
        expect(src).toContain('archivedPdfVersions');                            // gate past-version archived PDFs
        expect(src).toContain('revisionFullQuoteHtml(quotation, r)');            // rebuilt fallback for un-archived
    });

    test('loops over EVERY stored revision (newest first)', () => {
        expect(src).toContain('const revs = Array.isArray(quotation.revisions) ? quotation.revisions : [];');
        expect(src).toContain('for (let i = revs.length - 1; i >= 0; i--)');
        expect(src).toContain('revisionFullQuoteHtml(quotation, r)');
    });

    test('includes both the Weight and Freight sections', () => {
        expect(src).toContain('<div class="sq-sec-h">Weight</div>');
        expect(src).toContain('buildSharedWeightHtml(quotation)');
        expect(src).toContain('<div class="sq-sec-h">Freight</div>');
        expect(src).toContain('buildSharedFreightHtml(quotation)');
    });

    test('has a "no previous versions" note for a single-version quote', () => {
        expect(src).toContain("const prevNote = revs.length ? '' :");
        expect(src).toContain('Versions (newest first)');
    });
});
