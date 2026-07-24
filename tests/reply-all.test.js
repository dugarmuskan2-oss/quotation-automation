/**
 * @jest-environment node
 *
 * tests/reply-all.test.js
 *
 * Reply-all recipient logic in index.html.
 *
 *   bareEmailsFromHeader(header)  — parses a raw "To"/"Cc" header string
 *   ('A <a@x.com>, b@y.com') into an array of clean email addresses.
 *
 *   the reply-all CC computation — when replying to a quote it CCs everyone
 *   else who was on the enquiry (its To + Cc), EXCLUDING the original sender
 *   (already in To), EXCLUDING our own @dscpipes.com addresses, case-insensitively
 *   de-duplicated, joined with ", ".
 *
 * Both are executed for real: `bareEmailsFromHeader` is a standalone function
 * extracted by brace-matching; the CC computation is an inline block inside the
 * (DOM/async) sendQuotationToCustomer, so its exact source is lifted verbatim
 * (from `const seenCc = {};` to its terminating `.join(', ');`) and wrapped in a
 * thin `computeReplyAllCc(threadInfo, senderEmail)` shell over the real
 * bareEmailsFromHeader — no logic is re-typed, so the test can't drift from source.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Brace-match a `function name(...) { ... }` out of the SPA source.
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

// Lift the inline reply-all CC block verbatim (it is not a named function).
function extractReplyAllBlock(source) {
    const start = source.indexOf('const seenCc = {};');
    if (start === -1) throw new Error('reply-all CC block not found');
    const endMarker = ".join(', ');";
    const endIdx = source.indexOf(endMarker, start);
    if (endIdx === -1) throw new Error('reply-all CC block terminator not found');
    return source.slice(start, endIdx + endMarker.length);
}

function loadReplyAll() {
    const bare = extractFunction(src, 'bareEmailsFromHeader');
    const block = extractReplyAllBlock(src);
    const body =
        bare + '\n' +
        'function computeReplyAllCc(threadInfo, senderEmail) {\n' +
        '  var replyAllCc = "";\n' +
        block + '\n' +
        '  return replyAllCc;\n' +
        '}\n' +
        'return { bareEmailsFromHeader: bareEmailsFromHeader, computeReplyAllCc: computeReplyAllCc };';
    // eslint-disable-next-line no-new-func
    return new Function(body)();
}

const { bareEmailsFromHeader, computeReplyAllCc } = loadReplyAll();

// ─── bareEmailsFromHeader — header parsing ────────────────────────────────────

describe('bareEmailsFromHeader — pulls clean addresses out of a To/Cc header', () => {
    test('strips an angle-bracket display name', () => {
        expect(bareEmailsFromHeader('Jane Doe <jane@x.com>')).toEqual(['jane@x.com']);
    });

    test('handles a mix of display-name and bare tokens, comma-separated', () => {
        expect(bareEmailsFromHeader('A <a@x.com>, b@y.com'))
            .toEqual(['a@x.com', 'b@y.com']);
    });

    test('multiple comma-separated bare addresses', () => {
        expect(bareEmailsFromHeader('a@x.com, b@y.com, c@z.com'))
            .toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
    });

    test('semicolons also separate addresses', () => {
        expect(bareEmailsFromHeader('a@x.com; b@y.com')).toEqual(['a@x.com', 'b@y.com']);
    });

    test('a quoted display name containing a comma does not split the address', () => {
        // '"Doe, Jane"' is a single display name; only the real address survives.
        expect(bareEmailsFromHeader('"Doe, Jane" <jane@x.com>')).toEqual(['jane@x.com']);
    });

    test('case is preserved (this parser does not lowercase)', () => {
        expect(bareEmailsFromHeader('BuyeR@Cust.COM')).toEqual(['BuyeR@Cust.COM']);
    });

    test('dotted local parts and subdomains stay intact', () => {
        expect(bareEmailsFromHeader('first.last@sub.domain.com'))
            .toEqual(['first.last@sub.domain.com']);
    });

    test('empty / null / non-string headers yield an empty array', () => {
        expect(bareEmailsFromHeader('')).toEqual([]);
        expect(bareEmailsFromHeader(null)).toEqual([]);
        expect(bareEmailsFromHeader(undefined)).toEqual([]);
    });

    test('junk with no @ token yields an empty array (no crash)', () => {
        expect(bareEmailsFromHeader('no addresses here at all')).toEqual([]);
    });
});

// ─── reply-all CC computation ─────────────────────────────────────────────────

describe('computeReplyAllCc — CC everyone else, drop the sender and our own addresses', () => {
    test('drops the original sender (already in the To field)', () => {
        const cc = computeReplyAllCc(
            { to: 'sender@cust.com, other@cust.com', cc: '' },
            'sender@cust.com'
        );
        expect(cc).toBe('other@cust.com');
    });

    test('sender exclusion is case-insensitive', () => {
        const cc = computeReplyAllCc(
            { to: 'sender@cust.com, other@cust.com', cc: '' },
            'Sender@Cust.COM'
        );
        expect(cc).toBe('other@cust.com');
    });

    test('drops our own @dscpipes.com addresses (any case)', () => {
        const cc = computeReplyAllCc(
            { to: 'info@dscpipes.com, buyer@cust.com', cc: 'Sales@DSCPipes.com' },
            ''
        );
        expect(cc).toBe('buyer@cust.com');
    });

    test('merges the To and Cc headers together', () => {
        const cc = computeReplyAllCc(
            { to: 'a@x.com', cc: 'b@y.com' },
            ''
        );
        expect(cc).toBe('a@x.com, b@y.com');
    });

    test('de-duplicates case-insensitively, keeping the first occurrence verbatim', () => {
        const cc = computeReplyAllCc(
            { to: 'a@x.com, A@X.COM', cc: 'a@x.com' },
            ''
        );
        expect(cc).toBe('a@x.com');
    });

    test('preserves legitimate third-party CCs alongside the customer colleagues', () => {
        const cc = computeReplyAllCc(
            { to: 'sender@cust.com', cc: 'partner@third.com, colleague@cust.com' },
            'sender@cust.com'
        );
        expect(cc).toBe('partner@third.com, colleague@cust.com');
    });

    test('sender present in both To and Cc is dropped from both', () => {
        const cc = computeReplyAllCc(
            { to: 'sender@cust.com, one@cust.com', cc: 'sender@cust.com, two@cust.com' },
            'sender@cust.com'
        );
        expect(cc).toBe('one@cust.com, two@cust.com');
    });

    test('all the combined rules at once: sender + dscpipes + dedupe', () => {
        const cc = computeReplyAllCc(
            {
                to: 'Sender <sender@cust.com>, info@dscpipes.com, buyer@cust.com',
                cc: 'BUYER@cust.com, manager@cust.com, ops@dscpipes.com'
            },
            'sender@cust.com'
        );
        // sender dropped, both dscpipes dropped, buyer de-duped (first kept), manager kept
        expect(cc).toBe('buyer@cust.com, manager@cust.com');
    });

    test('nobody else on the enquiry -> empty CC string', () => {
        expect(computeReplyAllCc({ to: 'sender@cust.com', cc: '' }, 'sender@cust.com')).toBe('');
    });

    test('missing To/Cc headers -> empty CC string (no crash)', () => {
        expect(computeReplyAllCc({}, '')).toBe('');
        expect(computeReplyAllCc({ to: undefined, cc: undefined }, 'sender@cust.com')).toBe('');
    });

    test('angle-bracket display names in the headers are handled', () => {
        const cc = computeReplyAllCc(
            { to: 'Sender <sender@cust.com>, Colleague <col@cust.com>', cc: '' },
            'sender@cust.com'
        );
        expect(cc).toBe('col@cust.com');
    });
});

// ─── Source guard — the DOM/async wiring we can't execute headlessly ──────────

describe('source guard — reply-all wiring inside sendQuotationToCustomer', () => {
    test('the computed reply-all CC is passed to the compose window', () => {
        expect(src).toContain('cc: replyAllCc,');
    });
    test('the CC list is only built when the thread resolved', () => {
        expect(src).toContain('if (threadResolved) {');
        expect(src).toContain('let replyAllCc =');
    });
    test('the exclusion rule still targets @dscpipes.com', () => {
        expect(src).toMatch(/@dscpipes\\?\.com\$/);
    });
});
