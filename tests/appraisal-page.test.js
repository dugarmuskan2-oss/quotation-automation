/**
 * @jest-environment node
 *
 * tests/appraisal-page.test.js
 *
 * The staff appraisal page (appraisal-page.js, loaded by appraisal.html). This runs the REAL
 * shipped script — not a copy of its logic — inside a Node `vm` sandbox with a small stub DOM:
 *
 *  - #main / #tabs / #sub / #toast are plain objects; the page writes HTML strings into them and
 *    the tests read those strings back.
 *  - document.addEventListener is captured, so clicks and typing go through the page's own
 *    'click' / 'input' handlers. A click is only ever made on a button the page actually drew:
 *    the helper finds the element in the rendered HTML and hands its own data-* attributes to the
 *    handler (no hand-built fixture the real page could never produce).
 *  - fetch is a stub that serves /api/appraisal/me and /overview from fixtures built on the real
 *    utils/appraisal.js DEFAULT_SETUP, and records every other request.
 *  - Date and setTimeout are controlled, so "a second click within 400 ms" and "disarmed after
 *    4 seconds" can be tested without waiting.
 *
 * What it pins (behaviour first, a few source guards at the end):
 *  1. Quarterly reviews: the red "daily reminder email failed" line when the last failure is newer
 *     than the last send, the muted "last emailed" line otherwise.
 *  2. Staff tab: each person's item count (their jobs + their own items − items removed for them).
 *  3. Edit: the full list under headings in Setup order (Sales before Administration, even after
 *     Sales is unticked and ticked again), Remove / Put back for shared items with the count
 *     following, "+ Add an item under …" adding an own item under that heading.
 *  4. Save: refused with no request for a blank own-item name or an item under a deleted job;
 *     otherwise sends roles/targets/extras/hidden, with a staff PUT first only when the name or
 *     email changed.
 *  5. Remove needs two separate clicks (a second click within 400 ms does nothing), is disarmed
 *     after 4 s, and is refused while an Edit panel is open.
 *  6. Add staff: one POST even on a double click (the in-flight lock), the input is cleared once
 *     used, the lock comes off again after a successful save, and a failed POST unlocks so it can
 *     be tried again.
 *  7. Ten score buttons per item, on the manager's review and on the staff member's own form.
 *     The manager's Save & mark done sends the version it opened and never a self-review that was
 *     typed in and then unticked; a staff member updating a submitted form sends the version it
 *     opened; a quarter the manager has finished is locked.
 *  8. A staff member who is not on the list sees "not on the staff list yet"; a failed load
 *     says it failed instead of showing an empty list.
 *  9. Names are escaped (shown as text, never as markup).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DEFAULT_SETUP } = require('../utils/appraisal');

const ROOT = path.join(__dirname, '..');
const PAGE_FILE = path.join(ROOT, 'appraisal-page.js');
const HTML_FILE = path.join(ROOT, 'appraisal.html');

const clone = (o) => JSON.parse(JSON.stringify(o));
// 16 Oct 2026, 12:00 India time: the page's "previous quarter" is then Jul–Sep 2026 (2026-27-Q2).
const NOW = Date.parse('2026-10-16T06:30:00.000Z');
const PREV_Q = '2026-27-Q2';

// ── Reading the HTML the page drew ──────────────────────────────────────────────────────────────

function decode(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function camel(k) { return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function parseAttrs(src) {
    const attrs = {};
    const dataset = {};
    const rx = /([\w-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = rx.exec(src))) {
        const v = a[2] === undefined ? '' : decode(a[2]);
        attrs[a[1]] = v;
        if (a[1].indexOf('data-') === 0) dataset[camel(a[1].slice(5))] = v;
    }
    return { attrs, dataset };
}
/** Every button / input / select / textarea in an HTML string, in document order. */
function elementsIn(html) {
    const out = [];
    const btn = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    const field = /<(input|select|textarea)\b([^>]*)>/g;
    let m;
    while ((m = btn.exec(html))) {
        const { attrs, dataset } = parseAttrs(m[1]);
        out.push({ tag: 'button', attrs, dataset, text: decode(m[2].replace(/<[^>]*>/g, '')), index: m.index });
    }
    while ((m = field.exec(html))) {
        const { attrs, dataset } = parseAttrs(m[2]);
        out.push({ tag: m[1], attrs, dataset, checked: 'checked' in attrs, index: m.index });
    }
    return out.sort((a, b) => a.index - b.index);
}
function matches(el, act, want) {
    if (act && el.dataset.act !== act) return false;
    return Object.keys(want || {}).every((k) => el.dataset[k] === want[k]);
}

