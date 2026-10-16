/**
 * @jest-environment node
 *
 * tests/people-auth-routes.test.js
 *
 * The per-person permission ticks, the People routes and password resets, driven through the
 * REAL routers in routes/auth.js — createAuthRouter (login, /me, password reset) in front of
 * createAuthGate, with createPeopleRouter behind it, mounted in that order exactly as server.js
 * does. People sign in through POST /api/login and carry the cookie the app hands back.
 *
 * Storage is an in-memory stand-in holding users.json. The people list is cached at module
 * level in routes/auth.js, so every test starts with _test.forgetUsers(). Gmail is mocked so the
 * reset emails can be read.
 *
 * What is pinned (utils/permissions.js holds the rules, routes/auth.js applies them):
 *   - lists OFF until someone holds "Manage people" — then staff get only addRevisions;
 *   - only a manager changes ticks; role:'admin' is kept in step; the last manager is protected;
 *     switching the lists on has to include the person doing it;
 *   - re-adding someone keeps their ticks; a new person gets the staff default;
 *   - the Apps Script ingest secret is never "a manager", even while the lists are off;
 *   - passwords: self yes, staff on others no, Google-only no, short/mismatch no;
 *   - reset links go to the office only, never reveal who has an account, work once;
 *   - a Google session for someone taken off the list is refused at the gate;
 *   - a list that could not be read says "try again" (503), never "not allowed" (403).
 */

'use strict';

jest.mock('../utils/gmail', () => ({ sendEmail: jest.fn(async () => ({ id: 'sent-1' })) }));

// Nothing from the developer's shell may change who is configured or where links point.
for (const k of ['APP_PASSWORD', 'SESSION_SECRET', 'GMAIL_CLIENT_SECRET', 'GMAIL_CLIENT_ID',
    'ALLOWED_EMAIL_DOMAINS', 'PUBLIC_URL', 'COMPANY_EMAIL']) delete process.env[k];
process.env.INGEST_SECRET = 'apps-script-secret-for-tests';

const express = require('express');
const request = require('supertest');
const { createAuthRouter, createAuthGate, createPeopleRouter, _test } = require('../routes/auth');
const auth = require('../utils/auth');
const perms = require('../utils/permissions');
const reset = require('../utils/passwordReset');
const gmail = require('../utils/gmail');
const { CONFIG_KEY_USERS } = require('../utils/constants');

const ALL_SIX = ['allocateMargins', 'editMargins', 'addNotes', 'deleteNotes', 'addRevisions', 'managePeople'];

const OWNER = 'owner@dscpipes.com';
const STAFF = 'ravi@dscpipes.com';
const OTHER = 'meena@dscpipes.com';
const GOOGLE = 'gopal@gmail.com';            // Google sign-in only, outside the company domain

const PW = { owner: 'owner-pass-111', staff: 'staff-pass-222', other: 'other-pass-333' };
// scrypt is slow on purpose; hash once for the whole file.
const HASH = { owner: auth.hashPassword(PW.owner), staff: auth.hashPassword(PW.staff), other: auth.hashPassword(PW.other) };

/** Nobody holds "Manage people": the lists are OFF. */
function listsOffUsers() {
    return [
        { name: 'Owner', email: OWNER, hash: HASH.owner },
        { name: 'Ravi', email: STAFF, hash: HASH.staff },
        { name: 'Meena', email: OTHER, hash: HASH.other },
        { name: 'Gopal', email: GOOGLE },
    ];
}
/** The owner holds every tick: the lists are ON. */
function listsOnUsers() {
    const users = listsOffUsers();
    users[0] = Object.assign({}, users[0], { permissions: ALL_SIX.slice(), role: 'admin' });
    return users;
}

function makeStorage(users) {
    const s = {
        files: { [CONFIG_KEY_USERS]: JSON.stringify(users) },
        failReads: 0,             // the next N reads throw
        alwaysFail: false,
        saves: 0,
        async readText(key) {
            if (s.alwaysFail) throw new Error('S3 is down');
            if (s.failReads > 0) { s.failReads--; throw new Error('S3 hiccup'); }
            return s.files[key] == null ? null : s.files[key];
        },
        async saveText(key, text) { s.saves++; s.files[key] = String(text); },
        users() { return JSON.parse(s.files[CONFIG_KEY_USERS]); },
        person(email) { return s.users().find((u) => String(u.email).toLowerCase() === email.toLowerCase()); },
    };
    return s;
}

