'use strict';

/**
 * routes/appraisal.js — the staff performance appraisal.
 *
 * Who is a MANAGER comes from the People list (users.json): an admin there is a manager here.
 * Who is APPRAISED comes from the appraisal's own staff list (appraisal-staff.json), which admins
 * add to and remove from on the Staff tab. A staff member needs no email to be scored; an email,
 * when given, is how they are matched to their own sign-in so they can fill their own form.
 * Until an admin first changes the list it is seeded: the People list's non-admins on the live
 * site, the office staff on the testing site.
 *
 * Unlike the People page, there is no "until someone is an admin, everyone may manage" window
 * here — scores are private, so with no admin nobody sees anyone else's.
 *
 * Storage is split BY WHO WRITES IT, so a staff member and an admin can never overwrite each other:
 *   appraisal-setup.json        roles, items, weights, scale, raise table   (admins)
 *   appraisal-staff.json        who is appraised                             (admins)
 *   appraisal-self-<slug>.json  a person's own quarterly self-reviews       (that person only)
 *   appraisal-mgr-<slug>.json   roles/targets/own items, admin scores, 6-month notes (admins only)
 * <slug> comes from the staff member's id, which never changes. Staff are only ever sent their own
 * self-reviews plus their roles, items and targets — never a score an admin gave.
 *
 * Every save changes ONE entry (one quarter, one meeting, the profile, one staff member) and is
 * refused with 409 when that entry changed since the browser loaded it (`baseSavedAt`). A tab left
 * open overnight cannot put back yesterday's scores over today's. Removing a staff member only
 * marks them removed: their saved scores stay, and "Bring back" restores them by id. An email
 * belongs to one staff record for good — a new person can't take a removed person's email, or they
 * would sign in to that person's history. A manager can't be on the staff list under their own
 * email, and can never open or score their own review.
 */

const express = require('express');
const { APPRAISAL_KEY_PREFIX, APPRAISAL_REMINDER_EMAIL } = require('../utils/constants');
const roles = require('../utils/peopleRoles');
const A = require('../utils/appraisal');
const R = require('../utils/appraisalReminder');
const { sendEmail } = require('../utils/gmail');
const { siteBase } = require('./auth');
const { _test: { timingSafeEqualStr } } = require('../utils/auth');

const STALE_MSG = 'Someone saved this since you opened it. Reload the page to see the latest, then make your change again.';

/**
 * The testing site (a Vercel preview build) shares the live site's storage, and nobody has a
 * named login there yet (it has no sign-in at all). So on the testing site only, anyone without a
 * named login gets a test manager, and everything it saves goes to separate "preview-" files that
 * the live site never reads.
 */
function isTestSite() { return process.env.VERCEL_ENV === 'preview'; }
const TEST_MANAGER = { name: 'Test manager (testing site)', email: 'test-manager@testing-site' };
// The testing site's starting staff: the office staff by name, with the jobs the owner gave them.
// Their ids are the old pretend emails, so scores saved before the staff list existed still match.
// `startRoles` holds only until an admin saves that person's roles on the Staff tab.
const ALL_JOBS = ['r_sales', 'r_admin'];
const TEST_SITE_STAFF = [
    { id: 'pavithra@testing-site', name: 'Pavithra', email: '', startRoles: ALL_JOBS },
    { id: 'jayanthi@testing-site', name: 'Jayanthi', email: '', startRoles: ALL_JOBS },
    { id: 'ramesh@testing-site', name: 'Ramesh', email: '', startRoles: ALL_JOBS },
    { id: 'ramya@testing-site', name: 'Ramya', email: '', startRoles: ALL_JOBS },
    { id: 'kavitha@testing-site', name: 'Kavitha', email: '', startRoles: ['r_admin'] },
];

/** A person's saved roles, or their starting roles if nobody has saved any yet. */
function rolesOf(staff, mgrDoc) {
    if (mgrDoc && mgrDoc.profileSavedAt) return mgrDoc.roles || [];
    return (staff && staff.startRoles) || (mgrDoc && mgrDoc.roles) || [];
}

