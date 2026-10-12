/**
 * @jest-environment node
 *
 * tests/price-list-book.test.js
 *
 * The in-app Price List (utils/priceListBook.js) and how quotes are priced from it
 * (utils/priceList.js). The owner's rules:
 *   - An edit is a DRAFT. Quotes keep pricing from the LIVE list until someone checks the draft.
 *   - While a list has an unchecked draft, that list's lines on new quotes get NO price (blank
 *     and red). Only that list — the others keep pricing.
 *   - Checking needs a name, and makes the draft the next live version.
 *   - ERW/GI are priced from "Cost/Meter", never the ~5% higher "Price" column.
 *   - A size not in the list, or an angle/bar filed under a pipe type, gets no price.
 */

const Book = require('../utils/priceListBook');
const { applyPriceListRates, OUTCOME, SEAMLESS_COST } = require('../utils/priceList');
const { checkLinePrice } = require('../utils/priceList')._test;

const HEAD = ['Size', 'Inch', 'Light/Medium/Heavy', 'Cost/Meter', 'Price', 'KG/MTR'];
const ERW_V1 = [HEAD, ['E2M', '2"', 'Medium', '200', '210', '5.44'], ['E3H', '3"', 'Heavy', '400', '420', '9.0']];
const ERW_V2 = [HEAD, ['E2M', '2"', 'Medium', '250', '262', '5.44'], ['E4H', '4"', 'Heavy', '500', '525', '12.0']];
const GI_V1 = [HEAD, ['G2H', '2"', 'Heavy', '300', '315', '6.19']];
const SEAMLESS_V1 = [['Size', 'Inch', 'SCH', 'Cost/Meter', 'Price per Meter'], ['S2', '2"', '40', '350', '380']];

const ERW_2M = { originalDescription: '2" NB X Medium -- ERW', identifiedPipeType: 'MS ERW Pipe', quantity: '10', unitRate: '999' };
const GI_2H = { originalDescription: '2" NB X Heavy -- GI', identifiedPipeType: 'GI Pipe', quantity: '10', unitRate: '999' };

// A document with ERW and GI live (version 1), built through the real transitions.
function liveDoc() {
    let d = Book.emptyDoc();
    d = Book.saveDraft(d, 'erw', ERW_V1, { editedBy: 'A' });
    d = Book.checkDraft(d, 'erw', 'Checker').doc;
    d = Book.saveDraft(d, 'gi', GI_V1, { editedBy: 'A' });
    d = Book.checkDraft(d, 'gi', 'Checker').doc;
    return d;
}
const recalc = li => Object.assign({}, li, { finalRate: li.unitRate, lineTotal: String(Number(li.unitRate) * Number(li.quantity)) });

describe('draft → check → live', () => {
    test('an edit does not reach quotes until it is checked: the LIVE price is used meanwhile', () => {
        const d = Book.saveDraft(liveDoc(), 'erw', ERW_V2, { editedBy: 'B' });
        const book = Book.bookFromDoc(d);
        expect(book.erw['2|m']).toBe(200);           // live v1, not the draft's 250
        expect(book.pending).toEqual(['erw']);
    });

    test('while ERW has an unchecked draft, ERW lines get NO price — GI lines still price', () => {
        const d = Book.saveDraft(liveDoc(), 'erw', ERW_V2, { editedBy: 'B' });
        const { lineItems } = applyPriceListRates(Book.bookFromDoc(d), [ERW_2M, GI_2H], recalc);
        expect(lineItems[0].unitRate).toBe('');
        expect(lineItems[0].lineTotal).toBe('');
        expect(lineItems[0].rateCheck).toBe(OUTCOME.LIST_BEING_CHANGED);
        expect(lineItems[1].unitRate).toBe('300');
        expect(lineItems[1].rateCheck).toBe(OUTCOME.PRICED);
    });

    test('checking makes the draft the next live version and clears the draft', () => {
        const before = Book.saveDraft(liveDoc(), 'erw', ERW_V2, { editedBy: 'B' });
        const { doc, replaced } = Book.checkDraft(before, 'erw', '  Ravi ');
        expect(doc.lists.erw.live.version).toBe(2);
        expect(doc.lists.erw.live.checkedBy).toBe('Ravi');
        expect(doc.lists.erw.draft).toBeNull();
        expect(replaced.version).toBe(1);
        const book = Book.bookFromDoc(doc);
        expect(book.erw['2|m']).toBe(250);
        expect(book.pending).toEqual([]);
        expect(book.versions.erw).toBe(2);
    });

    test('checking needs a name, and needs a draft', () => {
        const d = Book.saveDraft(liveDoc(), 'erw', ERW_V2, { editedBy: 'B' });
        expect(() => Book.checkDraft(d, 'erw', '   ')).toThrow(/name/);
        expect(() => Book.checkDraft(liveDoc(), 'erw', 'Ravi')).toThrow(/no changes/);
    });

    test('discarding a draft keeps the live list and unblocks pricing', () => {
        const d = Book.discardDraft(Book.saveDraft(liveDoc(), 'erw', ERW_V2, { editedBy: 'B' }), 'erw');
        expect(d.lists.erw.draft).toBeNull();
        expect(d.lists.erw.live.version).toBe(1);
        expect(Book.bookFromDoc(d).pending).toEqual([]);
        expect(() => Book.discardDraft(d, 'erw')).toThrow(/no draft/);
    });

    test('every change advances rev (so two people saving at once can be told apart)', () => {
        const d0 = liveDoc();
        const d1 = Book.saveDraft(d0, 'erw', ERW_V2, { editedBy: 'B' });
        expect(d1.rev).toBe(d0.rev + 1);
    });

    test('unknown list names are refused', () => {
        expect(() => Book.saveDraft(liveDoc(), 'copper', ERW_V1, {})).toThrow(/Unknown price list/);
    });
});