// Mounted exactly as server.js does: sign-in routes, the gate, then the People routes.
function makeApp(storage) {
    const app = express();
    app.use('/api', createAuthRouter({ storage }));
    app.use(createAuthGate({ storage }));
    // What the gate decided about this request, for the tests to read.
    app.get('/api/probe', (req, res) => res.json({
        user: req.user || null, authOpen: !!req.authOpen, permissionsUnknown: !!req.permissionsUnknown,
    }));
    app.use('/api', createPeopleRouter({ storage }));
    return app;
}

// A browser: carries the session cookie and picks up any reissued one.
function browser(app, cookie) {
    const b = { cookie: cookie || null };
    b.send = async (method, path, body, headers) => {
        let r = request(app)[method](path);
        if (b.cookie) r = r.set('Cookie', b.cookie);
        for (const [k, v] of Object.entries(headers || {})) r = r.set(k, v);
        const res = body !== undefined ? await r.send(body) : await r;
        const set = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(auth.SESSION_COOKIE + '='));
        if (set) b.cookie = set.split(';')[0];
        return res;
    };
    b.post = (path, body, headers) => b.send('post', path, body, headers);
    b.get = (path, headers) => b.send('get', path, undefined, headers);
    return b;
}

let ip = 0;
/** A fresh address per login, so the failed-guess limiter never trips across tests. */
function login(app, name, password) {
    return browser(app).post('/api/login', { name, password }, { 'X-Forwarded-For': '10.9.' + Math.floor(++ip / 250) + '.' + (ip % 250) });
}
async function signIn(app, name, password) {
    const b = browser(app);
    const res = await b.post('/api/login', { name, password }, { 'X-Forwarded-For': '10.8.' + Math.floor(++ip / 250) + '.' + (ip % 250) });
    expect(res.status).toBe(200);
    expect(b.cookie).toMatch(/^dsc_session=.+/);
    return b;
}

function googleCookie(users, email, who) {
    const token = auth.signSession({ who: who || email, kind: 'google', email }, _test.sessionSecret(users));
    return auth.SESSION_COOKIE + '=' + encodeURIComponent(token);
}

function tokenFromEmail(call) {
    const m = /reset-password\.html\?token=([^"<&\s]+)/.exec(call.bodyHtml);
    return m ? decodeURIComponent(m[1]) : null;
}

const realNow = Date.now;
let clockOffset = 0;
function advanceClock(ms) {
    clockOffset += ms;
    if (!jest.isMockFunction(Date.now)) jest.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + clockOffset);
}

let quiet = [];
beforeEach(() => {
    _test.forgetUsers();
    gmail.sendEmail.mockClear();
    // The routes log every failed read and failed email; expected here, so kept off the output.
    quiet = [jest.spyOn(console, 'warn').mockImplementation(() => {}), jest.spyOn(console, 'error').mockImplementation(() => {})];
});
afterEach(() => {
    quiet.forEach((s) => s.mockRestore());
    if (jest.isMockFunction(Date.now)) Date.now.mockRestore();
    clockOffset = 0;
    delete process.env.PUBLIC_URL;
});

// ── GET /api/me ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/me — what the page is told this person may do', () => {
    test('lists off: a staff member with no ticks is told all six, and the gate gives them all six', async () => {
        const app = makeApp(makeStorage(listsOffUsers()));
        const ravi = await signIn(app, STAFF, PW.staff);
        const me = await ravi.get('/api/me');
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({ configured: true, signedIn: true, email: STAFF, listsOn: false, permissionsKnown: true });
        expect(me.body.permissions).toEqual(ALL_SIX);
        const probe = await ravi.get('/api/probe');
        expect(probe.status).toBe(200);
        expect(probe.body.user.permissions).toEqual(ALL_SIX);
        expect(probe.body.authOpen).toBe(false);
    });

    test('after the owner ticks Manage people for himself, staff get only addRevisions — on the same cookie', async () => {
        const storage = makeStorage(listsOffUsers());
        const app = makeApp(storage);
        const ravi = await signIn(app, STAFF, PW.staff);
        const owner = await signIn(app, OWNER, PW.owner);
        expect((await ravi.get('/api/me')).body.permissions).toEqual(ALL_SIX);

        const set = await owner.post('/api/people/permissions', { email: OWNER, permissions: ALL_SIX });
        expect(set.status).toBe(200);
        expect(set.body.permissions).toEqual(ALL_SIX);

        // Worked out from the list on every request, not kept in the cookie.
        const me = await ravi.get('/api/me');
        expect(me.body.signedIn).toBe(true);
        expect(me.body.permissions).toEqual(['addRevisions']);
        expect(me.body.listsOn).toBe(true);
        expect((await ravi.get('/api/probe')).body.user.permissions).toEqual(['addRevisions']);

        const ownerMe = await owner.get('/api/me');
        expect(ownerMe.body.permissions).toEqual(ALL_SIX);
        expect(ownerMe.body.listsOn).toBe(true);
    });

    test('an older record with role:"admin" and no tick list counts as every tick and switches the lists on', async () => {
        const users = listsOffUsers();
        users[0].role = 'admin';
        const app = makeApp(makeStorage(users));
        const owner = await signIn(app, OWNER, PW.owner);
        const ravi = await signIn(app, STAFF, PW.staff);
        expect((await owner.get('/api/me')).body.permissions).toEqual(ALL_SIX);
        const me = await ravi.get('/api/me');
        expect(me.body.permissions).toEqual(['addRevisions']);
        expect(me.body.listsOn).toBe(true);
    });

    test('a people list that cannot be read: permissionsKnown false and no permissions — never all six', async () => {
        const storage = makeStorage(listsOffUsers());
        const app = makeApp(storage);
        const ravi = await signIn(app, STAFF, PW.staff);
        _test.forgetUsers();
        storage.alwaysFail = true;
        const me = await ravi.get('/api/me');
        expect(me.status).toBe(200);
        expect(me.body.permissionsKnown).toBe(false);
        expect(me.body.permissions).toEqual([]);
        expect(me.body.configured).toBe(true);           // a failed read is never "nothing set up"
    });
});

