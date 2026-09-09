'use strict';

/**
 * utils/auth.js — who is allowed in.
 *
 * Before this existed the app had no login at all: anyone with the web address could read all
 * 2,541 quotes, including the margin and buying rate on every line, send email as the company,
 * and delete things. The address is not a secret either — every Copy Link sent to a customer is
 * a working address for the whole app with a query string on the end.
 *
 * Two ways in, and both can be on at once:
 *   - ONE SHARED PASSWORD (APP_PASSWORD), typed once per device. Closes the door in a minute.
 *   - PER-PERSON accounts (users.json in storage), which also record WHO did something.
 *
 * Three rules this file is built around:
 *
 *   1. DENY BY DEFAULT. Every route is protected unless it is on the short public list below.
 *      A route added later and forgotten therefore breaks loudly rather than leaking quietly —
 *      the failure everyone notices, instead of the one nobody does.
 *
 *   2. CUSTOMERS MUST NOT NEED A PASSWORD. A shared quote link is sent to people outside the
 *      company. That page, and only the handful of things it fetches, stay open.
 *
 *   3. NEVER LOCK THE OWNER OUT. With no password and no users configured the gate stands aside
 *      and says so, loudly, on every boot. A half-finished security feature must not take a
 *      live business offline; it just has to be honest that it is not doing anything yet.
 *
 * No new dependency: scrypt and HMAC both come from node's own crypto.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'dsc_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;          // a month, so nobody retypes it daily

// ── Passwords ────────────────────────────────────────────────────────────────────────────────

/** Hash a password for storage: "salt:key", scrypt. */
function hashPassword(password, existingSalt) {
    const salt = existingSalt || crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return salt + ':' + key;
}

/** Compare in constant time, so the answer takes the same time whether the first letter is
 *  wrong or only the last one is — otherwise the timing itself leaks the password. */
