'use strict';

/**
 * utils/removals.js — taking something off a card is a request, not an act.
 *
 * The owner's rule: "edits are allowed but anything deleted must go to recent changes and
 * approved". Typing over a phone number is an edit and saves like any other. Pressing ✕ on
 * one is a removal, and a removal waits for him in Recent changes until he says yes.
 *
 * THE THING THIS FILE EXISTS TO GET RIGHT is what a removal remembers. The obvious design —
 * "remove the third phone number" — is wrong, and quietly so: between marking it and
 * approving it he may have added a number, deleted another, or edited on his phone. The
 * third phone number is then somebody else's, and approving deletes the wrong one with no
 * way to tell. So a removal remembers the VALUE, and finds it again by matching. If it is
 * already gone, approving does nothing at all rather than taking the nearest thing.
 */

const str = (v) => String(v == null ? '' : v).trim();
const lower = (v) => str(v).toLowerCase();

/** The lists a ✕ can appear on, and how one entry is told from another. */
const REMOVABLE = {
    person: { list: 'people', same: (a, b) => samePerson(a, b), name: (v) => str(v && v.name) || firstMail(v) || 'a contact' },
    branch: { list: 'branches', same: (a, b) => lower(a && a.city) === lower(b && b.city) && lower(a && a.address) === lower(b && b.address), name: (v) => str(v && v.city) || 'a branch' },
    // The whole row is sent with a ✕, so it is matched on everything that tells two rows apart —
    // two "GI pipe" rows that differ only in Specification or Brand are two rows (review, 10 Oct).
    product: { list: 'products', same: (a, b) => sameRow(a, b), name: (v) => str(v && v.p) || 'a product' },
    route: { list: 'routes', same: (a, b) => lower(a && a.from) === lower(b && b.from) && lower(a && a.to) === lower(b && b.to), name: (v) => (str(v && v.from) + ' to ' + str(v && v.to)).trim() },
    note: { list: 'notes', same: (a, b) => lower(a && a.t) === lower(b && b.t), name: (v) => str(v && v.t).slice(0, 60) },
    type: { list: 'types', same: (a, b) => lower(a) === lower(b), name: (v) => str(v) },
    rule: { list: 'rules', same: (a, b) => lower(a) === lower(b), name: (v) => str(v).slice(0, 60) },
};

/** The ones that sit INSIDE a person or a product, so they need `at` to be found. */
const NESTED = ['phone', 'email', 'size', 'brand', 'std'];

/**
 * The makes in one product's Brand box — one per comma, as he typed them.
 *
 * Stored as one line ("TATA, MSL, JSL") because that is what the brand ranking has always
 * read. The dropdown adds to that line and ✕ takes one name out of it; nothing else changes.
 */
function makesOf(product) {
    return str(product && product.make).split(',').map(str).filter(Boolean);
}

/**
 * The product row a brand sits on.
 *
 * By name and specification AND holding that brand: a firm can list "ERW pipe" twice, and rows
 * with no product name at all are common, so the first row with the same name is often the
 * wrong one. The ✕ also sends the row's whole Brand line, and the row must still read exactly
 * that: if it has changed since he marked it, nothing is taken — never the nearest match.
 */
function findBrandRow(card, want, brand) {
    return pickRow((card.products || []).filter((p) => sameRow(p, want) && makesOf(p).some((m) => lower(m) === lower(brand))));
}

/**
 * One row out of the rows a request fits. Rows that read the same in every box that names a
 * row are one choice: the first, the one the card greys out. Rows that differ in a box the
 * request did not send are not guessed between — nothing is taken.
 */
function pickRow(rows) {
    if (rows.length < 2) return rows[0] || null;
    const id = (p) => [p.p, p.spec, p.std, p.make].map(lower).join('|');
    return rows.every((p) => id(p) === id(rows[0])) ? rows[0] : null;
}

