'use strict';

/**
 * routes/appraisal.js — the staff performance appraisal.
 *
 * Who is who comes from the People list (users.json): an ADMIN is the manager, everyone else is
 * staff. Unlike the People page, there is no "until someone is an admin, everyone may manage"
 * window here — scores are private, so with no admin nobody sees anyone else's.
 *
 * Storage is split BY WHO WRITES IT, so a staff member and an admin can never overwrite each other:
 *   appraisal-setup.json        roles, items, weights, scale, raise table   (admins)
 *   appraisal-self-<slug>.json  a person's own quarterly self-reviews       (that person only)
 *   appraisal-mgr-<slug>.json   roles/targets, admin scores, 6-month notes  (admins only)
 * Staff are only ever sent their own self-reviews plus their roles and targets — never a score
 * an admin gave.
 *
 * Every save changes ONE entry (one quarter, one meeting, the profile) inside its file, and is
 * refused with 409 when that entry changed since the browser loaded it (`baseSavedAt`). A tab left
 * open overnight cannot put back yesterday's scores over today's.
 */

const express = require('express');
const { APPRAISAL_KEY_PREFIX } = require('../utils/constants');
const roles = require('../utils/peopleRoles');
const A = require('../utils/appraisal');

const STALE_MSG = 'Someone saved this since you opened it. Reload the page to see the latest, then make your change again.';

/**
 * The testing site (a Vercel preview build) shares the live site's storage, and nobody has a
 * named login there yet (it has no sign-in at all). So on the testing site only, anyone without a
 * named login gets a test manager,
 * and everything it saves goes to separate "preview-" files that the live site never reads.
 */
function isTestSite() { return process.env.VERCEL_ENV === 'preview'; }
const TEST_MANAGER = { name: 'Test manager (testing site)', email: 'test-manager@testing-site' };
// The testing site has no People list, so it gets the office staff by name (no emails yet), each
// with the jobs the owner gave them. Never on the live site. `startRoles` holds only until an
// admin saves that person's roles on the Staff tab.
const ALL_JOBS = ['r_sales', 'r_admin'];
const TEST_SITE_STAFF = [
    { name: 'Pavithra', email: 'pavithra@testing-site', startRoles: ALL_JOBS },
    { name: 'Jayanthi', email: 'jayanthi@testing-site', startRoles: ALL_JOBS },
    { name: 'Ramesh', email: 'ramesh@testing-site', startRoles: ALL_JOBS },
    { name: 'Ramya', email: 'ramya@testing-site', startRoles: ALL_JOBS },
    { name: 'Kavitha', email: 'kavitha@testing-site', startRoles: ['r_admin'] },
];
function withTestSiteStaff(users) { return isTestSite() ? [...users, ...TEST_SITE_STAFF] : users; }

/** A person's saved roles, or their starting roles if nobody has saved any yet. */
function rolesOf(person, mgrDoc) {
    if (mgrDoc && mgrDoc.profileSavedAt) return mgrDoc.roles || [];
    return (person && person.startRoles) || (mgrDoc && mgrDoc.roles) || [];
}

function key(name) { return String(process.env.CONFIG_PREFIX || '').trim() + (isTestSite() ? 'preview-' : '') + APPRAISAL_KEY_PREFIX + name; }
const setupKey = () => key('setup.json');
const selfKey = (email) => key('self-' + A.personSlug(email) + '.json');
const mgrKey = (email) => key('mgr-' + A.personSlug(email) + '.json');

/** A small HTTP error a handler can throw; anything else becomes a 503. */
function fail(status, error) { const e = new Error(error); e.status = status; return e; }

function send(res, err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('appraisal route error:', err && err.message);
    return res.status(503).json({ error: 'Could not reach saved data. Try again in a moment.' });
}

/** Wraps a handler so a throw is always answered, never left hanging. */
function handle(fn) { return (req, res) => fn(req, res).catch((e) => send(res, e)); }

