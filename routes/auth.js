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
const { CONFIG_KEY_USERS } = require('../utils/constants');
const auth = require('../utils/auth');
const googleAuth = require('../utils/googleAuth');

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
                return next();
            }

            const secret = sessionSecret(users);
            const session = secret && auth.verifySession(auth.readCookie(req, auth.SESSION_COOKIE), secret);
            if (session) {
                req.user = { who: session.who, kind: session.kind, email: session.email || null };
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

function createAuthRouter({ storage }) {
    const router = express.Router();

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

    // A GET while the site is unconfigured is a fair question (has the login already been set
    // up?), and returning it plainly here is what lets the login page and this page agree.
    router.get('/people', async (req, res) => {
        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        res.json({
            you: (req.user && req.user.email) || null,
            people: users.map((u) => ({
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
        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });

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

        const next = users.filter((u) => String(u.email || '').toLowerCase() !== email);
        next.push(record);
        try { await storage.saveText(CONFIG_KEY_USERS, JSON.stringify(next, null, 2)); }
        catch (e) { return res.status(503).json({ error: 'Could not save. Try again shortly.' }); }
        forgetUsers();

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

        const { users, ok } = await loadUsers(storage);
        if (!ok) return res.status(503).json({ error: 'Cannot read the people list right now. Try again shortly.' });
        const next = users.filter((u) => String(u.email || '').toLowerCase() !== email);
        if (next.length === users.length) return res.status(404).json({ error: 'No one there with that email.' });

        try { await storage.saveText(CONFIG_KEY_USERS, JSON.stringify(next, null, 2)); }
        catch (e) { return res.status(503).json({ error: 'Could not save. Try again shortly.' }); }
        forgetUsers();

        reissueIfPossible(req, res, next);
        res.json({ ok: true });
    });

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
    _test: { sessionSecret, forgetUsers, loadUsers, hasIngestSecret },
};
