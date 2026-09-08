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
    const base = String(process.env.SESSION_SECRET || '').trim() || auth.sharedPassword() || '';
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
                req.user = { who: session.who, kind: session.kind };
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
        setSessionCookie(req, res, auth.signSession({ who: who.who, kind: who.kind }, secret));
        res.json({ ok: true, who: who.who });
    });

    router.post('/logout', (req, res) => {
        clearSessionCookie(req, res);
        res.json({ ok: true });
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
            people: Array.isArray(users) ? users.length : 0,
        });
    });

    return router;
}

module.exports = { createAuthRouter, createAuthGate, _test: { sessionSecret, forgetUsers, loadUsers, hasIngestSecret } };
