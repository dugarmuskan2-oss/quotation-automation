'use strict';

/**
 * tests/appraisal-rules.test.js — the staff appraisal's pure rules (utils/appraisal.js).
 *
 * What the owner set, and what these tests pin:
 *  - Scores run 1 to 10. Two parts: Work results 70%, Behaviour 30%.
 *  - Jobs: Sales (6 items) and Administration (3 items). No Accounts. No Discipline part.
 *    Behaviour has 5 items, one of them Attendance and punctuality.
 *  - Raise by rating: 9+ 12%, 8+ 10%, 7+ 7%, 6+ 5%, 5+ 2%, below that 0%.
 *  - Each person is scored on their own jobs' items + Behaviour, minus shared items removed
 *    for them alone, plus extra items set for them alone.
 *  - A profile save whose own items no longer fit Setup is REFUSED, never silently trimmed.
 *
 * Every weighted-total case is built so the right rule and a plausible wrong rule give
 * different numbers (70/30 vs equal weights, hidden excluded vs counted, jobs pooled vs
 * averaged per job). A case that reads the same either way proves nothing.
 */

const A = require('../utils/appraisal');

const {
    GROUPS, SCORE_MAX, DEFAULT_SETUP,
    groupsFor, weightedTotal, itemCount, unscoredCount, raiseFor,
    sanitizeSetup, sanitizeSelfReview, sanitizeManagerReview, sanitizeProfile,
    sanitizeNewStaff, newStaffId,
    isQuarterKey, isHalfKey, quartersOfHalf, quarterKey, halfKey,
} = A;

const ids = (list) => list.map((c) => c.id);
const SALES = ['c_s1', 'c_s2', 'c_s3', 'c_s4', 'c_s5', 'c_s6'];
const ADMIN = ['c_d5', 'c_d6', 'c_d7'];
const BEHAVIOUR = ['c_b1', 'c_b2', 'c_b3', 'c_b4', 'c_p1'];

/** Give every id in `list` the same score. */
function scoreAll(list, n, into) {
    const out = into || {};
    for (const id of list) out[id] = n;
    return out;
}

/** A setup made the way the server makes one: through sanitizeSetup. */
function setupFrom(input) {
    const r = sanitizeSetup(input);
    if (r.error) throw new Error('fixture setup refused: ' + r.error);
    return r.setup;
}

// ── The starter setup ───────────────────────────────────────────────────────

