/**
 * tests/appraisal-reminder.test.js
 *
 * The daily "appraisal reviews still due" email to the office (vercel.json cron, 9 am India time).
 *
 * Covers:
 *   - utils/appraisalReminder.js — which quarter is due (India time, financial year), whether a
 *     reminder may go out for it (never for the Jul–Sep 2026 batch, never before the round the
 *     appraisal was first set up for), who is still missing something, and the email itself.
 *   - utils/onceClaim.js — "only the first caller wins" for one day's slot, with a fake DynamoDB
 *     client that really honours attribute_not_exists and answers a little later, like the network.
 *   - GET /api/appraisal/reminders/run through supertest — locked without CRON_SECRET, one email a
 *     day however many runs race, a failed send gives the day back, the reply never names anyone.
 *   - utils/auth.js isPublicRequest and vercel.json — the scheduler can reach the route, nothing else
 *     under /api/appraisal opens up, and the cron fires at 03:30 UTC = 09:00 India time.
 *
 * Every fixture is built with the app's own sanitizers (sanitizeSelfReview / sanitizeManagerReview),
 * so no test leans on a shape the app could never save. Time is pinned with a Date.now spy.
 */

jest.mock('../utils/gmail', () => ({ sendEmail: jest.fn() }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const R = require('../utils/appraisalReminder');
const A = require('../utils/appraisal');
const { createOnceClaim } = require('../utils/onceClaim');
const { createAppraisalRouter } = require('../routes/appraisal');
const auth = require('../utils/auth');
const { sendEmail } = require('../utils/gmail');
const { ONCE_CLAIM_PREFIX, ENTITY_ONCE_CLAIM, APPRAISAL_REMINDER_EMAIL } = require('../utils/constants');

const at = (iso) => Date.parse(iso);
const Q3 = '2026-27-Q3';                                   // Oct–Dec 2026, the first that may be reminded

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────

const tick = () => new Promise((r) => setImmediate(r));

/** A DynamoDB document client that does what the real one does with these two commands: a Put
 *  with attribute_not_exists(<attr>) is refused when an item with that key already has <attr>,
 *  atomically, after a network-ish pause — so twenty racing callers really do race. */
function fakeDynamo() {
    const items = new Map();
    const sent = [];
    let failPutWith = null;
    const client = {
        async send(cmd) {
            sent.push(cmd);
            await tick();
            if (cmd instanceof PutCommand) {
                if (failPutWith) throw failPutWith;
                const { Item, ConditionExpression } = cmd.input;
                const cond = /^attribute_not_exists\((\w+)\)$/.exec(ConditionExpression || '');
                const existing = items.get(Item.id);
                if (cond && existing && existing[cond[1]] !== undefined) {
                    const e = new Error('The conditional request failed');
                    e.name = 'ConditionalCheckFailedException';
                    throw e;
                }
                items.set(Item.id, { ...Item });
                return {};
            }
            if (cmd instanceof DeleteCommand) { items.delete(cmd.input.Key.id); return {}; }
            throw new Error('fake DynamoDB: unexpected command');
        },
    };
    return { client, items, sent, failPuts(err) { failPutWith = err; } };
}

/** The storage layer's readText/saveText, in memory: null for a file that isn't there. */
function memoryStorage(initial) {
    const files = new Map(Object.entries(initial || {}));
    return {
        files,
        async readText(k) { await tick(); return files.has(k) ? files.get(k) : null; },
        async saveText(k, v) { await tick(); files.set(k, String(v)); },
    };
}

// ── Fixtures, through the app's own sanitizers ───────────────────────────────────────────────

const SETUP = A.DEFAULT_SETUP;
const ALL_SCORES = { c_s1: 7, c_s2: 7, c_s3: 7, c_s4: 7, c_s5: 7, c_s6: 7, c_d5: 7, c_d6: 7, c_d7: 7, c_b1: 7, c_b2: 7, c_b3: 7, c_b4: 7, c_p1: 7 };
const selfSubmitted = () => ({ ...A.sanitizeSelfReview({ scores: ALL_SCORES }, SETUP), submittedAt: '2027-01-02T05:00:00.000Z', savedAt: '2027-01-02T05:00:00.000Z' });
const mgrReview = (src) => ({ ...A.sanitizeManagerReview(src, SETUP), savedAt: '2027-01-03T05:00:00.000Z' });
const selfFile = (reviews) => ({ reviews: reviews || {} });
const mgrFile = (reviews) => (reviews ? { reviews } : {});

// ── Shared environment / clock handling ──────────────────────────────────────────────────────

const ENV_KEYS = ['CRON_SECRET', 'PUBLIC_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_ENV', 'CONFIG_PREFIX'];
let savedEnv;
let clock;
beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    clock = jest.spyOn(Date, 'now');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ id: 'gmail-msg-1' });
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// utils/appraisalReminder.js
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('istDay — the day as a clock in India shows it', () => {
    test('one minute either side of India midnight are different days, though the same UTC day', () => {
        expect(R.istDay(at('2026-09-30T18:29:00Z'))).toBe('2026-09-30');
        expect(R.istDay(at('2026-09-30T18:31:00Z'))).toBe('2026-10-01');
    });
    test('pads month and day', () => {
        expect(R.istDay(at('2027-01-05T03:30:00Z'))).toBe('2027-01-05');
    });
});