// ── POST /api/people/permissions ────────────────────────────────────────────────────────────
describe('POST /api/people/permissions — one person\'s ticks', () => {
    test('staff cannot change ticks once the lists are on (403), and nothing is saved', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const ravi = await signIn(app, STAFF, PW.staff);
        const self = await ravi.post('/api/people/permissions', { email: STAFF, permissions: ALL_SIX });
        expect(self.status).toBe(403);
        const other = await ravi.post('/api/people/permissions', { email: OTHER, permissions: ['addNotes'] });
        expect(other.status).toBe(403);
        expect(storage.saves).toBe(0);
        expect(storage.person(STAFF).permissions).toBeUndefined();
    });

    test('the manager sets ticks (unknown keys dropped); role:"admin" follows Manage people both ways', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);

        const up = await owner.post('/api/people/permissions', { email: OTHER, permissions: ['managePeople', 'addNotes', 'bogus'] });
        expect(up.status).toBe(200);
        expect(up.body.permissions).toEqual(['addNotes', 'managePeople']);
        expect(storage.person(OTHER)).toMatchObject({ permissions: ['addNotes', 'managePeople'], role: 'admin' });

        const down = await owner.post('/api/people/permissions', { email: OTHER, permissions: ['addNotes'] });
        expect(down.status).toBe(200);
        expect(storage.person(OTHER).permissions).toEqual(['addNotes']);
        expect(storage.person(OTHER)).not.toHaveProperty('role');
        // The password hash is untouched, so nobody is signed out by a tick change.
        expect(storage.person(OTHER).hash).toBe(HASH.other);
        expect((await owner.get('/api/probe')).status).toBe(200);
    });

    test('the last manager cannot untick Manage people from himself (400); with a second manager he can', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);

        const alone = await owner.post('/api/people/permissions', { email: OWNER, permissions: ['addRevisions'] });
        expect(alone.status).toBe(400);
        expect(alone.body.error).toMatch(/Someone must always be able to manage people/);
        expect(storage.person(OWNER).permissions).toContain('managePeople');
        expect(storage.saves).toBe(0);

        expect((await owner.post('/api/people/permissions', { email: OTHER, permissions: ['managePeople'] })).status).toBe(200);
        const nowOk = await owner.post('/api/people/permissions', { email: OWNER, permissions: ['addRevisions'] });
        expect(nowOk.status).toBe(200);
        expect(storage.person(OWNER).permissions).toEqual(['addRevisions']);
    });

    test('switching the lists on: Manage people for someone else first is refused; for himself it works', async () => {
        const storage = makeStorage(listsOffUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);

        const someoneElse = await owner.post('/api/people/permissions', { email: STAFF, permissions: ['managePeople'] });
        expect(someoneElse.status).toBe(400);
        expect(someoneElse.body.error).toMatch(/Tick "Manage people" for yourself first/);
        expect(storage.saves).toBe(0);
        expect(perms.listsOn(storage.users())).toBe(false);

        const himself = await owner.post('/api/people/permissions', { email: OWNER, permissions: ['managePeople'] });
        expect(himself.status).toBe(200);
        expect(perms.listsOn(storage.users())).toBe(true);
        expect(storage.person(OWNER).role).toBe('admin');
    });

    test('an email not on the list → 404; no list sent → 400', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);
        expect((await owner.post('/api/people/permissions', { email: 'nobody@dscpipes.com', permissions: ['addNotes'] })).status).toBe(404);
        expect((await owner.post('/api/people/permissions', { email: STAFF })).status).toBe(400);
        expect(storage.saves).toBe(0);
    });
});

