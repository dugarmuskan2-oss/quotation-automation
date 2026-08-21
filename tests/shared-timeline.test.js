/**
 * @jest-environment node
 *
 * tests/shared-timeline.test.js
 *
 * Three things shipped together in "Revision clear ordering, All Quotes button,
 * freight message + item table, drag-and-drop":
 *
 * 1. THE SHARED-PAGE TIMELINE (index.html — buildSharedEnquiryEvents, plus the entry
 *    comparator lifted straight out of renderSharedQuotePage). The Copy-Link page used to
 *    list versions only, so a transporter rate that arrived between Rev 1 and Rev 2 — very
 *    often the REASON Rev 2 exists — left no trace. Enquiry activity is now dated timeline
 *    entries merged into the same newest-first list, which only works if (a) both moments
 *    (sent + received) are recorded, (b) an undated entry sinks instead of floating to the
 *    top, and (c) the merge really interleaves. All three are asserted here against the
 *    real extracted code — including the REAL sort comparator, not a copy of it.
 *
 * 2. THE FREIGHT ENQUIRY MESSAGE (freight-tab-weight-editor.js _test export). The closing
 *    line is now exactly "Please include transit time." (the old one also asked about door
 *    delivery, which DSC does not promise), and the draft carries a [TABLE] placeholder
 *    swapped at send time for the consignment broken down per item. The weight gate has to
 *    survive that addition: a partial weight still prints "____ kg" AND the item table must
 *    not print a Total row, or the table would quietly re-introduce the light figure the
 *    gate exists to block. Escaping order matters too — the text is escaped BEFORE the
 *    table is injected, so a pipe description containing markup cannot become live HTML.
 *
 * 3. SOURCE GUARDS (pattern B) for what is too DOM-bound to execute in Node: the
 *    drag-and-drop wiring on the three paste boxes, the "All Quotes" button, and the
 *    position of the Enquiry section on the shared page. DROP_ACCEPT is a plain regex, so
 *    that one is extracted and exercised for real rather than guarded.
 *
 * No behaviour is reimplemented inline: index.html functions are extracted by
 * brace-matching and eval'd with their real dependencies; the freight helpers are
 * require()d from the shipped module.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
// Styling now lives in styles.css, not inline in index.html. These source guards
// assert CSS rules by exact text, so both files are read and searched together —
// the guard stays exactly as strong, it just no longer cares which file holds it.
const html = fs.readFileSync(INDEX_PATH, 'utf8')
    + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

// Pull a top-level `function name(...) {...}` out of source by brace-matching.
// The '(' in the search keeps `escapeHtml` from resolving to `escapeHtmlAttr`, and a
// leading `async ` is preserved so an inner await is not a SyntaxError.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
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

// Pull a single-line top-level `const NAME = ...;` out of source.
function extractConst(src, name) {
    const start = src.indexOf('const ' + name + ' =');
    if (start === -1) throw new Error('const not found: ' + name);
    return src.slice(start, src.indexOf('\n', start)).trim();
}

// Concatenate the named functions (declarations hoist, so order is irrelevant) and hand
// them all back. Real dependencies are included by name, never stubbed.
function loadFns(names) {
    const body = names.map(function (n) { return extractFunction(html, n); }).join('\n');
    const exported = 'return {' + names.map(function (n) { return n + ': ' + n; }).join(',') + '};';
    // eslint-disable-next-line no-new-func
    return new Function(body + '\n' + exported)();
}

const { escapeHtml, formatRevisionDate, buildSharedEnquiryEvents } =
    loadFns(['escapeHtml', 'formatRevisionDate', 'buildSharedEnquiryEvents']);

const renderSrc = extractFunction(html, 'renderSharedQuotePage');

// The REAL comparator renderSharedQuotePage sorts its merged entries with. Lifting the
// function expression out of the (DOM-bound) parent keeps the ordering assertions honest:
// if the comparator changes, these tests change with it.
function extractEntriesComparator(src) {
    const at = src.indexOf('entries.sort(');
    if (at === -1) throw new Error('entries.sort( not found in renderSharedQuotePage');
    const start = src.indexOf('function', at);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting the entries comparator');
}
// eslint-disable-next-line no-new-func
const compareEntries = new Function('return ' + extractEntriesComparator(renderSrc))();

const inr = function (n) { return n.toLocaleString('en-IN'); };

// =============================================================================
// 1a. buildSharedEnquiryEvents — which moments become timeline entries
// =============================================================================
describe('buildSharedEnquiryEvents — freight enquiries become dated events', () => {
    test('sent + replied (with a replyAt) yields TWO events, one per moment', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{
                email: 'ravi@roadlines.com',
                sentAt: '2026-07-03T09:00:00.000Z',
                replied: true,
                replyAt: '2026-07-05T09:00:00.000Z',
                amount: 1500,
            }],
        });
        expect(events).toHaveLength(2);
        expect(events[0].when).toBe('2026-07-03T09:00:00.000Z');
        expect(events[0].html).toContain('Freight enquiry sent');
        expect(events[1].when).toBe('2026-07-05T09:00:00.000Z');
        expect(events[1].html).toContain('Freight rate received');
        // Both sit in the "event" lane so the merge can tell them from a version.
        expect(events.map(function (e) { return e.sort; })).toEqual([1, 1]);
    });

    test('sent but not replied yields ONLY the sent event', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: 'slow@transport.com', sentAt: '2026-07-03T09:00:00.000Z', replied: false }],
        });
        expect(events).toHaveLength(1);
        expect(events[0].html).toContain('Freight enquiry sent');
        expect(events[0].html).not.toContain('received');
    });

    test('an entry with no sentAt contributes no "sent" event', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: 'a@b.com', replied: false }],
        });
        expect(events).toEqual([]);
    });

    test('the received event carries the email AND the rupee amount', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{
                email: 'ravi@roadlines.com', sentAt: '2026-07-03T09:00:00.000Z',
                replied: true, replyAt: '2026-07-05T09:00:00.000Z', amount: 1499.6,
            }],
        });
        // round(1499.6) = 1500, grouped the Indian way
        expect(events[1].html).toContain('ravi@roadlines.com — ₹' + inr(1500));
    });

    test('…and omits the amount entirely when there is not one', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{
                email: 'ravi@roadlines.com', sentAt: '2026-07-03T09:00:00.000Z',
                replied: true, replyAt: '2026-07-05T09:00:00.000Z',
            }],
        });
        expect(events[1].html).toContain('ravi@roadlines.com');
        expect(events[1].html).not.toContain('₹');
        expect(events[1].html).not.toContain('—');   // no dangling separator either
    });

    test('a zero amount is treated as "no amount", not as ₹0', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: 'a@b.com', sentAt: '2026-07-03T09:00:00.000Z', replied: true, amount: 0 }],
        });
        expect(events[1].html).not.toContain('₹');
    });

    test('REGRESSION: replied with no replyAt falls back to sentAt, not to an undated event', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: 'a@b.com', sentAt: '2026-07-03T09:00:00.000Z', replied: true }],
        });
        expect(events).toHaveLength(2);
        expect(events[1].when).toBe('2026-07-03T09:00:00.000Z');
        // …and it renders a real date rather than a blank slot.
        expect(events[1].html).toContain(formatRevisionDate('2026-07-03T09:00:00.000Z'));
    });

    test('each event stamps its own date through the shared formatter', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{
                email: 'a@b.com', sentAt: '2026-07-03T09:00:00.000Z',
                replied: true, replyAt: '2026-07-05T09:00:00.000Z',
            }],
        });
        expect(events[0].html).toContain(formatRevisionDate('2026-07-03T09:00:00.000Z'));
        expect(events[1].html).toContain(formatRevisionDate('2026-07-05T09:00:00.000Z'));
        expect(formatRevisionDate('2026-07-03T09:00:00.000Z')).not.toBe('');
    });
});

describe('buildSharedEnquiryEvents — supplier enquiries behave the same way', () => {
    test('sent + replied yields two events, with their own wording', () => {
        const events = buildSharedEnquiryEvents({
            supplierEnquiries: [{
                email: 'mill@steel.com', sentAt: '2026-07-02T09:00:00.000Z',
                replied: true, replyAt: '2026-07-04T09:00:00.000Z',
            }],
        });
        expect(events).toHaveLength(2);
        expect(events[0].html).toContain('Supplier enquiry sent');
        expect(events[1].html).toContain('Supplier offer received');
    });

    test('sent but not replied yields only the sent event', () => {
        const events = buildSharedEnquiryEvents({
            supplierEnquiries: [{ email: 'mill@steel.com', sentAt: '2026-07-02T09:00:00.000Z' }],
        });
        expect(events).toHaveLength(1);
        expect(events[0].html).toContain('Supplier enquiry sent');
    });

    test('a supplier offer prices off `rate` (freight uses `amount`)', () => {
        const q = {
            supplierEnquiries: [{
                email: 'mill@steel.com', sentAt: '2026-07-02T09:00:00.000Z',
                replied: true, rate: 62500, amount: 999,
            }],
        };
        const received = buildSharedEnquiryEvents(q)[1].html;
        expect(received).toContain('₹' + inr(62500));
        expect(received).not.toContain(inr(999));
    });

    test('a supplier reply with no rate shows the email alone', () => {
        const events = buildSharedEnquiryEvents({
            supplierEnquiries: [{ email: 'mill@steel.com', sentAt: '2026-07-02T09:00:00.000Z', replied: true }],
        });
        expect(events[1].html).toContain('mill@steel.com');
        expect(events[1].html).not.toContain('₹');
    });

    test('freight and supplier events are produced together, freight first', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: 'f@x.com', sentAt: '2026-07-03T09:00:00.000Z' }],
            supplierEnquiries: [{ email: 's@x.com', sentAt: '2026-07-02T09:00:00.000Z' }],
        });
        expect(events).toHaveLength(2);
        expect(events[0].html).toContain('Freight enquiry sent');
        expect(events[1].html).toContain('Supplier enquiry sent');
    });
});

describe('buildSharedEnquiryEvents — bad data must never break the shared page', () => {
    test('missing, null and non-array enquiry lists produce no events', () => {
        expect(buildSharedEnquiryEvents({})).toEqual([]);
        expect(buildSharedEnquiryEvents({ freightEnquiries: null, supplierEnquiries: null })).toEqual([]);
        expect(buildSharedEnquiryEvents({ freightEnquiries: 'nope', supplierEnquiries: 'nope' })).toEqual([]);
        expect(buildSharedEnquiryEvents({ freightEnquiries: {}, supplierEnquiries: {} })).toEqual([]);
        expect(buildSharedEnquiryEvents({ freightEnquiries: [], supplierEnquiries: [] })).toEqual([]);
    });

    test('null / undefined entries inside the arrays are skipped rather than thrown on', () => {
        expect(function () {
            buildSharedEnquiryEvents({ freightEnquiries: [null, undefined], supplierEnquiries: [null] });
        }).not.toThrow();
        expect(buildSharedEnquiryEvents({
            freightEnquiries: [null, { email: 'a@b.com', sentAt: '2026-07-03T09:00:00.000Z' }],
        })).toHaveLength(1);
    });

    test('an entry with no email at all still renders (blank detail, no crash)', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-07-03T09:00:00.000Z' }],
        });
        expect(events).toHaveLength(1);
        expect(events[0].html).toContain('Freight enquiry sent');
    });

    test('an email containing markup is escaped, not rendered', () => {
        const events = buildSharedEnquiryEvents({
            freightEnquiries: [{ email: '<img src=x onerror=alert(1)>@evil.com', sentAt: '2026-07-03T09:00:00.000Z' }],
            supplierEnquiries: [{ email: '<script>bad()</script>', sentAt: '2026-07-02T09:00:00.000Z', replied: true }],
        });
        const all = events.map(function (e) { return e.html; }).join('');
        expect(all).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(all).toContain('&lt;script&gt;bad()&lt;/script&gt;');
        expect(all).not.toContain('<img src=x');
        expect(all).not.toContain('<script>');
        // The escaping is the shared escapeHtml, not a private one.
        expect(all).toContain(escapeHtml('<script>bad()</script>'));
    });
});

// =============================================================================
// 1b. THE MERGE — enquiry events interleaved with versions, exactly as the page does it
// =============================================================================
describe('the shared timeline merge — an enquiry lands between the versions it sits between', () => {
    // Built the way renderSharedQuotePage builds `entries`: the live current version and every
    // stored revision get sort 2, buildSharedEnquiryEvents supplies sort-1 entries, then the
    // real comparator orders the lot.
    function buildEntries(quotation) {
        const revs = Array.isArray(quotation.revisions) ? quotation.revisions : [];
        const entries = [];
        entries.push({ label: 'current', when: quotation.updatedAt || quotation.sentAt || '', sort: 2 });
        for (let i = revs.length - 1; i >= 0; i--) {
            entries.push({ label: 'rev' + i, when: revs[i].createdAt || '', sort: 2 });
        }
        buildSharedEnquiryEvents(quotation).forEach(function (e) {
            e.label = e.html.indexOf('received') >= 0 ? 'freight-reply' : 'freight-sent';
            entries.push(e);
        });
        return entries;
    }

    test('THE POINT: a rate that arrived between two revisions is ordered between them', () => {
        const q = {
            updatedAt: '2026-07-10T09:00:00.000Z',                              // current version
            revisions: [
                { createdAt: '2026-07-01T09:00:00.000Z' },                      // rev0 — the original
                { createdAt: '2026-07-08T09:00:00.000Z' },                      // rev1
            ],
            freightEnquiries: [{
                email: 'ravi@roadlines.com',
                sentAt: '2026-07-03T09:00:00.000Z',
                replied: true,
                replyAt: '2026-07-05T09:00:00.000Z',                            // between rev0 and rev1
                amount: 1500,
            }],
        };
        const entries = buildEntries(q);
        entries.sort(compareEntries);

        expect(entries.map(function (e) { return e.label; }))
            .toEqual(['current', 'rev1', 'freight-reply', 'freight-sent', 'rev0']);

        // Stated as the thing that actually matters, not just as an array shape:
        const order = entries.map(function (e) { return e.label; });
        expect(order.indexOf('freight-reply')).toBeGreaterThan(order.indexOf('rev1'));
        expect(order.indexOf('freight-reply')).toBeLessThan(order.indexOf('rev0'));
    });

    test('undated entries sink to the BOTTOM instead of jumping to the top', () => {
        const entries = [
            { label: 'undated-rev', when: '', sort: 2 },
            { label: 'newest', when: '2026-07-10T09:00:00.000Z', sort: 2 },
            { label: 'undated-event', when: '', sort: 1 },
            { label: 'oldest', when: '2026-07-01T09:00:00.000Z', sort: 2 },
        ];
        entries.sort(compareEntries);
        const order = entries.map(function (e) { return e.label; });
        expect(order.slice(0, 2)).toEqual(['newest', 'oldest']);
        expect(order.slice(2).sort()).toEqual(['undated-event', 'undated-rev']);
    });

    test('a quote with an undated enquiry event keeps every version above it', () => {
        // replied with neither replyAt nor sentAt -> when === '' (the only undated event
        // buildSharedEnquiryEvents can emit).
        const q = {
            updatedAt: '2026-07-10T09:00:00.000Z',
            revisions: [{ createdAt: '2026-07-01T09:00:00.000Z' }],
            freightEnquiries: [{ email: 'a@b.com', replied: true }],
        };
        const entries = buildEntries(q);
        expect(entries.some(function (e) { return e.when === ''; })).toBe(true);
        entries.sort(compareEntries);
        expect(entries[entries.length - 1].label).toBe('freight-reply');
    });

    test('newest-first is the overall direction (the Versions list has always run that way)', () => {
        const entries = [
            { label: 'old', when: '2026-01-01T00:00:00.000Z', sort: 2 },
            { label: 'new', when: '2026-12-31T00:00:00.000Z', sort: 2 },
            { label: 'mid', when: '2026-06-15T00:00:00.000Z', sort: 1 },
        ];
        entries.sort(compareEntries);
        expect(entries.map(function (e) { return e.label; })).toEqual(['new', 'mid', 'old']);
    });

    // An enquiry reply stamped the same second as a revision is what prompted that revision, so
    // it belongs BELOW it — the thing that came first reads lower in a newest-first list.
    test('on an exact tie the version (2) sits above the enquiry event (1)', () => {
        const same = '2026-07-05T09:00:00.000Z';
        const entries = [
            { label: 'event', when: same, sort: 1 },
            { label: 'version', when: same, sort: 2 },
        ];
        entries.sort(compareEntries);
        expect(entries.map(function (e) { return e.label; })).toEqual(['version', 'event']);
    });
});

// =============================================================================
// 2. THE FREIGHT ENQUIRY MESSAGE — freight-tab-weight-editor.js (_test export)
// =============================================================================
const {
    buildEnquiryDraft,
    freightItemsTableHtml,
    enqTextToHtml,
    enqWeightUsable,
    enqScopeRows,
} = require('../freight-tab-weight-editor')._test;

const QUOTE = { id: 'q1', quoteNumber: 'DSC-142' };

function makeState(rows, enq) {
    return {
        rows: rows,
        split: false,
        enquiry: Object.assign(
            { forSec: 0, weightOverride: null, pickup: 'Raipur', drop: 'Nagpur' },
            enq || {}
        ),
    };
}
// Every row costed: 500 x 7.39 = 3,695 and 1000 x 14.25 = 14,250 -> 17,945 kg.
function completeState() {
    return makeState([
        { id: 'r1', sec: 1, d: '2" NB X Heavy -- ERW', qty: 500, kgm: 7.39, removed: false },
        { id: 'r2', sec: 1, d: '4" NB X Sch 40', qty: 1000, kgm: 14.25, removed: false },
    ]);
}
// The same load with the second row's kg/m never filled in.
function incompleteState() {
    const st = completeState();
    st.rows[1].kgm = 0;
    return st;
}
const FULL_WEIGHT = 17945;

describe('buildEnquiryDraft — the closing line and the [TABLE] placeholder', () => {
    test('the closing line is exactly "Please include transit time."', () => {
        const draft = buildEnquiryDraft(QUOTE, completeState());
        const lines = draft.split('\n').filter(function (l) { return l.trim() !== ''; });
        // …the last line before the sign-off, verbatim.
        expect(lines[lines.length - 3]).toBe('Please include transit time.');
        expect(draft).toContain('\nPlease include transit time.\n');
    });

    test('door delivery is gone — DSC does not promise it, so the draft must not ask about it', () => {
        const draft = buildEnquiryDraft(QUOTE, completeState());
        expect(draft).not.toMatch(/door/i);
        expect(draft).not.toContain('Kindly include transit time and whether door delivery is covered.');
    });

    test('the draft carries the [TABLE] placeholder, above the closing line', () => {
        const draft = buildEnquiryDraft(QUOTE, completeState());
        expect(draft).toContain('[TABLE]');
        expect(draft.indexOf('[TABLE]')).toBeLessThan(draft.indexOf('Please include transit time.'));
    });

    test('the rest of the draft is intact: pickup, drop, weight, material and the sign-off', () => {
        const draft = buildEnquiryDraft(QUOTE, completeState());
        expect(draft).toContain('• Pickup: Raipur');
        expect(draft).toContain('• Drop: Nagpur');
        expect(draft).toContain('• Weight: ' + inr(FULL_WEIGHT) + ' kg (17.95 Tonn, 2 items)');
        expect(draft).toContain('• Material: MS pipes');
        expect(draft.trim().endsWith('Regards,\nDSC Pipes')).toBe(true);
    });
});

describe('freightItemsTableHtml — the consignment broken down per item', () => {
    test('shows every row: description, qty, kg/m and the row weight', () => {
        const tbl = freightItemsTableHtml(completeState());
        expect(tbl).toContain('<table');
        ['Item', 'Qty', 'kg/m', 'Weight'].forEach(function (h) { expect(tbl).toContain('>' + h + '</th>'); });

        expect(tbl).toContain('>2" NB X Heavy -- ERW</td>');
        expect(tbl).toContain('>500</td>');
        expect(tbl).toContain('>7.39</td>');
        expect(tbl).toContain('>' + inr(3695) + ' kg</td>');

        expect(tbl).toContain('>4" NB X Sch 40</td>');
        expect(tbl).toContain('>1000</td>');
        expect(tbl).toContain('>14.25</td>');
        expect(tbl).toContain('>' + inr(14250) + ' kg</td>');
    });

    test('a complete load prints the Total row', () => {
        const tbl = freightItemsTableHtml(completeState());
        expect(tbl).toContain('colspan="3"');
        expect(tbl).toContain('>Total</td>');
        expect(tbl).toContain('>' + inr(FULL_WEIGHT) + ' kg (17.95 Tonn)</td>');
    });

    test('no rows in scope -> no table at all (rather than an empty shell)', () => {
        expect(freightItemsTableHtml(makeState([]))).toBe('');
    });

    test('the table follows the enquiry scope: split + forSec limits it to that shipment', () => {
        const st = completeState();
        st.rows[1].sec = 2;
        st.split = true;
        st.enquiry.forSec = 2;
        expect(enqScopeRows(st).map(function (r) { return r.id; })).toEqual(['r2']);
        const tbl = freightItemsTableHtml(st);
        expect(tbl).toContain('4" NB X Sch 40');
        expect(tbl).not.toContain('2" NB X Heavy -- ERW');
    });

    test('a soft-deleted row is left out of the table', () => {
        const st = completeState();
        st.rows[0].removed = true;
        const tbl = freightItemsTableHtml(st);
        expect(tbl).not.toContain('2" NB X Heavy -- ERW');
        expect(tbl).toContain('4" NB X Sch 40');
    });
});

describe('THE GATE STILL HOLDS — a partial weight cannot sneak in via the item table', () => {
    test('a row with no kg/m: the draft prints "____ kg" and the table has NO Total row', () => {
        const st = incompleteState();
        expect(enqWeightUsable(st)).toBe(false);

        const draft = buildEnquiryDraft(QUOTE, st);
        expect(draft).toContain('• Weight: ____ kg (');
        expect(draft).not.toMatch(/Weight: [\d,]+ kg/);

        const tbl = freightItemsTableHtml(st);
        expect(tbl).not.toContain('Total');
        expect(tbl).not.toContain('colspan="3"');
        expect(tbl).not.toContain('font-weight:700');   // the Total row is the only bold cell
        // The uncounted row is still listed, but its weight cell is an em-dash, not a number.
        expect(tbl).toContain('>4" NB X Sch 40</td>');
        expect(tbl).toContain('>—</td>');
        // …and the one row that DID count is shown at its own weight, never as a grand total.
        expect(tbl).toContain('>' + inr(3695) + ' kg</td>');
    });

    test('a row with no quantity blocks the total in exactly the same way', () => {
        const st = completeState();
        st.rows[0].qty = null;
        expect(enqWeightUsable(st)).toBe(false);
        expect(freightItemsTableHtml(st)).not.toContain('Total');
        expect(buildEnquiryDraft(QUOTE, st)).toContain('• Weight: ____ kg (');
    });

    test('every row complete -> the total appears, in the draft and in the table', () => {
        const st = completeState();
        expect(enqWeightUsable(st)).toBe(true);
        expect(buildEnquiryDraft(QUOTE, st)).toContain('• Weight: ' + inr(FULL_WEIGHT) + ' kg (17.95 Tonn, 2 items)');
        expect(freightItemsTableHtml(st)).toContain('>' + inr(FULL_WEIGHT) + ' kg (17.95 Tonn)</td>');
    });

    test('a typed weightOverride vouches for an incomplete load, and the total follows it', () => {
        const st = incompleteState();
        st.enquiry.weightOverride = 20000;
        expect(enqWeightUsable(st)).toBe(true);
        expect(freightItemsTableHtml(st)).toContain('>' + inr(20000) + ' kg (20 Tonn)</td>');
        expect(buildEnquiryDraft(QUOTE, st)).toContain('• Weight: ' + inr(20000) + ' kg (20 Tonn, 2 items)');
    });
});

describe('enqTextToHtml — placeholder substitution and escaping order', () => {
    test('with state, [TABLE] becomes the item table and no placeholder is left behind', () => {
        const st = completeState();
        const out = enqTextToHtml(buildEnquiryDraft(QUOTE, st), st);
        expect(out).not.toContain('[TABLE]');
        expect(out).toContain('<table');
        expect(out).toContain('2" NB X Heavy -- ERW');
        expect(out).toContain('>Total</td>');
        // The surrounding message survives, with newlines turned into <br>.
        expect(out).toContain('Please include transit time.');
        expect(out).toContain('<br>');
    });

    test('with NO state the placeholder is STRIPPED, never printed literally', () => {
        const out = enqTextToHtml(buildEnquiryDraft(QUOTE, completeState()));
        expect(out).not.toContain('[TABLE]');
        expect(out).not.toContain('<table');
        expect(out).toContain('Please include transit time.');
    });

    test('state whose scope is empty also strips the placeholder (empty table -> nothing)', () => {
        const st = makeState([]);
        const out = enqTextToHtml(buildEnquiryDraft(QUOTE, st), st);
        expect(out).not.toContain('[TABLE]');
        expect(out).not.toContain('<table');
    });

    test('every [TABLE] occurrence is replaced, not just the first', () => {
        const st = completeState();
        const out = enqTextToHtml('one [TABLE] two [TABLE] three', st);
        expect(out).not.toContain('[TABLE]');
        expect(out.match(/<table/g)).toHaveLength(2);
    });

    test('THE ORDER MATTERS: the text is escaped BEFORE the table is injected', () => {
        const st = completeState();
        st.rows[0].d = '2" <b>pipe</b>';
        const out = enqTextToHtml('<script>alert(1)</script>\n[TABLE]', st);

        // The typed message is inert…
        expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(out).not.toContain('<script>');
        // …the description inside the table is inert…
        expect(out).toContain('&lt;b&gt;pipe&lt;/b&gt;');
        expect(out).not.toContain('<b>pipe</b>');
        // …but the table's own markup is live, which is only true if it went in AFTER escaping.
        expect(out).toContain('<table');
        expect(out).toContain('</table>');
    });

    test('the table builder escapes the description on its own too', () => {
        const st = completeState();
        st.rows[0].d = '2" <b>pipe</b> & fittings';
        const tbl = freightItemsTableHtml(st);
        expect(tbl).toContain('&lt;b&gt;pipe&lt;/b&gt; &amp; fittings');
        expect(tbl).not.toContain('<b>pipe</b>');
    });
});

// =============================================================================
// 3. SOURCE GUARDS — too DOM-bound to execute in Node
// =============================================================================
describe('DROP_ACCEPT — which dropped files a paste box will take (real regex)', () => {
    // eslint-disable-next-line no-new-func
    const DROP_ACCEPT = new Function(extractConst(html, 'DROP_ACCEPT') + '\nreturn DROP_ACCEPT;')();

    test('accepts the enquiry file types the app already handles', () => {
        ['enquiry.pdf', 'ENQUIRY.PDF', 'spec.doc', 'spec.docx', 'rates.xls', 'rates.xlsx',
            'notes.txt', 'photo.png', 'photo.jpg', 'photo.jpeg', 'anim.gif', 'shot.webp']
            .forEach(function (n) { expect(DROP_ACCEPT.test(n)).toBe(true); });
    });

    test('refuses anything else', () => {
        ['virus.exe', 'archive.zip', 'sheet.csv', 'page.html', 'noextension', 'trailing.pdf.exe']
            .forEach(function (n) { expect(DROP_ACCEPT.test(n)).toBe(false); });
    });
});

describe('source guard — drag-and-drop on the paste boxes', () => {
    const attachSrc = extractFunction(html, 'attachDropTarget');
    const initDropSrc = extractFunction(html, 'initDropTargets');
    const initQuotationsSrc = extractFunction(html, 'initQuotations');

    test('one shared attachDropTarget, bound to all three paste boxes with their file inputs', () => {
        expect(html).toContain('function attachDropTarget(boxId, fileInputId)');
        expect(initDropSrc).toContain("attachDropTarget('emailContent', 'fileUpload')");
        expect(initDropSrc).toContain("attachDropTarget('enquiryInputText', 'enquiryInputFile')");
        expect(initDropSrc).toContain("attachDropTarget('weightExtractionText', 'weightExtractionFile')");
    });

    test('initQuotations wires them up on boot', () => {
        expect(initQuotationsSrc).toContain('initDropTargets();');
    });

    test('dragover preventDefault — without it the browser navigates away and loses typed text', () => {
        expect(attachSrc).toContain("['dragenter', 'dragover'].forEach");
        expect(attachSrc).toContain('e.preventDefault(); e.stopPropagation(); highlight(true);');
        // …and the drop itself is prevented too.
        expect(attachSrc).toContain("box.addEventListener('drop'");
        expect(attachSrc).toContain('e.preventDefault(); e.stopPropagation(); highlight(false);');
    });

    test('a dropped file is handed to the REAL file input and a change event dispatched', () => {
        expect(attachSrc).toContain('const dts = new DataTransfer();');
        expect(attachSrc).toContain('dts.items.add(file);');
        expect(attachSrc).toContain('fileInput.files = dts.files;');
        expect(attachSrc).toContain("fileInput.dispatchEvent(new Event('change', { bubbles: true }));");
    });

    test('unsupported extensions are refused by DROP_ACCEPT before anything is attached', () => {
        const checkIdx = attachSrc.indexOf('if (!DROP_ACCEPT.test(file.name))');
        const attachIdx = attachSrc.indexOf('fileInput.files = dts.files;');
        expect(checkIdx).toBeGreaterThan(-1);
        expect(attachIdx).toBeGreaterThan(checkIdx);   // the refusal comes first
        expect(attachSrc).toContain('is not a file type this box accepts.');
    });

    test('dragged TEXT appends to the textarea and fires input (so existing handlers run)', () => {
        expect(attachSrc).toContain("const text = dt.getData('text/plain');");
        expect(attachSrc).toContain("box.tagName === 'TEXTAREA'");
        expect(attachSrc).toContain("box.dispatchEvent(new Event('input', { bubbles: true }));");
    });

    test('binding is idempotent, and the .drop-hover highlight rule exists', () => {
        expect(attachSrc).toContain("box.dataset.dropBound === 'true'");
        expect(attachSrc).toContain("box.dataset.dropBound = 'true';");
        expect(attachSrc).toContain("box.classList.toggle('drop-hover', on)");
        expect(html).toContain('.drop-hover {');
    });
});

describe('source guard — the "All Quotes" button and the month dropdown', () => {
    test('#approvalAllMonthsBtn is labelled "All Quotes" and still clears every filter', () => {
        const btn = html.slice(html.indexOf('<button id="approvalAllMonthsBtn"'));
        const tag = btn.slice(0, btn.indexOf('</button>') + '</button>'.length);
        expect(tag).toContain('>All Quotes</button>');
        expect(tag).toContain('onclick="approvalShowAllMonths()"');
        expect(tag).not.toContain('>All months<');
    });

    test('the month dropdown\'s blank option is still "All months" — the two are separate strings', () => {
        // Renaming the button must not silently rename the dropdown option (it IS a month
        // dropdown), so both are pinned here together.
        expect(extractFunction(html, 'initApprovalFilters'))
            .toContain('<option value="">All months</option>');
    });

    test('approvalShowAllMonths still exists and clears the filters it claims to', () => {
        const showAll = extractFunction(html, 'approvalShowAllMonths');
        expect(showAll).toContain("approvalMonthFilter = ''");
        expect(showAll).toContain('displayAllApprovedQuotations();');
    });
});

describe('source guard — the Enquiry section on the shared page', () => {
    test('renders AFTER the admin note and BEFORE the versions/timeline', () => {
        const noteIdx = renderSrc.indexOf('+ noteSection');
        const enqIdx = renderSrc.indexOf('Enquiry (what the customer asked for)');
        const versIdx = renderSrc.indexOf('Versions (newest first)');
        expect(noteIdx).toBeGreaterThan(-1);
        expect(enqIdx).toBeGreaterThan(noteIdx);
        expect(versIdx).toBeGreaterThan(enqIdx);
        expect(renderSrc).toContain('buildSharedEnquiryHtml(quotation)');
    });

    test('the timeline is fed by buildSharedEnquiryEvents, merged into the same entries list', () => {
        // The second argument is the sink the clickable "view enquiry" bodies are collected into;
        // what this test cares about is that the events still feed the same entries list.
        expect(renderSrc).toMatch(/buildSharedEnquiryEvents\(quotation(, _sqSentEnquiries)?\)\.forEach/);
        expect(renderSrc).toContain('entries.push(e);');
        expect(renderSrc).toContain('sort: 2,');     // versions
        expect(renderSrc).toContain('entries.sort(');
    });

    test('buildSharedEnquiryHtml reuses buildEnquiryFilesChipsHTML rather than re-implementing chips', () => {
        const enqSrc = extractFunction(html, 'buildSharedEnquiryHtml');
        expect(enqSrc).toContain('buildEnquiryFilesChipsHTML(q)');
        // The one builder owns the chip markup and the "not attached" notes — the shared page
        // must not grow a second copy that can drift.
        expect(enqSrc).not.toContain('ATTACHED FILES');
        expect(enqSrc).not.toContain('enquiryFileViewUrl');
        expect(extractFunction(html, 'buildEnquiryFilesChipsHTML')).toContain('ATTACHED FILES');
    });
});