describe('DEFAULT_SETUP — the owner\'s scoring list', () => {
    test('scores run 1 to 10, with a named meaning for every score', () => {
        expect(SCORE_MAX).toBe(10);
        expect(DEFAULT_SETUP.scale.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        for (const s of DEFAULT_SETUP.scale) expect(s.label.trim()).not.toBe('');
    });

    test('two parts only, Work results 70 and Behaviour 30', () => {
        expect(GROUPS).toEqual(['work', 'behaviour']);
        expect(DEFAULT_SETUP.weights).toEqual({ work: 70, behaviour: 30 });
    });

    test('jobs are Sales (6 items) and Administration (3 items), nothing else', () => {
        expect(DEFAULT_SETUP.roles.map((r) => [r.id, r.name])).toEqual([['r_sales', 'Sales'], ['r_admin', 'Administration']]);
        expect(ids(DEFAULT_SETUP.roles[0].criteria)).toEqual(SALES);
        expect(ids(DEFAULT_SETUP.roles[1].criteria)).toEqual(ADMIN);
        expect(DEFAULT_SETUP.roles[0].criteria.map((c) => c.name)).toContain('Keeping in touch');
    });

    test('no Accounts job and no Discipline part anywhere', () => {
        const text = JSON.stringify(DEFAULT_SETUP).toLowerCase();
        expect(text).not.toMatch(/accounts/);
        expect(text).not.toMatch(/disciplin/);
        expect(Object.keys(DEFAULT_SETUP).sort()).toEqual(['behaviour', 'raises', 'roles', 'scale', 'weights']);
    });

    test('Behaviour has 5 items, including Attendance and punctuality (c_p1)', () => {
        expect(ids(DEFAULT_SETUP.behaviour)).toEqual(BEHAVIOUR);
        const att = DEFAULT_SETUP.behaviour.find((c) => c.id === 'c_p1');
        expect(att.name).toBe('Attendance and punctuality');
    });

    test('raise table: 9→12%, 8→10%, 7→7%, 6→5%, 5→2%, else 0%', () => {
        expect(DEFAULT_SETUP.raises.map((r) => [r.min, r.pct])).toEqual([[9, 12], [8, 10], [7, 7], [6, 5], [5, 2], [0, 0]]);
    });

    test('every item id is unique across the whole setup', () => {
        const all = [...DEFAULT_SETUP.roles.flatMap((r) => ids(r.criteria)), ...ids(DEFAULT_SETUP.behaviour)];
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(6 + 3 + 5);
    });

    test('the starter setup survives its own sanitizer unchanged (Setup could save it as is)', () => {
        const r = sanitizeSetup(DEFAULT_SETUP);
        expect(r.error).toBeUndefined();
        expect(r.setup).toEqual(DEFAULT_SETUP);
    });
});

// ── Who is scored on what ───────────────────────────────────────────────────

describe('groupsFor — the items one person is scored on', () => {
    test('Sales only: the 6 Sales items, then all 5 Behaviour items', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        expect(ids(g.work)).toEqual(SALES);
        expect(ids(g.behaviour)).toEqual(BEHAVIOUR);
    });

    test('Administration only: just its 3 items — Sales items are not theirs', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_admin'] });
        expect(ids(g.work)).toEqual(ADMIN);
        expect(itemCount(g)).toBe(3 + 5);
    });

    test('Sales and Administration: both jobs\' items, in Setup order', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_admin', 'r_sales'] });
        expect(ids(g.work)).toEqual([...SALES, ...ADMIN]);
        expect(itemCount(g)).toBe(14);
    });

    test('no jobs (or no profile at all): Behaviour only', () => {
        expect(ids(groupsFor(DEFAULT_SETUP, { roles: [] }).work)).toEqual([]);
        const g = groupsFor(DEFAULT_SETUP, undefined);
        expect(ids(g.work)).toEqual([]);
        expect(ids(g.behaviour)).toEqual(BEHAVIOUR);
    });

    test('a shared job item removed for this person only drops out of Work results', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], hidden: ['c_s2'] });
        expect(ids(g.work)).toEqual(['c_s1', 'c_s3', 'c_s4', 'c_s5', 'c_s6']);
        expect(ids(g.behaviour)).toEqual(BEHAVIOUR);
    });

    test('a shared Behaviour item removed for this person only drops out of Behaviour', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], hidden: ['c_p1'] });
        expect(ids(g.behaviour)).toEqual(['c_b1', 'c_b2', 'c_b3', 'c_b4']);
        expect(ids(g.work)).toEqual(SALES);
    });

    test('removing an item for one person does not remove it for anyone else', () => {
        groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], hidden: ['c_s1', 'c_b1'] });
        const other = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        expect(ids(other.work)).toEqual(SALES);
        expect(ids(other.behaviour)).toEqual(BEHAVIOUR);
    });

    test('an extra filed under a job goes into Work results; one under Behaviour goes into Behaviour', () => {
        const extras = [
            { id: 'x_tally', name: 'Tally entries', hint: '', section: 'r_sales' },
            { id: 'x_calm', name: 'Stays calm', hint: '', section: 'behaviour' },
        ];
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], extras });
        expect(ids(g.work)).toEqual([...SALES, 'x_tally']);
        expect(ids(g.behaviour)).toEqual([...BEHAVIOUR, 'x_calm']);
    });

    test('an extra under a job the person does not have (job since taken away) still counts in Work results', () => {
        const extras = [{ id: 'x_gem', name: 'GeM portal bids', hint: '', section: 'r_admin' }];
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], extras });
        expect(ids(g.work)).toEqual([...SALES, 'x_gem']);
        expect(ids(g.behaviour)).toEqual(BEHAVIOUR);
        expect(unscoredCount(g, scoreAll([...SALES, ...BEHAVIOUR], 7))).toBe(1);
    });

    test('a Behaviour extra for one person never leaks into the shared Behaviour list', () => {
        groupsFor(DEFAULT_SETUP, { roles: [], extras: [{ id: 'x_one', name: 'One', hint: '', section: 'behaviour' }] });
        expect(ids(DEFAULT_SETUP.behaviour)).toEqual(BEHAVIOUR);
        expect(ids(groupsFor(DEFAULT_SETUP, { roles: [] }).behaviour)).toEqual(BEHAVIOUR);
    });

    describe('one item shared by two jobs', () => {
        // Setup's sanitizer lets two jobs list the same item id, so a saved setup can hold one.
        const shared = setupFrom({
            weights: { work: 70, behaviour: 30 },
            roles: [
                { id: 'r_a', name: 'Job A', criteria: [{ id: 'c_x', name: 'On time' }, { id: 'c_a1', name: 'A only' }] },
                { id: 'r_b', name: 'Job B', criteria: [{ id: 'c_x', name: 'On time' }, { id: 'c_b9', name: 'B only' }] },
            ],
            behaviour: [{ id: 'c_beh', name: 'Teamwork' }],
        });

        test('the sanitizer keeps the shared item in both jobs (so groupsFor must de-duplicate)', () => {
            expect(ids(shared.roles[0].criteria)).toContain('c_x');
            expect(ids(shared.roles[1].criteria)).toContain('c_x');
        });

        test('someone doing both jobs is scored on it once', () => {
            const g = groupsFor(shared, { roles: ['r_a', 'r_b'] });
            expect(ids(g.work)).toEqual(['c_x', 'c_a1', 'c_b9']);
            expect(itemCount(g)).toBe(4);
            expect(unscoredCount(g, {})).toBe(4);
        });

        test('counting it once changes the Work average: c_x=1, the others 9 → 19/3, not 20/4', () => {
            const g = groupsFor(shared, { roles: ['r_a', 'r_b'] });
            // Behaviour left unscored so the total is just the Work average.
            expect(weightedTotal(shared, g, { c_x: 1, c_a1: 9, c_b9: 9 })).toBeCloseTo(19 / 3, 10);
        });

        test('removing the shared item for this person removes it from both jobs', () => {
            const g = groupsFor(shared, { roles: ['r_a', 'r_b'], hidden: ['c_x'] });
            expect(ids(g.work)).toEqual(['c_a1', 'c_b9']);
        });
    });
});

