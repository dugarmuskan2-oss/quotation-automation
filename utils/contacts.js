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

// The second setup (m@dscpipes.com) reads this SAME directory — one file, not a copy — but only
// sees these two roles. Dealer, manufacturer and fabricator stay the main site's alone. Kept as
// its own list rather than "everything except dealer/manufacturer" so a THIRD role added later
// defaults to hidden, not shared — sharing has to be an explicit choice, never an accident of
// what a new role happens to be called.
const SHARED_ROLES = ['transporter', 'other'];

/** The subset of the directory a read-only deployment may see. */
function visibleToReadonly(contacts) {
    return (Array.isArray(contacts) ? contacts : []).filter((p) => p && SHARED_ROLES.indexOf(p.role) !== -1);
}
const MAX_CONTACTS = 2000;
const MAX_CHANGES = 200;
// Room for a whole import to wait for approval at once — the old cap of 50 would have
// silently dropped the tail of a 24-firm import behind whatever was already queued.
const MAX_PENDING = 300;

function str(v) { return String(v == null ? '' : v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

/**
 * The trade a piece of text points at, or BLANK when it points at nothing.
 *
 * normalizeRole below answers 'other' when it cannot tell, which is a real choice the owner
 * might make and so cannot be told apart from nobody having chosen. For a suggestion that
 * distinction is the whole point: the card shows a guess he can accept or change, and a guess
 * of "other" on 1,700 cards is worse than leaving them blank.
 */
function suggestRole(text) {
    const s = lower(text);
    if (!s) return '';
    if (/transport|lorry|truck|freight|logistic|cargo|roadline|carrier|hauli/.test(s)) return 'transporter';
    if (/fabricat/.test(s)) return 'fabricator';
    if (/manufact|\bmill\b|\bplant\b|factory|works\b/.test(s)) return 'manufacturer';
    if (/dealer|stockist|trader|supplier|distribut|agenc/.test(s)) return 'dealer';
    return '';
}

function normalizeRole(v) {
    const s = lower(v);
    if (ROLES.indexOf(s) !== -1) return s;
    if (/manufact|mill|plant/.test(s)) return 'manufacturer';
    if (/transport|lorry|truck|freight|logistic|cargo|roadline|carrier/.test(s)) return 'transporter';
    if (/fabricat/.test(s)) return 'fabricator';
    if (/dealer|stockist|trader|supplier|distribut/.test(s)) return 'dealer';
    return 'other';
}

/**
 * An address as it should be STORED and COMPARED — one spelling, always.
 *
 * Two cards for Bombay Hardware sat in the queue looking identical, and the only difference
 * was a ">" on the end of one address: "bhplsales@bombayhardware.com>", left behind when a
 * "Name <addr>" header was pulled apart. Nothing cleaned it and nothing rejected it, so it
 * became its own firm — "d:bombayhardware.com>" — and every duplicate guard in the app
 * compares strings, so every one of them missed it.
 *
 * Six addresses are stored dirty today: a stray ">", quoted local parts from ISMT
 * ("rmache"@ismt.co.in), a typed label ("e-mail: info@mantoengg.com"), and a comma where a
 * dot belongs (rohit,jaiswal@stecol.co.in). The comma is NOT repaired — that is a guess about
 * what he meant, and a wrong address is worse than a rejected one. Only wrappers come off.
 */
function cleanEmail(v) {
    let s = str(v).trim();
    // "Firm Name <sales@x.com>" — keep what is inside the brackets, drop the rest.
    const inBrackets = s.match(/<([^<>]+)>/);
    if (inBrackets) s = inBrackets[1];
    return s
        .replace(/^(?:e-?mail|mail|id)\s*[:\-]\s*/i, '')   // "e-mail: info@x.com"
        .replace(/^mailto:/i, '')
        .replace(/[<>\s]/g, '')                            // a lone bracket, any space
        .replace(/^["'`]+|["'`]+$/g, '')                    // "ajay.maske"@ismt.co.in
        .replace(/["'`]/g, '')
        .replace(/[.,;:]+$/, '')                            // trailing punctuation
        .toLowerCase();
}

/**
 * The domain half must end in a real top-level domain, so "com>" is not an address.
 * The old test allowed any trailing character, which is exactly how the ">" got in.
 */
function isEmail(v) { return /^[a-z0-9._%+\-&']+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(cleanEmail(v)); }

/**
 * The app's own spelling for a pipe type.
 *
 * The remembered supplier file buckets by 'gi' / 'erw' / 'seamless', and the owner types
 * "seamless" as often as "Seamless". Shouting it back put SEAMLESS on the card while the
 * chips the browser offers say Seamless — and its duplicate check reads the letters, so the
 * same type landed on one card twice.
 */
const PIPE_TYPE_NAMES = ['GI', 'ERW', 'Seamless', 'SS', 'MS', 'Alloy'];
function canonicalPipeType(v) {
    return PIPE_TYPE_NAMES.find(t => lower(t) === lower(v)) || str(v);
}

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
        // Which branch this person sits at. Jindal Saw has 53 people across seven places —
        // Chennai office, Bombay office, Delhi office, Nasik factory and three plants — and
        // with one flat list there was nowhere to put that, so the reading stuffed it into
        // the job title: "HEAD - DOMESTIC SALES (SEAMLESS DIVISION), for CS pipe (Bombay
        // office)". A job, a product and a place in one box, and no way to ring the right one.
        branch: str(p && p.branch),
        phones: sanitizeLines(p && p.phones),
        // Cleaned BEFORE it is stored, so the value on the card and the value every guard
        // compares are the same string. Anything still not an address is dropped, not kept
        // in a shape that quietly defeats the duplicate checks.
        emails: sanitizeLines(p && p.emails)
            .map(e => ({ label: e.label, v: cleanEmail(e.v) }))
            .filter(e => isEmail(e.v)),
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
    // Cleaned on READ as well as on write: six addresses were stored before there was a
    // cleaner, and they must still collapse onto their clean twins rather than sit beside
    // them as a second firm forever.
    (partner.people || []).forEach(p => (p.emails || []).forEach(e => {
        const v = cleanEmail(e.v);
        if (v) out.push(v);
    }));
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
            make: str(pr && pr.make),
            sizes: sanitizeSizes(pr && pr.sizes),
            moq: num(pr && pr.moq, 0), rule: str(pr && pr.rule),
        }))
        // A row holding only a make is still worth keeping — "they stock Jindal" is a real
        // thing to have written down, and dropping it would lose what was just typed.
        .filter(pr => pr.p || pr.spec || pr.make || pr.sizes.length)
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
        // The firm's GST number, its own box rather than a remark, so it can be searched and
        // copied onto paperwork. Owner's decision. Stored as written and never validated —
        // a number he has to correct is better than one silently rejected.
        gst: str(src.gst).toUpperCase().slice(0, 20),
        // Which pages of his phone book this firm is filed under. The heading is the most
        // useful thing on the page — "P(13) PURCHASE DEP - ERW MFG (SCAFFOLDING TUBE)" says
        // what the firm does far better than anything in the entry itself — and every firm
        // under that heading shares it. One firm can be filed under several: APL Apollo is
        // under ERW MFG and under SQUARE PIPE.
        categories: sanitizeStrings(src.categories, 12),
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
        // Three states, not two. Anything that is not an explicit yes or no is "not
        // recorded" — a default answered for the owner, and the ranking then scored it.
        partLoad: src.partLoad === true ? true : (src.partLoad === false ? false : null),
        enquiries: sanitizeEnquiries(src.enquiries),
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
    // owner's business, but a blank new row is only ever an accident — a client that saved
    // before anything was typed, or an import that carried nothing worth keeping.
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
/**
 * Domains that say NOTHING about which firm someone works for.
 *
 * The ordinary free-mail names, and — the ones that actually bite here — India's old ISP
 * domains. Twenty years of contacts were made when vsnl.net and bsnl.in were how a business
 * had email at all. Treating one as a firm welded 47 unrelated people onto a single card,
 * and "Vsnl" is sitting in the directory today as a transporter.
 *
 * Matched on the WHOLE domain, not its first label, so bsnl.co.in is caught as well as
 * bsnl.in. This is the only such list — the Google-contacts scan imports it rather than
 * keeping a second one that can drift.
 */
const FREE_MAIL_NAMES = [
    'gmail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'live', 'icloud', 'proton', 'protonmail',
    'aol', 'rediffmail', 'rediff', 'zoho',
    // Indian ISPs — a mailbox here is a person's, never a firm's.
    'vsnl', 'bsnl', 'mtnl', 'sify', 'airtelmail', 'airtel', 'dataone', 'satyam', 'eth',
    'touchtelindia', 'vsnl-net',
];
const FREE_MAIL = new RegExp('^(' + FREE_MAIL_NAMES.join('|') + ')\\.');
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
    // FREE_MAIL is asked about the WHOLE domain (so bsnl.co.in is caught as well as
    // bsnl.in); the NAME is still guessed from its first label.
    const domain = cleanEmail(email).split('@')[1] || '';
    const label = domain.split('.')[0] || '';
    if (!label || FREE_MAIL.test(domain)) return '';
    const out = [];
    label.split(/[-_.]+/).filter(Boolean).forEach(part => { out.push.apply(out, splitTradeWord(part)); });
    return out.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Record that enquiries went out to (or a reply came in from) these addresses.
 * Unknown addresses become stubs the owner tidies later — the directory fills itself.
 */
const MAX_ENQUIRIES = 50;

/**
 * The enquiries actually sent to a firm, so "Enquiries sent: 1" can be opened and read.
 *
 * The card only ever held COUNTS — the number 1, with no way back to the email it stood for.
 * The exchange itself lives on the quote, keyed by its Gmail thread; this keeps that thread
 * id beside the firm so the card can link straight to it.
 *
 * Newest first, and capped: a firm asked every week for a year would otherwise grow the
 * directory blob without limit.
 */
function sanitizeEnquiries(input) {
    return (Array.isArray(input) ? input : [])
        .filter(e => e && typeof e === 'object')
        .map(e => ({
            thread: str(e.thread),
            at: str(e.at).slice(0, 10),
            quote: str(e.quote),
            asked: str(e.asked).slice(0, 200),
            replied: e.replied === true,
            repliedAt: str(e.repliedAt).slice(0, 10),
        }))
        .filter(e => e.thread || e.at)
        .slice(0, MAX_ENQUIRIES);
}

/**
 * Note an enquiry against the firm it went to, or mark one answered.
 *
 * Matched on the Gmail THREAD, never on position: the same firm can be asked twice in one
 * day, and replies come back in whatever order people get round to them. A reply on a thread
 * this card has no record of is ignored rather than guessed at — putting a reply beside a
 * question nobody asked is worse than not showing it.
 */
function noteEnquiry(partner, entry, when) {
    const list = sanitizeEnquiries(partner && partner.enquiries);
    const thread = str(entry && entry.thread);
    const day = str(when) || new Date().toISOString().slice(0, 10);

    if (entry && entry.replied) {
        const at = thread ? list.findIndex(e => e.thread === thread) : -1;
        if (at === -1) return list;
        const hit = Object.assign({}, list[at], { replied: true, repliedAt: day });
        return list.slice(0, at).concat([hit], list.slice(at + 1));
    }
    // Sending on a thread already listed is the same enquiry, not a second one.
    if (thread && list.some(e => e.thread === thread)) return list;
    return [{
        thread,
        at: day,
        quote: str(entry && entry.quote),
        asked: str(entry && entry.asked).slice(0, 200),
        replied: false,
        repliedAt: '',
    }].concat(list).slice(0, MAX_ENQUIRIES);
}

function bumpUsage(list, usage) {
    const now = new Date().toISOString().slice(0, 10);
    const reply = (usage && usage.kind) === 'reply';
    const contacts = (Array.isArray(list) ? list : []).slice();
    const unknown = [];
    const counted = {};
    sanitizeStrings(usage && usage.emails, 50).map(lower).filter(isEmail).forEach(email => {
        const idx = contacts.findIndex(c => allEmails(c).indexOf(email) !== -1);
        if (idx === -1) {
            // Nothing enters the directory unasked. An address we have not seen becomes an
            // item WAITING FOR APPROVAL (see pendingFromUsage), not a card that silently
            // appears. Our own address and test placeholders are dropped outright — copying
            // ourselves on an enquiry must never make the firm its own supplier.
            if (worthImporting(email) && unknown.indexOf(email) === -1) unknown.push(email);
            return;
        }
        // Replace rather than write through: `list` holds the caller's objects, and a stale
        // copy of one being mutated in place is exactly the hazard the directory avoids.
        const target = Object.assign({}, contacts[idx]);
        // ONE ENQUIRY, ONE FIRM. Cc'ing two people at the same mill is one enquiry to that
        // mill. Counting per address made a two-person firm look twice as busy as a
        // one-person firm, and reach "Regular" (5 asks) after two sends.
        if (!counted[idx]) {
            counted[idx] = true;
            if (reply) { target.rep = num(target.rep, 0) + 1; }
            else { target.enq = num(target.enq, 0) + 1; }
        }
        // WHICH enquiry, not just how many. The caller sends one entry per address; an
        // address with no thread simply bumps the count as before, which is what every
        // older caller does and what the counts on today's cards came from.
        const sent = ((usage && usage.threads) || [])
            .filter(t => t && lower(t.email) === email)[0];
        if (sent) {
            target.enquiries = noteEnquiry(target, {
                thread: str(sent.thread), quote: str(sent.quote),
                asked: str(sent.asked), replied: reply,
            }, now);
        }
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
            role: 'dealer', count: t.count, last: t.lastUsed, types: [canonicalPipeType(type)],
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
    const clean = cleanEmail(email);
    const domain = clean.split('@')[1] || '';
    return (domain && !FREE_MAIL.test(domain)) ? 'd:' + domain : 'e:' + clean;
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

/**
 * Add to the approval queue without ever losing what is already in it.
 *
 * The queue is capped, and the old code put new arrivals first and sliced the result — so a
 * full queue silently dropped its oldest items, which are the ones that have been waiting
 * longest. Room is whatever is left AFTER the existing queue; anything that does not fit is
 * counted and handed back, so the owner can be told rather than left to notice.
 */
function queueWithoutLosingAny(existing, incoming, cap) {
    const held = existing || [];
    const room = Math.max(0, (cap || MAX_PENDING) - held.length);
    const taken = (incoming || []).slice(0, room);
    return { items: taken.concat(held), queued: taken.length, noRoom: Math.max(0, (incoming || []).length - room) };
}

/**
 * How to tell two entries in a list apart, per field. Used only to decide whether an entry
 * the stored card has is already present in the one being approved.
 */
const LIST_KEY = {
    // A godown or board line is a person with NO name and NO address, and keying on those
    // two alone made every such line collapse to the empty string — so a second one was
    // dropped as a duplicate and its numbers went with it. The number identifies it.
    people: c => lower(str(((c.emails || [])[0] || {}).v)
        || str(((c.phones || [])[0] || {}).v).replace(/\D/g, '')
        || str(c.name)),
    notes: n => lower(str(n && n.t)),
    branches: b => lower(str(b && b.city) + '|' + str(b && b.address)),
    products: p => lower(str(p && p.p) + '|' + str(p && p.spec)),
    rules: r => lower(str(r)),
    routes: r => lower(str(r && r.from) + '|' + str(r && r.to)),
    types: t => lower(str(t)),
    categories: c => lower(str(c)).replace(/[^a-z0-9]/g, ''),
    images: i => lower(str(i && i.n)),
};

/**
 * Approving a queued firm must not delete work done while it was queued.
 *
 * The review card is a copy of the stored card FROZEN when the item was queued, and approving
 * writes the list fields from it wholesale. So a contact or a note added to that firm in the
 * days between — which is exactly what the owner does with a firm they are dealing with —
 * was silently wiped, and the History line said only "Contact added". Anything the stored
 * card has that the approved copy does not is put back.
 *
 * It errs towards keeping. A contact deleted on the review screen comes back, which is visible
 * and can be deleted again; a contact deleted behind the owner's back is not.
 */
/**
 * Is this incoming value a real answer, or just an empty box?
 *
 * The review card is FROZEN when the item is queued. A firm queued on Monday, given a city
 * and an address on Tuesday, then approved on Wednesday was having Tuesday's typing wiped by
 * Monday's blanks — the guard below only ever protected the list fields, so every plain box
 * (company, city, address, MOQ, vehicles) was written straight over.
 *
 * Blank never wins. Only a value that actually says something replaces what is stored.
 */
function saysSomething(v) {
    if (v == null) return false;                 // partLoad's "not answered"
    if (typeof v === 'number') return v !== 0;   // MOQ 0 is "not set", not "zero tonnes"
    if (typeof v === 'boolean') return true;
    return str(v) !== '';
}

function keepWhatWasAddedSince(before, incoming, fields) {
    if (!before || !incoming) return { partner: incoming, kept: [] };
    const out = Object.assign({}, incoming);
    const kept = [];
    (fields || []).forEach(f => {
        const key = LIST_KEY[f];
        if (key && Array.isArray(before[f])) {
            const have = new Set((out[f] || []).map(key));
            const missing = before[f].filter(x => !have.has(key(x)));
            if (!missing.length) return;
            out[f] = (out[f] || []).concat(missing);
            kept.push(missing.length + ' ' + f);
            return;
        }
        // Everything that is not a list: a stored answer is never replaced by a blank one.
        if (!saysSomething(out[f]) && saysSomething(before[f])) {
            out[f] = before[f];
            kept.push(f);
        }
    });
    return { partner: out, kept };
}

/**
 * Take the cards nobody ever approved OUT of the directory and put them back in the queue.
 *
 * The owner's rule from the start was that nothing enters the directory without approval.
 * Ten cards were in there anyway — built from addresses an enquiry had been sent to, with
 * the firm name read off the email ("anmolgroup69@gmail.com", "Vsnl") and every other box
 * left at its default. On the list they were indistinguishable from entries he had made.
 *
 * Nothing is thrown away. Each card becomes a queue item carrying the WHOLE card as its
 * preview, id included — this firm is not new, and its history hangs off that id — so
 * approving one puts back exactly what was there. A card that does not fit in the queue
 * STAYS in the directory: losing it to a full queue is the one unacceptable outcome.
 */
function unapprovedToPending(contacts, pending, cap) {
    const held = contacts || [];
    const queue = pending || [];
    const move = held.filter(p => p && p.fromEnquiry === true);
    if (!move.length) return { contacts: held, pending: queue, moved: [], noRoom: 0 };

    const items = move.map(p => ({
        id: newPendingId(),
        origin: 'import',
        from: allEmails(p)[0] || '',
        subject: str(p.company) || allEmails(p)[0] || 'Unnamed',
        file: '', kind: 'photo', text: '',
        finds: allEmails(p).map(email => ({
            kind: 'field', key: 'email', label: 'Address you have used', value: email,
        })),
        receivedAt: new Date().toISOString(),
        // Its part-load box was never answered by anybody — it holds whatever the old
        // two-option default put there. Send it back as "not recorded" rather than as a
        // claim the owner is about to approve without ever having made it.
        preview: sanitizePartner(Object.assign({}, p, { partLoad: null })),
    }));

    const room = queueWithoutLosingAny(queue, items, cap);
    const queued = {};
    items.slice(0, room.queued).forEach(it => { queued[it.preview.id] = true; });

    return {
        contacts: held.filter(p => !queued[p.id]),
        pending: room.items,
        moved: move.filter(p => queued[p.id]).map(p => str(p.company) || allEmails(p)[0] || p.id),
        noRoom: room.noRoom,
    };
}

/**
 * "022-24902570 /72 /76 /78" is FOUR lines, not one.
 *
 * A board with several lines is written in the trade the short way: the full number once,
 * then only the digits that change. Kept as one string it is honest but useless — you cannot
 * ring "/72", and searching for 24902576 finds nothing. Expanded wrongly it is worse: an
 * earlier pass invented 022-24902572/76/78 as separate numbers with no basis, and that had
 * to be undone.
 *
 * So the rule is narrow and refuses when it is unsure. A tail expands only when it is plain
 * digits, no longer than the base, and the base is a single clean number. Anything with an
 * extension, a comma, or letters is left exactly as written — 62 entries hold this shorthand
 * and being right about 50 beats guessing at all of them.
 *
 * Returns null when it will not expand, so the caller keeps the original untouched.
 */
function expandTrunkLine(value) {
    const raw = str(value);
    if (!raw.includes('/')) return null;
    if (/[a-z,]/i.test(raw)) return null;                 // EXTN:429, or two numbers comma-joined
    const parts = raw.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    const base = parts[0].replace(/\s+/g, '');
    // The STD code and the line itself: "044-49542545" is area 044, line 49542545. Lengths
    // must be judged against the LINE, or a whole second Chennai number reads as a suffix.
    const cut = base.match(/^(.*?)(\d+)$/);
    if (!cut) return null;
    const area = cut[1];                                  // "044-", "+91", or nothing
    const line = cut[2];
    if (line.length < 5) return null;                     // too short to have a stable stem

    const out = [base];
    for (let i = 1; i < parts.length; i++) {
        const tail = parts[i].replace(/\s+/g, '');
        if (!/^\d+$/.test(tail)) return null;             // not a number at all — do not guess
        // "044-49542545 / 26544914" and "23427580/23420291" are whole numbers written
        // together, not a stem and a tail. Splitting those needs no inference at all.
        if (tail.length >= line.length) { out.push(area + tail); continue; }
        if (tail.length > 4) return null;                 // too long for a suffix, too short for a number
        out.push(area + line.slice(0, line.length - tail.length) + tail);
    }
    return out;
}

/** A phone reduced to the digits that identify it — last ten, so +91 and 0 prefixes agree. */
function dialKey(v) {
    const digits = str(v).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Everything that IDENTIFIES a firm on a card or a queue item: its firms, and failing that
 * its name and phone numbers.
 *
 * This used to collect bare email addresses, and that was the leak. Bombay Hardware sat in
 * the queue under bhplsales@ while its Google card carried accounts@ — different strings, so
 * nothing matched, and the same firm was offered again as new. Worse, a card holding eight
 * colleagues was skipped entirely because ONE of its eight addresses was already known.
 * Matching on the firm — the email DOMAIN — settles both: same firm, one card.
 *
 * Names and phones are collected too, because a phone-book firm often has no email at all
 * (3,744 numbers live in these notes and many entries carry nothing else). Without them
 * those firms could never be matched, so they were never offered.
 */
function identitiesOf(partner) {
    const out = new Set();
    allEmails(partner || {}).forEach(e => out.add(firmKeyOf(e)));
    const name = lower(str((partner || {}).company)).replace(/[^a-z0-9]/g, '');
    if (name) out.add('n:' + name);
    ((partner || {}).people || []).forEach(p => (p.phones || []).forEach(q => {
        const d = dialKey(q && q.v);
        if (d.length >= 10) out.add('p:' + d);
    }));
    return out;
}

function addressesSpokenFor(pending, contacts) {
    const taken = new Set();
    const add = (p) => identitiesOf(p).forEach(k => taken.add(k));
    (contacts || []).forEach(add);
    (pending || []).forEach(it => {
        add((it && it.preview) || {});
        if (it && it.from && isEmail(it.from)) taken.add(firmKeyOf(it.from));
    });
    return taken;
}

/**
 * Two review cards for one firm, folded into one — keeping everything on both.
 *
 * Bombay Hardware showed why this is needed. A card built from a remembered address held one
 * line: bhplsales@, no name, no notes. The card built from Google Contacts held EIGHT
 * colleagues and both notes boxes — Sampath's two numbers, the godown line, Arumugam, and
 * Chetna Steel. Because the thin one reached the queue first, the rich one was skipped as a
 * firm already dealt with, and the owner was shown the worse of the two and told nothing.
 *
 * Skipping is right for a firm he has already APPROVED. For one still waiting it is wrong:
 * nothing has been decided yet, so the two should simply become the better card.
 *
 * Additive only. A blank never replaces a value, and nothing on either card is dropped.
 */
function mergePreviews(base, extra) {
    const out = Object.assign({}, base || {});
    const from = extra || {};
    Object.keys(LIST_KEY).forEach(f => {
        if (f === 'people') return;          // people are folded below, on their real identity
        const key = LIST_KEY[f];
        const mine = Array.isArray(out[f]) ? out[f] : [];
        const theirs = Array.isArray(from[f]) ? from[f] : [];
        const have = new Set(mine.map(key));
        out[f] = mine.concat(theirs.filter(x => !have.has(key(x))));
    });
    // Every person from both cards, then folded on shared numbers and addresses. Filtering
    // first would drop a nameless office line before its number was ever looked at.
    out.people = foldPeople((Array.isArray(out.people) ? out.people : [])
        .concat(Array.isArray(from.people) ? from.people : []));
    // A name read from the notes beats one made up from an email domain, so "Md4" gives way
    // to "MD4 STEELS". Every other box only fills a blank — a stored answer is never replaced.
    out.company = betterCompanyName(out.company, from.company, out);
    ['role', 'roleOther', 'city', 'address', 'vehicles', 'moq', 'partLoad'].forEach(f => {
        if (!saysSomething(out[f]) && saysSomething(from[f])) out[f] = from[f];
    });
    return out;
}

/**
 * Two records for the same person, or two people who happen to share a line?
 *
 * An EMAIL is one person's — "Mahesh Pardeshi" and "MAHESH PERDESH" both hold
 * mahesh.pardeshi@jindalsaw.com and are plainly one man spelled two ways, so a shared address
 * merges them whatever the names look like.
 *
 * A PHONE is not. In the Nasik list Mahesh Perdesh and Mangesh Lahamge are both written
 * against 8600107980; the owner confirmed they are two people and both keep the number.
 * Merging on a shared number alone would have deleted one of them.
 *
 * A BRANCH separates too: the owner wants a man who covers Bombay and Nasik listed under
 * each, so two records with the same name and different branches stay two records.
 */
function canBeSamePerson(a, b) {
    const mails = new Set(((a.emails || []).map(e => cleanEmail(e.v))).filter(Boolean));
    const sharesEmail = (b.emails || []).some(e => mails.has(cleanEmail(e.v)));
    if (sharesEmail) return true;
    const an = lower(str(a.name)), bn = str(b.name).toLowerCase();
    if (an && bn && an !== bn && !looksLikeALabel(an) && !looksLikeALabel(bn)) return false;
    const ab = lower(str(a.branch)), bb = lower(str(b.branch));
    return !(ab && bb && ab !== bb);
}

/** Is there anything on this person you could ring or write to? */
function personIsBare(p) {
    return !((p.phones || []).length || (p.emails || []).length);
}

/** One person, however many times they appear — matched on any shared number or address. */
function foldPeople(people) {
    const kept = [];
    (people || []).forEach(p => {
        const keys = new Set();
        (p.emails || []).forEach(e => { const v = cleanEmail(e.v); if (v) keys.add('e:' + v); });
        // SIX digits is enough here, where ten is the rule for telling firms apart. Two rows
        // on the SAME card sharing a landline are the same desk; two firms sharing one are a
        // coincidence worth being careful about. Kerala Roadways' office line, 25291620, is
        // eight digits — under the ten-digit rule it counted as no key at all, so the nameless
        // office row never matched itself and every re-run added another copy of it.
        (p.phones || []).forEach(q => { const d = dialKey(q && q.v); if (d.length >= 6) keys.add('p:' + d); });
        // ASHOK appeared three times on one card, every row empty, because a person with no
        // number and no address has nothing to match on. The NAME matches them — but only
        // when one side is bare. Two men called Kumar who each have their own number are two
        // men, and merging them on the name alone would delete one.
        const nameKey = 'n:' + lower(str(p.name)).replace(/[^a-z0-9]/g, '');
        const match = kept.find(k => {
            const shared = [...keys].some(x => k.keys.has(x));
            const byName = nameKey !== 'n:' && k.keys.has(nameKey)
                && (personIsBare(k.p) || personIsBare(p));
            return (shared || byName) && canBeSamePerson(k.p, p);
        });
        if (nameKey !== 'n:') keys.add(nameKey);
        if (!match) {
            kept.push({ p: Object.assign({}, p), keys });
            return;
        }
        keys.forEach(x => match.keys.add(x));
        const seen = new Set((match.p.phones || []).map(q => dialKey(q && q.v)));
        (p.phones || []).forEach(q => { if (!seen.has(dialKey(q && q.v))) match.p.phones.push(q); });
        const mails = new Set((match.p.emails || []).map(e => cleanEmail(e.v)));
        (p.emails || []).forEach(e => { if (!mails.has(cleanEmail(e.v))) match.p.emails.push(e); });
        if (betterName(p.name, match.p.name)) match.p.name = str(p.name);
        if (!str(match.p.role) && str(p.role)) match.p.role = p.role;
        if (!str(match.p.branch) && str(p.branch)) match.p.branch = p.branch;
    });
    // A person with no name, no number and no address is not a person. One is kept as the
    // empty "Main contact" slot every card needs; more than one is just noise.
    const real = kept.map(k => k.p).filter(p => str(p.name) || (p.phones || []).length || (p.emails || []).length);
    return real.length ? real : [{ name: '', role: 'Main contact', phones: [], emails: [] }];
}

/**
 * Is this the better name for a person carried on two cards?
 *
 * Google's display name for a mailbox is often a label, not a man — "Purchase | Fire Trix",
 * or the firm's own name spelled out. The phone book gives the actual person, "S.VENI". The
 * longer string is the wrong test on its own, so a label loses to a plain name and only then
 * does length decide.
 */
function looksLikeALabel(name) {
    return /[|@]|\b(pvt|ltd|limited|llp|corp|inc)\b/i.test(str(name));
}

function betterName(candidate, current) {
    const a = str(candidate), b = str(current);
    if (!a) return false;
    if (!b) return true;
    if (looksLikeALabel(b) && !looksLikeALabel(a)) return true;
    if (looksLikeALabel(a) && !looksLikeALabel(b)) return false;
    return a.length > b.length;
}

/**
 * Is this firm someone the owner SELLS to?
 *
 * The directory is for people he buys from and ships with. A customer on it is worse than
 * useless: it would be ranked as a supplier and could be sent a freight enquiry. The scan
 * already held back the customers it could spot by email domain, but a firm read out of a
 * notes box usually has no address at all — only a name and a number — so the domain test
 * never fired and Chemplast Sanmar, a customer, got a card anyway.
 *
 * Both tests now. The names come from the company on every saved quotation, which is the
 * closest thing to a definitive list of who he has sold to.
 */
function looksLikeACustomer(preview, customers) {
    const c = customers || {};
    const domains = new Set((c.domains || []).map(lower));
    const names = c.nameKeys || new Set((c.names || []).map(firmNameKey));
    const key = firmNameKey((preview || {}).company);
    if (key && names.has && names.has(key)) return true;
    return allEmails(preview || {}).some(e => {
        const d = cleanEmail(e).split('@')[1] || '';
        return d && domains.has(d);
    });
}

/**
 * Pull the branch back out of a job title that swallowed it.
 *
 * Before people had a branch of their own, the reading had nowhere to put one, so it wrote
 * the place into the role: "SR MANAGER -MARKETING, for SS pipe (Bombay office)". The job and
 * the place are both worth keeping, but not in one box — you cannot group by it, sort by it,
 * or tell at a glance who to ring in Nasik.
 *
 * Only branches the CARD already lists are recognised. Guessing a place from any capitalised
 * word would put half these people at a branch that does not exist, and a wrong branch is
 * worse than none: it is the number he would ring first.
 *
 * Returns { role, branch } — the role with the place taken out, and the place.
 */
function branchFromRole(role, branchNames) {
    const text = str(role);
    if (!text) return { role: '', branch: '' };
    // Longest first, so "Nasik factory (PPC division)" wins over "Nasik factory".
    const names = (branchNames || []).map(str).filter(Boolean)
        .sort((a, b) => b.length - a.length);
    for (const name of names) {
        const at = text.toLowerCase().indexOf(name.toLowerCase());
        if (at === -1) continue;
        const left = text.slice(0, at);
        const right = text.slice(at + name.length);
        const rest = tidyLeftover(left + ' ' + right);
        return { role: rest, branch: name };
    }
    return { role: text, branch: '' };
}

/**
 * What is left of a job title once the branch has been cut out of the middle of it.
 *
 * Cutting "Bombay office" out of "for SS pipe (Bombay office / Nasik factory)" leaves an
 * opening bracket with nothing to close it and a slash leading nowhere. A person whose job
 * reads "for SS pipe ( / Nasik factory" looks like a bug, so the wreckage is cleared: empty
 * brackets go, an unmatched bracket goes, and doubled-up commas and slashes collapse.
 */
function tidyLeftover(text) {
    // Edges first. Stripping a trailing ")" afterwards would leave its "(" behind, which is
    // exactly the wreckage this is here to clear.
    let s = str(text)
        .replace(/\(\s*\)/g, ' ')
        .replace(/\s*[,/]\s*(?=[,/])/g, '')
        .replace(/^[\s,/(-]+|[\s,/)-]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    const opens = (s.match(/\(/g) || []).length;
    const closes = (s.match(/\)/g) || []).length;
    if (opens > closes) s = s.replace(/\(/, ' ');
    else if (closes > opens) s = s.replace(/\)/, ' ');
    return s.replace(/\s{2,}/g, ' ').replace(/^[\s,/-]+|[\s,/-]+$/g, '').trim();
}

/**
 * The branch named inside a person's own NAME.
 *
 * Mailboxes are saved under a label rather than a person — "KRS Chennai - Madhavaram",
 * "Kerala Roadways (P) Ltd - Chennai Transhipment". The label says which office it is, and
 * that row obviously belongs to that branch.
 *
 * The NAME IS NOT CHANGED. His decision is that a name stays exactly as he typed it; only the
 * branch is filled in from what it says. As with the job title, only branches the card already
 * lists are recognised, so nothing is invented.
 */
function branchFromName(name, branchNames) {
    const text = str(name);
    if (!text) return '';
    const found = (branchNames || []).map(str).filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .find(b => text.toLowerCase().indexOf(b.toLowerCase()) !== -1);
    return found || '';
}

/** Every person on a card, with the branch lifted out of their job title or their name. */
function splitBranchesOut(preview) {
    const names = ((preview || {}).branches || [])
        .map(b => str(b && (b.city || b.address))).filter(Boolean);
    if (!names.length) return preview;
    const people = ((preview || {}).people || []).map(p => {
        if (str(p.branch)) return p;
        const cut = branchFromRole(p.role, names);
        if (cut.branch) return Object.assign({}, p, cut);
        const fromName = branchFromName(p.name, names);
        return fromName ? Object.assign({}, p, { branch: fromName }) : p;
    });
    return Object.assign({}, preview, { people });
}

/**
 * Was this firm's name GUESSED from its email domain?
 *
 * The contacts scan has nothing but an address to go on, so it makes a name out of the domain
 * — md4.com becomes "Md4", abs-engg.com becomes "Abs". Useful as a placeholder, useless on a
 * card: the owner cannot tell "Md4" from anything, and "Gamail" is not a firm at all, it is
 * someone's typo of gmail.com.
 *
 * The notes usually hold the real name — "MD4 STEELS", "ABS ENGINEERING SOLUTIONS". When they
 * do, it replaces the guess.
 */
function nameWasGuessed(company, preview) {
    const name = firmNameKey(company);
    if (!name) return true;
    return allEmails(preview || {}).some(e => firmNameKey(companyFromEmail(e)) === name);
}

/**
 * The better of two names for one firm.
 *
 * A name read out of the notes beats one made up from a domain. Between two real names the
 * fuller one wins — "BOMBAY HARDWARE PVT LTD" over "Bombayhardware" — because that is the name
 * the owner would write on an enquiry.
 */
function betterCompanyName(existing, incoming, preview) {
    const a = str(existing), b = str(incoming);
    if (!b) return a;
    if (!a) return b;
    const aGuessed = nameWasGuessed(a, preview);
    const bGuessed = nameWasGuessed(b, preview);
    if (aGuessed && !bGuessed) return b;
    if (bGuessed && !aGuessed) return a;
    return b.length > a.length ? b : a;
}

/**
 * One product range, not three copies of it.
 *
 * APL Apollo's range came out as "15X15 TO 400 X 200 /THICKNESS : 1.1 TO 12MM", then
 * "PRODUCT RANGE : 15X15 TO 400 X 200", then "THICKNESS : 1.1 TO 12MM" — the whole thing and
 * both of its halves, because the same range is written in four different contacts and each
 * reading split it a different way.
 *
 * The label the owner typed in front of it ("PRODUCT RANGE :") is not part of the product, and
 * a line that is wholly contained in another line adds nothing. The LONGEST wording wins,
 * because it is the one holding every part.
 */
function tidyProducts(list) {
    const seen = [];
    (Array.isArray(list) ? list : []).forEach(p => {
        const text = str(p && p.p).replace(/^\s*(product\s*range|range|size|sizes)\s*[:\-]\s*/i, '').trim();
        if (!text) return;
        seen.push(Object.assign({}, p, { p: text }));
    });
    // Longest first, so a shorter line is measured against the fuller one that may contain it.
    seen.sort((a, b) => b.p.length - a.p.length);
    const kept = [];
    seen.forEach(p => {
        const mine = squash(p.p);
        const inside = kept.some(k => squash(k.p).indexOf(mine) !== -1
            && str(k.spec).toLowerCase() === str(p.spec).toLowerCase());
        if (!inside) kept.push(p);
    });
    return kept;
}

function squash(s) { return str(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/**
 * Is this phone-book heading a TRADE, or just one firm's own page?
 *
 * "P(13) PURCHASE DEP - ERW MFG (SCAFFOLDING TUBE)" is a trade, and every firm underneath it
 * shares it. "APPOLO PIPES (ALL DETAILS)" is a page about one firm and says nothing about what
 * anybody does. *Owner's decision: no category from those.*
 */
function headingIsATrade(title) {
    const t = str(title);
    if (!t) return false;
    return !/ALL\s*DETAIL/i.test(t);
}

/**
 * The categories a card earns from the pages it was found on.
 *
 * Kept WORD FOR WORD, filing code and city and all — *owner's decision.* "PD (1) PIPE DEALER
 * (STOCKIST)-BOMBAY (MUMBAI)" stays exactly that, because Bombay stockists and Chennai
 * stockists are separate pages in his book and he wants them separate here.
 */
function categoriesFromHeadings(titles) {
    const out = [];
    (titles || []).forEach(t => {
        const title = str(t);
        if (!headingIsATrade(title)) return;
        if (out.some(x => squash(x) === squash(title))) return;
        out.push(title);
    });
    return out;
}

/** The phone-book headings a card records, read back off its own notes. */
function headingsOnCard(preview) {
    return ((preview || {}).notes || []).map(n => {
        const m = str(n && n.t).match(/^From your phone book, under "(.+)"$/);
        return m ? m[1] : '';
    }).filter(Boolean);
}

/** Is there any way to actually contact this firm — an address or a number? */
function canBeReached(preview) {
    if (allEmails(preview || {}).length) return true;
    return ((preview || {}).people || []).some(p => (p.phones || []).some(q => dialKey(q && q.v).length >= 10));
}

/** Does the queue or the directory already hold this firm, under any of its names? */
function firmIsSpokenFor(firm, taken) {
    const mine = identitiesOf((firm && firm.preview) || {});
    for (const k of mine) if (taken.has(k)) return true;
    return false;
}

/** How many of the Google firms have already been brought in or approved. */
function googleAlreadyHandled(pending, firms) {
    const taken = addressesSpokenFor(pending, []);
    return (firms || []).filter(f => firmIsSpokenFor(f, taken)).length;
}

/**
 * The next batch of Google firms to put in front of the owner.
 *
 * Skips anything already on a card or already waiting, so working through the list in
 * fifties never doubles back. Returns what is left as well, because "189 to go" turning
 * into "139 to go" is the only way he can tell the press did anything.
 */
function nextGoogleBatch(firms, pending, contacts, size) {
    const taken = addressesSpokenFor(pending, contacts);
    // Two different questions, and running them together was the bug. A NAME is enough to
    // recognise a firm the owner already has; it is not enough to offer him a new one, because
    // a card with no phone and no address can never be sent an enquiry. So: reachable enough
    // to be worth offering, then matched on everything including the name.
    //
    // Previously a firm was offered only if it had an EMAIL, which stranded the phone-only
    // firms — and most of the phone book is exactly that, 3,744 numbers typed into notes.
    // Worse, they were counted as already handled, so the count never moved and nothing said why.
    const isNew = (f) => canBeReached((f && f.preview) || {}) && !firmIsSpokenFor(f, taken);

    // A firm already APPROVED is settled — leave it alone. One still WAITING is not, so a
    // richer card for it improves the card he has yet to look at rather than being dropped.
    const inQueue = addressesSpokenFor(pending, []);
    const onlyQueued = (f) => canBeReached((f && f.preview) || {})
        && firmIsSpokenFor(f, inQueue) && !firmIsSpokenFor(f, addressesSpokenFor([], contacts));

    // A card just rebuilt from a notes box goes to the FRONT. The owner asked to see the ones
    // that changed, and burying them behind five hundred untouched cards is the same as not
    // having done the work.
    const waiting = (firms || []).filter(isNew)
        .sort((a, b) => (b.freshened ? 1 : 0) - (a.freshened ? 1 : 0));
    const take = waiting.slice(0, Math.max(0, size || 0));

    const enrich = [];
    (firms || []).filter(onlyQueued).forEach(f => {
        const mine = identitiesOf(f.preview || {});
        const item = (pending || []).find(it => {
            const theirs = identitiesOf((it && it.preview) || {});
            for (const k of mine) if (theirs.has(k)) return true;
            return false;
        });
        if (item) enrich.push({ id: item.id, preview: mergePreviews(item.preview, f.preview) });
    });

    return {
        items: take.map(f => googlePendingItem(f)),
        enrich,
        alreadyThere: (firms || []).length - waiting.length - enrich.length,
        left: waiting.length,
    };
}

/**
 * One Google firm, as a queue item.
 *
 * It carries no id: this firm is NOT in the directory, so approving it makes a new card and
 * the server assigns the id. The 'google' origin is what lets the review screen say where it
 * came from, and what the Discard warning reads to tell the truth about what happens next.
 */
/**
 * A request to take something off a card, as a queue item.
 *
 * It sits in Recent changes beside the firms waiting to be approved, because that is where
 * the owner already looks for things needing his word. Nothing is taken off the card until
 * he approves it.
 */
function removalPendingItem(req, subject) {
    return {
        id: newPendingId(),
        origin: 'removal',
        from: '', subject: str(subject), file: '', kind: '', text: '',
        finds: [],
        receivedAt: new Date().toISOString(),
        preview: null,
        removal: req,
    };
}

/** The removals waiting against one card, so it can show what is marked. */
function removalsFor(pending, cardId) {
    return (pending || [])
        .filter(it => it && it.origin === 'removal' && it.removal && it.removal.cardId === str(cardId))
        .map(it => it.removal);
}

function googlePendingItem(firm) {
    const preview = sanitizePartner(Object.assign({}, firm.preview, { id: '' }));
    const mails = allEmails(preview);
    const id = newPendingId();
    preview.id = 'p_new_' + id;
    // sanitizePartner has no "unset" for role — a blank comes back as 'other', which is a
    // real choice the owner might make and so cannot be told apart from nobody choosing.
    // The blank is put back and the review screen holds Approve until he picks, the same
    // way it already does for a firm with no name. Google gave us no labels to guess from,
    // and the role decides who gets sent a freight enquiry.
    preview.role = '';
    return {
        id,
        origin: 'google',
        from: mails[0] || '',
        subject: str(preview.company) || mails[0] || 'Unnamed',
        file: '', kind: 'photo', text: '',
        finds: mails.map(email => ({
            kind: 'field', key: 'email', label: 'From your Google Contacts', value: email,
        })),
        receivedAt: new Date().toISOString(),
        // Carried through so the Add tab can say which cards were rebuilt from a notes box,
        // rather than the owner having to work it out by reading them.
        freshened: str(firm.freshened),
        preview,
    };
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

/**
 * A partner deleted on purpose, logged so it can be put back.
 *
 * Deleting used to leave no trace at all: the card was gone, nothing said so, and there was
 * nothing to press. `removed` is what tells undo to put the whole card back rather than
 * treating a missing card as an already-undone edit.
 */
function removalEntry(partner, source) {
    const card = sanitizePartner(partner);
    const name = str(card.company) || firstReach(card) || 'a partner';
    const entry = changeEntry('Deleted ' + name,
        'Taken out of the directory. Undo puts the card back as it was.',
        source || 'Deleted by hand', card.id, card, null);
    entry.removed = true;
    // Said out loud, because the change log reads its lines to describe what moved. Left
    // empty, opening a deletion says "nothing measurable changed" — about a whole card.
    entry.lines = [{ label: 'Card removed', from: name, to: 'gone from the directory' }];
    return entry;
}

/** The first address or number on a card — what to call it when it has no firm name yet. */
function firstReach(partner) {
    const mails = allEmails(partner);
    if (mails.length) return mails[0];
    const phone = ((partner && partner.people) || [])
        .reduce((all, p) => all.concat((p && p.phones) || []), []).map(x => str(x && x.v)).filter(Boolean)[0];
    return phone || '';
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
    // Branches were changed silently for a long time: nothing in this list mentioned them, so
    // a card losing four of its five branches showed an empty "what moved" panel.
    const hadB = (b.branches || []).map(x => str(x.city));
    const nowB = (now.branches || []).map(x => str(x.city));
    nowB.forEach(city => { if (hadB.indexOf(city) === -1) out.push({ label: 'Branch added', from: '', to: city }); });
    hadB.forEach(city => { if (nowB.indexOf(city) === -1) out.push({ label: 'Branch REMOVED', from: city, to: '' }); });
    const hadR = (b.routes || []).map(r => r.from + ' → ' + r.to);
    (now.routes || []).forEach(r => { const k = r.from + ' → ' + r.to; if (hadR.indexOf(k) === -1) out.push({ label: 'Route added', from: '', to: k }); });
    const hadN = (b.notes || []).map(n => n.t);
    (now.notes || []).forEach(n => { if (hadN.indexOf(n.t) === -1) out.push({ label: 'Note added', from: '', to: n.t }); });
    const hadF = (b.images || []).map(i => i.n);
    (now.images || []).forEach(i => { if (hadF.indexOf(i.n) === -1) out.push({ label: 'File kept', from: '', to: i.n }); });
}

/** Undo one logged change: an addition is removed, an edit is restored from `before`. */
function undoChange(contacts, changes, changeId, confirmed) {
    const list = (Array.isArray(changes) ? changes : []).slice();
    const ch = list.find(x => x && x.id === changeId);
    if (!ch || ch.undone) return { contacts, changes: list, ok: false };
    let next = (contacts || []).slice();
    const idx = next.findIndex(p => p && p.id === ch.partnerId);
    // Undo puts back a snapshot of the WHOLE card, so anything added since goes with it.
    // Months later that is notes, a product, a contact — none of it mentioned by the entry
    // being undone, and there is no undo-the-undo. Say what else would go, and wait.
    if (ch.before !== null && idx !== -1 && !confirmed) {
        const alsoLost = undoCollateral(ch, next[idx]);
        if (alsoLost.length) return { contacts, changes: list, ok: false, alsoLost };
    }
    if (ch.before === null) { if (idx !== -1) next.splice(idx, 1); }
    else if (idx !== -1) next[idx] = sanitizePartner(ch.before);
    else {
        // The card is not there any more. Undoing a DELETION means putting it back; undoing
        // an edit to a card that has since been deleted cannot be done, and saying "done"
        // would be a lie the owner only finds out about later.
        if (!ch.removed) return { contacts, changes: list, ok: false, missing: true };
        const back = sanitizePartner(ch.before);
        // One address, one company still holds. If an address of the deleted card has since
        // been given to another card, putting this one back would split that firm in two.
        const clash = emailConflict(next, back, -1);
        if (clash) return { contacts, changes: list, ok: false, conflict: clash };
        next.unshift(back);
    }
    ch.undone = true;
    return { contacts: next.slice(0, MAX_CONTACTS), changes: list, ok: true, alsoLost: [] };
}

/**
 * What an undo would take that the change never touched.
 *
 * Everything between the snapshot and the card as it stands, minus the change's own lines —
 * those are the thing being undone on purpose.
 */
function undoCollateral(ch, current) {
    const mine = {};
    (ch.lines || []).forEach(l => { mine[l.label + '|' + l.to] = true; });
    return diffLines(sanitizePartner(ch.before), current)
        .filter(l => !mine[l.label + '|' + l.to]);
}

// ── pending items from the Gmail label ───────────────────────────────────────

function sanitizePendingItem(input) {
    const src = (input && typeof input === 'object') ? input : {};
    return {
        id: str(src.id) || newPendingId(),
        // 'import' items come from the addresses the app already remembered, and carry a
        // ready-made preview holding every person at the firm. 'gmail' items are built from
        // `finds` on the client, one address at a time.
        // Three origins now, and each means something different when the owner discards one:
        // a gmail item can be re-labelled to get it back, an import returns on the next
        // press, and a google one returns on the next scan.
        origin: ['import', 'google', 'removal'].indexOf(str(src.origin)) !== -1 ? str(src.origin) : 'gmail',
        // A removal is not a firm arriving — it is a request to take something OFF one. It
        // carries no preview; what it carries is which card, and which thing on it.
        removal: (src.removal && typeof src.removal === 'object') ? src.removal : null,
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
        // "Nothing found" and "the read failed" both leave an empty finds list, and the review
        // screen cannot tell them apart from the count alone — one means the email had nothing
        // in it, the other means nobody has read it yet. Kept on the item so a reload keeps it.
        readFailed: src.readFailed === true,
        // The day this card was rebuilt from a notes box, if it was. Kept on the item so the
        // Add tab can mark it and put it first — the whole point of doing the reading is that
        // the owner can see which cards it changed.
        freshened: str(src.freshened),
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
        if (!lines.length) return;
        const row = { id: str(s.id), lines, step: s };
        const ask = pipeTypeAsk(s, next);
        if (ask) row.ask = ask;
        out.push(row);
        card = next;
    });
    return out;
}

/**
 * A firm that deals in GI, ERW and Seamless has told us nothing when it says "24 inch".
 * Storing that with no type is a half-fact: the card says they have it, and cannot say in
 * what. So ask — but only when there is a real choice to make. One pipe type, or a size the
 * owner already qualified, needs no question.
 */
function pipeTypeAsk(step, card) {
    if (!step || step.kind !== 'product' || str(step.product && step.product.spec)) return null;
    const types = uniqStrings((card.types || []).map(str).filter(Boolean));
    if (types.length < 2) return null;
    const named = str(step.product && step.product.p);
    if (types.some(t => new RegExp('\\b' + t.replace(/[^a-z0-9]/gi, '') + '\\b', 'i').test(named))) return null;
    return { key: 'spec', question: 'Which of these is the ' + named + '?', options: types };
}

function applyAddFind(card, x, src) {
    if (x.kind === 'product') return mergeProductInto(card, x.product);
    if (x.kind === 'routes') return mergeRoutesInto(card, x.routes);
    if (x.kind === 'note') return addNoteInto(card, x.value, src);
    if (x.kind !== 'field') return;
    // A name, a number and an address read off one letterhead belong on ONE person row, so
    // they are placed together by addPersonInto rather than scattered across three finds.
    if (['person', 'phone', 'email'].indexOf(x.key) !== -1) return;
    if (x.key === 'types') { card.types = mergeStrings(card.types, splitList(x.value).map(canonicalPipeType)); return; }
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
    ['spec', 'rule', 'make'].forEach(k => { if (str(incoming[k])) merged[k] = incoming[k]; });
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
    SHARED_ROLES,
    visibleToReadonly,
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
    queueWithoutLosingAny,
    MAX_ENQUIRIES,
    sanitizeEnquiries,
    noteEnquiry,
    unapprovedToPending,
    addressesSpokenFor,
    googleAlreadyHandled,
    nextGoogleBatch,
    googlePendingItem,
    removalPendingItem,
    removalsFor,
    keepWhatWasAddedSince,
    LIST_KEY,
    companyFromEmail,
    changeEntry,
    removalEntry,
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
    // Shared with utils/googleContacts.js: one firm is one email domain, everywhere.
    firmKeyOf,
    cleanEmail,
    categoriesFromHeadings,
    headingsOnCard,
    tidyProducts,
    suggestRole,
    betterCompanyName,
    nameWasGuessed,
    branchFromRole,
    branchFromName,
    splitBranchesOut,
    looksLikeACustomer,
    firmNameKey,
    expandTrunkLine,
    mergePreviews,
    identitiesOf,
    dialKey,
    isEmail,
    FREE_MAIL_NAMES,
    addAfterCard,
    _test: { normalizeRole, sanitizePerson, sanitizePeople, splitTradeWord, isEmail,
        canonicalPipeType, firstReach,
        firmKeyOf, firmsAlreadyKnown, groupSeedsIntoFirms, seedFromSuggestionFiles, importPendingItem,
        emailConflict,
        addCandidates, applyAddFind, mergeStrings, mergeBranches, mergeProductInto,
        mergeRoutesInto, addNoteInto, addPersonInto, personIndexFor, splitList, firmLines,
        sameFirmName, firmNameKey, diffPeople, personLine, addExampleBlock },
};
