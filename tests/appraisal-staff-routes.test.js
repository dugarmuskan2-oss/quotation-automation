/**
 * @jest-environment node
 *
 * tests/appraisal-staff-routes.test.js
 *
 * routes/appraisal.js — the staff list, who sees what, and the testing site.
 * Driven through supertest on a real express app with:
 *   - an in-memory storage { readText, saveText } that records every key written,
 *   - a loadUsers stub (the People list), changeable mid-test (e.g. promoting someone),
 *   - a stand-in for the sign-in gate: header x-test-email sets req.user; no header = no session.
 *
 * Gmail is mocked (the router requires utils/gmail at load); nothing here sends mail.
 */

'use strict';

jest.mock('../utils/gmail', () => ({ sendEmail: jest.fn(async () => ({})) }));

const express = require('express');
const request = require('supertest');
const { createAppraisalRouter } = require('../routes/appraisal');
const A = require('../utils/appraisal');

const Q1 = '2026-27-Q1';
const Q2 = '2026-27-Q2';
const H1 = '2026-27-H1';

const BOSS = 'boss@dscpipes.com';      // old-style record: role 'admin', no tick list
const MEERA = 'meera@dscpipes.com';    // new-style manager: managePeople ticked
const ANITA = 'anita@dscpipes.com';    // staff (stored on People in mixed case)
const BALA = 'bala@dscpipes.com';      // staff with a tick list that is not managePeople

const ITEMS_ADMIN = ['c_d5', 'c_d6', 'c_d7'];
const ITEMS_SALES = ['c_s1', 'c_s2', 'c_s3', 'c_s4', 'c_s5', 'c_s6'];
const ITEMS_BEHAVIOUR = ['c_b1', 'c_b2', 'c_b3', 'c_b4', 'c_p1'];

function peopleList() {
    return [
        { name: 'Boss', email: 'Boss@dscpipes.com', role: 'admin' },
        { name: 'Meera', email: MEERA, permissions: ['managePeople', 'addNotes'] },
        { name: 'Anita', email: 'Anita@DSCpipes.com' },
        { name: 'Bala', email: BALA, permissions: ['addRevisions', 'allocateMargins'] },
    ];
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const scoresFor = (ids, n = 7) => Object.fromEntries(ids.map((id) => [id, n]));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A fresh app with its own storage and People list. */
function makeWorld(users) {
    const mem = new Map();
    const writes = [];
    const storage = {
        readText: async (k) => (mem.has(k) ? mem.get(k) : null),
        saveText: async (k, v) => { writes.push(k); mem.set(k, String(v)); },
    };
    // state.ok = false mimics routes/auth.js loadUsers when users.json can't be read:
    // { users: <last cached list, or []>, ok: false }.
    const state = { users: users || peopleList(), ok: true };
    const loadUsers = async () => ({ users: state.users, ok: state.ok });
    const onceClaim = { claim: jest.fn(async () => true), release: jest.fn(async () => {}) };
    const app = express();
    app.use((req, res, next) => {
        const email = req.headers['x-test-email'];
        if (email) req.user = { who: email, kind: 'person', email };
        next();
    });
    app.use('/api', createAppraisalRouter({ storage, loadUsers, onceClaim }));

    function call(method, path, email, body) {
        let r = request(app)[method]('/api' + path);
        if (email) r = r.set('x-test-email', email);
        if (body !== undefined) r = r.send(body);
        return r;
    }
    const as = (email) => ({
        get: (p) => call('get', p, email),
        put: (p, b) => call('put', p, email, b),
        post: (p, b) => call('post', p, email, b),
        del: (p) => call('delete', p, email),
    });
    return { mem, writes, state, as };
}

async function overview(w, email = BOSS) {
    const r = await w.as(email).get('/appraisal/overview');
    expect(r.status).toBe(200);
    return r.body;
}
const personIn = (ov, id) => ov.people.find((p) => p.id === id);

/** Stores the staff list (as seeded) by adding one more person, so later People changes don't re-seed it. */
async function storeStaffList(w) {
    const r = await w.as(BOSS).post('/appraisal/staff', { name: 'Chitra' });
    expect(r.status).toBe(200);
    return r.body.staff;
}

async function saveProfile(w, id, body, email = BOSS) {
    return w.as(email).put('/appraisal/profile/' + encodeURIComponent(id), body);
}

// ── Environment: these tests own VERCEL_ENV and CONFIG_PREFIX, and put them back after ──
const savedEnv = { VERCEL_ENV: process.env.VERCEL_ENV, CONFIG_PREFIX: process.env.CONFIG_PREFIX };
beforeEach(() => { delete process.env.VERCEL_ENV; delete process.env.CONFIG_PREFIX; });
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});

let errSpy;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => errSpy.mockRestore());

