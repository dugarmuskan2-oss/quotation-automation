'use strict';

// Sizes the AI wrote in millimetres, and XXS written so it reads as XS.
//
// Staff corrections, 14–16 Oct 2026:
//   DSC-2958 "Pipe NB 40 * SCH 160"      → AI "40X160"  (40 inch)  — is 1-1/2" (40 NB)
//   DSC-2936 "OD 48 mm x 4 mm"            → AI "48X4"   (48 inch)  — is 1-1/2" (48.3 OD)
//   DSC-2944 "OD 27MM"                    → AI "27X3.50MM"          — is 3/4"   (26.9 OD)
//   DSC-2938 "S-XXS" on 5 lines           → AI "1/2XXS", which reads "1/2 X XS" = Sch 80, priced too cheap
//
// The lists are keyed by inch, and the description is "<size>X<class>", so "1/2XXS" is
// genuinely ambiguous: XS after the X, or XXS with the X dropped. XXS is written "1/2XXXS".
//
// Only a size that cannot be an inch size is converted: anything above 24", or a decimal that is
// a pipe OD. 20 and 10 stay inch — "20NB" with the letters is handled by pipeWeights.
//
// Pure module: no I/O.

const { normSize } = require('./pipeWeights');

const INCH_SIZES = new Set(['1/8', '1/4', '3/8', '1/2', '3/4', '1', '11/4', '11/2', '2', '21/2', '3', '31/2',
    '4', '5', '6', '8', '10', '12', '14', '16', '18', '20', '22', '24']);

const NB_MM = { 15: '1/2', 25: '1', 32: '11/4', 40: '11/2', 50: '2', 65: '21/2', 80: '3', 90: '31/2', 100: '4',
    125: '5', 150: '6', 200: '8', 250: '10', 300: '12', 350: '14', 400: '16', 450: '18', 500: '20', 600: '24' };

// Outside diameters (ASME B36.10 and the EN/IS figures the lists also print).
const OD_MM = [[21.3, '1/2'], [26.7, '3/4'], [26.9, '3/4'], [33.4, '1'], [33.7, '1'], [42.2, '11/4'], [42.4, '11/4'],
    [48.3, '11/2'], [60.3, '2'], [73, '21/2'], [76.1, '21/2'], [88.9, '3'], [101.6, '31/2'], [114.3, '4'],
    [139.7, '5'], [141.3, '5'], [165.1, '6'], [168.3, '6'], [219.1, '8'], [273, '10'], [273.1, '10'],
    [323.9, '12'], [324.8, '12'], [355.6, '14'], [406.4, '16'], [457.2, '18'], [508, '20'], [609.6, '24']];
const OD_TOLERANCE_MM = 1;

/** Inch size for a size written in mm, or null when it is (or may be) an inch size already. */
function inchFromMm(size) {
    const s = String(size == null ? '' : size).trim();
    if (!/^\d+(\.\d+)?$/.test(s) || INCH_SIZES.has(normSize(s))) return null;
    const n = parseFloat(s);
    if (Number.isInteger(n) && NB_MM[n]) return { inch: NB_MM[n], from: 'NB ' + n + ' mm' };
    // Two ODs inside the tolerance are always the same size (26.7/26.9, 139.7/141.3), so first is fine.
    const hit = OD_MM.find(([od]) => Math.abs(od - n) <= OD_TOLERANCE_MM);
    return hit ? { inch: hit[1], from: 'OD ' + n + ' mm' } : null;
}

// "Sch XXS" appears in the enquiry, and plain "XS" never does.
function enquiryMeansXxs(enquiryText) {
    const t = String(enquiryText == null ? '' : enquiryText).toUpperCase();
    return /XXS/.test(t) && !/(^|[^X])XS\b/.test(t.replace(/XXS/g, ''));
}

// STD and XS are the same pipe as Sch 40 up to 10" and Sch 80 up to 8" (ASME B36.10). The seamless
// list names most of those rows by number only, so an STD/XS line found no price (DSC-2938: staff
// retyped 3"–6" STD as Sch 40 and 1"–6" XS as Sch 80 by hand). Above those sizes they differ, and
// the list names its own STD/XS rows, so they are left alone.
const INCH_ORDER = ['1/8', '1/4', '3/8', '1/2', '3/4', '1', '11/4', '11/2', '2', '21/2', '3', '31/2', '4', '5', '6', '8', '10'];
function stdXsAsNumber(size, cls) {
    const at = INCH_ORDER.indexOf(normSize(size));
    if (at < 0) return null;
    if (cls === 'STD') return '40';
    if (cls === 'XS' && at <= INCH_ORDER.indexOf('8')) return '80';
    return null;
}

/**
 * Rewrite each line's size into inches when the AI left it in mm, and "<size>XXS" into
 * "<size>XXXS" when the enquiry only ever says XXS. Returns how many lines changed.
 */
function normalizeLineSizes(lineItems, enquiryText) {
    const out = { mmToInch: 0, xxs: 0, stdXs: 0 };
    const onlyXxs = enquiryMeansXxs(enquiryText);
    (lineItems || []).forEach((li) => {
        const desc = String((li && li.originalDescription) || '').trim();
        const m = /^(\d+(?:\.\d+)?)\s*X\s*(.+)$/i.exec(desc);
        if (m) {
            const conv = inchFromMm(m[1]);
            if (conv) { li.originalDescription = conv.inch + 'X' + m[2]; li.enquirySize = conv.from; out.mmToInch++; }
        }
        const x = /^((?:\d+-)?\d+(?:\/\d+)?)XXS$/i.exec(String(li && li.originalDescription || ''));
        if (x && onlyXxs) { li.originalDescription = x[1] + 'XXXS'; out.xxs++; }
        const s = /^((?:\d+-)?\d+(?:\/\d+)?)X(STD|XS)$/i.exec(String(li && li.originalDescription || ''));
        const num = s && /seamless/i.test(String(li.identifiedPipeType || '')) && stdXsAsNumber(s[1], s[2].toUpperCase());
        if (num) { li.originalDescription = s[1] + 'X' + num; out.stdXs++; }
    });
    return out;
}

module.exports = { normalizeLineSizes, inchFromMm, enquiryMeansXxs, stdXsAsNumber, INCH_SIZES, NB_MM, OD_MM };