describe('dueQuarter — the financial-year quarter that ended most recently, India time', () => {
    const cases = [
        // instant (UTC)            India time            key             label
        ['2026-09-30T18:29:00Z', /* 30 Sep 23:59 */ '2026-27-Q1', 'Q1 · Apr–Jun 2026', [2026, 1]],
        ['2026-09-30T18:31:00Z', /*  1 Oct 00:01 */ '2026-27-Q2', 'Q2 · Jul–Sep 2026', [2026, 2]],
        ['2026-12-31T18:29:00Z', /* 31 Dec 23:59 */ '2026-27-Q2', 'Q2 · Jul–Sep 2026', [2026, 2]],
        ['2026-12-31T18:31:00Z', /*  1 Jan 00:01 */ '2026-27-Q3', 'Q3 · Oct–Dec 2026', [2026, 3]],
        ['2027-03-31T18:29:00Z', /* 31 Mar 23:59 */ '2026-27-Q3', 'Q3 · Oct–Dec 2026', [2026, 3]],
        ['2027-03-31T18:31:00Z', /*  1 Apr 00:01 */ '2026-27-Q4', 'Q4 · Jan–Mar 2027', [2026, 4]],
        ['2026-03-31T18:31:00Z', /*  1 Apr 2026  */ '2025-26-Q4', 'Q4 · Jan–Mar 2026', [2025, 4]],
        ['2027-06-30T18:31:00Z', /*  1 Jul 2027  */ '2027-28-Q1', 'Q1 · Apr–Jun 2027', [2027, 1]],
    ];
    test.each(cases)('%s → %s (%s)', (iso, key, label, [fy, q]) => {
        const d = R.dueQuarter(at(iso));
        expect(d.key).toBe(key);
        expect(d.label).toBe(label);
        // Same key format the saved reviews are filed under, or no review would ever be found.
        expect(d.key).toBe(A.quarterKey(fy, q));
        expect(A.isQuarterKey(d.key)).toBe(true);
        expect(d.endsMs).toBe(R.quarterEndMs(fy, q));
    });
    test('Q4 → Q1: on 1 April India time the due quarter is Jan–Mar of the year just gone, keyed to the old financial year', () => {
        const before = R.dueQuarter(at('2027-03-31T18:29:00Z'));
        const after = R.dueQuarter(at('2027-03-31T18:31:00Z'));
        expect(before.key).toBe('2026-27-Q3');
        expect(after.key).toBe('2026-27-Q4');
        expect(after.label).toBe('Q4 · Jan–Mar 2027');
    });
});

describe('quarterEndMs — the last instant of a quarter, India time', () => {
    test('each quarter ends at India midnight, 18:30 UTC the day before, minus 1 ms', () => {
        expect(R.quarterEndMs(2026, 1)).toBe(at('2026-06-30T18:30:00Z') - 1);
        expect(R.quarterEndMs(2026, 2)).toBe(at('2026-09-30T18:30:00Z') - 1);
        expect(R.quarterEndMs(2026, 3)).toBe(at('2026-12-31T18:30:00Z') - 1);
        expect(R.quarterEndMs(2026, 4)).toBe(at('2027-03-31T18:30:00Z') - 1);
    });
});