// ── POST /api/people/role ───────────────────────────────────────────────────────────────────
describe('POST /api/people/role — the older admin/staff switch', () => {
    test('"admin" is every tick, "staff" the staff default; anything else is 400; staff may not use it', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);

        const admin = await owner.post('/api/people/role', { email: STAFF, role: 'Admin' });
        expect(admin.status).toBe(200);
        expect(admin.body.permissions).toEqual(ALL_SIX);
        expect(storage.person(STAFF)).toMatchObject({ permissions: ALL_SIX, role: 'admin' });

        const staff = await owner.post('/api/people/role', { email: STAFF, role: 'staff' });
        expect(staff.status).toBe(200);
        expect(staff.body.permissions).toEqual(['addRevisions']);
        expect(storage.person(STAFF)).not.toHaveProperty('role');

        expect((await owner.post('/api/people/role', { email: STAFF, role: 'boss' })).status).toBe(400);

        const ravi = await signIn(app, STAFF, PW.staff);
        expect((await ravi.post('/api/people/role', { email: STAFF, role: 'admin' })).status).toBe(403);
        expect(storage.person(STAFF).permissions).toEqual(['addRevisions']);
    });
});

// ── POST /api/people ────────────────────────────────────────────────────────────────────────
describe('POST /api/people — add or re-add a person', () => {
    test('re-adding someone already on the list keeps their ticks; a brand-new person gets addRevisions only', async () => {
        const users = listsOnUsers();
        users[2].permissions = ['addNotes', 'deleteNotes'];
        const storage = makeStorage(users);
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);

        // Switching Meena to Google sign-in (no ticks sent) must not strip what she had.
        const again = await owner.post('/api/people', { name: 'Meena K', email: 'MEENA@dscpipes.com', method: 'google' });
        expect(again.status).toBe(200);
        const meena = storage.users().filter((u) => u.email === OTHER);
        expect(meena).toHaveLength(1);
        expect(meena[0]).toMatchObject({ name: 'Meena K', permissions: ['addNotes', 'deleteNotes'] });
        expect(meena[0]).not.toHaveProperty('hash');
        expect(meena[0]).not.toHaveProperty('role');

        // Her hash left the signing key; the owner's cookie was reissued, so he is still in.
        const fresh = await owner.post('/api/people', { name: 'Kiran', email: 'kiran@dscpipes.com', method: 'google' });
        expect(fresh.status).toBe(200);
        expect(storage.person('kiran@dscpipes.com').permissions).toEqual(['addRevisions']);
        expect(storage.person('kiran@dscpipes.com')).not.toHaveProperty('role');
    });

    test('a role or tick list sent with the person is used; staff cannot add anyone (403)', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);
        expect((await owner.post('/api/people', { name: 'Asha', email: 'asha@dscpipes.com', method: 'google', role: 'admin' })).status).toBe(200);
        expect(storage.person('asha@dscpipes.com')).toMatchObject({ permissions: ALL_SIX, role: 'admin' });

        const ravi = await signIn(app, STAFF, PW.staff);
        const res = await ravi.post('/api/people', { name: 'Pal', email: 'pal@dscpipes.com', method: 'google', permissions: ALL_SIX });
        expect(res.status).toBe(403);
        expect(storage.person('pal@dscpipes.com')).toBeUndefined();
    });
});