// ── The weighted total ──────────────────────────────────────────────────────

describe('weightedTotal — Work results 70%, Behaviour 30%', () => {
    const salesAdmin = () => groupsFor(DEFAULT_SETUP, { roles: ['r_sales', 'r_admin'] });

    test('Work all 9, Behaviour all 5 → 7.8 (equal weighting would give 7.0)', () => {
        const scores = scoreAll([...SALES, ...ADMIN], 9, scoreAll(BEHAVIOUR, 5));
        expect(weightedTotal(DEFAULT_SETUP, salesAdmin(), scores)).toBeCloseTo(7.8, 10);
    });

    test('Work all 4, Behaviour all 10 → 5.8 (swapped weights would give 8.2)', () => {
        const scores = scoreAll([...SALES, ...ADMIN], 4, scoreAll(BEHAVIOUR, 10));
        expect(weightedTotal(DEFAULT_SETUP, salesAdmin(), scores)).toBeCloseTo(5.8, 10);
    });

    test('the jobs\' items are pooled into one Work average: Sales 9s + Admin 6s → Work 8, total 7.4', () => {
        // Pooled: (6×9 + 3×6) / 9 = 8. Averaging per job would give (9+6)/2 = 7.5 → total 6.75.
        const scores = scoreAll(SALES, 9, scoreAll(ADMIN, 6, scoreAll(BEHAVIOUR, 6)));
        expect(weightedTotal(DEFAULT_SETUP, salesAdmin(), scores)).toBeCloseTo(0.7 * 8 + 0.3 * 6, 10);
    });

    test('a removed item\'s old score does not count: c_s1=1 hidden, rest 9/5 → 7.8 (not 6.87)', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], hidden: ['c_s1'] });
        const scores = scoreAll(SALES, 9, scoreAll(BEHAVIOUR, 5));
        scores.c_s1 = 1;   // scored before it was removed for them
        expect(weightedTotal(DEFAULT_SETUP, g, scores)).toBeCloseTo(7.8, 10);
    });

    test('a score for another job\'s item does not count for a Sales-only person', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        const scores = scoreAll(SALES, 8, scoreAll(BEHAVIOUR, 8));
        scores.c_d5 = 1;
        expect(weightedTotal(DEFAULT_SETUP, g, scores)).toBeCloseTo(8, 10);
    });

    test('a person\'s own extra counts in its part: Behaviour extra scored 1 pulls Behaviour to 5', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'], extras: [{ id: 'x_calm', name: 'Calm', hint: '', section: 'behaviour' }] });
        const scores = scoreAll(SALES, 9, scoreAll(BEHAVIOUR, 6));
        scores.x_calm = 1;  // Behaviour = (5×6 + 1) / 6 = 31/6
        expect(weightedTotal(DEFAULT_SETUP, g, scores)).toBeCloseTo(0.7 * 9 + 0.3 * (31 / 6), 10);
    });

    test('a part with nothing scored is left out, not counted as 0: only Behaviour scored 4 → 4', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        expect(weightedTotal(DEFAULT_SETUP, g, scoreAll(BEHAVIOUR, 4))).toBeCloseTo(4, 10);
    });

    test('nothing scored at all → null, never a guessed number', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        expect(weightedTotal(DEFAULT_SETUP, g, {})).toBeNull();
        expect(weightedTotal(DEFAULT_SETUP, g, undefined)).toBeNull();
    });

    test('out-of-range scores are ignored: a 0 or 11 does not move the average', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        const scores = scoreAll(SALES, 8, scoreAll(BEHAVIOUR, 8));
        scores.c_s1 = 0;
        scores.c_b1 = 11;
        expect(weightedTotal(DEFAULT_SETUP, g, scores)).toBeCloseTo(8, 10);
    });

    test('a 10 counts (the top of the scale is a real score)', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_admin'] });
        const scores = scoreAll(ADMIN, 10, scoreAll(BEHAVIOUR, 10));
        expect(weightedTotal(DEFAULT_SETUP, g, scores)).toBeCloseTo(10, 10);
    });

    test('uses the saved weights, not a fixed 70/30: 40/60 with Work 9, Behaviour 5 → 6.6', () => {
        const setup = Object.assign({}, DEFAULT_SETUP, { weights: { work: 40, behaviour: 60 } });
        const g = groupsFor(setup, { roles: ['r_sales'] });
        expect(weightedTotal(setup, g, scoreAll(SALES, 9, scoreAll(BEHAVIOUR, 5)))).toBeCloseTo(6.6, 10);
    });
});

