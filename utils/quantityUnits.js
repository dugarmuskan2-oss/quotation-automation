'use strict';

// Quantities asked in kg, and items that are not pipes.
//
// DSC-2823 asked for 2,497 kg, 876 kg, … and came out as 6 m on every line: the AI's "default
// 6 m" rule fired because the enquiry gave no METRES. And an angle (ISA 75x75x6) and a square bar
// were filed under "MS ERW Pipe". Now the AI returns the quantity and unit exactly as written, the
// app turns kg into metres using the PRICE LIST's kg/m, and anything that is not a pipe goes under
// its own heading and never gets a pipe price. Nothing is guessed: a kg line whose size has no
// kg/m in the list keeps NO quantity — blank and red — with the enquiry's figure beside it.
//
// Pure module: no I/O.

// Added to the generation prompt. It ships with the code (not the editable instructions) so the
// AI's answer and the app's handling of it can never be out of step.
const UNIT_AND_ITEM_RULES = `
QUANTITY AND UNIT — this overrides any default-quantity rule in the system instructions:
- Put the quantity EXACTLY as the enquiry gives it in "quantity", and its unit in "unit": "m" for metres, "kg" for kilograms (convert tonnes/MT to kg: 1 MT = 1000 kg), "nos" for pieces/numbers/lengths.
- NEVER convert kg to metres yourself — the app does that from the price list.
- Only when the enquiry gives NO quantity at all for an item, use 6 with unit "m".
NOT PIPES — angles (ISA), round/square/flat bars, rods, plates, sheets, channels (ISMC), beams (ISMB), flanges and fittings are NOT pipes. Set "identifiedPipeType" to "Other items" for them — never ERW, GI or Seamless — and leave their rate empty.`;

const OTHER_ITEMS = 'Other items';

// Words that mean the line is not a pipe, whatever pipe type it was filed under.
const NON_PIPE = /\b(ISA|ANGLES?|BARS?|ROUND\s*BAR|SQUARE\s*BAR|FLAT|FLATS|RODS?|PLATES?|SHEETS?|CHANNELS?|ISMC|ISMB|ISLB|BEAMS?|JOIST|FLANGES?|ELBOWS?|BENDS?|TEES?|REDUCERS?|COUPLINGS?|SOCKETS?|NIPPLES?|VALVES?)\b/i;

function isNonPipeItem(description) {
    return NON_PIPE.test(String(description == null ? '' : description));
}

// 'kg' | 'm' | 'nos' | '' from whatever the AI wrote.
function normaliseUnit(unit) {
    const u = String(unit == null ? '' : unit).trim().toLowerCase();
    if (/^(kg|kgs|kilo|kilos|kilograms?)$/.test(u)) return 'kg';
    if (/^(m|mtr|mtrs|meters?|metres?|rmt|rm)$/.test(u)) return 'm';
    if (/^(nos?|pcs?|pieces?|numbers?|lengths?)$/.test(u)) return 'nos';
    return '';
}

// File every non-pipe line under "Other items" so it never sits in (or is priced as) a pipe group.
function markNonPipeItems(lineItems) {
    let moved = 0;
    (lineItems || []).forEach(li => {
        if (li && isNonPipeItem(li.originalDescription) && li.identifiedPipeType !== OTHER_ITEMS) {
            li.identifiedPipeType = OTHER_ITEMS;
            moved++;
        }
    });
    return moved;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Turn kg lines into metres. `units[i]` is the unit the AI gave line i; `kgPerMeterOf(li)` returns
// the PRICE LIST's kg/m for a line (or null). A line without a list weight gets no quantity.
function convertKgQuantities(lineItems, units, kgPerMeterOf) {
    const out = { converted: 0, missing: 0 };
    (lineItems || []).forEach((li, i) => {
        if (!li || normaliseUnit(units[i]) !== 'kg') return;
        const kg = parseFloat(String(li.quantity == null ? '' : li.quantity).replace(/,/g, ''));
        li.enquiryQty = (Number.isFinite(kg) ? kg : String(li.quantity)) + ' kg';
        const kgm = kgPerMeterOf(li);
        if (Number.isFinite(kg) && kg > 0 && kgm > 0) {
            li.quantity = String(round2(kg / kgm));
            out.converted++;
        } else {
            li.quantity = '';
            li.quantityMissing = true;
            out.missing++;
        }
    });
    return out;
}

// After the price step recalculates totals, a line with no quantity must stay blank — not 0.
function keepMissingQuantitiesBlank(lineItems) {
    (lineItems || []).forEach(li => {
        if (li && li.quantityMissing) { li.quantity = ''; li.lineTotal = ''; }
    });
}

module.exports = { UNIT_AND_ITEM_RULES, OTHER_ITEMS, isNonPipeItem, normaliseUnit, markNonPipeItems,
    convertKgQuantities, keepMissingQuantitiesBlank };
