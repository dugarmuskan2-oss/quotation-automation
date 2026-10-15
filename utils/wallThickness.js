'use strict';

// A seamless line's schedule, worked out from the wall thickness the customer wrote.
//
// Customers' indents often give OD × wall in mm instead of a schedule (Enexio: "457.2 × 6.35").
// The AI turned those into schedules by itself and got it wrong in a different way on each run —
// 18" × 6.35 mm came out "STD 9.53 mm", 40 NB × 5.08 mm came out Sch 40 (it is Sch 80). So the AI
// now only copies the thickness down (wallThicknessMm), and the schedule is read off the live
// SEAMLESS price list, which carries every row's Thickness (mm). A thickness no row has (18" ×
// 6.35 mm is Sch 10, which the list does not stock) keeps the thickness in the description, finds
// no price, and stays blank and red — never a guessed schedule.
//
// Pure module: no I/O.

const { normSize, findCol, parseDescription } = require('./pipeWeights');

const TOLERANCE_MM = 0.06;   // lists print 5.54 where an indent says 5.5; 0.06 never reaches the next schedule

/** { size → [{ mm, sch }] } from the seamless list's rows (row 0 = header). */
function buildScheduleByWall(rows) {
    const out = {};
    if (!Array.isArray(rows) || rows.length < 2) return out;
    const h = rows[0];
    const iInch = findCol(h, [/^inch$/, /inch/]);
    const iSch = findCol(h, [/^sch$/, /schedule/]);
    const iThk = findCol(h, [/wall.*thick|^thickness/]);
    if (iInch < 0 || iSch < 0 || iThk < 0) return out;
    rows.slice(1).forEach((r) => {
        const size = normSize(r[iInch]);
        const mm = parseFloat(String(r[iThk] == null ? '' : r[iThk]));
        const sch = String(r[iSch] == null ? '' : r[iSch]).split('/')[0].trim();   // "140 / XXS" -> "140"
        if (!size || !(mm > 0) || !sch) return;
        (out[size] = out[size] || []).push({ mm, sch });
    });
    return out;
}

/** The schedule whose wall matches `mm` for that size, or null. Closest wins inside the tolerance. */
function scheduleForWall(byWall, size, mm) {
    const options = (byWall && byWall[normSize(size)]) || [];
    let best = null;
    options.forEach((o) => {
        const d = Math.abs(o.mm - mm);
        if (d <= TOLERANCE_MM && (!best || d < best.d)) best = { d, sch: o.sch };
    });
    return best ? best.sch : null;
}

// The AI often writes the wall straight into the description ("18X6.35", "2" NB X 5.5mm") instead
// of the wallThicknessMm field. A decimal, or a number marked mm, is a wall; a bare whole number
// is left alone — "8X10" may be Sch 10.
function wallFromDescription(description) {
    const t = String(description == null ? '' : description).toUpperCase().replace(/\s+/g, '');
    const m = /X(\d+\.\d+|\d+(?:\.\d+)?(?=MM))(?:MM)?(?:THK)?$/.exec(t);
    return m ? parseFloat(m[1]) : null;
}

function isSeamless(li) {
    return /seamless/i.test(String((li && li.identifiedPipeType) || ''));
}

/**
 * Rewrite each seamless line whose enquiry gave a wall to the schedule that wall is. `walls[i]` is
 * the wallThicknessMm the AI returned for line i (calculateLineItem drops the field, so the caller
 * keeps them). Returns how many were set from the list and how many had no matching schedule.
 */
function applyEnquiryWalls(lineItems, walls, byWall) {
    const out = { matched: 0, unmatched: 0 };
    (lineItems || []).forEach((li, i) => {
        if (!li || !isSeamless(li)) return;
        const given = parseFloat(String(walls && walls[i] != null ? walls[i] : ''));
        const mm = given > 0 ? given : wallFromDescription(li.originalDescription);
        if (!(mm > 0)) return;
        const { size } = parseDescription(li.originalDescription);
        if (!size) return;
        li.enquiryWallMm = mm;
        const sch = scheduleForWall(byWall, size, mm);
        if (sch) { li.originalDescription = size + 'X' + sch; out.matched++; }
        else { li.originalDescription = size + 'X' + mm + 'MM'; out.unmatched++; }
    });
    return out;
}

module.exports = { buildScheduleByWall, scheduleForWall, applyEnquiryWalls, wallFromDescription, TOLERANCE_MM };