// ═══════════════════════════════════════════════════════════════════════════════
describe('live site: the starting staff list', () => {
    test('is the People non-admins, id = lowercased email; old-style and tick-list managers both left out', async () => {
        const w = makeWorld();
        const ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA]);
        const anita = personIn(ov, ANITA);
        expect(anita.name).toBe('Anita');
        expect(anita.email).toBe(ANITA);
        expect(ov.removed).toEqual([]);
        // Reading the seed does not store anything.
        expect(w.writes).toEqual([]);
    });

    test('a tick-list manager can read the overview too', async () => {
        const w = makeWorld();
        const r = await w.as(MEERA).get('/appraisal/overview');
        expect(r.status).toBe(200);
        expect(r.body.people.map((p) => p.id)).toEqual([ANITA, BALA]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('adding staff', () => {
    test('a new person gets a fresh id, a lowercased email and addedAt', async () => {
        const w = makeWorld();
        const before = Date.now();
        const r = await w.as(BOSS).post('/appraisal/staff', { name: '  Chitra  ', email: 'Chitra@DSCpipes.com' });
        const after = Date.now();
        expect(r.status).toBe(200);
        const s = r.body.staff;
        expect(s.id).toMatch(/^s-[0-9a-f]{12}$/);
        expect(s.name).toBe('Chitra');
        expect(s.email).toBe('chitra@dscpipes.com');
        expect(s.addedAt).toMatch(ISO_RX);
        const t = Date.parse(s.addedAt);
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(after);
        const ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA, s.id]);
    });

    test('no email is fine; a bad email or a missing name is refused and nothing is stored', async () => {
        const w = makeWorld();
        const bad = await w.as(BOSS).post('/appraisal/staff', { name: 'X', email: 'not-an-email' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/email/i);
        const noName = await w.as(BOSS).post('/appraisal/staff', { name: '   ', email: 'x@dscpipes.com' });
        expect(noName.status).toBe(400);
        expect(w.writes).toEqual([]);
        const ok = await w.as(BOSS).post('/appraisal/staff', { name: 'Driver Murugan' });
        expect(ok.status).toBe(200);
        expect(ok.body.staff.email).toBe('');
    });

    test('an email an active staff member already has is refused (any spelling)', async () => {
        const w = makeWorld();
        const r = await w.as(BOSS).post('/appraisal/staff', { name: 'Anita Two', email: 'ANITA@dscpipes.com ' });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/already has that email/);
        const ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA]);
    });

    test("a removed person's email can't go to a new person (they would sign in to that history)", async () => {
        const w = makeWorld();
        expect((await w.as(BOSS).del('/appraisal/staff/' + encodeURIComponent(ANITA))).status).toBe(200);
        const r = await w.as(BOSS).post('/appraisal/staff', { name: 'New Anita', email: ANITA });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/removed/);
        const ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([BALA]);
        expect(ov.removed.map((p) => p.id)).toEqual([ANITA]);
    });

    test("a manager's email can't be added as staff (old-style and tick-list managers)", async () => {
        const w = makeWorld();
        const r1 = await w.as(BOSS).post('/appraisal/staff', { name: 'Boss', email: 'BOSS@dscpipes.com' });
        expect(r1.status).toBe(400);
        expect(r1.body.error).toMatch(/manager/i);
        const r2 = await w.as(BOSS).post('/appraisal/staff', { name: 'Meera', email: MEERA });
        expect(r2.status).toBe(400);
        expect(r2.body.error).toMatch(/manager/i);
        expect(w.writes).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('changing a name or email', () => {
    test('keeps the id and everything saved under it; the new email is how they sign in', async () => {
        const w = makeWorld();
        // Anita's profile, a manager draft, and her own self-review, all under her id.
        expect((await saveProfile(w, ANITA, { roles: ['r_admin'], targets: 'keep me' })).status).toBe(200);
        const draft = await w.as(BOSS).put(`/appraisal/review/${ANITA}/${Q2}`, { review: { scores: { c_d5: 8 }, comment: 'draft' } });
        expect(draft.status).toBe(200);
        const self = await w.as(ANITA).put(`/appraisal/self/${Q1}`, { review: { scores: scoresFor([...ITEMS_ADMIN, ...ITEMS_BEHAVIOUR]), wins: 'mine' } });
        expect(self.status).toBe(200);

        // Name only, same email: allowed (her own email is not a clash with herself).
        const r1 = await w.as(BOSS).put('/appraisal/staff/' + ANITA, { name: 'Anita K', email: ANITA });
        expect(r1.status).toBe(200);
        expect(r1.body.staff.id).toBe(ANITA);
        expect(r1.body.staff.name).toBe('Anita K');

        // New email: id unchanged.
        const r2 = await w.as(BOSS).put('/appraisal/staff/' + ANITA, { name: 'Anita K', email: 'Anita.K@DSCpipes.com' });
        expect(r2.status).toBe(200);
        expect(r2.body.staff.id).toBe(ANITA);
        expect(r2.body.staff.email).toBe('anita.k@dscpipes.com');

        const ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA]);
        const p = personIn(ov, ANITA);
        expect(p.name).toBe('Anita K');
        expect(p.email).toBe('anita.k@dscpipes.com');
        expect(p.mgr.targets).toBe('keep me');
        expect(p.mgr.roles).toEqual(['r_admin']);
        expect(p.mgr.reviews[Q2].scores).toEqual({ c_d5: 8 });
        expect(p.self.reviews[Q1].wins).toBe('mine');

        // Signing in with the new email finds her record; the old email no longer does.
        w.state.users = [...w.state.users, { name: 'Anita K', email: 'anita.k@dscpipes.com' }];
        const meNew = await w.as('anita.k@dscpipes.com').get('/appraisal/me');
        expect(meNew.status).toBe(200);
        expect(meNew.body.mine.targets).toBe('keep me');
        expect(meNew.body.mine.reviews[Q1].wins).toBe('mine');
        const meOld = await w.as(ANITA).get('/appraisal/me');
        expect(meOld.body.mine).toBeNull();
    });

    test("can't change to another staff member's or a manager's email", async () => {
        const w = makeWorld();
        const clash = await w.as(BOSS).put('/appraisal/staff/' + ANITA, { name: 'Anita', email: BALA });
        expect(clash.status).toBe(409);
        const mgr = await w.as(BOSS).put('/appraisal/staff/' + ANITA, { name: 'Anita', email: MEERA });
        expect(mgr.status).toBe(400);
        const ov = await overview(w);
        expect(personIn(ov, ANITA).email).toBe(ANITA);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('removing and bringing back', () => {
    test('remove only marks them removed; bring back restores them with their scores', async () => {
        const w = makeWorld();
        const draft = await w.as(BOSS).put(`/appraisal/review/${BALA}/${Q2}`, { review: { scores: { c_b1: 8, c_b2: 6 }, comment: 'kept' } });
        expect(draft.status).toBe(200);

        const del = await w.as(BOSS).del('/appraisal/staff/' + BALA);
        expect(del.status).toBe(200);
        let ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA]);
        expect(ov.removed).toHaveLength(1);
        expect(ov.removed[0]).toMatchObject({ id: BALA, name: 'Bala', email: BALA });
        expect(ov.removed[0].removedAt).toMatch(ISO_RX);

        // While removed: he has no record of his own, and can't be reviewed, renamed or removed again.
        expect((await w.as(BALA).get('/appraisal/me')).body.mine).toBeNull();
        expect((await w.as(BOSS).put(`/appraisal/review/${BALA}/${Q2}`, { review: { scores: {} } })).status).toBe(404);
        expect((await w.as(BOSS).put('/appraisal/staff/' + BALA, { name: 'Bala R', email: BALA })).status).toBe(404);
        expect((await w.as(BOSS).del('/appraisal/staff/' + BALA)).status).toBe(404);

        const back = await w.as(BOSS).post(`/appraisal/staff/${BALA}/restore`);
        expect(back.status).toBe(200);
        expect(back.body.staff.removedAt).toBeUndefined();
        ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA]);
        expect(ov.removed).toEqual([]);
        const bala = personIn(ov, BALA);
        expect(bala.name).toBe('Bala');
        expect(bala.mgr.reviews[Q2].scores).toEqual({ c_b1: 8, c_b2: 6 });
        expect(bala.mgr.reviews[Q2].comment).toBe('kept');

        // Restoring someone who is not removed is refused.
        expect((await w.as(BOSS).post(`/appraisal/staff/${BALA}/restore`)).status).toBe(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('who may do what', () => {
    test("a manager can't review or set up themself (promoted from staff), but can review others", async () => {
        const w = makeWorld();
        await storeStaffList(w);  // Bala is on the stored list as staff
        w.state.users = w.state.users.map((u) => (u.email === BALA ? { ...u, permissions: ['managePeople'] } : u));

        const selfReview = await w.as(BALA).put(`/appraisal/review/${BALA}/${Q2}`, { review: { scores: { c_b1: 10 } } });
        expect(selfReview.status).toBe(403);
        expect(selfReview.body.error).toMatch(/yourself/);
        const selfProfile = await saveProfile(w, BALA, { roles: ['r_sales'], targets: 'easy' }, BALA);
        expect(selfProfile.status).toBe(403);
        const selfMeeting = await w.as(BALA).put(`/appraisal/meeting/${BALA}/${H1}`, { meeting: { raisePct: 50 } });
        expect(selfMeeting.status).toBe(403);
        expect([...w.mem.keys()].some((k) => k.includes('mgr-'))).toBe(false);

        const other = await w.as(BALA).put(`/appraisal/review/${ANITA}/${Q2}`, { review: { scores: { c_b1: 6 } } });
        expect(other.status).toBe(200);
        const byBoss = await w.as(BOSS).put(`/appraisal/review/${BALA}/${Q2}`, { review: { scores: { c_b1: 5 } } });
        expect(byBoss.status).toBe(200);
        const ov = await overview(w);
        expect(personIn(ov, BALA).mgr.reviews[Q2].scores).toEqual({ c_b1: 5 });
    });

    test('the same holds for someone added on the Staff tab (id is not their email) and later made a manager', async () => {
        const w = makeWorld();
        const added = await w.as(BOSS).post('/appraisal/staff', { name: 'Chitra', email: 'chitra@dscpipes.com' });
        expect(added.status).toBe(200);
        const id = added.body.staff.id;
        expect(id).not.toBe('chitra@dscpipes.com');
        w.state.users = [...w.state.users, { name: 'Chitra', email: 'Chitra@dscpipes.com', permissions: ['managePeople'] }];

        const self = await w.as('chitra@dscpipes.com').put(`/appraisal/review/${id}/${Q2}`, { review: { scores: { c_b1: 10 } } });
        expect(self.status).toBe(403);
        expect(self.body.error).toMatch(/yourself/);
        expect((await w.as(BOSS).put(`/appraisal/review/${id}/${Q2}`, { review: { scores: { c_b1: 6 } } })).status).toBe(200);
    });

    test('staff get 403 on every admin route and nothing is written', async () => {
        const w = makeWorld();
        const me = w.as(ANITA);
        const tries = [
            me.get('/appraisal/overview'),
            me.put('/appraisal/setup', { setup: clone(A.DEFAULT_SETUP), baseSavedAt: null }),
            me.post('/appraisal/staff', { name: 'Friend' }),
            me.put('/appraisal/staff/' + BALA, { name: 'Bala', email: 'bala2@dscpipes.com' }),
            me.del('/appraisal/staff/' + BALA),
            me.post(`/appraisal/staff/${BALA}/restore`),
            me.put('/appraisal/profile/' + ANITA, { roles: ['r_sales'], targets: 'self-set' }),
            me.put(`/appraisal/review/${ANITA}/${Q2}`, { review: { scores: { c_b1: 10 } } }),
            me.put(`/appraisal/review/${BALA}/${Q2}`, { review: { scores: { c_b1: 1 } } }),
            me.put(`/appraisal/meeting/${ANITA}/${H1}`, { meeting: { raisePct: 40 } }),
        ];
        for (const r of await Promise.all(tries)) {
            expect(r.status).toBe(403);
            expect(r.body.people).toBeUndefined();
        }
        expect(w.writes).toEqual([]);
    });

    test('with no manager on People, nobody manages here (no "everyone may until a manager exists" window)', async () => {
        // The People page lets everyone manage until someone holds managePeople; scores are private,
        // so the appraisal must not. Same people as usual, minus the two managers.
        const w = makeWorld(peopleList().filter((u) => u.name === 'Anita' || u.name === 'Bala'));
        const me = await w.as(ANITA).get('/appraisal/me');
        expect(me.status).toBe(200);
        expect(me.body.you.isAdmin).toBe(false);
        expect(me.body.hasAdmin).toBe(false);
        expect(me.body.mine).not.toBeNull();
        expect((await w.as(ANITA).get('/appraisal/overview')).status).toBe(403);
        expect((await w.as(ANITA).put(`/appraisal/review/${BALA}/${Q2}`, { review: { scores: { c_b1: 1 } } })).status).toBe(403);
        expect(w.writes).toEqual([]);
        // With a manager on People, the same call says so.
        const w2 = makeWorld();
        expect((await w2.as(ANITA).get('/appraisal/me')).body.hasAdmin).toBe(true);
    });

    test('when the People list cannot be read, the answer is "try again" (503), never "not on the list" or a pass', async () => {
        const w = makeWorld();
        w.state.ok = false;
        w.state.users = [];  // first read failed, nothing cached
        const me = await w.as(ANITA).get('/appraisal/me');
        expect(me.status).toBe(503);
        expect(me.body.error).toMatch(/try again/i);
        expect(me.body.mine).toBeUndefined();
        w.state.users = peopleList();  // failed read with an older cached list: still refused
        expect((await w.as(BOSS).get('/appraisal/overview')).status).toBe(503);
        expect((await w.as(BOSS).post('/appraisal/staff', { name: 'Chitra' })).status).toBe(503);
        expect(w.writes).toEqual([]);
    });

    test('no session, or someone not on the People list, is refused on the live site', async () => {
        const w = makeWorld();
        const anon = await w.as(null).get('/appraisal/me');
        expect(anon.status).toBe(403);
        expect(anon.body.you).toBeUndefined();
        expect((await w.as(null).get('/appraisal/overview')).status).toBe(403);
        expect((await w.as('stranger@gmail.com').get('/appraisal/me')).status).toBe(403);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("a staff member's own view (mine)", () => {
    test('shows only their own jobs, targets and self-reviews — never a manager score or anyone else', async () => {
        const w = makeWorld();
        expect((await saveProfile(w, ANITA, { roles: ['r_sales'], targets: 'Anita: 20 orders' })).status).toBe(200);
        expect((await saveProfile(w, BALA, {
            roles: ['r_admin'], targets: 'Bala: clear ledger',
            extras: [{ id: 'x_tally', name: 'Tally entries', section: 'r_admin' }], hidden: ['c_b4'],
        })).status).toBe(200);
        const done = await w.as(BOSS).put(`/appraisal/review/${ANITA}/${Q2}`, {
            review: { scores: scoresFor([...ITEMS_SALES, ...ITEMS_BEHAVIOUR], 3), comment: 'MGR-ONLY-NOTE', done: true },
        });
        expect(done.status).toBe(200);
        // A manager DRAFT for Q1 (not done) neither locks her Q1 form nor shows up in her view.
        const draftQ1 = await w.as(BOSS).put(`/appraisal/review/${ANITA}/${Q1}`, {
            review: { scores: { c_s1: 2 }, comment: 'MGR-DRAFT-NOTE' },
        });
        expect(draftQ1.status).toBe(200);
        const own = await w.as(ANITA).put(`/appraisal/self/${Q1}`, {
            review: { scores: scoresFor([...ITEMS_SALES, ...ITEMS_BEHAVIOUR], 9), wins: 'anita-own-wins' },
        });
        expect(own.status).toBe(200);

        const r = await w.as('ANITA@dscpipes.com').get('/appraisal/me');
        expect(r.status).toBe(200);
        expect(r.body.you).toMatchObject({ email: ANITA, isAdmin: false });
        const mine = r.body.mine;
        expect(mine.roles).toEqual(['r_sales']);
        expect(mine.targets).toBe('Anita: 20 orders');
        expect(Object.keys(mine.reviews)).toEqual([Q1]);
        expect(mine.reviews[Q1].wins).toBe('anita-own-wins');
        expect(mine.reviews[Q1].scores.c_s1).toBe(9);
        expect(mine.lockedQuarters).toEqual([Q2]);
        expect(mine.extras).toEqual([]);
        expect(mine.hidden).toEqual([]);
        const text = JSON.stringify(r.body);
        expect(text).not.toMatch(/MGR-ONLY-NOTE|MGR-DRAFT-NOTE/);
        expect(text).not.toMatch(/Bala: clear ledger|Tally entries/);
        expect(r.body.people).toBeUndefined();

        // Bala's view carries his own items and removed items, so his own form lists the right ones.
        const b = await w.as(BALA).get('/appraisal/me');
        expect(b.body.mine.targets).toBe('Bala: clear ledger');
        expect(b.body.mine.roles).toEqual(['r_admin']);
        expect(b.body.mine.extras).toEqual([{ id: 'x_tally', name: 'Tally entries', hint: '', section: 'r_admin' }]);
        expect(b.body.mine.hidden).toEqual(['c_b4']);
        expect(b.body.mine.reviews).toEqual({});
        expect(JSON.stringify(b.body)).not.toMatch(/Anita: 20 orders|anita-own-wins/);

        // A quarter the manager has finished can't be changed by her.
        const late = await w.as(ANITA).put(`/appraisal/self/${Q2}`, { review: { scores: scoresFor([...ITEMS_SALES, ...ITEMS_BEHAVIOUR]) } });
        expect(late.status).toBe(409);
    });

    test('is null for someone on People but not on the staff list, who also cannot submit a form', async () => {
        const w = makeWorld();
        await storeStaffList(w);
        w.state.users = [...w.state.users, { name: 'Devi', email: 'devi@dscpipes.com' }];
        const r = await w.as('devi@dscpipes.com').get('/appraisal/me');
        expect(r.status).toBe(200);
        expect(r.body.you.isAdmin).toBe(false);
        expect(r.body.mine).toBeNull();
        const sub = await w.as('devi@dscpipes.com').put(`/appraisal/self/${Q1}`, { review: { scores: scoresFor(ITEMS_BEHAVIOUR) } });
        expect(sub.status).toBe(403);
    });

    test('a manager gets no mine (managers are not appraised) — even one still on the staff list after a promotion', async () => {
        const w = makeWorld();
        await storeStaffList(w);  // Bala stays on the stored list when People changes
        expect((await saveProfile(w, BALA, { roles: ['r_admin'], targets: 'Bala target' })).status).toBe(200);
        // Before the promotion Bala sees his own record, so the null below is the manager rule, not a missing record.
        const before = await w.as(BALA).get('/appraisal/me');
        expect(before.body.mine.targets).toBe('Bala target');

        w.state.users = w.state.users.map((u) => (u.email === BALA ? { ...u, permissions: ['managePeople'] } : u));
        const after = await w.as(BALA).get('/appraisal/me');
        expect(after.status).toBe(200);
        expect(after.body.you.isAdmin).toBe(true);
        expect(after.body.mine).toBeNull();
        expect(JSON.stringify(after.body)).not.toMatch(/Bala target/);

        const boss = await w.as(BOSS).get('/appraisal/me');
        expect(boss.body.you.isAdmin).toBe(true);
        expect(boss.body.mine).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("a person's profile (jobs, targets, own items, removed items)", () => {
    test('a save from a stale page is refused with 409 and changes nothing', async () => {
        const w = makeWorld();
        const first = await saveProfile(w, ANITA, { roles: ['r_sales'], targets: 'T1' });
        expect(first.status).toBe(200);
        const p1 = first.body.profileSavedAt;
        expect(p1).toMatch(ISO_RX);

        const noBase = await saveProfile(w, ANITA, { roles: ['r_admin'], targets: 'T-from-old-tab' });
        expect(noBase.status).toBe(409);

        await pause(5);
        const second = await saveProfile(w, ANITA, { roles: ['r_sales', 'r_admin'], targets: 'T2', baseSavedAt: p1 });
        expect(second.status).toBe(200);
        expect(second.body.profileSavedAt).not.toBe(p1);

        const stale = await saveProfile(w, ANITA, { roles: [], targets: 'T-stale', baseSavedAt: p1 });
        expect(stale.status).toBe(409);

        const p = personIn(await overview(w), ANITA);
        expect(p.mgr.targets).toBe('T2');
        expect(p.mgr.roles).toEqual(['r_sales', 'r_admin']);
    });

    test('a later save that sends only jobs + targets (meeting "set targets") keeps own items, removed items, scores and meeting notes', async () => {
        const w = makeWorld();
        const full = await saveProfile(w, ANITA, {
            roles: ['r_sales', 'r_admin'], targets: 'old',
            extras: [{ id: 'x_tally', name: 'Tally entries', section: 'r_admin' }],
            hidden: ['c_s6'],
        });
        expect(full.status).toBe(200);
        // Scores and meeting notes live in the same manager file as the profile.
        expect((await w.as(BOSS).put(`/appraisal/review/${ANITA}/${Q2}`, { review: { scores: { c_s1: 6 }, comment: 'keep-this-review' } })).status).toBe(200);
        expect((await w.as(BOSS).put(`/appraisal/meeting/${ANITA}/${H1}`, { meeting: { wentWell: 'keep-this-meeting', raisePct: 5 } })).status).toBe(200);

        const later = await saveProfile(w, ANITA, { roles: ['r_sales', 'r_admin'], targets: 'new targets', baseSavedAt: full.body.profileSavedAt });
        expect(later.status).toBe(200);
        const p = personIn(await overview(w), ANITA);
        expect(p.mgr.targets).toBe('new targets');
        expect(p.mgr.extras).toEqual([{ id: 'x_tally', name: 'Tally entries', hint: '', section: 'r_admin' }]);
        expect(p.mgr.hidden).toEqual(['c_s6']);
        expect(p.mgr.reviews[Q2].comment).toBe('keep-this-review');
        expect(p.mgr.reviews[Q2].scores).toEqual({ c_s1: 6 });
        expect(p.mgr.meetings[H1].wentWell).toBe('keep-this-meeting');
    });

    test('an own item under a job since deleted from Setup is refused (409), never silently dropped', async () => {
        const w = makeWorld();
        const extras = [{ id: 'x_tally', name: 'Tally entries', section: 'r_admin' }];
        const first = await saveProfile(w, ANITA, { roles: ['r_sales', 'r_admin'], targets: 't', extras });
        expect(first.status).toBe(200);

        // Another tab deletes the Administration job from Setup.
        const setup = clone(A.DEFAULT_SETUP);
        setup.roles = setup.roles.filter((r) => r.id !== 'r_admin');
        expect((await w.as(BOSS).put('/appraisal/setup', { setup, baseSavedAt: null })).status).toBe(200);

        // This tab still shows the item under Administration and saves.
        const r = await saveProfile(w, ANITA, { roles: ['r_sales', 'r_admin'], targets: 't2', extras, baseSavedAt: first.body.profileSavedAt });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/Setup has changed/);
        const p = personIn(await overview(w), ANITA);
        expect(p.mgr.extras.map((x) => x.id)).toEqual(['x_tally']);
        expect(p.mgr.targets).toBe('t');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('a finished ("done") review', () => {
    // Anita: Administration (3) + her own item + Behaviour (5) minus Learning (removed for her) = 8.
    const MUST = ['c_d5', 'c_d6', 'c_d7', 'x_tally', 'c_b1', 'c_b2', 'c_b3', 'c_p1'];

    async function setUp() {
        const w = makeWorld();
        const r = await saveProfile(w, ANITA, {
            roles: ['r_admin'], targets: '',
            extras: [{ id: 'x_tally', name: 'Tally entries', section: 'r_admin' }],
            hidden: ['c_b4'],
        });
        expect(r.status).toBe(200);
        return w;
    }
    const put = (w, review) => w.as(BOSS).put(`/appraisal/review/${ANITA}/${Q2}`, { review });

    test('needs her own extra item scored', async () => {
        const w = await setUp();
        const r = await put(w, { scores: scoresFor(MUST.filter((id) => id !== 'x_tally')), done: true });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/1 still to score/);
        expect([...w.mem.keys()].filter((k) => k.includes('mgr-')).length).toBe(1);
        expect(personIn(await overview(w), ANITA).mgr.reviews).toBeUndefined();
    });

    test('does not need the item removed for her; the extra score is kept', async () => {
        const w = await setUp();
        const r = await put(w, { scores: scoresFor(MUST, 8), done: true });
        expect(r.status).toBe(200);
        expect(r.body.review.done).toBe(true);
        expect(r.body.review.scores.x_tally).toBe(8);
        expect(r.body.review.scores.c_b4).toBeUndefined();
    });

    test('a draft (not done) may be partly scored', async () => {
        const w = await setUp();
        const r = await put(w, { scores: { c_d5: 4 }, done: false });
        expect(r.status).toBe(200);
        expect(r.body.review.done).toBe(false);
    });

    test('a review saved from a stale page is refused (409) and the newer one stays', async () => {
        const w = await setUp();
        const url = `/appraisal/review/${ANITA}/${Q2}`;
        const first = await w.as(BOSS).put(url, { review: { scores: { c_d5: 4 }, comment: 'first' } });
        expect(first.status).toBe(200);
        const base1 = first.body.review.savedAt;
        expect(base1).toMatch(ISO_RX);
        await pause(5);
        const second = await w.as(BOSS).put(url, { review: { scores: { c_d5: 6 }, comment: 'second' }, baseSavedAt: base1 });
        expect(second.status).toBe(200);
        const stale = await w.as(BOSS).put(url, { review: { scores: { c_d5: 1 }, comment: 'stale' }, baseSavedAt: base1 });
        expect(stale.status).toBe(409);
        const noBase = await w.as(BOSS).put(url, { review: { scores: { c_d5: 1 }, comment: 'no-base' } });
        expect(noBase.status).toBe(409);
        const p = personIn(await overview(w), ANITA);
        expect(p.mgr.reviews[Q2].comment).toBe('second');
        expect(p.mgr.reviews[Q2].scores).toEqual({ c_d5: 6 });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('saving Setup', () => {
    test('keeps the first startedAt for good, never takes one from the browser, and refuses a stale save', async () => {
        const w = makeWorld();
        const s1 = await w.as(BOSS).put('/appraisal/setup', {
            setup: { ...clone(A.DEFAULT_SETUP), startedAt: '2020-01-01T00:00:00.000Z' }, baseSavedAt: null,
        });
        expect(s1.status).toBe(200);
        const first = s1.body.setup;
        expect(first.startedAt).toMatch(ISO_RX);
        expect(first.startedAt).toBe(first.savedAt);

        await pause(5);
        const s2 = await w.as(BOSS).put('/appraisal/setup', {
            setup: { ...clone(A.DEFAULT_SETUP), startedAt: '2019-06-01T00:00:00.000Z' }, baseSavedAt: first.savedAt,
        });
        expect(s2.status).toBe(200);
        expect(s2.body.setup.savedAt).not.toBe(first.savedAt);
        expect(s2.body.setup.startedAt).toBe(first.startedAt);

        const stale = await w.as(BOSS).put('/appraisal/setup', { setup: clone(A.DEFAULT_SETUP), baseSavedAt: first.savedAt });
        expect(stale.status).toBe(409);

        const badWeights = clone(A.DEFAULT_SETUP);
        badWeights.weights = { work: 70, behaviour: 20 };
        const bad = await w.as(BOSS).put('/appraisal/setup', { setup: badWeights, baseSavedAt: s2.body.setup.savedAt });
        expect(bad.status).toBe(400);

        const me = await w.as(BOSS).get('/appraisal/me');
        expect(me.body.isStarter).toBe(false);
        expect(me.body.setup.startedAt).toBe(first.startedAt);
        expect(me.body.setup.savedAt).toBe(s2.body.setup.savedAt);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('testing site (VERCEL_ENV=preview)', () => {
    beforeEach(() => { process.env.VERCEL_ENV = 'preview'; });
    afterEach(() => { delete process.env.VERCEL_ENV; });

    const FIVE = ['jayanthi@testing-site', 'kavitha@testing-site', 'pavithra@testing-site', 'ramesh@testing-site', 'ramya@testing-site'];

    test('a visitor with no session is the test manager', async () => {
        const w = makeWorld();
        const r = await w.as(null).get('/appraisal/me');
        expect(r.status).toBe(200);
        expect(r.body.you).toMatchObject({ email: 'test-manager@testing-site', isAdmin: true });
        expect(r.body.testSite).toBe(true);
        expect(r.body.mine).toBeNull();
    });

    test('someone signed in is themself there, not the test manager', async () => {
        const w = makeWorld();
        const r = await w.as(ANITA).get('/appraisal/me');
        expect(r.status).toBe(200);
        expect(r.body.you).toMatchObject({ email: ANITA, isAdmin: false });
        expect((await w.as(ANITA).get('/appraisal/overview')).status).toBe(403);
        expect((await w.as(ANITA).post('/appraisal/staff', { name: 'Friend' })).status).toBe(403);
        expect(w.writes).toEqual([]);
        const boss = await w.as(BOSS).get('/appraisal/me');
        expect(boss.body.you).toMatchObject({ email: BOSS, isAdmin: true });
    });

    test('starts with the five office staff and their jobs, not the People list', async () => {
        const w = makeWorld();
        const ov = await overview(w, null);
        expect(ov.people.map((p) => p.id)).toEqual(FIVE);
        const rolesBy = Object.fromEntries(ov.people.map((p) => [p.id, p.mgr.roles]));
        expect(rolesBy['kavitha@testing-site']).toEqual(['r_admin']);
        for (const id of FIVE.filter((x) => x !== 'kavitha@testing-site')) expect(rolesBy[id]).toEqual(['r_sales', 'r_admin']);
        expect(ov.people.map((p) => p.name)).toEqual(['Jayanthi', 'Kavitha', 'Pavithra', 'Ramesh', 'Ramya']);
    });

    test('every key it writes starts with "preview-"; saved jobs replace the starting ones', async () => {
        const w = makeWorld();
        const t = w.as(null);
        const pav = 'pavithra@testing-site';
        expect((await t.post('/appraisal/staff', { name: 'Trial person' })).status).toBe(200);
        expect((await t.put('/appraisal/profile/' + pav, { roles: ['r_sales'], targets: 'x' })).status).toBe(200);
        expect((await t.put(`/appraisal/review/ramesh@testing-site/${Q2}`, { review: { scores: { c_b1: 6 } } })).status).toBe(200);
        expect((await t.put(`/appraisal/meeting/ramya@testing-site/${H1}`, { meeting: { raisePct: 5 } })).status).toBe(200);
        expect((await t.put('/appraisal/setup', { setup: clone(A.DEFAULT_SETUP), baseSavedAt: null })).status).toBe(200);
        expect((await t.del('/appraisal/staff/kavitha@testing-site')).status).toBe(200);
        expect((await t.post('/appraisal/staff/kavitha@testing-site/restore')).status).toBe(200);

        expect(w.writes.length).toBeGreaterThanOrEqual(7);
        for (const k of w.writes) expect(k).toMatch(/^preview-appraisal-/);

        const ov = await overview(w, null);
        expect(personIn(ov, pav).mgr.roles).toEqual(['r_sales']);
        expect(personIn(ov, 'jayanthi@testing-site').mgr.roles).toEqual(['r_sales', 'r_admin']);
    });

    test('the live site does not see the testing site\'s files', async () => {
        const w = makeWorld();
        expect((await w.as(null).post('/appraisal/staff', { name: 'Trial person' })).status).toBe(200);
        delete process.env.VERCEL_ENV;
        const ov = await overview(w, BOSS);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('another deployment (CONFIG_PREFIX set)', () => {
    afterEach(() => { delete process.env.CONFIG_PREFIX; });

    test('keeps its own appraisal files; the main site never reads them', async () => {
        const w = makeWorld();
        process.env.CONFIG_PREFIX = 'other-';
        expect((await w.as(BOSS).post('/appraisal/staff', { name: 'Other site person' })).status).toBe(200);
        expect((await saveProfile(w, ANITA, { roles: ['r_sales'], targets: 'other site target' })).status).toBe(200);
        expect(w.writes).toHaveLength(2);
        for (const k of w.writes) expect(k).toMatch(/^other-appraisal-/);

        delete process.env.CONFIG_PREFIX;
        const ov = await overview(w);
        expect(ov.people.map((p) => p.id)).toEqual([ANITA, BALA]);
        expect(personIn(ov, ANITA).mgr.targets).toBeUndefined();
    });
});
