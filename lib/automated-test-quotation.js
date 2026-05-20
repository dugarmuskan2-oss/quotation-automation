'use strict';

/**
 * Detect automated / debug / E2E quotations (not real customer quotes).
 * Keep in sync with isAutomatedTestQuotation() in index.html.
 */
const AUTOMATED_TEST_ID_PATTERNS = [
    /^e2e/i,
    /^test-save/i,
    /^dbg-/i,
    /^status-check/i,
    /^small-test/i,
    /^big-test/i
];

const AUTOMATED_TEST_QUOTE_NUMBER_PATTERNS = [
    /^E2E\//i,
    /^TEST-/i
];

/** Short debug quote numbers (exact match only — avoids false positives). */
const AUTOMATED_TEST_QUOTE_NUMBER_EXACT = new Set([
    'S1',
    'CHK',
    'BIG',
    'BIG2',
    'L1'
]);

function quotationIdAndQuoteNumber(quotation) {
    if (!quotation) {
        return { id: '', quoteNumber: '' };
    }
    const id = String(quotation.id || '');
    let quoteNumber = String(quotation.quoteNumber || '');
    const header = quotation.header && typeof quotation.header === 'object' ? quotation.header : null;
    if (!quoteNumber && header && header.quoteNumber) {
        quoteNumber = String(header.quoteNumber);
    }
    return { id, quoteNumber };
}

function isAutomatedTestQuotation(quotation) {
    if (!quotation) {
        return false;
    }
    const { id, quoteNumber } = quotationIdAndQuoteNumber(quotation);
    if (!id || id === 'QUOTE_NUMBER_COUNTER') {
        return false;
    }
    if (quotation.automatedTest === true) {
        return true;
    }
    if (AUTOMATED_TEST_ID_PATTERNS.some((re) => re.test(id))) {
        return true;
    }
    if (AUTOMATED_TEST_QUOTE_NUMBER_PATTERNS.some((re) => re.test(quoteNumber))) {
        return true;
    }
    if (AUTOMATED_TEST_QUOTE_NUMBER_EXACT.has(quoteNumber)) {
        return true;
    }
    return false;
}

/** Default TTL before a saved test row is auto-deleted (refreshed on each save). */
const AUTOMATED_TEST_TTL_MS = Number(process.env.AUTOMATED_TEST_TTL_MS) || 30 * 60 * 1000;

/** Legacy test rows without testExpiresAt are removed after this age. */
const AUTOMATED_TEST_LEGACY_MAX_AGE_MS = Number(process.env.AUTOMATED_TEST_LEGACY_MAX_AGE_MS) || 10 * 60 * 1000;

function isTestQuotationExpired(quotation, itemUpdatedAt) {
    if (!quotation) {
        return false;
    }
    const expiresAt = quotation.testExpiresAt;
    if (expiresAt) {
        const t = new Date(expiresAt).getTime();
        return !isNaN(t) && t <= Date.now();
    }
    const updatedAt = quotation.updatedAt || itemUpdatedAt;
    if (!updatedAt) {
        return true;
    }
    const t = new Date(updatedAt).getTime();
    if (isNaN(t)) {
        return true;
    }
    return Date.now() - t > AUTOMATED_TEST_LEGACY_MAX_AGE_MS;
}

module.exports = {
    isAutomatedTestQuotation,
    isTestQuotationExpired,
    AUTOMATED_TEST_TTL_MS,
    AUTOMATED_TEST_LEGACY_MAX_AGE_MS
};