describe('quarterIsDue — when a reminder may go out', () => {
    const Q2_2026 = R.dueQuarter(at('2026-10-16T03:30:00Z'));   // Jul–Sep 2026 (the first batch)
    const Q3_2026 = R.dueQuarter(at('2027-01-05T03:30:00Z'));   // Oct–Dec 2026
    const Q4_2026 = R.dueQuarter(at('2027-04-05T03:30:00Z'));   // Jan–Mar 2027
    const Q1_2027 = R.dueQuarter(at('2027-07-05T03:30:00Z'));   // Apr–Jun 2027
    const savedOn = (iso) => ({ ...SETUP, startedAt: iso, savedAt: iso });

    test('fixture check: the four quarters are the ones named', () => {
        expect([Q2_2026.key, Q3_2026.key, Q4_2026.key, Q1_2027.key]).toEqual(['2026-27-Q2', '2026-27-Q3', '2026-27-Q4', '2027-28-Q1']);
    });

    test('the starter setup (Setup never saved) is never due', () => {
        // Exactly what readSetup hands over when nothing is stored.
        expect(R.quarterIsDue({ ...SETUP, savedAt: null }, true, Q3_2026)).toBe(false);
        expect(R.quarterIsDue({ ...SETUP, savedAt: null }, true, Q1_2027)).toBe(false);
    });

    test('Jul–Sep 2026 is never reminded — even with Setup saved in August, May or the day it ended', () => {
        expect(R.quarterIsDue(savedOn('2026-08-10T06:00:00.000Z'), false, Q2_2026)).toBe(false);
        expect(R.quarterIsDue(savedOn('2026-05-10T06:00:00.000Z'), false, Q2_2026)).toBe(false);
        // Set up on 16 Oct 2026: the page asks everyone for Jul–Sep, but the owner said no reminders for it.
        expect(R.quarterIsDue(savedOn('2026-10-16T05:00:00.000Z'), false, Q2_2026)).toBe(false);
    });

    test('Oct–Dec 2026 is reminded once Setup is saved', () => {
        expect(R.quarterIsDue(savedOn('2026-08-10T06:00:00.000Z'), false, Q3_2026)).toBe(true);
        expect(R.quarterIsDue(savedOn('2026-10-16T05:00:00.000Z'), false, Q3_2026)).toBe(true);
    });

    test('a setup saved late: its first round is due, the quarters before it never are', () => {
        const late = savedOn('2027-08-15T06:00:00.000Z');          // in Jul–Sep 2027 → first round Apr–Jun 2027
        expect(R.quarterIsDue(late, false, Q1_2027)).toBe(true);    // the round the page asked for first
        expect(R.quarterIsDue(late, false, Q4_2026)).toBe(false);   // after the first-batch rule, but before set-up
        expect(R.quarterIsDue(late, false, Q3_2026)).toBe(false);
    });

    test('the first round turns over at India midnight on the day Setup is saved', () => {
        // 31 Mar 2027 23:59 India → the round asked for is Oct–Dec 2026; 1 Apr 00:01 → Jan–Mar 2027.
        expect(R.quarterIsDue(savedOn('2027-03-31T18:29:00.000Z'), false, Q3_2026)).toBe(true);
        expect(R.quarterIsDue(savedOn('2027-03-31T18:31:00.000Z'), false, Q3_2026)).toBe(false);
        expect(R.quarterIsDue(savedOn('2027-03-31T18:31:00.000Z'), false, Q4_2026)).toBe(true);
    });

    test('a later Setup save does not move the start: startedAt wins over savedAt', () => {
        // PUT /appraisal/setup keeps startedAt and moves savedAt — the real shape after a re-save.
        const resaved = { ...SETUP, startedAt: '2026-08-10T06:00:00.000Z', savedAt: '2027-08-15T06:00:00.000Z' };
        expect(R.quarterIsDue(resaved, false, Q3_2026)).toBe(true);
    });

    test('an older setup with only savedAt counts from that save', () => {
        expect(R.quarterIsDue({ ...SETUP, savedAt: '2026-08-10T06:00:00.000Z' }, false, Q3_2026)).toBe(true);
        expect(R.quarterIsDue({ ...SETUP, savedAt: '2027-08-15T06:00:00.000Z' }, false, Q3_2026)).toBe(false);
    });
});

