'use strict';

/**
 * tests/removals.test.js — taking something off a card waits for approval.
 *
 * The owner's rule: "edits are allowed but anything deleted must go to recent changes and
 * approved". Typing over a number is an edit. Pressing ✕ on one is a request.
 *
 * Nearly every test here is about the same danger. A removal that remembered a POSITION —
 * "take off the third phone number" — would be wrong the moment anything else on that card
 * moved, and wrong silently: approving would delete somebody else's number and look exactly
 * like it had worked. So removals remember the value, find it again by matching, and do
 * nothing at all when it has already gone.
 */

const {
    removalRequest, describeRemoval, applyRemoval, isMarked, samePerson, sizeName,
} = require('../utils/removals');

const card = (over) => Object.assign({
    id: 'p_1', company: 'Sri Steel',
    people: [
        { name: 'Ravi', role: 'Sales', phones: [{ label: 'Mobile', v: '98400 11111' }, { label: 'Office', v: '044 2222' }],
          emails: [{ label: 'Work', v: 'ravi@sristeel.com' }] },
        { name: 'Kumar', role: 'Owner', phones: [{ label: 'Mobile', v: '98400 33333' }],
          emails: [{ label: 'Work', v: 'kumar@sristeel.com' }] },
    ],
    branches: [{ city: 'Salem', area: '', address: 'Bypass Road' }],
    products: [{ p: 'GI pipe', spec: 'IS 1239 Heavy', make: '', moq: 0, rule: '',
                 sizes: [{ nb: '15', inch: '1/2"', od: '21.3', thk: '3.2' }, { nb: '25', inch: '1"', od: '33.4', thk: '3.2' }] }],
    routes: [{ from: 'Chennai', to: 'Hosur' }],
    notes: [{ t: 'Pays in 30 days', d: '2026-08-01' }],
    types: ['GI', 'ERW'],
    rules: ['GST extra'],
}, over);

const ravi = () => card().people[0];

