'use strict';

/**
 * routes/auth.js — the login routes, and the gate that stands in front of everything else.
 *
 * The gate is mounted BEFORE every other route and before the static file server, so a route
 * added later is protected without anyone remembering to protect it. What stays open is the
 * short list in utils/auth.js, not a list kept here.
 *
 * Two ways in, both live at once: one shared password (APP_PASSWORD), or named people.
 */

const express = require('express');
const crypto = require('crypto');
const { CONFIG_KEY_USERS, COMPANY_EMAIL } = require('../utils/constants');
const auth = require('../utils/auth');
const googleAuth = require('../utils/googleAuth');
const roles = require('../utils/peopleRoles');
const perms = require('../utils/permissions');
const reset = require('../utils/passwordReset');

// Reading the people list from cloud storage on EVERY request would add a network round trip to
// every page and every save. Held briefly instead; a minute-old list is fine for a list that
// changes a few times a year.
let cachedUsers = null;                 // the last GOOD read, never a failed one
let cachedAt = 0;
const USERS_TTL_MS = 60 * 1000;

/**
 * The people list, and whether we actually managed to read it.
 *
 * The `ok` flag is the whole point. The first version of this returned [] when the read failed,
 * which made "the list could not be read" indistinguishable from "there is nobody on the list" —
 * and with no APP_PASSWORD set, the second of those opens the app to everyone. A security review
 * reproduced it: one S3 hiccup, and every quote, margin and buying rate was served to anyone who
 * asked, for the full sixty seconds the empty list stayed cached.
 *
 * So a failure is never cached and never reported as emptiness. The caller decides, and it fails
 * shut.
 */
async function loadUsers(storage) {
    if (cachedUsers && Date.now() - cachedAt < USERS_TTL_MS) return { users: cachedUsers, ok: true };
    try {
        const raw = await storage.readText(CONFIG_KEY_USERS);
        const parsed = raw ? JSON.parse(raw) : [];
        cachedUsers = Array.isArray(parsed) ? parsed : [];
        cachedAt = Date.now();
        return { users: cachedUsers, ok: true };
    } catch (e) {
        console.warn('users.json could not be read (treating the app as LOCKED):', e.message);
        return { users: cachedUsers || [], ok: false };
    }
}

function forgetUsers() { cachedUsers = null; cachedAt = 0; }

/**
 * What signs the session cookie.
 *
 * The people's password hashes are always mixed in, which buys two things beyond a signature:
 *   - Named-people mode works with no env vars at all. Before this, setting up logins with
 *     tools/manage-users.js and no APP_PASSWORD left no secret to sign with, and every correct
 *     password came back as a 500 — the documented setup bricked the site.
 *   - Removing someone actually removes them. A signed cookie is valid for a month and nothing
 *     re-checks the list, so without this a person who left kept full access for 30 days.
 *     Changing the list changes the secret, so their cookie stops working at once.
 *
 * The cost is that adding or removing anyone signs everybody out. For a list that changes a few
 * times a year that is the right side of the trade.
 */
function sessionSecret(users) {
    // GMAIL_CLIENT_SECRET is the last resort rather than a preference: it is already set on every
    // deployment and is stable across restarts, so signing in works with no new setting at all.
    // It is only ever an input to a hash here; nothing derived from it goes anywhere near Google.
    const base = String(process.env.SESSION_SECRET || '').trim()
        || auth.sharedPassword()
        || String(process.env.GMAIL_CLIENT_SECRET || '').trim()
        || '';
    const people = (Array.isArray(users) ? users : [])
        .map((u) => (u && u.hash) || '').filter(Boolean).sort().join('|');
    if (!base && !people) return null;
    return crypto.createHash('sha256').update('dsc-session:' + base + '#' + people).digest('hex');
}

/** Machine-to-machine callers (the Google Apps Script) have no cookie and never will. They carry
 *  the shared ingest secret instead, and are recognised by THAT rather than by path — the first
 *  version allowlisted two paths, which broke the other endpoints the script calls. */
