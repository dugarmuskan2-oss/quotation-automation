'use strict';

/**
 * utils/passwordReset.js — "Forgot password?" links, and setting a password.
 *
 * The owner's rule (16 Oct 2026): every reset link goes to the office mailbox (COMPANY_EMAIL,
 * info@dscpipes.com), sent from it, whoever asked. The owner passes it on. So a stranger typing
 * someone's email can only ever make the office receive an email — never a way in.
 *
 * The link is signed, not stored. It carries the email and an expiry, signed together with that
 * person's CURRENT password hash. Setting a password changes the hash, so a used link stops
 * working by itself (one use), and an old link dies the moment the password changes any other way.
 *
 * Pure module: no I/O.
 */

const crypto = require('crypto');

const RESET_TTL_MS = 30 * 60 * 1000;
const MIN_PASSWORD = 8;

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64url'); }
function unb64(s) { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch (e) { return ''; } }

function sign(body, userHash, secret) {
    return crypto.createHmac('sha256', String(secret)).update(body + '|' + String(userHash || '')).digest('base64url');
}

function findPerson(users, email) {
    const e = String(email || '').trim().toLowerCase();
    return (Array.isArray(users) ? users : []).find((u) => u && String(u.email || '').toLowerCase() === e) || null;
}

/** A reset token for a person who signs in with a password, or null (unknown, or Google-only). */
function makeResetToken(users, email, secret, nowMs) {
    const person = findPerson(users, email);
    if (!person || !person.hash || !secret) return null;
    const body = b64(JSON.stringify({ e: person.email.toLowerCase(), x: (nowMs || Date.now()) + RESET_TTL_MS }));
    return body + '.' + sign(body, person.hash, secret);
}

/** The person a token is for, or null when it is forged, expired, or already used. */
function readResetToken(users, token, secret, nowMs) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !secret) return null;
    let data;
    try { data = JSON.parse(unb64(body)); } catch (e) { return null; }
    if (!data || !data.e || !(data.x > (nowMs || Date.now()))) return null;
    const person = findPerson(users, data.e);
    if (!person || !person.hash) return null;
    const expected = sign(body, person.hash, secret);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return person;
}

/** null when the two typed passwords are fine, else the reason in plain words. */
function passwordProblem(password, confirm) {
    const p = String(password || '');
    if (p.length < MIN_PASSWORD) return 'Use a password of at least ' + MIN_PASSWORD + ' characters.';
    if (p !== String(confirm || '')) return 'Those passwords did not match.';
    return null;
}

/** The people list with one person's password hash replaced (a copy; the input is not changed). */
function withNewHash(users, email, hash) {
    return users.map((u) => (findPerson([u], email) ? Object.assign({}, u, { hash }) : u));
}

/** The email the office receives. Names who it is for and how long the link lasts. */
function resetEmailHtml(person, link, askedAt) {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return '<p>Someone asked to reset the password for <b>' + esc(person.name || person.email) + '</b> (' + esc(person.email) + ')'
        + (askedAt ? ' on ' + esc(askedAt) : '') + '.</p>'
        + '<p>If that was them, send them this link. It works <b>once</b>, for <b>30 minutes</b>:</p>'
        + '<p><a href="' + esc(link) + '">' + esc(link) + '</a></p>'
        + '<p>If nobody asked, ignore this email — nothing changes until the link is used.</p>';
}

module.exports = { makeResetToken, readResetToken, passwordProblem, withNewHash, resetEmailHtml, RESET_TTL_MS, MIN_PASSWORD };
