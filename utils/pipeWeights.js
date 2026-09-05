'use strict';

// Pipe-weight lookup built from the user's own price lists (GI / ERW / Seamless).
// Each list carries kg/m in its last column (header "KG/MTR" or similar). We key the
// lookup on SIZE + CLASS/SCHEDULE taken from the clean Inch + Light/Medium/Heavy (or
// SCH) columns — never the raw "Size" code — so quirks like the `1XHY` code for 1" Heavy
// can't cause a miss. A quote line's description is parsed to the same key to look kg/m up.
//
// Pure module: no DOM, no I/O. Used server-side (backfill at quote generation) and its
// parsed map is shipped to the browser for the Freight panel / Weight Calculator to fill
// blanks. Fills BLANKS only — an AI-supplied kg/m is never overwritten.

// "2", "2-1/2", "2 1/2", `2"`, "2 inch", "50 NB" -> a compact size token: "2", "21/2".
function normSize(raw) {
    let s = String(raw == null ? '' : raw).toLowerCase();
    s = s.replace(/inches|inch|nominal|bore|"|”|nb/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    // "2 1/2" or "2-1/2" (whole + fraction) -> "21/2"
    s = s.replace(/^(\d+)\s*[-\s]\s*(\d+\/\d+)$/, '$1$2');
    return s.replace(/\s+/g, '');
}

// "Heavy" -> "h", "Medium" -> "m", "Light" -> "l", "SCH 40"/"40" -> "40", "XXS" -> "xxs",
// and a millimetre wall -> the bare number ("6.35" -> "6.35", "4.0" -> "4", "10 MM" -> "10").
//
// The large-bore ERW/GI rows (8" and up) carry NO class — they are sized by wall thickness, in
// the Wall Thickness column. Without handling that, every 8" row keys to the same "8|" and they
// overwrite each other, so the 8" weight you get back is whichever row happened to be last.
// Schedules and walls never collide because seamless and ERW/GI live in separate maps.
function normClass(raw) {
    const s = String(raw == null ? '' : raw).toLowerCase().trim();
    if (/heavy/.test(s)) return 'h';
    if (/medium/.test(s)) return 'm';
    if (/light/.test(s)) return 'l';
    if (/xxs/.test(s)) return 'xxs';
    if (/\bxs\b/.test(s)) return 'xs';
    if (/\bstd\b/.test(s)) return 'std';
    const sch = s.match(/sch(?:edule)?\.?\s*(\d{1,3})/);            // explicit "sch 40"
    if (sch) return sch[1];
    const num = s.match(/^(\d+(?:\.\d+)?)\s*(?:mm)?$/);             // "40", "6.35", "10 mm"
    if (num) return String(parseFloat(num[1]));                     // 4.0 and 4 are one row
    return s.replace(/\s+/g, '');
}

function weightKey(size, cls) {
    return normSize(size) + '|' + normClass(cls);
}

// Parse one CSV file into an array of cell-arrays (handles quoted fields, embedded commas
// and doubled "" quotes, e.g. `"31/2"" X 80 (X)"` and `"60,600"`).
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const src = String(text == null ? '' : text);
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// An empty spreadsheet cell does not always arrive empty. The large-bore ERW/GI rows carry no
// class, and the export writes the literal text "NaN" there — which is a non-empty string, so a
// plain truthiness check took "NaN" as the class and every 8"-and-up row keyed to "8|nan". The
// class then never fell through to the wall thickness, and not one large-bore weight resolved.
function cellOrBlank(v) {
    const s = String(v == null ? '' : v).trim();
    return /^(nan|#n\/a|n\/a|null|-|--)$/i.test(s) ? '' : s;
}

// Index of the first header cell matching any regex; -1 if none.
function findCol(header, regexes) {
    for (let i = 0; i < header.length; i++) {
        const h = String(header[i] == null ? '' : header[i]).toLowerCase().trim();
        if (h && regexes.some(rx => rx.test(h))) return i;
    }
    return -1;
}

// Build { "size|class" -> kgPerMeter } from a price list's rows (first row = header).
// kg/m column is the one headed KG/MTR / kg/m / kg per meter, else the last column.
function buildWeightMap(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return {};
    const header = rows[0];
    const iInch = findCol(header, [/^inch$/, /inch/]);
    const iSize = findCol(header, [/^size$/]);
    const iClass = findCol(header, [/light.*medium.*heavy|light\/medium|medium.*heavy|^class$/]);
    const iSch = findCol(header, [/^sch$/, /schedule/]);
    const iWall = findCol(header, [/wall.*thick|^thickness/]);
    const iKg = findCol(header, [/kg\s*\/?\s*(m|mtr|meter|metre)/]);
    const kgCol = iKg >= 0 ? iKg : header.length - 1;
    const map = {};
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const size = iInch >= 0 ? row[iInch] : (iSize >= 0 ? row[iSize] : row[0]);
        // Class first, then schedule, then WALL THICKNESS — the 8"-and-up ERW/GI rows leave the
        // class cell empty and are distinguished only by their wall, so without that fallback
        // every large-bore row of one size shares a key and all but the last are lost.
        const clsCell = cellOrBlank(iClass >= 0 ? row[iClass] : '');
        const schCell = cellOrBlank(iSch >= 0 ? row[iSch] : '');
        const wallCell = cellOrBlank(iWall >= 0 ? row[iWall] : '');
        const cls = clsCell || schCell || wallCell;
        const kg = parseFloat(String(row[kgCol] == null ? '' : row[kgCol]).replace(/,/g, '').trim());
        if (size == null || String(size).trim() === '') continue;
        if (!Number.isFinite(kg) || kg <= 0) continue;
        map[weightKey(size, cls)] = kg;
    }
    return map;
}

// Pull { size, cls } from a quote line description.
//
// TWO forms arrive here and both must work. The AI returns its own compact code — "2XH",
// "1XHY", "21/2XM", "8X6.35", "16X6.0" — while the app's own formatter later rewrites the same
// line for the screen as `2" NB X Heavy -- ERW` or `8" NB X 6.35mm thk -- ERW`. Reading only the
// display form is why this never matched a freshly generated quote: it is handed the AI's form.
//
// The size is taken from the FRONT of the code, and the class from what follows the final "X" —
// splitting on the first "X" turns "21/2XM" into size "21" and loses every fraction size.
function parseDescription(description) {
    const raw = String(description == null ? '' : description);
    const t = raw.toUpperCase().replace(/["”]/g, '').replace(/\s+/g, '')
        .replace(/--?(ERW|GI|SEAMLESS).*$/, '')
        .replace(/MMTHK$/, '').replace(/THK$/, '').replace(/MM$/, '');

    // Display form first: 2NBXHEAVY, 8NBX6.35, 1-1/2NBXSCH40
    let m = /^((?:\d+-)?\d+(?:\/\d+)?)NBX(.+)$/.exec(t);
    // …else the AI's compact code: 2XH, 21/2XM, 8X6.35, 16X5.5(6.0)
    if (!m) {
        const bracket = /\(([\d.]+)\)$/.exec(t);
        const body = bracket ? t.slice(0, t.indexOf('(')) : t;
        const c = /^((?:\d+-)?\d+(?:\/\d+)?)X(.+)$/.exec(body);
        if (c) m = [t, c[1], bracket ? bracket[1] : c[2]];
    }
    if (!m) {
        // Last resort — a bare size with no separator at all.
        const sizeOnly = raw.match(/(\d+\s*[-\s]\s*\d+\/\d+|\d+\/\d+|\d+)\s*"?/);
        return { size: sizeOnly ? sizeOnly[1] : '', cls: '' };
    }

    // Leave the size as written — normSize folds "2-1/2" and "21/2" together when the key is
    // built, and callers (and the existing tests) expect what the description actually said.
    const size = m[1];
    let spec = String(m[2]).replace(/^SCH(?:EDULE)?\.?/, '');       // "SCH40" -> "40"
    if (/^(HEAVY|HY|H)$/.test(spec)) spec = 'heavy';
    else if (/^(MEDIUM|MED|M)$/.test(spec)) spec = 'medium';
    else if (/^(LIGHT|LGT|L)$/.test(spec)) spec = 'light';
    return { size, cls: spec };
}

// Pick the right list's map for a line's pipe type ("Seamless Sch 40", "GI", "ERW").
function mapForPipeType(maps, pipeType) {
    const t = String(pipeType == null ? '' : pipeType).toLowerCase();
    if (/seamless/.test(t)) return maps.seamless || null;
    if (/erw/.test(t)) return maps.erw || null;
    if (/\bgi\b|galvan/.test(t)) return maps.gi || null;
    return null;
}

// kg/m for a quote line, or null if the size isn't in that list.
function lookupKgPerMeter(maps, pipeType, description) {
    const map = mapForPipeType(maps || {}, pipeType);
    if (!map) return null;
    const { size, cls } = parseDescription(description);
    if (!size) return null;
    const k = weightKey(size, cls);
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
}

// Fill in the kg/m the AI left blank, from the user's own price list.
//
// Why in code and not in the prompt: the AI drops kg/m by whole enquiries at a time — one real
// quote came back with 0 of 52 weights filled — and a missing weight silently drops that line's
// tonnage out of the freight enquiry, so the transporter is asked to price the wrong load.
// Reading a value out of a column is a lookup, and a lookup gets the same answer every time for
// no tokens, whereas a busy model skips it about one line in five.
//
// Two rules it must never break:
//   - BLANKS ONLY. A weight the AI supplied is left exactly as it is; if the two disagree that
//     is worth knowing about, not worth silently papering over.
//   - NO GUESSING. A size the sheet does not carry stays blank, so the app shows it red and
//     somebody looks, rather than a computed-from-geometry number nobody checked.
//
// Returns a count, so a caller can say what happened rather than change things invisibly.
function fillBlankKgPerMeter(maps, lineItems) {
    const out = { filled: 0, unknown: 0, alreadySet: 0 };
    if (!maps || !Object.keys(maps).length || !Array.isArray(lineItems)) return out;
    for (const li of lineItems) {
        if (!li || typeof li !== 'object') continue;
        const existing = String(li.kgPerMeter == null ? '' : li.kgPerMeter).trim();
        if (existing && parseFloat(existing) > 0) { out.alreadySet++; continue; }
        const kg = lookupKgPerMeter(maps, li.identifiedPipeType, li.originalDescription || li.description);
        if (kg > 0) { li.kgPerMeter = String(kg); out.filled++; }
        else out.unknown++;
    }
    return out;
}

const api = {
    parseCsv,
    buildWeightMap,
    parseDescription,
    lookupKgPerMeter,
    mapForPipeType,
    fillBlankKgPerMeter,
    _test: { normSize, normClass, weightKey, findCol },
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;

// The Freight panel needs the SAME lookup to repair quotes that were generated before the
// backfill existed. Loading this one file in the browser keeps a single copy of the matching
// rules — a second implementation over there would drift, and a size that resolved on the
// server but not on screen is the worst of both.
if (typeof window !== 'undefined') window.pipeWeights = api;
