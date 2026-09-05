'use strict';

/**
 * utils/googleContacts.js — turning a Google contact list into firms for approval.
 *
 * The owner's Google account holds 5,507 saved contacts. Read one at a time they are almost
 * useless: only 156 have the company box filled in, and 1,401 have a phone and no email at
 * all. Grouped by the email domain, though, those 5,507 contacts are only 590 firms — and
 * 251 of those are firms he has actually emailed.
 *
 * So this file does one thing: take the raw contact records and hand back FIRMS, each with
 * everyone who works there, marked with whether he has ever corresponded with them. Nothing
 * here writes anywhere or decides anything — grouping only. What reaches the directory is
 * decided by the owner, one firm at a time, in Recent changes.
 *
 * Deliberately NOT handled here: the 167 "list" contacts, where one entry holds twenty or
 * more firms typed into the notes under a heading. Those need reading, not grouping, and
 * they are their own phase.
 */

const { firmKeyOf, companyFromEmail } = require('./contacts');

const str = (v) => String(v == null ? '' : v).trim();
const lower = (v) => str(v).toLowerCase();

/**
 * Addresses a firm cannot be identified by — one of these is one PERSON, never a company.
 *
 * The Indian internet-provider domains matter as much as gmail here, and were missed at
 * first: vsnl.net alone put 47 unrelated people onto a single card called "Vsnl", and
 * eth.net and airtelmail.in did the same. They are the old dial-up and broadband providers,
 * so the oldest and most valuable entries in the book are exactly the ones affected.
 */
const FREE_MAIL = new RegExp('^(' + [
    'gmail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud', 'aol', 'ymail', 'proton',
    'rediffmail', 'vsnl', 'eth', 'airtelmail', 'sify', 'bsnl', 'dataone', 'mtnl', 'satyam',
].join('|') + ')\\.');

function domainOf(email) {
    return lower(email).split('@')[1] || '';
}

/**
 * One Google contact, flattened to the bits the directory has a home for.
 *
 * `organizations[0].name` is the company where it exists — on 156 of 5,507 contacts. The
 * rest carry the firm inside the person's NAME ("SRI BALAJI RAVI"), which is a reading job,
 * not a parsing one: it is left alone here and shown to the owner as it stands.
 */
function readPerson(person) {
    const src = (person && typeof person === 'object') ? person : {};
    const emails = (src.emailAddresses || [])
        .map((e) => lower(e && e.value)).filter((e) => e.indexOf('@') !== -1);
    const phones = (src.phoneNumbers || [])
        .map((p) => str(p && (p.canonicalForm || p.value))).filter(Boolean);
    return {
        name: str(((src.names || [])[0] || {}).displayName),
        company: str(((src.organizations || [])[0] || {}).name),
        title: str(((src.organizations || [])[0] || {}).title),
        emails,
        phones,
        notes: (src.biographies || []).map((b) => str(b && b.value)).filter(Boolean).join('\n'),
        address: str(((src.addresses || [])[0] || {}).formattedValue),
    };
}

/**
 * Which firm a contact belongs to, or null when there is nothing to group on.
 *
 * A business domain is the firm. A gmail-type address is one person, so it becomes its own
 * key rather than lumping every gmail user in the book into one "firm" — that mistake would
 * merge hundreds of unrelated people into a single card.
 */
function firmKeyForContact(read) {
    const business = read.emails.filter((e) => !FREE_MAIL.test(domainOf(e)));
    if (business.length) return firmKeyOf(business[0]);
    // A personal address is keyed by the ADDRESS, not the domain. firmKeyOf keeps its own,
    // shorter list of free providers and would hand back "d:vsnl.net" — which is how 47
    // unrelated people ended up on one card. The wider list here has to win.
    if (read.emails.length) return 'e:' + lower(read.emails[0]);
    return null;                       // phone-only: its own phase, see below
}

/**
 * The firm's name, in order of how much it can be trusted.
 *
 * The company box first, because somebody typed it on purpose. Then the domain read as a
 * name ("msltubes.com" -> "Msltubes"), which is a guess but an obvious and correctable one.
 * Never the person's name: "Ravi Kumar" as a firm name is a card the owner has to fix, and
 * a blank he can fill is more honest than a wrong name he has to notice.
 */
function firmNameFor(reads) {
    const stated = reads.map((r) => r.company).filter(Boolean)[0];
    if (stated) return stated;
    const business = reads
        .reduce((acc, r) => acc.concat(r.emails), [])
        .filter((e) => !FREE_MAIL.test(domainOf(e)))[0];
    return business ? companyFromEmail(business) : '';
}

/**
 * Group contacts into firms.
 *
 * `emailedDomains` is every domain the owner has ever exchanged mail with, which is what
 * "Contacted" means on the card: a firm he has actually dealt with, as opposed to one that
 * has sat in his phone for years untouched. 251 of 590 firms, when this was written.
 */
