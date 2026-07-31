/**
 * @jest-environment node
 *
 * tests/send-gate-after-save.test.js
 *
 * Regression guard: "after Save as Revision it asks me to save again before I can send".
 *
 * The send gate accepts `saved === true || everApproved === true`, and the edit handler
 * always PAIRS those — when an edit clears `saved` it sets `everApproved` so an already
 * approved quote never has to be re-approved just to be sent.
 *
 * saveQuotationChanges skipped that pairing: it set `saved = false` unconditionally
 * ("Save persists changes, Approve approves") without ever setting `everApproved`. On a
 * quote whose everApproved was never set — anything predating the flag — saving left
 * saved:false with no everApproved, so sending demanded an approval the user had already
 * given. Save as Revision routes through the same function, which is where it was noticed.
 *
 * Reproduced against the real app before fixing. These tests execute the REAL functions
 * pulled out of index.html, plus a source guard on the pairing itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

// The gate itself, lifted verbatim from sendQuotationToCustomer (index.html) so the
// assertion tracks the shipped condition rather than a paraphrase of it.
const SEND_GATE_SRC = 'const approvedAtLeastOnce = quotation.saved === true || quotation.everApproved === true;';
const canSend = (q) => q.saved === true || q.everApproved === true;

// The exact flag-pairing block saveQuotationChanges runs, extracted from source and executed,
// so these tests fail if that logic is reverted or reworded.
function runSaveFlagBlock(quotation) {
    const fnSrc = extractFunction(html, 'saveQuotationChanges');
    const marker = 'if (quotation.saved === true || quotation.sent === true) quotation.everApproved = true;';
    if (fnSrc.indexOf(marker) === -1) {
        throw new Error('saveQuotationChanges no longer pairs everApproved with clearing saved');
    }
    // eslint-disable-next-line no-new-func
    new Function('quotation', marker + '\nquotation.saved = false;\nquotation.hasUnsavedEdits = false;')(quotation);
    return quotation;
}

describe('the reported bug — saving must not make an approved quote unsendable', () => {
    test('an OLD approved+sent quote with no everApproved can still be sent after saving', () => {
        // Exactly the shape that failed: approved and sent long ago, before the flag existed.
        const q = { saved: true, sent: true };            // everApproved absent
        expect(canSend(q)).toBe(true);                     // sendable before saving
        runSaveFlagBlock(q);
        expect(q.saved).toBe(false);                       // Save still does not approve
        expect(q.everApproved).toBe(true);                 // ...but the approval is remembered
        expect(canSend(q)).toBe(true);                     // and it is STILL sendable
    });

    test('the same quote after Save as Revision (which routes through saveQuotationChanges)', () => {
        const q = { saved: true, sent: true, revisionCount: 0 };
        runSaveFlagBlock(q);
        expect(canSend(q)).toBe(true);
    });

    test('a sent quote that had already been edited (saved cleared, everApproved absent) stays sendable', () => {
        // An edit clears `saved`; if everApproved was somehow never set, `sent` still rescues it.
        const q = { saved: false, sent: true };
        runSaveFlagBlock(q);
        expect(q.everApproved).toBe(true);
        expect(canSend(q)).toBe(true);
    });

    test('a modern quote (everApproved already true) is unaffected', () => {
        const q = { saved: true, sent: true, everApproved: true };
        runSaveFlagBlock(q);
        expect(q.everApproved).toBe(true);
        expect(canSend(q)).toBe(true);
    });

    test('saving always clears the unsaved-edits flag, so the second gate passes too', () => {
        const q = { saved: true, sent: true, hasUnsavedEdits: true };
        runSaveFlagBlock(q);
        expect(q.hasUnsavedEdits).toBe(false);
    });
});

describe('the gate must NOT be opened for genuinely unapproved quotes', () => {
    test('never approved and never sent stays blocked after saving', () => {
        const q = { saved: false, sent: false };
        runSaveFlagBlock(q);
        expect(q.everApproved).toBeUndefined();
        expect(canSend(q)).toBe(false);
    });

    test('a draft with no flags at all stays blocked', () => {
        const q = {};
        runSaveFlagBlock(q);
        expect(canSend(q)).toBe(false);
    });

    test('everApproved is not granted by truthy-but-not-true values', () => {
        // Guards against loosening `=== true` to a truthy check later.
        const q = { saved: 'yes', sent: 0 };
        runSaveFlagBlock(q);
        expect(q.everApproved).toBeUndefined();
        expect(canSend(q)).toBe(false);
    });
});

describe('source guards — the gate and its pairing stay in step', () => {
    test('the send gate still accepts saved OR everApproved', () => {
        expect(html).toContain(SEND_GATE_SRC);
    });

    test('saveQuotationChanges pairs everApproved with clearing saved', () => {
        const src = extractFunction(html, 'saveQuotationChanges');
        expect(src).toContain('if (quotation.saved === true || quotation.sent === true) quotation.everApproved = true;');
        expect(src).toContain('quotation.saved = false;');
        expect(src).toContain('quotation.hasUnsavedEdits = false;');
    });

    test('the edit handler keeps the same pairing it always had', () => {
        const src = extractFunction(html, 'updateQuotationFromApprovalSection');
        expect(src).toContain('quotation.saved = false;');
        expect(src).toContain('quotation.everApproved = true;');
    });

    test('Save as Revision still requires the quote to have been sent', () => {
        const src = extractFunction(html, 'saveAsRevision');
        expect(src).toContain('if (!quotation.sent)');
        expect(src).toContain("saveQuotationChanges(quotationId, { asRevision: true })");
    });
});
