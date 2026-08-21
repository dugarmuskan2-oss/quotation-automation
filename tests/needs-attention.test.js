/**
 * @jest-environment node
 *
 * tests/needs-attention.test.js
 *
 * The status-led queue decision logic (Phase 1 + commit ed639a2): which quotes
 * are flagged "needs attention", the short reason on the red badge, and the
 * per-quote status pill / live action. These are the shared predicates the
 * single unified approval list uses to highlight a row light-red and label it
 * "Needs attention: {reason}".
 *
 * The predicates live inline in the browser-only SPA (index.html), so this test
 * extracts them by name (brace-matching) and evals them — same approach as
 * tests/revision-signature.test.js. determineLiveAction / statusPill call
 * quotationReviewed, so that helper is eval'd into the same scope.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
// Styling now lives in styles.css, not inline in index.html. These source guards
// assert CSS rules by exact text, so both files are read and searched together —
// the guard stays exactly as strong, it just no longer cares which file holds it.
const html = fs.readFileSync(INDEX_PATH, 'utf8')
    + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

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

// Eval one or more top-level functions together so later ones can call earlier
// ones (e.g. determineLiveAction calls quotationReviewed). Returns the LAST named.
function loadFns(names, sandbox) {
    const body = names.map(function(n) { return extractFunction(html, n); }).join('\n');
    const keys = Object.keys(sandbox || {});
    // eslint-disable-next-line no-new-func
    const factory = new Function(keys.join(','), body + '\nreturn ' + names[names.length - 1] + ';');
    return factory.apply(null, keys.map(function(k) { return sandbox[k]; }));
}

const quotationReviewed = loadFns(['quotationReviewed']);
const needsAttention = loadFns(['needsAttention']);
const needsAttentionReason = loadFns(['needsAttentionReason']);
const determineLiveAction = loadFns(['quotationReviewed', 'determineLiveAction']);
const statusPill = loadFns(['quotationReviewed', 'statusPill']);

describe('quotationReviewed — has the quote been approved/saved/sent at least once', () => {
    test('null and empty are not reviewed', () => {
        expect(quotationReviewed(null)).toBe(false);
        expect(quotationReviewed({})).toBe(false);
    });
    test('everApproved / saved / sent each mark it reviewed', () => {
        expect(quotationReviewed({ everApproved: true })).toBe(true);
        expect(quotationReviewed({ saved: true })).toBe(true);
        expect(quotationReviewed({ sent: true })).toBe(true);
    });
    test('revised alone does not count as reviewed', () => {
        expect(quotationReviewed({ revised: true })).toBe(false);
    });
});

describe('needsAttention — is the next action the user\'s?', () => {
    test('null / undefined / new-unreviewed quote are NOT flagged', () => {
        expect(needsAttention(null)).toBe(false);
        expect(needsAttention(undefined)).toBe(false);
        expect(needsAttention({})).toBe(false);
    });
    test('a customer reply flags it', () => {
        expect(needsAttention({ custReplyPending: true })).toBe(true);
    });
    test('revised-but-not-resent flags it', () => {
        expect(needsAttention({ revised: true })).toBe(true);
    });
    test('a resent revision is cleared (key edge)', () => {
        expect(needsAttention({ revised: true, resent: true })).toBe(false);
    });
    test('a transporter reply flags it', () => {
        expect(needsAttention({ transporterReplyIn: true })).toBe(true);
    });
    test('reviewed with no pending action is not flagged', () => {
        expect(needsAttention({ everApproved: true })).toBe(false);
        expect(needsAttention({ sent: true })).toBe(false);
    });
});

describe('needsAttentionReason — the short label on the red badge', () => {
    test('customer replied', () => {
        expect(needsAttentionReason({ custReplyPending: true })).toBe('customer replied');
    });
    test('resend (revised, not resent)', () => {
        expect(needsAttentionReason({ revised: true })).toBe('resend');
    });
    test('transporter reply', () => {
        expect(needsAttentionReason({ transporterReplyIn: true })).toBe('transporter reply');
    });
    test('customer-replied takes precedence over revised', () => {
        expect(needsAttentionReason({ custReplyPending: true, revised: true })).toBe('customer replied');
    });
    test('no trigger / resent revision / null all yield an empty string', () => {
        expect(needsAttentionReason({})).toBe('');
        expect(needsAttentionReason({ revised: true, resent: true })).toBe('');
        expect(needsAttentionReason(null)).toBe('');
    });
});

describe('determineLiveAction — the queue action button {label,key}', () => {
    test('unreviewed -> Review', () => {
        expect(determineLiveAction({})).toEqual({ label: 'Review', key: 'review' });
    });
    test('a revised (not-reviewed) quote still shows Review first', () => {
        expect(determineLiveAction({ revised: true })).toEqual({ label: 'Review', key: 'review' });
    });
    test('reviewed + revised + not resent -> Resend', () => {
        expect(determineLiveAction({ everApproved: true, revised: true })).toEqual({ label: 'Resend', key: 'resend' });
    });
    test('reviewed + customer replied -> Reply', () => {
        expect(determineLiveAction({ saved: true, custReplyPending: true })).toEqual({ label: 'Reply', key: 'reply' });
    });
    test('Resend beats Reply when both apply', () => {
        expect(determineLiveAction({ everApproved: true, revised: true, custReplyPending: true }))
            .toEqual({ label: 'Resend', key: 'resend' });
    });
    test('reviewed with nothing pending -> null', () => {
        expect(determineLiveAction({ sent: true })).toBeNull();
    });
});

describe('statusPill — the coloured status chip markup', () => {
    test('not reviewed -> New', () => {
        expect(statusPill({})).toBe('<span class="q-pill q-new">New</span>');
    });
    test('reviewed + customer replied -> Customer replied', () => {
        expect(statusPill({ saved: true, custReplyPending: true }))
            .toBe('<span class="q-pill q-reply">Customer replied</span>');
    });
    test('reviewed + revised -> Revised', () => {
        expect(statusPill({ everApproved: true, revised: true }))
            .toBe('<span class="q-pill q-revised">Revised</span>');
    });
    test('reviewed + sent -> Sent', () => {
        expect(statusPill({ sent: true })).toBe('<span class="q-pill q-sent">&#10003; Sent</span>');
    });
    test('reviewed, nothing else -> Approved', () => {
        expect(statusPill({ saved: true })).toBe('<span class="q-pill q-approved">Approved</span>');
    });
    test('reply pill beats revised once reviewed', () => {
        expect(statusPill({ sent: true, custReplyPending: true, revised: true }))
            .toBe('<span class="q-pill q-reply">Customer replied</span>');
    });
});

describe('admin margin-allocation states (adminStatus)', () => {
    test('awaiting -> red "Awaiting margin" pill, before review states', () => {
        expect(statusPill({ adminStatus: 'awaiting' })).toBe('<span class="q-pill q-awaiting">Awaiting margin</span>');
        // even a reviewed/sent quote still shows awaiting while on the desk
        expect(statusPill({ adminStatus: 'awaiting', saved: true })).toBe('<span class="q-pill q-awaiting">Awaiting margin</span>');
    });
    test('regretted -> gray pill, wins over everything', () => {
        expect(statusPill({ adminStatus: 'regretted', sent: true })).toBe('<span class="q-pill q-regretted">Regretted</span>');
    });
    test('regretted quotes are never flagged needs-attention', () => {
        expect(needsAttention({ adminStatus: 'regretted', custReplyPending: true })).toBe(false);
    });
    test('awaiting/regretted give staff no live action (the admin desk owns them)', () => {
        expect(determineLiveAction({ adminStatus: 'awaiting' })).toBeNull();
        expect(determineLiveAction({ adminStatus: 'regretted' })).toBeNull();
    });
    test('quotes without adminStatus (all existing quotes) behave exactly as before', () => {
        expect(statusPill({})).toBe('<span class="q-pill q-new">New</span>');
        expect(statusPill({ sent: true })).toBe('<span class="q-pill q-sent">&#10003; Sent</span>');
        expect(determineLiveAction({})).toEqual({ label: 'Review', key: 'review' });
    });
});

describe('source guard — needs-attention wiring in the approval list', () => {
    test('the list computes needsAttn and renders the red badge + folder class', () => {
        expect(html).toContain("const needsAttn = (typeof needsAttention === 'function') && needsAttention(quotation);");
        expect(html).toContain('<span class="saved-badge needs-attention-badge">Needs attention: ${needsAttentionReason(quotation)}</span>');
        expect(html).toContain("quotation-folder${needsAttn ? ' needs-attention' : ''}");
    });
    test('the highlight CSS is present', () => {
        expect(html).toContain('.needs-attention-badge { background-color: #c62828; }');
        expect(html).toContain('.quotation-folder.needs-attention .quotation-folder-header { background-color: #FCEBEB; }');
    });
    test('the two-group spotlight builders stay PARKED (not silently re-wired)', () => {
        expect(html).toContain('PARKED (not currently wired)');
    });
});