describe('unscoredCount — what is still to score before a form or review is done', () => {
    test('nothing scored: every item of theirs is outstanding', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales', 'r_admin'] });
        expect(unscoredCount(g, {})).toBe(14);
        expect(unscoredCount(g, undefined)).toBe(14);
    });

    test('counts only their own items still unscored', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_sales'] });
        const scores = scoreAll(SALES.slice(0, 4), 7, scoreAll(BEHAVIOUR.slice(0, 3), 7));
        scores.c_d5 = 7;   // not their item — must not reduce the count
        expect(unscoredCount(g, scores)).toBe(2 + 2);
    });

    test('a 0 is not a score', () => {
        const g = groupsFor(DEFAULT_SETUP, { roles: ['r_admin'] });
        const scores = scoreAll([...ADMIN, ...BEHAVIOUR], 6);
        scores.c_d6 = 0;
        expect(unscoredCount(g, scores)).toBe(1);
    });

    test('a removed item is not outstanding; an own extra is until it is scored', () => {
        const g = groupsFor(DEFAULT_SETUP, {
            roles: ['r_admin'], hidden: ['c_d7'],
            extras: [{ id: 'x_bank', name: 'Bank matching', hint: '', section: 'r_admin' }],
        });
        const scores = scoreAll(['c_d5', 'c_d6', ...BEHAVIOUR], 6);
        expect(unscoredCount(g, scores)).toBe(1);
        scores.x_bank = 6;
        expect(unscoredCount(g, scores)).toBe(0);
    });
});

// ── Scores from the browser ─────────────────────────────────────────────────