describe('missingFor — who still has something missing for a quarter', () => {
    const OTHER_Q = '2026-27-Q2';
    const people = [
        { name: 'Zara All Done',      self: selfFile({ [Q3]: selfSubmitted() }), mgr: mgrFile({ [Q3]: mgrReview({ scores: ALL_SCORES, done: true }) }) },
        { name: 'Bala Paper Form',    self: selfFile(),                          mgr: mgrFile({ [Q3]: mgrReview({ scores: ALL_SCORES, done: true, selfByMgr: { scores: ALL_SCORES } }) }) },
        { name: 'Chitra Paper Draft', self: selfFile(),                          mgr: mgrFile({ [Q3]: mgrReview({ scores: { c_p1: 6 }, done: false, selfByMgr: { scores: ALL_SCORES } }) }) },
        { name: 'Deepa Own Only',     self: selfFile({ [Q3]: selfSubmitted() }), mgr: mgrFile({ [Q3]: mgrReview({ scores: { c_p1: 6 }, done: false }) }) },
        { name: 'Esha Review Only',   self: selfFile(),                          mgr: mgrFile({ [Q3]: mgrReview({ scores: ALL_SCORES, done: true }) }) },
        { name: 'Farid Nothing',      self: selfFile(),                          mgr: mgrFile() },
        { name: 'Gita Last Quarter',  self: selfFile({ [OTHER_Q]: selfSubmitted() }), mgr: mgrFile({ [OTHER_Q]: mgrReview({ scores: ALL_SCORES, done: true }) }) },
        // Added at India midnight on 1 Jan 2027 — after Oct–Dec ended.
        { name: 'Hari Late Joiner',   addedAt: '2026-12-31T18:30:00.000Z', self: selfFile(), mgr: mgrFile() },
        // Added one second before India midnight — still inside Oct–Dec.
        { name: 'Indu Just In Time',  addedAt: '2026-12-31T18:29:59.000Z', self: selfFile(), mgr: mgrFile() },
        { name: 'Arun No Date',       self: selfFile(),                          mgr: mgrFile() },
    ];

    test('fixture check: the app keeps a typed-in paper form only when it has scores', () => {
        expect(people[1].mgr.reviews[Q3].selfByMgr).toBeDefined();
        expect(Object.keys(people[1].mgr.reviews[Q3].selfByMgr.scores).length).toBeGreaterThan(0);
    });

    test('lists each person with what is missing, sorted by name', () => {
        expect(R.missingFor(people, Q3)).toEqual([
            { name: 'Arun No Date',       formMissing: true,  reviewMissing: true },
            { name: 'Chitra Paper Draft', formMissing: false, reviewMissing: true },
            { name: 'Deepa Own Only',     formMissing: false, reviewMissing: true },
            { name: 'Esha Review Only',   formMissing: true,  reviewMissing: false },
            { name: 'Farid Nothing',      formMissing: true,  reviewMissing: true },
            { name: 'Gita Last Quarter',  formMissing: true,  reviewMissing: true },
            { name: 'Indu Just In Time',  formMissing: true,  reviewMissing: true },
        ]);
    });

    test('a form a manager typed in from paper counts as their form — but not as the review', () => {
        const out = R.missingFor(people, Q3);
        expect(out.find((m) => m.name === 'Bala Paper Form')).toBeUndefined();
        expect(out.find((m) => m.name === 'Chitra Paper Draft')).toEqual({ name: 'Chitra Paper Draft', formMissing: false, reviewMissing: true });
    });

    test('someone added after the quarter ended (India time) is skipped; one added a second before is not', () => {
        const names = R.missingFor(people, Q3).map((m) => m.name);
        expect(names).not.toContain('Hari Late Joiner');
        expect(names).toContain('Indu Just In Time');
        // For the next quarter (Jan–Mar 2027) the late joiner is due like everyone else.
        expect(R.missingFor(people, '2026-27-Q4').map((m) => m.name)).toContain('Hari Late Joiner');
    });

    test('nothing to check → nobody missing', () => {
        expect(R.missingFor([], Q3)).toEqual([]);
        expect(R.missingFor(undefined, Q3)).toEqual([]);
    });
});