/** Everything that decides one person's item list: jobs, own extra items, shared items removed. */
function profileOf(staff, mgrDoc) {
    return { roles: rolesOf(staff, mgrDoc), extras: (mgrDoc && mgrDoc.extras) || [], hidden: (mgrDoc && mgrDoc.hidden) || [] };
}

function key(name) { return String(process.env.CONFIG_PREFIX || '').trim() + (isTestSite() ? 'preview-' : '') + APPRAISAL_KEY_PREFIX + name; }
const setupKey = () => key('setup.json');
const staffKey = () => key('staff.json');
const reminderKey = () => key('reminder.json');
const selfKey = (id) => key('self-' + A.personSlug(id) + '.json');
const mgrKey = (id) => key('mgr-' + A.personSlug(id) + '.json');

/** The staff list to start from when nobody has changed it yet. */
function seedStaff(users) {
    if (isTestSite()) return TEST_SITE_STAFF.map((s) => ({ ...s }));
    return (users || []).filter((u) => u && u.email && roles.roleOf(u) !== 'admin')
        .map((u) => ({ id: String(u.email).toLowerCase(), name: u.name || u.email, email: String(u.email).toLowerCase() }));
}
const activeStaff = (list) => list.filter((s) => !s.removedAt);

/**
 * Is this request the daily scheduler (vercel.json crons)? Vercel sends CRON_SECRET (set in the
 * hosting settings) as a Bearer token. Locked shut until CRON_SECRET exists: an open route would
 * let anyone make the office's Gmail send mail.
 */
function fromScheduler(req) {
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) { console.error('Appraisal reminder: CRON_SECRET is not set in the hosting settings, so no reminder can be sent.'); return false; }
    return timingSafeEqualStr(String(req.headers.authorization || ''), 'Bearer ' + secret);
}

/** The live site's own address for the email's link — never the address the scheduler happened to call. */
function liveSiteBase(req) {
    const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const production = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
    return production ? 'https://' + production : siteBase(req);
}

/** A small HTTP error a handler can throw; anything else becomes a 503. */
function fail(status, error) { const e = new Error(error); e.status = status; return e; }

function send(res, err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('appraisal route error:', err && err.message);
    return res.status(503).json({ error: 'Could not reach saved data. Try again in a moment.' });
}

/** Wraps a handler so a throw is always answered, never left hanging. */
function handle(fn) { return (req, res) => fn(req, res).catch((e) => send(res, e)); }

