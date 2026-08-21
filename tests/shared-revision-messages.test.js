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
// Styling now lives in styles.css, not inline in index.html. These source guards
// assert CSS rules by exact text, so both files are read and searched together —
// the guard stays exactly as strong, it just no longer cares which file holds it.
const html = fs.readFileSync(INDEX_PATH, 'utf8')
    + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

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
    load(['buildSharedMessageGroups', 'sharedMessagesBlockHtml', 'revisionTextHtml', 'sharedMessageLineHtml']);

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

    // NOTE ON WHAT THIS COVERS. revisionTextHtml prefers sanitizeEmailHtmlForPreview, which needs
    // a DOM; this suite runs under @jest-environment node and jsdom is not installed, so here it
    // takes its escapeHtml FALLBACK. That fallback is a real shipped path and is what is asserted
    // below. The sanitizer path is covered by a source guard plus a browser check.
    test('this page is public — a message cannot inject markup (escape fallback)', () => {
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
            enquirySentBodies: { 'send:2026-03-01T09:00:00Z': SENT },
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
            enquirySentBodies: { 'send:2026-03-01T09:00:00Z': '   ', 'send:2026-03-02T09:00:00Z': '' },
        }, sink);
        out.forEach((e) => expect(e.html).not.toContain('sqShowSentEnquiry'));
        expect(sink).toEqual([]);
    });

    test('indexes stay in step across both enquiry kinds', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z' }],
            supplierEnquiries: [{ sentAt: '2026-03-02T09:00:00Z' }],
            enquirySentBodies: { 'send:2026-03-01T09:00:00Z': 'FREIGHT', 'send:2026-03-02T09:00:00Z': 'SUPPLIER' },
        }, sink);
        expect(out[0].html).toContain('sqShowSentEnquiry(0)');
        expect(out[1].html).toContain('sqShowSentEnquiry(1)');
        expect(sink.map((s) => s.html)).toEqual(['FREIGHT', 'SUPPLIER']);
    });

    test('a REPLY event is never clickable — we store their reply text, not a sent body', () => {
        const sink = [];
        const out = buildSharedEnquiryEvents({
            freightEnquiries: [{ sentAt: '2026-03-01T09:00:00Z', replied: true, replyAt: '2026-03-03T09:00:00Z', amount: 5000 }],
            enquirySentBodies: { 'send:2026-03-01T09:00:00Z': 'X' },
        }, sink);
        const reply = out.find((e) => e.html.includes('Freight rate received'));
        expect(reply.html).not.toContain('sqShowSentEnquiry');
        expect(sink).toHaveLength(1);   // only the SENT event contributed a body
    });

    test('called with no sink at all it still renders (used by older callers/tests)', () => {
        const out = buildSharedEnquiryEvents({
            supplierEnquiries: [{ sentAt: '2026-03-01T09:00:00Z' }],
            enquirySentBodies: { 'send:2026-03-01T09:00:00Z': 'X' },
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
        // Must be the reset INSIDE renderSharedQuotePage. A bare substring check also matched the
        // module-level declaration 'let _sqSentEnquiries = [];', so it passed even with the
        // per-render reset deleted — exactly the bug it exists to catch.
        const render = html.slice(html.indexOf('function renderSharedQuotePage('));
        const body = render.slice(0, render.indexOf('overlay.innerHTML'));
        expect(body).toContain('_sqSentEnquiries = [];');
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
        // One key format, written out in all three client places. The server no longer derives it
        // (it just stores the map), but it DOES rely on the keys sorting chronologically to evict
        // the oldest — which only holds because they are 'send:' + an ISO timestamp.
        [
            ['quote-enquiry-tab.js', "return 'send:' + String((t && t.sentAt) || '');"],
            ['freight-tab-weight-editor.js', "return 'send:' + String((t && t.sentAt) || '');"],
            ['index.html', "stored['send:' + String((t && t.sentAt) || '')]"],
        ].forEach(([f, snippet]) => {
            expect(fs3.readFileSync(path3.join(__dirname, '..', f), 'utf8')).toContain(snippet);
        });
        expect(routesSrc).toContain('Object.keys(merged).sort()');
    });
});

// ── The UOM decision, which had no coverage at all ────────────────────────────────────
//
// tests/enquiry-tab.test.js runs under @jest-environment node, so qtyHeadingOf short-circuits
// on `typeof document === 'undefined'` and defaultUomFor always returned '' there — the
// assertion passed whether the feature existed or not. jsdom is not installed, so the DOM
// parsing is stubbed here and the DECISION is exercised for real: given a heading, do we fill
// 'Meters' or leave it blank? That is the rule the user asked for, and the part that can be
// got wrong silently.

