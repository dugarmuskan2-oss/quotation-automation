/**
 * @jest-environment node
 *
 * The account circle (account-badge.js): the signed-in person's letters top right on every app
 * page, with Log out. The browser file is run for real in a Node vm with a small stub page
 * (jsdom isn't installed). Plus the POST /api/logout?go=login redirect it relies on, and guards on
 * the four pages that load it.
 *
 * The rule that matters most: logging out must not strand unsaved work. The circle asks the page's
 * own leave-guards first (they all call preventDefault on beforeunload), warns once, and logs out
 * with a real form submit so the browser's "Leave site?" box comes BEFORE the session ends.
 */

jest.mock('../utils/gmail', () => ({ sendEmail: jest.fn(async () => ({ id: 'sent-1' })) }));

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('account-badge.js');

// ── A small stub page ────────────────────────────────────────────────────────

/** A stand-in element: remembers what is set on it and hands out one stand-in child per selector. */
function fakeEl(tag) {
    const children = {};
    const listeners = {};
    return {
        tagName: String(tag || 'div').toUpperCase(), className: '', id: '', innerHTML: '', textContent: '',
        hidden: false, disabled: false, style: {}, attrs: {}, listeners,
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k]; },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        querySelector(sel) { return children[sel] || (children[sel] = fakeEl('child')); },
        contains(x) { return x === this || Object.values(children).includes(x); },
        focus() {}, submit: jest.fn(), remove: jest.fn(),
    };
}

function fakeDocument() {
    const doc = {
        readyState: 'complete', appended: [], styles: [], listeners: {},
        head: { appendChild(el) { doc.styles.push(el); } },
        body: { appendChild(el) { doc.appended.push(el); } },
        createElement: (tag) => fakeEl(tag),
        getElementById(id) {
            return doc.appended.find((e) => e.id === id) || doc.styles.find((e) => e.id === id) || null;
        },
        addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    };
    return doc;
}

/** Run account-badge.js in a sandbox whose /api/me answers `me` (or a function giving the reply). */
async function loadBadge(me) {
    const document = fakeDocument();
    const fetchCalls = [];
    const window = {
        fetch: jest.fn(async (url, opts) => {
            fetchCalls.push(url);
            const reply = typeof me === 'function' ? me(url, opts) : { ok: true, json: async () => me };
            return reply;
        }),
    };
    const ctx = { window, document, console, setTimeout, clearTimeout };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { AB: ctx.window.AccountBadge, document, window, fetchCalls };
}

let AB;
beforeAll(async () => { ({ AB } = await loadBadge({ signedIn: false })); });

// ── Letters ──────────────────────────────────────────────────────────────────

describe('initialsOf — the letters in the circle', () => {
    test.each([
        ['Dhanesh Dugar', 'DD'],
        ['Dhanesh Kumar Dugar', 'DD'],          // first and LAST word, not the first two
        ['Kavitha', 'KA'],                       // one word → its first two letters
        ['kavitha', 'KA'],                       // always capitals
        ['R. Kumar', 'RK'],                      // punctuation dropped
        ['  Ravi   Kumar  ', 'RK'],              // extra spaces
        ['A', 'A'],
        ['Ñandú Pérez', 'ÑP'],                   // letters outside A–Z count as letters
        ['李 小龙', '李小'],
    ])('%s → %s', (name, letters) => {
        expect(AB.initialsOf(name)).toBe(letters);
    });

    test('a name that is only an email uses the part before the @', () => {
        expect(AB.initialsOf('ravi.kumar@dscpipes.com')).toBe('RK');
        expect(AB.initialsOf('info@dscpipes.com')).toBe('IN');
    });

    test('nothing usable gives no letters (the circle then shows "?")', () => {
        expect(AB.initialsOf('')).toBe('');
        expect(AB.initialsOf(null)).toBe('');
        expect(AB.initialsOf('   ')).toBe('');
        expect(AB.initialsOf('...')).toBe('');
    });
});

// ── Who is signed in ─────────────────────────────────────────────────────────

