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

module.exports = { createLineItemId, parseFlexibleNumber, calculateLineItem };
