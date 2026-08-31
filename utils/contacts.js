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
    // Never CREATE a card with nothing on it. Editing an existing one down to nothing is the
    // owner's business, but a blank new row is only ever an accident — a stray "+ Add partner"
    // press, or a client that saved before anything was typed.
    if (idx === -1) {
        if (partnerIsEmpty(wanted)) return { contacts, partner: null, conflict: null, empty: true };
        return settle(wanted, -1);
    }
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

/** No firm name and nobody you could reach — there is nothing here to keep. */
function partnerIsEmpty(p) {
    if (str(p && p.company)) return false;
    const people = (p && Array.isArray(p.people)) ? p.people : [];
    return !people.some(c => str(c && c.name)
        || ((c && c.phones) || []).some(x => str(x && x.v))
        || ((c && c.emails) || []).some(x => str(x && x.v)));
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
    diffRole(out, b, now, !before);
    if (num(b.moq, 0) !== num(now.moq, 0)) out.push({ label: 'Overall MOQ', from: num(b.moq, 0) + ' T', to: num(now.moq, 0) + ' T' });
    diffList(out, 'Pipe types', (b.types || []).join(', '), (now.types || []).join(', '));
    diffProducts(out, b, now);
    diffPeople(out, b, now);
    diffAdditions(out, b, now);
    return out;
}

/**
 * Whether they are a dealer or a transporter decides which list they appear in, so it belongs
 * on the approval screen. Shown for a brand-new card even when it fell back to "dealer" — the
 * owner should see the guess before it becomes a fact, not discover it in the rankings.
 */
function diffRole(out, b, now, isNew) {
    if (!isNew && (!str(b.role) || str(b.role) === str(now.role))) return;
    if (isNew && !str(now.role)) return;
    out.push({ label: 'They are a', from: str(b.role), to: str(now.role) });
}

/**
 * People, phones and addresses — the commonest thing anyone adds, and for a long time the
 * one thing this list said nothing about. A blank "what would change" screen is worse than
 * no screen: the owner is being asked to approve something they cannot see.
 */
function diffPeople(out, b, now) {
    const held = {};
    (b.people || []).forEach(c => { held[personKey(c)] = c; });
    (now.people || []).forEach(c => {
        const had = held[personKey(c)];
        if (!had) {
            if (personLine(c)) out.push({ label: 'Contact added', from: '', to: personLine(c) });
            return;
        }
        diffLinesOf(out, 'Phone added', had.phones, c.phones, c);
        diffLinesOf(out, 'Address added', had.emails, c.emails, c);
    });
}

function personKey(c) { return lower((c && c.name) || '') || '(no name)'; }

/**
 * Empty when there is no actual person here. Every card carries a placeholder row whose only
 * content is the words "Main contact" — reporting that as a contact added would put a line on
 * the approval screen for a card that says nothing at all.
 */
function personLine(c) {
    const reach = [];
    ((c && c.phones) || []).forEach(x => { if (str(x.v)) reach.push(str(x.v)); });
    ((c && c.emails) || []).forEach(x => { if (str(x.v)) reach.push(str(x.v)); });
    if (!str(c && c.name) && !reach.length) return '';
    const bits = [str(c && c.name) || '(no name)'];
    if (str(c && c.role)) bits.push(str(c.role));
    return bits.concat(reach).join(' · ');
}

function diffLinesOf(out, label, hadList, nowList, person) {
    const had = (hadList || []).map(x => lower(x.v));
    (nowList || []).forEach(x => {
        if (!str(x.v) || had.indexOf(lower(x.v)) !== -1) return;
        out.push({ label, from: '', to: str(x.v) + ' — ' + (str(person && person.name) || 'no name') });
    });
}

function diffList(out, label, a, bVal) { if (a !== bVal) out.push({ label, from: a, to: bVal }); }

