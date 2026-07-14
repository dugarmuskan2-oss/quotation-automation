/**
 * @jest-environment node
 *
 * tests/compose-window.test.js
 *
 * Review-and-send compose window + send-flow fixes (commit 328ea9a). Covers the
 * pure regression helpers:
 *   - bareEmailFromHeader  — the comma-in-display-name reply-send bug
 *   - isValidEmailAddress  — the chip validation used in the compose dialog
 *   - matchesApprovalSearch — the "search misses the company name" bug (it was
 *     reading projectName instead of companyName)
 * plus source guards on the compose dialog's send-blocking checks, resolved
 * shape, and the popup-safe PDF preview.
 *
 * Pure helpers are extracted from index.html and eval'd (same approach as
 * tests/revision-signature.test.js). replySubject / the MIME builder are already
 * covered by tests/email-compose.test.js and are not retested here.
 */

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

function loadFns(names) {
    const body = names.map(function(n) { return extractFunction(html, n); }).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn ' + names[names.length - 1] + ';')();
}

const bareEmailFromHeader = loadFns(['bareEmailFromHeader']);
const isValidEmailAddress = loadFns(['isValidEmailAddress']);
const matchesApprovalSearch = loadFns([
    'normalizeSearchText', 'getMonthIndexFromToken', 'getMonthIndexFromDateText',
    'doesMonthMatchQuery', 'matchesApprovalSearch',
]);

describe('bareEmailFromHeader — pull the address out of a From header', () => {
    test('"Name <addr>" -> addr', () => {
        expect(bareEmailFromHeader('Jane Doe <jane@x.com>')).toBe('jane@x.com');
    });
    test('a comma inside the display name still yields the bare address (reply-send regression)', () => {
        expect(bareEmailFromHeader('"Doe, Jane" <jane@dsc.com>')).toBe('jane@dsc.com');
    });
    test('a bare address (no brackets) is returned trimmed', () => {
        expect(bareEmailFromHeader('bare@x.com')).toBe('bare@x.com');
        expect(bareEmailFromHeader('   spaced@x.com   ')).toBe('spaced@x.com');
    });
    test('empty / null -> empty string', () => {
        expect(bareEmailFromHeader('')).toBe('');
        expect(bareEmailFromHeader(null)).toBe('');
    });
    test('the first angle-bracket pair wins', () => {
        expect(bareEmailFromHeader('A <a@x.com> B <b@x.com>')).toBe('a@x.com');
    });
});

describe('isValidEmailAddress — chip validation', () => {
    test('accepts normal and multi-label-domain addresses', () => {
        expect(isValidEmailAddress('jane@dsc.com')).toBe(true);
        expect(isValidEmailAddress('a.b@sub.example.co.in')).toBe(true);
    });
    test('rejects a domain with no dot', () => {
        expect(isValidEmailAddress('nodomain@nodot')).toBe(false);
    });
    test('rejects whitespace, double-@ and empties', () => {
        expect(isValidEmailAddress('has space@x.com')).toBe(false);
        expect(isValidEmailAddress('double@@x.com')).toBe(false);
        expect(isValidEmailAddress('')).toBe(false);
        expect(isValidEmailAddress('plain')).toBe(false);
    });
});

describe('matchesApprovalSearch — searches the fields shown in the card title', () => {
    const q = {
        companyName: 'Tata Projects',
        projectName: 'Warehouse Job',
        customerName: 'R Ramesh',
        quoteNumber: 'DSC-108',
        quotationDate: '',
    };
    test('matches on the real company name (the fixed regression)', () => {
        expect(matchesApprovalSearch({ companyName: 'Tata Projects', projectName: '', customerName: '', quoteNumber: '' }, 'tata')).toBe(true);
    });
    test('matches on bill-to (projectName)', () => {
        expect(matchesApprovalSearch(q, 'warehouse')).toBe(true);
    });
    test('matches on Kind Attn (contact)', () => {
        expect(matchesApprovalSearch(q, 'ramesh')).toBe(true);
    });
    test('matches the quote number case-insensitively', () => {
        expect(matchesApprovalSearch(q, 'dsc-108')).toBe(true);
        expect(matchesApprovalSearch(q, 'DSC-108')).toBe(true);
    });
    test('a blank query matches everything', () => {
        expect(matchesApprovalSearch(q, '')).toBe(true);
        expect(matchesApprovalSearch(q, '   ')).toBe(true);
    });
    test('a non-matching query with no date returns false', () => {
        expect(matchesApprovalSearch(q, 'zzz-not-here')).toBe(false);
    });
    test('matches by month name against the quotation date', () => {
        expect(matchesApprovalSearch({ companyName: '', projectName: '', customerName: '', quoteNumber: '', quotationDate: 'July 2026' }, 'july')).toBe(true);
    });
});

describe('source guard — the compose dialog + send-flow wiring', () => {
    test('the review-and-send compose window exists with a WYSIWYG message editor', () => {
        expect(html).toContain('function composeQuotationEmail(prefill)');
        expect(html).toContain('email-modal--compose');
        expect(html).toContain('<div class="email-msg-editor" contenteditable="true"></div>');
    });
    test('send is blocked on empty message, invalid address, or empty subject', () => {
        expect(html).toContain('The message is empty. Please type a message before sending.');
        expect(html).toContain('One or more email addresses look invalid');
        expect(html).toContain('Please enter a subject.');
    });
    test('the dialog resolves to the { to, cc, bcc, subject, bodyHtml } shape', () => {
        expect(html).toContain("close({ to: data.to.join(', '), cc: data.cc.join(', '), bcc: data.bcc.join(', '), subject: subject, bodyHtml: bodyHtml });");
    });
    test('the PDF preview reuses a synchronously-opened tab (popup-blocker safe)', () => {
        expect(html).toContain("if (win) { win.location = url; } else { window.open(url, '_blank'); }");
    });
});
