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

// "Heavy" -> "h", "Medium" -> "m", "Light" -> "l", "SCH 40"/"40" -> "40", "XXS" -> "xxs".
function normClass(raw) {
    const s = String(raw == null ? '' : raw).toLowerCase().trim();
    if (/heavy/.test(s)) return 'h';
    if (/medium/.test(s)) return 'm';
    if (/light/.test(s)) return 'l';
    if (/xxs/.test(s)) return 'xxs';
    const sch = s.match(/(?:sch(?:edule)?\.?\s*)?(\d{2,3})/); // "sch 40", "40"
    if (sch) return sch[1];
    if (/\bxs\b/.test(s)) return 'xs';
    if (/\bstd\b/.test(s)) return 'std';
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
    const iKg = findCol(header, [/kg\s*\/?\s*(m|mtr|meter|metre)/]);
    const kgCol = iKg >= 0 ? iKg : header.length - 1;
    const map = {};
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const size = iInch >= 0 ? row[iInch] : (iSize >= 0 ? row[iSize] : row[0]);
        const cls = iClass >= 0 ? row[iClass] : (iSch >= 0 ? row[iSch] : '');
        const kg = parseFloat(String(row[kgCol] == null ? '' : row[kgCol]).replace(/,/g, '').trim());
        if (size == null || String(size).trim() === '') continue;
        if (!Number.isFinite(kg) || kg <= 0) continue;
        map[weightKey(size, cls)] = kg;
    }
    return map;
}

// Pull { size, cls } from a quote line description like `2" NB X SCH 40`,
// `2-1/2" NB X Heavy -- GI`, `1/2" NB X Sch 80`.
function parseDescription(description) {
    const s = String(description == null ? '' : description);
    const sizeM = s.match(/(\d+\s*[-\s]\s*\d+\/\d+|\d+\/\d+|\d+)\s*"?/);
    const size = sizeM ? sizeM[1] : '';
    let cls = '';
    const sch = s.match(/sch(?:edule)?\.?\s*(\d{2,3})/i);
    if (sch) cls = sch[1];
    else if (/heavy/i.test(s)) cls = 'heavy';
    else if (/medium/i.test(s)) cls = 'medium';
    else if (/light/i.test(s)) cls = 'light';
    else if (/xxs/i.test(s)) cls = 'xxs';
    return { size, cls };
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

module.exports = {
    parseCsv,
    buildWeightMap,
    parseDescription,
    lookupKgPerMeter,
    mapForPipeType,
    _test: { normSize, normClass, weightKey, findCol },
};
