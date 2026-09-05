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
    product: { list: 'products', same: (a, b) => lower(a && a.p) === lower(b && b.p) && lower(a && a.spec) === lower(b && b.spec), name: (v) => str(v && v.p) || 'a product' },
    route: { list: 'routes', same: (a, b) => lower(a && a.from) === lower(b && b.from) && lower(a && a.to) === lower(b && b.to), name: (v) => (str(v && v.from) + ' to ' + str(v && v.to)).trim() },
    note: { list: 'notes', same: (a, b) => lower(a && a.t) === lower(b && b.t), name: (v) => str(v && v.t).slice(0, 60) },
    type: { list: 'types', same: (a, b) => lower(a) === lower(b), name: (v) => str(v) },
    rule: { list: 'rules', same: (a, b) => lower(a) === lower(b), name: (v) => str(v).slice(0, 60) },
};

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
    if (!card || !REMOVABLE[what] && what !== 'phone' && what !== 'email' && what !== 'size') return null;
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
        const product = (card.products || []).filter((p) => lower(p && p.p) === lower(req.at && req.at.product && req.at.product.p))[0];
        if (!product) return { changed: false, reason: 'that product is no longer on the card' };
        const list = product.sizes || [];
        const at = list.findIndex((s) => sizeName(s) === sizeName(req.value));
        if (at === -1) return { changed: false, reason: 'it has already gone' };
        product.sizes = list.slice(0, at).concat(list.slice(at + 1));
        return { changed: true };
    }

    const meta = REMOVABLE[req.what];
    if (!meta) return { changed: false, reason: 'nothing to do' };
    const list = card[meta.list] || [];
    const at = list.findIndex((x) => meta.same(x, req.value));
    if (at === -1) return { changed: false, reason: 'it has already gone' };
    card[meta.list] = list.slice(0, at).concat(list.slice(at + 1));
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
    REMOVABLE, removalRequest, describeRemoval, applyRemoval, isMarked, samePerson, sizeName,
};