describe('defaultUomFor — Meters only while the quote still says metres', () => {
    const tabSrc2 = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');

    // Build the real functions with a stub DOM whose column resolver returns `heading`.
    function loadUom(heading, opts) {
        const o = opts || {};
        const names = ['qtyHeadingOf', 'defaultUomFor'];
        const body = names.map((n) => extractFunction(tabSrc2, n)).join('\n');
        const fakeTable = {};
        const document = o.noDocument ? undefined : {
            createElement: () => ({
                set innerHTML(v) { /* parsed by the stub below */ },
                querySelector: () => (o.noTable ? null : fakeTable),
            }),
        };
        const window = {
            getPdfColLabelsFromTable: o.noResolver ? undefined
                : () => { if (o.throws) throw new Error('boom'); return ['S. NO', 'ITEMS', heading, 'RATE', 'AMOUNT']; },
        };
        // eslint-disable-next-line no-new-func
        return new Function('document', 'window',
            "var DEFAULT_QTY_HEADING = 'QTY (MTRS)'; var DEFAULT_UOM = 'Meters';\n"
            + body + '\nreturn defaultUomFor;')(document, window);
    }

    const uomFor = (heading, opts) => loadUom(heading, opts)({ tableHTML: '<table></table>' });

    test('the untouched heading gives Meters', () => {
        expect(uomFor('QTY (Mtrs)')).toBe('Meters');
    });

    test('case does not matter — the comparison is deliberately case-insensitive', () => {
        expect(uomFor('qty (mtrs)')).toBe('Meters');
        expect(uomFor('  QTY (Mtrs)  ')).toBe('Meters');
    });

    test('a heading retyped to weight leaves UOM BLANK rather than claiming metres', () => {
        expect(uomFor('WEIGHT (KGS)')).toBe('');
        expect(uomFor('QTY (Nos)')).toBe('');
        expect(uomFor('Quantity (MT)')).toBe('');
    });

    test('no quote table at all: blank, never a guess', () => {
        expect(loadUom('QTY (Mtrs)')({})).toBe('');
        expect(loadUom('QTY (Mtrs)')({ tableHTML: '' })).toBe('');
        expect(uomFor('QTY (Mtrs)', { noTable: true })).toBe('');
    });

    test('a thrown parse, a missing resolver or no DOM all fall back to blank, not to a crash', () => {
        expect(uomFor('QTY (Mtrs)', { throws: true })).toBe('');
        expect(uomFor('QTY (Mtrs)', { noResolver: true })).toBe('');
        expect(uomFor('QTY (Mtrs)', { noDocument: true })).toBe('');
    });

    test('an empty heading is blank, not Meters', () => {
        expect(uomFor('')).toBe('');
    });
});

describe('trimSentBodyForStorage — a shortened copy must SAY it was shortened', () => {
    const load = (file) => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8');
        const body = extractFunction(src, 'trimSentBodyForStorage');
        const max = /var MAX_SENT_HTML = (\d+);/.exec(src)[1];
        const note = /var TRUNCATION_NOTE = '([^']*)';/.exec(src)[1];
        // eslint-disable-next-line no-new-func
        return { fn: new Function('var MAX_SENT_HTML = ' + max + "; var TRUNCATION_NOTE = '" + note + "';\n"
            + body + '\nreturn trimSentBodyForStorage;')(), max: Number(max), note };
    };

    ['quote-enquiry-tab.js', 'freight-tab-weight-editor.js'].forEach((file) => {
        describe(file, () => {
            const { fn, max, note } = load(file);

            test('a realistic enquiry is stored WHOLE — the first cap cut one off after 8 items', () => {
                // ~1.2 kB per line item is what the real table costs; 40 items must still fit.
                const row = '<tr><td style="border:1px solid #000;padding:6px 8px;">' + 'x'.repeat(1100) + '</td></tr>';
                const body = '<table>' + row.repeat(40) + '</table>';
                expect(body.length).toBeGreaterThan(40000);
                expect(fn(body)).toBe(body);
            });

            test('when it IS too long, the cut lands on a tag boundary and says so', () => {
                const body = '<table>' + '<tr><td>' + 'y'.repeat(max) + '</td></tr>' + '</table>';
                const out = fn(body);
                expect(out).toContain(note);
                // Never mid-tag: a blind slice let innerHTML drop the broken tag and auto-close the
                // table, showing a tidy enquiry that was quietly missing rows.
                const beforeNote = out.slice(0, out.length - note.length);
                expect(beforeNote.lastIndexOf('<')).toBeLessThan(beforeNote.lastIndexOf('>') + 1);
            });

            test('base64 images are dropped whichever quoting style they use', () => {
                expect(fn('<img src="data:image/png;base64,AAAA">')).toBe('<img src="">');
                expect(fn("<img src='data:image/png;base64,AAAA'>")).toBe("<img src=''>");
            });

            test('empty and non-string inputs are safe', () => {
                expect(fn('')).toBe('');
                expect(fn(null)).toBe('');
                expect(fn(undefined)).toBe('');
            });
        });
    });
});

