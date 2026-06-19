/**
 * Regression tests for editing header fields in the Approval section.
 *
 * Bug: approval-card header inputs use data-field (no id), but the live edit
 * handler identified the changed field by `changedInput.id` only, so editing
 * Kind Attn never updated quotation.customerName — the emailed greeting stayed
 * "Dear Sir/Madam". Fix: identify the field by `id || data-field`.
 *
 * Two layers:
 *  - Source guards: assert index.html still derives the field id with a
 *    data-field fallback, and that the send flow blocks on unsaved edits.
 *  - Behavioral: inline copy of the field-mapping + the send save-gate logic.
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
describe('index.html source guards', () => {
    const handler = sliceFrom('function updateQuotationFromApprovalSection', 6000);

    test('live edit handler derives the field id with a data-field fallback', () => {
        expect(handler).toContain('const inputId = changedInput.id');
        expect(handler).toContain("changedInput.getAttribute('data-field')");
    });

    test('handler still maps kindAttn to customerName', () => {
        expect(handler).toMatch(/inputId === 'kindAttn'[\s\S]{0,80}customerName/);
    });

    test('send flow blocks when there are unsaved edits', () => {
        const send = sliceFrom('async function sendQuotationToCustomer', 12000);
        expect(send).toMatch(/hasUnsavedEdits/);
        expect(send).toContain('unsaved changes');
    });
});

// =============================================================================
// Behavioral — inline copies of the pure logic from index.html
// =============================================================================

/** index.html — field id derivation used in updateQuotationFromApprovalSection */
function fieldIdOf(input) {
    return input.id || input.getAttribute('data-field') || '';
}

/** index.html — header field → quotation property mapping */
function applyHeaderFieldToQuotation(quotation, input) {
    const inputId = fieldIdOf(input);
    if (inputId === 'quotationDate') quotation.quotationDate = input.value;
    else if (inputId === 'preparedBy') quotation.preparedBy = input.value;
    else if (inputId === 'assignedTo') quotation.assignedTo = input.value;
    else if (inputId === 'checkedBy') quotation.checkedBy = input.value;
    else if (inputId === 'quoteNumber') quotation.quoteNumber = input.value;
    else if (inputId === 'kindAttn') quotation.customerName = input.value;
    else if (inputId === 'phoneNumber') { quotation.phoneNumber = input.value; quotation.contactDetails = quotation.mobileNumber || quotation.phoneNumber || ''; }
    else if (inputId === 'mobileNumber') { quotation.mobileNumber = input.value; quotation.contactDetails = quotation.mobileNumber || quotation.phoneNumber || ''; }
    else if (inputId === 'billTo') quotation.projectName = input.value;
    else if (inputId === 'shipTo') quotation.shipTo = input.value;
    return quotation;
}

/** A minimal stand-in for a DOM input with id and/or data-field. */
function mockInput({ id = '', dataField = null, value = '' }) {
    return { id, value, getAttribute: name => (name === 'data-field' ? dataField : null) };
}

/** index.html — send save-gate: blocks while there are unsaved edits. */
function blockedFromSending(quotation) {
    return quotation.hasUnsavedEdits === true;
}

describe('applyHeaderFieldToQuotation — data-field inputs (the regression)', () => {
    test('Kind Attn by data-field (no id) updates customerName', () => {
        const q = { customerName: '' };
        applyHeaderFieldToQuotation(q, mockInput({ dataField: 'kindAttn', value: 'Mr Rana' }));
        expect(q.customerName).toBe('Mr Rana');
    });

    test('Kind Attn by id (legacy creation template) still updates customerName', () => {
        const q = { customerName: '' };
        applyHeaderFieldToQuotation(q, mockInput({ id: 'kindAttn', value: 'Mr Rana' }));
        expect(q.customerName).toBe('Mr Rana');
    });

    test('Bill To by data-field updates projectName', () => {
        const q = {};
        applyHeaderFieldToQuotation(q, mockInput({ dataField: 'billTo', value: 'Acme Pvt Ltd' }));
        expect(q.projectName).toBe('Acme Pvt Ltd');
    });

    test('phone by data-field also refreshes contactDetails', () => {
        const q = {};
        applyHeaderFieldToQuotation(q, mockInput({ dataField: 'phoneNumber', value: '044-1234' }));
        expect(q.phoneNumber).toBe('044-1234');
        expect(q.contactDetails).toBe('044-1234');
    });

    test('an input with neither id nor data-field changes nothing', () => {
        const q = { customerName: 'keep' };
        applyHeaderFieldToQuotation(q, mockInput({ value: 'ignored' }));
        expect(q.customerName).toBe('keep');
    });
});

describe('send save-gate', () => {
    test('blocks while there are unsaved edits', () => {
        expect(blockedFromSending({ hasUnsavedEdits: true })).toBe(true);
    });

    test('allows sending when there are no unsaved edits', () => {
        expect(blockedFromSending({ hasUnsavedEdits: false })).toBe(false);
        expect(blockedFromSending({})).toBe(false);
    });
});