describe('reminderEmail', () => {
    const due = R.dueQuarter(at('2027-01-05T03:30:00Z'));
    const LINK = 'https://quotes.example/appraisal.html';

    test('a name is escaped, never injected as HTML', () => {
        const { bodyHtml } = R.reminderEmail(due, [{ name: '<b>x</b>', formMissing: true, reviewMissing: false }], LINK);
        expect(bodyHtml).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(bodyHtml).not.toContain('<b>x</b>');
        const { bodyHtml: b2 } = R.reminderEmail(due, [{ name: "O'Brien & Co", formMissing: true, reviewMissing: true }], LINK);
        expect(b2).toContain('O&#39;Brien &amp; Co');
    });

    test('subject and counts', () => {
        const one = R.reminderEmail(due, [{ name: 'A', formMissing: true, reviewMissing: false }], LINK);
        expect(one.subject).toBe('Appraisal reminder: 1 person still due for Q3 · Oct–Dec 2026');
        const two = R.reminderEmail(due, [
            { name: 'A', formMissing: true, reviewMissing: true },
            { name: 'B', formMissing: false, reviewMissing: true },
        ], LINK);
        expect(two.subject).toBe('Appraisal reminder: 2 people still due for Q3 · Oct–Dec 2026');
        expect(two.bodyHtml).toContain('1 form not filled · 2 manager reviews not marked done.');
    });

    test('links to the appraisal page', () => {
        const { bodyHtml } = R.reminderEmail(due, [{ name: 'A', formMissing: true, reviewMissing: true }], LINK);
        expect(bodyHtml).toContain('href="' + LINK + '"');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// utils/onceClaim.js
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('onceClaim with the database', () => {
    const withDb = (db) => createOnceClaim({ getDb: () => ({ client: db.client, table: 'dsc-test' }), storage: memoryStorage() });

    test('20 claims at the same instant → exactly one wins', async () => {
        const db = fakeDynamo();
        const once = withDb(db);
        const results = await Promise.all(Array.from({ length: 20 }, () => once.claim('appraisal-reminder-2027-01-05')));
        expect(results.filter((r) => r === true)).toHaveLength(1);
        expect(results.filter((r) => r === false)).toHaveLength(19);
        expect(db.items.size).toBe(1);
        const row = db.items.get(ONCE_CLAIM_PREFIX + 'appraisal-reminder-2027-01-05');
        expect(row).toBeDefined();
        expect(row._entity).toBe(ENTITY_ONCE_CLAIM);
        expect(db.sent[0].input.TableName).toBe('dsc-test');
    });

    test('different names do not block each other', async () => {
        const once = withDb(fakeDynamo());
        expect(await once.claim('a')).toBe(true);
        expect(await once.claim('b')).toBe(true);
        expect(await once.claim('a')).toBe(false);
    });

    test('release gives the slot back, so it can be claimed again', async () => {
        const db = fakeDynamo();
        const once = withDb(db);
        expect(await once.claim('day')).toBe(true);
        expect(await once.claim('day')).toBe(false);
        await once.release('day');
        expect(db.items.size).toBe(0);
        expect(await once.claim('day')).toBe(true);
    });

    test('any other database error is thrown, never read as "already claimed"', async () => {
        const db = fakeDynamo();
        const err = new Error('Rate exceeded');
        err.name = 'ProvisionedThroughputExceededException';
        db.failPuts(err);
        await expect(withDb(db).claim('day')).rejects.toBe(err);
    });
});

describe('onceClaim without a database (a copy running on a computer) — a marker file', () => {
    test('no database at all: first claim wins, second does not, release frees it', async () => {
        const storage = memoryStorage();
        const once = createOnceClaim({ getDb: () => null, storage });
        expect(await once.claim('day')).toBe(true);
        expect(storage.files.has('once-claim-day.json')).toBe(true);
        expect(await once.claim('day')).toBe(false);
        await once.release('day');
        expect(await once.claim('day')).toBe(true);
    });

    test('a client with no table name uses the file too, and never calls the database', async () => {
        const db = fakeDynamo();
        const storage = memoryStorage();
        const once = createOnceClaim({ getDb: () => ({ client: db.client, table: '' }), storage });
        expect(await once.claim('day')).toBe(true);
        expect(await once.claim('day')).toBe(false);
        expect(db.sent).toHaveLength(0);
        expect(storage.files.has('once-claim-day.json')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GET /api/appraisal/reminders/run
// ═════════════════════════════════════════════════════════════════════════════════════════════

const VERCEL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const CRON = (VERCEL.crons || []).find((c) => c.path === '/api/appraisal/reminders/run') || {};
const RUN_PATH = '/api/appraisal/reminders/run';

const SECRET = 'cron-secret-for-tests-7f3a';
const T_JAN = at('2027-01-05T03:30:00Z');                    // 09:00 India time, 5 Jan 2027 → Oct–Dec 2026 due
const SETUP_AUG = { ...SETUP, startedAt: '2026-08-10T06:00:00.000Z', savedAt: '2026-08-10T06:00:00.000Z' };
const USERS = [
    { name: 'Owner', email: 'owner@dsc.example', role: 'admin' },
    { name: 'Pavithra Sundaram', email: 'pavithra@dsc.example' },
];
const STAFF = [
    { id: 'st-pavithra', name: 'Pavithra Sundaram', email: 'pavithra@dsc.example', addedAt: '2026-08-01T05:00:00.000Z' },
    { id: 'st-ramesh', name: 'Ramesh Kumar', email: '', addedAt: '2026-09-01T05:00:00.000Z' },
    { id: 'st-newbie', name: 'Newbie Joined', email: '', addedAt: '2027-01-03T05:00:00.000Z' },
    { id: 'st-gone', name: 'Gone Removed', email: '', addedAt: '2026-08-01T05:00:00.000Z', removedAt: '2026-11-01T05:00:00.000Z' },
];
const selfKey = (id, pre = '') => pre + 'appraisal-self-' + A.personSlug(id) + '.json';
const mgrKey = (id, pre = '') => pre + 'appraisal-mgr-' + A.personSlug(id) + '.json';

function harness({ setup = SETUP_AUG, staff = STAFF, files = {}, prefix = '', storage, db } = {}) {
    const initial = { ...files };
    if (setup) initial[prefix + 'appraisal-setup.json'] = JSON.stringify(setup);
    if (staff) initial[prefix + 'appraisal-staff.json'] = JSON.stringify({ staff, savedAt: '2026-09-01T05:00:00.000Z' });
    const store = storage || memoryStorage();
    for (const [k, v] of Object.entries(initial)) store.files.set(k, v);
    const dynamo = db || fakeDynamo();
    const onceClaim = createOnceClaim({ getDb: () => ({ client: dynamo.client, table: 'dsc-test' }), storage: store });
    const app = express();
    app.use('/api', createAppraisalRouter({ storage: store, loadUsers: async () => ({ users: USERS, ok: true }), onceClaim }));
    const run = (authorization) => {
        const r = request(app).get(RUN_PATH);
        return authorization === undefined ? r : r.set('Authorization', authorization);
    };
    const reminderRecord = () => JSON.parse(store.files.get(prefix + 'appraisal-reminder.json') || '{}');
    return { app, storage: store, db: dynamo, run, reminderRecord };
}

function liveEnv() {
    process.env.CRON_SECRET = SECRET;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'quotes.dscpipes.example';
}

describe('the reminder route is locked to the scheduler', () => {
    test('no CRON_SECRET set → 401 for every caller, no email, no slot taken', async () => {
        clock.mockReturnValue(T_JAN);
        process.env.VERCEL_PROJECT_PRODUCTION_URL = 'quotes.dscpipes.example';
        const h = harness();
        for (const authz of [undefined, 'Bearer', 'Bearer ', 'Bearer undefined', 'Bearer null']) {
            const res = await h.run(authz);
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: 'Not allowed.' });
        }
        expect(sendEmail).not.toHaveBeenCalled();
        expect(h.db.items.size).toBe(0);
    });

    test('wrong token → 401, no email', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness();
        for (const authz of [undefined, 'Bearer wrong', SECRET, 'Bearer ' + SECRET + 'x', 'bearer ' + SECRET, 'Basic ' + SECRET]) {
            const res = await h.run(authz);
            expect(res.status).toBe(401);
        }
        expect(sendEmail).not.toHaveBeenCalled();
        expect(h.db.items.size).toBe(0);
    });
});

describe('the reminder route sends one email a day while something is due', () => {
    test('the right token sends exactly one email to the office, linking the live site', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness();
        const res = await h.run('Bearer ' + SECRET);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, sent: true });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const mail = sendEmail.mock.calls[0][0];
        expect(mail.to).toBe('info@dscpipes.com');
        expect(APPRAISAL_REMINDER_EMAIL).toBe('info@dscpipes.com');
        expect(mail.subject).toBe('Appraisal reminder: 2 people still due for Q3 · Oct–Dec 2026');
        expect(mail.bodyHtml).toContain('href="https://quotes.dscpipes.example/appraisal.html"');
        expect(mail.bodyHtml).not.toMatch(/127\.0\.0\.1|localhost/);    // never the address the scheduler called
        // Active staff who were there when Oct–Dec ended; not a removed one, not one who joined after.
        expect(mail.bodyHtml).toContain('Pavithra Sundaram');
        expect(mail.bodyHtml).toContain('Ramesh Kumar');
        expect(mail.bodyHtml).not.toContain('Newbie Joined');
        expect(mail.bodyHtml).not.toContain('Gone Removed');
        expect(h.reminderRecord()).toEqual({ lastSentAt: new Date(T_JAN).toISOString(), lastQuarter: Q3, lastCount: 2 });
    });

    test('the reply never carries a name or a count', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness();
        const first = await h.run('Bearer ' + SECRET);
        const again = await h.run('Bearer ' + SECRET);
        expect(first.text).toBe('{"ok":true,"sent":true}');
        expect(again.body).toEqual({ ok: true, sent: false, reason: 'Already sent today.' });
        for (const res of [first, again]) {
            expect(res.text).not.toMatch(/Pavithra|Ramesh|people|person|\d/);
        }
    });

    test('PUBLIC_URL, when set, is the link (trailing slash dropped)', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        process.env.PUBLIC_URL = 'https://app.dscpipes.example/';
        const h = harness();
        await h.run('Bearer ' + SECRET);
        expect(sendEmail.mock.calls[0][0].bodyHtml).toContain('href="https://app.dscpipes.example/appraisal.html"');
    });

    test('20 runs at the same instant → exactly one email', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness();
        const replies = await Promise.all(Array.from({ length: 20 }, () => h.run('Bearer ' + SECRET)));
        expect(replies.every((r) => r.status === 200)).toBe(true);
        expect(replies.filter((r) => r.body.sent === true)).toHaveLength(1);
        expect(replies.filter((r) => r.body.sent === false && r.body.reason === 'Already sent today.')).toHaveLength(19);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect([...h.db.items.keys()]).toEqual([ONCE_CLAIM_PREFIX + 'appraisal-reminder-2027-01-05']);
    });

    test('a second run the same India day sends nothing; the next India day sends again', async () => {
        liveEnv();
        const h = harness();
        clock.mockReturnValue(T_JAN);                                   // 09:00 India, 5 Jan
        expect((await h.run('Bearer ' + SECRET)).body.sent).toBe(true);
        clock.mockReturnValue(at('2027-01-05T18:29:00Z'));              // 23:59 India, still 5 Jan
        expect((await h.run('Bearer ' + SECRET)).body).toEqual({ ok: true, sent: false, reason: 'Already sent today.' });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(at('2027-01-05T18:31:00Z'));              // 00:01 India, 6 Jan — same UTC day
        expect((await h.run('Bearer ' + SECRET)).body).toEqual({ ok: true, sent: true });
        expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    test('Gmail fails → 502 with a plain message, the day is given back, the failure is recorded, a re-run sends', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness();
        sendEmail.mockRejectedValueOnce(new Error('invalid_grant: Token has been expired or revoked.'));
        const failed = await h.run('Bearer ' + SECRET);
        expect(failed.status).toBe(502);
        expect(failed.body).toEqual({ error: 'The reminder email could not be sent.' });
        expect(failed.text).not.toMatch(/invalid_grant|Pavithra|Ramesh/);
        expect(h.db.items.size).toBe(0);                                // slot released
        const rec = h.reminderRecord();
        expect(rec.lastFailedAt).toBe(new Date(T_JAN).toISOString());
        expect(rec.lastError).toContain('invalid_grant');
        expect(rec.lastSentAt).toBeUndefined();

        clock.mockReturnValue(T_JAN + 10 * 60 * 1000);                  // ten minutes later, same day
        const retry = await h.run('Bearer ' + SECRET);
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual({ ok: true, sent: true });
        expect(sendEmail).toHaveBeenCalledTimes(2);
        const after = h.reminderRecord();
        expect(after.lastSentAt).toBe(new Date(T_JAN + 10 * 60 * 1000).toISOString());
        expect(after.lastFailedAt).toBe(new Date(T_JAN).toISOString());  // the earlier failure is kept
    });

    test('the database cannot say who claimed the day → no email, 503', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness();
        const err = new Error('socket hang up');
        err.name = 'TimeoutError';
        h.db.failPuts(err);
        const res = await h.run('Bearer ' + SECRET);
        expect(res.status).toBe(503);
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

describe('the reminder route stays quiet when nothing is due', () => {
    test('16 Oct 2026 (Jul–Sep due) with Setup saved in August → no email, no slot used', async () => {
        clock.mockReturnValue(at('2026-10-16T03:30:00Z'));
        liveEnv();
        const h = harness();
        const res = await h.run('Bearer ' + SECRET);
        expect(res.body).toEqual({ ok: true, sent: false, reason: 'No quarter is due yet.' });
        expect(sendEmail).not.toHaveBeenCalled();
        expect(h.db.items.size).toBe(0);
    });

    test('Setup never saved → no email', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const h = harness({ setup: null });
        const res = await h.run('Bearer ' + SECRET);
        expect(res.body).toEqual({ ok: true, sent: false, reason: 'No quarter is due yet.' });
        expect(sendEmail).not.toHaveBeenCalled();
    });

    test('everything filled and done → no email, and the day is not used up', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const files = {};
        for (const id of ['st-pavithra', 'st-ramesh']) {
            files[selfKey(id)] = JSON.stringify(selfFile({ [Q3]: selfSubmitted() }));
            files[mgrKey(id)] = JSON.stringify(mgrFile({ [Q3]: mgrReview({ scores: ALL_SCORES, done: true }) }));
        }
        const h = harness({ files });
        const res = await h.run('Bearer ' + SECRET);
        expect(res.body).toEqual({ ok: true, sent: false, reason: 'Everything is filled and done.' });
        expect(sendEmail).not.toHaveBeenCalled();
        expect(h.db.items.size).toBe(0);
    });

    test('one person still missing their review → the email names only them', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const files = {
            [selfKey('st-pavithra')]: JSON.stringify(selfFile({ [Q3]: selfSubmitted() })),
            [mgrKey('st-pavithra')]: JSON.stringify(mgrFile({ [Q3]: mgrReview({ scores: ALL_SCORES, done: true }) })),
            [selfKey('st-ramesh')]: JSON.stringify(selfFile({ [Q3]: selfSubmitted() })),
            [mgrKey('st-ramesh')]: JSON.stringify(mgrFile({ [Q3]: mgrReview({ scores: { c_p1: 5 }, done: false }) })),
        };
        const h = harness({ files });
        const res = await h.run('Bearer ' + SECRET);
        expect(res.body).toEqual({ ok: true, sent: true });
        const mail = sendEmail.mock.calls[0][0];
        expect(mail.subject).toBe('Appraisal reminder: 1 person still due for Q3 · Oct–Dec 2026');
        expect(mail.bodyHtml).toContain('Ramesh Kumar');
        expect(mail.bodyHtml).not.toContain('Pavithra Sundaram');
    });
});

describe('the testing site has its own day slot', () => {
    test('a run on the testing site does not use up the live site\'s email for the day', async () => {
        clock.mockReturnValue(T_JAN);
        liveEnv();
        const storage = memoryStorage();
        const db = fakeDynamo();
        // Same storage and same database, as on Vercel: the preview build's files carry "preview-".
        const live = harness({ storage, db });
        const preview = harness({ storage, db, prefix: 'preview-' });

        process.env.VERCEL_ENV = 'preview';
        expect((await preview.run('Bearer ' + SECRET)).body).toEqual({ ok: true, sent: true });

        delete process.env.VERCEL_ENV;
        expect((await live.run('Bearer ' + SECRET)).body).toEqual({ ok: true, sent: true });
        expect(sendEmail).toHaveBeenCalledTimes(2);
        expect([...db.items.keys()].sort()).toEqual([
            ONCE_CLAIM_PREFIX + 'appraisal-reminder-2027-01-05',
            ONCE_CLAIM_PREFIX + 'preview-appraisal-reminder-2027-01-05',
        ]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The scheduler can reach it: utils/auth.js and vercel.json
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('isPublicRequest — only the reminder run is open without a session', () => {
    test('GET /api/appraisal/reminders/run needs no session (it checks CRON_SECRET itself)', () => {
        expect(auth.isPublicRequest('GET', '/api/appraisal/reminders/run', {})).toBe(true);
        expect(auth.isPublicRequest('GET', '/api/appraisal/reminders/run/', {})).toBe(true);
    });

    test('everything else under /api/appraisal still needs a session', () => {
        for (const p of [
            '/api/appraisal/overview', '/api/appraisal/me', '/api/appraisal/setup', '/api/appraisal/staff',
            '/api/appraisal/reminders', '/api/appraisal/reminders/run/now', '/api/appraisal/review/st-1/2026-27-Q3',
        ]) {
            expect([p, auth.isPublicRequest('GET', p, {})]).toEqual([p, false]);
        }
        expect(auth.isPublicRequest('PUT', '/api/appraisal/setup', {})).toBe(false);
    });
});

describe('vercel.json — the daily cron', () => {
    test('calls the reminder route at 03:30 UTC, which is 09:00 India time', () => {
        expect(CRON.path).toBe(RUN_PATH);
        expect(CRON.schedule).toBe('30 3 * * *');
        const [min, hour] = CRON.schedule.split(' ').map(Number);
        expect((hour * 60 + min + 5 * 60 + 30) % (24 * 60)).toBe(9 * 60);
    });

    test('server.js mounts the reminder router under /api with the database-backed claim', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        expect(src).toMatch(/^app\.use\('\/api', createAppraisalRouter\(\{[^\n]*onceClaim: require\('\.\/utils\/onceClaim'\)\.createOnceClaim\(\{ getDb: \(\) => \(\{ client: ddbDocClient, table: ddbTableName \}\)/m);
    });
});