describe('scores from a form — whole numbers 1 to 10 for real items only', () => {
    test('keeps 1 and 10; drops 0, 11, 2.5 and junk', () => {
        const r = sanitizeSelfReview({ scores: { c_s1: 1, c_s2: 10, c_s3: 0, c_s4: 11, c_s5: 2.5, c_s6: 'abc', c_b1: null } }, DEFAULT_SETUP);
        expect(r.scores).toEqual({ c_s1: 1, c_s2: 10 });
    });

    test('drops scores for item ids that are not in Setup', () => {
        const r = sanitizeSelfReview({ scores: { c_b1: 7, c_accounts1: 7, __proto__x: 7 } }, DEFAULT_SETUP);
        expect(r.scores).toEqual({ c_b1: 7 });
    });

    test('a person\'s own extra item can be scored once its id is passed in', () => {
        const extras = [{ id: 'x_tally', name: 'Tally', hint: '', section: 'r_admin' }];
        expect(sanitizeSelfReview({ scores: { x_tally: 8 } }, DEFAULT_SETUP, extras).scores).toEqual({ x_tally: 8 });
        expect(sanitizeSelfReview({ scores: { x_tally: 8 } }, DEFAULT_SETUP).scores).toEqual({});
    });

    test('the manager review applies the same score rules, and extras', () => {
        const extras = [{ id: 'x_tally', name: 'Tally', hint: '', section: 'r_admin' }];
        const r = sanitizeManagerReview({ scores: { c_d5: 10, c_d6: 0, c_d7: 11, x_tally: 3, x_other: 3 }, done: true }, DEFAULT_SETUP, extras);
        expect(r.scores).toEqual({ c_d5: 10, x_tally: 3 });
        expect(r.done).toBe(true);
    });

    test('a review is done only on a real true, not the text "true"', () => {
        expect(sanitizeManagerReview({ done: 'true' }, DEFAULT_SETUP).done).toBe(false);
    });

    test('a manager-typed self form is kept only when it has a score', () => {
        expect(sanitizeManagerReview({ selfByMgr: { wins: 'x', scores: { c_b1: 0 } } }, DEFAULT_SETUP).selfByMgr).toBeUndefined();
        expect(sanitizeManagerReview({ selfByMgr: { scores: { c_b1: 6 } } }, DEFAULT_SETUP).selfByMgr.scores).toEqual({ c_b1: 6 });
    });
});

// ── Setup ───────────────────────────────────────────────────────────────────