function createAppraisalRouter({ storage, loadUsers }) {
    const router = express.Router();

    async function readJson(k, fallback) {
        const raw = await storage.readText(k);
        if (!raw) return fallback;
        return JSON.parse(raw);
    }
    const writeJson = (k, obj) => storage.saveText(k, JSON.stringify(obj));

    async function readSetup() {
        const stored = await readJson(setupKey(), null);
        return stored ? { setup: stored, isStarter: false } : { setup: { ...A.DEFAULT_SETUP, savedAt: null }, isStarter: true };
    }

    /** The signed-in person, their People-list record, and whether they are an admin. */
    async function whoIsAsking(req) {
        const { users: people, ok } = await loadUsers(storage);
        if (!ok) throw fail(503, 'Cannot read the people list right now. Try again shortly.');
        const users = withTestSiteStaff(people);
        const email = req.user && req.user.email;
        if (!email && isTestSite()) return { users, me: TEST_MANAGER, email: TEST_MANAGER.email, isAdmin: true, testSite: true };
        if (!email) throw fail(403, 'Sign in with your own name to use the appraisal. The shared password has no name on it.');
        const me = users.find((u) => roles.sameEmail(u && u.email, email));
        if (!me) throw fail(403, 'You are not on the People list. Ask an admin to add you.');
        return { users, me, email: String(me.email).toLowerCase(), isAdmin: roles.roleOf(me) === 'admin' };
    }

    async function requireAdmin(req) {
        const who = await whoIsAsking(req);
        if (!who.isAdmin) throw fail(403, 'Only an admin can do this.');
        return who;
    }

    function personByEmail(users, email) {
        const p = users.find((u) => roles.sameEmail(u && u.email, email));
        if (!p) throw fail(404, 'That person is not on the People list.');
        return p;
    }

    /** Replace one entry in a stored map, refusing if it moved since the browser read it. */
    async function saveEntry(k, emptyDoc, mapName, entryKey, entry, baseSavedAt) {
        const doc = await readJson(k, emptyDoc);
        doc[mapName] = doc[mapName] || {};
        const current = doc[mapName][entryKey];
        if (((current && current.savedAt) || null) !== (baseSavedAt || null)) throw fail(409, STALE_MSG);
        const saved = { ...entry, savedAt: new Date().toISOString() };
        doc[mapName][entryKey] = saved;
        await writeJson(k, doc);
        return saved;
    }

    // ── Everyone ───────────────────────────────────────────────────────────

    router.get('/appraisal/me', handle(async (req, res) => {
        const who = await whoIsAsking(req);
        const { setup, isStarter } = await readSetup();
        const [self, mgr] = await Promise.all([
            readJson(selfKey(who.email), { reviews: {} }),
            readJson(mgrKey(who.email), {}),
        ]);
        const lockedQuarters = Object.keys(mgr.reviews || {}).filter((q) => mgr.reviews[q] && mgr.reviews[q].done);
        res.json({
            you: { email: who.email, name: who.me.name || who.email, isAdmin: who.isAdmin },
            hasAdmin: roles.adminCount(who.users) > 0,
            testSite: !!who.testSite,
            setup, isStarter,
            mine: { roles: mgr.roles || [], targets: mgr.targets || '', reviews: self.reviews || {}, lockedQuarters },
        });
    }));

    router.put('/appraisal/self/:quarter', express.json(), handle(async (req, res) => {
        const q = req.params.quarter;
        if (!A.isQuarterKey(q)) throw fail(400, 'That is not a quarter.');
        const who = await whoIsAsking(req);
        const { setup } = await readSetup();
        const mgr = await readJson(mgrKey(who.email), {});
        if (mgr.reviews && mgr.reviews[q] && mgr.reviews[q].done) {
            throw fail(409, 'Your manager has already finished this quarter, so it can no longer be changed.');
        }
        const review = A.sanitizeSelfReview(req.body && req.body.review, setup);
        const groups = A.groupsFor(setup, mgr.roles || []);
        const left = A.unscoredCount(groups, review.scores);
        if (left) throw fail(400, `Score every item first. ${left} still to score.`);
        review.submittedAt = new Date().toISOString();
        const saved = await saveEntry(selfKey(who.email), { email: who.email, reviews: {} }, 'reviews', q, review, req.body && req.body.baseSavedAt);
        res.json({ ok: true, review: saved });
    }));

    // ── Admins only ────────────────────────────────────────────────────────

    router.get('/appraisal/overview', handle(async (req, res) => {
        const who = await requireAdmin(req);
        const { setup, isStarter } = await readSetup();
        const people = await Promise.all(who.users.filter((u) => u && u.email).map(async (u) => {
            const [self, mgr] = await Promise.all([readJson(selfKey(u.email), { reviews: {} }), readJson(mgrKey(u.email), {})]);
            return { email: String(u.email).toLowerCase(), name: u.name || u.email, role: roles.roleOf(u), self, mgr: { ...mgr, roles: rolesOf(u, mgr) } };
        }));
        people.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ you: { email: who.email, name: who.me.name || who.email, isAdmin: true }, setup, isStarter, people });
    }));

    router.put('/appraisal/setup', express.json(), handle(async (req, res) => {
        await requireAdmin(req);
        const { setup: current } = await readSetup();
        if ((current.savedAt || null) !== ((req.body && req.body.baseSavedAt) || null)) throw fail(409, STALE_MSG);
        const clean = A.sanitizeSetup(req.body && req.body.setup);
        if (clean.error) throw fail(400, clean.error);
        const saved = { ...clean.setup, savedAt: new Date().toISOString() };
        await writeJson(setupKey(), saved);
        res.json({ ok: true, setup: saved });
    }));

    router.put('/appraisal/profile/:email', express.json(), handle(async (req, res) => {
        const who = await requireAdmin(req);
        const person = personByEmail(who.users, req.params.email);
        const { setup } = await readSetup();
        const k = mgrKey(person.email);
        const doc = await readJson(k, {});
        if ((doc.profileSavedAt || null) !== ((req.body && req.body.baseSavedAt) || null)) throw fail(409, STALE_MSG);
        const profile = A.sanitizeProfile(req.body, setup);
        const next = { ...doc, email: String(person.email).toLowerCase(), roles: profile.roles, targets: profile.targets, profileSavedAt: new Date().toISOString() };
        await writeJson(k, next);
        res.json({ ok: true, profileSavedAt: next.profileSavedAt });
    }));

    router.put('/appraisal/review/:email/:quarter', express.json(), handle(async (req, res) => {
        const q = req.params.quarter;
        if (!A.isQuarterKey(q)) throw fail(400, 'That is not a quarter.');
        const who = await requireAdmin(req);
        const person = personByEmail(who.users, req.params.email);
        const { setup } = await readSetup();
        const review = A.sanitizeManagerReview(req.body && req.body.review, setup);
        if (review.done) {
            const doc = await readJson(mgrKey(person.email), {});
            const left = A.unscoredCount(A.groupsFor(setup, rolesOf(person, doc)), review.scores);
            if (left) throw fail(400, `Score every item first. ${left} still to score.`);
        }
        const saved = await saveEntry(mgrKey(person.email), { email: person.email }, 'reviews', q, review, req.body && req.body.baseSavedAt);
        res.json({ ok: true, review: saved });
    }));

    router.put('/appraisal/meeting/:email/:half', express.json(), handle(async (req, res) => {
        const h = req.params.half;
        if (!A.isHalfKey(h)) throw fail(400, 'That is not a half-year.');
        const who = await requireAdmin(req);
        const person = personByEmail(who.users, req.params.email);
        const meeting = A.sanitizeMeeting(req.body && req.body.meeting);
        const saved = await saveEntry(mgrKey(person.email), { email: person.email }, 'meetings', h, meeting, req.body && req.body.baseSavedAt);
        res.json({ ok: true, meeting: saved });
    }));

    return router;
}

module.exports = { createAppraisalRouter, _test: { fail } };
