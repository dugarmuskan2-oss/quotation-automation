'use strict';

/**
 * utils/calculations.js
 *
 * Pure calculation helpers used by the quotation generator and tests.
 */

// ─── ID generator ─────────────────────────────────────────────────────────────

function createLineItemId(prefix = 'line-item') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Number parsing ───────────────────────────────────────────────────────────

/**
 * Parse a number that may use Indian (lakh/crore) or Western thousand-separator
 * formatting, currency symbols, or plain decimals.
 *
 * Examples:
 *   '1,00,000'   → 100000   (Indian lakh)
 *   '1,00,00,000'→ 10000000 (Indian crore)
 *   '1,000'      → 1000     (Western)
 *   '₹ 1,000'    → 1000
 *   '3.14'       → 3.14
 *   null / ''    → null
 */
function parseFlexibleNumber(value) {
    if (value == null) return null;

    let normalized = String(value).trim();
    if (!normalized) return null;

    // Strip currency symbols, spaces, and other non-numeric characters
    // (keep digits, commas, dots, and sign characters)
    normalized = normalized.replace(/[^\d,.\-+]/g, '');
    if (!normalized) return null;

    const hasComma = normalized.includes(',');
    const hasDot   = normalized.includes('.');

    if (hasComma && hasDot) {
        // Ambiguous — use position to decide which is the decimal separator
        if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
            // European style: 1.000,50  → strip dots, replace comma with dot
            normalized = normalized.replace(/\./g, '').replace(',', '.');
        } else {
            // Western/Indian style: 1,000.50 or 1,00,000.50  → strip commas
            normalized = normalized.replace(/,/g, '');
        }
    } else if (hasComma) {
        // Indian (1,00,000) and Western (1,000) both use comma as thousand separator
        // (Indian decimal separator is always a dot, never a comma)
        normalized = normalized.replace(/,/g, '');
    }

    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

// ─── Line-item calculation ─────────────────────────────────────────────────────

/**
 * Calculate finalRate and lineTotal for a single quotation line item.
 *
 * Formula:
 *   finalRate = round(unitRate × (1 + marginPercent / 100))
 *   lineTotal = quantity × finalRate
 *
 * @param {object} item  Raw line item from the AI or frontend
 * @returns {object}     Normalised line item with all numeric fields formatted
 */
function calculateLineItem(item) {
    const unitRate        = parseFloat(item.unitRate) || 0;
    const kgPerMeterRaw   = parseFlexibleNumber(item.kgPerMeter);
    const kgPerMeter      = Number.isFinite(kgPerMeterRaw) ? kgPerMeterRaw : null;
    const marginPercentRaw = parseFloat(item.marginPercent);
    const marginPercent   = Number.isFinite(marginPercentRaw) ? marginPercentRaw : 0;
    const quantity        = parseFloat(item.quantity) || 0;

    const finalRate = Math.round(unitRate * (1 + marginPercent / 100));
    const lineTotal = quantity * finalRate;

    return {
        lineItemId:          item.lineItemId || createLineItemId(),
        originalDescription: item.originalDescription || '',
        identifiedPipeType:  item.identifiedPipeType || '',
        quantity:            quantity.toString(),
        unitRate:            unitRate.toFixed(2),
        kgPerMeter:          kgPerMeter == null ? '' : kgPerMeter.toFixed(2),
        marginPercent:       marginPercent.toString(),
        finalRate:           String(finalRate),
        lineTotal:           lineTotal.toFixed(2),
    };
}

/** Map a free-text pipe-type string to its bucket: 'Seamless' | 'GI' | 'ERW' | ''. */
function pipeTypeBucket(pipeTypeText) {
    const value = String(pipeTypeText || '').toLowerCase();
    if (value.includes('seamless')) return 'Seamless';
    if (value.includes('gi') || value.includes('galvan')) return 'GI';
    if (value.includes('erw')) return 'ERW';
    return '';
}

/**
 * Tiny derived summary of a quote's line items, stored on the quotation so the
 * admin "Margins to allocate" desk can render without fetching full line items.
 * Shape: { count, types: ['Seamless','ERW',...], noRate }
 */
function buildItemSummary(lineItems) {
    const items = Array.isArray(lineItems) ? lineItems : [];
    const types = [];
    let noRate = 0;
    items.forEach(item => {
        const bucket = pipeTypeBucket(item && item.identifiedPipeType);
        if (bucket && types.indexOf(bucket) === -1) types.push(bucket);
        const rate = parseFloat(item && item.unitRate);
        if (!Number.isFinite(rate) || rate <= 0) noRate++;
    });
    return { count: items.length, types, noRate };
}

/** Normalize an admin margin pct ('' | number-ish) to a finite number or 0. */
function adminPct(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Stamp the admin's per-pipe-type margin decisions onto line items.
 * adminMargins shape: { seamless: {mode:'price'|'cost', pct}, erw: {pct}, gi: {pct} }
 *  - Seamless 'price' mode: quote at the price-list rate (margin 0 — the list
 *    price already carries margin).
 *  - Seamless 'cost' mode: base becomes costRate when the AI extracted one
 *    (falls back to the existing unitRate), plus pct% margin.
 *  - ERW / GI: unitRate is already the cost column, plus pct% margin.
 * Items with an unknown pipe type or no rate are left for staff (margin set,
 * rate awaited). Returns a NEW array; never mutates the input.
 */
function stampAdminMargins(lineItems, adminMargins) {
    const margins = (adminMargins && typeof adminMargins === 'object') ? adminMargins : {};
    return (Array.isArray(lineItems) ? lineItems : []).map(item => {
        const bucket = pipeTypeBucket(item && item.identifiedPipeType);
        const next = { ...item };
        if (bucket === 'Seamless') {
            const cfg = margins.seamless || {};
            if (cfg.mode === 'cost') {
                const costRate = parseFloat(next.costRate);
                if (Number.isFinite(costRate) && costRate > 0) next.unitRate = String(costRate);
                next.marginPercent = String(adminPct(cfg.pct));
            } else {
                next.marginPercent = '0';   // price list already includes margin
            }
        } else if (bucket === 'ERW' || bucket === 'GI') {
            const cfg = margins[bucket.toLowerCase()] || {};
            next.marginPercent = String(adminPct(cfg.pct));
        } else {
            return next;   // unknown type — staff decides (admin note carries intent)
        }
        return calculateLineItem(next);
    });
}

module.exports = { createLineItemId, parseFlexibleNumber, calculateLineItem, pipeTypeBucket, buildItemSummary, stampAdminMargins };
