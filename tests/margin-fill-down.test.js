/**
 * Regression tests for the Margin % "fill down" button.
 *
 * Feature: a ↓ button next to each line item's Margin % copies that row's margin
 * into every item row BELOW it within the same pipe-type group, stopping at the
 * next pipe-type header (and skipping freight rows). It lives in index.html as
 * fillMarginDownBelow(buttonEl) and is rendered into the creation table, both
 * add-row templates, and (retrofitted at render time) the approval table.
 *
 * Two layers:
 *  - Source guards: assert index.html still ships the handler, the button markup,
 *    the group-boundary traversal, and the approval-table retrofit.
 *  - Behavioral: inline copy of the traversal semantics (fill down within a group).
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceFrom(marker, len = 4000) {
    const i = html.indexOf(marker);
    return i === -1 ? '' : html.slice(i, i + len);
}

// =============================================================================
// Source guards — tie the tests to the real code so a revert fails CI
// =============================================================================
describe('index.html source guards — margin fill-down', () => {
    test('ships the fillMarginDownBelow handler', () => {
        expect(html).toContain('function fillMarginDownBelow(buttonEl)');
    });

    test('handler stops at the pipe-type group boundary and skips freight rows', () => {
        const fn = sliceFrom('function fillMarginDownBelow(buttonEl)', 900);
        expect(fn).toContain("!row.classList.contains('pipe-type-header')");
        expect(fn).toContain("row.classList.contains('item-row')");
        expect(fn).toContain("!row.classList.contains('freight-row')");
        expect(fn).toContain('nextElementSibling');
        expect(fn).toContain('[data-field="marginPercent"]');
    });

    test('the ↓ button is wired to the handler', () => {
        expect(html).toContain('class="margin-fill-down-btn"');
        expect(html).toContain('onclick="fillMarginDownBelow(this)"');
    });

    test('the approval table retrofits the button onto older saved quotes', () => {
        expect(html).toContain('Ensure the margin cell has a "fill down" button');
        // Retrofit only adds the button when it is missing (no duplicates on new quotes).
        const retro = sliceFrom('Ensure the margin cell has a "fill down" button', 800);
        expect(retro).toContain("!row.querySelector('.margin-fill-down-btn')");
        expect(retro).toContain('margin-cell-wrap');
    });
});

// =============================================================================
// Behavioral — inline copy of the fill-down traversal semantics
// =============================================================================

/**
 * index.html — fillMarginDownBelow traversal, modelled over an ordered row list.
 * Copies the start row's margin into every 'item' row that follows it until the
 * next 'header' row; 'freight' rows are skipped but do not stop the walk. Rows
 * above (and the start row itself) are never changed.
 */
function fillMarginDown(rows, startIndex) {
    const out = rows.map(r => ({ ...r }));
    const value = out[startIndex].margin;
    for (let i = startIndex + 1; i < out.length; i++) {
        if (out[i].type === 'header') break;
        if (out[i].type === 'item') out[i].margin = value;
    }
    return out;
}

// GI group (rows 1-3) then ERW group (row 5)
const GROUPS = () => [
    { type: 'header', margin: null },   // 0  GI header
    { type: 'item',   margin: 5 },      // 1
    { type: 'item',   margin: 8 },      // 2
    { type: 'item',   margin: 12 },     // 3
    { type: 'header', margin: null },   // 4  ERW header
    { type: 'item',   margin: 20 },     // 5
];

describe('fillMarginDown — within-group fill', () => {
    test('copies the start margin to item rows below in the same group', () => {
        const r = fillMarginDown(GROUPS(), 1);
        expect(r.map(x => x.margin)).toEqual([null, 5, 5, 5, null, 20]);
    });

    test('does not cross into the next pipe-type group', () => {
        const r = fillMarginDown(GROUPS(), 1);
        expect(r[5].margin).toBe(20); // ERW row untouched
    });

    test('rows above the start row are unchanged', () => {
        const r = fillMarginDown(GROUPS(), 2); // start at second GI row (8)
        expect(r[1].margin).toBe(5);           // first GI row unchanged
        expect(r.map(x => x.margin)).toEqual([null, 5, 8, 8, null, 20]);
    });

    test('clicking the last row in a group changes nothing', () => {
        const r = fillMarginDown(GROUPS(), 3);
        expect(r.map(x => x.margin)).toEqual([null, 5, 8, 12, null, 20]);
    });

    test('freight rows are skipped but do not stop the walk', () => {
        const rows = [
            { type: 'header',  margin: null },
            { type: 'item',    margin: 5 },
            { type: 'freight', margin: null },
            { type: 'item',    margin: 9 },
        ];
        const r = fillMarginDown(rows, 1);
        expect(r[2].margin).toBe(null); // freight untouched
        expect(r[3].margin).toBe(5);    // item after freight still filled
    });
});
