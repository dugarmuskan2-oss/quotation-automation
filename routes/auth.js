'use strict';

/**
 * routes/auth.js — the login routes, and the gate that stands in front of everything else.
 *
 * The gate is mounted BEFORE every other route and before the static file server, so a route
 * added later is protected without anyone remembering to protect it. What stays open is the
 * short list in utils/auth.js, not a list kept here.
 *
 * Two ways in, both live at once (see utils/auth.js): one shared password, or named people.
 */

const express = require('express');
const crypto = require('crypto');
const { CONFIG_KEY_USERS } = require('../utils/constants');
const auth = require('../utils/auth');

// Reading the people list from cloud storage on EVERY request would add a network round trip to
// every page and every save. Held briefly instead; a minute-old list is fine for a list that
// changes a few times a year, and losing it on a cold start costs one read.
let cachedUsers = null;
let cachedAt = 0;
const USERS_TTL_MS = 60 * 1000;

async function loadUsers(storage) {
    if (cachedUsers && Date.now() - cachedAt < USERS_TTL_MS) return cachedUsers;
    try {
        const raw = await storage.readText(CONFIG_KEY_USERS);
        const parsed = raw ? JSON.parse(raw) : [];
        cachedUsers = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // A storage hiccup must not become "everyone is locked out" — but it must not become
        // "everyone is let in" either. An empty list means the shared password still works.
        console.warn('users.json could not be read:', e.message);
        cachedUsers = [];
    }
    cachedAt = Date.now();
    return cachedUsers;
}

function forgetUsers() { cachedUsers = null; cachedAt = 0; }

/** What signs the session cookie. Derived from the shared password when nothing else is set, so
 *  changing the password also invalidates every cookie issued under the old one. */
function sessionSecret() {
    const explicit = String(process.env.SESSION_SECRET || '').trim();
    if (explicit) return explicit;
    const shared = auth.sharedPassword();
    if (shared) return crypto.createHash('sha256').update('dsc-session:' + shared).digest('hex');
    return null;
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

/** The gate. Everything not on the public list needs a valid session. */
function createAuthGate({ storage }) {
    let warned = false;
    return async function authGate(req, res, next) {
        if (auth.isPublicRequest(req.method, req.path, req.query)) return next();

        const users = await loadUsers(storage);
        if (!auth.authIsConfigured(users)) {
            // Nothing is set up yet. Standing aside is deliberate — a half-configured login must
            // not take a live business offline — but it is said out loud, every boot, so that
            // "we added a login" can never quietly mean "there is still no login".
            if (!warned) {
                warned = true;
                console.warn('SECURITY: no APP_PASSWORD and no users.json — the app is OPEN to anyone with the address.');
            }
            res.setHeader('X-Auth-Status', 'not-configured');
            return next();
        }

        const secret = sessionSecret();
        const session = secret && auth.verifySession(auth.readCookie(req, auth.SESSION_COOKIE), secret);
        if (session) {
            req.user = { who: session.who, kind: session.kind };
            return next();
        }
        if (wantsHtml(req)) {
            // Send them back where they were headed once they are in. Only ever a path from this
            // request, never anything a link could put in the query string.
            const back = encodeURIComponent(req.originalUrl || '/');
            return res.redirect(302, '/login.html?next=' + back);
        }
        return res.status(401).json({ error: 'Not signed in' });
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
        const users = await loadUsers(storage);
        if (!auth.authIsConfigured(users)) {
            return res.status(503).json({ error: 'No password has been set up for this site yet.' });
        }
        const who = auth.authenticate(name, password, users);
        if (!who) {
            auth.noteFailedAttempt(key);
            return res.status(401).json({ error: 'That did not work.' });   // never say WHICH part
        }
        const secret = sessionSecret();
        if (!secret) return res.status(500).json({ error: 'Sessions are not configured.' });
        auth.clearAttempts(key);
        setSessionCookie(req, res, auth.signSession({ who: who.who, kind: who.kind }, secret));
        res.json({ ok: true, who: who.who });
    });

    router.post('/logout', (req, res) => {
        clearSessionCookie(req, res);
        res.json({ ok: true });
    });

    // Lets the page show who is signed in, and whether a password is set at all.
    router.get('/me', async (req, res) => {
        const users = await loadUsers(storage);
        const secret = sessionSecret();
        const session = secret && auth.verifySession(auth.readCookie(req, auth.SESSION_COOKIE), secret);
        res.json({
            configured: auth.authIsConfigured(users),
            signedIn: !!session,
            who: session ? session.who : null,
            people: Array.isArray(users) ? users.length : 0,
        });
    });

    return router;
}

module.exports = { createAuthRouter, createAuthGate, _test: { sessionSecret, forgetUsers, loadUsers } };