// ── The Apps Script ingest secret ───────────────────────────────────────────────────────────
describe('the Apps Script ingest secret (no cookie)', () => {
    test('passes the gate with nobody signed in, but can NOT add a person — even while the lists are off', async () => {
        const storage = makeStorage(listsOffUsers());
        const app = makeApp(storage);
        const script = browser(app);
        const secret = { 'X-Ingest-Secret': process.env.INGEST_SECRET };

        const probe = await script.get('/api/probe', secret);
        expect(probe.status).toBe(200);
        expect(probe.body.user).toBeNull();
        expect(probe.body.authOpen).toBe(false);

        const add = await script.post('/api/people', { name: 'Bot', email: 'bot@evil.example', method: 'google', permissions: ALL_SIX }, secret);
        expect(add.status).toBe(403);
        const tick = await script.post('/api/people/permissions', { email: OWNER, permissions: ALL_SIX }, secret);
        expect(tick.status).toBe(403);
        expect(storage.saves).toBe(0);
        expect(storage.person('bot@evil.example')).toBeUndefined();

        // A wrong secret does not even pass the gate.
        expect((await script.post('/api/people', { name: 'Bot', email: 'bot@evil.example' }, { 'X-Ingest-Secret': 'guess' })).status).toBe(401);

        // Control: with the lists off a SIGNED-IN person may add someone — the 403 is about identity.
        const ravi = await signIn(app, STAFF, PW.staff);
        expect((await ravi.post('/api/people', { name: 'Kiran', email: 'kiran@dscpipes.com', method: 'google' })).status).toBe(200);
    });
});

// ── POST /api/people/password ───────────────────────────────────────────────────────────────
describe('POST /api/people/password — setting a password', () => {
    test('anyone may set their own; the new one signs in, the old one does not, and they stay signed in', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const ravi = await signIn(app, STAFF, PW.staff);
        const res = await ravi.post('/api/people/password', { email: STAFF, password: 'ravi-new-pass-1', confirmPassword: 'ravi-new-pass-1' });
        expect(res.status).toBe(200);
        expect((await login(app, STAFF, PW.staff)).status).toBe(401);
        expect((await login(app, STAFF, 'ravi-new-pass-1')).status).toBe(200);
        expect((await ravi.get('/api/probe')).status).toBe(200);    // reissued under the new key
    });

    test('staff setting someone else\'s password → 403, their hash untouched', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const ravi = await signIn(app, STAFF, PW.staff);
        const res = await ravi.post('/api/people/password', { email: OTHER, password: 'taken-over-1', confirmPassword: 'taken-over-1' });
        expect(res.status).toBe(403);
        expect(storage.person(OTHER).hash).toBe(HASH.other);
        expect((await login(app, OTHER, 'taken-over-1')).status).toBe(401);
    });

    test('a manager may set someone else\'s, but a Google-only person has none to set (400)', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);
        const g = await owner.post('/api/people/password', { email: GOOGLE, password: 'google-pass-1', confirmPassword: 'google-pass-1' });
        expect(g.status).toBe(400);
        expect(g.body.error).toMatch(/signs in with Google/);
        expect(storage.person(GOOGLE)).not.toHaveProperty('hash');

        const m = await owner.post('/api/people/password', { email: OTHER, password: 'meena-set-by-owner', confirmPassword: 'meena-set-by-owner' });
        expect(m.status).toBe(200);
        expect((await login(app, OTHER, 'meena-set-by-owner')).status).toBe(200);
    });

    test('too short or not matching → 400 and nothing saved', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const ravi = await signIn(app, STAFF, PW.staff);
        const short = await ravi.post('/api/people/password', { email: STAFF, password: 'short', confirmPassword: 'short' });
        expect(short.status).toBe(400);
        expect(short.body.error).toMatch(/at least 8/);
        const differ = await ravi.post('/api/people/password', { email: STAFF, password: 'long-enough-1', confirmPassword: 'long-enough-2' });
        expect(differ.status).toBe(400);
        expect(differ.body.error).toMatch(/did not match/);
        expect(storage.saves).toBe(0);
        expect(storage.person(STAFF).hash).toBe(HASH.staff);
    });
});