function diffProducts(out, b, now) {
    // "min 0 T" is a guessed number wearing a fact's clothes: zero is what we store when
    // nobody said what the minimum is, and a pipe trader reads it as "no minimum order".
    // Say we do not know instead (CLAUDE.md check #5).
    const line = y => (num(y.moq, 0) > 0 ? 'min ' + num(y.moq, 0) + ' T' : 'no minimum given')
        + (y.rule ? ' · ' + y.rule : '');
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

// ── the Add tab: added by hand, outside the Gmail label ─────────────────────

/**
 * The firms the model is allowed to match against — id, name, city, pipe types.
 *
 * Every card goes in, never a slice of them. A firm left out of this list is a firm the model
 * reports as brand new, and the owner ends up with a second card for a partner they already
 * have — the exact duplicate the whole directory is built to prevent. A longer prompt is the
 * cheaper mistake.
 */
function firmsForPrompt(contacts) {
    return (Array.isArray(contacts) ? contacts : [])
        .filter(p => p && str(p.id))
        .map(p => ({
            id: str(p.id), company: str(p.company), city: str(p.city),
            types: (p.types || []).join(', '),
        }));
}

function firmLines(firms) {
    if (!firms.length) return '(the directory is empty — anything you read is a new firm)';
    return firms.map(f => f.id + ' | ' + (f.company || '(no name yet)')
        + (f.city ? ' | ' + f.city : '') + (f.types ? ' | ' + f.types : '')).join('\n');
}

const ADD_JSON_SHAPE = '{"mode":"new|update|unsure","matchId":"","questions":[],"candidates":[],'
    + '"company":"","role":"dealer|manufacturer|transporter|fabricator|other","city":"",'
    + '"types":"comma list of GI/ERW/Seamless/SS/MS/Alloy","person":"","phone":"","email":"",'
    + '"products":[{"p":"","spec":"","moq":0,"rule":""}],"routes":[{"from":"","to":""}],'
    + '"notes":["short facts worth keeping"],"read":""}';

const ADD_RULES = [
    'Never guess. Leave EMPTY anything you are not sure of, and never invent a number — not a price, a size, a minimum order or a phone number.',
    'Fill ONLY the fields the text actually talks about. Every other field stays empty. If the text does not say what kind of firm they are, leave "role" EMPTY — do not work it out from what they sell.',
    'A pipe, a size or a class the firm sells or stocks is a PRODUCT. Put it in "products", never in "notes". "24 inch pipes", "2 inch heavy GI", "sch 40 seamless" are all products.',
    '"types" is only the broad family — GI, ERW, Seamless, SS, MS, Alloy — and only when the text names one. Do not work the family out from a size.',
    'A person is "person", their number is "phone", their address is "email". One person per read.',
    '"notes" is the LAST resort: only for something that fits none of the other fields, such as a credit term or a delivery habit. If it is a product, a person, a number, a place or a route, it belongs in that field and NOT in notes.',
    'Never repeat in "notes" something you have already put in another field.',
    'Answer "update" ONLY when the text clearly names one firm in the list above. Copy that firm\'s id exactly into matchId.',
    'If it could be two of those firms, or you cannot tell whether it is one of them at all, answer "unsure": leave matchId empty, put the ids of the firms it might be in candidates, and put a short question in questions.',
    'Answer "new" only when the firm is plainly not in the list above. Leave matchId empty.',
    'Questions must be plain English a pipe trader can answer in one line. No jargon, no ids, no field names.',
    '"read" is ONE short plain-English sentence saying what you understood, for a reader who is not technical. Example: "MSL already in your directory - adding 24 inch to their product range."',
    'Return the JSON and nothing else.',
];

/**
 * Worked examples, because the rules alone were not enough. Live, "MSL now has 24 inch pipes
 * also" came back as a NOTE plus an invented role change — the one sentence the owner is most
 * likely to type, filed in the one place it does not belong.
 */
const ADD_EXAMPLES = [
    ['MSL now has 24 inch pipes also',
        '{"mode":"update","matchId":"<MSL id>","products":[{"p":"24 inch pipes","spec":"","moq":0,"rule":""}],'
        + '"notes":[],"read":"MSL already in your directory - adding 24 inch pipes to their range."}'],
    ['new number for Ravi at Sri Balaji - 98400 12345',
        '{"mode":"update","matchId":"<Sri Balaji id>","person":"Ravi","phone":"98400 12345",'
        + '"notes":[],"read":"Adding a number for Ravi at Sri Balaji."}'],
    ['Kumar has joined MSL, kumar@msl.com, he handles sales',
        '{"mode":"update","matchId":"<MSL id>","person":"Kumar","email":"kumar@msl.com",'
        + '"notes":[],"read":"Adding Kumar at MSL."}'],
    ['Sri Balaji Steels, Coimbatore, they run lorries to Chennai, Ravi 98400 12345',
        '{"mode":"new","company":"Sri Balaji Steels","city":"Coimbatore","role":"transporter",'
        + '"person":"Ravi","phone":"98400 12345","routes":[{"from":"Coimbatore","to":"Chennai"}],'
        + '"notes":[],"read":"Adding Sri Balaji Steels of Coimbatore as a new transporter."}'],
    ['MSL want payment in 30 days now',
        '{"mode":"update","matchId":"<MSL id>","notes":["Payment in 30 days"],'
        + '"read":"Noting MSL\'s payment terms."}'],
];

function addExampleBlock() {
    return ADD_EXAMPLES.map(([said, json]) =>
        'Owner types: ' + said + '\nYou return: ' + json).join('\n\n');
}

function addPrompt({ text, fileName, firms }) {
    return 'A pipe dealership is adding a trade partner to its own directory by hand.\n'
        + 'Read what the owner gave you below (and any attached file) and decide whether it is a\n'
        + 'NEW firm, an UPDATE to a firm they already hold, or whether you cannot tell.\n\n'
        + 'FIRMS ALREADY IN THE DIRECTORY (id | company | city | pipe types):\n'
        + firmLines(Array.isArray(firms) ? firms : []) + '\n\n'
        + 'Return STRICT JSON only, in exactly this shape:\n' + ADD_JSON_SHAPE + '\n\n'
        + 'Rules:\n' + ADD_RULES.map(r => '- ' + r).join('\n') + '\n\n'
        + 'Examples (note how little is filled in — every untouched field stays empty):\n\n'
        + addExampleBlock() + '\n\n'
        + (str(fileName) ? 'Attached file: ' + str(fileName) + '\n\n' : '')
        + 'What the owner typed or pasted:\n' + str(text);
}

const ADD_DEFAULT_QUESTION = 'Is this a firm you already have, or a new one? '
    + 'Tell me which firm it is and I will read it again.';

/**
 * Which firm the model actually landed on — checked against the real directory, never taken
 * on trust.
 *
 * A model answering "update" with an id the directory does not hold would otherwise sail
 * through as a new card for a firm the owner already has. An id we cannot vouch for becomes
 * a question instead, which is the honest answer.
 */
/**
 * Drop anything the typed text does not actually support.
 *
 * The prompt is the first line and the model still steps over it: "MSL now has 24 inch pipes"
 * came back proposing the firm was a DEALER, about a card that says transporter — from a
 * sentence that says nothing about what they are. A value the owner never wrote is a guess,
 * and a guess must not reach a card that already holds the truth.
 *
 * Only applied to TYPED text. When a file was attached the words are inside it, so there is
 * nothing here to check against and the popup is what stands guard instead.
 */
// Stems, not whole words: the owner writes "lorries", "traders", "mills", "hauls".
const ROLE_WORDS = /manufact|mill|plant|transport|lorr|truck|haul|freight|logistic|cargo|roadline|carrier|fabricat|deal|stockist|trad|suppl|distribut|fleet/i;

function groundInText(parsed, text, hasFile) {
    const p = Object.assign({}, (parsed && typeof parsed === 'object') ? parsed : {});
    if (hasFile || !str(text)) return p;
    const hay = lower(text).replace(/[^a-z0-9 ]+/g, ' ');
    const says = v => {
        const want = lower(v).replace(/[^a-z0-9 ]+/g, ' ').trim();
        return !want || hay.indexOf(want) !== -1;
    };
    if (str(p.role) && !ROLE_WORDS.test(text)) p.role = '';
    ['company', 'city', 'vehicles'].forEach(k => { if (str(p[k]) && !says(p[k])) p[k] = ''; });
    return p;
}

/**
 * The words that could be a firm's name on a card — its own name, and for an imported card
 * whose only name is an address, the part before the @. Domain words carry no identity.
 */
const MAIL_NOISE = { yahoo: 1, gmail: 1, hotmail: 1, outlook: 1, rediffmail: 1, com: 1, co: 1, in: 1, net: 1, org: 1 };
function firmNameTokens(company) {
    const name = str(company);
    const base = name.indexOf('@') === -1 ? name : name.split('@')[0];
    return firmNameKey(base).split(' ')
        .filter(t => t.length >= 3 && !MAIL_NOISE[t]);
}

/**
 * Does the owner's own text point at THIS card?
 *
 * Reported live: "add 24 inch to msl" proposed updating adarshroadcarriers@yahoo.com. The
 * model answered "update" with a real id and no company name at all, so the name check had
 * nothing to compare and waved it through. A matching id is not evidence — the owner's words
 * have to point at the card, or we ask.
 */
function textPointsAtFirm(text, company) {
    const hay = ' ' + lower(text).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const tokens = firmNameTokens(company);
    if (!tokens.length) return true;            // a card with no usable name cannot disagree
    return tokens.some(t => hay.indexOf(' ' + t + ' ') !== -1
        || hay.replace(/ /g, '').indexOf(t) !== -1);
}

function addDraftMode(parsed, firms, settledId, text) {
    const p = (parsed && typeof parsed === 'object') ? parsed : {};
    const list = (Array.isArray(firms) ? firms : []).filter(f => f && str(f.id));
    // The owner has already told us which firm this is by pressing its name. That settles it
    // — asking the model again, or re-checking the name it guessed, can only unsettle it.
    const settled = str(settledId) ? list.find(f => f.id === str(settledId)) : null;
    if (settled) return { mode: 'update', matchId: settled.id, questions: [], candidates: [] };
    const match = list.find(f => f.id === str(p.matchId)) || null;
    const mode = lower(p.mode);
    const named = str(p.company);
    // The model will happily answer "update" pointing at whichever card is nearest, even when
    // the firm in the text is not in the directory at all. Seen live: "MSL now has 24 inch
    // pipes" came back as an update to ARC LIMITED, renaming it. The id existing is not
    // evidence it is the right firm — the NAME has to agree, or we ask instead of guessing.
    if (mode === 'update' && match && named && !sameFirmName(named, match.company)) {
        return {
            mode: 'unsure', matchId: '',
            questions: ['You wrote “' + named + '”, but the closest card I have is “'
                + str(match.company) + '”. Is this the same firm, or one you have not added yet?'],
            candidates: addCandidates([match.company].concat(p.candidates || []), list),
        };
    }
    // The same guard, for when the model names no firm at all — which is when it went wrong.
    if (mode === 'update' && match && str(text) && !textPointsAtFirm(text, match.company)) {
        return {
            mode: 'unsure', matchId: '',
            questions: ['Which firm is that about? Nothing in your directory matches the name you wrote — '
                + 'the closest is “' + str(match.company) + '”.'],
            candidates: addCandidates([match.company].concat(p.candidates || []), list),
        };
    }
    if (mode === 'update' && match) return { mode: 'update', matchId: match.id, questions: [], candidates: [] };
    if (mode === 'new' && !match) return { mode: 'new', matchId: '', questions: [], candidates: [] };
    const asked = sanitizeStrings(p.questions, 5).map(q => q.slice(0, 300));
    return {
        mode: 'unsure',
        matchId: match ? match.id : '',
        questions: asked.length ? asked : [ADD_DEFAULT_QUESTION],
        candidates: addCandidates(p.candidates, list),
    };
}

/**
 * Loose enough for the ways one firm gets written — "MSL" for "M S L Tubes", "Jco Pipe" for
 * "JCO PIPE PVT LTD" — and strict enough that two different firms never read as one. Trade
 * suffixes carry no identity, so they are dropped before comparing.
 */
const NAME_NOISE = /\b(pvt|private|ltd|limited|llp|inc|co|company|and|the|&)\b/g;
function firmNameKey(name) {
    return lower(name).replace(/[^a-z0-9 ]+/g, ' ').replace(NAME_NOISE, ' ')
        .replace(/\s+/g, ' ').trim();
}
function sameFirmName(a, b) {
    const x = firmNameKey(a), y = firmNameKey(b);
    if (!x || !y) return true;              // nothing to disagree about
    if (x === y) return true;
    const squashed = s => s.replace(/ /g, '');
    return squashed(x).indexOf(squashed(y)) === 0 || squashed(y).indexOf(squashed(x)) === 0;
}

/** Only firms that really exist — a made-up name in `candidates` is dropped, not shown. */
function addCandidates(raw, firms) {
    const out = [];
    (Array.isArray(raw) ? raw : []).slice(0, 8).forEach(c => {
        const key = lower(c && typeof c === 'object' ? (c.id || c.company) : c);
        const hit = key && firms.find(f => lower(f.id) === key || (f.company && lower(f.company) === key));
        if (hit && !out.some(o => o.id === hit.id)) out.push({ id: hit.id, company: str(hit.company) });
    });
    return out;
}

/**
 * The card as it WOULD look: the BEFORE card with what was read written onto it. Pure.
 *
 * Additive on purpose. A blank the model left never erases something stored, and pipe types,
 * branches, routes, products and notes are ADDED to what is there. The owner said "MSL now
 * has 24 inch also" — they are adding to a card, not retyping it. Taking something away is
 * done in the Directory tab, where they can see what they are taking away.
 */
function addAfterCard(parsed, before, source) {
    return applyAddSteps(before, addSteps(parsed), source);
}

/**
 * One reading broken into the separate things it would do, so the owner can keep some and
 * drop others rather than taking the whole lot or none of it.
 *
 * The person step stays whole on purpose: a name, a number and an address read off one
 * letterhead are one fact, and letting the number in while refusing the name it belongs to
 * would put a loose number on the card.
 */
function addSteps(parsed) {
    const steps = findsFromExtraction(parsed)
        .filter(x => !(x.kind === 'field' && ['person', 'phone', 'email'].indexOf(x.key) !== -1))
        .map((x, i) => Object.assign({ id: 's' + i }, x));
    const p = (parsed && typeof parsed === 'object') ? parsed : {};
    if (str(p.person) || str(p.phone) || str(p.email)) {
        steps.push({
            id: 'person', kind: 'person',
            person: str(p.person), phone: str(p.phone), email: str(p.email),
        });
    }
    return steps;
}

function applyAddSteps(before, steps, source) {
    const card = before ? JSON.parse(JSON.stringify(before)) : {};
    const src = str(source) || 'added by hand';
    (Array.isArray(steps) ? steps : []).forEach(s => {
        if (s && s.kind === 'person') addPersonInto(card, s);
        else applyAddFind(card, s, src);
    });
    return sanitizePartner(card);
}

/**
 * What each step would change, on its own. Applied one at a time against the card as it
 * stands after the steps before it, so the list reads in the order the owner will see it and
 * a step that turns out to change nothing is dropped rather than shown as an empty tick-box.
 */
function addChangeList(before, steps, source) {
    const src = str(source) || 'added by hand';
    let card = sanitizePartner(before ? JSON.parse(JSON.stringify(before)) : {});
    const out = [];
    (Array.isArray(steps) ? steps : []).forEach(s => {
        const next = applyAddSteps(card, [s], src);
        const lines = diffLines(card, next);
        if (lines.length) { out.push({ id: str(s.id), lines, step: s }); card = next; }
    });
    return out;
}

function applyAddFind(card, x, src) {
    if (x.kind === 'product') return mergeProductInto(card, x.product);
    if (x.kind === 'routes') return mergeRoutesInto(card, x.routes);
    if (x.kind === 'note') return addNoteInto(card, x.value, src);
    if (x.kind !== 'field') return;
    // A name, a number and an address read off one letterhead belong on ONE person row, so
    // they are placed together by addPersonInto rather than scattered across three finds.
    if (['person', 'phone', 'email'].indexOf(x.key) !== -1) return;
    if (x.key === 'types') { card.types = mergeStrings(card.types, splitList(x.value)); return; }
    if (x.key === 'branches') { card.branches = mergeBranches(card.branches, splitList(x.value)); return; }
    // "other" is what we store when nobody knows what they are, so it is never news. Seen
    // live: a line about 24 inch pipes turned a known TRANSPORTER into "other", which would
    // have dropped them out of the freight list altogether.
    if (x.key === 'role' && normalizeRole(x.value) === 'other' && str(card.role)) return;
    card[x.key] = x.value;
}

function splitList(v) { return str(v).split(/[,;/]+/).map(str).filter(Boolean); }

function mergeStrings(existing, added) {
    const out = (Array.isArray(existing) ? existing : []).map(str).filter(Boolean);
    const seen = {};
    out.forEach(v => { seen[lower(v)] = true; });
    added.forEach(v => { if (!seen[lower(v)]) { seen[lower(v)] = true; out.push(v); } });
    return out;
}

function mergeBranches(existing, cities) {
    const out = (Array.isArray(existing) ? existing : []).slice();
    cities.forEach(city => {
        if (!out.some(b => lower(b && b.city) === lower(city))) out.push({ city, area: '', address: '' });
    });
    return out;
}

/** Fill a product in, never flatten it — a blank the model left keeps whatever is stored. */
function mergeProductInto(card, incoming) {
    const list = (card.products = Array.isArray(card.products) ? card.products : []);
    const at = list.findIndex(pr => pr && lower(pr.p) === lower(incoming.p));
    if (at === -1) { list.push(incoming); return; }
    const merged = Object.assign({}, list[at]);
    ['spec', 'rule'].forEach(k => { if (str(incoming[k])) merged[k] = incoming[k]; });
    if (num(incoming.moq, 0) > 0) merged.moq = num(incoming.moq, 0);
    if ((incoming.sizes || []).length) merged.sizes = incoming.sizes;
    list[at] = merged;
}

function mergeRoutesInto(card, routes) {
    const list = (card.routes = Array.isArray(card.routes) ? card.routes : []);
    (routes || []).forEach(r => {
        const same = e => lower(e && e.from) === lower(r.from) && lower(e && e.to) === lower(r.to);
        if (!list.some(same)) list.push({ from: str(r.from), to: str(r.to) });
    });
}

function addNoteInto(card, text, src) {
    const list = (card.notes = Array.isArray(card.notes) ? card.notes : []);
    // Reading the same brochure twice must not leave the same note on the card twice.
    if (list.some(n => n && str(n.t) === str(text))) return;
    list.unshift({ d: new Date().toISOString().slice(0, 10), t: str(text), src });
}

function addPersonInto(card, parsed) {
    const p = (parsed && typeof parsed === 'object') ? parsed : {};
    const name = str(p.person), phone = str(p.phone), email = lower(p.email);
    if (!name && !phone && !email) return;
    const people = (card.people = Array.isArray(card.people) ? card.people : []);
    const at = personIndexFor(people, name, email);
    const row = at === -1 ? { name: '', role: 'Main contact', phones: [], emails: [] } : people[at];
    // Never rename somebody already stored: an unfamiliar name is a NEW colleague at the firm,
    // not a correction, and overwriting is how a contact quietly disappears.
    if (name && !str(row.name)) row.name = name;
    if (phone) pushContactLines(row.phones = row.phones || [], 'Mobile', phone);
    if (email && isEmail(email)) pushContactLines(row.emails = row.emails || [], 'Work', email);
    if (at === -1) people.push(row);
}

function personIndexFor(people, name, email) {
    if (email) {
        const at = people.findIndex(c => ((c && c.emails) || []).some(e => lower(e && e.v) === email));
        if (at !== -1) return at;
    }
    if (name) return people.findIndex(c => c && lower(c.name) === lower(name));
    // A number or an address with nobody named belongs to the main contact.
    return people.length ? 0 : -1;
}

function pushContactLines(list, label, value) {
    splitList(value).forEach(v => {
        if (!list.some(e => lower(e && e.v) === lower(v))) list.push({ label, v });
    });
}

module.exports = {
    ROLES,
    sanitizePartner,
    mergePartner,
    partnerIsEmpty,
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
    firmsForPrompt,
    addPrompt,
    groundInText,
    addSteps,
    applyAddSteps,
    addChangeList,
    addDraftMode,
    addAfterCard,
    _test: { normalizeRole, sanitizePerson, sanitizePeople, splitTradeWord, isEmail,
        firmKeyOf, firmsAlreadyKnown, groupSeedsIntoFirms, seedFromSuggestionFiles, importPendingItem,
        emailConflict,
        addCandidates, applyAddFind, mergeStrings, mergeBranches, mergeProductInto,
        mergeRoutesInto, addNoteInto, addPersonInto, personIndexFor, splitList, firmLines,
        sameFirmName, firmNameKey, diffPeople, personLine, addExampleBlock },
};
