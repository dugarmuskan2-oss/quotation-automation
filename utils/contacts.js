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
// Room for a whole import to wait for approval at once — the old cap of 50 would have
// silently dropped the tail of a 24-firm import behind whatever was already queued.
const MAX_PENDING = 300;

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

// A partner id must be unique even when a whole import is created inside one millisecond —
// a timestamp alone is not, and duplicate ids make every partner sharing one impossible to
// edit or delete on its own (they merge into, and delete with, each other).
let idCounter = 0;
function newPartnerId() {
    idCounter = (idCounter + 1) % 1e6;
    return 'p_' + Date.now().toString(36) + '_' + idCounter.toString(36)
        + Math.random().toString(36).slice(2, 7);
}

function sanitizePartner(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const now = new Date().toISOString();
    return {
        id: str(src.id) || newPartnerId(),
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

/**
 * Merge one partner into the list by id (never a whole-list overwrite).
 *
 * With `fields` given, only those keys are taken from the incoming copy and the rest of the
 * stored record is kept. That is what stops a second tab — holding a copy loaded minutes ago
 * — from replacing a colleague's edit to a different part of the same firm.
 */
function mergePartner(list, incoming, fields) {
    const contacts = (Array.isArray(list) ? list : []).slice(0, MAX_CONTACTS);
    const wanted = sanitizePartner(incoming);
    const idx = contacts.findIndex(c => c && c.id === wanted.id);
    const settle = (result, at) => {
        // ONE ADDRESS, ONE COMPANY — checked on the merged result, so every write path is
        // covered by the one guard. Refusing is the only honest answer: dropping the address
        // would lose what was typed without saying so, and letting it through is how a firm
        // ends up on two cards, asked twice, each copy telling a different story.
        const clash = emailConflict(contacts, result, at);
        if (clash) return { contacts, partner: contacts[at] || null, conflict: clash };
        if (at === -1) contacts.unshift(result); else contacts[at] = result;
        return { contacts: contacts.slice(0, MAX_CONTACTS), partner: result, conflict: null };
    };
    if (idx === -1) return settle(wanted, -1);
    // A full overwrite happens ONLY when the caller asked for one by passing no field list.
    // If a list was given but nothing in it is a real field — a typo, or a field renamed and
    // the caller not updated — the safe reading is "write nothing", never "write everything":
    // falling through to the wholesale branch there would let a stale copy replace a
    // colleague's work, which is the one thing this argument exists to prevent.
    if (!Array.isArray(fields)) return settle(wanted, idx);
    const only = fields.filter(f => typeof f === 'string' && f in wanted);
    const merged = Object.assign({}, contacts[idx]);
    only.forEach(f => { merged[f] = wanted[f]; });
    merged.checked = wanted.checked;           // any edit stamps last-edited
    return settle(merged, idx);
}

/**
 * The first address on `candidate` that another card already holds, or null.
 * `skipIndex` is the candidate's own place in the list, so a card never clashes with itself.
 */
function emailConflict(contacts, candidate, skipIndex) {
    const mine = allEmails(candidate);
    if (!mine.length) return null;
    for (let i = 0; i < contacts.length; i++) {
        if (i === skipIndex || !contacts[i]) continue;
        const theirs = allEmails(contacts[i]);
        const hit = mine.find(e => theirs.indexOf(e) !== -1);
        if (hit) return { email: hit, id: contacts[i].id, company: contacts[i].company };
    }
    return null;
}

/**
 * Every address the directory holds on more than one card. Empty is the healthy answer —
 * this exists so duplicates that pre-date the one-address-one-company rule can be found and
 * cleared, rather than sitting there splitting a firm's history in two.
 */
function duplicateEmails(contacts) {
    const seen = {}, clashes = {};
    (Array.isArray(contacts) ? contacts : []).forEach(p => {
        if (!p) return;
        uniqStrings(allEmails(p)).forEach(e => {
            if (seen[e]) (clashes[e] = clashes[e] || [seen[e]]).push(cardRef(p));
            else seen[e] = cardRef(p);
        });
    });
    return Object.keys(clashes).map(email => ({ email, cards: clashes[email] }));
}

function cardRef(p) { return { id: p.id, company: p.company }; }

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
    const contacts = (Array.isArray(list) ? list : []).slice();
    const unknown = [];
    sanitizeStrings(usage && usage.emails, 50).map(lower).filter(isEmail).forEach(email => {
        const idx = contacts.findIndex(c => allEmails(c).indexOf(email) !== -1);
        if (idx === -1) {
            // Nothing enters the directory unasked. An address we have not seen becomes an
            // item WAITING FOR APPROVAL (see pendingFromUsage), not a card that silently
            // appears. Our own address and test placeholders are dropped outright — copying
            // ourselves on an enquiry must never make the firm its own supplier.
            if (worthImporting(email)) unknown.push(email);
            return;
        }
        // Replace rather than write through: `list` holds the caller's objects, and a stale
        // copy of one being mutated in place is exactly the hazard the directory avoids.
        const target = Object.assign({}, contacts[idx]);
        if (reply) { target.rep = num(target.rep, 0) + 1; }
        else { target.enq = num(target.enq, 0) + 1; }
        target.last = now;
        contacts[idx] = target;
    });
    return { contacts: contacts.slice(0, MAX_CONTACTS), unknown };
}

/**
 * Which FIRMS the app already knows about — held on a card, or already waiting for approval.
 *
 * Keyed by firm, never by address. Keying on the exact address was the leak: an enquiry to
 * manish@jcopipe.com on Monday and cp@jcopipe.com on Tuesday left TWO cards to approve for
 * one mill, and a colleague at a firm already in the directory queued as a brand-new firm
 * that would sit beside the curated card once approved.
 */
function firmsAlreadyKnown(existing, queued) {
    const held = {}, inQueue = {};
    (Array.isArray(existing) ? existing : []).forEach(p => {
        allEmails(p).forEach(e => { held[firmKeyOf(e)] = p; });
    });
    (Array.isArray(queued) ? queued : []).forEach(item => {
        const mails = (item && item.preview) ? allEmails(item.preview) : [];
        if (item && item.from) mails.push(lower(item.from));
        mails.forEach(e => { if (e) inQueue[firmKeyOf(e)] = true; });
    });
    return { held, inQueue };
}

/**
 * Addresses an enquiry went to that the directory has never seen, queued for review.
 *
 * Grouped by firm on the way in, so emailing three people at one new mill offers ONE card
 * with three people on it — not three suppliers. A firm already in the queue is not queued
 * again however many enquiries go out to it, and a new colleague at a firm we already hold
 * is offered as an UPDATE to that card rather than as a second firm beside it.
 */
function pendingFromUsage(existing, queued, emails, usage) {
    const known = firmsAlreadyKnown(existing, queued);
    const firms = {};
    sanitizeStrings(emails, 50).map(lower).filter(isEmail).forEach(email => {
        if (!worthImporting(email) || findByEmail(existing, email)) return;
        const key = firmKeyOf(email);
        if (known.inQueue[key]) return;
        if (!firms[key]) {
            firms[key] = {
                key, emails: [], count: 0, last: '',
                match: known.held[key] || null,
                role: (usage && usage.role) || 'dealer',
                types: sanitizeStrings(usage && usage.pipeTypes, 6),
                routes: (usage && usage.pickup) ? [{ from: str(usage.pickup), to: str(usage.drop) }] : [],
            };
        }
        if (firms[key].emails.indexOf(email) === -1) firms[key].emails.push(email);
    });
    return Object.keys(firms).map(key => importPendingItem(firms[key], firms[key].emails, firms[key].match));
}

// ── importing the memory the app already built ───────────────────────────────

/**
 * Read the older auto-learned suggestion files into one draft per ADDRESS.
 *
 * freight-suggestions.json holds transporter addresses (global + per pickup/drop route);
 * supplier-suggestions.json holds supplier addresses bucketed by pipe type. Both carry a
 * usage `count` and `lastUsed` — real history worth keeping, so it seeds enq/last rather
 * than starting every partner at zero.
 */
function seedFromSuggestionFiles(freight, supplier) {
    const seed = {};

    const note = (email, patch) => {
        const key = lower(email);
        if (!key || !isEmail(key) || !worthImporting(key)) return null;
        if (!seed[key]) seed[key] = { email: key, count: 0, last: '', types: [], routes: [], role: 'dealer' };
        Object.assign(seed[key], patch, {
            count: Math.max(seed[key].count, num(patch.count, 0)),
            last: (patch.last && patch.last > seed[key].last) ? patch.last : seed[key].last,
            types: seed[key].types.concat(patch.types || []),
            routes: seed[key].routes.concat(patch.routes || []),
            // One address can sit in BOTH remembered files — a firm that hauls for us and also
            // sells pipe. A plain overwrite let the later 'dealer' patch bury 'transporter',
            // and the firm then never appeared in the transporter list at all.
            role: (seed[key].role === 'transporter' || patch.role === 'transporter')
                ? 'transporter' : (patch.role || seed[key].role),
        });
        return seed[key];
    };

    const f = (freight && typeof freight === 'object') ? freight : {};
    (f.transporters || []).forEach(t => note(t.email, { role: 'transporter', count: t.count, last: t.lastUsed }));
    (f.routes || []).forEach(r => (r.transporters || []).forEach(t => note(t.email, {
        role: 'transporter', count: t.count, last: t.lastUsed,
        routes: [{ from: str(r.pickup), to: str(r.drop) }],
    })));

    const s = (supplier && typeof supplier === 'object') ? supplier : {};
    (s.suppliers || []).forEach(t => note(t.email, { role: 'dealer', count: t.count, last: t.lastUsed }));
    Object.keys((s.byType) || {}).forEach(type => {
        ((s.byType[type]) || []).forEach(t => note(t.email, {
            role: 'dealer', count: t.count, last: t.lastUsed, types: [type.toUpperCase()],
        }));
    });
    return seed;
}

/**
 * Which FIRM an address belongs to.
 *
 * A business email domain IS the firm: manish@jcopipe.com and cp@jcopipe.com are two people
 * at Jco Pipe, not two suppliers. Importing them as separate partners broke the owner's rule
 * outright — the directory offered "Jindalhissar" four times, and sending would have put four
 * separate enquiries in front of four colleagues at one mill, none of them able to see the
 * others. One firm, one card, everyone Cc'd together.
 *
 * A free-mail address (gmail, yahoo, rediffmail…) says nothing about the firm, so each one
 * stays on its own card. Two of those may well be the same firm — but nothing in the address
 * proves it, and guessing would merge two unrelated people into one supplier.
 */
function firmKeyOf(email) {
    const domain = lower(email).split('@')[1] || '';
    const label = domain.split('.')[0] || '';
    return (label && !FREE_MAIL.test(label)) ? 'd:' + domain : 'e:' + lower(email);
}

function groupSeedsIntoFirms(seed) {
    const firms = {};
    Object.keys(seed).forEach(email => {
        const key = firmKeyOf(email);
        const d = seed[email];
        if (!firms[key]) firms[key] = { key, emails: [], role: 'dealer', count: 0, last: '', types: [], routes: [] };
        const firm = firms[key];
        firm.emails.push(email);
        firm.count = Math.max(firm.count, num(d.count, 0));
        if (d.last && d.last > firm.last) firm.last = d.last;
        firm.types = firm.types.concat(d.types || []);
        firm.routes = firm.routes.concat(d.routes || []);
        // Used as a transporter even once and it is a transporter — that is the role that
        // changes which list a firm appears in, so it must not be lost to a later 'dealer'.
        if (d.role === 'transporter') firm.role = 'transporter';
    });
    return firms;
}

function uniqStrings(list) {
    return (list || []).filter((v, i) => list.indexOf(v) === i);
}

/**
 * Turn the remembered addresses into items WAITING FOR APPROVAL — never into partners.
 *
 * Nothing reaches the directory without the owner saying yes, so the import queues one
 * reviewable draft per firm alongside the ones arriving from the Gmail label. Approving is
 * the only write path, exactly as it is for a labelled brochure.
 *
 * A firm whose addresses are ALL already in the directory is skipped. A firm with some new
 * and some known addresses is proposed as an UPDATE to the card that already exists, so the
 * curated card gains the missing person instead of a duplicate appearing beside it.
 */
function pendingFromSuggestions(existing, freight, supplier) {
    const firms = groupSeedsIntoFirms(seedFromSuggestionFiles(freight, supplier));
    const items = [];
    let skippedFirms = 0, skippedAddresses = 0;

    Object.keys(firms).forEach(key => {
        const firm = firms[key];
        const fresh = firm.emails.filter(e => !findByEmail(existing, e));
        skippedAddresses += firm.emails.length - fresh.length;
        if (!fresh.length) { skippedFirms++; return; }
        const match = firm.emails.map(e => findByEmail(existing, e)).find(Boolean) || null;
        items.push(importPendingItem(firm, fresh, match));
    });
    return { items, queued: items.length, skippedFirms, skippedAddresses };
}

/**
 * Drop proposals for addresses already sitting in the queue. Pressing Import twice, or
 * sending a second enquiry to the same new firm, must not stack up the same card to approve
 * over and over.
 */
function dropAlreadyQueued(queued, proposed) {
    const inQueue = firmsAlreadyKnown([], queued).inQueue;
    return (Array.isArray(proposed) ? proposed : []).filter(item => {
        // By FIRM, not by address, and across every address on the draft: a brochure already
        // queued from billing@ must block the whole firm, not just that one person.
        const mine = item.preview ? allEmails(item.preview) : [];
        if (item.from) mine.push(lower(item.from));
        return !mine.some(e => inQueue[firmKeyOf(e)]);
    });
}

let pendingCounter = 0;
function newPendingId() {
    pendingCounter = (pendingCounter + 1) % 1e6;
    return 'pd_' + Date.now().toString(36) + '_' + pendingCounter.toString(36)
        + Math.random().toString(36).slice(2, 7);
}

function importPendingItem(firm, fresh, match) {
    const id = newPendingId();
    const company = (match && match.company) || companyFromEmail(fresh[0]) || fresh[0];
    const people = fresh.map((email, i) => ({
        name: '', role: i === 0 && !match ? 'Main contact' : '',
        phones: [], emails: [{ label: 'Work', v: email }],
    }));
    // Built here rather than on the client: a firm carries several addresses, and the client's
    // preview builder only knows how to place the ONE address a labelled email arrives from.
    const preview = sanitizePartner(match
        ? Object.assign({}, match, { people: (match.people || []).concat(people) })
        : {
            role: firm.role, company,
            people,
            types: uniqStrings(firm.types),
            routes: dedupeRoutes(firm.routes),
            fromEnquiry: true,
            enq: firm.count,
            last: firm.last ? String(firm.last).slice(0, 10) : '',
        });
    preview.id = 'p_new_' + id;
    if (match) preview.matchId = match.id;

    return {
        id,
        origin: 'import',
        from: fresh[0],
        subject: company,
        file: '', kind: 'photo', text: '',
        finds: fresh.map(email => ({ kind: 'field', key: 'email', label: 'Address you have used', value: email })),
        receivedAt: new Date().toISOString(),
        preview,
    };
}

/**
 * Two kinds of address sit in the remembered files that must NOT become partners:
 * our own (it lands there whenever an enquiry is copied to ourselves — importing it makes
 * the firm appear to be its own supplier), and the example.com placeholders left by testing.
 * OWN_EMAIL_DOMAINS is read from the env so the owner's domain is never hard-coded here.
 */
function worthImporting(email) {
    if (/@example\.(com|org|net)$/i.test(email)) return false;
    const own = String(process.env.OWN_EMAIL_DOMAINS || 'dscpipes.com')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const domain = email.split('@')[1] || '';
    return own.indexOf(domain) === -1;
}

function dedupeRoutes(routes) {
    const seen = {}, out = [];
    (routes || []).forEach(r => {
        const k = lower(r.from) + '|' + lower(r.to);
        if (!r.from || seen[k]) return;
        seen[k] = true; out.push(r);
    });
    return out;
}

// ── the change log: what the app did on its own, with enough to undo it ──────

// Undo finds a change by its id, so two changes sharing one means pressing undo restores
// the wrong partner. A batch of entries can easily be logged inside a single millisecond,
// so the id carries a counter as well as the clock — same reason as newPartnerId.
let changeCounter = 0;
function newChangeId() {
    changeCounter = (changeCounter + 1) % 1e6;
    return 'ch_' + Date.now().toString(36) + '_' + changeCounter.toString(36)
        + Math.random().toString(36).slice(2, 7);
}

function changeEntry(title, detail, source, partnerId, before, after) {
    return {
        id: newChangeId(),
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
        id: str(src.id) || newPendingId(),
        // 'import' items come from the addresses the app already remembered, and carry a
        // ready-made preview holding every person at the firm. 'gmail' items are built from
        // `finds` on the client, one address at a time.
        origin: str(src.origin) === 'import' ? 'import' : 'gmail',
        preview: (src.preview && typeof src.preview === 'object') ? src.preview : null,
        from: lower(src.from),
        subject: str(src.subject).slice(0, 300),
        file: str(src.file).slice(0, 200),
        kind: /pdf/i.test(str(src.kind) || str(src.file)) ? 'pdf' : 'photo',
        text: str(src.text).slice(0, 20000),
        // The attachment itself, so a brochure can actually be read. Kept out of the stored
        // queue item (see routes/contacts.js) — it is only needed during extraction.
        fileBase64: str(src.fileBase64),
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
    duplicateEmails,
    findByEmail,
    allEmails,
    bumpUsage,
    pendingFromSuggestions,
    pendingFromUsage,
    dropAlreadyQueued,
    MAX_PENDING,
    companyFromEmail,
    changeEntry,
    pushChange,
    diffLines,
    undoChange,
    sanitizePendingItem,
    extractionPrompt,
    findsFromExtraction,
    _test: { normalizeRole, sanitizePerson, sanitizePeople, splitTradeWord, isEmail,
        firmKeyOf, firmsAlreadyKnown, groupSeedsIntoFirms, seedFromSuggestionFiles, importPendingItem,
        emailConflict },
};