describe('a removal remembers WHAT, never where', () => {
    test('the third phone number is not what gets remembered', () => {
        const req = removalRequest(card(), 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        expect(JSON.stringify(req)).not.toMatch(/"index"|"at":\s*\d/);
        expect(req.value.v).toBe('044 2222');
        expect(req.cardId).toBe('p_1');
    });

    test('the value is copied, so editing the card afterwards cannot change the request', () => {
        const c = card();
        const phone = c.people[0].phones[0];
        const req = removalRequest(c, 'phone', phone, { person: c.people[0] });
        phone.v = 'changed after the fact';
        expect(req.value.v).toBe('98400 11111');
    });
});

describe('carrying out an approved removal', () => {
    test('the right phone number goes, and only that one', () => {
        const c = card();
        const req = removalRequest(c, 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        expect(applyRemoval(c, req).changed).toBe(true);
        expect(c.people[0].phones.map((p) => p.v)).toEqual(['98400 11111']);
        expect(c.people[1].phones).toHaveLength(1);          // Kumar untouched
    });

    test('THE POINT OF ALL THIS: the list moving does not delete the wrong number', () => {
        const c = card();
        // He marks Ravi's office line...
        const req = removalRequest(c, 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        // ...then, before approving, deletes his mobile and adds a new number. By position
        // the request now points at the NEW number.
        c.people[0].phones = [{ label: 'Office', v: '044 2222' }, { label: 'Mobile', v: '99999 88888' }];
        applyRemoval(c, req);
        expect(c.people[0].phones.map((p) => p.v)).toEqual(['99999 88888']);
    });

    test('a number already gone is a quiet no-op, not the nearest match', () => {
        const c = card();
        const req = removalRequest(c, 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        c.people[0].phones = [{ label: 'Mobile', v: '98400 11111' }];
        const r = applyRemoval(c, req);
        expect(r.changed).toBe(false);
        expect(r.reason).toContain('already gone');
        expect(c.people[0].phones).toHaveLength(1);
    });

    test('a person renamed since is still found, because the address matches', () => {
        const c = card();
        const req = removalRequest(c, 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        c.people[0].name = 'Ravi Kumar';                     // renamed while it waited
        expect(applyRemoval(c, req).changed).toBe(true);
        expect(c.people[0].phones).toHaveLength(1);
    });

    test('the contact having gone entirely is said out loud, not guessed around', () => {
        const c = card();
        const req = removalRequest(c, 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        c.people = [c.people[1]];
        const r = applyRemoval(c, req);
        expect(r.changed).toBe(false);
        expect(r.reason).toContain('no longer on the card');
        expect(c.people[0].phones).toHaveLength(1);          // Kumar's number is safe
    });

    test('an email goes the same way', () => {
        const c = card();
        const req = removalRequest(c, 'email', { label: 'Work', v: 'ravi@sristeel.com' }, { person: ravi() });
        expect(applyRemoval(c, req).changed).toBe(true);
        expect(c.people[0].emails).toEqual([]);
        expect(c.people[1].emails).toHaveLength(1);
    });

    test('a whole contact goes', () => {
        const c = card();
        const req = removalRequest(c, 'person', c.people[0]);
        expect(applyRemoval(c, req).changed).toBe(true);
        expect(c.people.map((p) => p.name)).toEqual(['Kumar']);
    });

    test('a branch, a product, a route, a note, a type and a rule all go', () => {
        const c = card();
        const each = [
            ['branch', c.branches[0], 'branches'],
            ['product', c.products[0], 'products'],
            ['route', c.routes[0], 'routes'],
            ['note', c.notes[0], 'notes'],
            ['type', 'GI', 'types'],
            ['rule', 'GST extra', 'rules'],
        ];
        each.forEach(([what, value, list]) => {
            const before = c[list].length;
            expect(applyRemoval(c, removalRequest(c, what, value)).changed).toBe(true);
            expect(c[list]).toHaveLength(before - 1);
        });
        expect(c.types).toEqual(['ERW']);
    });

    test('a size goes off the right product', () => {
        const c = card();
        const req = removalRequest(c, 'size', c.products[0].sizes[1], { product: { p: 'GI pipe' } });
        expect(applyRemoval(c, req).changed).toBe(true);
        expect(c.products[0].sizes.map((s) => s.nb)).toEqual(['15']);
    });

    test('a type is matched whatever the case — SEAMLESS and Seamless are one type', () => {
        const c = card({ types: ['SEAMLESS'] });
        expect(applyRemoval(c, removalRequest(c, 'type', 'seamless')).changed).toBe(true);
        expect(c.types).toEqual([]);
    });

    test('nothing at all does nothing, and does not throw', () => {
        expect(applyRemoval(null, null).changed).toBe(false);
        expect(applyRemoval(card(), null).changed).toBe(false);
        expect(applyRemoval(card(), { what: 'nonsense', value: 'x' }).changed).toBe(false);
    });
});

describe('what the queue line says', () => {
    test('a phone number names the number, the person and the firm', () => {
        const t = describeRemoval(removalRequest(card(), 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() }));
        expect(t).toContain('044 2222');
        expect(t).toContain('Ravi');
        expect(t).toContain('Sri Steel');
    });

    test('a note is quoted, so he knows which one', () => {
        expect(describeRemoval(removalRequest(card(), 'note', { t: 'Pays in 30 days' })))
            .toContain('Pays in 30 days');
    });

    test('a route reads as a route', () => {
        expect(describeRemoval(removalRequest(card(), 'route', { from: 'Chennai', to: 'Hosur' })))
            .toContain('Chennai to Hosur');
    });

    test('a nameless contact is described by their address rather than left blank', () => {
        const anon = { name: '', phones: [], emails: [{ label: 'Work', v: 'x@y.com' }] };
        expect(describeRemoval(removalRequest(card(), 'person', anon))).toContain('x@y.com');
    });
});

describe('marking the same thing twice', () => {
    test('a number already marked is not queued again', () => {
        const req = removalRequest(card(), 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        expect(isMarked([req], 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() })).toBe(true);
    });

    test('and a different number on the same person is not confused with it', () => {
        const req = removalRequest(card(), 'phone', { label: 'Office', v: '044 2222' }, { person: ravi() });
        expect(isMarked([req], 'phone', { label: 'Mobile', v: '98400 11111' }, { person: ravi() })).toBe(false);
    });

    test('the same number under a DIFFERENT person is its own request', () => {
        // Two people at one firm can share a landline. Marking one must not grey out both.
        const c = card();
        const req = removalRequest(c, 'phone', { label: 'Office', v: '044 2222' }, { person: c.people[0] });
        expect(isMarked([req], 'phone', { label: 'Office', v: '044 2222' }, { person: c.people[1] })).toBe(false);
    });
});

describe('telling two contacts apart', () => {
    test('the address wins, because people get renamed more often than they move', () => {
        expect(samePerson({ name: 'Ravi', emails: [{ v: 'r@x.com' }] },
                          { name: 'Ravi Kumar', emails: [{ v: 'r@x.com' }] })).toBe(true);
    });

    test('two different people at one firm are not the same person', () => {
        expect(samePerson({ name: 'Ravi', emails: [{ v: 'ravi@x.com' }] },
                          { name: 'Kumar', emails: [{ v: 'kumar@x.com' }] })).toBe(false);
    });

    test('with no address at all, the name has to do', () => {
        expect(samePerson({ name: 'Ravi', emails: [] }, { name: 'ravi', emails: [] })).toBe(true);
        expect(samePerson({ name: '', emails: [] }, { name: '', emails: [] })).toBe(false);
    });
});
