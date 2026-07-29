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

// Extracted individually so the pipe-type grouping is exercised directly.
// revisionPipeTypeOf is self-contained; revisionItemsTableHtml needs escapeHtml + it.
const revisionPipeTypeOf = loadFns(['revisionPipeTypeOf']);
const revisionItemsTableHtml = loadFns(['escapeHtml', 'revisionPipeTypeOf', 'revisionItemsTableHtml']);

// Pull the text of every full-width pipe-type header cell (<td colspan="4" …>TYPE</td>),
// in document order, so we can assert both the COUNT and the ORDER of group headers.
function headerTypesOf(out) {
    const re = /colspan="4"[^>]*>([^<]+)</g;
    const found = [];
    let m;
    while ((m = re.exec(out)) !== null) found.push(m[1]);
    return found;
}
function headerCount(out) {
    return (out.match(/colspan="4"/g) || []).length;
}

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

describe('revisionPipeTypeOf — the group label for one line item', () => {
    test('returns the stored identifiedPipeType verbatim when set', () => {
        expect(revisionPipeTypeOf({ identifiedPipeType: 'GI' })).toBe('GI');
        expect(revisionPipeTypeOf({ identifiedPipeType: 'Seamless' })).toBe('Seamless');
    });

    test('trims surrounding whitespace on the stored type', () => {
        expect(revisionPipeTypeOf({ identifiedPipeType: '  ERW  ' })).toBe('ERW');
    });

    test('stored type wins over anything in the description', () => {
        // identifiedPipeType says ERW even though the description suffix says GI.
        expect(revisionPipeTypeOf({ identifiedPipeType: 'ERW', originalDescription: '2" NB X Heavy -- GI' })).toBe('ERW');
    });

    test('derives ERW from a "-- ERW" description suffix (no stored type)', () => {
        expect(revisionPipeTypeOf({ originalDescription: '3/4" NB X MED -- ERW' })).toBe('ERW');
    });

    test('derives GI from a "-- GI" description suffix', () => {
        expect(revisionPipeTypeOf({ originalDescription: '2" NB X Heavy -- GI' })).toBe('GI');
    });

    test('derives Seamless from a schedule spec ("Sch 40") with no suffix', () => {
        expect(revisionPipeTypeOf({ originalDescription: '2" NB X Sch 40' })).toBe('Seamless');
    });

    test('SMLS suffix maps to Seamless (not the raw token)', () => {
        expect(revisionPipeTypeOf({ originalDescription: '2" NB X Heavy -- SMLS' })).toBe('Seamless');
    });

    test('normalises the derived suffix to upper-case regardless of input case', () => {
        expect(revisionPipeTypeOf({ originalDescription: '3/4" nb x med -- erw' })).toBe('ERW');
    });

    test('reads the suffix from a legacy `description` field too', () => {
        expect(revisionPipeTypeOf({ description: '2" NB X Heavy -- GI' })).toBe('GI');
    });

    test('a plain "Freight" line with no type -> empty string', () => {
        expect(revisionPipeTypeOf({ originalDescription: 'Freight' })).toBe('');
    });

    test('a bare pipe with no suffix and no schedule -> empty string', () => {
        expect(revisionPipeTypeOf({ originalDescription: '2" NB X Heavy' })).toBe('');
    });

    test('null / empty item never throws and yields empty string', () => {
        expect(revisionPipeTypeOf(null)).toBe('');
        expect(revisionPipeTypeOf(undefined)).toBe('');
        expect(revisionPipeTypeOf({})).toBe('');
    });
});

