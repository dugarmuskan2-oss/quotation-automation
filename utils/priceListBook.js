'use strict';

// The in-app price lists (ERW / GI / Seamless) — the ONE copy of the prices quotes are made from.
//
// Each list has a LIVE version (checked; quotes are priced from it) and at most one DRAFT (edited,
// not yet checked). The rules the owner set:
//   - An edit never reaches a quote until someone prints the draft, checks it and clicks Checked.
//   - While a list has an unchecked draft, that list's lines on NEW quotes get no price at all
//     (blank and red) — only that list; the others keep pricing from their live version.
//
// A list is stored as spreadsheet rows (row 0 = header), the same shape an uploaded Excel/CSV
// gives, so the existing column readers (buildPriceMap / buildWeightMap) work on it unchanged.
//
// Stored document:
//   { rev, lists: { erw: { live: Version|null, draft: Draft|null }, gi: {…}, seamless: {…} } }
//   Version = { version, rows, editedBy, editedAt, checkedBy, checkedAt }
//   Draft   = { rows, basedOnVersion, editedBy, editedAt, source }
//
// Pure module: no I/O.

const { buildPriceMap, buildSeamlessCostMap, SEAMLESS_COST } = require('./priceList');
const { makeRowKeyer } = require('./pipeWeights');

const LIST_TYPES = ['erw', 'gi', 'seamless'];

function emptyDoc() {
    return { rev: 0, lists: { erw: { live: null, draft: null }, gi: { live: null, draft: null }, seamless: { live: null, draft: null } } };
}

// Fill in anything a stored (or missing) document lacks, so callers never test for holes.
function normaliseDoc(doc) {
    const out = emptyDoc();
    if (!doc || typeof doc !== 'object') return out;
    out.rev = Number.isFinite(doc.rev) ? doc.rev : 0;
    LIST_TYPES.forEach(t => {
        const l = (doc.lists && doc.lists[t]) || {};
        out.lists[t] = { live: l.live || null, draft: l.draft || null };
    });
    return out;
}

function assertListType(type) {
    if (!LIST_TYPES.includes(type)) throw new Error(`Unknown price list "${type}" — use erw, gi or seamless.`);
}

// Every cell as trimmed text; drops fully blank rows; row 0 must be a header.
function cleanRows(rows) {
    if (!Array.isArray(rows) || rows.length < 2) throw new Error('A price list needs a header row and at least one price row.');
    const width = Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0)));
    return rows
        .map(r => Array.from({ length: width }, (_, i) => String(Array.isArray(r) && r[i] != null ? r[i] : '').trim()))
        .filter((r, i) => i === 0 || r.some(c => c !== ''));
}

// A list we cannot price from must never be saved — buildPriceMap throws on a missing rate column.
function validateRows(type, rows) {
    const clean = cleanRows(rows);
    const priced = Object.keys(buildPriceMap(clean, type)).length;
    if (!priced) throw new Error(`No prices could be read from the ${type.toUpperCase()} list — check the rate column has numbers.`);
    return clean;
}

// The price tables quotes are made from, built from LIVE versions only, plus which lists are
// blocked by an unchecked draft and which version priced each list.
function bookFromDoc(doc) {
    const d = normaliseDoc(doc);
    const book = { pending: [], versions: {} };
    LIST_TYPES.forEach(t => {
        const { live, draft } = d.lists[t];
        if (draft) book.pending.push(t);
        if (!live) return;
        book[t] = buildPriceMap(live.rows, t);
        book.versions[t] = live.version;
        if (t === 'seamless') book[SEAMLESS_COST] = buildSeamlessCostMap(live.rows);
    });
    return book;
}

// Cell-by-cell differences between the live rows and the draft rows, matched by row key (size +
// class) so a re-ordered or inserted row does not mark everything below it as changed.
function diffRows(liveRows, draftRows) {
    const header = (draftRows && draftRows[0]) || [];
    const keyOf = makeRowKeyer(header);
    const liveHeader = (liveRows && liveRows[0]) || [];
    const liveKeyOf = makeRowKeyer(liveHeader);
    const liveByKey = {};
    (liveRows || []).slice(1).forEach(r => { const k = liveKeyOf(r); if (k) liveByKey[k] = r; });
    const changes = [];
    (draftRows || []).slice(1).forEach((row, i) => {
        const key = keyOf(row);
        const before = key ? liveByKey[key] : null;
        if (!before) { changes.push({ row: i + 1, key, kind: 'added' }); return; }
        delete liveByKey[key];
        header.forEach((h, c) => {
            const lc = liveHeader.indexOf(h);
            const from = lc >= 0 ? String(before[lc] == null ? '' : before[lc]) : '';
            const to = String(row[c] == null ? '' : row[c]);
            if (from !== to) changes.push({ row: i + 1, key, kind: 'changed', column: h, from, to });
        });
    });
    // A removed row is named by its first cell (the Size code as printed, e.g. "1XM").
    Object.keys(liveByKey).forEach(k => changes.push({ key: k, kind: 'removed', label: String(liveByKey[k][0] || k) }));
    return changes;
}

// ── Transitions. Each returns a NEW document with rev advanced; the caller saves it. ──────────

function withList(doc, type, list) {
    const d = normaliseDoc(doc);
    d.lists[type] = list;
    d.rev += 1;
    return d;
}

function saveDraft(doc, type, rows, { editedBy, source }) {
    assertListType(type);
    const d = normaliseDoc(doc);
    const live = d.lists[type].live;
    const draft = { rows: validateRows(type, rows), basedOnVersion: live ? live.version : 0,
        editedBy: editedBy || '', editedAt: new Date().toISOString(), source: source || 'edit' };
    return withList(d, type, { live, draft });
}

function discardDraft(doc, type) {
    assertListType(type);
    const d = normaliseDoc(doc);
    if (!d.lists[type].draft) throw new Error(`The ${type.toUpperCase()} list has no draft to discard.`);
    return withList(d, type, { live: d.lists[type].live, draft: null });
}

// The draft becomes live. Returns the new document and the version it replaced (for history).
function checkDraft(doc, type, checkedBy) {
    assertListType(type);
    const name = String(checkedBy || '').trim();
    if (!name) throw new Error('Type the name of the person who checked the list.');
    const d = normaliseDoc(doc);
    const { live, draft } = d.lists[type];
    if (!draft) throw new Error(`The ${type.toUpperCase()} list has no changes waiting to be checked.`);
    const next = { version: (live ? live.version : 0) + 1, rows: draft.rows, editedBy: draft.editedBy,
        editedAt: draft.editedAt, checkedBy: name, checkedAt: new Date().toISOString() };
    return { doc: withList(d, type, { live: next, draft: null }), replaced: live };
}

module.exports = { LIST_TYPES, emptyDoc, normaliseDoc, assertListType, cleanRows, validateRows, bookFromDoc,
    diffRows, saveDraft, discardDraft, checkDraft };
