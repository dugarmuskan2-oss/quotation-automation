/**
 * @jest-environment node
 *
 * tests/revision-full-view.test.js
 *
 * The "show the ENTIRE quote in History" feature (index.html): a past version is
 * rendered read-only as header + items + terms. Covers:
 *   - revisionHeaderField  — pull one header field from a snapshot's stored `header`
 *                            object, falling back to the live quote (older snapshots
 *                            predate header capture, so they borrow the current header).
 *   - revisionHeaderHtml   — the header block for a past version.
 *   - revisionFullQuoteHtml — header + items table + terms for a past version.
 *
 * These live inline in the browser-only SPA (index.html); extracted by name and
 * eval'd together with their pure dependency escapeHtml (same extractor pattern as
 * tests/revision-history.test.js). Everything here is a pure string builder, so the
 * real functions run under Node with no DOM stubbing.
 *
 * NOTE: sibling version helpers (currentRevisionNumber / displayQuoteNumber /
 * revisionLabel / commitRevisionSnapshot / buildHistoryTabContent) are already
 * covered by tests/revision-history.test.js and are intentionally NOT retested here.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

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

// Bundle the named functions (defined in dependency order) and return the last one.
function loadFns(names) {
    const body = names.map(function (n) { return extractFunction(html, n); }).join('\n');
    // eslint-disable-next-line no-new-func
    const factory = new Function(body + '\nreturn ' + names[names.length - 1] + ';');
    return factory();
}

// Pure dependency shared by all three targets; extracted so the REAL escaping runs.
const revisionHeaderField = loadFns(['revisionHeaderField']);
const revisionHeaderHtml = loadFns(['escapeHtml', 'revisionHeaderField', 'revisionHeaderHtml']);
const revisionFullQuoteHtml = loadFns([
    'escapeHtml',
    'revisionHeaderField',
    'revisionPipeTypeOf',
    'revisionItemsTableHtml',
    'revisionHeaderHtml',
    'revisionFullQuoteHtml',
]);

describe('revisionHeaderField — snapshot header value, else the live quote', () => {
    test('uses the snapshot header value when present', () => {
        const rev = { header: { companyName: 'SnapCo' } };
        expect(revisionHeaderField(rev, { companyName: 'LiveCo' }, 'companyName')).toBe('SnapCo');
    });

    test('falls back to the live quote when the snapshot has no header object', () => {
        const rev = { revNo: 2 };
        expect(revisionHeaderField(rev, { companyName: 'LiveCo' }, 'companyName')).toBe('LiveCo');
    });

    test('falls back when the header field is missing, empty, or whitespace-only', () => {
        const q = { customerName: 'Bob' };
        expect(revisionHeaderField({ header: {} }, q, 'customerName')).toBe('Bob');
        expect(revisionHeaderField({ header: { customerName: '' } }, q, 'customerName')).toBe('Bob');
        expect(revisionHeaderField({ header: { customerName: '   ' } }, q, 'customerName')).toBe('Bob');
    });

    test('never leaks a literal "undefined": both sides missing -> empty string', () => {
        expect(revisionHeaderField({}, {}, 'shipTo')).toBe('');
        expect(revisionHeaderField({ header: {} }, {}, 'shipTo')).toBe('');
        expect(revisionHeaderField(null, {}, 'shipTo')).toBe('');
    });

    test('a genuine snapshot value wins even when the live quote also has one', () => {
        const rev = { header: { preparedBy: 'Asha' } };
        expect(revisionHeaderField(rev, { preparedBy: 'Ravi' }, 'preparedBy')).toBe('Asha');
    });
});

describe('revisionHeaderHtml — the header block for a past version', () => {
    test('a snapshot WITH a header renders those captured values (not the live ones)', () => {
        const rev = {
            header: {
                companyName: 'Snap Steel Ltd',
                customerName: 'Priya',
                quotationDate: '2026-07-14',
                projectName: 'Bill Addr',
                shipTo: 'Ship Addr',
                contactDetails: '99999-00000',
                preparedBy: 'Asha',
                checkedBy: 'Deepak',
            },
        };
        const live = { companyName: 'Live Steel Ltd', customerName: 'Someone Else' };
        const out = revisionHeaderHtml(live, rev);

        // Captured snapshot values appear...
        expect(out).toContain('Snap Steel Ltd');
        expect(out).toContain('Priya');
        expect(out).toContain('2026-07-14');
        expect(out).toContain('Bill Addr');
        expect(out).toContain('Ship Addr');
        expect(out).toContain('99999-00000');
        expect(out).toContain('Asha');
        expect(out).toContain('Deepak');
        // ...and the diverging live values do NOT override them.
        expect(out).not.toContain('Live Steel Ltd');
        expect(out).not.toContain('Someone Else');
        // Labels are present.
        expect(out).toContain('Company');
        expect(out).toContain('Kind Attn');
        expect(out).toContain('Checked By');
    });

    test('a snapshot WITHOUT a header borrows the live quote header', () => {
        const live = {
            companyName: 'Live Steel Ltd',
            customerName: 'Ramesh',
            preparedBy: 'Asha',
        };
        const out = revisionHeaderHtml(live, { revNo: 1 });
        expect(out).toContain('Live Steel Ltd');
        expect(out).toContain('Ramesh');
        expect(out).toContain('Asha');
    });

    test('empty fields render no row and never leak "undefined"', () => {
        // Only companyName is known on either side; every other field is absent.
        const out = revisionHeaderHtml({ companyName: 'Acme' }, { header: {} });
        expect(out).toContain('Acme');
        expect(out).not.toContain('undefined');
        // Missing fields are omitted entirely — no empty "Ship To" / "Phone" rows.
        expect(out).not.toContain('Ship To');
        expect(out).not.toContain('Phone');
        // The one known field still renders its label.
        expect(out).toContain('Company');
    });

    test('header values are HTML-escaped', () => {
        const rev = { header: { companyName: '<b>A&B</b> "Co"' } };
        const out = revisionHeaderHtml({}, rev);
        expect(out).toContain('&lt;b&gt;A&amp;B&lt;/b&gt; &quot;Co&quot;');
        expect(out).not.toContain('<b>A&B</b>');
    });
});

describe('revisionFullQuoteHtml — the entire past version: header + items + terms', () => {
    const fullRev = {
        header: { companyName: 'Snap Steel Ltd', customerName: 'Priya' },
        lineItems: [
            { originalDescription: '2" NB X Heavy -- GI', quantity: 100, finalRate: '250.00', lineTotal: '25000.00' },
            { originalDescription: 'Freight', quantity: '', unitRate: '', lineTotal: '1500.00' },
        ],
        grandTotal: '26500.00',
        termsText: 'Payment: 100% advance',
    };

    test('renders the snapshot header, its items, and its terms', () => {
        const out = revisionFullQuoteHtml({ companyName: 'Live Co' }, fullRev);
        // Header (from the snapshot).
        expect(out).toContain('Snap Steel Ltd');
        expect(out).toContain('Priya');
        // Items (descriptions + numbers from the snapshot).
        expect(out).toContain('2&quot; NB X Heavy -- GI');
        expect(out).toContain('100');
        expect(out).toContain('250.00');
        expect(out).toContain('25000.00');
        expect(out).toContain('Freight');
        expect(out).toContain('1500.00');
        // Grand total from the snapshot.
        expect(out).toContain('26500.00');
        // Terms from the snapshot.
        expect(out).toContain('Terms');
        expect(out).toContain('Payment: 100% advance');
    });

    test('finalRate wins over unitRate; unitRate is used when no finalRate', () => {
        // Values chosen so no rate is a substring of any qty/total/grand-total — and we
        // assert on the exact right-aligned rate cell (">RATE</td>"), so the test actually
        // exercises the (finalRate ?? unitRate) selection and would go red if it flipped.
        const rev = {
            lineItems: [
                { originalDescription: 'A', quantity: '10', finalRate: '250', unitRate: '200', lineTotal: '3300' },
                { originalDescription: 'B', quantity: '20', unitRate: '175', lineTotal: '3400' },
            ],
            grandTotal: '6700',
        };
        const out = revisionFullQuoteHtml({}, rev);
        expect(out).toContain('>250</td>');      // row A uses finalRate...
        expect(out).not.toContain('>200</td>');  // ...NOT its unitRate
        expect(out).toContain('>175</td>');      // row B falls back to unitRate
    });

    test('terms fall back to the live quote when the snapshot omits them (null)', () => {
        const rev = { lineItems: [], grandTotal: '0', termsText: null };
        const out = revisionFullQuoteHtml({ termsText: 'Legacy terms from live quote' }, rev);
        expect(out).toContain('Legacy terms from live quote');
    });

    test('no terms block when the snapshot terms are an explicit empty string', () => {
        const rev = { lineItems: [], grandTotal: '0', termsText: '' };
        const out = revisionFullQuoteHtml({ termsText: 'Should NOT appear' }, rev);
        expect(out).not.toContain('Should NOT appear');
        expect(out).not.toContain('Terms &amp; Conditions');
    });

    test('a legacy snapshot (no header, no terms, minimal items) renders safely — no "undefined"', () => {
        const legacy = { lineItems: [{ originalDescription: 'Old pipe', lineTotal: '900' }] };
        const live = { companyName: 'Live Steel Ltd', customerName: 'Ramesh', termsText: 'Live terms' };
        const out = revisionFullQuoteHtml(live, legacy);
        expect(out).not.toContain('undefined');
        // Header borrows the live quote.
        expect(out).toContain('Live Steel Ltd');
        expect(out).toContain('Ramesh');
        // The one item still shows.
        expect(out).toContain('Old pipe');
        expect(out).toContain('900');
        // Terms fall back to the live quote (snapshot termsText is undefined -> not null-guarded away).
        expect(out).toContain('Live terms');
    });

    test('item descriptions are HTML-escaped', () => {
        const rev = { lineItems: [{ originalDescription: '<script>x</script>', lineTotal: '1' }], grandTotal: '1' };
        const out = revisionFullQuoteHtml({}, rev);
        expect(out).toContain('&lt;script&gt;x&lt;/script&gt;');
        expect(out).not.toContain('<script>x</script>');
    });
});

describe('source guard — the History view wires the full-quote renderer', () => {
    test('viewRevision and downloadRevision both render the ENTIRE quote', () => {
        // Two CALL sites confirm the read-only modal and the print/PDF window both use the
        // full renderer (header + items + terms), not just the items table. The leading "+ "
        // excludes the function DEFINITION (`function revisionFullQuoteHtml(...)`), so this
        // can't be satisfied by the definition plus a single call site.
        const uses = (html.match(/\+ revisionFullQuoteHtml\(quotation, rev\)/g) || []).length;
        expect(uses).toBeGreaterThanOrEqual(2);
    });
});
