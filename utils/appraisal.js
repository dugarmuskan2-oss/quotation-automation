'use strict';

/**
 * utils/appraisal.js — the staff appraisal's rules, with no I/O.
 *
 * Periods follow the Indian financial year (April to March): four quarters, two halves.
 * Staff fill a self-review each quarter; an admin scores them on the same items; every six
 * months the two quarterly admin scores are averaged into the rating that picks the raise.
 *
 * Everything that arrives from a browser goes through a sanitize* function here before it is
 * stored, so a stale or hand-made request can only ever write the fields it is allowed to.
 */

const crypto = require('crypto');

const GROUPS = ['work', 'behaviour', 'discipline'];
const TEXT_MAX = 2000;
const NAME_MAX = 120;

// ── Periods ─────────────────────────────────────────────────────────────────

const QUARTER_RX = /^(\d{4})-(\d{2})-Q([1-4])$/;
const HALF_RX = /^(\d{4})-(\d{2})-H([12])$/;

function yy(n) { return String(n % 100).padStart(2, '0'); }

function quarterKey(fy, q) { return `${fy}-${yy(fy + 1)}-Q${q}`; }
function halfKey(fy, h) { return `${fy}-${yy(fy + 1)}-H${h}`; }

/** A quarter key is valid only when its two years really are consecutive. */
function isQuarterKey(k) {
    const m = QUARTER_RX.exec(String(k || ''));
    return !!m && m[2] === yy(Number(m[1]) + 1);
}
function isHalfKey(k) {
    const m = HALF_RX.exec(String(k || ''));
    return !!m && m[2] === yy(Number(m[1]) + 1);
}

/** The two quarter keys that make up a half-year key. */
function quartersOfHalf(k) {
    const m = HALF_RX.exec(k);
    const fy = Number(m[1]);
    return m[3] === '1' ? [quarterKey(fy, 1), quarterKey(fy, 2)] : [quarterKey(fy, 3), quarterKey(fy, 4)];
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** The items one person is scored on: their roles' items (no duplicates), then the shared two. */
function groupsFor(setup, roleIds) {
    const work = [];
    const seen = new Set();
    const mine = new Set(Array.isArray(roleIds) ? roleIds : []);
    for (const r of (setup && setup.roles) || []) {
        if (!mine.has(r.id)) continue;
        for (const c of r.criteria || []) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            work.push(c);
        }
    }
    return { work, behaviour: (setup && setup.behaviour) || [], discipline: (setup && setup.discipline) || [] };
}

function averageOf(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/**
 * Weighted total on the 1–5 scale. Each group is the average of its scored items; a group with
 * nothing scored is left out and the remaining weights are re-balanced, rather than counted as 0.
 * Returns null when nothing at all is scored — never a guessed number.
 */
function weightedTotal(setup, groups, scores) {
    let weightUsed = 0;
    let sum = 0;
    for (const g of GROUPS) {
        const vals = (groups[g] || []).map((c) => scores && scores[c.id]).filter((v) => v >= 1 && v <= 5);
        const avg = averageOf(vals);
        if (avg == null) continue;
        const w = Number((setup.weights || {})[g] || 0);
        weightUsed += w;
        sum += w * avg;
    }
    return weightUsed ? sum / weightUsed : null;
}

function itemCount(groups) { return GROUPS.reduce((n, g) => n + (groups[g] || []).length, 0); }

function unscoredCount(groups, scores) {
    return GROUPS.reduce((n, g) => n + (groups[g] || []).filter((c) => !(scores && scores[c.id] >= 1)).length, 0);
}

/** The raise row a rating reaches: the highest "from" that the rating is at or above. */
function raiseFor(setup, rating) {
    if (rating == null) return null;
    const rows = [...((setup && setup.raises) || [])].sort((a, b) => b.min - a.min);
    return rows.find((r) => rating >= r.min) || null;
}

// ── Sanitizers ──────────────────────────────────────────────────────────────

function cleanText(v, max) { return String(v == null ? '' : v).slice(0, max || TEXT_MAX); }

function cleanId(v) {
    const s = String(v == null ? '' : v);
    return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : null;
}

function cleanItems(list) {
    const out = [];
    const seen = new Set();
    for (const c of Array.isArray(list) ? list : []) {
        const id = cleanId(c && c.id);
        const name = cleanText(c && c.name, NAME_MAX).trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name, hint: cleanText(c.hint, 300) });
    }
    return out;
}