/** The editor's sections: [{ name, body }] in the order drawn. */
function editorSections(html) {
    return html.split('<div class="itemsec"><h4>').slice(1).map((chunk) => {
        const i = chunk.indexOf('</h4>');
        return { name: decode(chunk.slice(0, i)), body: chunk.slice(i) };
    });
}
function editorCount(html) {
    const m = /Everything .*? is scored on · (\d+) items/.exec(html);
    return m ? Number(m[1]) : null;
}
/** Staff tab rows: name → { email, jobs, items }. */
function staffRows(html) {
    const out = {};
    const rx = /<tr><td class="name">([^<]*)<\/td><td class="small muted">([^<]*)<\/td><td>([\s\S]*?)<\/td><td class="small">(\d+)<\/td>/g;
    let m;
    while ((m = rx.exec(html))) {
        out[decode(m[1])] = { email: decode(m[2]), jobs: m[3].replace(/<[^>]*>/g, ' ').trim().split(/\s+/), items: Number(m[4]) };
    }
    return out;
}
/** The score buttons drawn for one person/item: their data-v values in order. */
function scoreValues(html, who, cid) {
    return elementsIn(html).filter((e) => matches(e, 'score', { who, c: cid })).map((e) => e.dataset.v);
}
function scoredItemIds(html, who) {
    const ids = [];
    elementsIn(html).filter((e) => matches(e, 'score', { who })).forEach((e) => { if (ids.indexOf(e.dataset.c) < 0) ids.push(e.dataset.c); });
    return ids;
}
function headings(html, tag) {
    const rx = new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'g');
    const out = [];
    let m;
    while ((m = rx.exec(html))) out.push(decode(m[1]));
    return out;
}

// ── Fixtures (the shapes routes/appraisal.js sends) ─────────────────────────────────────────────

const SETUP = Object.assign(clone(DEFAULT_SETUP), { savedAt: '2026-07-01T05:00:00.000Z' });
const BOSS = { email: 'info@dscpipes.com', name: 'Boss', isAdmin: true };

function staffPerson(id, name, email, mgr, self) {
    return { id, name, email, self: self || { reviews: {} }, mgr: Object.assign({ roles: [], extras: [], hidden: [] }, mgr || {}) };
}
function people() {
    return [
        // Accounts was a job once and was removed in Setup; Meena still has an own item filed under it.
        staffPerson('meena', 'Meena', '', { roles: [], extras: [{ id: 'x_old1', name: 'Bank reconciliation', hint: '', section: 'r_accounts' }] }),
        staffPerson('pavithra@dsc.com', 'Pavithra', 'pavithra@dsc.com', { roles: ['r_sales'], targets: 'Rs 40 lakh in orders', profileSavedAt: '2026-10-01T10:00:00.000Z' }),
        staffPerson('ravi@dsc.com', 'Ravi', 'ravi@dsc.com', {
            roles: ['r_sales', 'r_admin'], hidden: ['c_s6'],
            extras: [{ id: 'x_tally1', name: 'Tally entries', hint: 'Same day', section: 'r_admin' }],
            profileSavedAt: '2026-10-02T10:00:00.000Z',
        }),
    ];
}
function adminMe() { return { you: BOSS, hasAdmin: true, testSite: false, setup: clone(SETUP), isStarter: false, mine: null }; }
function overview(extra) {
    return Object.assign({
        you: BOSS, setup: clone(SETUP), isStarter: false, people: people(),
        removed: [{ id: 'old@dsc.com', name: 'Old Hand', email: 'old@dsc.com', removedAt: '2026-09-01T00:00:00.000Z' }],
        reminder: {},
    }, extra || {});
}
function staffMe(mine) {
    return { you: { email: 'pavithra@dsc.com', name: 'Pavithra', isAdmin: false }, hasAdmin: true, testSite: false, setup: clone(SETUP), isStarter: false, mine };
}

// ── The sandbox ─────────────────────────────────────────────────────────────────────────────────

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }

