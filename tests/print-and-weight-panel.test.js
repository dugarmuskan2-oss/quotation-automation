/**
 * @jest-environment node
 *
 * tests/print-and-weight-panel.test.js
 *
 * Two small features:
 *
 * (1) Print enquiry — printEnquirySheet (index.html) renders the enquiry as a
 *     formatted email + attachment chips into a pop-up print window. The function
 *     itself is window/document-bound (window.open + document.write + win.print),
 *     so it is covered by source-guards for the email-body and attachment-list
 *     markers. The PURE helpers it calls to build that output are extracted by
 *     brace-matching and eval'd, then exercised behaviourally:
 *       - buildAdminMessage       (the "Message from the admin" block)
 *       - isImageEnquiryAttachment (image-inline vs PDF-iframe + chip emoji)
 *       - enquiryFileViewUrl       (the attachment src URLs, with encoding)
 *       - escapeHtml               (used for the title / attachment names)
 *
 * (2) Freight weight panel — freight-tab-weight-editor.js: the "+" add button
 *     (class `fwe-addbtn`) and the "With tolerance (7%)" weight row, rendered as
 *     `fmt(secWt * 0.93)` where `secWt = secWeight(st, sec)`. secWeight/weightOf
 *     are on the module's `_test` export and are required + run for real. The
 *     format helper `fmt` is NOT on the `_test` export, so — rather than inline a
 *     copy — its real source text is extracted by brace-matching and eval'd, so
 *     the tolerance math (× 0.93 → round → en-IN grouping) is asserted against the
 *     real function. Add-button markup + tolerance-row label get source-guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const freightSrc = fs.readFileSync(path.join(__dirname, '..', 'freight-tab-weight-editor.js'), 'utf8');

// Real exported freight helpers (no inline copies).
const { secWeight, weightOf } = require('../freight-tab-weight-editor')._test;

// Pull a top-level function out of source by brace-matching; keep a leading `async`.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}
// Simple eval for helpers that need no injected globals.
function loadFn(src, name) {
    // eslint-disable-next-line no-eval
    return eval('(' + extractFunction(src, name) + ')');
}
// Eval with an injected sandbox (e.g. API_BASE_URL for enquiryFileViewUrl).
function loadFnSandbox(src, name, sandbox) {
    const keys = Object.keys(sandbox);
    // eslint-disable-next-line no-new-func
    const factory = new Function(keys.join(','), 'return (' + extractFunction(src, name) + ');');
    return factory.apply(null, keys.map((k) => sandbox[k]));
}

// ── Feature 1: print-enquiry pure helpers (real, extracted) ──────────────────
const buildAdminMessage = loadFn(html, 'buildAdminMessage');
const isImageEnquiryAttachment = loadFn(html, 'isImageEnquiryAttachment');
const escapeHtml = loadFn(html, 'escapeHtml');
const enquiryFileViewUrl = loadFnSandbox(html, 'enquiryFileViewUrl', { API_BASE_URL: 'https://api.test' });

// ── Feature 2: the real `fmt` format helper (extracted from the module source) ─
const fmt = loadFn(freightSrc, 'fmt');

// The REAL freight-panel section renderer + its pure deps (all string builders, no
// DOM), bundled and executed — so the "+" add button and the tolerance row's ×0.93
// factor are asserted against real output, not values the test itself supplies.
function loadFreightSection() {
    const names = ['esc', 'escTxt', 'fmt', 'weightOf', 'secRows', 'secWeight', 'secComplete', 'gridHead', 'rowHtml',
        'rowIsSeamless', 'secToleranceWeight', 'secHasTolerance', 'sectionHtml'];
    const body = names.map((n) => extractFunction(freightSrc, n)).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn sectionHtml;')();
}
const sectionHtml = loadFreightSection();

// The REAL tolerance helpers — extracted + eval'd (they are NOT on the module's
// `_test` export, so they can't be required; bundle their pure deps and return them).
function loadToleranceHelpers() {
    const names = ['weightOf', 'secRows', 'rowIsSeamless', 'secToleranceWeight', 'secHasTolerance'];
    const body = names.map((n) => extractFunction(freightSrc, n)).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn { rowIsSeamless, secToleranceWeight, secHasTolerance };')();
}
const { rowIsSeamless, secToleranceWeight, secHasTolerance } = loadToleranceHelpers();

describe('buildAdminMessage — the print sheet\'s "Message from the admin" block', () => {
    test('GI/ERW margins render as "Cost + N%", joined with " · "', () => {
        const q = { adminMargins: { gi: { pct: 5 }, erw: { pct: 7 } }, itemSummary: { types: ['GI', 'ERW'] } };
        expect(buildAdminMessage(q)).toBe('GI: Cost + 5% · ERW: Cost + 7%');
    });
    test('Seamless in cost mode -> "Cost + N%"; price-list mode -> "Price list"', () => {
        expect(buildAdminMessage({ adminMargins: { seamless: { mode: 'cost', pct: 8 } }, itemSummary: { types: ['Seamless'] } }))
            .toBe('Seamless: Cost + 8%');
        expect(buildAdminMessage({ adminMargins: { seamless: { mode: 'pricelist' } }, itemSummary: { types: ['Seamless'] } }))
            .toBe('Seamless: Price list');
    });
    test('missing pct defaults to 0%', () => {
        expect(buildAdminMessage({ adminMargins: { gi: {} }, itemSummary: { types: ['GI'] } })).toBe('GI: Cost + 0%');
    });
    test('an admin note is appended on its own line under the margins', () => {
        const q = { adminMargins: { gi: { pct: 5 } }, itemSummary: { types: ['GI'] }, adminNote: 'Urgent — quote today' };
        expect(buildAdminMessage(q)).toBe('GI: Cost + 5%\nUrgent — quote today');
    });
    test('a note with no margins stands alone (no leading newline)', () => {
        expect(buildAdminMessage({ adminNote: 'Please expedite' })).toBe('Please expedite');
    });
    test('nothing configured -> empty string (print sheet omits the block)', () => {
        expect(buildAdminMessage({})).toBe('');
        expect(buildAdminMessage({ adminMargins: null, itemSummary: null })).toBe('');
    });
});

describe('isImageEnquiryAttachment — image-inline vs PDF-iframe decision', () => {
    test('true for an image contentType (case-insensitive)', () => {
        expect(isImageEnquiryAttachment({ contentType: 'image/png' })).toBe(true);
        expect(isImageEnquiryAttachment({ contentType: 'IMAGE/JPEG' })).toBe(true);
    });
    test('true for a known image extension in the name (case-insensitive)', () => {
        expect(isImageEnquiryAttachment({ name: 'photo.JPG' })).toBe(true);
        expect(isImageEnquiryAttachment({ name: 'scan.jpeg' })).toBe(true);
        expect(isImageEnquiryAttachment({ name: 'logo.webp' })).toBe(true);
        expect(isImageEnquiryAttachment({ name: 'anim.gif' })).toBe(true);
    });
    test('false for a PDF / non-image', () => {
        expect(isImageEnquiryAttachment({ name: 'rates.pdf', contentType: 'application/pdf' })).toBe(false);
        expect(isImageEnquiryAttachment({ name: 'sheet.xlsx' })).toBe(false);
        expect(isImageEnquiryAttachment({})).toBe(false);
    });
    test('the extension must be at the end, not mid-name', () => {
        expect(isImageEnquiryAttachment({ name: 'photo.png.zip' })).toBe(false);
    });
});

describe('enquiryFileViewUrl — attachment src for the print window', () => {
    test('builds the view route with URL-encoded key + name', () => {
        const url = enquiryFileViewUrl({ key: 'enq/2026/a b.png', name: 'a b.png' });
        expect(url).toBe('https://api.test/view-enquiry-file?key=enq%2F2026%2Fa%20b.png&name=a%20b.png');
    });
    test('a missing name encodes to an empty name param', () => {
        expect(enquiryFileViewUrl({ key: 'x/y.pdf' })).toBe('https://api.test/view-enquiry-file?key=x%2Fy.pdf&name=');
    });
});

describe('escapeHtml — escapes the title / attachment names written into the print doc', () => {
    test('escapes all five HTML-significant characters', () => {
        expect(escapeHtml('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;');
    });
    test('null / undefined -> empty string', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('printEnquirySheet — source guards (window/document-bound render)', () => {
    test('the "Print enquiry" button is wired to printEnquirySheet(id)', () => {
        expect(html).toContain('printEnquirySheet(${JSON.stringify(quotation.id)})');
        expect(html).toContain('🖨️ Print enquiry');
    });
    test('the sheet embeds the enquiry AS EMAILED (formatted body) via buildEmailContentPreviewHTML', () => {
        expect(html).toContain('const emailHtml = buildEmailContentPreviewHTML(quotation);');
        expect(html).toContain("+ '<div class=\"sec\">Enquiry (as emailed)</div>' + emailHtml");
    });
    test('the sheet renders an Attachments section: images inline, PDFs embedded, notes for non-forwarded files', () => {
        expect(html).toContain("+ '<div class=\"sec\">Attachments</div>' + attachSection");
        expect(html).toContain("'<img src=\"' + escapeHtml(url) + '\">'");
        expect(html).toContain("'<iframe src=\"' + escapeHtml(url) + '\"></iframe>'");
        expect(html).toContain("<p style=\"color:#999; font-size:13px;\">No files attached.</p>");
    });
    test('the admin message is shown as its own block when present', () => {
        expect(html).toContain('<div class="sec">Message from the admin</div>');
    });
    test('it opens a pop-up and prints (with a pop-up-blocked fallback)', () => {
        expect(html).toContain("const win = window.open('', '_blank', 'width=850,height=1000');");
        expect(html).toContain("alert('Please allow pop-ups to print the enquiry.')");
        expect(html).toContain('win.print()');
    });
});

// ── Feature 2 ────────────────────────────────────────────────────────────────

describe('weightOf — line weight = qty × kg/m (real, exported)', () => {
    test('multiplies quantity by kg/m', () => {
        expect(weightOf({ qty: 10, kgm: 3.7 })).toBeCloseTo(37, 6);
    });
    test('a null quantity or zero kg/m contributes nothing', () => {
        expect(weightOf({ qty: null, kgm: 5 })).toBe(0);
        expect(weightOf({ qty: 5, kgm: 0 })).toBe(0);
        expect(weightOf({})).toBe(0);
    });
});

describe('secWeight — total weight of one shipment, skipping soft-deleted rows (real, exported)', () => {
    test('sums only rows in the section and ignores removed rows', () => {
        const st = { rows: [
            { sec: 1, qty: 2, kgm: 10 },               // 20
            { sec: 1, qty: 3, kgm: 10 },               // 30
            { sec: 1, qty: 1, kgm: 10, removed: true }, // soft-deleted -> excluded
            { sec: 2, qty: 9, kgm: 9 },                // other shipment
        ] };
        expect(secWeight(st, 1)).toBe(50);
        expect(secWeight(st, 2)).toBe(81);
    });
    test('an empty section weighs 0', () => {
        expect(secWeight({ rows: [] }, 1)).toBe(0);
    });
});

describe('fmt — weight formatter (real source, extracted)', () => {
    test('rounds to a whole kg', () => {
        expect(fmt(34.41)).toBe('34');
        expect(fmt(34.6)).toBe('35');
        expect(fmt(0)).toBe('0');
    });
    test('uses Indian digit grouping (en-IN)', () => {
        expect(fmt(100000)).toBe('1,00,000');
        expect(fmt(930000)).toBe('9,30,000');
    });
});

describe('freight section render — total row, "With tolerance (7%)" row, and "+" button (real sectionHtml)', () => {
    test('a 37 kg section renders total 37 kg and a 34 kg tolerance weight (× 0.93 applied by real code)', () => {
        const st = { split: false, rows: [
            { id: 1, sec: 1, d: 'Pipe A', qty: 10, kgm: 3.7 },              // 37 kg
            { id: 2, sec: 1, d: 'Removed', qty: 5, kgm: 2, removed: true }, // soft-deleted -> excluded
            { id: 3, sec: 2, d: 'Other shipment', qty: 4, kgm: 100 },       // sec 2 -> excluded from sec 1
        ] };
        expect(secWeight(st, 1)).toBe(37);
        const out = sectionHtml(st, 1);
        // Total row = real section weight.
        expect(out).toContain('Total weight');
        expect(out).toContain('>37 kg</div>');
        // Tolerance row = fmt(37 × 0.93) = fmt(34.41) = "34", produced by the REAL renderer.
        expect(out).toContain('With tolerance (7%)');
        expect(out).toContain('>34 kg</div>');
        // Factor guard: a change to × 0.90 would render 33, not 34.
        expect(out).not.toContain('>33 kg</div>');
        // The "+" add button is rendered for this section.
        expect(out).toContain('<button class="fwe-add fwe-addbtn" data-sec="1"');
    });
    test('the ×0.93 factor holds on big loads, grouped Indian-style (real render)', () => {
        const st = { split: false, rows: [{ id: 1, sec: 1, d: 'Bulk', qty: 100000, kgm: 10 }] }; // 1,000,000 kg
        expect(secWeight(st, 1)).toBe(1000000);
        const out = sectionHtml(st, 1);
        expect(out).toContain('>9,30,000 kg</div>'); // fmt(1,000,000 × 0.93)
    });
});

describe('freight weight panel — source guard (CSS rule only; markup is covered behaviorally above)', () => {
    test('the .fwe-addbtn style rule exists (not renderable, so string-guarded)', () => {
        expect(freightSrc).toContain('.fwe-addbtn{');
    });
});

// ── 7% weight tolerance: welded (ERW/GI) only, NEVER seamless (billed exact) ──
// These EXECUTE the real rowIsSeamless / secToleranceWeight / secHasTolerance and
// the real sectionHtml renderer — no inline copies of the tolerance logic.

describe('rowIsSeamless — classifies a line as seamless (exact-billed) vs welded (tolerance)', () => {
    test('true when the pipe TYPE says seamless (case-insensitive)', () => {
        expect(rowIsSeamless({ type: 'Seamless' })).toBe(true);
        expect(rowIsSeamless({ type: 'SEAMLESS', d: '' })).toBe(true);
        expect(rowIsSeamless({ d: '2" NB smls' })).toBe(true); // "smls" shorthand
    });
    test('true when the DESCRIPTION carries a schedule size (SCH / schedule)', () => {
        expect(rowIsSeamless({ d: '2" NB X Sch 40' })).toBe(true);
        expect(rowIsSeamless({ d: 'Schedule 80 pipe' })).toBe(true);
        expect(rowIsSeamless({ type: 'SCH 160', d: '3" NB' })).toBe(true);
    });
    test('false for welded pipe tagged "-- GI" / "-- ERW"', () => {
        expect(rowIsSeamless({ d: '2" NB X Heavy -- GI' })).toBe(false);
        expect(rowIsSeamless({ d: '2" NB X Medium -- ERW' })).toBe(false);
        expect(rowIsSeamless({ type: 'ERW', d: '2" NB' })).toBe(false);
    });
    test('welded is the default: an untyped / plain row is NOT seamless', () => {
        expect(rowIsSeamless({ d: 'Pipe A' })).toBe(false);
        expect(rowIsSeamless({})).toBe(false);
        expect(rowIsSeamless(null)).toBe(false);
    });
    test('a "-- ERW" tag wins over a stray "sch" so welded lines never slip into seamless', () => {
        // GI/ERW check runs before the SCH check; this stays welded.
        expect(rowIsSeamless({ d: 'sch-ish note -- ERW' })).toBe(false);
    });
});

describe('secToleranceWeight — deduct 7% from welded weight only, keep seamless whole', () => {
    test('an all-seamless section keeps its FULL weight (×1, no deduction)', () => {
        const st = { split: false, rows: [
            { id: 1, sec: 1, d: '2" NB X Sch 40', type: 'Seamless', qty: 10, kgm: 10 }, // 100
            { id: 2, sec: 1, d: '3" NB seamless', type: 'Seamless', qty: 5, kgm: 10 },   // 50
        ] };
        expect(secWeight(st, 1)).toBe(150);
        expect(secToleranceWeight(st, 1)).toBe(150);          // ×1, exact
        expect(secToleranceWeight(st, 1)).toBe(secWeight(st, 1));
        // A 7% deduction would have produced 139.5 — must NOT happen for seamless.
        expect(secToleranceWeight(st, 1)).not.toBeCloseTo(139.5, 5);
    });
    test('an all-welded (ERW/GI) section is reduced to ×0.93', () => {
        const st = { split: false, rows: [
            { id: 1, sec: 1, d: '2" NB -- ERW', type: 'ERW', qty: 10, kgm: 10 }, // 100 -> 93
            { id: 2, sec: 1, d: '3" NB -- GI', type: 'GI', qty: 10, kgm: 10 },   // 100 -> 93
        ] };
        expect(secWeight(st, 1)).toBe(200);
        expect(secToleranceWeight(st, 1)).toBeCloseTo(186, 6); // 200 × 0.93
        expect(secToleranceWeight(st, 1)).not.toBeCloseTo(200, 6); // not left whole
    });
    test('a MIXED section = seamless whole + welded ×0.93 → 193, NOT 186', () => {
        const st = { split: false, rows: [
            { id: 1, sec: 1, d: '2" NB seamless', type: 'Seamless', qty: 10, kgm: 10 }, // 100 seamless -> 100
            { id: 2, sec: 1, d: '3" NB -- ERW', type: 'ERW', qty: 10, kgm: 10 },        // 100 welded   -> 93
        ] };
        expect(secWeight(st, 1)).toBe(200);
        expect(secToleranceWeight(st, 1)).toBeCloseTo(193, 6); // 100 + 93
        // If seamless were (wrongly) also ×0.93 the whole section would be 186.
        expect(secToleranceWeight(st, 1)).not.toBeCloseTo(186, 1);
    });
    test('soft-deleted rows are excluded from the tolerance weight', () => {
        const st = { split: false, rows: [
            { id: 1, sec: 1, d: '2" NB -- ERW', qty: 10, kgm: 10 },                 // 100 -> 93
            { id: 2, sec: 1, d: '3" NB -- ERW', qty: 10, kgm: 10, removed: true },  // excluded
        ] };
        expect(secToleranceWeight(st, 1)).toBeCloseTo(93, 6);
    });
});

describe('secHasTolerance — only show the tolerance line when welded weight exists', () => {
    test('false for an all-seamless section', () => {
        const st = { rows: [{ id: 1, sec: 1, d: '2" NB seamless', qty: 10, kgm: 10 }] };
        expect(secHasTolerance(st, 1)).toBe(false);
    });
    test('true once the section has any ERW/GI (welded) weight', () => {
        const st = { rows: [{ id: 1, sec: 1, d: '2" NB -- ERW', qty: 10, kgm: 10 }] };
        expect(secHasTolerance(st, 1)).toBe(true);
    });
    test('mixed section has tolerance (its welded part qualifies)', () => {
        const st = { rows: [
            { id: 1, sec: 1, d: 'seamless', qty: 10, kgm: 10 },
            { id: 2, sec: 1, d: '-- GI', qty: 10, kgm: 10 },
        ] };
        expect(secHasTolerance(st, 1)).toBe(true);
    });
    test('welded rows with no weight (zero qty, or soft-deleted) do NOT trigger the line', () => {
        expect(secHasTolerance({ rows: [{ id: 1, sec: 1, d: '-- ERW', qty: 0, kgm: 10 }] }, 1)).toBe(false);
        expect(secHasTolerance({ rows: [{ id: 1, sec: 1, d: '-- ERW', qty: 10, kgm: 10, removed: true }] }, 1)).toBe(false);
    });
});

describe('sectionHtml — the "With tolerance (7%)" row appears for welded, is omitted for seamless (real render)', () => {
    test('an ERW section shows the tolerance row at fmt(weight × 0.93): 187 → "174 kg"', () => {
        const st = { split: false, rows: [{ id: 1, sec: 1, d: '2" NB X Heavy -- ERW', type: 'ERW', qty: 187, kgm: 1 }] };
        expect(secWeight(st, 1)).toBe(187);
        const out = sectionHtml(st, 1);
        expect(out).toContain('With tolerance (7%)');
        expect(out).toContain('>187 kg</div>'); // total (whole)
        expect(out).toContain('>174 kg</div>'); // fmt(187 × 0.93) = fmt(173.91)
        // Factor guard: × 0.90 would render 168, not 174.
        expect(out).not.toContain('>168 kg</div>');
    });
    test('an all-seamless section renders NO tolerance row (billed exact)', () => {
        const st = { split: false, rows: [{ id: 1, sec: 1, d: '2" NB X Sch 40', type: 'Seamless', qty: 187, kgm: 1 }] };
        const out = sectionHtml(st, 1);
        expect(out).not.toContain('With tolerance');
        expect(out).toContain('>187 kg</div>'); // total still shown, whole
        // No deducted figure should appear anywhere.
        expect(out).not.toContain('>174 kg</div>');
    });
    test('a mixed section shows a tolerance row at the 193 figure (seamless whole + welded ×0.93)', () => {
        const st = { split: false, rows: [
            { id: 1, sec: 1, d: '2" NB seamless', type: 'Seamless', qty: 100, kgm: 1 }, // 100 -> 100
            { id: 2, sec: 1, d: '3" NB -- ERW', type: 'ERW', qty: 100, kgm: 1 },        // 100 -> 93
        ] };
        const out = sectionHtml(st, 1);
        expect(out).toContain('With tolerance (7%)');
        expect(out).toContain('>200 kg</div>'); // total
        expect(out).toContain('>193 kg</div>'); // 100 + 93
        expect(out).not.toContain('>186 kg</div>'); // would be 200 × 0.93 if seamless were deducted
    });
});