// ── Password reset ──────────────────────────────────────────────────────────────────────────
describe('password reset ("Forgot password?")', () => {
    test('a request emails the OFFICE, naming the person, with a link to the reset page', async () => {
        process.env.PUBLIC_URL = 'https://quotes.example.test';
        const app = makeApp(makeStorage(listsOnUsers()));
        const res = await browser(app).post('/api/password-reset/request', { email: 'Ravi@DSCpipes.com' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, sentTo: 'info@dscpipes.com' });
        expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
        const mail = gmail.sendEmail.mock.calls[0][0];
        expect(mail.to).toBe('info@dscpipes.com');
        expect(mail.subject).toMatch(/Ravi/);
        expect(mail.bodyHtml).toMatch(/Ravi/);
        expect(mail.bodyHtml).toContain('https://quotes.example.test/reset-password.html?token=');
        expect(tokenFromEmail(mail)).toBeTruthy();
    });

    test('a stranger and a Google-only person get the same 200 answer, and no email is sent', async () => {
        const app = makeApp(makeStorage(listsOnUsers()));
        const stranger = await browser(app).post('/api/password-reset/request', { email: 'nobody@nowhere.example' });
        const google = await browser(app).post('/api/password-reset/request', { email: GOOGLE });
        expect(stranger.status).toBe(200);
        expect(google.status).toBe(200);
        expect(stranger.body).toEqual({ ok: true, sentTo: 'info@dscpipes.com' });
        expect(google.body).toEqual(stranger.body);
        expect(gmail.sendEmail).not.toHaveBeenCalled();
    });

    test('asking again within 2 minutes → 429, and only one email goes out', async () => {
        const app = makeApp(makeStorage(listsOnUsers()));
        expect((await browser(app).post('/api/password-reset/request', { email: OWNER })).status).toBe(200);
        const again = await browser(app).post('/api/password-reset/request', { email: OWNER.toUpperCase() });
        expect(again.status).toBe(429);
        expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    });

    test('an email that fails to send → 503, and asking again is allowed straight away', async () => {
        const users = listsOnUsers();
        users.push({ name: 'Asha', email: 'asha@dscpipes.com', hash: HASH.other });
        const app = makeApp(makeStorage(users));
        gmail.sendEmail.mockImplementationOnce(async () => { throw new Error('Gmail down'); });
        expect((await browser(app).post('/api/password-reset/request', { email: 'asha@dscpipes.com' })).status).toBe(503);
        expect((await browser(app).post('/api/password-reset/request', { email: 'asha@dscpipes.com' })).status).toBe(200);
        expect(gmail.sendEmail).toHaveBeenCalledTimes(2);
    });

    test('completing with the emailed token sets the new password; the old one fails; the link works once', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        expect((await browser(app).post('/api/password-reset/request', { email: OTHER })).status).toBe(200);
        const token = tokenFromEmail(gmail.sendEmail.mock.calls[0][0]);
        expect(token).toBeTruthy();

        const done = await browser(app).post('/api/password-reset/complete', { token, password: 'meena-reset-99', confirmPassword: 'meena-reset-99' });
        expect(done.status).toBe(200);
        expect((await login(app, OTHER, PW.other)).status).toBe(401);
        expect((await login(app, OTHER, 'meena-reset-99')).status).toBe(200);

        const reused = await browser(app).post('/api/password-reset/complete', { token, password: 'second-go-123', confirmPassword: 'second-go-123' });
        expect(reused.status).toBe(400);
        expect(reused.body.error).toMatch(/expired or was already used/);
        expect((await login(app, OTHER, 'second-go-123')).status).toBe(401);
    });

    test('a forged or tampered token → 400 and nothing is saved', async () => {
        const users = listsOnUsers();
        const storage = makeStorage(users);
        const app = makeApp(storage);
        const forged = reset.makeResetToken(users, OWNER, 'not-the-real-secret');
        const r1 = await browser(app).post('/api/password-reset/complete', { token: forged, password: 'hijacked-123', confirmPassword: 'hijacked-123' });
        expect(r1.status).toBe(400);

        // A real token for Meena, its body rewritten to point at the owner, signature kept.
        const real = reset.makeResetToken(users, OTHER, _test.sessionSecret(users));
        const ownerBody = Buffer.from(JSON.stringify({ e: OWNER, x: Date.now() + 60000 }), 'utf8').toString('base64url');
        const tampered = ownerBody + '.' + real.split('.')[1];
        const r2 = await browser(app).post('/api/password-reset/complete', { token: tampered, password: 'hijacked-123', confirmPassword: 'hijacked-123' });
        expect(r2.status).toBe(400);
        expect(storage.saves).toBe(0);
        expect((await login(app, OWNER, 'hijacked-123')).status).toBe(401);

        // The untouched real token does work — the 400s above were the forgery being caught.
        const ok = await browser(app).post('/api/password-reset/complete', { token: real, password: 'meena-real-123', confirmPassword: 'meena-real-123' });
        expect(ok.status).toBe(200);
    });
});