function createAppraisalRouter({ storage, loadUsers, onceClaim }) {
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

    /** The whole staff list (removed people included), seeded when nobody has saved one. */
    async function readStaff(users) {
        const stored = await readJson(staffKey(), null);
        return stored && Array.isArray(stored.staff) ? stored.staff : seedStaff(users);
    }

    /** The signed-in person, their People-list record, and whether they are a manager. */
    async function whoIsAsking(req) {
        const { users, ok } = await loadUsers(storage);
        if (!ok) throw fail(503, 'Cannot read the people list right now. Try again shortly.');
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

    /** An admin's request about one staff member: who is asking, the setup, and that person. */
    async function adminAndStaff(req) {
        const who = await requireAdmin(req);
        const staff = activeStaff(await readStaff(who.users)).find((s) => s.id === req.params.id);
        if (!staff) throw fail(404, 'That person is not on the staff list.');
        if (staff.email && roles.sameEmail(staff.email, who.email)) throw fail(403, 'You can\'t review yourself. Another manager has to.');
        const { setup } = await readSetup();
        return { who, staff, setup };
    }

    /** A name and email for a staff record, checked: valid, not a manager's, not anyone else's. */
    function checkedDetails(body, users, list, selfId) {
        const clean = A.sanitizeNewStaff(body);
        if (clean.error) throw fail(400, clean.error);
        const { email } = clean.staff;
        if (!email) return clean.staff;
        const manager = users.find((u) => u && u.email && roles.roleOf(u) === 'admin' && roles.sameEmail(u.email, email));
        if (manager) throw fail(400, 'That email belongs to a manager on the People page. Managers are not appraised.');
        const other = list.find((x) => x.id !== selfId && x.email && roles.sameEmail(x.email, email));
        if (other && !other.removedAt) throw fail(409, other.name + ' on the staff list already has that email.');
        if (other) throw fail(409, other.name + ' had that email and was removed. Bring ' + other.name + ' back under Removed staff, or use another email.');
        return clean.staff;
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

    /** Change the staff list by one person: read it fresh, apply `change`, write it back. */
    async function changeStaff(users, change) {
        const list = await readStaff(users);
        const result = change(list);
        await writeJson(staffKey(), { staff: list, savedAt: new Date().toISOString() });
        return result;
    }

    /** Each staff member with their saved self-review and manager files. */
    function withFiles(list) {
        return Promise.all(list.map(async (s) => {
            const [self, mgr] = await Promise.all([readJson(selfKey(s.id), { reviews: {} }), readJson(mgrKey(s.id), {})]);
            return { staff: s, self, mgr };
        }));
    }

    // ── Everyone ───────────────────────────────────────────────────────────

    /** The signed-in staff member's own record on the staff list (matched by email), or null. */
    async function myStaffRecord(who) {
        const list = activeStaff(await readStaff(who.users));
        return list.find((s) => s.email && roles.sameEmail(s.email, who.email)) || null;
    }

    async function mineFor(staff) {
        if (!staff) return null;
        const [self, mgr] = await Promise.all([readJson(selfKey(staff.id), { reviews: {} }), readJson(mgrKey(staff.id), {})]);
        const lockedQuarters = Object.keys(mgr.reviews || {}).filter((q) => mgr.reviews[q] && mgr.reviews[q].done);
        return { ...profileOf(staff, mgr), targets: mgr.targets || '', reviews: self.reviews || {}, lockedQuarters };
    }

    router.get('/appraisal/me', handle(async (req, res) => {
        const who = await whoIsAsking(req);
        const { setup, isStarter } = await readSetup();
        const mine = who.isAdmin ? null : await mineFor(await myStaffRecord(who));
        res.json({
            you: { email: who.email, name: who.me.name || who.email, isAdmin: who.isAdmin },
            hasAdmin: !!who.testSite || roles.adminCount(who.users) > 0,
            testSite: !!who.testSite,
            setup, isStarter, mine,
        });
    }));

    router.put('/appraisal/self/:quarter', express.json(), handle(async (req, res) => {
        const q = req.params.quarter;
        if (!A.isQuarterKey(q)) throw fail(400, 'That is not a quarter.');
        const who = await whoIsAsking(req);
        const staff = await myStaffRecord(who);
        if (!staff) throw fail(403, 'You are not on the appraisal staff list. Ask your manager to add you with this email.');
        const { setup } = await readSetup();
        const mgr = await readJson(mgrKey(staff.id), {});
        if (mgr.reviews && mgr.reviews[q] && mgr.reviews[q].done) {
            throw fail(409, 'Your manager has already finished this quarter, so it can no longer be changed.');
        }
        const review = A.sanitizeSelfReview(req.body && req.body.review, setup, mgr.extras);
        const left = A.unscoredCount(A.groupsFor(setup, profileOf(staff, mgr)), review.scores);
        if (left) throw fail(400, `Score every item first. ${left} still to score.`);
        review.submittedAt = new Date().toISOString();
        const saved = await saveEntry(selfKey(staff.id), { id: staff.id, reviews: {} }, 'reviews', q, review, req.body && req.body.baseSavedAt);
        res.json({ ok: true, review: saved });
    }));

    // ── Admins only ────────────────────────────────────────────────────────

    router.get('/appraisal/overview', handle(async (req, res) => {
        const who = await requireAdmin(req);
        const { setup, isStarter } = await readSetup();
        const files = await withFiles(activeStaff(await readStaff(who.users)));
        const people = files.map(({ staff: s, self, mgr }) => ({ id: s.id, name: s.name, email: s.email || '', self, mgr: { ...mgr, ...profileOf(s, mgr) } }));
        people.sort((a, b) => a.name.localeCompare(b.name));
        const removed = (await readStaff(who.users)).filter((s) => s.removedAt).map((s) => ({ id: s.id, name: s.name, email: s.email || '', removedAt: s.removedAt }));
        const reminder = await readJson(reminderKey(), {});
        res.json({ you: { email: who.email, name: who.me.name || who.email, isAdmin: true }, setup, isStarter, people, removed, reminder });
    }));

    router.put('/appraisal/setup', express.json(), handle(async (req, res) => {
        await requireAdmin(req);
        const { setup: current, isStarter } = await readSetup();
        if ((current.savedAt || null) !== ((req.body && req.body.baseSavedAt) || null)) throw fail(409, STALE_MSG);
        const clean = A.sanitizeSetup(req.body && req.body.setup);
        if (clean.error) throw fail(400, clean.error);
        const now = new Date().toISOString();
        // startedAt = when the appraisal was first set up; reminders never cover quarters before it.
        const startedAt = isStarter ? now : (current.startedAt || current.savedAt);
        const saved = { ...clean.setup, startedAt, savedAt: now };
        await writeJson(setupKey(), saved);
        res.json({ ok: true, setup: saved });
    }));

    /** Add one staff member: a name, and optionally the email they sign in with. */
    router.post('/appraisal/staff', express.json(), handle(async (req, res) => {
        const who = await requireAdmin(req);
        const added = await changeStaff(who.users, (list) => {
            const s = { id: A.newStaffId(), ...checkedDetails(req.body, who.users, list, null), addedAt: new Date().toISOString() };
            list.push(s);
            return s;
        });
        res.json({ ok: true, staff: added });
    }));

    /** Change a staff member's name or email. Their id — and so their saved scores — stay the same. */
    router.put('/appraisal/staff/:id', express.json(), handle(async (req, res) => {
        const who = await requireAdmin(req);
        const changed = await changeStaff(who.users, (list) => {
            const s = list.find((x) => x.id === req.params.id && !x.removedAt);
            if (!s) throw fail(404, 'That person is not on the staff list.');
            Object.assign(s, checkedDetails(req.body, who.users, list, s.id));
            return s;
        });
        res.json({ ok: true, staff: changed });
    }));

    /** Take one staff member off the list. Their saved scores are kept, never deleted. */
    router.delete('/appraisal/staff/:id', handle(async (req, res) => {
        const who = await requireAdmin(req);
        await changeStaff(who.users, (list) => {
            const s = list.find((x) => x.id === req.params.id && !x.removedAt);
            if (!s) throw fail(404, 'That person is not on the staff list.');
            s.removedAt = new Date().toISOString();
        });
        res.json({ ok: true });
    }));

    /** Bring a removed staff member back, with everything they had. */
    router.post('/appraisal/staff/:id/restore', handle(async (req, res) => {
        const who = await requireAdmin(req);
        const back = await changeStaff(who.users, (list) => {
            const s = list.find((x) => x.id === req.params.id && x.removedAt);
            if (!s) throw fail(404, 'That person is not on the removed list.');
            const clash = s.email && list.find((x) => x.id !== s.id && !x.removedAt && x.email && roles.sameEmail(x.email, s.email));
            if (clash) throw fail(409, clash.name + ' now has ' + s.name + '\'s email. Change it first.');
            delete s.removedAt;
            return s;
        });
        res.json({ ok: true, staff: back });
    }));

    router.put('/appraisal/profile/:id', express.json(), handle(async (req, res) => {
        const { staff, setup } = await adminAndStaff(req);
        const k = mgrKey(staff.id);
        const doc = await readJson(k, {});
        if ((doc.profileSavedAt || null) !== ((req.body && req.body.baseSavedAt) || null)) throw fail(409, STALE_MSG);
        const { profile, error } = A.sanitizeProfile(req.body, setup);
        if (error) throw fail(409, error);
        const next = { ...doc, id: staff.id, ...profile, profileSavedAt: new Date().toISOString() };
        await writeJson(k, next);
        res.json({ ok: true, profileSavedAt: next.profileSavedAt });
    }));

    router.put('/appraisal/review/:id/:quarter', express.json(), handle(async (req, res) => {
        const q = req.params.quarter;
        if (!A.isQuarterKey(q)) throw fail(400, 'That is not a quarter.');
        const { staff, setup } = await adminAndStaff(req);
        const doc = await readJson(mgrKey(staff.id), {});
        const review = A.sanitizeManagerReview(req.body && req.body.review, setup, doc.extras);
        if (review.done) {
            const left = A.unscoredCount(A.groupsFor(setup, profileOf(staff, doc)), review.scores);
            if (left) throw fail(400, `Score every item first. ${left} still to score.`);
        }
        const saved = await saveEntry(mgrKey(staff.id), { id: staff.id }, 'reviews', q, review, req.body && req.body.baseSavedAt);
        res.json({ ok: true, review: saved });
    }));

    router.put('/appraisal/meeting/:id/:half', express.json(), handle(async (req, res) => {
        const h = req.params.half;
        if (!A.isHalfKey(h)) throw fail(400, 'That is not a half-year.');
        const { staff } = await adminAndStaff(req);
        const meeting = A.sanitizeMeeting(req.body && req.body.meeting);
        const saved = await saveEntry(mgrKey(staff.id), { id: staff.id }, 'meetings', h, meeting, req.body && req.body.baseSavedAt);
        res.json({ ok: true, meeting: saved });
    }));

    // ── The daily reminder (vercel.json crons, 9 am India time) ────────────

    /** Who still has something missing for the due quarter, or why no email is due. */
    async function whatIsDue(now) {
        const due = R.dueQuarter(now);
        const { setup, isStarter } = await readSetup();
        if (!R.quarterIsDue(setup, isStarter, due)) return { due, skip: 'No quarter is due yet.' };
        const { users, ok } = await loadUsers(storage);
        if (!ok) throw fail(503, 'Cannot read the people list right now.');
        const files = await withFiles(activeStaff(await readStaff(users)));
        const missing = R.missingFor(files.map(({ staff, self, mgr }) => ({ name: staff.name, addedAt: staff.addedAt, self, mgr })), due.key);
        return missing.length ? { due, missing } : { due, skip: 'Everything is filled and done.' };
    }

    /** Keep the last result where admins see it, so a broken reminder shows on the page, not only in a log. */
    async function noteResult(change) {
        const last = await readJson(reminderKey(), {});
        await writeJson(reminderKey(), { ...last, ...change });
    }

    /**
     * Today's slot is claimed first — only one run can win it, even two at the same instant — so
     * the office never gets two emails in a day. If the send fails the slot is given back (a re-run
     * can try again), the failure is logged and saved for the page, and the run fails loudly.
     */
    async function sendReminder(due, missing, link, now) {
        const slot = (isTestSite() ? 'preview-' : '') + 'appraisal-reminder-' + R.istDay(now);
        if (!(await onceClaim.claim(slot))) return false;
        try {
            await sendEmail({ to: APPRAISAL_REMINDER_EMAIL, ...R.reminderEmail(due, missing, link) });
        } catch (e) {
            console.error('Appraisal reminder email failed:', e && e.message);
            await onceClaim.release(slot).catch((er) => console.error('Appraisal reminder: could not give back today\'s slot:', er && er.message));
            await noteResult({ lastFailedAt: new Date(now).toISOString(), lastError: String((e && e.message) || e).slice(0, 300) }).catch(() => {});
            throw fail(502, 'The reminder email could not be sent.');
        }
        await noteResult({ lastSentAt: new Date(now).toISOString(), lastQuarter: due.key, lastCount: missing.length })
            .catch((e) => console.error('Appraisal reminder sent, but its record was not saved:', e && e.message));
        return true;
    }

    router.get('/appraisal/reminders/run', handle(async (req, res) => {
        if (!fromScheduler(req)) throw fail(401, 'Not allowed.');
        const now = Date.now();
        const { due, skip, missing } = await whatIsDue(now);
        if (skip) return res.json({ ok: true, sent: false, reason: skip });
        const sent = await sendReminder(due, missing, liveSiteBase(req) + '/appraisal.html', now);
        res.json(sent ? { ok: true, sent: true } : { ok: true, sent: false, reason: 'Already sent today.' });
    }));

    return router;
}

module.exports = { createAppraisalRouter, _test: { fail, seedStaff, rolesOf, profileOf } };
