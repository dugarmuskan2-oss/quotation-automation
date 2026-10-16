'use strict';

/**
 * utils/appraisalReminder.js — the daily "appraisal reviews still due" email. Pure: no I/O.
 *
 * The quarter that is due is the one that ended most recently (India time). From the day after it
 * ends, the office gets one email each morning listing who still has something missing for it:
 *   - their form   — not submitted by them, and not typed in by a manager from a paper form,
 *   - the review   — not yet marked done by a manager.
 * The emails stop when nothing is missing, and move on to the next quarter when it ends.
 *
 * The first quarter that can be due is the one that had just ended when the appraisal was set up
 * (Setup first saved) — that is the quarter the page opens on and asks everyone to fill. Earlier
 * quarters are never due. Nor is a quarter that ended before a person was added to the staff list.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// The owner, 16 Oct 2026: no reminders for the first batch (Q2 · Jul–Sep 2026). The first quarter
// that can ever be reminded is Q3 · Oct–Dec 2026, so the first email can come on 1 Jan 2027.
const FIRST_REMINDED_QUARTER = { fy: 2026, q: 3 };
const MONTHS = [['Apr', 'Jun'], ['Jul', 'Sep'], ['Oct', 'Dec'], ['Jan', 'Mar']];

function yy(n) { return String(n % 100).padStart(2, '0'); }

/** Calendar parts of a moment, as a clock in India shows them. */
function istParts(ms) {
    const d = new Date(ms + IST_OFFSET_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Today's date in India, 'YYYY-MM-DD' — one email per such day. */
function istDay(ms) {
    const p = istParts(ms);
    return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
}

/** The financial-year quarter a moment falls in (April–March), India time. */
function quarterOf(ms) {
    const { y, m } = istParts(ms);
    return m >= 4 ? { fy: y, q: Math.floor((m - 4) / 3) + 1 } : { fy: y - 1, q: 4 };
}

/** The quarter that ended most recently, with its key (same as utils/appraisal.js quarterKey) and label. */
function dueQuarter(ms) {
    const c = quarterOf(ms);
    const fy = c.q === 1 ? c.fy - 1 : c.fy;
    const q = c.q === 1 ? 4 : c.q - 1;
    const endYear = q === 4 ? fy + 1 : fy;
    const label = 'Q' + q + ' · ' + MONTHS[q - 1][0] + '–' + MONTHS[q - 1][1] + ' ' + endYear;
    return { key: fy + '-' + yy(fy + 1) + '-Q' + q, label, endsMs: quarterEndMs(fy, q) };
}

/** The last instant of the quarter with this key ('2026-27-Q2'). */
function quarterEndOf(key) {
    const m = /^(\d{4})-\d{2}-Q([1-4])$/.exec(String(key || ''));
    return m ? quarterEndMs(Number(m[1]), Number(m[2])) : Infinity;
}

/** The last instant of a quarter, India time, as a timestamp. */
function quarterEndMs(fy, q) {
    const nextStartMonth = [7, 10, 1, 4][q - 1];          // the month after the quarter
    const year = q === 3 ? fy + 1 : (q === 4 ? fy + 1 : fy);
    return Date.UTC(year, nextStartMonth - 1, 1) - IST_OFFSET_MS - 1;
}

/**
 * Who still has something missing for quarter `q`.
 * `people` is [{ name, addedAt, self, mgr }] with each person's saved self-review and manager files.
 */
function missingFor(people, q) {
    const out = [];
    for (const p of people || []) {
        const own = p.self && p.self.reviews && p.self.reviews[q];
        const mr = p.mgr && p.mgr.reviews && p.mgr.reviews[q];
        const typedIn = !!(mr && mr.selfByMgr && Object.keys(mr.selfByMgr.scores || {}).length);
        if (p.addedAt && Date.parse(p.addedAt) > quarterEndOf(q)) continue;   // joined after it ended
        const formMissing = !(own && own.submittedAt) && !typedIn;
        const reviewMissing = !(mr && mr.done);
        if (formMissing || reviewMissing) out.push({ name: p.name, formMissing, reviewMissing });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** When the appraisal was set up: the first Setup save (older setups only carry their last save). */
function setUpAtMs(setup) {
    const t = Date.parse((setup && (setup.startedAt || setup.savedAt)) || '');
    return Number.isFinite(t) ? t : null;
}

/** Is a reminder due for quarter `due`? Only once Setup is saved, only from the quarter that had
 *  just ended when it was (the round the page asked for first) onwards, and never before
 *  FIRST_REMINDED_QUARTER. */
function quarterIsDue(setup, isStarter, due) {
    const since = setUpAtMs(setup);
    if (isStarter || since == null) return false;
    if (due.endsMs < quarterEndMs(FIRST_REMINDED_QUARTER.fy, FIRST_REMINDED_QUARTER.q)) return false;
    return due.endsMs >= dueQuarter(since).endsMs;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** The email: one line per person with what is still missing, and a link to the appraisal. */
function reminderEmail(due, missing, link) {
    const forms = missing.filter((m) => m.formMissing).length;
    const reviews = missing.filter((m) => m.reviewMissing).length;
    const subject = `Appraisal reminder: ${missing.length} ${missing.length === 1 ? 'person' : 'people'} still due for ${due.label}`;
    const cell = (todo) => `<td style="padding:6px 12px;border-bottom:1px solid #eee;color:${todo ? '#A32D2D' : '#2E7D32'}">${todo ? 'Not yet' : 'Done'}</td>`;
    const rows = missing.map((m) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee"><strong>${esc(m.name)}</strong></td>${cell(m.formMissing)}${cell(m.reviewMissing)}</tr>`).join('');
    const bodyHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#2b2b2b">
<p>The staff appraisal for <strong>${esc(due.label)}</strong> is still open.</p>
<p>${forms} form${forms === 1 ? '' : 's'} not filled · ${reviews} manager review${reviews === 1 ? '' : 's'} not marked done.</p>
<table style="border-collapse:collapse;font-size:14px"><thead><tr>
<th style="text-align:left;padding:6px 12px;border-bottom:2px solid #ccc">Name</th>
<th style="text-align:left;padding:6px 12px;border-bottom:2px solid #ccc">Their form</th>
<th style="text-align:left;padding:6px 12px;border-bottom:2px solid #ccc">Manager's review</th>
</tr></thead><tbody>${rows}</tbody></table>
<p><a href="${esc(link)}">Open the appraisal</a></p>
<p style="color:#888;font-size:12px">This email comes every morning until everything for ${esc(due.label)} is filled and marked done.</p>
</div>`;
    return { subject, bodyHtml };
}

module.exports = { istDay, dueQuarter, quarterEndMs, missingFor, quarterIsDue, reminderEmail };
