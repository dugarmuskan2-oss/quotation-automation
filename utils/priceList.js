'use strict';

// Pipe prices looked up in the in-app price lists (GI / ERW / Seamless — see priceListBook.js).
//
// The AI used to read the rate out of the PDF price lists itself, and nothing checked it: a row
// slip, a wrong class ("C class heavy duty" quoted at Medium, DSC-2787) or the wrong column went
// straight into the quote. Now the AI only reads the ENQUIRY — size, class, pipe type, quantity —
// and the rate comes from here. A line whose size is not in the sheet gets NO rate: it stays blank
// and red for a person to fill. Nothing is guessed, and the AI's own number is kept beside it
// (aiUnitRate) so the two can be compared when a quote is checked.
//
// Keys are built by the same code as the kg/m table (makeRowKeyer / parseDescription), so a size
// can never match one way for weight and another way for price.

const { makeRowKeyer, cellNumber, findCol, parseDescription, weightKey } = require('./pipeWeights');

// Which money column is the rate, per list. ERW and GI carry "Cost/Meter" and, beside it, "Price"
// (about 5% higher) — the rate is Cost/Meter, never Price. Seamless uses "Price per Meter"; its
// "Cost/Meter" is kept too (the seamless COST table), for the admin's "cost + margin" mode.
const COST_COLUMN = [/^cost\s*\/\s*(m|mtr|meter|metre)s?$/, /cost\s*(\/|per)\s*(m|mtr|meter|metre)/];
const RATE_COLUMN = {
    erw:      COST_COLUMN,
    gi:       COST_COLUMN,
    seamless: [/^price\s*(\/|per)\s*(m|mtr|meter|metre)s?$/, /price\s*(\/|per)\s*(m|mtr|meter|metre)/],
};
const SEAMLESS_COST = 'seamlessCost';   // key of the seamless cost table inside the stored price file

// Build { "size|class" -> rate per metre } from a price list's rows (first row = header).
// Throws when the rate column is missing — a sheet we cannot read must not quietly price nothing.
function buildPriceMap(rows, pipeType) {
    if (!Array.isArray(rows) || rows.length < 2) return {};
    const iRate = findCol(rows[0], RATE_COLUMN[pipeType] || []);
    if (iRate < 0) {
        const want = pipeType === 'seamless' ? '"Price per Meter"' : '"Cost/Meter"';
        throw new Error(`No ${want} column found in the ${pipeType.toUpperCase()} price list.`);
    }
    return mapColumn(rows, iRate);
}

// Seamless only: { "size|class" -> Cost/Meter }. Empty when the sheet has no cost column.
function buildSeamlessCostMap(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return {};
    const iCost = findCol(rows[0], COST_COLUMN);
    return iCost < 0 ? {} : mapColumn(rows, iCost);
}

function mapColumn(rows, col) {
    const rowKey = makeRowKeyer(rows[0]);
    const map = {};
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const key = rowKey(row);
        const rate = cellNumber(row[col]);
        if (key && Number.isFinite(rate)) map[key] = rate;
    }
    return map;
}

// 'seamless' | 'erw' | 'gi' | null from a line's pipe type text.
function priceListTypeOf(pipeType) {
    const t = String(pipeType == null ? '' : pipeType).toLowerCase();
    if (/seamless/.test(t)) return 'seamless';
    if (/erw/.test(t)) return 'erw';
    if (/\bgi\b|galvan/.test(t)) return 'gi';
    return null;
}

// Why a line did or did not get a price — one plain reason per line, saved with the quote.
const OUTCOME = {
    PRICED: 'priced',                   // rate taken from the price list
    NOT_A_LISTED_TYPE: 'not-a-listed-type', // not GI / ERW / Seamless (flange, fitting, plate…)
    NO_PRICE_LIST: 'no-price-list',     // that list has never been checked and made live
    LIST_BEING_CHANGED: 'list-being-changed', // that list has edits not yet checked — no prices until it is
    SIZE_NOT_IN_LIST: 'size-not-in-list', // the size/class the AI read is not a row in the sheet
};

// Look one line up. Pure: says what the price is and why, changes nothing.
function checkLinePrice(book, li) {
    const description = String(li.originalDescription || li.description || '');
    const type = priceListTypeOf(li.identifiedPipeType);
    const { size, cls } = parseDescription(description);
    const key = size ? weightKey(size, cls) : '';
    const base = { description, pipeType: li.identifiedPipeType || '', list: type, size, cls, key,
        aiPrice: String(li.unitRate == null ? '' : li.unitRate) };
    let outcome;
    if (!type) outcome = OUTCOME.NOT_A_LISTED_TYPE;
    else if ((book.pending || []).includes(type)) outcome = OUTCOME.LIST_BEING_CHANGED;
    else if (!book[type] || !Object.keys(book[type]).length) outcome = OUTCOME.NO_PRICE_LIST;
    else if (!key || !Object.prototype.hasOwnProperty.call(book[type], key)) outcome = OUTCOME.SIZE_NOT_IN_LIST;
    else {
        const costs = type === 'seamless' ? (book[SEAMLESS_COST] || {}) : {};
        const listCost = Object.prototype.hasOwnProperty.call(costs, key) ? costs[key] : null;
        return Object.assign(base, { outcome: OUTCOME.PRICED, listPrice: book[type][key], listCost,
            listVersion: (book.versions || {})[type] || null });
    }
    return Object.assign(base, { outcome, listPrice: null });
}

// Set every line's rate from the price list, or blank it. Takes lines already run through
// calculateLineItem and a `recalc` (that same function) so a new rate re-derives final rate and
// total by the one rule used everywhere. Returns the new lines and the per-line check record.
//
// Runs at GENERATION time only, before anyone has typed a rate. Never point it at a saved quote —
// a rate there may be a hand correction.
function applyPriceListRates(book, lineItems, recalc) {
    const checks = [];
    const lines = (Array.isArray(lineItems) ? lineItems : []).map(li => {
        if (!li || typeof li !== 'object') return li;
        const check = checkLinePrice(book || {}, li);
        checks.push(check);
        // The AI's own seamless cost is dropped like its rate — only the sheet's figure is used.
        const extra = { aiUnitRate: check.aiPrice, rateCheck: check.outcome, costRate: check.listCost ? String(check.listCost) : '' };
        if (check.outcome === OUTCOME.PRICED) {
            return Object.assign(recalc(Object.assign({}, li, { unitRate: String(check.listPrice) })), extra);
        }
        return Object.assign({}, li, { unitRate: '', finalRate: '', lineTotal: '' }, extra);
    });
    const counts = {};
    checks.forEach(c => { counts[c.outcome] = (counts[c.outcome] || 0) + 1; });
    return { lineItems: lines, priceCheck: { checkedAt: new Date().toISOString(), listVersions: (book && book.versions) || {}, counts, lines: checks } };
}

module.exports = { buildPriceMap, buildSeamlessCostMap, SEAMLESS_COST, applyPriceListRates, priceListTypeOf, OUTCOME,
    _test: { checkLinePrice, RATE_COLUMN } };