function hasIngestSecret(req) {
    const expected = String(process.env.INGEST_SECRET || '').trim();
    if (!expected) return false;
    const sent = req.headers['x-ingest-secret'];
    return !!sent && auth._test.timingSafeEqualStr(String(sent), expected);
}

function isHttps(req) {
    return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
    const bits = [
        auth.SESSION_COOKIE + '=' + encodeURIComponent(token),
        'Path=/',
        'HttpOnly',                       // JavaScript on the page can never read it
        'SameSite=Lax',                   // not sent from another site's form post
        'Max-Age=' + auth.DEFAULT_TTL_SECONDS,
    ];
    if (isHttps(req)) bits.push('Secure');
    res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(req, res) {
    const bits = [auth.SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (isHttps(req)) bits.push('Secure');
    res.setHeader('Set-Cookie', bits.join('; '));
}

function wantsHtml(req) {
    return String(req.headers.accept || '').indexOf('text/html') >= 0;
}

function refuse(req, res) {
    if (wantsHtml(req)) {
        return res.redirect(302, '/login.html?next=' + encodeURIComponent(auth.safeNextPath(req.originalUrl || '/')));
    }
    return res.status(401).json({ error: 'Not signed in' });
}

/** The gate. Everything not on the public list needs a valid session. */
function createAuthGate({ storage }) {
    let warned = false;
    return async function authGate(req, res, next) {
        try {
            if (auth.isPublicRequest(req.method, req.path, req.query)) return next();
            if (hasIngestSecret(req)) return next();

            const { users, ok } = await loadUsers(storage);

            // "Could not read the list" must never be mistaken for "nobody is set up". Only a
            // clean read of an empty list, with no shared password, means nothing is configured.
            const configured = auth.authIsConfigured(users) || !ok;
            if (!configured) {
                // Nothing is set up yet. Standing aside is deliberate — a half-configured login
                // must not take a live business offline — but it is said out loud, every boot, so
                // "we added a login" can never quietly mean "there is still no login".
                if (!warned) {
                    warned = true;
                    console.warn('SECURITY: no APP_PASSWORD and no users.json — the app is OPEN to anyone with the address.');
                }
                res.setHeader('X-Auth-Status', 'not-configured');
                // No logins at all: the site is open, as it always was. Marked here (never as a
                // req.user — that would let reissueIfPossible sign an "open" cookie) so permission
                // checks pass in this mode and only in this mode.
                req.authOpen = true;
                return next();
            }

            const secret = sessionSecret(users);
            const session = secret && auth.verifySession(auth.readCookie(req, auth.SESSION_COOKIE), secret);
            if (session) {
                req.user = { who: session.who, kind: session.kind, email: session.email || null };
                // Worked out from the list on every request — never kept in the cookie, so a
                // changed tick applies at once and nobody is signed out. A list we could not read
                // gives nothing at all rather than "everything".
                req.user.permissions = ok ? perms.effectivePermissions(users, req.user.email) : [];
                return next();
            }
            return refuse(req, res);
        } catch (e) {
            // The gate itself failing must not become a way through, and must not take the
            // server down either: this runs in async middleware, where a thrown error is an
            // unhandled rejection.
            console.error('auth gate error (refusing the request):', e && e.message);
            return refuse(req, res);
        }
    };
}

// This site's own address, for links in emails. PUBLIC_URL wins, as for the Google callback.
function siteBase(req) {
    const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    return (isHttps(req) ? 'https' : 'http') + '://' + String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
}

// One reset email per address every 2 minutes, so the button can't be used to flood the office.
const resetAskedAt = new Map();
function resetAskedTooSoon(email) {
    const key = String(email || '').trim().toLowerCase();
    const last = resetAskedAt.get(key) || 0;
    if (Date.now() - last < 2 * 60 * 1000) return true;
    resetAskedAt.set(key, Date.now());
    return false;
}

// Sends the link to the OFFICE mailbox (owner's rule) — never to the address typed in.
async function emailResetLink(req, users, email) {
    const token = reset.makeResetToken(users, email, sessionSecret(users));
    if (!token) return;                                   // not on the list, or signs in with Google
    const person = users.find((u) => String(u.email || '').toLowerCase() === String(email).trim().toLowerCase());
    const link = siteBase(req) + '/reset-password.html?token=' + encodeURIComponent(token);
    const askedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await require('../utils/gmail').sendEmail({
        to: COMPANY_EMAIL,
        subject: 'Password reset link — ' + (person.name || person.email),
        bodyHtml: reset.resetEmailHtml(person, link, askedAt),
    });
}

function createAuthRouter({ storage }) {
    const router = express.Router();

    // "Forgot password?" The answer is the same whether or not the address is on the list, so
    // the page can't be used to find out who has an account.
    router.post('/password-reset/request', express.json(), async (req, res) => {
        const email = String((req.body && req.body.email) || '').trim();
        if (!email) return res.status(400).json({ error: 'Enter your email address.' });
        if (resetAskedTooSoon(email)) return res.status(429).json({ error: 'A link was just sent. Wait 2 minutes before asking again.' });
        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot check right now. Try again shortly.' });
        try { await emailResetLink(req, users, email); }
        catch (e) {
            console.error('Password reset email failed:', e.message);
            resetAskedAt.delete(email.toLowerCase());
            return res.status(503).json({ error: 'The email could not be sent. Try again shortly.' });
        }
        res.json({ ok: true, sentTo: COMPANY_EMAIL });
    });

    router.post('/password-reset/complete', express.json(), async (req, res) => {
        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot check right now. Try again shortly.' });
        const person = reset.readResetToken(users, req.body && req.body.token, sessionSecret(users));
        if (!person) return res.status(400).json({ error: 'This link has expired or was already used. Ask for a new one.' });
        const problem = reset.passwordProblem(req.body.password, req.body.confirmPassword);
        if (problem) return res.status(400).json({ error: problem });
        const next = reset.withNewHash(users, person.email, auth.hashPassword(String(req.body.password)));
        try { await storage.saveText(CONFIG_KEY_USERS, JSON.stringify(next, null, 2)); }
        catch (e) { return res.status(503).json({ error: 'Could not save. Try again shortly.' }); }
        forgetUsers();
        res.json({ ok: true });
    });

    router.post('/login', express.json(), async (req, res) => {
        const key = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
        if (auth.tooManyAttempts(key)) {
            return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
        }
        const { name, password } = req.body || {};
        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot check logins right now. Try again shortly.' });
        if (!auth.authIsConfigured(users)) {
            return res.status(503).json({ error: 'No password has been set up for this site yet.' });
        }
        const who = auth.authenticate(name, password, users);
        if (!who) {
            auth.noteFailedAttempt(key);
            return res.status(401).json({ error: 'That did not work.' });   // never say WHICH part
        }
        const secret = sessionSecret(users);
        if (!secret) return res.status(500).json({ error: 'Sessions are not configured.' });
        auth.clearAttempts(key);
        setSessionCookie(req, res, auth.signSession({ who: who.who, kind: who.kind, email: who.email }, secret));
        res.json({ ok: true, who: who.who });
    });

    router.post('/logout', (req, res) => {
        clearSessionCookie(req, res);
        res.json({ ok: true });
    });

    // ── Sign in with Google ──────────────────────────────────────────────────
    // Two halves of one round trip. Anything that goes wrong sends the person back to the login
    // page with a plain-English reason rather than a bare error, because this is the front door.
    const backToLogin = (res, message) => res.redirect(302, '/login.html?error=' + encodeURIComponent(message));

    router.get('/auth/google', async (req, res) => {
        if (!googleAuth.isConfigured()) return backToLogin(res, 'Google sign-in is not set up on this site.');
        const { users } = await loadUsers(storage);
        const secret = sessionSecret(users);
        if (!secret) return backToLogin(res, 'Sign-in is not set up on this site.');
        const url = googleAuth.authUrl(req, googleAuth.makeState(secret, auth.safeNextPath(req.query.next)));
        if (!url) return backToLogin(res, 'Google sign-in is not set up on this site.');
        return res.redirect(302, url);
    });

    router.get('/auth/google/callback', async (req, res) => {
        const { users, ok } = await loadUsers(storage);
        if (!ok) return backToLogin(res, 'Cannot check logins right now. Try again shortly.');
        const secret = sessionSecret(users);

        // The signed state proves this callback belongs to a sign-in THIS app started. Without
        // it, anyone could hand the callback a code and be issued a session.
        const state = secret && googleAuth.readState(req.query.state, secret);
        if (!state) return backToLogin(res, 'That sign-in took too long. Please try again.');
        if (req.query.error) return backToLogin(res, 'Google sign-in was cancelled.');

        let identity = null;
        try { identity = await googleAuth.identityFromCode(req, req.query.code); }
        catch (e) { console.warn('Google sign-in failed:', e.message); }
        if (!identity) return backToLogin(res, 'Google could not confirm who you are.');

        const known = users.find((u) => String(u.email || '').toLowerCase() === identity.email);
        if (!known && !googleAuth.allowedByDomain(identity.email)) {
            // Deliberately names the address: the usual reason is signing in with a personal
            // account by mistake, and "not allowed" alone leaves people stuck.
            return backToLogin(res, identity.email + ' is not allowed to use this site.');
        }

        setSessionCookie(req, res, auth.signSession({
            who: (known && known.name) || identity.name,
            kind: 'google',
            email: identity.email,
        }, secret));
        return res.redirect(302, auth.safeNextPath(state.n));
    });

    // Lets the login page show who is signed in. Deliberately says nothing about WHY someone is
    // not: "configured" is reported only as a true/false the owner needs to see on their own
    // login screen, and it never becomes false because a storage read failed.
    router.get('/me', async (req, res) => {
        const { users, ok } = await loadUsers(storage);
        const secret = sessionSecret(users);
        const session = secret && auth.verifySession(auth.readCookie(req, auth.SESSION_COOKIE), secret);
        res.json({
            configured: auth.authIsConfigured(users) || !ok,
            signedIn: !!session,
            who: session ? session.who : null,
            email: session ? (session.email || null) : null,
            people: Array.isArray(users) ? users.length : 0,
            google: googleAuth.isConfigured(),      // whether to offer the Google button
            // What this person may do, for the app to hide what they can't. The server checks
            // every one of these again on the route itself; this only shapes the page.
            permissions: !ok ? [] : (!auth.authIsConfigured(users) ? perms.ALL.slice()
                : (session ? perms.effectivePermissions(users, session.email || null) : [])),
            permissionsKnown: !!ok,
            listsOn: perms.listsOn(users),
        });
    });

    return router;
}

/**
 * The people-management routes: list, add, remove. Deliberately a SEPARATE router from
 * createAuthRouter, and mounted AFTER the gate in server.js rather than before it.
 *
 * createAuthRouter is mounted before the gate on purpose — signing in has to work before there
 * is a session to check. Managing the list of who can sign in is the opposite: it must never run
 * before the gate, or it would manage itself unprotected regardless of configuration. Mounting it
 * after the gate means req.user is already set, and the normal "not configured yet" bootstrap
 * (the site is open until the first person is added) is what makes the very first person addable
 * at all — closing over itself the moment they are.
 */
function createPeopleRouter({ storage }) {
    const router = express.Router();
    const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Only someone with "Manage people" changes the list (anyone signed in while nobody has it
    // yet — see utils/permissions.js). Checked on the server: the page hiding a button is not a lock.
    function refuseUnlessManager(req, res, users) {
        if (req.authOpen || roles.canManagePeople(users, req.user && req.user.email)) return false;
        res.status(403).json({ error: 'Only someone allowed to manage people can change this.' });
        return true;
    }
    function refuseIfNoAdminLeft(res, before, after) {
        if (!roles.leavesNoAdmin(before, after)) return false;
        res.status(400).json({ error: 'Someone must always be able to manage people. Tick "Manage people" for someone else first.' });
        return true;
    }
    // Every change is made on a FRESH read of the list, never this instance's minute-old copy —
    // otherwise two people changing ticks at nearly the same time would undo each other.
    async function loadFresh() {
        forgetUsers();
        return loadUsers(storage);
    }
    // One person's ticks set, with role:'admin' kept in step for older code that still reads it.
    function withPermissions(user, list) {
        const copy = Object.assign({}, user, { permissions: perms.cleanPermissions(list) });
        if (copy.permissions.includes('managePeople')) copy.role = 'admin'; else delete copy.role;
        return copy;
    }
    async function savePeople(res, next) {
        try { await storage.saveText(CONFIG_KEY_USERS, JSON.stringify(next, null, 2)); }
        catch (e) { res.status(503).json({ error: 'Could not save. Try again shortly.' }); return false; }
        forgetUsers();
        return true;
    }

    // A GET while the site is unconfigured is a fair question (has the login already been set
    // up?), and returning it plainly here is what lets the login page and this page agree.
    router.get('/people', async (req, res) => {
        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        const you = (req.user && req.user.email) || null;
        res.json({
            you,
            youCanManage: !!req.authOpen || roles.canManagePeople(users, you),
            hasAdmin: roles.adminCount(users) > 0,
            listsOn: perms.listsOn(users),
            catalog: perms.PERMISSIONS,
            people: users.map((u) => ({
                role: roles.roleOf(u),
                permissions: perms.permissionsOf(u),
                name: u.name || u.email,
                email: u.email,
                // Computed from what is stored, not stored itself: a person added with --google
                // (or through this page's Google option) has no hash at all, which is the only
                // signal there is — and the only one that needs to be, since nothing else reads it.
                kind: u.hash ? 'password' : 'google',
            })),
        });
    });

    router.post('/people', express.json(), async (req, res) => {
        const { users, ok } = await loadFresh();
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        if (refuseUnlessManager(req, res, users)) return;

        const name = String((req.body && req.body.name) || '').trim();
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        const method = (req.body && req.body.method) === 'password' ? 'password' : 'google';
        if (!name) return res.status(400).json({ error: 'Enter a name.' });
        if (!EMAIL_RX.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

        let record;
        if (method === 'password') {
            const password = String((req.body && req.body.password) || '');
            const confirm = String((req.body && req.body.confirmPassword) || '');
            if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
            if (password !== confirm) return res.status(400).json({ error: 'Those passwords did not match.' });
            record = { name, email, hash: auth.hashPassword(password) };
        } else {
            // No hash at all — matches tools/manage-users.js --google. authenticate() still runs
            // a throwaway hash for anyone without one, so trying a password against this person
            // takes the same time as any other attempt and fails; "has no password" cannot be
            // discovered by timing it.
            record = { name, email };
        }

        // Ticks: what was sent, else (someone already on the list) what they had, else the staff
        // default. Re-adding a person to change how they sign in must not strip their ticks.
        const existing = users.find((u) => roles.sameEmail(u && u.email, email));
        const sent = Array.isArray(req.body && req.body.permissions) ? req.body.permissions
            : (roles.parseRole(req.body && req.body.role) === 'admin' ? perms.ALL : null);
        record = withPermissions(record, sent || (existing ? perms.permissionsOf(existing) : perms.STAFF_DEFAULT));

        const next = users.filter((u) => String(u.email || '').toLowerCase() !== email);
        next.push(record);
        if (refuseIfNoAdminLeft(res, users, next)) return;
        if (!(await savePeople(res, next))) return;

        // Adding a password-based person changes every hash mixed into the signing key, which
        // would otherwise sign the person doing the adding straight out mid-task. Reissuing under
        // the new key, for the same identity, keeps them signed in through their own change.
        reissueIfPossible(req, res, next);
        res.json({ ok: true });
    });

    router.post('/people/remove', express.json(), async (req, res) => {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'No email given.' });

        // NEVER LOCK THE OWNER OUT applies here too. This is the one rule the UI cannot be
        // trusted to enforce on its own — a stale page, a replayed request, a second tab — so it
        // is checked again on the server, against who the session actually says you are.
        const you = (req.user && req.user.email) || null;
        if (you && you.toLowerCase() === email) {
            return res.status(400).json({ error: 'You cannot remove yourself. Ask someone else to.' });
        }

        const { users, ok } = await loadFresh();
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        if (refuseUnlessManager(req, res, users)) return;
        const next = users.filter((u) => String(u.email || '').toLowerCase() !== email);
        if (next.length === users.length) return res.status(404).json({ error: 'No one there with that email.' });
        if (refuseIfNoAdminLeft(res, users, next)) return;
        if (!(await savePeople(res, next))) return;

        reissueIfPossible(req, res, next);
        res.json({ ok: true });
    });

    // A new password for someone who signs in with one. An admin may set anyone's; anyone may set
    // their own. Like adding or removing a person, it changes the signing key, so everyone else
    // signs in once more; the person doing it stays signed in.
    router.post('/people/password', express.json(), async (req, res) => {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        const { users, ok } = await loadFresh();
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        const self = roles.sameEmail(req.user && req.user.email, email);
        if (!self && refuseUnlessManager(req, res, users)) return;
        const person = users.find((u) => roles.sameEmail(u && u.email, email));
        if (!person) return res.status(404).json({ error: 'No one there with that email.' });
        if (!person.hash) return res.status(400).json({ error: (person.name || email) + ' signs in with Google and has no password.' });
        const problem = reset.passwordProblem(req.body.password, req.body.confirmPassword);
        if (problem) return res.status(400).json({ error: problem });
        const next = reset.withNewHash(users, email, auth.hashPassword(String(req.body.password)));
        if (!(await savePeople(res, next))) return;
        reissueIfPossible(req, res, next);
        res.json({ ok: true });
    });

    // One person's ticks. The password hash is untouched, so nobody is signed out by this.
    router.post('/people/permissions', express.json(), async (req, res) => {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        const list = req.body && req.body.permissions;
        if (!email || !Array.isArray(list)) return res.status(400).json({ error: 'Give an email and a list of permissions.' });
        await setPermissions(req, res, email, list);
    });

    // Older pages: "admin" is every tick, "staff" the staff default.
    router.post('/people/role', express.json(), async (req, res) => {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        const role = roles.parseRole(req.body && req.body.role);
        if (!email || !role) return res.status(400).json({ error: 'Give an email and a role (admin or staff).' });
        await setPermissions(req, res, email, role === 'admin' ? perms.ALL : perms.STAFF_DEFAULT);
    });

    async function setPermissions(req, res, email, list) {
        const { users, ok } = await loadFresh();
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        if (refuseUnlessManager(req, res, users)) return;
        if (!users.some((u) => roles.sameEmail(u && u.email, email))) return res.status(404).json({ error: 'No one there with that email.' });
        const next = users.map((u) => (roles.sameEmail(u && u.email, email) ? withPermissions(u, list) : u));
        if (refuseIfNoAdminLeft(res, users, next)) return;
        if (!(await savePeople(res, next))) return;
        const saved = next.find((u) => roles.sameEmail(u.email, email));
        res.json({ ok: true, permissions: perms.permissionsOf(saved) });
    }

    // Re-signs the acting person's own cookie under the secret the NEW list produces, so changing
    // the people list does not also sign out whoever just changed it. Silently does nothing for a
    // shared-password session (no identity to reissue) or if signing somehow fails — worst case
    // that visitor is asked to sign in again, which is safe, never a way through.
    function reissueIfPossible(req, res, newUsers) {
        if (!req.user || !req.user.kind) return;
        try {
            const secret = sessionSecret(newUsers);
            if (!secret) return;
            setSessionCookie(req, res, auth.signSession(
                { who: req.user.who, kind: req.user.kind, email: req.user.email }, secret));
        } catch (e) { /* they will simply be asked to sign in again — never a way through */ }
    }

    return router;
}

module.exports = {
    createAuthRouter,
    createAuthGate,
    createPeopleRouter,
    loadUsers,
    _test: { sessionSecret, forgetUsers, loadUsers, hasIngestSecret },
};