function makeEnv({ me, ov, routes } = {}) {
    const clock = { now: NOW };
    const calls = [];
    const timers = [];
    const handlers = {};
    const focused = [];
    const server = { me: clone(me || adminMe()), overview: clone(ov || overview()), routes: routes || {} };
    let liveLabels = {};   // Remove-button labels the page changed in place since the last render
    let lastButtonSweep = [];

    function makeEl(id, onSet) {
        let html = '';
        return {
            id, textContent: '', hidden: id === 'toast', style: {}, focus() {},
            get innerHTML() { return html; },
            set innerHTML(v) { html = String(v); if (onSet) onSet(); },
        };
    }
    const els = {
        main: makeEl('main', () => { liveLabels = {}; }),
        tabs: makeEl('tabs'), sub: makeEl('sub'), toast: makeEl('toast'),
    };

    function respond(method, url, body) {
        const k = method + ' ' + url;
        if (server.routes[k]) return server.routes[k](body, server);
        if (k === 'GET /api/appraisal/me') return { status: 200, body: server.me };
        if (k === 'GET /api/appraisal/overview') return { status: 200, body: server.overview };
        return { status: 200, body: { ok: true } };
    }
    function fetchStub(url, init) {
        const method = (init && init.method) || 'GET';
        const body = init && init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, url, body });
        return Promise.resolve(respond(method, url, body)).then((r) => ({
            status: r.status, ok: r.status >= 200 && r.status < 300, json: () => Promise.resolve(clone(r.body || {})),
        }));
    }

    const document = {
        querySelector(sel) {
            const m = /^#([\w-]+)$/.exec(sel);
            if (m && els[m[1]]) return els[m[1]];
            return m ? makeEl(m[1]) : null;
        },
        querySelectorAll(sel) {
            if (sel === '#main button') {
                lastButtonSweep = elementsIn(els.main.innerHTML).filter((e) => e.tag === 'button').map((e) => ({ dataset: e.dataset, disabled: 'disabled' in e.attrs }));
                return lastButtonSweep;
            }
            const m = /^\[data-act="([\w-]+)"\]$/.exec(sel);
            if (!m) throw new Error('appraisal-page.js asked for an unexpected selector: ' + sel);
            return elementsIn(els.main.innerHTML).filter((e) => e.dataset.act === m[1]).map((e) => ({
                dataset: e.dataset,
                get textContent() { return e.dataset.v in liveLabels ? liveLabels[e.dataset.v] : e.text; },
                set textContent(t) { liveLabels[e.dataset.v] = t; },
            }));
        },
        getElementById(id) { return { focus() { focused.push(id); } }; },
        addEventListener(type, fn) { handlers[type] = fn; },
    };
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(clock.now); }
        static now() { return clock.now; }
    }
    const ctx = {
        document, fetch: fetchStub, console, Date: FakeDate,
        window: { addEventListener(t, fn) { handlers['window:' + t] = fn; }, scrollTo() {} },
        location: { href: '/appraisal.html' },
        setTimeout(fn, ms) { timers.push({ fn, at: clock.now + (ms || 0), done: false }); return timers.length; },
        clearTimeout(id) { if (timers[id - 1]) timers[id - 1].done = true; },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(PAGE_FILE, 'utf8'), ctx, { filename: 'appraisal-page.js' });

    const env = {
        calls, els, clock, focused, server,
        get html() { return els.main.innerHTML; },
        get tabsHtml() { return els.tabs.innerHTML; },
        get toast() { return els.toast.hidden ? '' : els.toast.textContent; },
        get lastButtonSweep() { return lastButtonSweep; },
        writes() { return calls.filter((c) => c.method !== 'GET'); },
        all(act, want) { return elementsIn(els.tabs.innerHTML + els.main.innerHTML).filter((e) => matches(e, act, want)); },
        find(act, want) {
            const found = env.all(act, want);
            if (found.length !== 1) throw new Error('expected one rendered [data-act="' + act + '"] ' + JSON.stringify(want || {}) + ', found ' + found.length);
            return found[0];
        },
        /** Click a control the page drew. A checkbox flips before the click event, as in a browser. */
        click(act, want) {
            const el = env.find(act, want);
            const b = { dataset: el.dataset, checked: el.tag === 'input' && el.attrs.type === 'checkbox' ? !el.checked : el.checked };
            let prevented = false;
            handlers.click({ target: { closest: (s) => (s === '[data-act]' ? b : null) }, preventDefault() { prevented = true; } });
            return { prevented };
        },
        /** Type into a field the page drew (found by its data-d). */
        type(d, value) {
            const el = elementsIn(els.main.innerHTML).filter((e) => e.dataset.d === d);
            if (el.length !== 1) throw new Error('expected one field with data-d="' + d + '", found ' + el.length);
            handlers.input({ target: { dataset: el[0].dataset, value } });
        },
        removeLabel(id) {
            const btn = env.find('staff-remove', { v: id });
            return id in liveLabels ? liveLabels[id] : btn.text;
        },
        advance(ms) {
            clock.now += ms;
            timers.forEach((t) => { if (!t.done && t.at <= clock.now) { t.done = true; t.fn(); } });
        },
    };
    return env;
}