// ── The server-side cap on stored enquiry bodies ──────────────────────────────────────
//
// mergeEnquirySentBodies lives inside createQuotationsRouter, so it is brace-matched out of the
// source and eval'd with its two constants — the same approach the other suites use for closured
// helpers. It had no coverage at all, and its first version silently dropped ARBITRARY entries
// while its comment claimed it kept the newest.

describe('mergeEnquirySentBodies — evicting oldest-first, and actually bounding the item', () => {
    const routesSrc2 = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'routes', 'quotations.js'), 'utf8');
    const MAX_BODIES = Number(/const MAX_SENT_BODIES = (\d+);/.exec(routesSrc2)[1]);
    const MAX_CHARS = Number(/const MAX_SENT_BODY_CHARS = (\d+);/.exec(routesSrc2)[1]);
    // eslint-disable-next-line no-new-func
    const merge = new Function(
        'const MAX_SENT_BODIES = ' + MAX_BODIES + '; const MAX_SENT_BODY_CHARS = ' + MAX_CHARS + ';\n'
        + extractFunction(routesSrc2, 'mergeEnquirySentBodies') + '\nreturn mergeEnquirySentBodies;')();

    const key = (n) => 'send:2026-03-' + String(n).padStart(2, '0') + 'T09:00:00.000Z';

    test('incoming bodies are merged onto the stored ones, not replacing them', () => {
        const payload = { enquirySentBodies: { [key(1)]: 'first' } };
        merge(payload, { [key(2)]: 'second' });
        expect(payload.enquirySentBodies).toEqual({ [key(1)]: 'first', [key(2)]: 'second' });
    });

    test('eviction drops the OLDEST, whatever order the keys arrive in', () => {
        // The real hazard: this map is rehydrated from a DynamoDB Map attribute, whose key order
        // is not insertion order. Seeded deliberately newest-first to prove sorting is what
        // decides — the previous version sliced Object.keys and dropped arbitrary entries.
        const stored = {};
        for (let d = MAX_BODIES + 3; d >= 1; d--) stored[key(d)] = 'body' + d;
        const payload = { enquirySentBodies: stored };
        merge(payload, {});
        const left = Object.keys(payload.enquirySentBodies).sort();
        expect(left).toHaveLength(MAX_BODIES);
        expect(left[0]).toBe(key(4));                       // days 1-3 evicted, the three oldest
        expect(payload.enquirySentBodies[key(1)]).toBeUndefined();
        expect(payload.enquirySentBodies[key(MAX_BODIES + 3)]).toBe('body' + (MAX_BODIES + 3));
    });

    test('the newly saved body is never the one thrown away', () => {
        const stored = {};
        for (let d = 1; d <= MAX_BODIES; d++) stored[key(d)] = 'old';
        const payload = { enquirySentBodies: stored };
        const fresh = 'send:2026-12-31T09:00:00.000Z';
        merge(payload, { [fresh]: 'JUST SENT' });
        expect(payload.enquirySentBodies[fresh]).toBe('JUST SENT');
    });

    test('the TOTAL size is bounded, not just the count — that is the 400 KB item limit', () => {
        // Counting entries alone bounded nothing useful: 25 x 60 KB is 1.5 MB, four times the
        // per-item limit, and every save for that quote would start failing.
        const payload = { enquirySentBodies: {} };
        const big = 'x'.repeat(50000);
        for (let d = 1; d <= 10; d++) merge(payload, { [key(d)]: big });
        const total = Object.values(payload.enquirySentBodies).reduce((n, v) => n + v.length, 0);
        expect(total).toBeLessThanOrEqual(MAX_CHARS);
        expect(MAX_BODIES * 60000).toBeGreaterThan(400000);   // the count cap alone is not a bound
    });

    test('the most recent body is kept even when it alone exceeds the byte cap', () => {
        const payload = { enquirySentBodies: {} };
        merge(payload, { [key(1)]: 'x'.repeat(MAX_CHARS + 1000) });
        expect(Object.keys(payload.enquirySentBodies)).toHaveLength(1);
    });

    test('junk and empty values are ignored rather than stored', () => {
        const payload = { enquirySentBodies: {} };
        merge(payload, { a: '', b: null, c: 42, d: {} });
        expect(payload.enquirySentBodies).toEqual({});
        merge(payload, null);
        merge(payload, 'nope');
        merge(payload, ['array']);
        expect(payload.enquirySentBodies).toEqual({});
    });
});