describe('accountFrom — reading /api/me', () => {
    test('nobody signed in → no circle at all', () => {
        expect(AB.accountFrom(null)).toBeNull();
        expect(AB.accountFrom({ signedIn: false, who: 'Dhanesh Dugar', email: 'd@x.com' })).toBeNull();
    });

    test('a person: their name and email', () => {
        expect(AB.accountFrom({ signedIn: true, who: 'Dhanesh Dugar', email: 'd@x.com' }))
            .toEqual({ shared: false, name: 'Dhanesh Dugar', email: 'd@x.com' });
    });

    test('the shared password: no name, so "Shared login" and an icon', () => {
        expect(AB.accountFrom({ signedIn: true, who: 'shared', email: null }))
            .toEqual({ shared: true, name: 'Shared login', email: '' });
    });

    test('someone actually named "shared" who has an email is a person, not the shared login', () => {
        expect(AB.accountFrom({ signedIn: true, who: 'shared', email: 's@x.com' }).shared).toBe(false);
    });

    test('a person with no name falls back to their email', () => {
        expect(AB.accountFrom({ signedIn: true, who: null, email: 'ravi@x.com' }).name).toBe('ravi@x.com');
    });
});

describe('badgeHtml — what is drawn', () => {
    test('letters in the circle, name and email in the box, a Log out button, the warning hidden', () => {
        const html = AB.badgeHtml({ shared: false, name: 'Dhanesh Dugar', email: 'd@x.com' });
        expect(html).toMatch(/class="acct-btn"[^>]*>DD<\/button>/);
        expect(html).toContain('<div class="acct-name">Dhanesh Dugar</div>');
        expect(html).toContain('<div class="acct-email">d@x.com</div>');
        expect(html).toMatch(/<div class="acct-warn"[^>]*hidden>/);
        expect(html).toMatch(/<button type="button" class="acct-out">Log out<\/button>/);
    });

    test('the shared login gets the person icon and no letters', () => {
        const html = AB.badgeHtml({ shared: true, name: 'Shared login', email: '' });
        expect(html).toMatch(/class="acct-btn shared"[^>]*><svg/);
        expect(html).not.toContain('acct-email');
    });

    test('a name that is HTML is shown as text, never run', () => {
        const html = AB.badgeHtml({ shared: false, name: '<img src=x onerror=alert(1)>', email: '"><script>x</script>' });
        expect(html).not.toMatch(/<img|<script/);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });
});

// ── Showing it, or not ───────────────────────────────────────────────────────

describe('start — only for someone signed in', () => {
    test('signed in: one circle with their letters is added to the page', async () => {
        const { document } = await loadBadge({ signedIn: true, who: 'Dhanesh Dugar', email: 'd@x.com' });
        expect(document.appended).toHaveLength(1);
        expect(document.appended[0].id).toBe('acct-badge');
        expect(document.appended[0].innerHTML).toContain('>DD</button>');
        expect(document.styles).toHaveLength(1);
    });

    test('a customer opening a shared quote link (not signed in): nothing is added', async () => {
        const { document, fetchCalls } = await loadBadge({ signedIn: false });
        expect(fetchCalls).toEqual(['/api/me']);
        expect(document.appended).toHaveLength(0);
        expect(document.styles).toHaveLength(0);
    });

    test('/api/me failing or unreachable: no circle, and no error that breaks the page', async () => {
        const failed = await loadBadge(() => ({ ok: false, json: async () => ({ signedIn: true, who: 'X Y' }) }));
        expect(failed.document.appended).toHaveLength(0);
        const down = await loadBadge(() => { throw new Error('offline'); });
        expect(down.document.appended).toHaveLength(0);
    });

    test('starting twice never draws two circles', async () => {
        const { AB: ab, document, window } = await loadBadge({ signedIn: true, who: 'Kavitha', email: 'k@x.com' });
        await ab.start(document, window);
        expect(document.appended).toHaveLength(1);
        expect(document.appended[0].innerHTML).toContain('>KA</button>');
    });

    test('opening the circle sets aria-expanded; closing it puts the Log out button back', async () => {
        const { document } = await loadBadge({ signedIn: true, who: 'Dhanesh Dugar', email: 'd@x.com' });
        const wrap = document.appended[0];
        const btn = wrap.querySelector('.acct-btn'), menu = wrap.querySelector('.acct-menu');
        menu.hidden = true;
        btn.listeners.click[0]({ stopPropagation() {} });
        expect(menu.hidden).toBe(false);
        expect(btn.attrs['aria-expanded']).toBe('true');
        const out = wrap.querySelector('.acct-out');
        out.textContent = 'Log out anyway';
        btn.listeners.click[0]({ stopPropagation() {} });
        expect(menu.hidden).toBe(true);
        expect(out.textContent).toBe('Log out');
        expect(btn.attrs['aria-expanded']).toBe('false');
    });
});

