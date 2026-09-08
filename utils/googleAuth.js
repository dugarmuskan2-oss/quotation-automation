'use strict';

/**
 * utils/googleAuth.js — "Sign in with Google".
 *
 * The same Google project the app already uses to send email, so there is nothing new to sign up
 * for. The two flows are unrelated though, and worth keeping straight:
 *
 *   sending  — one long-lived refresh token for ONE mailbox, so the app can send as the company.
 *   signing in — a fresh, short exchange that answers one question: who is this person?
 *
 * Nothing from the sign-in is kept. No token is stored, no mailbox is read; the email address
 * comes out, the session is issued, and the Google credentials are thrown away.
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

/**
 * Where Google sends people back to. It has to match what is registered in the Google Cloud
 * console CHARACTER FOR CHARACTER, and the two deployments live at different addresses — so it
 * is built from the request that is actually happening rather than from a guess or a constant.
 * PUBLIC_URL overrides it for the case where the app sits behind something that rewrites Host.
 */
function callbackUrl(req) {
    const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured + '/api/auth/google/callback';
    const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return proto + '://' + host + '/api/auth/google/callback';
}

function isConfigured() {
    return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

function clientFor(req) {
    if (!isConfigured()) return null;
    return new OAuth2Client(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, callbackUrl(req));
}

/** Where to send someone to sign in. `state` comes back untouched and is how the callback knows
 *  the request started here — without it, anyone could feed the callback a code of their own. */
function authUrl(req, state) {
    const client = clientFor(req);
    if (!client) return null;
    return client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],   // who you are, and nothing else
        state,
        prompt: 'select_account',                // always ask WHICH account, never silently reuse
    });
}

/** Turn the code Google sent back into a verified email address, or null. */
async function identityFromCode(req, code) {
    const client = clientFor(req);
    if (!client || !code) return null;
    const { tokens } = await client.getToken(String(code));
    if (!tokens || !tokens.id_token) return null;
    // Verifying the id_token is the step that matters: it checks Google's signature and that the
    // token was issued for THIS app. Reading the email straight out of the token without this
    // would accept one minted by anybody.
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GMAIL_CLIENT_ID });
    const payload = ticket && ticket.getPayload();
    if (!payload || !payload.email) return null;
    if (payload.email_verified === false) return null;
    return { email: String(payload.email).toLowerCase(), name: payload.name || payload.email };
}

/** Company addresses may sign in with Google without being added by hand first. Anyone else has
 *  to be on the people list. Set ALLOWED_EMAIL_DOMAINS to "" to turn the domain rule off. */
function allowedByDomain(email) {
    const raw = process.env.ALLOWED_EMAIL_DOMAINS;
    const domains = String(raw === undefined ? 'dscpipes.com' : raw)
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!domains.length) return false;
    const at = String(email || '').lastIndexOf('@');
    if (at < 0) return false;
    return domains.indexOf(String(email).toLowerCase().slice(at + 1)) >= 0;
}

// ── The state parameter ──────────────────────────────────────────────────────────────────────
// Signed, short-lived, and carries where to go afterwards. Signed so the callback can tell its
// own redirect from one somebody else started; short-lived so a stale link cannot be replayed.

function makeState(secret, nextPath) {
    const body = Buffer.from(JSON.stringify({
        n: nextPath || '/',
        t: Date.now(),
        r: crypto.randomBytes(8).toString('hex'),
    }), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
    return body + '.' + sig;
}

function readState(state, secret, maxAgeMs) {
    if (!state || !secret) return null;
    const s = String(state);
    const dot = s.lastIndexOf('.');
    if (dot < 1) return null;
    const expected = crypto.createHmac('sha256', String(secret)).update(s.slice(0, dot)).digest('base64url');
    const got = Buffer.from(s.slice(dot + 1), 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(s.slice(0, dot), 'base64url').toString('utf8')); }
    catch (e) { return null; }
    if (!data || typeof data.t !== 'number') return null;
    if (Date.now() - data.t > (maxAgeMs || 10 * 60 * 1000)) return null;
    return data;
}

module.exports = {
    isConfigured,
    callbackUrl,
    authUrl,
    identityFromCode,
    allowedByDomain,
    makeState,
    readState,
};
