/**
 * @jest-environment node
 *
 * tests/permissions-client.test.js
 *
 * The BROWSER side of per-person permissions (commits 2359b40, 6f71c2b, e3c6ffb).
 * The server checks every tick again on its own route; the page only hides what a person
 * can't use. These tests run the REAL functions, pulled out of index.html / people.html /
 * revision-popup.js by brace matching and run in a sandbox:
 *
 *   - myAccess / loadMyAccess / can / refusedMessage — unknown access hides nothing
 *   - formatAskStamp — "Ravi Kumar · 16 Oct, 3:20 pm", India time on any computer
 *   - revisionEntryLineHTML / buildRevisionStripHTML — 🗑 on notes, the two Add buttons
 *   - adminStripActionsHTML — the ✏️ / 🗑 corner icons of "From the admin"
 *   - renderMarginDesk — who sees which waiting quotes
 *   - sanitizeQuotationForSave — the desk's working copies are never saved
 *   - initQuotations / mdkSendToApproval / mdkRegret / reopenMargins /
 *     applyApprovalServerFilter — run with fake fetch, plus source guards on the markers
 *   - people.html esc() and revision-popup.js askStamp fallback
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const peopleHtml = fs.readFileSync(path.join(ROOT, 'people.html'), 'utf8');
const popupSrc = fs.readFileSync(path.join(ROOT, 'revision-popup.js'), 'utf8');

// Pull a function (keeping a leading `async`) out of source by brace matching.
// Matches `function NAME(` exactly, so `can` never picks up `canSomething`.
function extractFunction(src, name) {
    const re = new RegExp('(async\\s+)?function\\s+' + name.replace(/[$]/g, '\\$') + '\\s*\\(');
    const m = re.exec(src);
    if (!m) throw new Error('function not found: ' + name);
    const start = m.index;
    const open = src.indexOf('{', start + m[0].length);
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

// The real `let myAccess = …;` declaration from index.html (its starting value matters).
function myAccessDecl() {
    const m = /let myAccess = [^\n]*;/.exec(html);
    if (!m) throw new Error('myAccess declaration not found');
    return m[0];
}
// The real SERVER_OWNED_LIST_FIELDS declaration.
function serverOwnedDecl() {
    const m = /const SERVER_OWNED_LIST_FIELDS = \[[\s\S]*?\];/.exec(html);
    if (!m) throw new Error('SERVER_OWNED_LIST_FIELDS not found');
    return m[0];
}

// Evaluate the named functions (plus an optional prelude) with `sandbox` values as the free
// variables they read. Returns every named function, and a setter/getter for myAccess when
// the prelude declares it.
function load(names, sandbox, opts) {
    opts = opts || {};
    const src = opts.src || html;
    const prelude = opts.prelude || '';
    const body = prelude + '\n' + names.map(function (n) { return extractFunction(src, n); }).join('\n');
    const keys = Object.keys(sandbox || {});
    const access = /let myAccess/.test(prelude)
        ? '__setAccess: function (a) { myAccess = a; }, __getAccess: function () { return myAccess; },' : '';
    // eslint-disable-next-line no-new-func
    const factory = new Function(keys.join(','), body + '\nreturn {' + access + names.join(',') + '};');
    return factory.apply(null, keys.map(function (k) { return sandbox[k]; }));
}

// Same, with the real myAccess + can() included and access set to `access` (null = leave default).
function loadWithAccess(names, sandbox, access) {
    const fns = load(['can'].concat(names), sandbox, { prelude: myAccessDecl() });
    if (access) fns.__setAccess(access);
    return fns;
}
// A computer whose clock is NOT on India time. Setting process.env.TZ inside jest does not
// reach the real clock (jest hands the test a copy of process.env), and this office's own
// machines ARE on India time — so a stamp that forgot timeZone:'Asia/Kolkata' would still
// pass there. This Date defaults toLocaleString to UTC unless a zone is given, so the
// stamp is only right if the code itself asks for India time.
class UtcComputerDate extends Date {
    toLocaleString(locale, opts) {
        return super.toLocaleString(locale, Object.assign({ timeZone: 'UTC' }, opts || {}));
    }
}

const UNKNOWN = { known: false, permissions: [] };
function known() { return { known: true, permissions: Array.prototype.slice.call(arguments) }; }

// A fetch Response the page's safeJsonParse can read.
function jsonResponse(data, status) {
    const st = status || 200;
    return {
        ok: st >= 200 && st < 300,
        status: st,
        headers: { get: function () { return 'application/json'; } },
        json: async function () { return data; },
        text: async function () { return JSON.stringify(data); },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('can() / loadMyAccess() — what the signed-in person may do', () => {
    function setup(fetchImpl) {
        const fetch = jest.fn(fetchImpl || (async function () { throw new Error('offline'); }));
        const fns = load(['loadMyAccess', 'can', 'refusedMessage'], {
            fetch: fetch, API_BASE_URL: 'http://x/api', console: { warn: function () {} },
        }, { prelude: myAccessDecl() });
        return Object.assign({ fetch: fetch }, fns);
    }
    const ALL = ['allocateMargins', 'editMargins', 'addNotes', 'deleteNotes', 'addRevisions', 'managePeople'];

    test('before /me has answered (the real starting value) nothing is hidden', () => {
        const s = setup();
        expect(s.__getAccess().known).toBe(false);
        ALL.forEach(function (k) { expect(s.can(k)).toBe(true); });
    });

    test('a known list allows ONLY the listed ticks', async () => {
        const s = setup(async function () { return jsonResponse({ permissionsKnown: true, permissions: ['addNotes', 'addRevisions'], who: 'Ravi' }); });
        await s.loadMyAccess();
        expect(s.fetch).toHaveBeenCalledWith('http://x/api/me', expect.objectContaining({ credentials: 'same-origin' }));
        expect(s.can('addNotes')).toBe(true);
        expect(s.can('addRevisions')).toBe(true);
        expect(s.can('deleteNotes')).toBe(false);
        expect(s.can('allocateMargins')).toBe(false);
        expect(s.can('editMargins')).toBe(false);
        expect(s.can('managePeople')).toBe(false);
        expect(s.__getAccess().who).toBe('Ravi');
    });

    test('a known EMPTY list allows nothing', async () => {
        const s = setup(async function () { return jsonResponse({ permissionsKnown: true, permissions: [] }); });
        await s.loadMyAccess();
        ALL.forEach(function (k) { expect(s.can(k)).toBe(false); });
    });

    test('permissionsKnown false (people list unreadable) keeps everything shown', async () => {
        const s = setup(async function () { return jsonResponse({ permissionsKnown: false, permissions: [] }); });
        await s.loadMyAccess();
        ALL.forEach(function (k) { expect(s.can(k)).toBe(true); });
    });

    test('a failed /me (not ok, or network error) hides nothing and does not throw', async () => {
        const notOk = setup(async function () { return jsonResponse({ permissionsKnown: true, permissions: [] }, 500); });
        await notOk.loadMyAccess();
        ALL.forEach(function (k) { expect(notOk.can(k)).toBe(true); });

        const offline = setup();
        await expect(offline.loadMyAccess()).resolves.toBeUndefined();
        ALL.forEach(function (k) { expect(offline.can(k)).toBe(true); });
    });

    test('the list is copied, not shared with the response', async () => {
        const perms = ['addNotes'];
        const s = setup(async function () { return jsonResponse({ permissionsKnown: true, permissions: perms }); });
        await s.loadMyAccess();
        perms.push('deleteNotes');
        expect(s.can('deleteNotes')).toBe(false);
    });
});

describe('refusedMessage — a 403 says so plainly', () => {
    const { refusedMessage } = load(['refusedMessage'], {});

    test('a no-permission refusal shows the server\'s own words', () => {
        expect(refusedMessage({ code: 'no-permission', error: 'You are not allowed to delete notes.' }, 'Failed'))
            .toBe('You are not allowed to delete notes.');
    });
    test('any other error falls back', () => {
        expect(refusedMessage({ code: 'conflict', error: 'Changed meanwhile' }, 'Failed')).toBe('Failed');
        expect(refusedMessage({ error: 'boom' }, 'Failed')).toBe('Failed');
    });
    test('no-permission without words, or no result at all, falls back', () => {
        expect(refusedMessage({ code: 'no-permission' }, 'Failed')).toBe('Failed');
        expect(refusedMessage(null, 'Failed')).toBe('Failed');
        expect(refusedMessage(undefined, 'Failed')).toBe('Failed');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('formatAskStamp — who asked and when, India time', () => {
    const { formatAskStamp } = load(['formatAskStamp'], { Date: UtcComputerDate });
    const AT = '2026-10-16T09:50:00Z';   // 15:20 in India; 09:50 on a UTC computer

    test('(the fake computer really is on UTC when no zone is asked for)', () => {
        expect(new UtcComputerDate(AT).toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })).toBe('9:50 am');
    });

    test('name and India time, exactly', () => {
        expect(formatAskStamp({ addedBy: 'Ravi Kumar', addedAt: AT })).toBe('Ravi Kumar · 16 Oct, 3:20 pm');
    });
    test('an old entry without addedBy shows the time only — no stray " · "', () => {
        expect(formatAskStamp({ addedAt: AT })).toBe('16 Oct, 3:20 pm');
        expect(formatAskStamp({ addedBy: '', addedAt: AT })).toBe('16 Oct, 3:20 pm');
    });
    test('a name with no (or a broken) time shows the name only', () => {
        expect(formatAskStamp({ addedBy: 'Ravi Kumar' })).toBe('Ravi Kumar');
        expect(formatAskStamp({ addedBy: 'Ravi Kumar', addedAt: 'not a date' })).toBe('Ravi Kumar');
    });
    test('nothing at all is an empty string', () => {
        expect(formatAskStamp(null)).toBe('');
        expect(formatAskStamp({})).toBe('');
    });
    test('India date rolls over before UTC does (20:00 UTC is the next morning)', () => {
        expect(formatAskStamp({ addedBy: 'Asha', addedAt: '2026-10-16T20:00:00Z' })).toBe('Asha · 17 Oct, 1:30 am');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('revisionEntryLineHTML — the 🗑 on a note', () => {
    function line(access) {
        return loadWithAccess(['escapeHtml', 'revisionTextHtml', 'formatAskStamp', 'revisionEntryLineHTML'], { Date: UtcComputerDate }, access)
            .revisionEntryLineHTML;
    }
    const note = { id: 'n1', text: 'Call the buyer', addedBy: 'Ravi Kumar', addedAt: '2026-10-16T09:50:00Z' };

    test('a note with an id, for someone with Delete notes, gets the 🗑 button', () => {
        const h = line(known('deleteNotes'))(note, { note: true, quoteId: 'q1' });
        expect(h).toContain('class="rev-note-del"');
        expect(h).toContain('data-qid="q1"');
        expect(h).toContain('data-note-id="n1"');
        expect(h).toContain('onclick="event.stopPropagation(); deleteExtraNote(this)">🗑</button>');
        // OUTSIDE the text span (the note's HTML is sanitised and would drop it)
        expect(h.indexOf('class="rev-note-del"')).toBeGreaterThan(h.indexOf('class="rev-ask-meta"'));
    });

    test('unknown access shows it too (the server still checks)', () => {
        expect(line(null)(note, { note: true, quoteId: 'q1' })).toContain('rev-note-del');
    });

    test('no Delete notes tick → no 🗑', () => {
        const h = line(known('addNotes', 'addRevisions'))(note, { note: true, quoteId: 'q1' });
        expect(h).not.toContain('rev-note-del');
        expect(h).not.toContain('deleteExtraNote');
    });

    test('a note without an id, or without the quote id, gets no 🗑', () => {
        const fn = line(known('deleteNotes'));
        expect(fn({ text: 'old note' }, { note: true, quoteId: 'q1' })).not.toContain('rev-note-del');
        expect(fn(note, { note: true })).not.toContain('rev-note-del');
    });

    test('a revision ask NEVER gets the 🗑, even with Delete notes and a quote id', () => {
        const fn = line(known('deleteNotes'));
        expect(fn({ id: 'r1', text: 'Change rate' }, { quoteId: 'q1' })).not.toContain('rev-note-del');
        expect(fn({ id: 'r1', text: 'Change rate', done: true }, {})).not.toContain('rev-note-del');
    });

    test('the data attributes are escaped', () => {
        const h = line(known('deleteNotes'))({ id: 'n"1\'<x>', text: 't' }, { note: true, quoteId: 'q"1<b>' });
        expect(h).toContain('data-qid="q&quot;1&lt;b&gt;"');
        expect(h).toContain('data-note-id="n&quot;1&#39;&lt;x&gt;"');
        expect(h).not.toContain('q"1');
        expect(h).not.toContain('n"1');
    });

    test('the meta shows the stamp (escaped) and " · done" for a done ask', () => {
        const fn = line(UNKNOWN);
        expect(fn(note, { note: true, quoteId: 'q1' }))
            .toContain('<span class="rev-ask-meta">Ravi Kumar · 16 Oct, 3:20 pm</span>');
        expect(fn({ id: 'r', text: 'x', addedBy: '<i>Eve</i>', addedAt: '2026-10-16T09:50:00Z', done: true }, {}))
            .toContain('<span class="rev-ask-meta">&lt;i&gt;Eve&lt;/i&gt; · 16 Oct, 3:20 pm · done</span>');
    });

    test('the dot: 🗒️ for a note, ● open ask, ✓ done ask', () => {
        const fn = line(UNKNOWN);
        expect(fn(note, { note: true })).toContain('<span class="rev-ask-dot">🗒️</span>');
        expect(fn({ text: 'x' }, {})).toContain('<span class="rev-ask-dot">●</span>');
        expect(fn({ text: 'x', done: true }, {})).toContain('<span class="rev-ask-dot">✓</span>');
    });
});

describe('buildRevisionStripHTML — each Add button only with its tick', () => {
    function strip(access) {
        return loadWithAccess(['escapeHtml', 'revisionTextHtml', 'formatAskStamp', 'revisionEntryLineHTML',
            'revisionRequestsOf', 'extraNotesOf', 'buildRevisionStripHTML'], { Date: UtcComputerDate }, access).buildRevisionStripHTML;
    }
    const empty = { id: 'q1' };
    const ADD_REV = "addRevisionRequest(\"q1\", 'revision')\">📝 Add revision</button>";
    const ADD_NOTE = "addRevisionRequest(\"q1\", 'note')\">🗒️ Add another note</button>";

    test('unknown access: both buttons', () => {
        const h = strip(null)(empty);
        expect(h).toContain(ADD_REV);
        expect(h).toContain(ADD_NOTE);
        expect(h).toContain('rev-ask-strip is-empty');
    });
    test('Add revisions only → only "Add revision"', () => {
        const h = strip(known('addRevisions'))(empty);
        expect(h).toContain(ADD_REV);
        expect(h).not.toContain('Add another note');
    });
    test('Add notes only → only "Add another note"', () => {
        const h = strip(known('addNotes'))(empty);
        expect(h).toContain(ADD_NOTE);
        expect(h).not.toContain('Add revision');
    });
    test('no ticks → neither button (the empty actions row stays)', () => {
        const h = strip(known())(empty);
        expect(h).not.toContain('Add revision');
        expect(h).not.toContain('Add another note');
        expect(h).toContain('<div class="rev-ask-actions"></div>');
    });
    test('notes are drawn with the quote id, so the 🗑 can show; revisions never get one', () => {
        const q = {
            id: 'q9',
            extraNotes: [{ id: 'n1', text: 'a note' }],
            revisionRequests: [{ id: 'r1', text: 'open ask' }, { id: 'r2', text: 'done ask', done: true }],
        };
        const h = strip(known('deleteNotes'))(q);
        expect(h).toContain('data-qid="q9" data-note-id="n1"');
        expect((h.match(/rev-note-del/g) || []).length).toBe(1);
        expect(h).toContain('rev-ask-strip is-open');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('adminStripActionsHTML — the ✏️ / 🗑 corner icons', () => {
    function actions(access) {
        return loadWithAccess(['escapeHtml', 'adminStripActionsHTML'], {}, access).adminStripActionsHTML;
    }
    const base = { id: 'q1', adminStatus: 'ready', sent: false, everApproved: false, allocatedTableFp: 'fp-1', tableHTML: '<table><tr class="item-row"></tr></table>' };
    const EDIT = 'onclick="event.stopPropagation(); reopenMargins(this)">✏️</button>';
    const DEL = 'onclick="event.stopPropagation(); clearAdminNote(this)">🗑</button>';

    test('an untouched, allocated, unsent quote with Edit margins gets ✏️ inside .mdk-corner', () => {
        const h = actions(known('editMargins'))(base, false);
        expect(h).toContain(EDIT);
        expect(h).toContain('title="Edit margins"');
        expect(h).toContain('data-qid="q1"');
        expect(h.startsWith('<div class="mdk-corner">')).toBe(true);
        expect(h.endsWith('</div>')).toBe(true);
        expect(h).not.toContain(DEL);
    });

    test.each([
        ['no Edit margins tick', {}, known('allocateMargins', 'deleteNotes')],
        ['still awaiting', { adminStatus: 'awaiting' }, known('editMargins')],
        ['regretted', { adminStatus: 'regretted' }, known('editMargins')],
        ['already sent', { sent: true }, known('editMargins')],
        ['approved since', { everApproved: true }, known('editMargins')],
        ['no allocatedTableFp (box did not build the table)', { allocatedTableFp: '' }, known('editMargins')],
        ['FOR freight spread into margin', { freightDistributedIntoMargin: true }, known('editMargins')],
        ['a freight line in the table', { tableHTML: '<table><tr class="freight-row"></tr></table>' }, known('editMargins')],
    ])('no ✏️ when %s', (_label, patch, access) => {
        const h = actions(access)(Object.assign({}, base, patch), false);
        expect(h).not.toContain('reopenMargins');
        expect(h).toBe('');
    });

    test('🗑 only with a note AND Delete notes', () => {
        const q = Object.assign({}, base, { adminStatus: 'awaiting' });   // no ✏️ here
        expect(actions(known('deleteNotes'))(q, true)).toBe('<div class="mdk-corner">'
            + '<button type="button" title="Delete the admin note" aria-label="Delete the admin note" data-qid="q1" ' + DEL + '</div>');
        expect(actions(known('deleteNotes'))(q, false)).toBe('');
        expect(actions(known('editMargins', 'addNotes'))(q, true)).toBe('');
    });

    test('both icons sit together in ONE corner box, ✏️ first', () => {
        const h = actions(null)(base, true);
        expect((h.match(/class="mdk-corner"/g) || []).length).toBe(1);
        expect(h.indexOf(EDIT)).toBeGreaterThan(0);
        expect(h.indexOf(DEL)).toBeGreaterThan(h.indexOf(EDIT));
        expect(h.endsWith(DEL + '</div>')).toBe(true);
        expect(h).not.toContain('rev-ask-actions');
    });

    test('the quote id is escaped into data-qid', () => {
        const h = actions(null)(Object.assign({}, base, { id: 'q"1<x>' }), true);
        expect(h).toContain('data-qid="q&quot;1&lt;x&gt;"');
        expect(h).not.toContain('data-qid="q"1');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('renderMarginDesk — Allocate sees every waiting quote; Edit only the reopened ones', () => {
    function runDesk(quotes, access) {
        const section = { style: {}, innerHTML: 'old' };
        const doc = { getElementById: function (id) { return id === 'marginDeskSection' ? section : null; } };
        const fns = loadWithAccess(['renderMarginDesk'], {
            document: doc,
            approvedQuotations: quotes,
            buildMarginDeskRow: function (q) { return '[row:' + q.id + ']'; },
            ensureDeskEnquiryLoaded: function () {},
            mdkExpandedIds: {},
        }, access);
        fns.renderMarginDesk();
        return section;
    }
    const quotes = [
        { id: 'fresh', adminStatus: 'awaiting' },
        { id: 'reopened', adminStatus: 'awaiting', adminReopenedAt: '2026-10-16T10:00:00Z', adminReopenedBy: 'Ravi' },
        { id: 'sentReopened', adminStatus: 'awaiting', adminReopenedAt: '2026-10-16T10:00:00Z', sent: true },
        { id: 'deletedReopened', adminStatus: 'awaiting', adminReopenedAt: '2026-10-16T10:00:00Z', deleted: true },
        { id: 'ready', adminStatus: 'ready', adminReopenedAt: '2026-10-16T10:00:00Z' },
    ];

    test('Allocate margins → every waiting quote', () => {
        const s = runDesk(quotes, known('allocateMargins'));
        expect(s.style.display).toBe('block');
        expect(s.innerHTML).toContain('[row:fresh]');
        expect(s.innerHTML).toContain('[row:reopened]');
        expect(s.innerHTML).not.toContain('[row:sentReopened]');
        expect(s.innerHTML).not.toContain('[row:deletedReopened]');
        expect(s.innerHTML).not.toContain('[row:ready]');
        expect(s.innerHTML).toContain('2 waiting');
    });

    test('Edit margins alone → only the reopened ones', () => {
        const s = runDesk(quotes, known('editMargins'));
        expect(s.style.display).toBe('block');
        expect(s.innerHTML).toContain('[row:reopened]');
        expect(s.innerHTML).not.toContain('[row:fresh]');
        expect(s.innerHTML).toContain('1 waiting');
    });

    test('Edit margins alone with nothing reopened → box hidden', () => {
        const s = runDesk([{ id: 'fresh', adminStatus: 'awaiting' }], known('editMargins'));
        expect(s.style.display).toBe('none');
        expect(s.innerHTML).toBe('');
    });

    test('neither tick → no box at all', () => {
        const s = runDesk(quotes, known('addNotes', 'deleteNotes', 'addRevisions', 'managePeople'));
        expect(s.style.display).toBe('none');
        expect(s.innerHTML).toBe('');
    });

    test('unknown access → every waiting quote (nothing hidden)', () => {
        const s = runDesk(quotes, null);
        expect(s.innerHTML).toContain('[row:fresh]');
        expect(s.innerHTML).toContain('[row:reopened]');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sanitizeQuotationForSave — the desk\'s working copies never reach the save', () => {
    const { sanitizeQuotationForSave } = load(['sanitizeQuotationForSave'], { PDF_PLACEHOLDER: '(PDF)' });

    test('strips _adminMarginsDraft, _deskLoading, _deskLoaded, _mdkNoteEdited, _mdkNoteFrom', () => {
        const q = {
            id: 'q1', companyName: 'Acme', adminNote: 'keep me', adminMargins: { erw: { pct: '3' } },
            _adminMarginsDraft: { erw: { pct: '9' } }, _deskLoading: true, _deskLoaded: true,
            _mdkNoteEdited: true, _mdkNoteFrom: 'old note',
        };
        const out = sanitizeQuotationForSave(q);
        ['_adminMarginsDraft', '_deskLoading', '_deskLoaded', '_mdkNoteEdited', '_mdkNoteFrom'].forEach(function (k) {
            expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
        });
        expect(out.companyName).toBe('Acme');
        expect(out.adminNote).toBe('keep me');
        expect(out.adminMargins).toEqual({ erw: { pct: '3' } });
        // the on-screen copy keeps its working state
        expect(q._mdkNoteEdited).toBe(true);
        expect(q._adminMarginsDraft).toEqual({ erw: { pct: '9' } });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('initQuotations — access is known BEFORE the first render', () => {
    test('the list loads only after /me has answered', async () => {
        let resolveMe;
        const fetch = jest.fn(function () { return new Promise(function (r) { resolveMe = r; }); });
        const seenAtLoad = [];
        let fns;
        const sandbox = {
            fetch: fetch, API_BASE_URL: 'http://x/api', console: { warn: function () {} },
            initDropTargets: function () {}, initApprovalFilters: function () {},
            approvedQuotationsCursor: 'c', approvedQuotationsHasMore: true,
            loadQuotationsFromBackend: async function () { seenAtLoad.push(fns.can('allocateMargins')); },
            loadRevisionQuotesForCount: function () {},
            setTimeout: function () {}, checkAllReplies: function () {},
        };
        fns = load(['loadMyAccess', 'can', 'initQuotations'], sandbox, { prelude: myAccessDecl() });
        const done = fns.initQuotations();
        await Promise.resolve(); await Promise.resolve();
        expect(seenAtLoad).toEqual([]);           // still waiting on /me
        resolveMe(jsonResponse({ permissionsKnown: true, permissions: ['addNotes'] }));
        await done;
        expect(seenAtLoad).toEqual([false]);      // first render already knew: no Allocate tick
    });

    test('source guard: await loadMyAccess() comes before the first list load', () => {
        const fn = extractFunction(html, 'initQuotations');
        const a = fn.indexOf('await loadMyAccess();');
        const b = fn.indexOf('await loadQuotationsFromBackend(false);');
        expect(a).toBeGreaterThan(-1);
        expect(b).toBeGreaterThan(a);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mdkSendToApproval — the note is sent only when typed, with the note it replaced', () => {
    function setup(q, access, fetchImpl) {
        const noteEl = { innerHTML: 'note in the box' };
        const btn = { disabled: false, textContent: '→ Send to approval' };
        const doc = {
            getElementById: function (id) {
                if (id === 'mdk-note-' + q.id) return noteEl;
                if (id === 'mdk-apply-' + q.id) return btn;
                return null;
            },
        };
        const fetch = jest.fn(fetchImpl || (async function () { return jsonResponse({ success: true, quotation: { adminStatus: 'ready' } }); }));
        const fns = loadWithAccess(['idsMatch', 'mdkQuote', 'adminMarginsOf', 'safeJsonParse', 'mdkSendToApproval'], {
            approvedQuotations: [q], document: doc, fetch: fetch, API_BASE_URL: 'http://x/api',
            defaultMarginsByPipeType: { erw: '3', gi: '4', seamless: '5' }, mdkSending: {},
            displayAllApprovedQuotations: jest.fn(), alert: jest.fn(), console: { error: function () {} },
        }, access);
        return { fns: fns, fetch: fetch, noteEl: noteEl, btn: btn };
    }
    function sentBody(fetch) { return JSON.parse(fetch.mock.calls[0][1].body); }

    test('note not typed here → no adminNote / expectedAdminNote in the request, stored note untouched', async () => {
        const q = { id: 'q1', adminStatus: 'awaiting', adminNote: 'stored note' };
        const s = setup(q, known('allocateMargins', 'addNotes'));
        await s.fns.mdkSendToApproval('q1');
        expect(s.fetch).toHaveBeenCalledTimes(1);
        expect(s.fetch.mock.calls[0][0]).toBe('http://x/api/quotations/q1/apply-admin-margins');
        const body = sentBody(s.fetch);
        expect(Object.prototype.hasOwnProperty.call(body, 'adminNote')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(body, 'expectedAdminNote')).toBe(false);
        expect(body.adminMargins).toBeDefined();
    });

    test('note typed here (with Add notes) → sent from the box, with expectedAdminNote = the note it was typed over', async () => {
        const q = { id: 'q1', adminStatus: 'awaiting', adminNote: 'half typed', _mdkNoteEdited: true, _mdkNoteFrom: 'colleague note' };
        const s = setup(q, known('allocateMargins', 'addNotes'));
        s.noteEl.innerHTML = 'final <b>note</b>';
        await s.fns.mdkSendToApproval('q1');
        const body = sentBody(s.fetch);
        expect(body.adminNote).toBe('final <b>note</b>');
        expect(body.expectedAdminNote).toBe('colleague note');
        // after success the working markers are gone
        expect(q._mdkNoteEdited).toBeUndefined();
        expect(q._mdkNoteFrom).toBeUndefined();
        expect(q._adminMarginsDraft).toBeUndefined();
        expect(q.adminStatus).toBe('ready');
    });

    test('note typed but no Add notes tick → note left out', async () => {
        const q = { id: 'q1', adminStatus: 'awaiting', adminNote: 'x', _mdkNoteEdited: true, _mdkNoteFrom: 'x' };
        const s = setup(q, known('allocateMargins'));
        await s.fns.mdkSendToApproval('q1');
        const body = sentBody(s.fetch);
        expect(Object.prototype.hasOwnProperty.call(body, 'adminNote')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(body, 'expectedAdminNote')).toBe(false);
        expect(q.adminNote).toBe('x');   // the box's text was not copied in either
    });

    test('a second click while the first is saving does nothing; the button shows Sending…', async () => {
        let release;
        const q = { id: 'q1', adminStatus: 'awaiting' };
        const s = setup(q, null, function () { return new Promise(function (r) { release = r; }); });
        const first = s.fns.mdkSendToApproval('q1');
        const second = s.fns.mdkSendToApproval('q1');
        await second;
        expect(s.fetch).toHaveBeenCalledTimes(1);
        expect(s.btn.disabled).toBe(true);
        expect(s.btn.textContent).toBe('Sending…');
        release(jsonResponse({ success: true, quotation: {} }));
        await first;
    });

    test('source guards: note copied/sent only when q._mdkNoteEdited, with expectedAdminNote', () => {
        const fn = extractFunction(html, 'mdkSendToApproval');
        expect(fn).toContain("if (noteEl && can('addNotes') && q._mdkNoteEdited) q.adminNote = noteEl.innerHTML;");
        expect(fn).toContain("...(can('addNotes') && q._mdkNoteEdited ? { adminNote: q.adminNote || '', expectedAdminNote: q._mdkNoteFrom || '' } : {}),");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mdkRegret — the server is asked (check:true) BEFORE the email window opens', () => {
    function setup(q, access, regretCheck) {
        const order = [];
        const fetch = jest.fn(async function (url, init) {
            if (/\/regret$/.test(url)) {
                order.push('regret:' + (init && init.body));
                if (regretCheck instanceof Error) throw regretCheck;
                return regretCheck || jsonResponse({ success: true, ok: true });
            }
            if (/resolve-thread/.test(url)) { order.push('resolve'); return jsonResponse({ fromEmail: 'buyer@acme.in', subject: 'Enquiry' }); }
            order.push('other:' + url);
            return jsonResponse({ success: true });
        });
        const compose = jest.fn(async function () { order.push('compose'); return null; });   // cancelled
        const alert = jest.fn();
        const fns = loadWithAccess(['refusedMessage', 'safeJsonParse', 'mdkRegret'], {
            mdkQuote: function () { return q; }, fetch: fetch, API_BASE_URL: 'http://x/api', alert: alert,
            composeQuotationEmail: compose, bareEmailFromHeader: function (s) { return s; },
            replySubjectLocal: function (s) { return 'Re: ' + s; }, regretEmailBodyHtml: async function () { return '<p>Sorry</p>'; },
            mdkSetRegretStatus: jest.fn(async function () { return true; }), confirm: jest.fn(function () { return false; }),
            console: { error: function () {} },
        }, access);
        return { fns: fns, fetch: fetch, compose: compose, alert: alert, order: order };
    }
    const q = { id: 'q1', companyName: 'Acme', gmailMessageId: 'm1', adminStatus: 'awaiting' };

    test('allowed: check:true goes first, then the email window', async () => {
        const s = setup(q, known('allocateMargins'));
        await s.fns.mdkRegret('q1');
        expect(s.order[0]).toBe('regret:{"check":true}');
        expect(s.order).toContain('compose');
        expect(s.order.indexOf('compose')).toBeGreaterThan(0);
        expect(s.fetch.mock.calls[0][0]).toBe('http://x/api/quotations/q1/regret');
    });

    test('server refuses (403) → its words are shown and NO email window opens', async () => {
        const s = setup(q, known('allocateMargins'), jsonResponse({ code: 'no-permission', error: 'You may not regret this quote.' }, 403));
        await s.fns.mdkRegret('q1');
        expect(s.compose).not.toHaveBeenCalled();
        expect(s.alert).toHaveBeenCalledWith('You may not regret this quote.');
        expect(s.order).toEqual(['regret:{"check":true}']);
    });

    test('server says the quote is no longer waiting (409) → no email window', async () => {
        const s = setup(q, known('allocateMargins'), jsonResponse({ error: 'Already regretted' }, 409));
        await s.fns.mdkRegret('q1');
        expect(s.compose).not.toHaveBeenCalled();
        expect(s.alert).toHaveBeenCalledWith('Already regretted');
    });

    test('server unreachable → nothing sent, no email window', async () => {
        const s = setup(q, known('allocateMargins'), new Error('offline'));
        await s.fns.mdkRegret('q1');
        expect(s.compose).not.toHaveBeenCalled();
        expect(s.alert).toHaveBeenCalledWith('Could not reach the server. Nothing was sent.');
    });

    test('no Allocate margins tick → refused before any request', async () => {
        const s = setup(q, known('editMargins', 'addNotes'));
        await s.fns.mdkRegret('q1');
        expect(s.fetch).not.toHaveBeenCalled();
        expect(s.compose).not.toHaveBeenCalled();
        expect(s.alert.mock.calls[0][0]).toMatch(/not allowed to regret/);
    });

    test('source guard: check:true regret call comes before composeQuotationEmail', () => {
        const fn = extractFunction(html, 'mdkRegret');
        const check = fn.indexOf('/regret`, {\n                    method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify({ check: true })');
        const compose = fn.indexOf('composeQuotationEmail(');
        expect(check).toBeGreaterThan(-1);
        expect(compose).toBeGreaterThan(check);
        expect(fn).toContain("if (!pre.ok) { alert(refusedMessage(preResult, preResult.error || 'Could not check this quote. Try again.')); return; }");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reopenMargins — refuses unsaved edits; copies back only the box\'s fields', () => {
    function setup(q, opts) {
        opts = opts || {};
        const fetch = jest.fn(opts.fetch || (async function () {
            return jsonResponse({
                success: true,
                quotation: {
                    adminStatus: 'awaiting', adminReopenedAt: '2026-10-16T11:00:00Z', adminReopenedBy: 'Ravi Kumar',
                    adminMargins: { erw: { pct: '7' } }, adminNote: 'server note', updatedAt: 'u2',
                    // stored copies that must NOT overwrite what is on screen
                    companyName: 'STORED CO', lineItems: [{ lineItemId: 'stale' }], tableHTML: '<stored/>', checkedBy: 'old',
                },
            });
        }));
        const alert = jest.fn();
        const confirm = jest.fn(function () { return true; });
        const renderMarginDesk = jest.fn();
        const win = { _flushApprovalEdits: opts.flush || function () {} };
        const fns = load(['idsMatch', 'refusedMessage', 'safeJsonParse', 'reopenMargins'], {
            approvedQuotations: [q], adminStripBusy: {}, window: win, alert: alert, confirm: confirm,
            fetch: fetch, API_BASE_URL: 'http://x/api', syncApprovedQuotationsGlobal: function () {},
            renderMarginDesk: renderMarginDesk, displayAllApprovedQuotations: function () {},
            document: { getElementById: function () { return null; } },
        });
        const btn = { disabled: false, getAttribute: function (k) { return k === 'data-qid' ? String(q.id) : null; } };
        return { fns: fns, fetch: fetch, alert: alert, confirm: confirm, renderMarginDesk: renderMarginDesk, btn: btn };
    }

    test('unsaved edits → refused with a message; no request, no confirm', async () => {
        const q = { id: 'q1', adminStatus: 'ready', hasUnsavedEdits: true };
        const s = setup(q);
        await s.fns.reopenMargins(s.btn);
        expect(s.fetch).not.toHaveBeenCalled();
        expect(s.confirm).not.toHaveBeenCalled();
        expect(s.alert.mock.calls[0][0]).toMatch(/not saved/);
    });

    test('pending typing is flushed first — edits it reveals are refused too', async () => {
        const q = { id: 'q1', adminStatus: 'ready' };
        const s = setup(q, { flush: function (id) { if (id === 'q1') q.hasUnsavedEdits = true; } });
        await s.fns.reopenMargins(s.btn);
        expect(s.fetch).not.toHaveBeenCalled();
    });

    test('success → only the box\'s fields are copied; the on-screen quote keeps the rest', async () => {
        const q = {
            id: 'q1', adminStatus: 'ready', companyName: 'Acme', lineItems: [{ lineItemId: 'live' }],
            tableHTML: '<live/>', checkedBy: 'Asha', _adminMarginsDraft: { erw: { pct: '1' } },
        };
        const s = setup(q);
        await s.fns.reopenMargins(s.btn);
        expect(s.fetch.mock.calls[0][0]).toBe('http://x/api/quotations/q1/reopen-margins');
        expect(q.adminStatus).toBe('awaiting');
        expect(q.adminReopenedAt).toBe('2026-10-16T11:00:00Z');
        expect(q.adminReopenedBy).toBe('Ravi Kumar');
        expect(q.adminMargins).toEqual({ erw: { pct: '7' } });
        expect(q.adminNote).toBe('server note');
        expect(q.updatedAt).toBe('u2');
        expect(q.companyName).toBe('Acme');
        expect(q.lineItems).toEqual([{ lineItemId: 'live' }]);
        expect(q.tableHTML).toBe('<live/>');
        expect(q.checkedBy).toBe('Asha');
        expect(q._adminMarginsDraft).toBeUndefined();
        expect(s.renderMarginDesk).toHaveBeenCalled();
    });

    test('a refusal shows the server\'s words and re-enables the button', async () => {
        const q = { id: 'q1', adminStatus: 'ready' };
        const s = setup(q, { fetch: async function () { return jsonResponse({ code: 'no-permission', error: 'You may not edit margins.' }, 403); } });
        await s.fns.reopenMargins(s.btn);
        expect(s.alert).toHaveBeenCalledWith('Could not open the margins again: You may not edit margins.');
        expect(s.btn.disabled).toBe(false);
        expect(q.adminStatus).toBe('ready');
    });

    test('source guards: refuses hasUnsavedEdits; no whole-quote Object.assign', () => {
        const fn = extractFunction(html, 'reopenMargins');
        expect(fn).toContain("if (q.hasUnsavedEdits) { alert('This quote has changes that are not saved.");
        expect(fn).toContain("['adminStatus', 'adminReopenedAt', 'adminReopenedBy', 'adminMargins', 'adminNote', 'updatedAt'].forEach(function(k) {");
        expect(fn).not.toMatch(/Object\.assign\(\s*q\s*,\s*result\.quotation\s*\)/);
        // the flush happens before the check
        expect(fn.indexOf('_flushApprovalEdits(q.id)')).toBeLessThan(fn.indexOf('if (q.hasUnsavedEdits)'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SERVER_OWNED_LIST_FIELDS — desk fields refresh from the server, except a note being typed', () => {
    test('includes adminStatus and adminNote (and the rest of the desk fields)', () => {
        // eslint-disable-next-line no-new-func
        const list = new Function(serverOwnedDecl() + '\nreturn SERVER_OWNED_LIST_FIELDS;')();
        ['adminStatus', 'adminNote', 'adminMargins', 'adminReopenedAt', 'adminReopenedBy', 'allocatedBy', 'allocatedTableFp']
            .forEach(function (k) { expect(list).toContain(k); });
    });

    function runFilter(existing, server) {
        const fetch = jest.fn(async function () { return jsonResponse({ quotations: [server] }); });
        const fns = load(['idsMatch', 'safeJsonParse', 'approvalFilterKey', 'applyApprovalServerFilter'], {
            _approvalFilterSeq: 0, approvalFilterFetchFailed: false, approvalServerFilterKey: null,
            approvalServerFilterIds: null, approvalFilterLoading: false,
            approvalEnquiryFilter: false, approvalRevisionFilter: true, approvalFreightFilter: false, approvalMonthFilter: '',
            displayAllApprovedQuotations: function () {}, fetch: fetch, API_BASE_URL: 'http://x/api',
            approvedQuotations: [existing], syncApprovedQuotationsGlobal: function () {},
        }, { prelude: serverOwnedDecl() });
        return fns.applyApprovalServerFilter().then(function () { return fetch; });
    }

    test('a colleague\'s new desk state replaces this tab\'s old copy', async () => {
        const existing = { id: 'q1', adminStatus: 'ready', adminNote: 'old note', companyName: 'Typed here' };
        const fetch = await runFilter(existing, { id: 'q1', adminStatus: 'awaiting', adminNote: 'new note', companyName: 'Server' });
        expect(fetch.mock.calls[0][0]).toBe('http://x/api/quotations-filter?revision=1');
        expect(existing.adminStatus).toBe('awaiting');
        expect(existing.adminNote).toBe('new note');
        expect(existing.companyName).toBe('Typed here');   // not server-owned: never overwritten
    });

    test('a note being typed on the desk (_mdkNoteEdited) is NOT overwritten — the status still is', async () => {
        const existing = { id: 'q1', adminStatus: 'awaiting', adminNote: 'half typed', _mdkNoteEdited: true };
        await runFilter(existing, { id: 'q1', adminStatus: 'ready', adminNote: 'server note' });
        expect(existing.adminNote).toBe('half typed');
        expect(existing.adminStatus).toBe('ready');
    });

    test('source guard: the refresh skips adminNote while _mdkNoteEdited', () => {
        const fn = extractFunction(html, 'applyApprovalServerFilter');
        expect(fn).toContain("if (k === 'adminNote' && existing._mdkNoteEdited) return;");
        expect(fn).toContain('SERVER_OWNED_LIST_FIELDS.forEach(function(k) {');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('people.html esc() — safe inside attributes too', () => {
    const { esc } = load(['esc'], {}, { src: peopleHtml });

    test('escapes " and \' as well as & < >', () => {
        expect(esc('a"b')).toBe('a&quot;b');
        expect(esc("O'Brien")).toBe('O&#39;Brien');
        expect(esc('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
        expect(esc('"><img src=x onerror=alert(1)>')).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    });
    test('null / undefined become an empty string; numbers become text', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
        expect(esc(0)).toBe('0');
    });
    test('roleHtml keeps an awkward address inside its data-email attribute', () => {
        const { roleHtml } = load(['esc', 'roleHtml'], { catalog: [{ key: 'a' }, { key: 'b' }] }, { src: peopleHtml });
        const h = roleHtml({ email: 'x"onclick="alert(1)\'@a.in', permissions: ['a'] });
        expect(h).toContain('data-email="x&quot;onclick=&quot;alert(1)&#39;@a.in"');
        expect(h).toContain('1 of 2 allowed');
        expect(roleHtml({ email: 'b@a.in', permissions: ['a', 'b'] })).toContain('>Admin</button>');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('revision-popup.js askStamp — works on its own, India time', () => {
    function loadPopup(extraWindow) {
        const appended = [];
        const store = {};
        const win = Object.assign({
            localStorage: {
                getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
                setItem: function (k, v) { store[k] = String(v); },
            },
            location: { origin: 'http://localhost:3000' },
        }, extraWindow || {});
        function makeEl() {
            return { className: '', id: '', innerHTML: '', querySelector: function () { return {}; }, addEventListener: function () {}, remove: function () {} };
        }
        const doc = {
            hidden: false,
            body: { appendChild: function (el) { appended.push(el); } },
            createElement: makeEl,
            getElementById: function () { return null; },
        };
        // Date: a computer NOT on India time (see UtcComputerDate).
        const ctx = { window: win, document: doc, Date: UtcComputerDate, setInterval: function () { return 0; }, fetch: function () { return Promise.reject(new Error('no')); }, console: console };
        vm.createContext(ctx);
        vm.runInContext(popupSrc, ctx);
        return { RP: win.RevisionPopup, appended: appended };
    }
    const AT = '2026-10-16T09:50:00Z';

    test('fallback (no window.formatAskStamp): name and India time, exactly', () => {
        const { RP } = loadPopup();
        expect(RP._test.askStamp({ addedBy: 'Ravi Kumar', addedAt: AT })).toBe('Ravi Kumar · 16 Oct, 3:20 pm');
    });
    test('fallback: an old ask without addedBy shows the time only, no stray " · "', () => {
        const { RP } = loadPopup();
        expect(RP._test.askStamp({ addedAt: AT })).toBe('16 Oct, 3:20 pm');
        expect(RP._test.askStamp({ addedBy: 'Ravi Kumar' })).toBe('Ravi Kumar');
        expect(RP._test.askStamp(null)).toBe('');
    });
    test('uses index.html\'s formatAskStamp when the page has one', () => {
        const { RP } = loadPopup({ formatAskStamp: function (a) { return 'page:' + a.addedBy; } });
        expect(RP._test.askStamp({ addedBy: 'Ravi', addedAt: AT })).toBe('page:Ravi');
    });
    test('the pop-up row shows the stamp, escaped', () => {
        const { RP, appended } = loadPopup();
        RP.check([{ id: 1, quoteNumber: 'DSC-1', companyName: 'Acme', revisionRequests: [{ id: 'a1', text: 'Change rate', addedBy: 'Ravi <b>K</b>', addedAt: AT }] }]);
        expect(appended.length).toBe(1);
        expect(appended[0].innerHTML).toContain('Ravi &lt;b&gt;K&lt;/b&gt; · 16 Oct, 3:20 pm');
    });
});