describe('revisionItemsTableHtml — full-width pipe-type header row per group', () => {
    test('a single-type quote emits exactly ONE header row for that type', () => {
        const rev = {
            lineItems: [
                { originalDescription: '2" NB X Heavy -- GI', quantity: 100, finalRate: '250', lineTotal: '25000' },
                { originalDescription: '3" NB X Heavy -- GI', quantity: 50, finalRate: '300', lineTotal: '15000' },
            ],
            grandTotal: '40000',
        };
        const out = revisionItemsTableHtml(rev);
        expect(headerCount(out)).toBe(1);
        expect(headerTypesOf(out)).toEqual(['GI']);
    });

    test('two groups (Seamless then GI) emit TWO headers, Seamless before GI', () => {
        const rev = {
            lineItems: [
                { originalDescription: '2" NB X Sch 40', quantity: 10, finalRate: '500', lineTotal: '5000' },
                { originalDescription: '4" NB X Sch 80', quantity: 20, finalRate: '600', lineTotal: '12000' },
                { originalDescription: '2" NB X Heavy -- GI', quantity: 100, finalRate: '250', lineTotal: '25000' },
            ],
            grandTotal: '42000',
        };
        const out = revisionItemsTableHtml(rev);
        expect(headerCount(out)).toBe(2);
        // Order matters: the Seamless group came first in the item list.
        expect(headerTypesOf(out)).toEqual(['Seamless', 'GI']);
        expect(out.indexOf('>Seamless<')).toBeLessThan(out.indexOf('>GI<'));
    });

    test('consecutive same-type items share ONE header; the type re-emits when it toggles back', () => {
        const rev = {
            lineItems: [
                { originalDescription: '2" NB X Heavy -- GI', quantity: 1, finalRate: '1', lineTotal: '1' },
                { originalDescription: '2" NB X Sch 40', quantity: 1, finalRate: '1', lineTotal: '1' },
                { originalDescription: '3" NB X Heavy -- GI', quantity: 1, finalRate: '1', lineTotal: '1' },
            ],
            grandTotal: '3',
        };
        // GI, Seamless, GI -> a fresh header each time the type changes.
        expect(headerTypesOf(revisionItemsTableHtml(rev))).toEqual(['GI', 'Seamless', 'GI']);
    });

    test('POCL bug fix: an ERW item typed only in its description STILL gets an ERW header', () => {
        const rev = {
            lineItems: [
                { originalDescription: '3/4" NB X MED -- ERW', quantity: 50, finalRate: '100', lineTotal: '5000' },
            ],
            grandTotal: '5000',
        };
        const out = revisionItemsTableHtml(rev);
        expect(headerCount(out)).toBe(1);
        expect(headerTypesOf(out)).toEqual(['ERW']);
    });

    test('a freight / untyped row gets NO header row before it', () => {
        const rev = {
            lineItems: [
                { originalDescription: '2" NB X Heavy -- GI', quantity: 100, finalRate: '250', lineTotal: '25000' },
                { originalDescription: 'Freight', quantity: '', unitRate: '', lineTotal: '1500' },
            ],
            grandTotal: '26500',
        };
        const out = revisionItemsTableHtml(rev);
        // Only the GI group has a header — the freight row contributes none.
        expect(headerCount(out)).toBe(1);
        expect(headerTypesOf(out)).toEqual(['GI']);
        // The freight row itself still renders as a normal cell.
        expect(out).toContain('>Freight</td>');
        expect(out).toContain('1500');
    });

    test('an all-untyped quote (only freight) emits ZERO header rows', () => {
        const rev = {
            lineItems: [{ originalDescription: 'Freight', quantity: '', unitRate: '', lineTotal: '1500' }],
            grandTotal: '1500',
        };
        const out = revisionItemsTableHtml(rev);
        expect(headerCount(out)).toBe(0);
        expect(headerTypesOf(out)).toEqual([]);
        // Body still present with the freight line.
        expect(out).toContain('>Freight</td>');
    });

    test('normal item cells (desc / qty / rate / total) still render alongside the header', () => {
        const rev = {
            lineItems: [
                { originalDescription: '2" NB X Heavy -- GI', quantity: 100, finalRate: '250.00', lineTotal: '25000.00' },
            ],
            grandTotal: '25000.00',
        };
        const out = revisionItemsTableHtml(rev);
        expect(out).toContain('2&quot; NB X Heavy -- GI');   // description (escaped)
        expect(out).toContain('>100</td>');                   // qty cell
        expect(out).toContain('>250.00</td>');                // rate cell (finalRate)
        expect(out).toContain('>25000.00</td>');              // total cell
        // Header did not swallow / replace the item row.
        expect(headerCount(out)).toBe(1);
    });

    test('header text is HTML-escaped (a crafted stored type cannot inject markup)', () => {
        const rev = {
            lineItems: [{ identifiedPipeType: '<b>GI</b>', originalDescription: 'x', lineTotal: '1' }],
            grandTotal: '1',
        };
        const out = revisionItemsTableHtml(rev);
        expect(out).toContain('&lt;b&gt;GI&lt;/b&gt;');
        expect(out).not.toContain('<b>GI</b>');
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