// ── The gate and Google sessions ────────────────────────────────────────────────────────────
describe('the gate — a Google sign-in for someone taken off the list', () => {
    test('removed (domain not allowed) → refused on the same cookie; a company-domain address is let in', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const users = storage.users();
        const gopal = browser(app, googleCookie(users, GOOGLE, 'Gopal'));
        const before = await gopal.get('/api/probe');
        expect(before.status).toBe(200);
        expect(before.body.user).toMatchObject({ kind: 'google', email: GOOGLE, permissions: ['addRevisions'] });

        const owner = await signIn(app, OWNER, PW.owner);
        expect((await owner.post('/api/people/remove', { email: GOOGLE })).status).toBe(200);
        expect(storage.person(GOOGLE)).toBeUndefined();
        // Gopal had no password hash, so the signing key did not change — only the gate's rule refuses him.
        expect(_test.sessionSecret(storage.users())).toBe(_test.sessionSecret(users));

        const after = await gopal.get('/api/probe');
        expect(after.status).toBe(401);
        expect(after.body.error).toBe('Not signed in');
        const page = await gopal.get('/api/probe', { Accept: 'text/html' });
        expect(page.status).toBe(302);
        expect(page.headers.location).toMatch(/^\/login\.html\?next=/);

        // Someone at the company's own domain may come in by Google without being on the list.
        const newHire = browser(app, googleCookie(storage.users(), 'newhire@dscpipes.com', 'New Hire'));
        const nh = await newHire.get('/api/probe');
        expect(nh.status).toBe(200);
        expect(nh.body.user.permissions).toEqual(['addRevisions']);
    });
});

// ── A people list that cannot be read ───────────────────────────────────────────────────────
describe('a people list that cannot be read', () => {
    test('a manager whose ticks could not be read is told to try again (503), not refused (403)', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);

        // The gate's minute-old copy goes stale and its re-read fails; the route's own fresh read works.
        advanceClock(61 * 1000);
        storage.failReads = 1;
        const res = await owner.post('/api/people/permissions', { email: STAFF, permissions: ['addNotes'] });
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/Could not check your permissions/);
        expect(storage.saves).toBe(0);

        // What the gate decided: nothing allowed, and marked "unknown" rather than "not allowed".
        advanceClock(61 * 1000);
        storage.failReads = 1;
        const probe = await owner.get('/api/probe');
        expect(probe.status).toBe(200);
        expect(probe.body.permissionsUnknown).toBe(true);
        expect(probe.body.user.permissions).toEqual([]);
    });

    test('when no read works at all, every people write answers 503 and saves nothing', async () => {
        const storage = makeStorage(listsOnUsers());
        const app = makeApp(storage);
        const owner = await signIn(app, OWNER, PW.owner);
        // Each write empties the cache (it insists on a fresh read), so the scene is set again
        // before each one: the gate holds a minute-old copy, and storage is down.
        async function storageDownThen(fn) {
            storage.alwaysFail = false;
            expect((await owner.get('/api/probe')).status).toBe(200);
            advanceClock(61 * 1000);
            storage.alwaysFail = true;
            return fn();
        }
        const add = await storageDownThen(() => owner.post('/api/people', { name: 'Kiran', email: 'kiran@dscpipes.com', method: 'google' }));
        expect(add.status).toBe(503);
        expect(add.body.error).toMatch(/Cannot read the people list/);
        const tick = await storageDownThen(() => owner.post('/api/people/permissions', { email: STAFF, permissions: ['addNotes'] }));
        expect(tick.status).toBe(503);
        const pw = await storageDownThen(() => owner.post('/api/people/password', { email: OWNER, password: 'owner-new-123', confirmPassword: 'owner-new-123' }));
        expect(pw.status).toBe(503);
        expect(storage.saves).toBe(0);

        // With the cache gone as well, a failed read means LOCKED, never open: the gate refuses.
        const locked = await owner.post('/api/people/remove', { email: STAFF });
        expect(locked.status).toBe(401);
        expect(storage.saves).toBe(0);
    });
});