describe('a list that cannot be priced from is never saved', () => {
    test('no Cost/Meter column → refused', () => {
        const rows = [['Size', 'Inch', 'Light/Medium/Heavy', 'Price'], ['E2M', '2"', 'Medium', '210']];
        expect(() => Book.saveDraft(Book.emptyDoc(), 'erw', rows, {})).toThrow(/Cost\/Meter/);
    });
    test('a rate column with no numbers → refused', () => {
        const rows = [HEAD, ['E2M', '2"', 'Medium', '', '', '']];
        expect(() => Book.saveDraft(Book.emptyDoc(), 'erw', rows, {})).toThrow(/No prices/);
    });
    test('header only → refused', () => {
        expect(() => Book.cleanRows([HEAD])).toThrow(/header row and at least one/);
    });
    test('blank rows and empty unheaded columns are dropped, cells trimmed', () => {
        const rows = [['Size', ' Inch ', ''], [' A ', '2"', ''], ['', '', ''], ['B', '3"']];
        expect(Book.cleanRows(rows)).toEqual([['Size', 'Inch'], ['A', '2"'], ['B', '3"']]);
    });
});

describe('which price a line gets', () => {
    const book = Book.bookFromDoc(liveDoc());

    test('ERW/GI use Cost/Meter, never the Price column', () => {
        expect(checkLinePrice(book, ERW_2M).listPrice).toBe(200);   // Price column says 210
    });
    test('the AI\'s own rate is kept beside, never used', () => {
        const { lineItems } = applyPriceListRates(book, [ERW_2M], recalc);
        expect(lineItems[0].unitRate).toBe('200');
        expect(lineItems[0].aiUnitRate).toBe('999');
    });
    test('a size not in the list gets no price', () => {
        const li = Object.assign({}, ERW_2M, { originalDescription: '6" NB X Heavy -- ERW' });
        const { lineItems } = applyPriceListRates(book, [li], recalc);
        expect(lineItems[0].unitRate).toBe('');
        expect(lineItems[0].rateCheck).toBe(OUTCOME.SIZE_NOT_IN_LIST);
    });
    test('an angle filed under ERW never takes a pipe price', () => {
        const li = Object.assign({}, ERW_2M, { originalDescription: 'ISA 2" Medium angle' });
        expect(checkLinePrice(book, li).outcome).toBe(OUTCOME.NOT_A_LISTED_TYPE);
    });
    test('a list never checked live prices nothing', () => {
        const li = { originalDescription: '2" NB X SCH 40', identifiedPipeType: 'Seamless', quantity: '1' };
        expect(checkLinePrice(book, li).outcome).toBe(OUTCOME.NO_PRICE_LIST);
    });
    test('seamless uses "Price per Meter", and keeps its Cost/Meter as the cost table', () => {
        let d = Book.saveDraft(liveDoc(), 'seamless', SEAMLESS_V1, {});
        d = Book.checkDraft(d, 'seamless', 'Ravi').doc;
        const b = Book.bookFromDoc(d);
        expect(b.seamless['2|40']).toBe(380);
        expect(b[SEAMLESS_COST]['2|40']).toBe(350);
    });
});

describe('diffRows — what changed in a draft', () => {
    test('changed cells, added and removed rows are matched by size + class, not position', () => {
        const changes = Book.diffRows(ERW_V1, ERW_V2);
        expect(changes).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'changed', key: '2|m', column: 'Cost/Meter', from: '200', to: '250' }),
            expect.objectContaining({ kind: 'added', key: '4|h' }),
            expect.objectContaining({ kind: 'removed', key: '3|h', label: 'E3H' }),
        ]));
        // An unchanged KG/MTR on the 2" row is not reported.
        expect(changes.some(c => c.key === '2|m' && c.column === 'KG/MTR')).toBe(false);
    });
    test('a re-ordered list with the same values reports nothing', () => {
        const reordered = [HEAD, ERW_V1[2], ERW_V1[1]];
        expect(Book.diffRows(ERW_V1, reordered)).toEqual([]);
    });
});