function firmsFromPeople(connections, emailedDomains) {
    const seen = emailedDomains instanceof Set
        ? emailedDomains
        : new Set((emailedDomains || []).map(lower));
    const firms = new Map();
    const phoneOnly = [];

    (Array.isArray(connections) ? connections : []).forEach((person) => {
        const read = readPerson(person);
        if (!read.emails.length && !read.phones.length) return;   // a name and nothing else
        const key = firmKeyForContact(read);
        if (!key) { phoneOnly.push(read); return; }
        if (!firms.has(key)) firms.set(key, []);
        firms.get(key).push(read);
    });

    const out = [];
    firms.forEach((reads, key) => {
        const domains = reads
            .reduce((acc, r) => acc.concat(r.emails.map(domainOf)), [])
            .filter((d) => d && !FREE_MAIL.test(d));
        out.push({
            key,
            company: firmNameFor(reads),
            contacted: domains.some((d) => seen.has(d)),
            people: reads,
            emails: [...new Set(reads.reduce((acc, r) => acc.concat(r.emails), []))],
        });
    });

    return { firms: out, phoneOnly };
}

/**
 * A firm, as the review card the owner approves.
 *
 * The ROLE is deliberately left empty. He has no labels in Google Contacts saying what kind
 * of firm each one is, and a guessed role decides who gets sent a freight enquiry — the
 * fifth check, exactly. He picks it as he approves.
 *
 * Part load is left unanswered for the same reason, and the card carries no minimum order:
 * a blank there means "not recorded", never "no minimum".
 */
function previewFromFirm(firm) {
    const people = firm.people.map((r, i) => ({
        name: r.name,
        role: str(r.title) || (i === 0 ? 'Main contact' : ''),
        phones: r.phones.map((v) => ({ label: 'Mobile', v })),
        emails: r.emails.map((v) => ({ label: 'Work', v })),
    }));
    const address = firm.people.map((r) => r.address).filter(Boolean)[0] || '';
    return {
        role: '',                       // the owner's to choose
        company: firm.company,
        people,
        address,
        city: '',
        branches: [], types: [], products: [], rules: [], routes: [], images: [],
        moq: 0,
        partLoad: null,                 // not recorded, never assumed
        notes: notesFrom(firm),
        fromGoogle: true,
        contacted: firm.contacted === true,
    };
}

/**
 * Whatever was typed in the notes box, kept verbatim and dated.
 *
 * It is copied across, never read: on a normal contact it is a line or two of context worth
 * keeping, and pretending to understand it would put guessed facts in real boxes.
 */
function notesFrom(firm) {
    const seen = {};
    return firm.people
        .map((r) => str(r.notes))
        .filter((t) => t && !seen[t] && (seen[t] = true))
        .slice(0, 5)
        .map((t) => ({ t: t.slice(0, 500), d: new Date().toISOString().slice(0, 10) }));
}

/**
 * Firms the owner has looked at himself and said are real suppliers, despite being big.
 *
 * Size is a good signal and a blunt one: nobody keeps forty contacts at a lorry firm, so a
 * big count usually means a project company — a CUSTOMER — whose whole staff has collected
 * in the address book. But seven of them are proper pipe names, and dropping those on a
 * rule would be the sort of silent loss this directory exists to avoid. He read the list
 * and picked these out; nothing here is inferred.
 */
const BIG_BUT_REAL = [
    'jindalpipe.com', 'ismt.co.in', 'mahaseam.com', 'jcopipe.com',
    'jindalsaw.com', 'sicagen.com', 'bhuwalka.in',
];

/** How many people at one firm stops looking like a supplier and starts looking like a customer. */
const CROWDED_FIRM = 10;

/**
 * Split the firms into the ones to import, and the two kinds we hold back.
 *
 * Held back is not the same as thrown away: both lists come back so the owner can be told
 * what was left out and why. A firm silently missing from an import is indistinguishable
 * from one that was never in his contacts.
 */
function sortFirmsForImport(firms, options) {
    const opts = options || {};
    const customers = new Set((opts.customerDomains || []).map(lower));
    const keep = new Set((opts.keepDomains || BIG_BUT_REAL).map(lower));
    const crowdedAt = opts.crowdedAt || CROWDED_FIRM;

    const out = { toImport: [], quotedTo: [], crowded: [] };
    (firms || []).forEach((f) => {
        const domains = (f.emails || []).map(domainOf).filter(Boolean);
        if (domains.some((d) => customers.has(d))) { out.quotedTo.push(f); return; }
        if (domains.some((d) => keep.has(d))) { out.toImport.push(f); return; }
        if ((f.people || []).length >= crowdedAt) { out.crowded.push(f); return; }
        out.toImport.push(f);
    });
    return out;
}

module.exports = {
    BIG_BUT_REAL,
    CROWDED_FIRM,
    sortFirmsForImport,
    readPerson,
    firmKeyForContact,
    firmNameFor,
    firmsFromPeople,
    previewFromFirm,
    notesFrom,
    FREE_MAIL,
};