async function start(opts) {
    const env = makeEnv(opts);
    await flush();
    return env;
}
async function openStaffTab(opts) {
    const env = await start(opts);
    env.click('tab', { v: 'staff' });
    return env;
}
async function editPerson(id, opts) {
    const env = await openStaffTab(opts);
    env.click('p-edit', { v: id });
    return env;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('manager view: first load', () => {
    test('reads /me then /overview, writes nothing, and opens on Quarterly reviews', async () => {
        const env = await start();
        expect(env.calls.map((c) => c.method + ' ' + c.url)).toEqual(['GET /api/appraisal/me', 'GET /api/appraisal/overview']);
        expect(env.els.sub.textContent).toBe('Manager view · Signed in as Boss');
        expect(env.all('tab').map((t) => t.text)).toEqual(['Quarterly reviews', '6-month meetings', 'Staff', 'Setup']);
        expect(env.find('tab', { v: 'reviews' }).attrs['aria-selected']).toBe('true');
        expect(env.html).toContain('<strong>0 of 3</strong> forms in');
    });
});

describe('Quarterly reviews: the daily reminder email line', () => {
    const FAILED = 'The daily reminder email failed on';
    const SENT = 'Daily reminder: last emailed to info@dscpipes.com on';
    // Times are 10:00 UTC so the page's local date reads "15 Oct" from UTC−10 to UTC+13.

    test('a failure newer than the last send shows the red line, with the reason, and no "last emailed"', async () => {
        const env = await start({ ov: overview({ reminder: { lastSentAt: '2026-10-14T10:00:00.000Z', lastFailedAt: '2026-10-15T10:00:00.000Z', lastError: 'Gmail said <no>' } }) });
        expect(env.html).toContain('<div class="error">The daily reminder email failed on 15 Oct: Gmail said &lt;no&gt;. It will try again tomorrow at 9 am.</div>');
        expect(env.html).not.toContain(SENT);
    });

    test('a failure older than the last send shows only the muted "last emailed" line', async () => {
        const env = await start({ ov: overview({ reminder: { lastSentAt: '2026-10-15T10:00:00.000Z', lastFailedAt: '2026-10-14T10:00:00.000Z', lastError: 'old trouble' } }) });
        expect(env.html).toContain('<p class="small muted">Daily reminder: last emailed to info@dscpipes.com on 15 Oct.</p>');
        expect(env.html).not.toContain(FAILED);
        expect(env.html).not.toContain('old trouble');
    });

    test('a failure with no send ever is still shown red', async () => {
        const env = await start({ ov: overview({ reminder: { lastFailedAt: '2026-10-15T10:00:00.000Z', lastError: 'Not signed in to Gmail' } }) });
        expect(env.html).toContain(FAILED + ' 15 Oct: Not signed in to Gmail.');
        expect(env.html).not.toContain(SENT);
    });

    test('nothing sent or failed yet shows neither line', async () => {
        const env = await start();
        expect(env.html).toContain('forms in');   // the page did render
        expect(env.html).not.toContain(FAILED);
        expect(env.html).not.toContain(SENT);
    });
});

describe('Staff tab', () => {
    test('lists each person with their item count: jobs + own items − items removed for them', async () => {
        const env = await openStaffTab();
        const rows = staffRows(env.html);
        // Meena: no job, 5 Behaviour + 1 own item (under a job since removed) = 6.
        // Pavithra: Sales 6 + Behaviour 5 = 11.
        // Ravi: Sales 6 − 1 removed for him + Administration 3 + 1 own + Behaviour 5 = 14.
        expect(Object.keys(rows)).toEqual(['Meena', 'Pavithra', 'Ravi']);
        expect(rows.Meena.items).toBe(6);
        expect(rows.Pavithra.items).toBe(11);
        expect(rows.Ravi.items).toBe(14);
        expect(rows.Ravi.jobs).toEqual(['Sales', 'Administration']);
        expect(rows.Meena.jobs).toEqual(['None']);
        expect(env.html).toContain('Removed staff (1)');
        expect(env.find('staff-restore', { v: 'old@dsc.com' }).text).toBe('Bring back');
    });
});

describe('Edit: one person\'s full list', () => {
    test('headings follow Setup order — Sales before Administration — even after unticking and reticking Sales', async () => {
        const env = await editPerson('ravi@dsc.com');
        expect(editorSections(env.html).map((s) => s.name)).toEqual(['Sales', 'Administration', 'Behaviour']);
        expect(editorCount(env.html)).toBe(14);

        env.click('p-role', { v: 'r_sales' });   // untick
        expect(env.find('p-role', { v: 'r_sales' }).checked).toBe(false);
        expect(editorSections(env.html).map((s) => s.name)).toEqual(['Administration', 'Behaviour']);
        expect(editorCount(env.html)).toBe(9);

        env.click('p-role', { v: 'r_sales' });   // tick again: now last in his roles list
        expect(editorSections(env.html).map((s) => s.name)).toEqual(['Sales', 'Administration', 'Behaviour']);
        expect(editorCount(env.html)).toBe(14);
    });

    test('every shared item is listed under its heading; shared items get Remove, own items do not', async () => {
        const env = await editPerson('ravi@dsc.com');
        const secs = editorSections(env.html);
        const ids = (body, act) => elementsIn(body).filter((e) => e.dataset.act === act).map((e) => e.dataset.v);
        expect(ids(secs[0].body, 'p-hide')).toEqual(['c_s1', 'c_s2', 'c_s3', 'c_s4', 'c_s5']);
        expect(ids(secs[0].body, 'p-unhide')).toEqual(['c_s6']);
        expect(ids(secs[1].body, 'p-hide')).toEqual(['c_d5', 'c_d6', 'c_d7']);
        expect(secs[2].body).toContain('Attendance and punctuality');
        expect(ids(secs[2].body, 'p-hide')).toEqual(['c_b1', 'c_b2', 'c_b3', 'c_b4', 'c_p1']);
        // His own item sits under Administration, editable, with its own Remove (p-del-extra), not p-hide.
        const own = elementsIn(secs[1].body).filter((e) => e.dataset.d === 'person:extras.0.name');
        expect(own.map((e) => e.attrs.value)).toEqual(['Tally entries']);
        expect(elementsIn(secs[1].body).filter((e) => e.dataset.act === 'p-del-extra').length).toBe(1);
        expect(env.all('p-hide', { v: 'x_tally1' })).toHaveLength(0);
    });

    test('a removed-for-them item shows Put back and drops the count; Remove and Put back move it both ways', async () => {
        const env = await editPerson('ravi@dsc.com');
        expect(env.html).toMatch(/Keeping in touch <span class="chip">Removed for them<\/span>/);
        expect(env.find('p-unhide', { v: 'c_s6' }).text).toBe('Put back');
        expect(env.find('p-hide', { v: 'c_s1' }).text).toBe('Remove');

        env.click('p-hide', { v: 'c_s1' });
        expect(editorCount(env.html)).toBe(13);
        expect(env.all('p-hide', { v: 'c_s1' })).toHaveLength(0);
        expect(env.find('p-unhide', { v: 'c_s1' }).text).toBe('Put back');

        env.click('p-unhide', { v: 'c_s6' });
        expect(editorCount(env.html)).toBe(14);
        expect(env.find('p-hide', { v: 'c_s6' }).text).toBe('Remove');

        env.click('p-save'); await flush();
        const put = env.writes();
        expect(put).toHaveLength(1);
        expect(put[0].body.hidden).toEqual(['c_s1']);
    });

    test('+ Add an item under a heading adds an own item there, focused, and Save sends it under that heading', async () => {
        const env = await editPerson('pavithra@dsc.com');
        expect(env.all('p-add-extra').map((e) => [e.dataset.v, e.text])).toEqual([
            ['r_sales', '+ Add an item under Sales'], ['behaviour', '+ Add an item under Behaviour'],
        ]);
        env.click('p-add-extra', { v: 'r_sales' });
        expect(editorCount(env.html)).toBe(12);
        const secs = editorSections(env.html);
        expect(secs.map((s) => s.name)).toEqual(['Sales', 'Behaviour']);
        expect(elementsIn(secs[0].body).some((e) => e.dataset.d === 'person:extras.0.name')).toBe(true);
        expect(elementsIn(secs[1].body).some((e) => e.dataset.d === 'person:extras.0.name')).toBe(false);
        expect(env.focused).toEqual(['px-0-n']);

        env.type('person:extras.0.name', 'Site visits');
        env.click('p-save'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/profile/pavithra%40dsc.com']);
        expect(w[0].body.extras).toHaveLength(1);
        expect(w[0].body.extras[0]).toMatchObject({ name: 'Site visits', hint: '', section: 'r_sales' });
        expect(w[0].body.extras[0].id).toMatch(/^x_[a-z0-9]+$/);
    });
});

describe('Edit: Save', () => {
    test('a blank own-item name is refused with no request', async () => {
        const env = await editPerson('pavithra@dsc.com');
        env.click('p-add-extra', { v: 'behaviour' });
        env.click('p-save'); await flush();
        expect(env.toast).toBe('One of their own items has no name. Type a name or remove it.');
        expect(env.writes()).toEqual([]);
        env.type('person:extras.0.name', '   ');
        env.click('p-save'); await flush();
        expect(env.writes()).toEqual([]);
        expect(env.find('p-save').text).toBe('Save');   // the panel is still open
    });

    test('an own item under a job removed in Setup is refused until it is moved; then it saves under the new heading', async () => {
        const env = await editPerson('meena');
        const secs = editorSections(env.html);
        expect(secs.map((s) => s.name)).toEqual(['Job removed in Setup', 'Behaviour']);
        expect(secs[0].body).toContain('value="Bank reconciliation"');
        expect(elementsIn(secs[0].body).some((e) => e.dataset.d === 'person:extras.0.section' && e.tag === 'select')).toBe(true);
        expect(secs[0].body).not.toContain('+ Add an item under');

        env.click('p-save'); await flush();
        expect(env.toast).toBe('Move or remove the items under "Job removed in Setup" first.');
        expect(env.writes()).toEqual([]);

        env.type('person:extras.0.section', 'behaviour');
        env.click('p-save'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/profile/meena']);
        expect(w[0].body.extras).toEqual([{ id: 'x_old1', name: 'Bank reconciliation', hint: '', section: 'behaviour' }]);
    });

    test('sends roles, targets, extras, hidden and the version it started from — and no staff PUT when name/email are unchanged', async () => {
        const env = await editPerson('pavithra@dsc.com');
        env.type('person:targets', 'Rs 50 lakh in orders');
        env.type('person:email', ' Pavithra@DSC.com ');   // same email, different case and spaces
        env.click('p-role', { v: 'r_admin' });
        env.click('p-hide', { v: 'c_s2' });
        env.click('p-save'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/profile/pavithra%40dsc.com']);
        expect(w[0].body).toEqual({
            roles: ['r_sales', 'r_admin'], targets: 'Rs 50 lakh in orders', extras: [], hidden: ['c_s2'],
            baseSavedAt: '2026-10-01T10:00:00.000Z',
        });
        expect(env.toast).toBe('Saved');
        expect(env.all('p-save')).toHaveLength(0);          // panel closed after the save
        expect(env.calls.slice(-2).map((c) => c.url)).toEqual(['/api/appraisal/me', '/api/appraisal/overview']);
    });

    test('a changed name goes to the staff PUT first, then the profile PUT', async () => {
        const env = await editPerson('pavithra@dsc.com');
        env.type('person:name', 'Pavithra R');
        env.click('p-save'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/staff/pavithra%40dsc.com', 'PUT /api/appraisal/profile/pavithra%40dsc.com']);
        expect(w[0].body).toEqual({ name: 'Pavithra R', email: 'pavithra@dsc.com' });
    });

    test('if the staff PUT is refused, the profile is not sent and the panel stays open with the edits', async () => {
        const env = await editPerson('pavithra@dsc.com', {
            routes: { 'PUT /api/appraisal/staff/pavithra%40dsc.com': () => ({ status: 409, body: { error: 'Ravi already signs in with that email.' } }) },
        });
        env.type('person:email', 'ravi@dsc.com');
        env.click('p-save'); await flush();
        expect(env.writes().map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/staff/pavithra%40dsc.com']);
        expect(env.toast).toBe('Ravi already signs in with that email.');
        expect(env.find('p-save').text).toBe('Save');
        expect(env.lastButtonSweep.every((b) => !b.disabled)).toBe(true);   // unlocked again
        // The edits are still in the panel: saving again (now accepted) sends the same email.
        delete env.server.routes['PUT /api/appraisal/staff/pavithra%40dsc.com'];
        env.click('p-save'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual([
            'PUT /api/appraisal/staff/pavithra%40dsc.com', 'PUT /api/appraisal/staff/pavithra%40dsc.com', 'PUT /api/appraisal/profile/pavithra%40dsc.com',
        ]);
        expect(w[1].body).toEqual({ name: 'Pavithra', email: 'ravi@dsc.com' });
    });
});

describe('Remove a staff member', () => {
    test('needs two separate clicks: a second click within 400 ms does nothing', async () => {
        const env = await openStaffTab();
        env.click('staff-remove', { v: 'meena' }); await flush();
        expect(env.writes()).toEqual([]);
        expect(env.removeLabel('meena')).toBe('Click again to remove');

        env.advance(200);
        env.click('staff-remove', { v: 'meena' }); await flush();       // the second half of a double-click
        expect(env.writes()).toEqual([]);

        env.advance(300);                                // 500 ms after arming: a real second click
        env.click('staff-remove', { v: 'meena' }); await flush();
        expect(env.writes().map((c) => c.method + ' ' + c.url)).toEqual(['DELETE /api/appraisal/staff/meena']);
        await flush();
        expect(env.toast).toBe('Meena removed. Their past scores are kept under Removed staff.');
    });

    test('is disarmed after 4 seconds: a click then arms it again instead of removing', async () => {
        const env = await openStaffTab();
        env.click('staff-remove', { v: 'meena' }); await flush();
        env.advance(4000);
        expect(env.removeLabel('meena')).toBe('Remove');
        env.advance(100);
        env.click('staff-remove', { v: 'meena' }); await flush();
        expect(env.writes()).toEqual([]);
        expect(env.removeLabel('meena')).toBe('Click again to remove');
    });

    test('arming one person disarms another, so a click on the first again does not remove', async () => {
        const env = await openStaffTab();
        env.click('staff-remove', { v: 'meena' }); await flush();
        env.advance(600);
        env.click('staff-remove', { v: 'ravi@dsc.com' }); await flush();
        expect(env.removeLabel('meena')).toBe('Remove');
        env.advance(600);
        env.click('staff-remove', { v: 'meena' }); await flush();
        expect(env.writes()).toEqual([]);
    });

    test('is refused while an Edit panel is open', async () => {
        const env = await editPerson('pavithra@dsc.com');
        env.click('staff-remove', { v: 'meena' }); await flush();
        env.advance(600);
        env.click('staff-remove', { v: 'meena' }); await flush();
        expect(env.toast).toBe('Save or cancel the open Edit panel first.');
        expect(env.writes()).toEqual([]);
        env.click('staff-restore', { v: 'old@dsc.com' }); await flush();
        expect(env.writes()).toEqual([]);
    });
});

describe('Add staff', () => {
    test('a blank name is refused with no request', async () => {
        const env = await openStaffTab();
        env.click('staff-add'); await flush();
        expect(env.toast).toBe('Type a name first.');
        expect(env.writes()).toEqual([]);
    });

    test('a double click sends one POST: the page locks while it is in flight, then clears the inputs', async () => {
        const gate = deferred();
        const env = await openStaffTab({
            routes: {
                'POST /api/appraisal/staff': (body, server) => gate.promise.then(() => {
                    server.overview.people.push(staffPerson('kiran@dsc.com', body.name, body.email, {}));
                    return { status: 200, body: { ok: true, staff: { id: 'kiran@dsc.com', name: body.name, email: body.email } } };
                }),
            },
        });
        env.type('newstaff:name', 'Kiran');
        env.type('newstaff:email', 'kiran@dsc.com');
        env.click('staff-add');
        const second = env.click('staff-add');
        expect(second.prevented).toBe(true);
        expect(env.writes()).toEqual([{ method: 'POST', url: '/api/appraisal/staff', body: { name: 'Kiran', email: 'kiran@dsc.com' } }]);
        expect(env.lastButtonSweep.length).toBeGreaterThan(0);
        expect(env.lastButtonSweep.every((b) => b.disabled)).toBe(true);

        gate.resolve();
        await flush();
        expect(env.toast).toBe('Kiran added');
        expect(env.writes()).toHaveLength(1);
        expect(env.find(null, { d: 'newstaff:name' }).attrs.value).toBe('');
        expect(env.find(null, { d: 'newstaff:email' }).attrs.value).toBe('');
        expect(staffRows(env.html).Kiran.items).toBe(5);
        // A third click, with the cleared name: the lock is off again after a successful save (not
        // stuck swallowing every click), so it reaches the blank-name check — and sends nothing.
        const third = env.click('staff-add'); await flush();
        expect(third.prevented).toBe(false);
        expect(env.toast).toBe('Type a name first.');
        expect(env.writes()).toHaveLength(1);
    });

    test('a refused POST says why and unlocks, so it can be tried again', async () => {
        let n = 0;
        const env = await openStaffTab({
            routes: { 'POST /api/appraisal/staff': () => (++n === 1 ? { status: 409, body: { error: 'Old Hand had that email and was removed.' } } : { status: 200, body: { ok: true, staff: { name: 'Old Hand' } } }) },
        });
        env.type('newstaff:name', 'Old Hand');
        env.type('newstaff:email', 'old@dsc.com');
        env.click('staff-add'); await flush();
        expect(env.toast).toBe('Old Hand had that email and was removed.');
        expect(env.lastButtonSweep.every((b) => !b.disabled)).toBe(true);
        expect(env.click('staff-add').prevented).toBe(false);
        expect(env.writes()).toHaveLength(2);
    });
});

describe('Scoring: ten buttons per item', () => {
    test('the manager\'s review of one person draws 1–10 for every item they are scored on, and nothing else', async () => {
        const env = await start();
        env.click('open-review', { v: 'pavithra@dsc.com' });
        const expected = ['c_s1', 'c_s2', 'c_s3', 'c_s4', 'c_s5', 'c_s6', 'c_b1', 'c_b2', 'c_b3', 'c_b4', 'c_p1'];
        expect(scoredItemIds(env.html, 'mgr')).toEqual(expected);
        expected.forEach((id) => expect(scoreValues(env.html, 'mgr', id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']));

        env.click('score', { who: 'mgr', c: 'c_s1', v: '7' });
        const pressed = env.all('score', { who: 'mgr', c: 'c_s1' }).filter((e) => e.attrs['aria-pressed'] === 'true').map((e) => e.dataset.v);
        expect(pressed).toEqual(['7']);
        env.click('done-review'); await flush();
        expect(env.toast).toBe('Score every item first. 10 still to score.');
        expect(env.writes()).toEqual([]);
    });

    test('a staff member\'s own form: their job and Behaviour, minus items removed for them, plus their own, 1–10 each', async () => {
        const mine = {
            roles: ['r_sales'], hidden: ['c_s3'], targets: '5 new customers', reviews: {}, lockedQuarters: [],
            extras: [{ id: 'x_beh1', name: 'Keeps the yard tidy', hint: '', section: 'behaviour' }],
        };
        const env = await start({ me: staffMe(mine) });
        expect(env.calls.map((c) => c.url)).toEqual(['/api/appraisal/me']);
        expect(env.all('tab').map((t) => t.text)).toEqual(['My review', 'How scoring works']);
        expect(headings(env.html, 'h3')).toEqual(['Sales', 'Behaviour']);
        expect(env.html).toContain('Keeps the yard tidy <span class="chip info">Only for you</span>');
        const expected = ['c_s1', 'c_s2', 'c_s4', 'c_s5', 'c_s6', 'c_b1', 'c_b2', 'c_b3', 'c_b4', 'c_p1', 'x_beh1'];
        expect(scoredItemIds(env.html, 'self')).toEqual(expected);
        expected.forEach((id) => expect(scoreValues(env.html, 'self', id)).toHaveLength(10));

        env.click('submit-self'); await flush();
        expect(env.toast).toBe('Score every item first. 11 still to score.');
        expect(env.writes()).toEqual([]);

        expected.forEach((id) => env.click('score', { who: 'self', c: id, v: '8' }));
        env.click('submit-self'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/self/' + PREV_Q]);
        expect(Object.keys(w[0].body.review.scores).sort()).toEqual(expected.slice().sort());
        expect(w[0].body.baseSavedAt).toBeNull();
    });

    test('the manager\'s Save & mark done sends every score, done, and the version it opened — and drops a self-review typed in then unticked', async () => {
        const started = { scores: { c_s1: 6 }, notes: { c_s1: 'Good month' }, comment: 'Steady', done: false, savedAt: '2026-10-10T10:00:00.000Z' };
        const ps = people();
        ps[1].mgr.reviews = { [PREV_Q]: started };
        const env = await start({ ov: overview({ people: ps }) });
        expect(env.html).toContain('<span class="chip wait">Started</span>');
        env.click('open-review', { v: 'pavithra@dsc.com' });
        const pressed = env.all('score', { who: 'mgr', c: 'c_s1' }).filter((e) => e.attrs['aria-pressed'] === 'true').map((e) => e.dataset.v);
        expect(pressed).toEqual(['6']);

        // Start typing in their paper form, then change mind: none of it may be saved as their self-review.
        env.click('type-self');
        env.click('score', { who: 'selfm', c: 'c_s1', v: '3' });
        env.click('type-self');
        expect(env.all('score', { who: 'selfm' })).toHaveLength(0);

        const ids = scoredItemIds(env.html, 'mgr');
        expect(ids).toHaveLength(11);
        ids.forEach((id) => env.click('score', { who: 'mgr', c: id, v: '8' }));
        env.click('done-review'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/review/pavithra%40dsc.com/' + PREV_Q]);
        expect(w[0].body.baseSavedAt).toBe('2026-10-10T10:00:00.000Z');
        const review = w[0].body.review;
        expect(review.scores).toEqual(Object.fromEntries(ids.map((id) => [id, 8])));
        expect(review).toMatchObject({ notes: { c_s1: 'Good month' }, comment: 'Steady', done: true });
        expect(review).not.toHaveProperty('selfByMgr');
        expect(review).not.toHaveProperty('base');
        expect(review).not.toHaveProperty('typeSelf');
        expect(env.toast).toBe('Review saved and marked done');
        expect(env.all('done-review')).toHaveLength(0);    // back on the list
    });
});

describe('Staff view: a form already in', () => {
    const SUBMITTED = '2026-10-05T10:00:00.000Z';
    const SALES_AND_BEHAVIOUR = ['c_s1', 'c_s2', 'c_s3', 'c_s4', 'c_s5', 'c_s6', 'c_b1', 'c_b2', 'c_b3', 'c_b4', 'c_p1'];
    function submittedMine(lockedQuarters) {
        return {
            roles: ['r_sales'], hidden: [], extras: [], targets: '', lockedQuarters,
            reviews: { [PREV_Q]: { scores: Object.fromEntries(SALES_AND_BEHAVIOUR.map((id) => [id, 7])), notes: {}, wins: 'Big order', help: '', submittedAt: SUBMITTED, savedAt: SUBMITTED } },
        };
    }

    test('updating a submitted form sends the version it was opened at, so a stale copy is refused', async () => {
        const env = await start({ me: staffMe(submittedMine([])) });
        expect(env.html).toContain('<span class="chip ok">Submitted 5 Oct</span>');
        expect(env.find('submit-self').text).toBe('Update my form');
        env.click('score', { who: 'self', c: 'c_s1', v: '9' });
        env.click('submit-self'); await flush();
        const w = env.writes();
        expect(w.map((c) => c.method + ' ' + c.url)).toEqual(['PUT /api/appraisal/self/' + PREV_Q]);
        expect(w[0].body.baseSavedAt).toBe(SUBMITTED);
        expect(w[0].body.review.scores.c_s1).toBe(9);
        expect(w[0].body.review.scores.c_s2).toBe(7);
        expect(w[0].body.review.wins).toBe('Big order');
        expect(env.toast).toBe('Your form is submitted');
    });

    test('a quarter the manager has finished is locked: every score button disabled, no submit button', async () => {
        const env = await start({ me: staffMe(submittedMine([PREV_Q])) });
        expect(env.html).toContain('<span class="chip info">Reviewed by your manager</span>');
        const buttons = env.all('score', { who: 'self' });
        expect(buttons).toHaveLength(110);
        expect(buttons.every((b) => 'disabled' in b.attrs)).toBe(true);
        expect(env.all('submit-self')).toHaveLength(0);
    });
});

describe('Names are shown as text, never as markup', () => {
    test('a name with < & > is escaped on Quarterly reviews, the Staff tab and the Edit panel', async () => {
        const NAME = 'Ali <b>& Sons</b>';
        const SAFE = 'Ali &lt;b&gt;&amp; Sons&lt;/b&gt;';
        const env = await start({ ov: overview({ people: [staffPerson('s-0a1b2c3d4e5f', NAME, '', {})] }) });
        expect(env.html).toContain('<td class="name">' + SAFE + '</td>');
        expect(env.html).not.toContain('<b>');
        env.click('tab', { v: 'staff' });
        expect(staffRows(env.html)[NAME].items).toBe(5);
        expect(env.html).not.toContain('<b>');
        env.click('p-edit', { v: 's-0a1b2c3d4e5f' });
        expect(env.html).toContain('<h3>' + SAFE + '</h3>');
        expect(env.html).not.toContain('<b>');
    });
});

describe('Staff view: not on the list, and failed loads', () => {
    test('a staff member with mine:null sees "not on the staff list yet" and nothing else is fetched', async () => {
        const env = await start({ me: staffMe(null) });
        expect(env.calls.map((c) => c.method + ' ' + c.url)).toEqual(['GET /api/appraisal/me']);
        expect(env.html).toContain('<h3>You are not on the staff list yet</h3>');
        expect(env.html).toContain('Ask your manager to add you on the Staff tab');
        expect(env.all('score')).toHaveLength(0);
        expect(env.all('submit-self')).toHaveLength(0);
    });

    test('with no admin on the People page the form says it is not set up yet', async () => {
        const env = await start({ me: Object.assign(staffMe(null), { hasAdmin: false }) });
        expect(env.html).toContain('<h3>Not set up yet</h3>');
        expect(env.html).not.toContain('not on the staff list yet');
    });

    test('a failed /overview reads as a failure, never as "No staff yet"', async () => {
        const env = await start({ routes: { 'GET /api/appraisal/overview': () => ({ status: 500, body: { error: 'Storage is not answering.' } }) } });
        expect(env.html).toContain('Could not load the appraisal: Storage is not answering.');
        expect(env.find('reload').text).toBe('Try again');
        expect(env.html).not.toContain('No staff yet');
        expect(env.tabsHtml).toBe('');
    });
});

describe('source guards: appraisal.html and serving the script', () => {
    const html = fs.readFileSync(HTML_FILE, 'utf8');

    test('appraisal.html loads appraisal-page.js once, with a ?v= cache-buster', () => {
        const tags = html.match(/<script\b[^>]*\bsrc="[^"]*appraisal-page\.js[^"]*"[^>]*>/g) || [];
        expect(tags).toHaveLength(1);
        expect(tags[0]).toMatch(/src="\/appraisal-page\.js\?v=\d+"/);
    });

    test('appraisal.html has the containers the script draws into', () => {
        ['main', 'tabs', 'sub'].forEach((id) => expect(html).toMatch(new RegExp('<[a-z]+\\b[^>]*\\bid="' + id + '"')));
        expect(html).toMatch(/<div class="toast" id="toast" hidden><\/div>/);
    });

    test('server.js serves appraisal.html and appraisal-page.js (signed-in only, not public)', () => {
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const line = (/const SERVABLE_ROOT_FILES = new Set\(\[([^\]]*)\]\)/.exec(server) || [])[1] || '';
        expect(line).toContain("'/appraisal.html'");
        expect(line).toContain("'/appraisal-page.js'");
        const { PUBLIC_FILES } = require('../utils/auth');
        expect(PUBLIC_FILES.has('/appraisal-page.js')).toBe(false);
        expect(PUBLIC_FILES.has('/appraisal.html')).toBe(false);
    });
});