// ── Unsaved work ─────────────────────────────────────────────────────────────

describe('pageHasUnsavedWork — asking the page\'s own leave-guards', () => {
    function win() { const w = new EventTarget(); w.Event = Event; return w; }

    test('no guard, or a guard with nothing unsaved → false', () => {
        expect(AB.pageHasUnsavedWork(win())).toBe(false);
        const w = win();
        w.addEventListener('beforeunload', () => {});
        expect(AB.pageHasUnsavedWork(w)).toBe(false);
    });

    test('a guard that calls preventDefault (unsaved work) → true', () => {
        const w = win();
        w.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
        expect(AB.pageHasUnsavedWork(w)).toBe(true);
    });

    test('every page guard it relies on really works that way (preventDefault on beforeunload)', () => {
        const guards = [
            [read('index.html'), /addEventListener\('beforeunload', function\(e\) \{[\s\S]{0,900}?e\.preventDefault\(\)/],
            [read('appraisal-page.js'), /addEventListener\('beforeunload', function \(e\) \{ if \(S\.dirty\) \{ e\.preventDefault\(\)/],
            [read('price-list.js'), /addEventListener\('beforeunload', function \(e\) \{ if \(state\.dirty\) \{ e\.preventDefault\(\)/],
        ];
        for (const [text, rx] of guards) expect(text).toMatch(rx);
    });
});

describe('Log out — never strands unsaved work, never runs twice', () => {
    function setup(unsaved) {
        const w = new EventTarget();
        w.Event = Event;
        const timers = [];
        w.setTimeout = (fn) => { timers.push(fn); };
        if (unsaved) w.addEventListener('beforeunload', (e) => e.preventDefault());
        const forms = [];
        const doc = { body: { appendChild() {} }, createElement: (t) => { const f = fakeEl(t); forms.push(f); return f; } };
        const wrap = fakeEl('div');
        const btn = wrap.querySelector('.acct-out'), warn = wrap.querySelector('.acct-warn');
        btn.textContent = 'Log out'; warn.hidden = true;
        const logout = AB._test.createLogout(wrap, doc, w);
        return { logout, btn, warn, forms, timers };
    }

    test('nothing unsaved: one click submits a real form to POST /api/logout?go=login', () => {
        const { logout, btn, forms } = setup(false);
        logout.click();
        expect(forms).toHaveLength(1);
        expect(forms[0].method).toBe('POST');
        expect(forms[0].action).toBe('/api/logout?go=login');
        expect(forms[0].submit).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toBe('Logging out…');
    });

    test('a second click while it is logging out does nothing (one request)', () => {
        const { logout, forms } = setup(false);
        logout.click();
        logout.click();
        logout.click();
        expect(forms).toHaveLength(1);
        expect(forms[0].submit).toHaveBeenCalledTimes(1);
    });

    test('unsaved work: the first click only warns — no log out yet', () => {
        const { logout, btn, warn, forms } = setup(true);
        logout.click();
        expect(forms).toHaveLength(0);
        expect(warn.hidden).toBe(false);
        expect(btn.textContent).toBe('Log out anyway');
        expect(btn.disabled).toBe(false);
    });

    test('unsaved work: the second click goes ahead', () => {
        const { logout, forms } = setup(true);
        logout.click();
        logout.click();
        expect(forms).toHaveLength(1);
        expect(forms[0].submit).toHaveBeenCalledTimes(1);
    });

    test('closing the box resets the warning, so the next try warns again', () => {
        const { logout, btn, warn, forms } = setup(true);
        logout.click();
        logout.reset();
        expect(warn.hidden).toBe(true);
        expect(btn.textContent).toBe('Log out');
        logout.click();
        expect(forms).toHaveLength(0);
        expect(warn.hidden).toBe(false);
    });

    test('choosing "Stay" at the browser box: the button comes back and the spare form is removed', () => {
        const { logout, btn, forms, timers } = setup(true);
        logout.click();
        logout.click();
        expect(btn.disabled).toBe(true);
        timers.forEach((fn) => fn());
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toBe('Log out anyway');
        expect(forms[0].remove).toHaveBeenCalled();
    });

    test('reset does nothing while a log-out is under way', () => {
        const { logout, btn } = setup(false);
        logout.click();
        logout.reset();
        expect(btn.textContent).toBe('Logging out…');
    });
});

// ── The server side ──────────────────────────────────────────────────────────

describe('POST /api/logout', () => {
    const { createAuthRouter } = require('../routes/auth');
    const storage = { readText: async () => null, saveText: async () => {} };
    const app = express();
    app.use('/api', createAuthRouter({ storage }));

    test('?go=login (the circle\'s form) clears the session and sends the browser to sign-in', async () => {
        const res = await request(app).post('/api/logout?go=login');
        expect(res.status).toBe(303);
        expect(res.headers.location).toBe('/login.html');
        expect(String(res.headers['set-cookie'])).toMatch(/dsc_session=;.*Max-Age=0/);
    });

    test('a plain call still answers JSON (other pages use it that way)', async () => {
        const res = await request(app).post('/api/logout');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(String(res.headers['set-cookie'])).toMatch(/dsc_session=;.*Max-Age=0/);
    });

    test('anything other than go=login is not a redirect', async () => {
        const res = await request(app).post('/api/logout?go=https://evil.example');
        expect(res.status).toBe(200);
        expect(res.headers.location).toBeUndefined();
    });
});

// ── Wiring and layering ──────────────────────────────────────────────────────

describe('on every app page, served without a session, under every pop-up', () => {
    test.each(['index.html', 'home.html', 'appraisal.html', 'people.html'])('%s loads it with a cache-buster', (page) => {
        expect(read(page)).toMatch(/<script src="\/account-badge\.js\?v=[\w-]+"><\/script>/);
    });

    test('signed-out pages do not load it', () => {
        expect(read('login.html')).not.toContain('account-badge.js');
        expect(read('reset-password.html')).not.toContain('account-badge.js');
    });

    test('it is a public file (index.html is also the customer quote page, with no session)', () => {
        const { PUBLIC_FILES } = require('../utils/auth');
        expect(PUBLIC_FILES.has('/account-badge.js')).toBe(true);
    });

    test('Home\'s old Sign out link is gone (the circle replaces it)', () => {
        expect(read('home.html')).not.toMatch(/id="signout"/);
    });

    test('the circle sits below every pop-up window, so a dialog always covers it', () => {
        const z = (css, sel) => Number((new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*?z-index:\\s*(\\d+)').exec(css) || [])[1]);
        const badge = z(AB._test.CSS, '.acct-wrap');
        expect(badge).toBeGreaterThan(0);
        expect(badge).toBeLessThan(z(read('people.html'), '.pm-overlay'));     // People permissions window
        expect(badge).toBeLessThan(z(read('styles.css'), '.pd-modal'));          // Partner Directory pop-ups
        expect(badge).toBeLessThan(60);                                           // the directory's pinned "NOT saved" bar on a phone
        expect(read('styles.css')).toMatch(/\.pd-error-save \{\s*position: fixed;[^}]*z-index: 60;/);
    });

    test('the circle stays a circle on a phone (no invalid font shorthand, phone min-height undone)', () => {
        const btn = /\.acct-btn\{([^}]*)\}/.exec(AB._test.CSS)[1];
        expect(btn).not.toMatch(/font:[^;]*inherit/);
        expect(btn).toMatch(/width:38px;height:38px/);
        expect(btn).toMatch(/min-height:0/);
        expect(btn).toMatch(/border-radius:50%/);
        expect(AB._test.CSS).toMatch(/@media print\{\.acct-wrap\{display:none\}\}/);
    });
});
