/**
 * Regression tests: the approval section must NOT auto-save edits to the backend.
 *
 * Required behaviour: editing a field marks the quote unsaved (hasUnsavedEdits)
 * but does not persist. Backend persistence happens ONLY on an explicit Save
 * (saveQuotationChanges) or Approve (saveQuotation). The save gate then blocks
 * Download/Send while there are unsaved edits.
 *
 * Previously updateQuotationFromApprovalSection scheduled a debounced backend POST
 * (scheduleQuotationBackendSave) on every edit — that autosave has been removed.
 *
 * Two layers:
 *  - Source guards: assert the autosave machinery is gone, the edit handler only
 *    flags unsaved, and explicit Save still persists.
 *  - Behavioral: inline model of the edit / save / gate state machine.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** Slice the source between two markers (the function body, roughly). */
function sliceBetween(startMarker, endMarker) {
    const i = html.indexOf(startMarker);
    if (i === -1) return '';
    const j = html.indexOf(endMarker, i + startMarker.length);
    return j === -1 ? html.slice(i) : html.slice(i, j);
}

// =============================================================================
// Source guards — tie the tests to the real code so a revert fails CI
// =============================================================================
describe('index.html source guards — no approval autosave', () => {
    test('the debounced backend-autosave helper is gone entirely', () => {
        expect(html).not.toContain('scheduleQuotationBackendSave');
        expect(html).not.toContain('backendSaveTimers');
    });

    test('the live edit handler flags unsaved but does not persist to the backend', () => {
        const fn = sliceBetween(
            'function updateQuotationFromApprovalSection',
            'function recalculateApprovalQuotationTotals'
        );
        expect(fn).toContain('quotation.hasUnsavedEdits = true');
        expect(fn).toContain('Do NOT auto-save');
        expect(fn).not.toContain('saveQuotationToBackend');
    });

    test('explicit Save still persists to the backend and clears the unsaved flag', () => {
        const fn = sliceBetween('function saveQuotationChanges', 'function saveQuotation(');
        expect(fn).toContain('saveQuotationToBackend(quotation)');
        expect(fn).toContain('quotation.hasUnsavedEdits = false');
    });

    test('recalculation never persists (no call site passes shouldSave=true)', () => {
        expect(html).not.toMatch(/recalculateApprovalQuotationTotals\([^,]+,\s*true\s*\)/);
    });
});

// =============================================================================
// Behavioral — inline model of the edit / save / gate state machine
// =============================================================================

/** index.html — editing an approval field: mark unsaved, never touch the backend. */
function onApprovalEdit(state /* , backend */) {
    if (state.saved) { state.saved = false; state.everApproved = true; }
    state.hasUnsavedEdits = true;
    // NOTE: deliberately no backend write here — that is the whole point.
    return state;
}

/** index.html — explicit Save: persist once and clear the unsaved flag. */
function onExplicitSave(state, backend) {
    backend.saves += 1;
    state.saved = false;          // Save persists edits; Approve is what marks approved
    state.hasUnsavedEdits = false;
    return state;
}

/** index.html — Download/Send save gate. */
function blockedFromSending(state) {
    return state.hasUnsavedEdits === true;
}

describe('approval edit / save behaviour', () => {
    test('editing does not write to the backend and flags unsaved', () => {
        const backend = { saves: 0 };
        const state = { saved: true, everApproved: true, hasUnsavedEdits: false };
        onApprovalEdit(state, backend);
        expect(backend.saves).toBe(0);
        expect(state.hasUnsavedEdits).toBe(true);
        expect(state.saved).toBe(false);
        expect(state.everApproved).toBe(true); // approval stays sticky
    });

    test('Download/Send is blocked while there are unsaved edits', () => {
        const state = { hasUnsavedEdits: false };
        onApprovalEdit(state, { saves: 0 });
        expect(blockedFromSending(state)).toBe(true);
    });

    test('explicit Save persists exactly once and unblocks sending', () => {
        const backend = { saves: 0 };
        const state = { saved: true, everApproved: true, hasUnsavedEdits: false };
        onApprovalEdit(state, backend);
        onExplicitSave(state, backend);
        expect(backend.saves).toBe(1);
        expect(state.hasUnsavedEdits).toBe(false);
        expect(blockedFromSending(state)).toBe(false);
    });

    test('many edits still trigger zero background saves', () => {
        const backend = { saves: 0 };
        const state = { hasUnsavedEdits: false };
        for (let i = 0; i < 10; i++) onApprovalEdit(state, backend);
        expect(backend.saves).toBe(0);
    });
});