/**
 * A product row as a removal names it: name and Details always; the Specification and Brand
 * lines whenever the request carried them (a request made before they were sent has neither).
 */
function sameRow(p, want) {
    return lower(p && p.p) === lower(want && want.p)
        && (!want || want.spec === undefined || lower(p && p.spec) === lower(want.spec))
        && (!want || want.std === undefined || lower(p && p.std) === lower(want.std))
        && (!want || want.make === undefined || lower(p && p.make) === lower(want.make));
}

/** The items in one product's Specification box — one per comma, like the makes. */
function stdOf(product) {
    return str(product && product.std).split(',').map(str).filter(Boolean);
}

/** The product row a specification item sits on — the same care as findBrandRow. */
function findStdRow(card, want, item) {
    return pickRow((card.products || []).filter((p) => sameRow(p, want) && stdOf(p).some((m) => lower(m) === lower(item))));
}

function firstMail(person) {
    return str((((person && person.emails) || [])[0] || {}).v);
}

/**
 * Two contacts are the same person when they share an address, or failing that a name.
 * Matching on the address first matters: he renames people ("Ravi" -> "Ravi Kumar") far more
 * often than they change their email.
 */
function samePerson(a, b) {
    const ma = firstMail(a), mb = firstMail(b);
    if (ma && mb) return lower(ma) === lower(mb);
    return !!str(a && a.name) && lower(a && a.name) === lower(b && b.name);
}

/**
 * A request to take one thing off one card.
 *
 * `at` names the person or product it sits under, for the two nested lists — a phone number
 * on its own is not enough to find, since two people at a firm can share a landline.
 */
function removalRequest(card, what, value, at) {
    if (!card || !REMOVABLE[what] && !NESTED.includes(what)) return null;
    return {
        cardId: str(card.id),
        cardName: str(card.company) || 'this card',
        what,
        value: JSON.parse(JSON.stringify(value == null ? '' : value)),
        at: at ? JSON.parse(JSON.stringify(at)) : null,
        askedAt: new Date().toISOString().slice(0, 10),
    };
}

/** What the queue line says, in the owner's words rather than field names. */
function describeRemoval(req) {
    if (!req) return '';
    const who = req.at && req.at.person ? ' from ' + (str(req.at.person.name) || firstMail(req.at.person)) : '';
    const on = ' on ' + (str(req.cardName) || 'a card');
    switch (req.what) {
        case 'phone': return 'Remove the phone number ' + str(req.value && req.value.v) + who + on;
        case 'email': return 'Remove the address ' + str(req.value && req.value.v) + who + on;
        case 'size': return 'Remove the size ' + sizeName(req.value)
            + (req.at && req.at.product ? ' from ' + str(req.at.product.p) : '') + on;
        case 'brand': return 'Remove the brand ' + str(req.value)
            + (req.at && req.at.product && str(req.at.product.p) ? ' from ' + str(req.at.product.p) : '') + on;
        case 'std': return 'Remove the specification ' + str(req.value)
            + (req.at && req.at.product && str(req.at.product.p) ? ' from ' + str(req.at.product.p) : '') + on;
        default: {
            const meta = REMOVABLE[req.what];
            const label = meta ? meta.name(req.value) : '';
            return 'Remove ' + (label ? '"' + label + '"' : 'an entry') + on;
        }
    }
}

function sizeName(s) {
    return [str(s && s.nb), str(s && s.inch)].filter(Boolean).join(' ') || 'a row';
}

/**
 * Carry out an approved removal.
 *
 * Matched by VALUE every time, never by position. Returns whether anything was actually
 * taken off: if he removed it himself in the meantime, approving must be a quiet no-op and
 * say so, not delete whatever now sits in that slot.
 */