function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ab.length !== bb.length || ab.length === 0) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function verifyPassword(password, stored) {
    const s = String(stored == null ? '' : stored);
    if (!password || s.indexOf(':') < 0) return false;
    const salt = s.slice(0, s.indexOf(':'));
    const key = s.slice(s.indexOf(':') + 1);
    let candidate;
    try { candidate = crypto.scryptSync(String(password), salt, 64).toString('hex'); }
    catch (e) { return false; }
    return timingSafeEqualStr(candidate, key);
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────
// A signed token, not an id in a table: the app runs as separate serverless invocations with no
// shared memory, so anything held server-side would be forgotten between requests.

function signSession(payload, secret, ttlSeconds) {
    const exp = Math.floor(Date.now() / 1000) + (ttlSeconds || DEFAULT_TTL_SECONDS);
    const body = Buffer.from(JSON.stringify(Object.assign({}, payload, { exp })), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
    return body + '.' + sig;
}

/** The session inside a token, or null if it is forged, tampered with, or out of date. */
function verifySession(token, secret) {
    if (!token || !secret) return null;
    const t = String(token);
    const dot = t.lastIndexOf('.');
    if (dot < 1) return null;
    const body = t.slice(0, dot);
    const expected = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
    if (!timingSafeEqualStr(t.slice(dot + 1), expected)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch (e) { return null; }
    if (!data || typeof data.exp !== 'number') return null;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
}

function readCookie(req, name) {
    const raw = (req && req.headers && req.headers.cookie) || '';
    for (const part of String(raw).split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        const value = part.slice(eq + 1).trim();
        // decodeURIComponent throws on a stray percent sign, and this runs inside async
        // middleware where a thrown error is an unhandled rejection — one request with
        // `Cookie: dsc_session=%` would have taken the whole server down.
        try { return decodeURIComponent(value); }
        catch (e) { return value; }         // undecodable means it is not one of ours; it will fail the signature
    }
    return null;
}

/** Where a "come back here after signing in" value is allowed to point: a path on this site and
 *  nothing else. Rejects "//evil.com", and "/\evil.com" too — every browser's URL parser treats a
 *  backslash like a slash, so the obvious first-character check lets a whole-site redirect
 *  through. Also rejects control characters, which can be used to smuggle past a naive check. */
function safeNextPath(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s || s[0] !== '/') return '/';
    if (/[\\\u0000-\u001F\u007F]/.test(s)) return '/';
    if (s[1] === '/') return '/';                      // "//evil.com" is another site
    return s;
}

// ── What stays open ──────────────────────────────────────────────────────────────────────────

// Files the browser must fetch to draw ANY page, including the login page and a customer's
// quote link. Everything else in the project root stops being downloadable — server.js,
// storage/index.js and CLAUDE.md were all being served to anyone who asked.
const PUBLIC_FILES = new Set([
    '/logo.png', '/favicon.ico', '/styles.css', '/login.html',
    '/utils/pipeWeights.js', '/gmail-ingest/descriptionFormatter.js',
    '/weight-calculator.js', '/enquiry-preparer.js', '/freight-tab-weight-editor.js',
    '/quote-enquiry-tab.js', '/register.js', '/partner-directory.js',
]);

// Endpoints a customer's quote link genuinely needs, and the machine-to-machine ones that carry
// their own secret. Deliberately short, and deliberately not a prefix match: "/api/quotations"
// (the list of all 2,541) must NOT be reachable just because "/api/quotations/123" is.
const PUBLIC_API_EXACT = new Set([
    '/api/login', '/api/logout', '/api/me',
    // Signing in with Google happens BEFORE there is a session, so both ends of that round trip
    // have to be reachable without one. Neither hands anything over: the first only redirects to
    // Google, and the second refuses any code that did not come from a request this app started.
    '/api/auth/google', '/api/auth/google/callback',
    '/api/health',
    '/api/company',                 // the letterhead address on a shared quote's PDF
    '/api/ingest-from-gmail',       // Apps Script, checked against INGEST_SECRET
    '/ingest-from-gmail',
]);

// One quote by id, for a link sent to a customer. NOT the list, the search or the filter.
const PUBLIC_API_PATTERNS = [
    /^\/api\/quotations\/[^/]+$/,
    /^\/api\/quotations\/[^/]+\/pdf$/,
];

/** Is this request allowed through without a session? */
function isPublicRequest(method, pathname, query) {
    const p = String(pathname || '').replace(/\/+$/, '') || '/';
    // The shared quote page itself. index.html serves both the app and the customer view, so the
    // query string is the only thing that tells them apart — and it is visible here.
    if ((p === '/' || p === '/index.html') && query && String(query.view) === 'pdf') return true;
    if (PUBLIC_FILES.has(p)) return true;
    if (PUBLIC_API_EXACT.has(p)) return true;
    if (String(method).toUpperCase() === 'GET' && PUBLIC_API_PATTERNS.some((rx) => rx.test(p))) return true;
    return false;
}

// ── Who is configured ────────────────────────────────────────────────────────────────────────

/** The shared password, or null. Held as a plain env var on purpose: it is one secret set by the
 *  owner in the hosting dashboard, and a hash there would just be a password they cannot read. */
function sharedPassword() {
    const v = String(process.env.APP_PASSWORD || '').trim();
    return v ? v : null;
}

/** True when nothing is configured — the gate then stands aside rather than locking everyone out. */
function authIsConfigured(users) {
    return !!sharedPassword() || (Array.isArray(users) && users.length > 0);
}

/** Check a login against the per-person list first, then the shared password.
 *  Returns the session to issue, or null. */
function authenticate(name, password, users) {
    if (!password) return null;
    const list = Array.isArray(users) ? users : [];
    const typed = String(name == null ? '' : name).trim().toLowerCase();
    if (typed) {
        const person = list.find((u) => u && (String(u.email || '').toLowerCase() === typed
                                           || String(u.name || '').toLowerCase() === typed));
        // A wrong name still runs a hash, so "no such person" and "wrong password" take the
        // same time and cannot be told apart from outside.
        const stored = (person && person.hash) || hashPassword('not-a-real-password');
        if (person && verifyPassword(password, stored)) {
            return { who: person.name || person.email, kind: 'person', email: person.email };
        }
        if (person) return null;      // named someone real and got it wrong: do not fall through
    }
    const shared = sharedPassword();
    // No email on a shared-password session — it identifies no one in particular, which is the
    // whole difference between this and a named login. Callers that need to tell "me" from
    // "someone else" (removing a person from the list) must treat a null email as "not them".
    if (shared && timingSafeEqualStr(password, shared)) return { who: 'shared', kind: 'shared', email: null };
    return null;
}

// ── Too many guesses ─────────────────────────────────────────────────────────────────────────
// Best-effort only: each serverless invocation has its own memory, so this slows a burst from
// one machine rather than being a hard limit. Better than nothing, and honest about which.
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

function tooManyAttempts(key) {
    const now = Date.now();
    const rec = attempts.get(key);
    if (!rec || now > rec.resetAt) return false;
    return rec.count >= MAX_ATTEMPTS;
}

function noteFailedAttempt(key) {
    const now = Date.now();
    const rec = attempts.get(key);
    if (!rec || now > rec.resetAt) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    else rec.count++;
    if (attempts.size > 5000) attempts.clear();          // never let this become the memory leak
}

function clearAttempts(key) { attempts.delete(key); }

module.exports = {
    SESSION_COOKIE,
    DEFAULT_TTL_SECONDS,
    hashPassword,
    verifyPassword,
    signSession,
    verifySession,
    readCookie,
    safeNextPath,
    isPublicRequest,
    sharedPassword,
    authIsConfigured,
    authenticate,
    tooManyAttempts,
    noteFailedAttempt,
    clearAttempts,
    PUBLIC_FILES,
    _test: { timingSafeEqualStr, PUBLIC_API_EXACT, PUBLIC_API_PATTERNS },
};
