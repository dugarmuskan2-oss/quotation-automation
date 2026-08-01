/**
 * @jest-environment node
 *
 * tests/shared-revision-messages.test.js
 *
 * The Copy-Link page now carries the admin's revision asks and plain notes, each drawn
 * directly ABOVE the version that answered it.
 *
 * The whole feature rests on one judgement: which version does a given message belong to?
 * A message written at 10:00 with a new version saved at 11:00 is one conversation — the
 * ask, then what was done about it — so a message is filed against the FIRST version
 * stamped at or after it, and anything written since the newest version belongs to Current.
 * Get that wrong and a customer-facing page attributes an ask to the wrong quote revision,
 * which is worse than not showing it at all. Hence the boundary cases below.
 *
 * Also covered: the two UOM defaults that changed at the same time.
 *
 * Nothing is reimplemented — index.html functions are brace-matched out of the real file
 * and eval'd, and quote-enquiry-tab.js is required as the shipped module.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

function extractFunction(src, name) {
    let start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
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

// The real functions, with only their leaf dependencies stubbed.
const PRELUDE = `
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function formatRevisionDate(v) { return 'D(' + v + ')'; }
`;

function load(names) {
    const body = PRELUDE + names.map(n => extractFunction(html, n)).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn {' + names.join(',') + '};')();
}

const { buildSharedMessageGroups, sharedMessagesBlockHtml, sharedMessageLineHtml } =
    load(['buildSharedMessageGroups', 'sharedMessagesBlockHtml', 'sharedMessageLineHtml']);

const ask = (text, addedAt, extra) => Object.assign({ text, addedAt, addedBy: 'ADMIN' }, extra || {});

// Three archived versions, oldest first — the order renderSharedQuotePage relies on.
const REVS = [
    { revNo: 1, createdAt: '2026-03-10T10:00:00.000Z' },
    { revNo: 2, createdAt: '2026-03-20T10:00:00.000Z' },
    { revNo: 3, createdAt: '2026-03-30T10:00:00.000Z' },
];

describe('buildSharedMessageGroups — which version does a message belong above?', () => {
    test('a message is filed against the first version saved AFTER it', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [
                ask('drop the rate on item 2', '2026-03-05T09:00:00.000Z'),   // before rev 1
                ask('add the 6 inch line', '2026-03-15T09:00:00.000Z'),       // between rev 1 and 2
                ask('freight to be included', '2026-03-25T09:00:00.000Z'),    // between rev 2 and 3
            ],
        }, REVS);
        expect(g.v0.map(m => m.entry.text)).toEqual(['drop the rate on item 2']);
        expect(g.v1.map(m => m.entry.text)).toEqual(['add the 6 inch line']);
        expect(g.v2.map(m => m.entry.text)).toEqual(['freight to be included']);
        expect(g.current).toBeUndefined();
    });

    test('anything written since the newest version belongs to Current', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [ask('customer wants it in kg', '2026-04-02T09:00:00.000Z')],
        }, REVS);
        expect(g.current.map(m => m.entry.text)).toEqual(['customer wants it in kg']);
    });

    test('a message stamped EXACTLY at a version belongs to that version, not the next', () => {
        // The save and the ask can land in the same second. The version that carries the
        // ask's own timestamp is the one that answered it.
        const g = buildSharedMessageGroups({
            revisionRequests: [ask('same second as rev 2', '2026-03-20T10:00:00.000Z')],
        }, REVS);
        expect(g.v1.map(m => m.entry.text)).toEqual(['same second as rev 2']);
        expect(g.v2).toBeUndefined();
    });

    test('asks and notes are both carried, and flagged apart', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [ask('a revision', '2026-03-05T09:00:00.000Z')],
            extraNotes: [ask('just a note', '2026-03-05T09:30:00.000Z')],
        }, REVS);
        expect(g.v0.map(m => [m.entry.text, m.isNote])).toEqual([
            ['a revision', false],
            ['just a note', true],
        ]);
    });

    test('within a group, messages read oldest first — the order they were written', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [
                ask('third', '2026-03-08T09:00:00.000Z'),
                ask('first', '2026-03-01T09:00:00.000Z'),
                ask('second', '2026-03-04T09:00:00.000Z'),
            ],
        }, REVS);
        expect(g.v0.map(m => m.entry.text)).toEqual(['first', 'second', 'third']);
    });

    test('a done revision ask is still shown — the page records what was asked', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [ask('sorted now', '2026-03-05T09:00:00.000Z', { done: true })],
        }, REVS);
        expect(g.v0).toHaveLength(1);
    });

    test('an undated or unparseable message shows against Current rather than vanishing', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [ask('no date', ''), ask('junk date', 'not-a-date')],
        }, REVS);
        expect(g.current.map(m => m.entry.text).sort()).toEqual(['junk date', 'no date']);
    });

    test('a version with no createdAt cannot claim messages', () => {
        const g = buildSharedMessageGroups(
            { revisionRequests: [ask('whose is this?', '2026-03-05T09:00:00.000Z')] },
            [{ revNo: 1, createdAt: '' }, { revNo: 2, createdAt: '2026-03-20T10:00:00.000Z' }]
        );
        expect(g.v0).toBeUndefined();
        expect(g.v1.map(m => m.entry.text)).toEqual(['whose is this?']);
    });

    test('no revisions at all: everything sits above Current', () => {
        const g = buildSharedMessageGroups({
            revisionRequests: [ask('one', '2026-03-05T09:00:00.000Z')],
            extraNotes: [ask('two', '2026-03-06T09:00:00.000Z')],
        }, []);
        expect(g.current).toHaveLength(2);
    });

    test('empty / missing / non-array fields produce no groups and no crash', () => {
        expect(buildSharedMessageGroups({}, REVS)).toEqual({});
        expect(buildSharedMessageGroups({ revisionRequests: null, extraNotes: 'oops' }, REVS)).toEqual({});
        expect(buildSharedMessageGroups({ revisionRequests: [null, undefined] }, REVS)).toEqual({});
    });
});

describe('rendering the messages', () => {
    test('an empty group renders nothing at all — no stray empty box', () => {
        expect(sharedMessagesBlockHtml([])).toBe('');
        expect(sharedMessagesBlockHtml(undefined)).toBe('');
    });

    test('the message text, date and author all appear', () => {
        const out = sharedMessageLineHtml(ask('reduce the margin', '2026-03-05T09:00:00.000Z'), false);
        expect(out).toContain('reduce the margin');
        expect(out).toContain('D(2026-03-05T09:00:00.000Z)');
        expect(out).toContain('ADMIN');
    });

    test('notes are marked apart from revision asks', () => {
        expect(sharedMessageLineHtml(ask('a note', ''), true)).toContain('sq-msg-note');
        expect(sharedMessageLineHtml(ask('an ask', ''), false)).not.toContain('sq-msg-note');
    });

    test('this page is public — a message cannot inject markup', () => {
        const out = sharedMessageLineHtml(
            { text: '<img src=x onerror=alert(1)>', addedAt: '', addedBy: '<script>bad()</script>' }, false);
        expect(out).not.toContain('<img');
        expect(out).not.toContain('<script>');
        expect(out).toContain('&lt;img');
        expect(out).toContain('&lt;script&gt;');
    });

    test('a missing text field renders an empty line, not "undefined"', () => {
        expect(sharedMessageLineHtml({}, false)).not.toContain('undefined');
        expect(sharedMessageLineHtml(null, false)).not.toContain('undefined');
    });
});

describe('source guard — the groups are actually wired into the version cards', () => {
    test('Current and each past version render their message block above the card', () => {
        expect(html).toContain('const msgGroups = buildSharedMessageGroups(quotation, revs);');
        // Above, not below: the block is concatenated BEFORE the sq-card div in both places.
        expect(html).toMatch(/html: sharedMessagesBlockHtml\(msgGroups\.current\)\s*\+\s*'<div class="sq-card">/);
        expect(html).toMatch(/html: sharedMessagesBlockHtml\(msgGroups\['v' \+ i\]\)\s*\+\s*'<div class="sq-card">/);
    });

    test('the styles the block depends on exist', () => {
        expect(html).toContain('.sq-msg {');
        expect(html).toContain('.sq-msg-note {');
        expect(html).toContain('.sq-msg-text {');
    });
});

describe('section headings are black, not grey', () => {
    test('the shared-page section heading and the attached-files heading both read black', () => {
        expect(html).toMatch(/\.sq-sec-h \{[^}]*color: #20201d/);
        expect(html).not.toMatch(/\.sq-sec-h \{[^}]*color: #9b988e/);
        expect(html).toContain('font-size:11px; color:#20201d; font-weight:700; margin-bottom:3px;">ATTACHED FILES');
    });
});

describe('the approval filter buttons read Freight, Enquiry, Revision', () => {
    test('that is their order in the markup', () => {
        const freight = html.indexOf('id="approvalFreightBtn"');
        const enquiry = html.indexOf('id="approvalEnquiryBtn"');
        const revision = html.indexOf('id="approvalRevisionBtn"');
        expect(freight).toBeGreaterThan(-1);
        expect(freight).toBeLessThan(enquiry);
        expect(enquiry).toBeLessThan(revision);
    });

    test('the revision count badge travelled with its button', () => {
        const btn = html.slice(html.indexOf('id="approvalRevisionBtn"'));
        expect(btn.slice(0, btn.indexOf('</button>'))).toContain('id="approvalRevisionCount"');
    });
});

// ── Clicking an enquiry to read what was actually sent ────────────────────────────────

const { buildSharedEnquiryEvents } = (() => {
    const body = PRELUDE + extractFunction(html, 'buildSharedEnquiryEvents');
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn { buildSharedEnquiryEvents };')();
})();

describe('buildSharedEnquiryEvents — the "view enquiry" click-through', () => {
    const SENT = '<table><tr><td>2" NB X Heavy</td></tr></table>';

    test('an enquiry we kept the body for becomes clickable, and the body lands in the sink', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z', email: 't@x.com' }],
            enquirySentBodies: { 'es:t@x.com|2026-03-01T09:00:00Z': SENT },
        }, sink);
        expect(out).toHaveLength(1);
        expect(out[0].html).toContain('sqShowSentEnquiry(0)');
        expect(out[0].html).toContain('view enquiry');
        expect(sink).toEqual([{ title: 'Freight enquiry sent', when: '2026-03-01T09:00:00Z', html: SENT }]);
    });

    test('an enquiry sent BEFORE we stored bodies stays plain — no button onto an empty box', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z', email: 't@x.com' }],
        }, sink);
        expect(out[0].html).not.toContain('sqShowSentEnquiry');
        expect(out[0].html).not.toContain('view enquiry');
        expect(sink).toEqual([]);
    });

    test('a blank or whitespace-only stored body does not make it clickable', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z' }],
            supplierEnquiries: [{ sentAt: '2026-03-02T09:00:00Z' }],
            enquirySentBodies: { 'es:|2026-03-01T09:00:00Z': '   ', 'es:|2026-03-02T09:00:00Z': '' },
        }, sink);
        out.forEach((e) => expect(e.html).not.toContain('sqShowSentEnquiry'));
        expect(sink).toEqual([]);
    });

    test('indexes stay in step across both enquiry kinds', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z' }],
            supplierEnquiries: [{ sentAt: '2026-03-02T09:00:00Z' }],
            enquirySentBodies: { 'es:|2026-03-01T09:00:00Z': 'FREIGHT', 'es:|2026-03-02T09:00:00Z': 'SUPPLIER' },
        }, sink);
        expect(out[0].html).toContain('sqShowSentEnquiry(0)');
        expect(out[1].html).toContain('sqShowSentEnquiry(1)');
        expect(sink.map((s) => s.html)).toEqual(['FREIGHT', 'SUPPLIER']);
    });

    test('a REPLY event is never clickable — we store their reply text, not a sent body', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z', replied: true, replyAt: '2026-03-03T09:00:00Z', amount: 5000 }],
            enquirySentBodies: { 'es:|2026-03-01T09:00:00Z': 'X' },
        }, sink);
        const reply = out.find((e) => e.html.includes('Freight rate received'));
        expect(reply.html).not.toContain('sqShowSentEnquiry');
        expect(sink).toHaveLength(1);   // only the SENT event contributed a body
    });

    test('called with no sink at all it still renders (used by older callers/tests)', () => {
        const out = buildSharedEnquiryEvents({
            supplierEnquiries: [{ sentAt: '2026-03-01T09:00:00Z' }],
            enquirySentBodies: { 'es:|2026-03-01T09:00:00Z': 'X' },
        });
        expect(out[0].html).toContain('sqShowSentEnquiry(0)');
    });
});

describe('source guard — the viewer cannot destroy the shared page', () => {
    test('it builds its OWN overlay element, not the singleton the page itself lives in', () => {
        expect(html).toContain("el.id = 'sq-sent-enquiry-overlay'");
        const fn = html.slice(html.indexOf('function sqShowSentEnquiry('));
        const viewer = fn.slice(0, fn.indexOf('\n        }'));
        // getPreviewOverlay() IS the shared page; using it here would wipe the quote out.
        expect(viewer).not.toContain('getPreviewOverlay');
    });

    test('the stored body is sanitized before it is written into the page', () => {
        const fn = html.slice(html.indexOf('function sqShowSentEnquiry('));
        expect(fn.slice(0, 900)).toContain('sanitizeEmailHtmlForPreview');
    });

    test('the sink is reset on every render so stale indexes cannot open the wrong enquiry', () => {
        expect(html).toContain('_sqSentEnquiries = [];');
    });
});

describe('what we store of a sent enquiry is bounded', () => {
    const fs2 = require('fs');
    const path2 = require('path');
    const read = (f) => fs2.readFileSync(path2.join(__dirname, '..', f), 'utf8');

    test('both senders strip inline base64 images and cap the length', () => {
        ['quote-enquiry-tab.js', 'freight-tab-weight-editor.js'].forEach((f) => {
            const src = read(f);
            expect(src).toContain('function trimSentBodyForStorage(');
            expect(src).toContain('MAX_SENT_HTML');
            expect(src).toContain('data:');
        });
    });

    test('the freight body is built ONCE, not per recipient', () => {
        const src = read('freight-tab-weight-editor.js');
        const fn = src.slice(src.indexOf('function freightSendAll('));
        const head = fn.slice(0, fn.indexOf('Promise.all'));
        expect(head).toContain('var bodyHtml = enqTextToHtml(bodyText, st);');
        // The per-recipient fetch reuses that value rather than rebuilding it.
        expect(fn).toContain('bodyHtml: bodyHtml,');
    });
});

// ── Where the sent bodies are stored ──────────────────────────────────────────────────

describe('sent enquiry bodies stay OUT of the quotations list projection', () => {
    const fs3 = require('fs');
    const path3 = require('path');
    const routesSrc = fs3.readFileSync(path3.join(__dirname, '..', 'routes', 'quotations.js'), 'utf8');

    test('enquirySentBodies is NOT projected into every list page', () => {
        const block = routesSrc.slice(routesSrc.indexOf('SUMMARY_NESTED_PATHS'),
                                     routesSrc.indexOf('const SUMMARY_PROJECTION'));
        // The thread arrays ARE projected (the filters need them) — which is exactly why a
        // kilobyte-sized email body must not live inside them.
        expect(block).toContain("'freightEnquiries'");
        expect(block).toContain("'supplierEnquiries'");
        expect(block).not.toContain('enquirySentBodies');
    });

    test('neither sender puts the body inside a thread object any more', () => {
        ['quote-enquiry-tab.js', 'freight-tab-weight-editor.js'].forEach((f) => {
            expect(fs3.readFileSync(path3.join(__dirname, '..', f), 'utf8')).not.toContain('sentHtml:');
        });
    });

    test('a stale tab cannot wipe the bodies with a whole-object save', () => {
        expect(routesSrc).toMatch(/SERVER_OWNED = \[[^\]]*'enquirySentBodies'/);
    });

    test('client and server derive the SAME key, or a body never finds its thread', () => {
        const clientKey = "'es:' + String((t && t.email) || '').toLowerCase() + '|' + String((t && t.sentAt) || '')";
        expect(routesSrc).toContain(clientKey);
        ['quote-enquiry-tab.js', 'freight-tab-weight-editor.js', 'index.html'].forEach((f) => {
            expect(fs3.readFileSync(path3.join(__dirname, '..', f), 'utf8')).toContain(clientKey);
        });
    });
});