function cleanScale(list) {
    const byN = new Map((Array.isArray(list) ? list : []).map((s) => [Number(s && s.n), s]));
    return [1, 2, 3, 4, 5].map((n) => ({
        n, label: cleanText((byN.get(n) || {}).label, 40), desc: cleanText((byN.get(n) || {}).desc, 300),
    }));
}

function cleanRaises(list) {
    return (Array.isArray(list) ? list : [])
        .map((r) => ({ min: Number(r && r.min), pct: Number(r && r.pct), note: cleanText(r && r.note, 120) }))
        .filter((r) => Number.isFinite(r.min) && Number.isFinite(r.pct) && r.min >= 0 && r.min <= 5 && r.pct >= 0 && r.pct <= 100)
        .sort((a, b) => b.min - a.min);
}

/** The setup, or an error message when the weights do not add up to 100. */
function sanitizeSetup(input) {
    const src = input && typeof input === 'object' ? input : {};
    const weights = {};
    for (const g of GROUPS) weights[g] = Math.max(0, Math.round(Number((src.weights || {})[g]) || 0));
    const total = GROUPS.reduce((n, g) => n + weights[g], 0);
    if (total !== 100) return { error: `The three parts add up to ${total}%. Make them 100%.` };
    const roles = [];
    for (const r of Array.isArray(src.roles) ? src.roles : []) {
        const id = cleanId(r && r.id);
        const name = cleanText(r && r.name, NAME_MAX).trim();
        if (id && name && !roles.some((x) => x.id === id)) roles.push({ id, name, criteria: cleanItems(r.criteria) });
    }
    return {
        setup: {
            scale: cleanScale(src.scale), weights, roles,
            behaviour: cleanItems(src.behaviour), discipline: cleanItems(src.discipline), raises: cleanRaises(src.raises),
        },
    };
}

/** Scores kept only for item ids that exist in the setup, and only whole numbers 1–5. */
function cleanScores(scores, validIds) {
    const out = {};
    for (const [k, v] of Object.entries(scores && typeof scores === 'object' ? scores : {})) {
        const n = Number(v);
        if (validIds.has(k) && Number.isInteger(n) && n >= 1 && n <= 5) out[k] = n;
    }
    return out;
}

function cleanNotes(notes, validIds) {
    const out = {};
    for (const [k, v] of Object.entries(notes && typeof notes === 'object' ? notes : {})) {
        const t = cleanText(v, 500).trim();
        if (validIds.has(k) && t) out[k] = t;
    }
    return out;
}

function allItemIds(setup) {
    const ids = new Set();
    for (const r of setup.roles || []) for (const c of r.criteria || []) ids.add(c.id);
    for (const c of setup.behaviour || []) ids.add(c.id);
    for (const c of setup.discipline || []) ids.add(c.id);
    return ids;
}

function sanitizeSelfReview(input, setup) {
    const ids = allItemIds(setup);
    const src = input && typeof input === 'object' ? input : {};
    return {
        scores: cleanScores(src.scores, ids), notes: cleanNotes(src.notes, ids),
        wins: cleanText(src.wins).trim(), help: cleanText(src.help).trim(),
    };
}

function sanitizeManagerReview(input, setup) {
    const ids = allItemIds(setup);
    const src = input && typeof input === 'object' ? input : {};
    const out = {
        scores: cleanScores(src.scores, ids), notes: cleanNotes(src.notes, ids),
        comment: cleanText(src.comment).trim(), done: src.done === true,
    };
    if (src.selfByMgr && typeof src.selfByMgr === 'object') {
        const s = sanitizeSelfReview(src.selfByMgr, setup);
        if (Object.keys(s.scores).length) out.selfByMgr = s;
    }
    return out;
}

function sanitizeMeeting(input) {
    const src = input && typeof input === 'object' ? input : {};
    const pct = src.raisePct === '' || src.raisePct == null ? null : Number(src.raisePct);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(src.date || '')) ? String(src.date) : '';
    return {
        wentWell: cleanText(src.wentWell).trim(), improve: cleanText(src.improve).trim(),
        newTargets: cleanText(src.newTargets).trim(),
        raisePct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null,
        date, done: src.done === true,
    };
}

