/**
 * @jest-environment node
 *
 * tests/revision-history.test.js
 *
 * Revisions + History (Phase 4) and the "Save as Revision" button-after-save
 * work: version numbering, snapshot capture + the 10-snapshot cap, the display
 * label ("DSC-108 (Rev 1)"), the post-send change description, and the History
 * empty state.
 *
 * These live inline in the browser-only SPA (index.html); extracted by name and
 * eval'd (same as tests/revision-signature.test.js). Functions that call helpers
 * (displayQuoteNumber -> currentRevisionNumber) are eval'd together; ones that
 * read the DOM freight line (buildRevisionSnapshotData / describePostSendChange)
 * get a stubbed snapshotFreightLine injected.
 *
 * NOTE: the revisionSignature fingerprint + the no-changes guard
 * (currentDiffersFromBaseline) are already covered by
 * tests/revision-signature.test.js and are intentionally NOT retested here.
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

function loadFns(names, sandbox) {
    const body = names.map(function(n) { return extractFunction(html, n); }).join('\n');
    const keys = Object.keys(sandbox || {});
    // eslint-disable-next-line no-new-func
    const factory = new Function(keys.join(','), body + '\nreturn ' + names[names.length - 1] + ';');
    return factory.apply(null, keys.map(function(k) { return sandbox[k]; }));
}

const currentRevisionNumber = loadFns(['currentRevisionNumber']);
const displayQuoteNumber = loadFns(['currentRevisionNumber', 'displayQuoteNumber']);
const revisionLabel = loadFns(['revisionLabel']);
const commitRevisionSnapshot = loadFns(['commitRevisionSnapshot']);
const formatRevisionDate = loadFns(['formatRevisionDate']);
const buildHistoryTabContent = loadFns(['buildHistoryTabContent']);
// snapshotFreightLine reads the DOM — inject a stub so these run under Node.
const buildSnapshotWithFreight = (freight) =>
    loadFns(['buildRevisionSnapshotData'], { snapshotFreightLine: function() { return freight || null; } });
const describeChangeWithFreight = (freight) =>
    loadFns(['describePostSendChange'], { snapshotFreightLine: function() { return freight || null; } });

describe('currentRevisionNumber — version number of the live quote (0 = Original)', () => {
    test('the persistent counter wins, even when 0', () => {
        expect(currentRevisionNumber({ revisionCount: 0 })).toBe(0);
        expect(currentRevisionNumber({ revisionCount: 3 })).toBe(3);
    });
    test('falls back to revisions.length for pre-counter quotes', () => {
        expect(currentRevisionNumber({ revisions: [{}, {}] })).toBe(2);
    });
    test('no data -> 0', () => {
        expect(currentRevisionNumber({})).toBe(0);
    });
});

describe('displayQuoteNumber — "(Rev N)" suffix for display only', () => {
    test('adds the suffix once revised', () => {
        expect(displayQuoteNumber({ quoteNumber: 'DSC-108', revisionCount: 1 })).toBe('DSC-108 (Rev 1)');
        expect(displayQuoteNumber({ quoteNumber: 'DSC-108', revisions: [{}, {}] })).toBe('DSC-108 (Rev 2)');
    });
    test('Original (rev 0) shows the bare number', () => {
        expect(displayQuoteNumber({ quoteNumber: 'DSC-108', revisionCount: 0 })).toBe('DSC-108');
        expect(displayQuoteNumber({ quoteNumber: 'DSC-108' })).toBe('DSC-108');
    });
    test('trims surrounding whitespace', () => {
        expect(displayQuoteNumber({ quoteNumber: '  DSC-108  ', revisionCount: 2 })).toBe('DSC-108 (Rev 2)');
    });
    test('empty quote number -> empty string', () => {
        expect(displayQuoteNumber({ quoteNumber: '', revisionCount: 2 })).toBe('');
        expect(displayQuoteNumber({})).toBe('');
    });
});

describe('revisionLabel — label for a stored snapshot', () => {
    test('revNo 0 is "Original"', () => {
        expect(revisionLabel({ revNo: 0 }, 5)).toBe('Original');
    });
    test('revNo N is "Rev N"', () => {
        expect(revisionLabel({ revNo: 3 }, 0)).toBe('Rev 3');
    });
    test('missing revNo falls back to the array index', () => {
        expect(revisionLabel({}, 0)).toBe('Original');
        expect(revisionLabel({}, 2)).toBe('Rev 2');
        expect(revisionLabel(null, 1)).toBe('Rev 1');
    });
});

describe('commitRevisionSnapshot — push + advance counter + 10-cap', () => {
    test('initialises revisions[], sets revisionCount = revNo + 1, marks revised', () => {
        const q = {};
        commitRevisionSnapshot(q, { revNo: 0 });
        expect(q.revisions.length).toBe(1);
        expect(q.revisionCount).toBe(1);
        expect(q.revised).toBe(true);
    });
    test('revisionCount tracks the committed snapshot revNo', () => {
        const q = {};
        commitRevisionSnapshot(q, { revNo: 0 });
        commitRevisionSnapshot(q, { revNo: 1 });
        commitRevisionSnapshot(q, { revNo: 2 });
        expect(q.revisionCount).toBe(3);
        expect(q.revisions.length).toBe(3);
    });
    test('caps stored snapshots at 10, dropping the oldest', () => {
        const q = {};
        for (let i = 0; i < 13; i++) commitRevisionSnapshot(q, { revNo: i, tag: 'r' + i });
        expect(q.revisions.length).toBe(10);
        // oldest dropped: first kept snapshot is r3, last is r12
        expect(q.revisions[0].tag).toBe('r3');
        expect(q.revisions[9].tag).toBe('r12');
        // counter still reflects the true latest version, not the capped array length
        expect(q.revisionCount).toBe(13);
    });
});

describe('buildRevisionSnapshotData — snapshot the current state before mutating', () => {
    test('captures revNo, change label, number, totals and a deep copy of line items', () => {
        const build = buildSnapshotWithFreight(null);
        const q = {
            quoteNumber: 'DSC-9',
            grandTotal: '1000',
            termsText: 'Net 30',
            lineItems: [{ originalDescription: 'Pipe', lineTotal: '1000' }],
        };
        const snap = build(q, 'Original');
        expect(snap.revNo).toBe(0);
        expect(snap.change).toBe('Original');
        expect(snap.quoteNumber).toBe('DSC-9');
        expect(snap.grandTotal).toBe('1000');
        expect(snap.termsText).toBe('Net 30');
        expect(snap.lineItems).toEqual([{ originalDescription: 'Pipe', lineTotal: '1000' }]);
        // deep copy — mutating the snapshot must not touch the source
        snap.lineItems[0].lineTotal = '9999';
        expect(q.lineItems[0].lineTotal).toBe('1000');
    });
    test('revNo derives from revisionCount, else revisions.length, else 0', () => {
        const build = buildSnapshotWithFreight(null);
        expect(build({ revisionCount: 4, lineItems: [] }, 'x').revNo).toBe(4);
        expect(build({ revisions: [{}], lineItems: [] }, 'x').revNo).toBe(1);
        expect(build({ lineItems: [] }, 'x').revNo).toBe(0);
    });
    test('a live freight line is appended to the snapshot items', () => {
        const build = buildSnapshotWithFreight({ originalDescription: 'Freight', lineTotal: '500' });
        const snap = build({ lineItems: [{ originalDescription: 'Pipe', lineTotal: '1000' }] }, 'x');
        expect(snap.lineItems).toHaveLength(2);
        expect(snap.lineItems[1]).toEqual({ originalDescription: 'Freight', lineTotal: '500' });
    });
    test('default change label when none given', () => {
        const build = buildSnapshotWithFreight(null);
        expect(build({ lineItems: [] }).change).toBe('Edited after sending');
    });
});

describe('describePostSendChange — what changed vs the sent snapshot', () => {
    test('FOR applied: existing freight -> "Freight set as FOR"', () => {
        const describe_ = describeChangeWithFreight(null);
        const snap = { lineItems: [{ originalDescription: 'Freight', lineTotal: '500' }], grandTotal: '1500' };
        expect(describe_(snap, { freightDistributedIntoMargin: true, grandTotal: '1500' })).toBe('Freight set as FOR');
    });
    test('FOR applied: no prior freight -> "Freight added (FOR)"', () => {
        const describe_ = describeChangeWithFreight(null);
        const snap = { lineItems: [{ originalDescription: 'Pipe', lineTotal: '1000' }], grandTotal: '1000' };
        expect(describe_(snap, { freightDistributedIntoMargin: true, grandTotal: '1000' })).toBe('Freight added (FOR)');
    });
    test('freight newly added -> "Freight added"', () => {
        const describe_ = describeChangeWithFreight({ lineTotal: '500' }); // live freight now present
        const snap = { lineItems: [{ originalDescription: 'Pipe', lineTotal: '1000' }], grandTotal: '1000' };
        expect(describe_(snap, { grandTotal: '1500' })).toBe('Freight added');
    });
    test('freight removed -> "Freight removed"', () => {
        const describe_ = describeChangeWithFreight(null); // no live freight
        const snap = { lineItems: [{ originalDescription: 'Freight', lineTotal: '500' }], grandTotal: '1500' };
        expect(describe_(snap, { grandTotal: '1000' })).toBe('Freight removed');
    });
    test('freight amount changed -> "Freight changed"', () => {
        const describe_ = describeChangeWithFreight({ lineTotal: '800' }); // live freight now 800
        const snap = { lineItems: [{ originalDescription: 'Freight', lineTotal: '500' }], grandTotal: '1500' };
        expect(describe_(snap, { grandTotal: '1800' })).toBe('Freight changed');
    });
    test('only the totals moved -> "Prices changed"', () => {
        const describe_ = describeChangeWithFreight(null);
        const snap = { lineItems: [{ originalDescription: 'Pipe', lineTotal: '1000' }], grandTotal: '1000' };
        expect(describe_(snap, { grandTotal: '1200' })).toBe('Prices changed');
    });
    test('nothing measurable changed -> "Edited after sending"', () => {
        const describe_ = describeChangeWithFreight(null);
        const snap = { lineItems: [{ originalDescription: 'Pipe', lineTotal: '1000' }], grandTotal: '1000' };
        expect(describe_(snap, { grandTotal: '1000' })).toBe('Edited after sending');
    });
});

describe('formatRevisionDate — empty for missing/invalid dates only', () => {
    test('empty / undefined / invalid -> empty string', () => {
        expect(formatRevisionDate('')).toBe('');
        expect(formatRevisionDate(undefined)).toBe('');
        expect(formatRevisionDate('not-a-real-date')).toBe('');
    });
    test('a valid ISO date produces a non-empty label (locale-formatted)', () => {
        expect(formatRevisionDate('2026-07-14T10:00:00.000Z').length).toBeGreaterThan(0);
    });
});

describe('buildHistoryTabContent — empty state', () => {
    const EMPTY = '<div class="qhist-empty">No revisions yet. Adding freight to a sent quote offers to create one — the version the customer already has is kept here, read-only.</div>';
    test('no revisions -> the read-only empty-state message', () => {
        expect(buildHistoryTabContent({})).toBe(EMPTY);
        expect(buildHistoryTabContent({ revisions: [] })).toBe(EMPTY);
    });
});

describe('source guard — Save-as-Revision button-after-save + baseline wiring', () => {
    // The button was briefly limited to SENT quotes, on the reasoning that a revision only
    // preserves the version the customer already has. The owner reversed that: the desk also
    // versions a quote before it goes out, so the button is always shown and the function no
    // longer refuses. Both halves matter — showing the button while the function still blocked
    // is exactly the "does nothing but scold" state the sent-only gate was introduced to fix.
    test('the button is rendered unconditionally', () => {
        expect(html).toContain('🔖 Save as Revision');
        expect(html).toContain('saveQuotationChanges(quotationId, { asRevision: true });');
        expect(html).not.toContain('const canRevise = !!quotation.sent;');
    });
    test('saveAsRevision does not refuse an unsent quote', () => {
        expect(html).not.toContain('Send this quote to the customer first — a revision keeps the version they already have.');
        // the only bail-out left is a quote that genuinely is not in the list
        expect(html).toContain("if (!quotation) { alert('Quotation not found!'); return; }");
    });
    test('the first save/approve establishes the revision baseline', () => {
        expect(html).toContain("if (!quotation.revisionBaseline) quotation.revisionBaseline = buildRevisionSnapshotData(quotation, 'Original');");
        expect(html).toContain('} else if (!quotation.revisionBaseline) {');
    });
    test('the 10-snapshot cap is present in commitRevisionSnapshot', () => {
        expect(html).toContain('if (quotation.revisions.length > 10) quotation.revisions = quotation.revisions.slice(-10);');
    });
});
