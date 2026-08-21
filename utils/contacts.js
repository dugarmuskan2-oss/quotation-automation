'use strict';

/**
 * utils/contacts.js — the partner directory's data logic (server side).
 *
 * A partner is one firm: dealers, manufacturers, transporters, fabricators, or "other".
 * The shape mirrors how the trade actually works — a firm has PEOPLE (each with several
 * labelled phones/emails), BRANCHES (places a lorry can go), PRODUCTS (each a list of
 * sizes, because 15 NB heavy is 3.2 mm while 100 NB heavy is 5.4 mm — never a range),
 * firm-wide price RULES, and STATS the app learns on its own (asked/replied/when).
 *
 * Pure module: no I/O. `routes/contacts.js` owns reading/writing the JSON blob.
 * Ranking lives in the browser (partner-directory.js) — the server never ranks.
 */

const ROLES = ['dealer', 'manufacturer', 'transporter', 'fabricator', 'other'];
const MAX_CONTACTS = 2000;
const MAX_CHANGES = 200;

function str(v) { return String(v == null ? '' : v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function normalizeRole(v) {
    const s = lower(v);
    if (ROLES.indexOf(s) !== -1) return s;
    if (/manufact|mill|plant/.test(s)) return 'manufacturer';
    if (/transport|lorry|truck|freight|logistic|cargo|roadline|carrier/.test(s)) return 'transporter';
    if (/fabricat/.test(s)) return 'fabricator';
    if (/dealer|stockist|trader|supplier|distribut/.test(s)) return 'dealer';
    return 'other';
}

function isEmail(v) { return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(str(v)); }

// ── people: one person, many labelled numbers and addresses ──────────────────

function sanitizeLines(list, max) {
    return (Array.isArray(list) ? list : [])
        .map(x => ({ label: str(x && x.label) || 'Other', v: str(x && x.v) }))
        .filter(x => x.v)
        .slice(0, max || 6);
}

function sanitizePerson(p) {
    return {
        name: str(p && p.name),
        role: str(p && p.role),
        phones: sanitizeLines(p && p.phones),
        emails: sanitizeLines(p && p.emails).filter(e => isEmail(e.v)),
    };
}

function sanitizePeople(list) {
    const people = (Array.isArray(list) ? list : []).map(sanitizePerson)
        .filter(p => p.name || p.phones.length || p.emails.length);
    return people.length ? people.slice(0, 12) : [{ name: '', role: 'Main contact', phones: [], emails: [] }];
}

/** Every email a firm holds, whichever person holds it — matching must look at all. */
function allEmails(partner) {
    const out = [];
    (partner.people || []).forEach(p => (p.emails || []).forEach(e => { if (e.v) out.push(lower(e.v)); }));
    return out;
}

// ── branches, products, notes ────────────────────────────────────────────────

function sanitizeBranches(list) {
    return (Array.isArray(list) ? list : [])
        .map(b => ({ city: str(b && b.city), area: str(b && b.area), address: str(b && b.address) }))
        .filter(b => b.city || b.area || b.address)
        .slice(0, 20);
}

function sanitizeSizes(list) {
    return (Array.isArray(list) ? list : [])
        .map(s => ({ nb: str(s && s.nb), inch: str(s && s.inch), od: str(s && s.od), thk: str(s && s.thk) }))
        .filter(s => s.nb || s.inch || s.od || s.thk)
        .slice(0, 60);
}

function sanitizeProducts(list) {
    return (Array.isArray(list) ? list : [])
        .map(pr => ({
            p: str(pr && pr.p), spec: str(pr && pr.spec),
            sizes: sanitizeSizes(pr && pr.sizes),
            moq: num(pr && pr.moq, 0), rule: str(pr && pr.rule),
        }))
        .filter(pr => pr.p || pr.spec || pr.sizes.length)
        .slice(0, 40);
}

function sanitizeNotes(list) {
    return (Array.isArray(list) ? list : [])
        .map(n => ({ d: str(n && n.d), t: str(n && n.t).slice(0, 2000), src: str(n && n.src) }))
        .filter(n => n.t)
        .slice(0, 100);
}

function sanitizeStrings(list, max) {
    return (Array.isArray(list) ? list : []).map(str).filter(Boolean).slice(0, max || 20);
}

// ── the partner record ───────────────────────────────────────────────────────

function sanitizePartner(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const now = new Date().toISOString();
    return {
        id: str(src.id) || ('p_' + now.replace(/[^0-9]/g, '').slice(0, 17)),
        role: normalizeRole(src.role),
        roleOther: str(src.roleOther),
        company: str(src.company),
        people: sanitizePeople(src.people),
        city: str(src.city),
        address: str(src.address),
        branches: sanitizeBranches(src.branches),
        types: sanitizeStrings(src.types, 10),
        moq: num(src.moq, 0),
        products: sanitizeProducts(src.products),
        rules: sanitizeStrings(src.rules, 20),
        routes: (Array.isArray(src.routes) ? src.routes : [])
            .map(r => ({ from: str(r && r.from), to: str(r && r.to) }))
            .filter(r => r.from || r.to).slice(0, 40),
        vehicles: str(src.vehicles),
        partLoad: src.partLoad !== false,
        notes: sanitizeNotes(src.notes),
        images: (Array.isArray(src.images) ? src.images : [])
            .map(im => ({ n: str(im && im.n), kind: str(im && im.kind), d: str(im && im.d), count: num(im && im.count, 0) }))
            .filter(im => im.n).slice(0, 30),
        fromEnquiry: src.fromEnquiry === true,
        fromWeb: src.fromWeb === true,
        enq: num(src.enq, 0),
        rep: num(src.rep, 0),
        last: str(src.last),
        checked: str(src.checked) || now.slice(0, 10),
    };
}

/** Merge one partner into the list by id (never a whole-list overwrite). */
function mergePartner(list, incoming) {
    const partner = sanitizePartner(incoming);
    const contacts = (Array.isArray(list) ? list : []).slice(0, MAX_CONTACTS);
    const idx = contacts.findIndex(c => c && c.id === partner.id);
    if (idx === -1) contacts.unshift(partner);
    else contacts[idx] = partner;
    return { contacts: contacts.slice(0, MAX_CONTACTS), partner };
}

function findByEmail(list, email) {
    const wanted = lower(email);
    if (!wanted) return null;
    return (Array.isArray(list) ? list : []).find(c => allEmails(c).indexOf(wanted) !== -1) || null;
}

// ── the automatic side: usage stats and stubs ────────────────────────────────

/** `sales@kalpatarusteel.com` → "Kalpataru Steel" — a guess to be confirmed, never a fact. */
const FREE_MAIL = /^(gmail|yahoo|ymail|hotmail|outlook|live|rediffmail|icloud|proton|protonmail|aol)$/;
const TRADE_WORDS = ['corporation', 'engineering', 'international', 'enterprises', 'enterprise',
    'industries', 'roadlines', 'logistics', 'syndicate', 'overseas', 'agencies', 'carriers',
    'trading', 'traders', 'exports', 'industry', 'movers', 'impex', 'metals', 'steels', 'stores',
    'alloys', 'agency', 'cargo', 'trader', 'tubes', 'pipes', 'steel', 'metal', 'alloy', 'group',
    'corp', 'tube', 'pipe', 'iron'];

function splitTradeWord(s) {
    for (let i = 0; i < TRADE_WORDS.length; i++) {
        const w = TRADE_WORDS[i];
        if (s.length > w.length && s.slice(-w.length) === w) return splitTradeWord(s.slice(0, -w.length)).concat([w]);
    }
    return s ? [s] : [];
}

function companyFromEmail(email) {
    const label = (lower(email).split('@')[1] || '').split('.')[0] || '';
    if (!label || FREE_MAIL.test(label)) return '';
    const out = [];
    label.split(/[-_.]+/).filter(Boolean).forEach(part => { out.push.apply(out, splitTradeWord(part)); });
    return out.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Record that enquiries went out to (or a reply came in from) these addresses.
 * Unknown addresses become stubs the owner tidies later — the directory fills itself.
 */
function bumpUsage(list, usage) {
    const now = new Date().toISOString().slice(0, 10);
    const reply = (usage && usage.kind) === 'reply';
    let contacts = (Array.isArray(list) ? list : []).slice();
    sanitizeStrings(usage && usage.emails, 50).map(lower).filter(isEmail).forEach(email => {
        let target = findByEmail(contacts, email);
        if (!target) {
            target = stubPartner(email, usage);
            contacts.unshift(target);
        }
        if (reply) { target.rep = num(target.rep, 0) + 1; }
        else { target.enq = num(target.enq, 0) + 1; }
        target.last = now;
    });
    return contacts.slice(0, MAX_CONTACTS);
}

function stubPartner(email, usage) {
    return sanitizePartner({
        role: (usage && usage.role) || 'dealer',
        company: companyFromEmail(email) || email,
        people: [{ name: '', role: 'Main contact', emails: [{ label: 'Work', v: email }] }],
        types: sanitizeStrings(usage && usage.pipeTypes, 6),
        routes: (usage && usage.pickup) ? [{ from: usage.pickup, to: str(usage.drop) }] : [],
        fromEnquiry: true,
    });
}

// ── the change log: what the app did on its own, with enough to undo it ──────

function changeEntry(title, detail, source, partnerId, before, after) {
    return {
        id: 'ch_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
        at: new Date().toISOString(),
        title: str(title), detail: str(detail), source: str(source),
        partnerId: str(partnerId), undone: false,
        before: before ? sanitizePartner(before) : null,
        lines: after ? diffLines(before, after) : [],
    };
}

function pushChange(changes, entry) {
    const list = (Array.isArray(changes) ? changes : []).slice();
    list.unshift(entry);
    return list.slice(0, MAX_CHANGES);
}

/** Field-by-field record of what moved — frozen when the change happens. */
function diffLines(before, now) {
    const out = [], b = before || {};
    const was = k => str(b[k]);
    [['company', 'Company'], ['city', 'City'], ['address', 'Address'], ['vehicles', 'Vehicles']]
        .forEach(([k, label]) => { if (was(k) !== str(now[k])) out.push({ label, from: was(k), to: str(now[k]) }); });
    if (num(b.moq, 0) !== num(now.moq, 0)) out.push({ label: 'Overall MOQ', from: num(b.moq, 0) + ' T', to: num(now.moq, 0) + ' T' });
    diffList(out, 'Pipe types', (b.types || []).join(', '), (now.types || []).join(', '));
    diffProducts(out, b, now);
    diffAdditions(out, b, now);
    return out;
}

function diffList(out, label, a, bVal) { if (a !== bVal) out.push({ label, from: a, to: bVal }); }

function diffProducts(out, b, now) {
    const line = y => 'min ' + num(y.moq, 0) + ' T' + (y.rule ? ' · ' + y.rule : '');
    const had = {};
    (b.products || []).forEach(x => { had[lower(x.p)] = x; });
    (now.products || []).forEach(x => {
        const o = had[lower(x.p)];
        if (!o) out.push({ label: 'Product added', from: '', to: x.p + ' — ' + line(x) });
        else if (num(o.moq, 0) !== num(x.moq, 0) || str(o.rule) !== str(x.rule)) out.push({ label: x.p, from: line(o), to: line(x) });
    });
}

function diffAdditions(out, b, now) {
    const hadR = (b.routes || []).map(r => r.from + ' → ' + r.to);
    (now.routes || []).forEach(r => { const k = r.from + ' → ' + r.to; if (hadR.indexOf(k) === -1) out.push({ label: 'Route added', from: '', to: k }); });
    const hadN = (b.notes || []).map(n => n.t);
    (now.notes || []).forEach(n => { if (hadN.indexOf(n.t) === -1) out.push({ label: 'Note added', from: '', to: n.t }); });
    const hadF = (b.images || []).map(i => i.n);
    (now.images || []).forEach(i => { if (hadF.indexOf(i.n) === -1) out.push({ label: 'File kept', from: '', to: i.n }); });
}

/** Undo one logged change: an addition is removed, an edit is restored from `before`. */
function undoChange(contacts, changes, changeId) {
    const list = (Array.isArray(changes) ? changes : []).slice();
    const ch = list.find(x => x && x.id === changeId);
    if (!ch || ch.undone) return { contacts, changes: list, ok: false };
    let next = (contacts || []).slice();
    const idx = next.findIndex(p => p && p.id === ch.partnerId);
    if (ch.before === null) { if (idx !== -1) next.splice(idx, 1); }
    else if (idx !== -1) next[idx] = sanitizePartner(ch.before);
    ch.undone = true;
    return { contacts: next, changes: list, ok: true };
}

// ── pending items from the Gmail label ───────────────────────────────────────

function sanitizePendingItem(input) {
    const src = (input && typeof input === 'object') ? input : {};
    return {
        id: str(src.id) || ('pd_' + Date.now() + '_' + Math.floor(Math.random() * 1e6)),
        from: lower(src.from),
        subject: str(src.subject).slice(0, 300),
        file: str(src.file).slice(0, 200),
        kind: /pdf/i.test(str(src.kind) || str(src.file)) ? 'pdf' : 'photo',
        text: str(src.text).slice(0, 20000),
        finds: Array.isArray(src.finds) ? src.finds.slice(0, 40) : [],
        receivedAt: str(src.receivedAt) || new Date().toISOString(),
    };
}

/** The prompt that turns an email + attachment text into directory findings. */
function extractionPrompt(item) {
    return 'Read this email (and any attachment text) from a trade partner of a pipe dealership.\n'
        + 'Return STRICT JSON only: {"role":"dealer|manufacturer|transporter|fabricator|other",'
        + '"company":"","person":"","phone":"","city":"","branches":"","types":"comma list of GI/ERW/Seamless/SS/MS/Alloy",'
        + '"products":[{"p":"","spec":"","moq":0,"rule":""}],"routes":[{"from":"","to":""}],"vehicles":"","notes":["short facts worth keeping"]}\n'
        + 'Leave any field you are not sure of EMPTY — never guess a number.\n\n'
        + 'From: ' + item.from + '\nSubject: ' + item.subject + '\n\n' + item.text;
}

/** Turn the model's JSON into the same find rows the UI reviews. */
function findsFromExtraction(parsed) {
    const p = (parsed && typeof parsed === 'object') ? parsed : {};
    const out = [];
    const field = (key, label, value) => { if (str(value)) out.push({ kind: 'field', key, label, value: str(value) }); };
    field('role', 'They are a', p.role); field('company', 'Company', p.company);
    field('person', 'Contact person', p.person); field('phone', 'Phone', p.phone);
    field('city', 'City', p.city); field('branches', 'Branches', p.branches);
    field('types', 'Pipe types', p.types); field('vehicles', 'Vehicles', p.vehicles);
    (Array.isArray(p.products) ? p.products : []).slice(0, 15).forEach(pr => {
        if (str(pr && pr.p)) out.push({ kind: 'product', label: 'Product', value: str(pr.p) + (pr.spec ? ' — ' + str(pr.spec) : ''), product: { p: str(pr.p), spec: str(pr.spec), sizes: [], moq: num(pr.moq, 0), rule: str(pr.rule) } });
    });
    (Array.isArray(p.routes) ? p.routes : []).slice(0, 15).forEach(r => {
        if (str(r && r.from)) out.push({ kind: 'routes', label: 'Route', value: str(r.from) + ' → ' + str(r.to), routes: [{ from: str(r.from), to: str(r.to) }] });
    });
    (Array.isArray(p.notes) ? p.notes : []).slice(0, 10).forEach(n => { if (str(n)) out.push({ kind: 'note', label: 'Note', value: str(n) }); });
    return out;
}

module.exports = {
    ROLES,
    sanitizePartner,
    mergePartner,
    findByEmail,
    allEmails,
    bumpUsage,
    companyFromEmail,
    changeEntry,
    pushChange,
    diffLines,
    undoChange,
    sanitizePendingItem,
    extractionPrompt,
    findsFromExtraction,
    _test: { normalizeRole, sanitizePerson, sanitizePeople, stubPartner, splitTradeWord, isEmail },
};