function sanitizeProfile(input, setup) {
    const src = input && typeof input === 'object' ? input : {};
    const valid = new Set((setup.roles || []).map((r) => r.id));
    const roles = [...new Set(Array.isArray(src.roles) ? src.roles : [])].filter((id) => valid.has(id));
    return { roles, targets: cleanText(src.targets).trim() };
}

/** A storage-safe key part for one person, the same for any spelling of their email. */
function personSlug(email) {
    return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 20);
}

// ── Starter setup (used until an admin saves their own) ─────────────────────

function item(id, name, hint) { return { id, name, hint }; }

const DEFAULT_SETUP = {
    scale: [
        { n: 1, label: 'Poor', desc: 'Well below what was expected. Needs close support and a clear plan to improve.' },
        { n: 2, label: 'Needs work', desc: 'Below target in some areas. Needs regular help to get the job done.' },
        { n: 3, label: 'Meets target', desc: 'Did what was expected, on time, with normal help.' },
        { n: 4, label: 'Good', desc: 'Above target. Works with little help and fixes problems on their own.' },
        { n: 5, label: 'Excellent', desc: 'Far above target. Others can learn from how they work.' },
    ],
    weights: { work: 60, behaviour: 20, discipline: 20 },
    roles: [
        { id: 'r_sales', name: 'Sales', criteria: [
            item('c_s1', 'Orders closed vs target', 'Value and number of orders won this quarter, compared with the target.'),
            item('c_s2', 'New customers', 'New buyers added, including GeM, Ariba and other portal leads.'),
            item('c_s3', 'Payment collection', 'Payments collected on time. Few overdue invoices.'),
            item('c_s4', 'Quotes and follow-ups', 'Quotes sent quickly and every lead followed up.'),
            item('c_s5', 'Customer care', 'Customers get clear answers and stay happy with the service.'),
        ] },
        { id: 'r_accounts', name: 'Accounts', criteria: [
            item('c_a1', 'Accuracy', 'Invoices, entries and ledgers are correct the first time.'),
            item('c_a2', 'Dues follow-up', 'Chases pending payments and keeps the outstanding list up to date.'),
            item('c_a3', 'Filings on time', 'GST, TDS and other filings done before the due date.'),
            item('c_a4', 'Bank and ledger matching', 'Bank statements and ledgers matched every month.'),
            item('c_a5', 'Reports on time', 'Sales, stock and payment reports ready when needed.'),
        ] },
        { id: 'r_admin', name: 'Administration', criteria: [
            item('c_d1', 'Vendor registrations and documents', 'Vendor forms, portal registrations and company documents complete and current.'),
            item('c_d2', 'Dispatch coordination', 'Transport, delivery papers and dispatch details sorted without delays.'),
            item('c_d3', 'Records and filing', 'Files are easy to find. Nothing goes missing.'),
            item('c_d4', 'Office running', 'Supplies, repairs and day-to-day office needs handled.'),
            item('c_d5', 'Tasks done on time', 'Assigned tasks finished by the agreed date.'),
        ] },
    ],
    behaviour: [
        item('c_b1', 'Teamwork', 'Helps others and shares work when the team is busy.'),
        item('c_b2', 'Communication', 'Keeps people informed. Clear with customers and colleagues.'),
        item('c_b3', 'Ownership', 'Takes charge of problems without being told.'),
        item('c_b4', 'Learning', 'Picks up new tools, products and ways of working.'),
    ],
    discipline: [
        item('c_p1', 'Attendance and punctuality', 'Comes in on time. Leave planned in advance.'),
        item('c_p2', 'Follows company rules', 'Follows processes, approvals and pricing rules.'),
        item('c_p3', 'Meets deadlines', 'Delivers what was promised by the agreed date.'),
    ],
    raises: [
        { min: 4.5, pct: 12, note: 'Top performer' },
        { min: 4, pct: 10, note: '' },
        { min: 3.5, pct: 7, note: '' },
        { min: 3, pct: 5, note: 'Met expectations' },
        { min: 2.5, pct: 2, note: '' },
        { min: 0, pct: 0, note: 'No raise. Agree an improvement plan.' },
    ],
};

module.exports = {
    GROUPS, DEFAULT_SETUP,
    quarterKey, halfKey, isQuarterKey, isHalfKey, quartersOfHalf,
    groupsFor, weightedTotal, itemCount, unscoredCount, raiseFor,
    sanitizeSetup, sanitizeSelfReview, sanitizeManagerReview, sanitizeMeeting, sanitizeProfile,
    personSlug,
};