function applyRemoval(card, req) {
    if (!card || !req) return { changed: false, reason: 'nothing to do' };

    if (req.what === 'phone' || req.what === 'email') {
        const person = findPerson(card, req.at && req.at.person);
        if (!person) return { changed: false, reason: 'that contact is no longer on the card' };
        const key = req.what === 'phone' ? 'phones' : 'emails';
        const list = person[key] || [];
        const at = list.findIndex((x) => lower(x && x.v) === lower(req.value && req.value.v));
        if (at === -1) return { changed: false, reason: 'it has already gone' };
        person[key] = list.slice(0, at).concat(list.slice(at + 1));
        return { changed: true };
    }

    if (req.what === 'size') {
        const rows = (card.products || []).filter((p) => sameRow(p, req.at && req.at.product));
        const product = pickRow(rows);
        if (rows.length > 1 && !product) return { changed: false, reason: 'two product rows look the same, so nothing was taken' };
        if (!product) return { changed: false, reason: 'that product is no longer on the card' };
        const list = product.sizes || [];
        const at = list.findIndex((s) => sizeName(s) === sizeName(req.value));
        if (at === -1) return { changed: false, reason: 'it has already gone' };
        product.sizes = list.slice(0, at).concat(list.slice(at + 1));
        return { changed: true };
    }

    if (req.what === 'brand') return removeBrand(card, req);
    if (req.what === 'std') return removeStd(card, req);

    const meta = REMOVABLE[req.what];
    if (!meta) return { changed: false, reason: 'nothing to do' };
    const list = card[meta.list] || [];
    // Never the first of two look-alikes: if a product request matches two rows, nothing goes.
    if (req.what === 'product') {
        const fits = list.filter((x) => meta.same(x, req.value));
        if (fits.length > 1 && !pickRow(fits)) return { changed: false, reason: 'two product rows look the same, so nothing was taken' };
    }
    const at = list.findIndex((x) => meta.same(x, req.value));
    if (at === -1) return { changed: false, reason: 'it has already gone' };
    card[meta.list] = list.slice(0, at).concat(list.slice(at + 1));
    return { changed: true };
}

/** One make out of one product's Brand box, found by name — never by its place in the line. */
function removeBrand(card, req) {
    const product = findBrandRow(card, req.at && req.at.product, req.value);
    if (!product) return { changed: false, reason: 'it has already gone, or that product row has changed since' };
    const makes = makesOf(product);
    const at = makes.findIndex((m) => lower(m) === lower(req.value));
    if (at === -1) return { changed: false, reason: 'it has already gone' };
    product.make = makes.slice(0, at).concat(makes.slice(at + 1)).join(', ');
    return { changed: true };
}

/** One item out of one product's Specification box, found by its words — never by its place. */
function removeStd(card, req) {
    const product = findStdRow(card, req.at && req.at.product, req.value);
    if (!product) return { changed: false, reason: 'it has already gone, or that product row has changed since' };
    const items = stdOf(product);
    const at = items.findIndex((m) => lower(m) === lower(req.value));
    if (at === -1) return { changed: false, reason: 'it has already gone' };
    product.std = items.slice(0, at).concat(items.slice(at + 1)).join(', ');
    return { changed: true };
}

function findPerson(card, want) {
    return (card.people || []).filter((p) => samePerson(p, want))[0] || null;
}

/**
 * Is this thing already marked for removal?
 *
 * The card greys out what is waiting, so pressing ✕ twice must not queue it twice — and the
 * owner needs to see at a glance which of two identical-looking numbers he already marked.
 */
function isMarked(requests, what, value, at) {
    const want = removalRequest({ id: '', company: '' }, what, value, at);
    if (!want) return false;
    return (requests || []).some((r) => r && r.what === what
        && JSON.stringify(r.value) === JSON.stringify(want.value)
        && JSON.stringify(r.at || null) === JSON.stringify(want.at || null));
}

module.exports = {
    REMOVABLE, removalRequest, describeRemoval, applyRemoval, isMarked, samePerson, sizeName, makesOf, stdOf,
};
