/**
 * Tests for server-side line item calculations.
 * These run when the AI returns quotation data — before it's sent to the frontend.
 *
 * Formula:
 *   finalRate  = round(unitRate × (1 + marginPercent / 100))
 *   lineTotal  = quantity × finalRate
 */

// Pure utility functions — import directly, no server or mocks needed
const { calculateLineItem, parseFlexibleNumber } = require('../utils/calculations');

// =============================================================================
// calculateLineItem
// =============================================================================
describe('calculateLineItem — finalRate', () => {
    test('applies margin correctly: 1000 + 15% = 1150, rounded', () => {
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '15', quantity: '1' });
        expect(result.finalRate).toBe('1150');
    });

    test('applies 0% margin — finalRate equals unitRate', () => {
        const result = calculateLineItem({ unitRate: '2500', marginPercent: '0', quantity: '1' });
        expect(result.finalRate).toBe('2500');
    });

    test('rounds finalRate to nearest whole number', () => {
        // 1000 × 1.155 = 1155.0 — rounds to 1155
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '15.5', quantity: '1' });
        expect(result.finalRate).toBe('1155');
    });

    test('rounds up at .5: 1000 × 1.1005 = 1100.5 → 1101', () => {
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '10.05', quantity: '1' });
        expect(result.finalRate).toBe('1101');
    });

    test('handles missing marginPercent — defaults to 0', () => {
        const result = calculateLineItem({ unitRate: '500', quantity: '1' });
        expect(result.finalRate).toBe('500');
    });

    test('handles empty string margin — defaults to 0', () => {
        const result = calculateLineItem({ unitRate: '500', marginPercent: '', quantity: '1' });
        expect(result.finalRate).toBe('500');
    });

    test('handles missing unitRate — defaults to 0', () => {
        const result = calculateLineItem({ marginPercent: '15', quantity: '5' });
        expect(result.finalRate).toBe('0');
        expect(result.lineTotal).toBe('0.00');
    });
});

describe('calculateLineItem — lineTotal', () => {
    test('multiplies quantity by finalRate', () => {
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '15', quantity: '50' });
        // finalRate = 1150, lineTotal = 50 × 1150 = 57500
        expect(result.lineTotal).toBe('57500.00');
    });

    test('handles quantity of 1', () => {
        const result = calculateLineItem({ unitRate: '2500', marginPercent: '20', quantity: '1' });
        // finalRate = 3000, lineTotal = 3000
        expect(result.lineTotal).toBe('3000.00');
    });

    test('handles decimal quantity', () => {
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '0', quantity: '2.5' });
        // finalRate = 1000, lineTotal = 2500
        expect(result.lineTotal).toBe('2500.00');
    });

    test('returns 0.00 when quantity is 0', () => {
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '15', quantity: '0' });
        expect(result.lineTotal).toBe('0.00');
    });

    test('returns 0.00 when quantity is missing', () => {
        const result = calculateLineItem({ unitRate: '1000', marginPercent: '15' });
        expect(result.lineTotal).toBe('0.00');
    });
});

describe('calculateLineItem — output format', () => {
    test('unitRate is formatted to 2 decimal places', () => {
        const result = calculateLineItem({ unitRate: '1000', quantity: '1' });
        expect(result.unitRate).toBe('1000.00');
    });

    test('lineTotal is formatted to 2 decimal places', () => {
        const result = calculateLineItem({ unitRate: '333', marginPercent: '0', quantity: '3' });
        expect(result.lineTotal).toBe('999.00');
    });

    test('kgPerMeter is empty string when not provided', () => {
        const result = calculateLineItem({ unitRate: '100', quantity: '1' });
        expect(result.kgPerMeter).toBe('');
    });

    test('kgPerMeter is formatted to 2 decimal places when provided', () => {
        const result = calculateLineItem({ unitRate: '100', quantity: '1', kgPerMeter: '3.5' });
        expect(result.kgPerMeter).toBe('3.50');
    });

    test('preserves originalDescription and identifiedPipeType', () => {
        const result = calculateLineItem({
            unitRate: '100', quantity: '1',
            originalDescription: '6" SCH 40 pipe',
            identifiedPipeType: 'Carbon Steel',
        });
        expect(result.originalDescription).toBe('6" SCH 40 pipe');
        expect(result.identifiedPipeType).toBe('Carbon Steel');
    });

    test('assigns a lineItemId when not provided', () => {
        const result = calculateLineItem({ unitRate: '100', quantity: '1' });
        expect(result.lineItemId).toBeTruthy();
    });

    test('preserves existing lineItemId', () => {
        const result = calculateLineItem({ unitRate: '100', quantity: '1', lineItemId: 'existing-id' });
        expect(result.lineItemId).toBe('existing-id');
    });
});

// =============================================================================
// parseFlexibleNumber
// =============================================================================
describe('parseFlexibleNumber', () => {
    test('parses plain integers', () => {
        expect(parseFlexibleNumber('1000')).toBe(1000);
    });

    test('parses plain decimals', () => {
        expect(parseFlexibleNumber('3.14')).toBe(3.14);
    });

    test('parses Western thousands: 1,000 → 1000', () => {
        expect(parseFlexibleNumber('1,000')).toBe(1000);
    });

    test('parses Indian lakh format: 1,00,000 → 100000', () => {
        expect(parseFlexibleNumber('1,00,000')).toBe(100000);
    });

    test('parses Indian ten-lakh format: 10,00,000 → 1000000', () => {
        expect(parseFlexibleNumber('10,00,000')).toBe(1000000);
    });

    test('parses Indian crore format: 1,00,00,000 → 10000000', () => {
        expect(parseFlexibleNumber('1,00,00,000')).toBe(10000000);
    });

    test('parses Indian format with decimal: 1,00,000.50 → 100000.5', () => {
        expect(parseFlexibleNumber('1,00,000.50')).toBe(100000.5);
    });

    test('parses plain thousands with decimal: 1,000.50 → 1000.5', () => {
        expect(parseFlexibleNumber('1,000.50')).toBe(1000.5);
    });

    test('returns null for null input', () => {
        expect(parseFlexibleNumber(null)).toBeNull();
    });

    test('returns null for undefined input', () => {
        expect(parseFlexibleNumber(undefined)).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(parseFlexibleNumber('')).toBeNull();
    });

    test('returns null for non-numeric string', () => {
        expect(parseFlexibleNumber('abc')).toBeNull();
    });

    test('parses numeric value passed as a number (not string)', () => {
        expect(parseFlexibleNumber(42)).toBe(42);
    });

    test('strips currency symbols and spaces', () => {
        expect(parseFlexibleNumber('₹ 1,000')).toBe(1000);
    });
});