describe('sanitizeSetup — what an admin may save', () => {
    const base = () => ({ weights: { work: 70, behaviour: 30 }, roles: DEFAULT_SETUP.roles, behaviour: DEFAULT_SETUP.behaviour, raises: DEFAULT_SETUP.raises, scale: DEFAULT_SETUP.scale });

    test('70/30 is accepted', () => {
        const r = sanitizeSetup(base());
        expect(r.error).toBeUndefined();
        expect(r.setup.weights).toEqual({ work: 70, behaviour: 30 });
    });

    test('weights that do not total 100 are refused, saying the total', () => {
        const r = sanitizeSetup(Object.assign(base(), { weights: { work: 60, behaviour: 30 } }));
        expect(r.setup).toBeUndefined();
        expect(r.error).toMatch(/90%/);
    });

    test('a third "discipline" part cannot make up the 100 — only the two parts count', () => {
        const r = sanitizeSetup(Object.assign(base(), { weights: { work: 60, behaviour: 20, discipline: 20 } }));
        expect(r.setup).toBeUndefined();
        expect(r.error).toMatch(/80%/);
    });

    test('a discipline weight sent alongside a valid 70/30 is thrown away', () => {
        const r = sanitizeSetup(Object.assign(base(), { weights: { work: 70, behaviour: 30, discipline: 20 } }));
        expect(r.setup.weights).toEqual({ work: 70, behaviour: 30 });
    });

    test('negative weights count as 0 (so -10/110 is not a way to reach 100)', () => {
        const r = sanitizeSetup(Object.assign(base(), { weights: { work: 110, behaviour: -10 } }));
        expect(r.error).toMatch(/110%/);
    });

    test('startedAt and a discipline list are never taken from what the browser sends', () => {
        const r = sanitizeSetup(Object.assign(base(), { startedAt: '2020-01-01T00:00:00.000Z', discipline: [{ id: 'c_p2', name: 'Rules' }] }));
        expect(Object.keys(r.setup).sort()).toEqual(['behaviour', 'raises', 'roles', 'scale', 'weights']);
        expect(JSON.stringify(r.setup)).not.toMatch(/startedAt|discipline|2020-01-01/);
    });

    test('the scale always has 10 points, whatever is sent', () => {
        const r = sanitizeSetup(Object.assign(base(), { scale: [{ n: 1, label: 'Bad' }, { n: 12, label: 'Off the scale' }] }));
        expect(r.setup.scale.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(r.setup.scale[0].label).toBe('Bad');
    });

    test('jobs need a safe id and a name; a repeated job id is dropped', () => {
        const r = sanitizeSetup(Object.assign(base(), {
            roles: [
                { id: 'r_sales', name: 'Sales', criteria: [{ id: 'c_s1', name: 'Orders' }] },
                { id: 'r_sales', name: 'Sales again', criteria: [] },
                { id: 'bad id', name: 'Spaces', criteria: [] },
                { id: 'r_blank', name: '   ', criteria: [] },
            ],
        }));
        expect(r.setup.roles.map((x) => x.name)).toEqual(['Sales']);
    });

    test('raise rows outside 0–10 or above 100% are dropped, and the rest kept highest first', () => {
        const r = sanitizeSetup(Object.assign(base(), { raises: [{ min: 6, pct: 5 }, { min: 11, pct: 20 }, { min: 9, pct: 12 }, { min: 8, pct: 150 }] }));
        expect(r.setup.raises.map((x) => [x.min, x.pct])).toEqual([[9, 12], [6, 5]]);
    });
});

// ── One person's profile ────────────────────────────────────────────────────

describe('sanitizeProfile — jobs, targets, own items and removed shared items', () => {
    test('jobs are kept only if Setup has them, once each', () => {
        const r = sanitizeProfile({ roles: ['r_sales', 'r_accounts', 'r_sales'], targets: '  20 orders  ' }, DEFAULT_SETUP);
        expect(r.profile.roles).toEqual(['r_sales']);
        expect(r.profile.targets).toBe('20 orders');
    });

    test('extras and hidden that are not sent stay out, so the old ones are kept', () => {
        const r = sanitizeProfile({ roles: ['r_sales'], targets: 'x' }, DEFAULT_SETUP);
        expect(r.error).toBeUndefined();
        expect('extras' in r.profile).toBe(false);
        expect('hidden' in r.profile).toBe(false);
    });

    test('an empty list sent on purpose clears them', () => {
        const r = sanitizeProfile({ roles: [], extras: [], hidden: [] }, DEFAULT_SETUP);
        expect(r.profile.extras).toEqual([]);
        expect(r.profile.hidden).toEqual([]);
    });

    test('own items under a job or under Behaviour are kept, with their heading', () => {
        const r = sanitizeProfile({ roles: ['r_sales'], extras: [
            { id: 'x_tally', name: ' Tally entries ', hint: 'All in', section: 'r_admin' },
            { id: 'x_calm', name: 'Stays calm', section: 'behaviour' },
        ] }, DEFAULT_SETUP);
        expect(r.error).toBeUndefined();
        expect(r.profile.extras).toEqual([
            { id: 'x_tally', name: 'Tally entries', hint: 'All in', section: 'r_admin' },
            { id: 'x_calm', name: 'Stays calm', hint: '', section: 'behaviour' },
        ]);
    });

    test('an own item under a heading that is no longer a job is an ERROR, never silently dropped', () => {
        const r = sanitizeProfile({ roles: ['r_sales'], extras: [
            { id: 'x_ok', name: 'Fine', section: 'r_sales' },
            { id: 'x_old', name: 'GST filings', section: 'r_accounts' },   // Accounts was removed from Setup
        ] }, DEFAULT_SETUP);
        expect(r.profile).toBeUndefined();
        expect(typeof r.error).toBe('string');
        expect(r.error).toMatch(/Reload/);
    });

    test('an own item with no name is refused too, rather than lost', () => {
        const r = sanitizeProfile({ roles: [], extras: [{ id: 'x_blank', name: '  ', section: 'behaviour' }] }, DEFAULT_SETUP);
        expect(r.profile).toBeUndefined();
        expect(r.error).toEqual(expect.any(String));
    });

    test('removed shared items are kept only if they are real Setup items, once each', () => {
        const r = sanitizeProfile({ roles: ['r_sales'], hidden: ['c_s1', 'c_nope', 'x_mine', 'c_p1', 'c_s1', 'c_d5'] }, DEFAULT_SETUP);
        expect(r.profile.hidden).toEqual(['c_s1', 'c_p1', 'c_d5']);
    });
});

// ── The staff list ──────────────────────────────────────────────────────────

describe('sanitizeNewStaff — a name, and an email only if they sign in', () => {
    test('a name is required', () => {
        expect(sanitizeNewStaff({ name: '   ', email: 'a@b.com' }).error).toMatch(/name/i);
        expect(sanitizeNewStaff({}).error).toMatch(/name/i);
        expect(sanitizeNewStaff(null).error).toMatch(/name/i);
    });

    test('no email is fine', () => {
        expect(sanitizeNewStaff({ name: ' Kavitha ' })).toEqual({ staff: { name: 'Kavitha', email: '' } });
    });

    test('the email is trimmed and lower-cased, so any spelling is the same person', () => {
        expect(sanitizeNewStaff({ name: 'Ravi', email: '  Ravi.K@DSCPipes.COM ' })).toEqual({ staff: { name: 'Ravi', email: 'ravi.k@dscpipes.com' } });
    });

    test.each(['ravi', 'ravi@', 'ravi@dscpipes', 'ravi k@dscpipes.com', '@dscpipes.com'])('a broken email (%s) is refused', (email) => {
        const r = sanitizeNewStaff({ name: 'Ravi', email });
        expect(r.staff).toBeUndefined();
        expect(r.error).toMatch(/email/i);
    });

    test('the name is capped at 120 characters', () => {
        expect(sanitizeNewStaff({ name: 'a'.repeat(300) }).staff.name).toHaveLength(120);
    });

    test('newStaffId gives a fresh, file-safe id each time', () => {
        const a = newStaffId();
        const b = newStaffId();
        expect(a).toMatch(/^s-[0-9a-f]{12}$/);
        expect(b).toMatch(/^s-[0-9a-f]{12}$/);
        expect(a).not.toBe(b);
    });
});

// ── Raises ──────────────────────────────────────────────────────────────────

describe('raiseFor — the raise row a rating reaches', () => {
    const pct = (rating) => { const r = raiseFor(DEFAULT_SETUP, rating); return r && r.pct; };

    test.each([
        [10, 12], [9, 12], [8.99, 10], [8, 10], [7.99, 7], [7, 7],
        [6.99, 5], [6, 5], [5.99, 2], [5, 2], [4.99, 0], [1, 0],
    ])('rating %p → %p%%', (rating, expected) => {
        expect(pct(rating)).toBe(expected);
    });

    test('no rating → no raise row (not 0%)', () => {
        expect(raiseFor(DEFAULT_SETUP, null)).toBeNull();
        expect(raiseFor(DEFAULT_SETUP, undefined)).toBeNull();
    });

    test('works whatever order the rows were saved in', () => {
        const setup = { raises: [{ min: 0, pct: 0 }, { min: 7, pct: 7 }, { min: 9, pct: 12 }] };
        expect(raiseFor(setup, 9.5).pct).toBe(12);
        expect(raiseFor(setup, 8).pct).toBe(7);
        expect(raiseFor(setup, 3).pct).toBe(0);
    });

    test('a rating below every row reaches none', () => {
        expect(raiseFor({ raises: [{ min: 5, pct: 2 }] }, 4)).toBeNull();
    });
});

// ── Periods (Indian financial year) ────────────────────────────────────────

describe('quarter and half keys', () => {
    test('keys name the financial year as two consecutive years', () => {
        expect(quarterKey(2026, 2)).toBe('2026-27-Q2');
        expect(halfKey(2099, 2)).toBe('2099-00-H2');
        expect(isQuarterKey('2026-27-Q2')).toBe(true);
        expect(isQuarterKey('2026-28-Q2')).toBe(false);
        expect(isQuarterKey('2026-27-Q5')).toBe(false);
        expect(isHalfKey('2026-27-H1')).toBe(true);
        expect(isHalfKey('2026-27-H3')).toBe(false);
    });

    test('each half is its two quarters', () => {
        expect(quartersOfHalf('2026-27-H1')).toEqual(['2026-27-Q1', '2026-27-Q2']);
        expect(quartersOfHalf('2026-27-H2')).toEqual(['2026-27-Q3', '2026-27-Q4']);
    });
});
