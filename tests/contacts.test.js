/**
 * tests/contacts.test.js
 *
 * Guards utils/contacts.js — the Partner Directory's server-side data logic.
 * Pure module (no I/O), so everything here is exercised for real: no mocks, no fixtures
 * the app could never produce.
 *
 * What these tests exist to stop happening again:
 *  - a whole import sharing ONE id, so editing or deleting one partner hit them all
 *  - a second tab's stale copy wiping a colleague's note (CLAUDE.md check #2)
 *  - an AI import overwriting a card the owner curated by hand
 *  - our own address (or an example.com placeholder) becoming a "supplier"
 *  - the change log/undo failing to put a bad import back the way it was
 *  - a blank find row inventing a value the email never contained (CLAUDE.md check #5)
 *
 * And the two rules the owner stated in their own words, which the module now enforces:
 *  - "even when you import, it must sit under the approval space — dont add anything without
 *    approval": NOTHING reaches the directory except through approval. The import queues
 *    drafts; bumpUsage no longer turns an unknown address into a card.
 *  - "same companies must not create multiple": one firm, one card. Four addresses at
 *    jindalhissar.com are four colleagues at one mill — offering them as four suppliers put
 *    four separate enquiries in front of people who could not see each other.
 *
 * House rule for this file: a negative assertion (`not.toContain`) is never left to carry a
 * behaviour on its own — deleting the behaviour only makes a negative MORE true. Every field
 * the module tracks has a POSITIVE assertion somewhere below.
 */

const fs = require('fs');
const path = require('path');

const contactsLib = require('../utils/contacts');

const {
    ROLES, sanitizePartner, mergePartner, findByEmail, allEmails, bumpUsage,
    pendingFromSuggestions, pendingFromUsage, dropAlreadyQueued, MAX_PENDING, queueWithoutLosingAny,
    companyFromEmail, changeEntry, pushChange, diffLines,
    undoChange, sanitizePendingItem, extractionPrompt, findsFromExtraction,
} = contactsLib;

const { normalizeRole, sanitizePerson, sanitizePeople, firmKeyOf } = contactsLib._test;

/** Today, read at the moment it is needed — a module-load constant flakes across midnight. */
function todayStamp() { return new Date().toISOString().slice(0, 10); }

/**
 * Assert a date stamp was written "now". `before` is todayStamp() captured just before the
 * call; the only other legal answer is today read again now (the midnight rollover case).
 */
function expectStampedToday(value, before) {
    expect([before, todayStamp()]).toContain(value);
}

/** Every address across the previews of a queue of pending items, flattened. */
function queuedEmails(items) {
    return (items || []).reduce((acc, it) => acc.concat(allEmails(it.preview)), []);
}

/** The domain half of an address — the thing that must not appear on two cards at once. */
function domainOf(email) { return String(email).split('@')[1] || ''; }

function person(name, emails) {
    return { name, role: 'Main contact', emails: (emails || []).map(v => ({ label: 'Work', v })) };
}

/** n distinct saved cards, for the storage-cap tests. */
function manyCards(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(sanitizePartner({
            id: 'p_bulk_' + i, company: 'Firm ' + i,
            people: [person('P' + i, ['p' + i + '@bulk' + i + '.in'])],
        }));
    }
    return out;
}

/** Run fn with Date.now and Math.random pinned, then put both back exactly as they were. */
function withFrozenEntropy(nowMs, randomFn, fn) {
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => nowMs;
    Math.random = randomFn;
    try { return fn(); } finally { Date.now = realNow; Math.random = realRandom; }
}

// ── the role list itself ─────────────────────────────────────────────────────

describe('ROLES', () => {
    test('is the exact set the UI filter and normalizeRole both depend on', () => {
        // The browser builds its role filter from this list; dropping one hides every partner
        // of that kind from the directory.
        expect(ROLES).toEqual(['dealer', 'manufacturer', 'transporter', 'fabricator', 'other']);
    });
});

// ── unique ids ───────────────────────────────────────────────────────────────

describe('partner ids are unique', () => {
    // The bug that shipped: the id was built from a truncated timestamp, so an import that
    // ran inside a single millisecond gave 21 of 22 partners the SAME id. Editing one edited
    // them all; deleting one deleted them all. The fix was the counter in newPartnerId().

    test('the counter alone keeps 500 ids apart when the clock AND the random suffix are frozen', () => {
        // Deterministic on purpose: with Math.random pinned to a constant the ONLY thing that
        // can separate these ids is the counter — the actual fix. Leaving the randomness live
        // would let the test pass on luck with the counter deleted.
        const ids = withFrozenEntropy(1756000000000, () => 0.5, () => {
            const acc = [];
            for (let i = 0; i < 500; i++) acc.push(sanitizePartner({ company: 'Firm ' + i }).id);
            return acc;
        });
        expect(ids).toHaveLength(500);
        expect(new Set(ids).size).toBe(500);
    });

    test('a random tail is appended as well, because the counter wraps at a million', () => {
        // The counter is not a standalone guarantee: two ids drawn one full wrap apart share a
        // counter value, and only the random tail then separates them. Pinned by stubbing the
        // RNG to a known constant and checking that constant's fingerprint reaches the id —
        // deterministic, unlike "generate lots and hope none collide".
        const id = withFrozenEntropy(1756000000000, () => 0.7654321,
            () => sanitizePartner({ company: 'A' }).id);
        expect(id.endsWith('rk000')).toBe(true);   // (0.7654321).toString(36).slice(2, 7)
    });

    test('a 22-firm import (the batch that broke) yields 22 distinct queue ids and 22 distinct preview ids', () => {
        // Same bug, now one step earlier: the import builds QUEUE items, and the card the owner
        // reviews is `preview`, whose id is derived from the item id. Colliding ids here mean
        // approving one item edits or approves another firm's draft.
        const res = withFrozenEntropy(1756000000000, () => 0.5, () => {
            const transporters = [];
            for (let i = 0; i < 22; i++) transporters.push({ email: 'office' + i + '@carrier' + i + '.in', count: 1 });
            return pendingFromSuggestions([], { transporters }, null);
        });
        expect(res.queued).toBe(22);
        expect(res.items).toHaveLength(22);
        expect(new Set(res.items.map(it => it.id)).size).toBe(22);
        expect(new Set(res.items.map(it => it.preview.id)).size).toBe(22);
        res.items.forEach(it => { expect(it.preview.id).toBe('p_new_' + it.id); });
    });

    test('an id already on the record is kept, never re-issued', () => {
        // mergePartner/undoChange match on id — re-issuing one on every save would orphan the card.
        expect(sanitizePartner({ id: 'p_keepme', company: 'X' }).id).toBe('p_keepme');
    });
});

// ── the whole partner record ─────────────────────────────────────────────────

describe('sanitizePartner keeps every field the card shows', () => {
    // Each of these fields is something the owner typed and expects to see again. Any one of
    // them silently hard-coded to '' or [] loses real data with nothing else noticing.
    const full = sanitizePartner({
        id: 'p_full',
        role: 'Lorry Transport',
        roleOther: 'Also does scrap',
        company: 'Sri Logistics',
        city: 'Chennai',
        address: '12 Anna Salai, Guindy',
        vehicles: '20ft, 32ft MXL, trailer',
        moq: 12,
        rules: ['Payment 30 days', 'Rate revised quarterly'],
        branches: [
            { city: 'Hosur', area: 'SIPCOT', address: 'Plot 14' },
            { city: '', area: '', address: '' },
        ],
        images: [{ n: 'brochure.pdf', kind: 'pdf', d: '2026-08-01', count: 3 }, { n: '' }],
        fromWeb: true,
        people: [{
            name: 'Ravi',
            role: 'Owner',
            phones: [{ label: 'Mobile', v: '9876543210' }, { label: 'Office', v: '044-22334455' }],
            emails: [{ label: 'Work', v: 'ravi@srilogistics.com' }],
        }],
    });

    test('the firm-level fields survive', () => {
        expect(full.role).toBe('transporter');
        expect(full.roleOther).toBe('Also does scrap');
        expect(full.company).toBe('Sri Logistics');
        expect(full.city).toBe('Chennai');
        expect(full.address).toBe('12 Anna Salai, Guindy');
        expect(full.vehicles).toBe('20ft, 32ft MXL, trailer');
        expect(full.moq).toBe(12);
        expect(full.rules).toEqual(['Payment 30 days', 'Rate revised quarterly']);
        expect(full.fromWeb).toBe(true);
    });

    test('branches survive, and an entirely blank branch row is dropped', () => {
        expect(full.branches).toEqual([{ city: 'Hosur', area: 'SIPCOT', address: 'Plot 14' }]);
    });

    test('kept files survive, and a nameless one is dropped', () => {
        expect(full.images).toEqual([{ n: 'brochure.pdf', kind: 'pdf', d: '2026-08-01', count: 3 }]);
    });

    test("a person's name, role and every labelled phone survive", () => {
        expect(full.people).toHaveLength(1);
        expect(full.people[0].name).toBe('Ravi');
        expect(full.people[0].role).toBe('Owner');
        expect(full.people[0].phones).toEqual([
            { label: 'Mobile', v: '9876543210' },
            { label: 'Office', v: '044-22334455' },
        ]);
        expect(full.people[0].emails).toEqual([{ label: 'Work', v: 'ravi@srilogistics.com' }]);
    });

    test('fromWeb and fromEnquiry are strict — only a real true sets them', () => {
        expect(sanitizePartner({ fromWeb: 'true' }).fromWeb).toBe(false);
        expect(sanitizePartner({ fromEnquiry: 1 }).fromEnquiry).toBe(false);
        expect(sanitizePartner({ fromEnquiry: true }).fromEnquiry).toBe(true);
    });

    test('partLoad defaults to YES — a transporter takes part loads unless told otherwise', () => {
        // The default matters commercially: defaulting to "no part loads" would quietly rule
        // every transporter out of the small consignments that are most of the freight work.
        expect(sanitizePartner({}).partLoad).toBe(true);
        expect(sanitizePartner({ partLoad: undefined }).partLoad).toBe(true);
        expect(sanitizePartner({ partLoad: true }).partLoad).toBe(true);
        expect(sanitizePartner({ partLoad: false }).partLoad).toBe(false);
    });
});

describe('product sizes — the point of the products list', () => {
    // Module header: "15 NB heavy is 3.2 mm while 100 NB heavy is 5.4 mm — never a range".
    // Sizes are the reason a product is a list rather than a sentence; losing them makes the
    // product row useless for quoting.
    test('every size row survives with its own nb/inch/od/thk', () => {
        const p = sanitizePartner({
            products: [{
                p: 'GI Pipe', spec: 'IS 1239 Heavy', moq: 5, rule: 'ex-Chennai only',
                sizes: [
                    { nb: '15', inch: '1/2"', od: '21.3', thk: '3.2' },
                    { nb: '100', inch: '4"', od: '114.3', thk: '5.4' },
                ],
            }],
        });
        expect(p.products).toHaveLength(1);
        expect(p.products[0].spec).toBe('IS 1239 Heavy');
        expect(p.products[0].moq).toBe(5);
        expect(p.products[0].rule).toBe('ex-Chennai only');
        expect(p.products[0].sizes).toEqual([
            { nb: '15', inch: '1/2"', od: '21.3', thk: '3.2' },
            { nb: '100', inch: '4"', od: '114.3', thk: '5.4' },
        ]);
    });

    test('a wholly blank size row is dropped rather than shown as an empty line', () => {
        const p = sanitizePartner({
            products: [{ p: 'GI Pipe', sizes: [{ nb: '15' }, { nb: '', inch: '', od: '', thk: '' }, {}] }],
        });
        expect(p.products[0].sizes).toEqual([{ nb: '15', inch: '', od: '', thk: '' }]);
    });

    test('a product with only sizes (no name yet) is still kept', () => {
        const p = sanitizePartner({ products: [{ p: '', spec: '', sizes: [{ nb: '15' }] }] });
        expect(p.products).toHaveLength(1);
    });
});

// ── storage caps: this whole directory is one JSON blob ──────────────────────

describe('storage caps — the directory is a single JSON blob, so every list is capped', () => {
    function repeat(n, make) { const out = []; for (let i = 0; i < n; i++) out.push(make(i)); return out; }

    test('a card holds at most 12 people, 20 branches, 40 products, 60 sizes, 40 routes', () => {
        const p = sanitizePartner({
            people: repeat(20, i => person('P' + i, ['p' + i + '@x.in'])),
            branches: repeat(30, i => ({ city: 'C' + i })),
            products: repeat(50, i => ({ p: 'Prod ' + i })),
            routes: repeat(50, i => ({ from: 'F' + i, to: 'T' + i })),
        });
        expect(p.people).toHaveLength(12);
        expect(p.branches).toHaveLength(20);
        expect(p.products).toHaveLength(40);
        expect(p.routes).toHaveLength(40);

        const sized = sanitizePartner({ products: [{ p: 'GI', sizes: repeat(70, i => ({ nb: String(i) })) }] });
        expect(sized.products[0].sizes).toHaveLength(60);
    });

    test('a person holds at most 6 phones and 6 emails', () => {
        const p = sanitizePerson({
            name: 'Ravi',
            phones: repeat(10, i => ({ label: 'L' + i, v: '900000000' + i })),
            emails: repeat(10, i => ({ label: 'L' + i, v: 'a' + i + '@x.in' })),
        });
        expect(p.phones).toHaveLength(6);
        expect(p.emails).toHaveLength(6);
    });

    test('notes are capped at 100, and one note at 2000 characters', () => {
        const p = sanitizePartner({
            notes: repeat(150, i => ({ d: '2026-08-01', t: 'note ' + i })).concat([
                { d: '2026-08-01', t: 'x'.repeat(5000) },
            ]),
        });
        expect(p.notes).toHaveLength(100);
        expect(sanitizePartner({ notes: [{ t: 'x'.repeat(5000) }] }).notes[0].t).toHaveLength(2000);
    });

    test('pipe types are capped at 10 and free-text rules at 20', () => {
        const p = sanitizePartner({
            types: repeat(30, i => 'T' + i),
            rules: repeat(30, i => 'Rule ' + i),
        });
        expect(p.types).toHaveLength(10);
        expect(p.rules).toHaveLength(20);
    });

    test('the directory itself never exceeds 2000 cards — approve is now the only door', () => {
        const base = manyCards(2000);

        const merged = mergePartner(base, { company: 'Newest Traders' }, ['company']);
        expect(merged.contacts).toHaveLength(2000);
        expect(merged.contacts[0].company).toBe('Newest Traders');
        expect(merged.contacts[1999].company).toBe('Firm 1998');   // the oldest fell off the end

        // The two automatic doors are shut: neither grows the directory at all any more.
        const bumped = bumpUsage(base, { emails: ['brand.new@nowhere.in'] });
        expect(bumped.contacts).toHaveLength(2000);
        expect(bumped.contacts[0].company).toBe('Firm 0');
        expect(bumped.unknown).toEqual(['brand.new@nowhere.in']);
    });

    test('bumpUsage reads at most 50 addresses from one send', () => {
        const emails = [];
        for (let i = 0; i < 60; i++) emails.push('bulk' + i + '@carrier' + i + '.in');
        expect(bumpUsage([], { emails }).unknown).toHaveLength(50);
    });

    test('the approval queue holds a whole import at once — 300, not the old 50', () => {
        // A 24-firm import behind whatever was already queued would have had its tail silently
        // dropped by the route's old inline cap of 50. Room for the biggest realistic import.
        expect(MAX_PENDING).toBe(300);
    });

    describe('queueWithoutLosingAny — a full queue never eats what is already in it', () => {
        const item = (id) => ({ id, preview: { company: 'Firm ' + id } });
        const many = (n, p) => Array.from({ length: n }, (_, i) => item(p + i));

        test('with room to spare, new ones go on top and everything is kept', () => {
            const r = queueWithoutLosingAny(many(3, 'old'), many(2, 'new'), 10);
            expect(r.items.map((x) => x.id)).toEqual(['new0', 'new1', 'old0', 'old1', 'old2']);
            expect(r.queued).toBe(2);
            expect(r.noRoom).toBe(0);
        });

        test('when it will not all fit, the OLD queue survives and the new ones are cut', () => {
            // The whole bug: it used to be the other way round, silently.
            const existing = many(8, 'old');
            const r = queueWithoutLosingAny(existing, many(5, 'new'), 10);
            expect(r.items).toHaveLength(10);
            existing.forEach((x) => expect(r.items.map((i) => i.id)).toContain(x.id));
            expect(r.queued).toBe(2);
            expect(r.noRoom).toBe(3);       // and it says how many did not fit
        });

        test('a queue already at the cap takes nothing, and loses nothing', () => {
            const existing = many(10, 'old');
            const r = queueWithoutLosingAny(existing, many(4, 'new'), 10);
            expect(r.items.map((x) => x.id)).toEqual(existing.map((x) => x.id));
            expect(r.queued).toBe(0);
            expect(r.noRoom).toBe(4);
        });

        test('a queue OVER the cap is not trimmed as a side effect', () => {
            // Trimming here would delete waiting items on an unrelated write.
            const existing = many(12, 'old');
            const r = queueWithoutLosingAny(existing, [], 10);
            expect(r.items).toHaveLength(12);
            expect(r.noRoom).toBe(0);
        });

        test('nothing incoming means nothing changes', () => {
            const existing = many(3, 'old');
            const r = queueWithoutLosingAny(existing, [], 10);
            expect(r.items.map((x) => x.id)).toEqual(existing.map((x) => x.id));
            expect(r.queued).toBe(0);
        });

        test('missing arguments do not throw', () => {
            expect(queueWithoutLosingAny(null, null, 10).items).toEqual([]);
            expect(queueWithoutLosingAny(undefined, [item('a')], 10).queued).toBe(1);
        });
    });
});

// ── labelled phone/email lines ───────────────────────────────────────────────

describe('labelled phone and email lines', () => {
    test('a line with no label is filed under "Other", not left blank', () => {
        // The card groups lines by label; a blank label renders a headless row.
        const p = sanitizePerson({ name: 'Ravi', phones: [{ v: '9876543210' }] });
        expect(p.phones).toEqual([{ label: 'Other', v: '9876543210' }]);
    });

    test('a labelled line with no value is dropped, not shown as an empty row', () => {
        const p = sanitizePerson({
            name: 'Ravi',
            phones: [{ label: 'Mobile', v: '' }, { label: 'Office', v: '   ' }, { label: 'Home', v: '044-1' }],
        });
        expect(p.phones).toEqual([{ label: 'Home', v: '044-1' }]);
    });
});

// ── mergePartner: field-scoped writes ────────────────────────────────────────

describe('mergePartner — a stale copy must not overwrite a fresh one', () => {
    function storedCard() {
        return sanitizePartner({
            id: 'p_sri',
            company: 'Sri Logistics',
            city: 'Chennai',
            people: [person('Ravi', ['ravi@srilogistics.com'])],
            notes: [
                { d: '2026-08-01', t: 'Old note both tabs have' },
                { d: '2026-08-20', t: 'Colleague: rate revised to 2.10 per kg' },
            ],
            products: [{ p: 'GI Pipe', moq: 5 }],
            checked: '2026-01-01',
        });
    }

    test('with fields given, only those fields come from the incoming copy', () => {
        // Two tabs: tab A loaded the card before the colleague added their note, then saves
        // the city. The colleague's note and the products must survive that save.
        const stored = storedCard();
        const staleFromTabA = Object.assign({}, stored, {
            city: 'Madurai',
            notes: [{ d: '2026-08-01', t: 'Old note both tabs have' }],
            products: [],
            checked: '',
        });

        const res = mergePartner([stored], staleFromTabA, ['city']);

        expect(res.contacts).toHaveLength(1);
        expect(res.partner.city).toBe('Madurai');
        expect(res.partner.notes.map(n => n.t)).toEqual([
            'Old note both tabs have',
            'Colleague: rate revised to 2.10 per kg',
        ]);
        expect(res.partner.products).toHaveLength(1);
        expect(res.contacts[0].notes).toHaveLength(2);
    });

    test('a field-scoped save still stamps the card as just-checked', () => {
        const stored = storedCard();
        const stale = Object.assign({}, stored, { city: 'Madurai', checked: '' });
        const at = todayStamp();
        const res = mergePartner([stored], stale, ['city']);
        expect(stored.checked).toBe('2026-01-01');      // the caller's copy is not mutated
        expectStampedToday(res.partner.checked, at);
    });

    test('only a caller that asks for no scoping at all gets a wholesale replace', () => {
        const stored = storedCard();
        const incoming = Object.assign({}, stored, { company: 'Sri Logistics Pvt Ltd', notes: [] });

        // No field list = the caller deliberately asked to save the whole record.
        const wholesale = mergePartner([stored], incoming);
        expect(wholesale.partner.company).toBe('Sri Logistics Pvt Ltd');
        expect(wholesale.partner.notes).toEqual([]);
    });

    test('a field list that names nothing real writes nothing — it does NOT fall through to a full overwrite', () => {
        // The dangerous case: a caller narrows its save but the field has since been renamed
        // (or was mistyped). Treating "nothing valid to scope to" as "replace everything" turns
        // the one argument that exists to PREVENT a stale-copy overwrite into the cause of one.
        const stored = storedCard();
        const incoming = Object.assign({}, stored, { company: 'Sri Logistics Pvt Ltd', notes: [] });

        const unknownFields = mergePartner([stored], incoming, ['bogusField']);
        expect(unknownFields.partner.company).toBe(stored.company);
        expect(unknownFields.partner.notes).toEqual(stored.notes);

        const emptyFields = mergePartner([stored], incoming, []);
        expect(emptyFields.partner.company).toBe(stored.company);
        expect(emptyFields.partner.notes).toEqual(stored.notes);
    });

    test('a brand-new card with nothing on it is never created', () => {
        // A client that saves before anything is typed puts an empty row in the directory —
        // it happened twice, live. The button that caused it is gone, but /contacts/add-apply
        // still leans on this guard, so it stays. The client no longer does, and the server refuses to create
        // one either — a blank new row is only ever an accident.
        const held = storedCard();
        const res = mergePartner([held], {
            company: '', people: [{ name: '', role: 'Main contact', phones: [], emails: [] }],
        });
        expect(res.empty).toBe(true);
        expect(res.partner).toBeNull();
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].id).toBe(held.id);
    });

    test('anything that says who they are IS worth creating', () => {
        // The mixed set is what pins it — a guard that refused everything, or accepted
        // everything, fails on one of these four.
        const worth = [
            { what: 'a firm name', card: { company: 'Balaji Tubes' } },
            { what: 'a person', card: { company: '', people: [{ name: 'Ravi', phones: [], emails: [] }] } },
            { what: 'a phone', card: { company: '', people: [{ name: '', phones: [{ label: 'Mobile', v: '9840012345' }], emails: [] }] } },
            { what: 'an address', card: { company: '', people: [{ name: '', phones: [], emails: [{ label: 'Work', v: 'ravi@balajitubes.com' }] }] } },
        ];
        worth.forEach(({ what, card }) => {
            const res = mergePartner([], card);
            expect(`${what}: ${res.empty === true}`).toBe(`${what}: false`);
            expect(res.contacts).toHaveLength(1);
        });
    });

    test('emptying a card that already exists is still the owner\'s business', () => {
        // The refusal is on CREATION only. Clearing a card they already have is a deliberate
        // act, and blocking it would be us overruling them on their own data.
        const held = storedCard();
        const res = mergePartner([held], Object.assign({}, held, {
            company: '', people: [{ name: '', role: '', phones: [], emails: [] }],
        }));
        expect(res.empty).toBeUndefined();
        expect(res.contacts).toHaveLength(1);
        expect(res.partner.company).toBe('');
    });

    test("the caller's list and the caller's stored card are both left untouched", () => {
        // CLAUDE.md check #2. The route handler holds the list it just read from storage and
        // writes back what mergePartner returns; if the merge also edited that list in place,
        // a failed or abandoned write would still have changed what the caller believes it has.
        const stored = storedCard();
        const list = [stored];

        mergePartner(list, Object.assign({}, stored, { city: 'Madurai' }), ['city']);
        expect(list).toHaveLength(1);
        expect(list[0]).toBe(stored);
        expect(list[0].city).toBe('Chennai');

        mergePartner(list, { company: 'Brand New Traders' }, ['company']);
        expect(list).toHaveLength(1);
    });

    test('an id that is not in the list is added, not merged over an existing card', () => {
        const stored = storedCard();
        const res = mergePartner([stored], { company: 'Brand New Traders' }, ['company']);
        expect(res.contacts).toHaveLength(2);
        expect(res.contacts[0].company).toBe('Brand New Traders');
        expect(res.contacts[1].company).toBe('Sri Logistics');
    });
});

// ── one firm, one card ───────────────────────────────────────────────────────

describe('firmKeyOf — a business domain IS the firm, a free-mail address is only a person', () => {
    test('two people at one mill share a key; two gmail users never do', () => {
        expect(firmKeyOf('manish@jcopipe.com')).toBe(firmKeyOf('cp@jcopipe.com'));
        expect(firmKeyOf('ravi@gmail.com')).not.toBe(firmKeyOf('suresh@gmail.com'));
    });

    test('two different mills do not share a key', () => {
        expect(firmKeyOf('sales@jcopipe.com')).not.toBe(firmKeyOf('sales@jindalhissar.com'));
    });

    test('the sub-domain is part of the firm, and case is not', () => {
        expect(firmKeyOf('Sales@Mail.JcoPipe.com')).toBe(firmKeyOf('other@mail.jcopipe.com'));
        expect(firmKeyOf('sales@mail.jcopipe.com')).not.toBe(firmKeyOf('sales@jcopipe.com'));
    });

    test('two DIFFERENT mills behind the same sub-domain label stay apart', () => {
        // The whole domain is the firm, not its first label. Keying on the label alone reads
        // both of these as a firm called "Mail" — one card holding two mills' staff, so an
        // enquiry meant for one goes to the other's people. Every assertion above survives
        // that mutation; this is the one that does not.
        expect(firmKeyOf('a@mail.jcopipe.com')).not.toBe(firmKeyOf('b@mail.jindalhissar.com'));
    });

    test('every free-mail provider stays per-person, not one giant "Gmail" supplier', () => {
        ['gmail.com', 'yahoo.co.in', 'rediffmail.com', 'hotmail.com', 'outlook.com'].forEach(host => {
            expect(firmKeyOf('ravi@' + host)).not.toBe(firmKeyOf('suresh@' + host));
        });
    });
});

// ── pendingFromSuggestions ───────────────────────────────────────────────────

describe('pendingFromSuggestions — the remembered addresses WAIT for approval', () => {
    const ENV_KEY = 'OWN_EMAIL_DOMAINS';
    let savedOwn;
    beforeEach(() => { savedOwn = process.env[ENV_KEY]; });
    afterEach(() => {
        if (savedOwn === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedOwn;
    });

    test('a transporter address becomes a review item whose preview is the draft card', () => {
        const res = pendingFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 3, lastUsed: '2026-08-01' }],
        }, null);
        expect(res.items).toHaveLength(1);
        expect(res.queued).toBe(1);

        const item = res.items[0];
        expect(item.origin).toBe('import');
        expect(item.from).toBe('ravi@srilogistics.com');
        expect(item.subject).toBe('Sri Logistics');
        expect(item.finds).toEqual([{
            kind: 'field', key: 'email',
            label: 'Address you have used', value: 'ravi@srilogistics.com',
        }]);
        expect(Number.isNaN(Date.parse(item.receivedAt))).toBe(false);

        const p = item.preview;
        expect(p.role).toBe('transporter');
        expect(p.company).toBe('Sri Logistics');
        expect(allEmails(p)).toEqual(['ravi@srilogistics.com']);
        expect(p.fromEnquiry).toBe(true);
        expect(p.enq).toBe(3);
        expect(p.last).toBe('2026-08-01');
        expect(p.id).toBe('p_new_' + item.id);
    });

    test('THE DIRECTORY IS NOT TOUCHED — the import returns queue items, never partners', () => {
        // The owner's rule in their own words: "even when you import, it must sit under the
        // approval space — dont add anything without approval". The old importFromSuggestions
        // wrote straight into the directory, and no test could catch it because the function
        // returned the directory. Now the list handed in must come back out unchanged.
        const existing = [sanitizePartner({
            id: 'p_a', company: 'Curated A', people: [person('X', ['x@curated-a.in'])],
        })];
        const snapshot = JSON.parse(JSON.stringify(existing));
        const before = existing[0];

        const res = pendingFromSuggestions(existing, {
            transporters: [{ email: 'ravi@srilogistics.com', count: 2 }],
        }, { suppliers: [{ email: 'sales@kalpatarusteel.com', count: 1 }] });

        expect(existing).toHaveLength(1);
        expect(existing[0]).toBe(before);
        expect(existing).toEqual(snapshot);

        // Nothing that comes back is a partner list, and no item is a partner record: the only
        // partner-shaped thing on an item is the `preview` the owner has yet to approve.
        expect(res.contacts).toBeUndefined();
        expect(res.added).toBeUndefined();
        expect(Object.keys(res).sort()).toEqual(['items', 'queued', 'skippedAddresses', 'skippedFirms']);
        expect(res.items).toHaveLength(2);
        res.items.forEach(it => {
            expect(it.id).toMatch(/^pd_/);
            expect(it.origin).toBe('import');
            expect(it.people).toBeUndefined();
            expect(it.company).toBeUndefined();
            expect(it.preview.people.length).toBeGreaterThan(0);
        });
    });

    test('a firm that hauls for us AND sells to us stays a transporter', () => {
        // The SAME address sits in both remembered files for a firm we use both ways. The
        // later "dealer" entry used to bury the earlier "transporter", and the firm then never
        // appeared in the transporter list at all — so it stopped being offered for freight.
        const res = pendingFromSuggestions([],
            { transporters: [{ email: 'ops@speedelexpress.com', count: 4, lastUsed: '2026-08-01' }] },
            { suppliers: [{ email: 'ops@speedelexpress.com', count: 1, lastUsed: '2026-07-01' }] });

        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.role).toBe('transporter');

        // and the same however the two files are read — a firm listed as a supplier first
        // must not end up a dealer just because freight came second
        const other = pendingFromSuggestions([],
            { transporters: [{ email: 'ops@srilogistics.com', count: 1 }] },
            { byType: { erw: [{ email: 'ops@srilogistics.com', count: 9 }] } });
        expect(other.items[0].preview.role).toBe('transporter');
    });

    test('ONE FIRM, ONE CARD — four colleagues at one mill are one item, not four suppliers', () => {
        // The live bug the owner hit: the directory offered "Jindalhissar" FOUR times. Sending
        // would have put four separate enquiries in front of four colleagues at one mill, none
        // of them able to see the others — the exact opposite of the rule they stated.
        const res = pendingFromSuggestions([], {
            transporters: [
                { email: 'ops@speedelexpress.com', count: 5, lastUsed: '2026-08-01' },
                { email: 'billing@speedelexpress.com', count: 1, lastUsed: '2026-07-01' },
            ],
        }, {
            suppliers: [
                { email: 'sales@jindalhissar.com', count: 9, lastUsed: '2026-08-10' },
                { email: 'marketing@jindalhissar.com', count: 4, lastUsed: '2026-08-02' },
                { email: 'exports@jindalhissar.com', count: 2, lastUsed: '2026-07-20' },
                { email: 'accounts@jindalhissar.com', count: 1, lastUsed: '2026-06-01' },
                { email: 'manish@jcopipe.com', count: 3, lastUsed: '2026-08-05' },
                { email: 'cp@jcopipe.com', count: 2, lastUsed: '2026-08-06' },
                { email: 'ravi.stockist@gmail.com', count: 4, lastUsed: '2026-08-07' },
                { email: 'suresh.tubes@gmail.com', count: 2, lastUsed: '2026-08-08' },
                { email: 'kumar.pipes@gmail.com', count: 1, lastUsed: '2026-08-09' },
            ],
        });

        // three real firms + three unrelated gmail people = six cards to approve
        expect(res.items).toHaveLength(6);
        expect(res.queued).toBe(6);

        const jindal = res.items.filter(it => it.preview.company === 'Jindalhissar');
        expect(jindal).toHaveLength(1);
        expect(jindal[0].preview.people).toHaveLength(4);
        expect(allEmails(jindal[0].preview).sort()).toEqual([
            'accounts@jindalhissar.com', 'exports@jindalhissar.com',
            'marketing@jindalhissar.com', 'sales@jindalhissar.com',
        ]);
        // The firm's history is the best of its people's, not whichever address came first.
        expect(jindal[0].preview.enq).toBe(9);
        expect(jindal[0].preview.last).toBe('2026-08-10');

        const jco = res.items.filter(it => it.preview.company === 'Jco Pipe');
        expect(jco).toHaveLength(1);
        expect(allEmails(jco[0].preview).sort()).toEqual(['cp@jcopipe.com', 'manish@jcopipe.com']);

        const speedel = res.items.filter(it => it.preview.company === 'Speedelexpress');
        expect(speedel).toHaveLength(1);
        expect(allEmails(speedel[0].preview)).toHaveLength(2);

        // A gmail address proves nothing about the firm, so each stays on its own card —
        // merging them would put two unrelated people into one supplier.
        const gmailItems = res.items.filter(it => allEmails(it.preview).some(e => domainOf(e) === 'gmail.com'));
        expect(gmailItems).toHaveLength(3);
        expect(gmailItems.map(it => it.preview.company).sort())
            .toEqual(['kumar.pipes@gmail.com', 'ravi.stockist@gmail.com', 'suresh.tubes@gmail.com']);

        // The negative that actually pins it: NO business domain may appear on two cards.
        // (firmKeyOf returning the whole address would put each jindalhissar person on their own.)
        const cardsPerDomain = {};
        res.items.forEach(it => allEmails(it.preview).forEach(e => {
            const d = domainOf(e);
            if (d === 'gmail.com') return;
            cardsPerDomain[d] = (cardsPerDomain[d] || []).concat([it.id]);
        }));
        expect(Object.keys(cardsPerDomain).sort())
            .toEqual(['jcopipe.com', 'jindalhissar.com', 'speedelexpress.com']);
        Object.keys(cardsPerDomain).forEach(d => {
            expect([d, new Set(cardsPerDomain[d]).size]).toEqual([d, 1]);
        });
    });

    test('used as a transporter even once, the whole firm is a transporter', () => {
        // Role decides which list the firm appears in. One address at the firm used for freight
        // and another for supply must not leave the card filed as a dealer.
        const res = pendingFromSuggestions([],
            { transporters: [{ email: 'ops@speedelexpress.com', count: 2 }] },
            { suppliers: [{ email: 'billing@speedelexpress.com', count: 1 }] });
        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.role).toBe('transporter');
    });

    test('a firm with SOME addresses already held is proposed as an UPDATE to that card', () => {
        // Matching looks at every person on the card, because the remembered address is often
        // a person's second address. The curated card must gain the missing colleague — not
        // find a duplicate firm sitting beside it.
        const existing = sanitizePartner({
            id: 'p_sri',
            company: 'Sri Logistics (curated by owner)',
            people: [
                person('Reception', ['front.desk@srilogistics.com']),
                person('Ravi', ['ravi.office@srilogistics.com', 'ravi@srilogistics.com']),
            ],
        });

        const res = pendingFromSuggestions([existing], {
            transporters: [
                { email: 'ravi@srilogistics.com', count: 9, lastUsed: '2026-08-10' },
                { email: 'accounts@srilogistics.com', count: 3, lastUsed: '2026-08-11' },
            ],
        }, null);

        expect(res.items).toHaveLength(1);            // one firm, one card — not a second "Sri"
        expect(res.skippedFirms).toBe(0);
        expect(res.skippedAddresses).toBe(1);         // ravi@ was already held

        const p = res.items[0].preview;
        expect(p.matchId).toBe('p_sri');              // approve UPDATES the existing card
        expect(p.id).toBe('p_new_' + res.items[0].id);   // ...but the draft is not that card
        expect(p.company).toBe('Sri Logistics (curated by owner)');
        expect(p.people).toHaveLength(3);             // the two curated people, plus the new one
        expect(allEmails(p)).toEqual([
            'front.desk@srilogistics.com',
            'ravi.office@srilogistics.com', 'ravi@srilogistics.com',
            'accounts@srilogistics.com',
        ]);
        // Only the genuinely new address is offered — the known one is not re-added.
        expect(res.items[0].finds.map(f => f.value)).toEqual(['accounts@srilogistics.com']);
        expect(existing.people).toHaveLength(2);      // the stored card itself is untouched
    });

    test('a firm whose addresses are ALL already held is skipped entirely', () => {
        const existing = sanitizePartner({
            id: 'p_sri',
            company: 'Sri Logistics (curated by owner)',
            people: [person('Ravi', ['ravi@srilogistics.com', 'accounts@srilogistics.com'])],
        });

        const res = pendingFromSuggestions([existing], {
            transporters: [
                { email: 'ravi@srilogistics.com', count: 9 },
                { email: 'accounts@srilogistics.com', count: 3 },
                { email: 'vrl@vrlgroup.in', count: 2 },
            ],
        }, null);

        expect(res.items).toHaveLength(1);
        expect(queuedEmails(res.items)).toEqual(['vrl@vrlgroup.in']);
        expect(res.queued).toBe(1);
        expect(res.skippedFirms).toBe(1);
        expect(res.skippedAddresses).toBe(2);
    });

    test('our own domain is excluded — dscpipes.com by default', () => {
        // Our address lands in the remembered files whenever an enquiry is copied to ourselves.
        // Queueing it invites the owner to approve their own firm as its own supplier.
        delete process.env[ENV_KEY];
        const res = pendingFromSuggestions([], {
            transporters: [{ email: 'info@dscpipes.com' }, { email: 'ravi@srilogistics.com' }],
        }, null);
        expect(queuedEmails(res.items)).toEqual(['ravi@srilogistics.com']);
        expect(res.queued).toBe(1);
    });

    test('OWN_EMAIL_DOMAINS overrides the default, and takes a comma list', () => {
        process.env[ENV_KEY] = 'mypipes.in, second.co';
        const res = pendingFromSuggestions([], {
            transporters: [
                { email: 'a@mypipes.in' },
                { email: 'b@second.co' },
                { email: 'info@dscpipes.com' },   // no longer "ours" once the env names others
            ],
        }, null);
        expect(queuedEmails(res.items)).toEqual(['info@dscpipes.com']);
        expect(res.queued).toBe(1);
    });

    test('example.com / example.org placeholders are excluded', () => {
        const res = pendingFromSuggestions([], {
            transporters: [
                { email: 'test@example.com' },
                { email: 'demo@example.org' },
                { email: 'ravi@srilogistics.com' },
            ],
        }, null);
        expect(queuedEmails(res.items)).toEqual(['ravi@srilogistics.com']);
        expect(res.queued).toBe(1);
    });

    test('one address seen twice keeps the HIGHEST count and the NEWEST date', () => {
        // Real history is the whole reason for the import: this transporter was asked 7 times,
        // most recently in August. The global entry is read first and the route entry second,
        // so a merge that simply keeps whatever it saw first would report the July date.
        const res = pendingFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 7, lastUsed: '2026-07-01' }],
            routes: [{
                pickup: 'Chennai', drop: 'Hyderabad',
                transporters: [{ email: 'ravi@srilogistics.com', count: 2, lastUsed: '2026-08-01' }],
            }],
        }, null);
        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.enq).toBe(7);
        expect(res.items[0].preview.last).toBe('2026-08-01');
    });

    test('and the other way round — the newest date wins whichever order it arrives in', () => {
        const res = pendingFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 2, lastUsed: '2026-08-01' }],
            routes: [{
                pickup: 'Chennai', drop: 'Hyderabad',
                transporters: [{ email: 'ravi@srilogistics.com', count: 7, lastUsed: '2026-07-01' }],
            }],
        }, null);
        expect(res.items[0].preview.enq).toBe(7);
        expect(res.items[0].preview.last).toBe('2026-08-01');
    });

    test('last comes from lastUsed as a date only, not the full timestamp', () => {
        const res = pendingFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 1, lastUsed: '2026-08-01T09:30:00.000Z' }],
        }, null);
        expect(res.items[0].preview.last).toBe('2026-08-01');
    });

    test('routes are deduped (case/spacing ignored), keeping each distinct lane once', () => {
        const res = pendingFromSuggestions([], {
            routes: [
                { pickup: 'Chennai', drop: 'Hyderabad', transporters: [{ email: 'ravi@srilogistics.com' }] },
                { pickup: 'chennai', drop: 'HYDERABAD', transporters: [{ email: 'ravi@srilogistics.com' }] },
                { pickup: 'Chennai', drop: 'Mumbai', transporters: [{ email: 'ravi@srilogistics.com' }] },
            ],
        }, null);
        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.routes).toEqual([
            { from: 'Chennai', to: 'Hyderabad' },
            { from: 'Chennai', to: 'Mumbai' },
        ]);
    });

    test('two people at one firm pool their lanes onto the single card', () => {
        // The dedupe has to survive the grouping: one firm's card carries every lane its people
        // were used for, each lane once.
        const res = pendingFromSuggestions([], {
            routes: [
                { pickup: 'Chennai', drop: 'Hyderabad', transporters: [{ email: 'ops@speedelexpress.com' }] },
                { pickup: 'Chennai', drop: 'Hyderabad', transporters: [{ email: 'billing@speedelexpress.com' }] },
                { pickup: 'Chennai', drop: 'Mumbai', transporters: [{ email: 'billing@speedelexpress.com' }] },
            ],
        }, null);
        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.routes).toEqual([
            { from: 'Chennai', to: 'Hyderabad' },
            { from: 'Chennai', to: 'Mumbai' },
        ]);
    });

    test('pipe types are uppercased and deduped', () => {
        const res = pendingFromSuggestions([], null, {
            byType: {
                erw: [{ email: 'sales@kalpatarusteel.com', count: 1 }],
                ERW: [{ email: 'sales@kalpatarusteel.com', count: 1 }],
                gi: [{ email: 'sales@kalpatarusteel.com', count: 1 }],
            },
        });
        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.types).toEqual(['ERW', 'GI']);
        expect(res.items[0].preview.role).toBe('dealer');
    });

    test('queued + skippedFirms + skippedAddresses describe what actually happened', () => {
        const existing = sanitizePartner({ company: 'Known', people: [person('X', ['known@x.in'])] });
        const res = pendingFromSuggestions([existing], {
            transporters: [{ email: 'known@x.in' }, { email: 'new1@y.in' }],
        }, { suppliers: [{ email: 'new2@z.in' }, { email: 'known@x.in' }] });
        expect(res.queued).toBe(2);
        expect(res.items).toHaveLength(2);
        expect(res.skippedFirms).toBe(1);      // x.in — its only address is already held
        expect(res.skippedAddresses).toBe(1);  // one address, seen twice, is one skip
    });
});

// ── findByEmail ──────────────────────────────────────────────────────────────

describe('findByEmail', () => {
    const card = sanitizePartner({
        id: 'p_sri',
        company: 'Sri Logistics',
        people: [
            person('Reception', ['front.desk@srilogistics.com']),
            person('Ravi', ['ravi.office@srilogistics.com', 'ravi@srilogistics.com']),
        ],
    });
    const other = sanitizePartner({ company: 'Other', people: [person('Z', ['z@other.in'])] });

    test('searches every person on the card, not just the first address', () => {
        expect(findByEmail([other, card], 'ravi@srilogistics.com')).toBe(card);
        expect(findByEmail([other, card], 'front.desk@srilogistics.com')).toBe(card);
        expect(findByEmail([other, card], 'nobody@srilogistics.com')).toBeNull();
    });

    test('matching ignores case on both sides', () => {
        // The stored address is however the person typed it; the address we look up comes
        // out of a mail header. Either side may be capitalised.
        const mixedCase = sanitizePartner({ company: 'Mixed', people: [person('Boss', ['Suresh@SriLogistics.COM'])] });
        expect(findByEmail([mixedCase], 'suresh@srilogistics.com')).toBe(mixedCase);
        expect(findByEmail([mixedCase], 'SURESH@SRILOGISTICS.COM')).toBe(mixedCase);
    });

    test('a blank or missing address matches nothing — it must never return the first card', () => {
        // bumpUsage and the import both branch on this. Returning a card for a blank address
        // would count every unattributed send against whoever happens to be top of the list.
        expect(findByEmail([other, card], '')).toBeNull();
        expect(findByEmail([other, card], null)).toBeNull();
        expect(findByEmail([other, card], '   ')).toBeNull();
        expect(findByEmail([], 'ravi@srilogistics.com')).toBeNull();
        expect(findByEmail(null, 'ravi@srilogistics.com')).toBeNull();
    });
});

// ── bumpUsage ────────────────────────────────────────────────────────────────

describe('bumpUsage — the directory learns from what we send and receive', () => {
    function known() {
        return sanitizePartner({
            id: 'p_known', company: 'Sri Logistics',
            people: [person('Ravi', ['ravi@srilogistics.com'])],
        });
    }

    const ENV_KEY = 'OWN_EMAIL_DOMAINS';
    let savedOwn;
    beforeEach(() => { savedOwn = process.env[ENV_KEY]; });
    afterEach(() => {
        if (savedOwn === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedOwn;
    });

    test("kind:'reply' counts a reply, not an enquiry", () => {
        const res = bumpUsage([known()], { emails: ['ravi@srilogistics.com'], kind: 'reply' });
        expect(res.contacts[0].rep).toBe(1);
        expect(res.contacts[0].enq).toBe(0);
        expect(res.unknown).toEqual([]);
    });

    test('anything else counts an enquiry, not a reply', () => {
        const res = bumpUsage([known()], { emails: ['ravi@srilogistics.com'], kind: 'enquiry' });
        expect(res.contacts[0].enq).toBe(1);
        expect(res.contacts[0].rep).toBe(0);
        const noKind = bumpUsage([known()], { emails: ['ravi@srilogistics.com'] });
        expect(noKind.contacts[0].enq).toBe(1);
        expect(noKind.contacts[0].rep).toBe(0);
    });

    test('an address we have never seen NO LONGER becomes a partner — it waits for approval', () => {
        // The owner's rule: "dont add anything without approval". A stub card used to appear
        // in the directory the moment an enquiry went out to a new address. Both halves matter:
        // the directory gained nothing, AND the address is handed back to be queued for review.
        const res = bumpUsage([], {
            emails: ['ops@vrlgroup.in'], kind: 'enquiry', role: 'transporter',
            pipeTypes: ['ERW'], pickup: 'Chennai', drop: 'Hyderabad',
        });
        expect(res.contacts).toEqual([]);
        expect(res.unknown).toEqual(['ops@vrlgroup.in']);
    });

    test('a known firm is bumped and a new address queued in the same send', () => {
        // The realistic case: an enquiry to five transporters, two of them already on file.
        const res = bumpUsage([known()], {
            emails: ['ravi@srilogistics.com', 'ops@vrlgroup.in'], kind: 'enquiry',
        });
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].enq).toBe(1);
        expect(res.unknown).toEqual(['ops@vrlgroup.in']);
    });

    test('our own domain and example.com never even reach the approval queue', () => {
        // Copying ourselves on an enquiry must not offer our own firm as a supplier, and the
        // test placeholders left in the remembered files are not partners either.
        delete process.env[ENV_KEY];
        const res = bumpUsage([], {
            emails: ['info@dscpipes.com', 'test@example.com', 'demo@example.org', 'ops@vrlgroup.in'],
        });
        expect(res.contacts).toEqual([]);
        expect(res.unknown).toEqual(['ops@vrlgroup.in']);
    });

    test('OWN_EMAIL_DOMAINS decides which domain is "ours" for the queue too', () => {
        process.env[ENV_KEY] = 'mypipes.in';
        const res = bumpUsage([], { emails: ['a@mypipes.in', 'info@dscpipes.com'] });
        expect(res.unknown).toEqual(['info@dscpipes.com']);
    });

    test('an excluded address the owner DELIBERATELY added is still bumped', () => {
        // Exclusion decides what gets OFFERED, never what gets counted. A colleague's
        // dscpipes.com address put on a card by hand is a real partner and its stats must move.
        delete process.env[ENV_KEY];
        const ours = sanitizePartner({
            id: 'p_ours', company: 'Our Hosur Depot',
            people: [person('Depot', ['depot@dscpipes.com'])],
        });
        const res = bumpUsage([ours], { emails: ['depot@dscpipes.com'], kind: 'enquiry' });
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].enq).toBe(1);
        expect(res.unknown).toEqual([]);
    });

    test("'last' is stamped with today", () => {
        const at = todayStamp();
        const res = bumpUsage([known()], { emails: ['ravi@srilogistics.com'], kind: 'reply' });
        expectStampedToday(res.contacts[0].last, at);
    });

    test('an address already on a card is counted there, never duplicated', () => {
        let list = [known()];
        list = bumpUsage(list, { emails: ['RAVI@srilogistics.com'], kind: 'enquiry' }).contacts;
        list = bumpUsage(list, { emails: ['ravi@srilogistics.com'], kind: 'enquiry' }).contacts;
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('p_known');
        expect(list[0].enq).toBe(2);
    });

    test("the caller's list and the caller's card are not edited in place", () => {
        // CLAUDE.md check #2 — the route writes back what bumpUsage returns, so a bump that
        // also mutated the list the caller read means a failed write still changed the record.
        const card = known();
        const stored = [card];
        const res = bumpUsage(stored, { emails: ['ravi@srilogistics.com'], kind: 'enquiry' });
        expect(stored).toHaveLength(1);
        expect(stored[0]).toBe(card);
        expect(card.enq).toBe(0);
        expect(res.contacts[0].enq).toBe(1);
        expect(res.contacts).toHaveLength(1);
    });

    test('rubbish that is not an address creates nothing and queues nothing', () => {
        const res = bumpUsage([], { emails: ['not-an-email', '   ', 'ravi@srilogistics.com'] });
        expect(res.contacts).toEqual([]);
        expect(res.unknown).toEqual(['ravi@srilogistics.com']);
    });
});

// ── pendingFromUsage and dropAlreadyQueued ───────────────────────────────────

describe('pendingFromUsage — a new address we just wrote to waits for approval', () => {
    const ENV_KEY = 'OWN_EMAIL_DOMAINS';
    let savedOwn;
    beforeEach(() => { savedOwn = process.env[ENV_KEY]; });
    afterEach(() => {
        if (savedOwn === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedOwn;
    });

    const usage = {
        kind: 'enquiry', role: 'transporter', pipeTypes: ['ERW'],
        pickup: 'Chennai', drop: 'Hyderabad',
    };

    test('the queued draft arrives with the context of the enquiry that found it', () => {
        // A nameless address the owner cannot place is a card they will never approve.
        const items = pendingFromUsage([], [], ['ops@vrlgroup.in'], usage);
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(item.origin).toBe('import');
        expect(item.from).toBe('ops@vrlgroup.in');
        expect(item.preview.company).toBe('Vrl Group');       // guessed from the domain
        expect(item.preview.role).toBe('transporter');
        expect(item.preview.types).toEqual(['ERW']);
        expect(item.preview.routes).toEqual([{ from: 'Chennai', to: 'Hyderabad' }]);
        expect(allEmails(item.preview)).toEqual(['ops@vrlgroup.in']);
        expect(item.preview.id).toBe('p_new_' + item.id);
    });

    test('a free-mail draft falls back to the address, because the domain says nothing', () => {
        const items = pendingFromUsage([], [], ['ravi.transport@gmail.com'], usage);
        expect(items[0].preview.company).toBe('ravi.transport@gmail.com');
    });

    test('a colleague at a firm we ALREADY hold is an update to that card, never a second firm', () => {
        // The owner's rule leaked here: this path matched on the exact address, so emailing
        // a new person at a firm already in the directory queued a brand-new firm. Approving
        // it put a duplicate mill beside the card the owner had curated.
        const held = sanitizePartner({
            company: 'Jco Pipe (curated by owner)', city: 'Mumbai',
            people: [{ name: 'Manish', emails: [{ label: 'Work', v: 'manish@jcopipe.com' }] }],
        });
        const items = pendingFromUsage([held], [], ['cp@jcopipe.com'], usage);

        expect(items).toHaveLength(1);
        expect(items[0].preview.matchId).toBe(held.id);       // an UPDATE, not a new firm
        expect(items[0].subject).toBe('Jco Pipe (curated by owner)');
        expect(items[0].preview.company).toBe('Jco Pipe (curated by owner)');
        expect(items[0].preview.city).toBe('Mumbai');         // what they typed is kept
        expect(allEmails(items[0].preview).sort())
            .toEqual(['cp@jcopipe.com', 'manish@jcopipe.com']);
    });

    test('the same firm reached again on a later send is not queued a second time', () => {
        // Monday to manish@, Tuesday to cp@ — one mill, one card to approve, not two.
        const monday = pendingFromUsage([], [], ['manish@jcopipe.com'], usage);
        const tuesday = pendingFromUsage([], monday, ['cp@jcopipe.com'], usage);
        expect(tuesday).toHaveLength(0);
        // and a genuinely different firm in the same send still gets through
        const mixed = pendingFromUsage([], monday, ['cp@jcopipe.com', 'ops@vrlgroup.in'], usage);
        expect(mixed).toHaveLength(1);
        expect(mixed[0].preview.company).toBe('Vrl Group');
    });

    test('several new people at ONE new firm queue as ONE item', () => {
        // Same rule as the import: emailing three colleagues at a mill must offer one card
        // with three people, not three suppliers nobody can Cc together.
        const items = pendingFromUsage([], [],
            ['manish@jcopipe.com', 'cp@jcopipe.com', 'exports@jcopipe.com'], usage);
        expect(items).toHaveLength(1);
        expect(items[0].preview.people).toHaveLength(3);
        expect(allEmails(items[0].preview).sort())
            .toEqual(['cp@jcopipe.com', 'exports@jcopipe.com', 'manish@jcopipe.com']);
    });

    test('two gmail addresses stay two cards — nothing proves they are one firm', () => {
        const items = pendingFromUsage([], [], ['ravi@gmail.com', 'suresh@gmail.com'], usage);
        expect(items).toHaveLength(2);
    });

    test('an address already in the directory is not queued', () => {
        const existing = sanitizePartner({
            id: 'p_sri', company: 'Sri Logistics',
            people: [person('Ravi', ['ravi@srilogistics.com'])],
        });
        const items = pendingFromUsage([existing], [],
            ['ravi@srilogistics.com', 'ops@vrlgroup.in'], usage);
        expect(items).toHaveLength(1);
        expect(items[0].from).toBe('ops@vrlgroup.in');
    });

    test('two enquiries to the same new address queue it ONCE', () => {
        // Sending on Monday and again on Tuesday must leave one card to approve, not two.
        const first = pendingFromUsage([], [], ['ops@vrlgroup.in'], usage);
        expect(first).toHaveLength(1);
        const second = pendingFromUsage([], first, ['ops@vrlgroup.in'], usage);
        expect(second).toEqual([]);
    });

    // NOT GUARDED HERE, deliberately — two real gaps found while writing these tests, both the
    // same "one firm, one card" rule leaking on the USAGE path only (the import path handles
    // both). `pendingFromUsage` matches on the exact address, never on the firm:
    //   1. enquiry Monday to manish@jcopipe.com, Tuesday to cp@jcopipe.com → TWO cards to
    //      approve for one mill;
    //   2. jcopipe.com already in the directory under manish@, enquiry to cp@ → the draft has
    //      no `matchId`, so approving creates a duplicate firm beside the curated card.
    // Writing a passing test for either would mean asserting the wrong answer is right, so
    // they are reported instead of pinned. Both are fixed by keying `already`/the directory
    // lookup on firmKeyOf, the same way pendingFromSuggestions does.

    test('one address repeated inside a single send queues once', () => {
        const items = pendingFromUsage([], [],
            ['ops@vrlgroup.in', 'OPS@vrlgroup.in'], usage);
        expect(items).toHaveLength(1);
        expect(allEmails(items[0].preview)).toEqual(['ops@vrlgroup.in']);
    });

    test('our own domain, example.com and rubbish are never queued', () => {
        delete process.env[ENV_KEY];
        const items = pendingFromUsage([], [],
            ['info@dscpipes.com', 'test@example.com', 'not-an-email', '   '], usage);
        expect(items).toEqual([]);
    });

    test('a gmail-queued item blocks the same address arriving from the label', () => {
        // The Gmail-label queue item has no preview, only `from`. It must still count as
        // "already waiting", or the same firm sits in the queue twice.
        const fromLabel = sanitizePendingItem({ from: 'ops@vrlgroup.in', subject: 'Our rates' });
        expect(fromLabel.preview).toBeNull();
        expect(pendingFromUsage([], [fromLabel], ['ops@vrlgroup.in'], usage)).toEqual([]);
    });
});

describe('dropAlreadyQueued — pressing Import twice must not stack the same card up', () => {
    function suggestions() {
        return {
            transporters: [
                { email: 'ops@speedelexpress.com', count: 5, lastUsed: '2026-08-01' },
                { email: 'billing@speedelexpress.com', count: 1, lastUsed: '2026-07-01' },
                { email: 'vrl@vrlgroup.in', count: 2, lastUsed: '2026-08-02' },
            ],
        };
    }

    test('the first press queues everything, the second press queues nothing', () => {
        const first = pendingFromSuggestions([], suggestions(), null).items;
        expect(dropAlreadyQueued([], first)).toHaveLength(2);

        // The route re-runs the import from scratch, so the second run builds NEW items with
        // new ids for the same firms. Matching must be on the addresses, not the item id.
        const second = pendingFromSuggestions([], suggestions(), null).items;
        expect(second.map(it => it.id)).not.toEqual(first.map(it => it.id));
        expect(dropAlreadyQueued(first, second)).toEqual([]);
    });

    test('a firm not yet in the queue still gets through', () => {
        const queued = pendingFromSuggestions([], {
            transporters: [{ email: 'vrl@vrlgroup.in', count: 2 }],
        }, null).items;
        const proposed = pendingFromSuggestions([], suggestions(), null).items;

        const fresh = dropAlreadyQueued(queued, proposed);
        expect(queuedEmails(fresh).sort())
            .toEqual(['billing@speedelexpress.com', 'ops@speedelexpress.com']);
    });

    test('ANY address on the draft matching the queue is enough — a colleague is not a new firm', () => {
        // The queued card holds two people. A proposal that arrives holding only one of them
        // is the same firm and must be dropped.
        const queued = pendingFromSuggestions([], suggestions(), null).items;
        const proposed = pendingFromSuggestions([], {
            transporters: [{ email: 'billing@speedelexpress.com', count: 1 }],
        }, null).items;
        expect(proposed).toHaveLength(1);
        expect(dropAlreadyQueued(queued, proposed)).toEqual([]);
    });

    test('an item held from the Gmail label blocks a proposal for that same address', () => {
        const fromLabel = sanitizePendingItem({ from: 'vrl@vrlgroup.in', subject: 'Our rates' });
        const proposed = pendingFromSuggestions([], suggestions(), null).items;
        const fresh = dropAlreadyQueued([fromLabel], proposed);
        expect(queuedEmails(fresh).sort())
            .toEqual(['billing@speedelexpress.com', 'ops@speedelexpress.com']);
    });

    test("the proposal's OTHER addresses count too — the item may be filed under a colleague", () => {
        // A labelled email arrived from billing@, so that is what the queue holds. The import
        // then proposes the whole firm, and files its draft under ops@ (the first address it
        // found). Comparing only the draft's `from` misses the overlap and queues the firm
        // twice — one card per address, which is the duplicate-firm bug all over again.
        const fromLabel = sanitizePendingItem({ from: 'billing@speedelexpress.com', subject: 'Our rates' });
        const proposed = pendingFromSuggestions([], suggestions(), null).items;
        const speedel = proposed.find(it => it.from === 'ops@speedelexpress.com');
        expect(speedel).toBeTruthy();
        expect(allEmails(speedel.preview)).toContain('billing@speedelexpress.com');

        const fresh = dropAlreadyQueued([fromLabel], proposed);
        expect(queuedEmails(fresh)).toEqual(['vrl@vrlgroup.in']);
    });

    test('an empty queue drops nothing, and nothing proposed is not an error', () => {
        const proposed = pendingFromSuggestions([], suggestions(), null).items;
        expect(dropAlreadyQueued([], proposed)).toHaveLength(2);
        expect(dropAlreadyQueued(null, proposed)).toHaveLength(2);
        expect(dropAlreadyQueued(proposed, [])).toEqual([]);
        expect(dropAlreadyQueued(proposed, null)).toEqual([]);
    });
});

// ── companyFromEmail ─────────────────────────────────────────────────────────

describe('companyFromEmail — a guess from the domain, never from a free-mail one', () => {
    test('splits the trade word off the domain', () => {
        expect(companyFromEmail('sales@kalpatarusteel.com')).toBe('Kalpataru Steel');
        expect(companyFromEmail('info@bharatpipes.co.in')).toBe('Bharat Pipes');
    });

    test('separators in the domain are words too', () => {
        expect(companyFromEmail('ops@vrl-logistics.com')).toBe('Vrl Logistics');
    });

    test('a free-mail address says nothing about the firm, so it returns blank', () => {
        expect(companyFromEmail('ravi@gmail.com')).toBe('');
        expect(companyFromEmail('ravi@rediffmail.com')).toBe('');
        expect(companyFromEmail('ravi@yahoo.co.in')).toBe('');
    });
});

// ── the change log and undo ──────────────────────────────────────────────────

describe('the change log — what the app did on its own', () => {
    function baseCard(extra) {
        return sanitizePartner(Object.assign({
            id: 'p_sri', company: 'Sri Logistics', city: 'Chennai',
            address: '12 Anna Salai', vehicles: '20ft', moq: 5, types: ['GI'],
            people: [person('Ravi', ['ravi@srilogistics.com'])],
        }, extra || {}));
    }

    test('EVERY watched field is recorded when it moves, with what it was and what it became', () => {
        // Positive coverage for all six watched fields. The old version of this suite only ever
        // asserted the City line and then used not.toContain() for the rest — which stayed green
        // with Company, Address, Vehicles, MOQ and Pipe-type tracking deleted outright.
        const before = baseCard();
        const after = Object.assign({}, before, {
            company: 'Sri Logistics Pvt Ltd',
            city: 'Madurai',
            address: '99 Mount Road',
            vehicles: '32ft MXL',
            moq: 10,
            types: ['GI', 'ERW'],
        });
        const byLabel = {};
        diffLines(before, after).forEach(l => { byLabel[l.label] = l; });

        expect(byLabel.Company).toEqual({ label: 'Company', from: 'Sri Logistics', to: 'Sri Logistics Pvt Ltd' });
        expect(byLabel.City).toEqual({ label: 'City', from: 'Chennai', to: 'Madurai' });
        expect(byLabel.Address).toEqual({ label: 'Address', from: '12 Anna Salai', to: '99 Mount Road' });
        expect(byLabel.Vehicles).toEqual({ label: 'Vehicles', from: '20ft', to: '32ft MXL' });
        expect(byLabel['Overall MOQ']).toEqual({ label: 'Overall MOQ', from: '5 T', to: '10 T' });
        expect(byLabel['Pipe types']).toEqual({ label: 'Pipe types', from: 'GI', to: 'GI, ERW' });
    });

    test('only the field that actually moved is recorded', () => {
        // The log is how the owner sees what the AI touched — a line for an untouched field
        // makes a harmless import look like a rewrite. Asserted as an EXACT list, so a diff
        // that pushes every field unconditionally fails here rather than quietly passing.
        const before = baseCard();
        const after = Object.assign({}, before, { city: 'Madurai' });
        expect(diffLines(before, after).map(l => l.label)).toEqual(['City']);
    });

    test('a first-ever card (no before) reports the fields it arrived with', () => {
        const after = { company: 'Brand New Traders', city: 'Hosur', moq: 3, types: ['ERW'] };
        const byLabel = {};
        diffLines(null, after).forEach(l => { byLabel[l.label] = l; });
        expect(byLabel.Company).toEqual({ label: 'Company', from: '', to: 'Brand New Traders' });
        expect(byLabel.City).toEqual({ label: 'City', from: '', to: 'Hosur' });
        expect(byLabel['Overall MOQ']).toEqual({ label: 'Overall MOQ', from: '0 T', to: '3 T' });
        expect(byLabel['Pipe types']).toEqual({ label: 'Pipe types', from: '', to: 'ERW' });
    });

    test('a new product is recorded with its MOQ and rule', () => {
        const before = baseCard();
        const after = Object.assign({}, before, {
            products: [{ p: 'GI Pipe', spec: 'IS 1239', moq: 5, rule: 'ex-Chennai only' }],
        });
        const line = diffLines(before, after).find(l => l.label === 'Product added');
        expect(line).toBeTruthy();
        expect(line.to).toContain('GI Pipe');
        expect(line.to).toContain('min 5 T');
        expect(line.to).toContain('ex-Chennai only');
    });

    test("a product's changed MOQ is recorded under the product's own name", () => {
        const before = baseCard({ products: [{ p: 'GI Pipe', moq: 5 }] });
        const after = Object.assign({}, before, { products: [{ p: 'GI Pipe', moq: 10 }] });
        const line = diffLines(before, after).find(l => l.label === 'GI Pipe');
        expect(line).toBeTruthy();
        expect(line.from).toContain('min 5 T');
        expect(line.to).toContain('min 10 T');
    });

    test('an unchanged product produces no line at all', () => {
        const before = baseCard({ products: [{ p: 'GI Pipe', moq: 5, rule: 'ex-Chennai only' }] });
        const after = Object.assign({}, before, { products: [{ p: 'GI Pipe', moq: 5, rule: 'ex-Chennai only' }] });
        expect(diffLines(before, after)).toEqual([]);
    });

    test('an added route is recorded', () => {
        const before = baseCard({ routes: [{ from: 'Chennai', to: 'Hyderabad' }] });
        const after = Object.assign({}, before, {
            routes: [{ from: 'Chennai', to: 'Hyderabad' }, { from: 'Chennai', to: 'Mumbai' }],
        });
        const lines = diffLines(before, after).filter(l => l.label === 'Route added');
        expect(lines).toHaveLength(1);
        expect(lines[0].to).toContain('Mumbai');
    });

    test('an added note is recorded, the note already there is not', () => {
        const before = baseCard({ notes: [{ d: '2026-08-01', t: 'Old note' }] });
        const after = Object.assign({}, before, {
            notes: [{ d: '2026-08-01', t: 'Old note' }, { d: '2026-08-20', t: 'Pays in 30 days' }],
        });
        const lines = diffLines(before, after).filter(l => l.label === 'Note added');
        expect(lines).toHaveLength(1);
        expect(lines[0].to).toBe('Pays in 30 days');
    });

    test('a kept file is recorded', () => {
        const before = baseCard();
        const after = Object.assign({}, before, { images: [{ n: 'brochure.pdf', kind: 'pdf' }] });
        const line = diffLines(before, after).find(l => l.label === 'File kept');
        expect(line).toBeTruthy();
        expect(line.to).toBe('brochure.pdf');
    });

    test('changeEntry freezes the before-snapshot, the lines and the time it happened', () => {
        const before = baseCard();
        const after = Object.assign({}, before, { city: 'Madurai' });
        const at = Date.now();
        const entry = changeEntry('AI read a brochure', 'brochure.pdf', 'ai', before.id, before, after);
        expect(entry.undone).toBe(false);
        expect(entry.title).toBe('AI read a brochure');
        expect(entry.detail).toBe('brochure.pdf');
        expect(entry.source).toBe('ai');
        expect(entry.partnerId).toBe('p_sri');
        expect(entry.before.city).toBe('Chennai');
        expect(entry.lines.some(l => l.label === 'City')).toBe(true);
        // "when" is what the owner reads down the log; an absent or frozen `at` makes the
        // history unorderable.
        const stamped = Date.parse(entry.at);
        expect(Number.isNaN(stamped)).toBe(false);
        expect(stamped).toBeGreaterThanOrEqual(at - 1000);
        expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('change ids stay distinct even when a whole import logs inside one millisecond', () => {
        // undoChange finds a change BY ID. Colliding ids mean pressing undo on one change
        // restores whatever partner the first matching entry happens to hold — the same class
        // of bug that duplicate partner ids caused. The clock is frozen so only the random
        // tail can separate them; the RNG is stubbed to a distinct-but-deterministic sequence
        // so the assertion never depends on luck.
        let seq = 0;
        const ids = withFrozenEntropy(1756000000000, () => { seq += 1; return (seq % 900) / 1000; }, () => {
            let log = [];
            for (let i = 0; i < 205; i++) log = pushChange(log, changeEntry('c' + i, '', 'ai', 'p_sri', null, null));
            return log.map(c => c.id);
        });
        expect(ids).toHaveLength(200);
        expect(new Set(ids).size).toBe(200);
    });

    test('pushChange keeps the newest first and caps the log', () => {
        let log = [];
        for (let i = 0; i < 205; i++) log = pushChange(log, changeEntry('c' + i, '', 'ai', 'p_sri', null, null));
        expect(log).toHaveLength(200);
        expect(log[0].title).toBe('c204');
    });
});

describe('undoChange — how the owner puts a bad AI import back', () => {
    function editScenario() {
        const before = sanitizePartner({
            id: 'p_sri', company: 'Sri Logistics', city: 'Chennai',
            people: [person('Ravi', ['ravi@srilogistics.com'])],
        });
        const after = Object.assign({}, before, { city: 'Madurai', company: 'Sri Logistics Pvt Ltd' });
        const changes = pushChange([], changeEntry('AI edit', 'brochure.pdf', 'ai', before.id, before, after));
        return { contacts: [after], changes, id: changes[0].id };
    }

    test('undoing an ADDITION (before === null) removes the partner', () => {
        const created = sanitizePartner({ company: 'Brand New Traders' });
        const changes = pushChange([], changeEntry('AI added', '', 'ai', created.id, null, created));
        const res = undoChange([created], changes, changes[0].id);
        expect(res.ok).toBe(true);
        expect(res.contacts).toHaveLength(0);
        expect(res.changes[0].undone).toBe(true);
    });

    test('undoing an EDIT restores the before-snapshot', () => {
        const s = editScenario();
        const res = undoChange(s.contacts, s.changes, s.id);
        expect(res.ok).toBe(true);
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].city).toBe('Chennai');
        expect(res.contacts[0].company).toBe('Sri Logistics');
        expect(res.contacts[0].id).toBe('p_sri');
    });

    test("undoing does not edit the caller's own list in place", () => {
        const s = editScenario();
        undoChange(s.contacts, s.changes, s.id);
        expect(s.contacts).toHaveLength(1);
        expect(s.contacts[0].city).toBe('Madurai');
    });

    test('undoing an already-undone change does nothing at all', () => {
        // Real sequence: undo, then the owner types their own correction. Pressing undo a
        // second time (or a second tab pressing it) must not wipe that correction.
        const s = editScenario();
        const first = undoChange(s.contacts, s.changes, s.id);
        const edited = first.contacts.slice();
        edited[0] = Object.assign({}, edited[0], { city: 'Coimbatore' });

        const second = undoChange(edited, first.changes, s.id);
        expect(second.ok).toBe(false);
        expect(second.contacts[0].city).toBe('Coimbatore');
    });

    test('an unknown change id is a no-op', () => {
        const s = editScenario();
        const res = undoChange(s.contacts, s.changes, 'ch_does_not_exist');
        expect(res.ok).toBe(false);
        expect(res.contacts[0].city).toBe('Madurai');
        expect(res.changes[0].undone).toBe(false);
    });
});

// ── the pending queue and the model's findings ───────────────────────────────

describe('sanitizePendingItem', () => {
    test('a huge attachment is kept inside its cap', () => {
        const item = sanitizePendingItem({ from: 'a@b.in', text: 'x'.repeat(50000) });
        expect(item.text).toHaveLength(20000);
    });

    test('subject and file name are capped too', () => {
        const item = sanitizePendingItem({ subject: 's'.repeat(900), file: 'f'.repeat(900) });
        expect(item.subject).toHaveLength(300);
        expect(item.file).toHaveLength(200);
    });

    test('classifies a pdf and a photo', () => {
        expect(sanitizePendingItem({ file: 'brochure.pdf' }).kind).toBe('pdf');
        expect(sanitizePendingItem({ kind: 'application/pdf', file: 'scan' }).kind).toBe('pdf');
        expect(sanitizePendingItem({ kind: 'image/jpeg', file: 'photo.jpg' }).kind).toBe('photo');
    });

    test('the sender is lower-cased, because findByEmail matches on lower case', () => {
        expect(sanitizePendingItem({ from: '  Ravi@SriLogistics.COM ' }).from).toBe('ravi@srilogistics.com');
    });

    test('the attachment bytes are carried through — without them there is nothing to read', () => {
        // fileBase64 is the brochure itself. Dropping it leaves the extractor with a subject
        // line and no document, and the queue item looks fine while finding nothing.
        const item = sanitizePendingItem({ from: 'a@b.in', fileBase64: 'JVBERi0xLjQK' });
        expect(item.fileBase64).toBe('JVBERi0xLjQK');
    });

    test('findings already on the item survive a re-sanitise, and are capped at 40', () => {
        // The queue item is re-sanitised every time it is written back; losing `finds` would
        // throw away a review the owner has already half-done.
        const finds = [];
        for (let i = 0; i < 50; i++) finds.push({ kind: 'note', label: 'Note', value: 'n' + i });
        const item = sanitizePendingItem({ from: 'a@b.in', finds });
        expect(item.finds).toHaveLength(40);
        expect(item.finds[0]).toEqual({ kind: 'note', label: 'Note', value: 'n0' });
    });

    test('origin says where the item came from, and defaults to the Gmail label', () => {
        // The card the owner sees is drawn differently for the two: an 'import' item shows the
        // ready-made preview, a 'gmail' one is built from `finds` one address at a time.
        expect(sanitizePendingItem({}).origin).toBe('gmail');
        expect(sanitizePendingItem({ from: 'a@b.in' }).origin).toBe('gmail');
        expect(sanitizePendingItem({ origin: 'import' }).origin).toBe('import');
        expect(sanitizePendingItem({ origin: 'somewhere else' }).origin).toBe('gmail');
    });

    test('the preview survives a re-sanitise, with every person at the firm still on it', () => {
        // The queue item is re-written whenever the queue changes. An import item that lost its
        // preview would leave the owner approving a blank card — and losing the colleagues that
        // grouping put together in the first place is exactly the duplicate-firm bug returning.
        const built = pendingFromSuggestions([], {
            transporters: [
                { email: 'ops@speedelexpress.com', count: 5, lastUsed: '2026-08-01' },
                { email: 'billing@speedelexpress.com', count: 1, lastUsed: '2026-07-01' },
            ],
        }, null).items[0];

        const again = sanitizePendingItem(built);
        expect(again.origin).toBe('import');
        expect(again.preview).toEqual(built.preview);
        expect(allEmails(again.preview).sort())
            .toEqual(['billing@speedelexpress.com', 'ops@speedelexpress.com']);
        expect(again.preview.id).toBe('p_new_' + built.id);
    });

    test('a gmail-label item has no preview at all, and rubbish is not kept as one', () => {
        expect(sanitizePendingItem({ from: 'a@b.in' }).preview).toBeNull();
        expect(sanitizePendingItem({ from: 'a@b.in', preview: 'Sri Logistics' }).preview).toBeNull();
    });

    test('always has an id and a receivedAt, and keeps the ones it is given', () => {
        const fresh = sanitizePendingItem({});
        expect(fresh.id).toMatch(/^pd_/);
        expect(Number.isNaN(Date.parse(fresh.receivedAt))).toBe(false);

        const given = sanitizePendingItem({ id: 'pd_mine', receivedAt: '2026-08-01T00:00:00.000Z' });
        expect(given.id).toBe('pd_mine');
        expect(given.receivedAt).toBe('2026-08-01T00:00:00.000Z');
    });
});

describe('extractionPrompt — what the model is actually shown', () => {
    const prompt = extractionPrompt({
        from: 'ravi@srilogistics.com',
        subject: 'Rates for GI pipe',
        text: 'We stock 15 NB to 150 NB heavy. Minimum 5 tonne ex-Chennai.',
    });

    test('tells the model never to guess a number', () => {
        // CLAUDE.md check #5 — a missing MOQ must stay missing, not be invented.
        expect(prompt).toContain('never guess a number');
    });

    test('demands strict JSON, since the reply is parsed straight into find rows', () => {
        expect(prompt).toContain('Return STRICT JSON only:');
    });

    test('actually includes the email — sender, subject AND body', () => {
        // A prompt that stopped passing the body would still ask all the right questions and
        // return an empty extraction that looks like "nothing in this email".
        expect(prompt).toContain('From: ravi@srilogistics.com');
        expect(prompt).toContain('Subject: Rates for GI pipe');
        expect(prompt).toContain('We stock 15 NB to 150 NB heavy. Minimum 5 tonne ex-Chennai.');
    });
});

describe('findsFromExtraction — the model JSON becomes review rows', () => {
    test('each filled field becomes one find row', () => {
        const finds = findsFromExtraction({
            role: 'transporter', company: 'Sri Logistics', person: 'Ravi',
            phone: '9876543210', city: 'Chennai', branches: 'Hosur, Madurai',
            types: 'ERW, GI', vehicles: '20ft, 32ft',
        });
        expect(finds.map(f => f.key)).toEqual([
            'role', 'company', 'person', 'phone', 'city', 'branches', 'types', 'vehicles',
        ]);
        expect(finds[1]).toEqual({ kind: 'field', key: 'company', label: 'Company', value: 'Sri Logistics' });
    });

    test('a field the email did not contain produces NO row', () => {
        // An absent value must stay absent — a blank row invites someone to accept a fact
        // that was never in the email.
        const finds = findsFromExtraction({ company: 'Sri Logistics', city: '', phone: '   ' });
        expect(finds).toHaveLength(1);
        expect(finds[0].key).toBe('company');
    });

    test('a product row carries its MOQ and rule; a nameless product is dropped', () => {
        const finds = findsFromExtraction({
            products: [
                { p: 'GI Pipe', spec: 'IS 1239', moq: 5, rule: 'ex-Chennai only' },
                { p: '', spec: 'nameless' },
            ],
        });
        expect(finds).toHaveLength(1);
        expect(finds[0].kind).toBe('product');
        expect(finds[0].product).toEqual({
            p: 'GI Pipe', spec: 'IS 1239', sizes: [], moq: 5, rule: 'ex-Chennai only',
        });
    });

    test('a route row needs a from; a route without one is dropped', () => {
        const finds = findsFromExtraction({
            routes: [{ from: 'Chennai', to: 'Hyderabad' }, { from: '', to: 'Mumbai' }],
        });
        expect(finds).toHaveLength(1);
        expect(finds[0].kind).toBe('routes');
        expect(finds[0].routes).toEqual([{ from: 'Chennai', to: 'Hyderabad' }]);
    });

    test('blank notes are dropped', () => {
        const finds = findsFromExtraction({ notes: ['Pays in 30 days', '', '   '] });
        expect(finds).toHaveLength(1);
        expect(finds[0]).toEqual({ kind: 'note', label: 'Note', value: 'Pays in 30 days' });
    });

    test('a runaway extraction is capped at 15 products, 15 routes and 10 notes', () => {
        // One review screen the owner can actually get through — and a bound on what a bad
        // model reply can push into the stored queue item.
        const many = (n, make) => { const out = []; for (let i = 0; i < n; i++) out.push(make(i)); return out; };
        const finds = findsFromExtraction({
            products: many(25, i => ({ p: 'Prod ' + i })),
            routes: many(25, i => ({ from: 'F' + i, to: 'T' + i })),
            notes: many(25, i => 'note ' + i),
        });
        expect(finds.filter(f => f.kind === 'product')).toHaveLength(15);
        expect(finds.filter(f => f.kind === 'routes')).toHaveLength(15);
        expect(finds.filter(f => f.kind === 'note')).toHaveLength(10);
    });
});

// ── the small pieces the rest leans on ───────────────────────────────────────

describe('role and people sanitising', () => {
    test('normalizeRole reads the trade words, and falls back to other', () => {
        expect(normalizeRole('Lorry Transport')).toBe('transporter');
        expect(normalizeRole('Pipe Mill')).toBe('manufacturer');
        expect(normalizeRole('Stockist')).toBe('dealer');
        expect(normalizeRole('Fabrication works')).toBe('fabricator');
        expect(normalizeRole('something else entirely')).toBe('other');
    });

    test('an address that is not an address is not stored as one', () => {
        const p = sanitizePerson({ name: 'Ravi', emails: [{ v: 'ravi at sri dot in' }, { v: 'ravi@sri.in' }] });
        expect(p.emails.map(e => e.v)).toEqual(['ravi@sri.in']);
    });

    test('a card always has at least one person row to type into', () => {
        expect(sanitizePeople([])).toHaveLength(1);
        expect(sanitizePeople(undefined)[0].role).toBe('Main contact');
    });
});

// ── the route really uses all this ───────────────────────────────────────────

describe('routes/contacts.js is wired to the approval path, not the old write-through one', () => {
    // Everything above proves the module behaves. These prove the ROUTE calls it that way —
    // the gap that let two "guarded" behaviours in this repo pass with the code deleted.
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contacts.js'), 'utf8');

    test('the import route queues drafts and never writes partners', () => {
        expect(source).toContain('contactsLib.pendingFromSuggestions(');
        // saveDirectory must not appear anywhere in the import-remembered handler.
        const handler = source.slice(source.indexOf("'/contacts/import-remembered'"),
            source.indexOf("'/contacts/usage'"));
        expect(handler).toContain('contactsLib.pendingFromSuggestions(');
        expect(handler).toContain('savePending(');
        expect(handler).not.toContain('saveDirectory(');
    });

    test('the usage route hands bumpUsage\'s unknown addresses to the approval queue', () => {
        // If the route dropped `bumped.unknown` on the floor, every new address an enquiry went
        // to would vanish — no card, no queue item, nothing for the owner to approve.
        expect(source).toMatch(/const bumped = contactsLib\.bumpUsage\(dir\.contacts, usage\)/);
        expect(source).toMatch(
            /contactsLib\.pendingFromUsage\(\s*dir\.contacts,\s*items,\s*bumped\.unknown,\s*usage\s*\)/);
    });

    test('the import route drops what is already queued before saving', () => {
        expect(source).toMatch(/contactsLib\.dropAlreadyQueued\(\s*items,\s*result\.items\s*\)/);
    });

    test('the queue cap is the shared MAX_PENDING, never an inline number', () => {
        expect(source).toContain('const MAX_PENDING = contactsLib.MAX_PENDING;');
        // The old inline cap of 50 would silently drop the tail of a 24-firm import.
        expect(source).not.toMatch(/savePending\([^;]*slice\(0,\s*\d/);
    });

    test('neither route caps the queue by slicing new arrivals over the old ones', () => {
        // `fresh.concat(items).slice(0, MAX_PENDING)` put the NEW items first and cut the
        // end off — and the end is the OLDEST queue, the brochures tagged in Gmail days ago
        // and still waiting. They vanished with nothing said. Both routes go through
        // queueWithoutLosingAny now, which fills the room that is left instead.
        expect(source).toMatch(/contactsLib\.queueWithoutLosingAny\(items,\s*fresh,\s*MAX_PENDING\)/);
        expect(source).toMatch(/contactsLib\.queueWithoutLosingAny\(items,\s*proposed,\s*MAX_PENDING\)/);
        expect(source).not.toMatch(/(fresh|proposed)\.concat\(items\)\.slice/);
        // and both hand the overflow count back, so the owner can be told
        expect(source).toMatch(/noRoom: room\.noRoom/);
    });
});

describe('a saved partner really goes through those helpers', () => {
    // The three tests above prove the helpers work; these prove sanitizePartner CALLS them.
    // Unhooking either one leaves every helper test green while the stored record rots:
    // a role of "Lorry Transport" drops out of the ROLES filter, and an unvalidated people
    // array puts "ravi at sri dot in" on the card as a mailto link.

    test('the role written on the card is the normalised one, not the words typed', () => {
        expect(sanitizePartner({ role: 'Lorry Transport' }).role).toBe('transporter');
        expect(sanitizePartner({ role: 'Pipe Mill' }).role).toBe('manufacturer');
        expect(ROLES).toContain(sanitizePartner({ role: 'anything at all' }).role);
    });

    test('people on the card are sanitised, so a non-address never gets stored', () => {
        const p = sanitizePartner({
            people: [{ name: 'Ravi', emails: [{ label: 'Work', v: 'ravi at sri dot in' }] }],
        });
        expect(p.people[0].emails).toEqual([]);
    });

    test('a card saved with no people still gets its one empty person row', () => {
        expect(sanitizePartner({ people: [] }).people).toEqual([
            { name: '', role: 'Main contact', phones: [], emails: [] },
        ]);
        expect(sanitizePartner({}).people).toHaveLength(1);
    });
});

// ── one address belongs to ONE company ───────────────────────────────────────

/**
 * The owner's words: "we need to make sure duplicates dont exist — maybe one email can
 * exist only within one company and not multiple."
 *
 * An address on two cards is not untidiness, it is a firm asked twice: two cards, two
 * histories, two enquiries to the same person who cannot see the other. So the rule is
 * enforced at the single write path (mergePartner), and a clash is REFUSED — never
 * "reported and written anyway", and never "quietly written without the offending
 * address", which loses what was typed with no error to explain it.
 *
 * Every test below therefore asserts BOTH halves: the conflict names the right address
 * and the right card, AND the stored list came back byte-identical.
 */
describe('mergePartner — one address belongs to one company', () => {
    const { duplicateEmails } = contactsLib;

    function kalpataru(people) {
        return sanitizePartner({
            id: 'p_kalp', company: 'Kalpataru Steel', city: 'Nashik',
            people: people || [person('Manish', ['manish@kalpatarusteel.com'])],
        });
    }
    function sri(people) {
        return sanitizePartner({
            id: 'p_sri', company: 'Sri Logistics', role: 'transporter', city: 'Chennai',
            people: people || [person('Ravi', ['ravi@srilogistics.com'])],
        });
    }
    /** Two firms, no shared address — the healthy directory every test starts from. */
    function twoFirms() { return [kalpataru(), sri()]; }

    /** JSON is the honest byte-for-byte comparison here: the blob is what gets stored. */
    const frozen = (list) => JSON.stringify(list);

    test('a FIELD-SCOPED save that types another card\'s address is refused, and writes nothing', () => {
        // Sri Logistics is edited to add "Manish" — but that address is Kalpataru's. The
        // whole point is that the list must come back exactly as it went in: a mutation that
        // reports the clash and writes anyway, and one that strips the offending address and
        // writes the rest, both change this string.
        const list = twoFirms();
        const before = frozen(list);
        const stale = Object.assign({}, list[1], {
            people: [person('Ravi', ['ravi@srilogistics.com']), person('Manish', ['manish@kalpatarusteel.com'])],
        });

        const res = mergePartner(list, stale, ['people']);

        expect(res.conflict).toEqual({
            email: 'manish@kalpatarusteel.com', id: 'p_kalp', company: 'Kalpataru Steel',
        });
        expect(frozen(res.contacts)).toBe(before);
        // What comes back as `partner` is the STORED card, not the rejected edit — the route
        // echoes it to the client, and echoing the refused version would look like a save.
        expect(allEmails(res.partner)).toEqual(['ravi@srilogistics.com']);
    });

    test('a WHOLESALE save of the same edit is refused too, and writes nothing', () => {
        // No `fields` = "replace the whole record". A guard placed only on the field-scoped
        // branch would let this one straight through.
        const list = twoFirms();
        const before = frozen(list);
        const stale = Object.assign({}, list[1], {
            company: 'Sri Logistics Pvt Ltd',
            people: [person('Manish', ['manish@kalpatarusteel.com'])],
        });

        const res = mergePartner(list, stale);

        expect(res.conflict).toEqual({
            email: 'manish@kalpatarusteel.com', id: 'p_kalp', company: 'Kalpataru Steel',
        });
        expect(frozen(res.contacts)).toBe(before);
        expect(res.contacts[1].company).toBe('Sri Logistics');   // the rename did not land either
    });

    test('a BRAND-NEW card carrying an address someone already holds is refused, and is not added', () => {
        // The third write path: an id that is not in the list at all (a hand-added partner, or
        // an approved queue item for a firm we do not hold yet).
        const list = twoFirms();
        const before = frozen(list);

        const res = mergePartner(list, {
            company: 'Manish Trading Co',
            people: [person('Manish', ['MANISH@KalpataruSteel.com'])],
        });

        expect(res.conflict.email).toBe('manish@kalpatarusteel.com');   // matched case-blind
        expect(res.conflict.company).toBe('Kalpataru Steel');
        expect(res.conflict.id).toBe('p_kalp');
        expect(res.partner).toBeNull();
        expect(frozen(res.contacts)).toBe(before);
        expect(res.contacts).toHaveLength(2);
    });

    test('a card keeping its OWN address is not a clash — editing the city still saves', () => {
        // The assertion that stops a lazy "is this address anywhere in the list" check: every
        // card holds its own addresses, so that reading refuses every edit ever made.
        const list = twoFirms();

        const scoped = mergePartner(list, Object.assign({}, list[1], { city: 'Madurai' }), ['city']);
        expect(scoped.conflict).toBeNull();
        expect(scoped.partner.city).toBe('Madurai');
        expect(allEmails(scoped.contacts[1])).toEqual(['ravi@srilogistics.com']);

        // Wholesale takes the other route through the merge, carrying the people from the
        // incoming copy rather than the stored one — it must skip its own slot as well.
        const whole = mergePartner(list, Object.assign({}, list[1], { city: 'Madurai' }));
        expect(whole.conflict).toBeNull();
        expect(whole.partner.city).toBe('Madurai');
        expect(allEmails(whole.contacts[1])).toEqual(['ravi@srilogistics.com']);
    });

    test('a genuinely new colleague at a firm we already hold is added, not refused', () => {
        // One firm, one card: cp@ joining manish@ on Kalpataru is the whole point of the
        // directory. Refusing this would push the owner into making a second card.
        const list = twoFirms();
        const grown = Object.assign({}, list[0], {
            people: [person('Manish', ['manish@kalpatarusteel.com']), person('CP', ['cp@kalpatarusteel.com'])],
        });

        const res = mergePartner(list, grown, ['people']);

        expect(res.conflict).toBeNull();
        expect(allEmails(res.partner)).toEqual(['manish@kalpatarusteel.com', 'cp@kalpatarusteel.com']);
        expect(allEmails(res.contacts[0])).toEqual(['manish@kalpatarusteel.com', 'cp@kalpatarusteel.com']);
    });

    test('the clash is found whatever the case, and on ANY person of either card', () => {
        // Both cards carry the shared address on their SECOND person, and in different case.
        // A check that reads only people[0], or compares the addresses as typed, misses it —
        // and the duplicate it was built to stop walks straight in.
        const list = [
            kalpataru([person('Reception', ['front@kalpatarusteel.com']),
                person('Manish', ['Manish@KalpataruSteel.com'])]),
            sri(),
        ];
        const before = frozen(list);
        const stale = Object.assign({}, list[1], {
            people: [person('Ravi', ['ravi@srilogistics.com']),
                person('M', ['manish@KALPATARUSTEEL.com'])],
        });

        const res = mergePartner(list, stale, ['people']);

        expect(res.conflict).toEqual({
            email: 'manish@kalpatarusteel.com', id: 'p_kalp', company: 'Kalpataru Steel',
        });
        expect(frozen(res.contacts)).toBe(before);
    });

    // ── finding the duplicates that pre-date the rule ────────────────────────

    describe('duplicateEmails', () => {
        test('finds an address held twice and names BOTH cards', () => {
            // Written before the rule existed, these sit there splitting one firm's history
            // in two — so the directory has to be able to point at them.
            const list = [kalpataru(), sri([person('Ravi', ['ravi@srilogistics.com']),
                person('Manish', ['manish@kalpatarusteel.com'])])];

            expect(duplicateEmails(list)).toEqual([{
                email: 'manish@kalpatarusteel.com',
                cards: [{ id: 'p_kalp', company: 'Kalpataru Steel' },
                    { id: 'p_sri', company: 'Sri Logistics' }],
            }]);
        });

        test('a healthy directory reports nothing at all', () => {
            expect(duplicateEmails(twoFirms())).toEqual([]);
            expect(duplicateEmails([])).toEqual([]);
        });

        test('one address on two people of the SAME card is not a duplicate', () => {
            // A shared office address listed against two colleagues on one card breaks no
            // rule — the firm still has exactly one card. Flagging it would put a red banner
            // on the directory that nothing can ever clear.
            const shared = kalpataru([person('Manish', ['office@kalpatarusteel.com']),
                person('CP', ['office@kalpatarusteel.com'])]);
            expect(duplicateEmails([shared, sri()])).toEqual([]);
        });

        test('three cards sharing one address list all three', () => {
            const third = sanitizePartner({
                id: 'p_third', company: 'Third Firm',
                people: [person('X', ['manish@kalpatarusteel.com'])],
            });
            const dups = duplicateEmails([kalpataru(), sri([person('Ravi',
                ['manish@kalpatarusteel.com'])]), third]);

            expect(dups).toHaveLength(1);
            expect(dups[0].email).toBe('manish@kalpatarusteel.com');
            expect(dups[0].cards.map(c => c.id)).toEqual(['p_kalp', 'p_sri', 'p_third']);
            expect(dups[0].cards.map(c => c.company))
                .toEqual(['Kalpataru Steel', 'Sri Logistics', 'Third Firm']);
        });
    });
});

// ── the routes refuse the clash, and refuse it BEFORE they write ─────────────

describe('routes/contacts.js — a clash is a 409 and nothing is stored', () => {
    const express = require('express');
    const request = require('supertest');
    const createContactsRouter = require('../routes/contacts');
    const { CONFIG_KEY_CONTACTS, CONFIG_KEY_CONTACTS_PENDING } = require('../utils/constants');

    const KALP = sanitizePartner({
        id: 'p_kalp', company: 'Kalpataru Steel',
        people: [person('Manish', ['manish@kalpatarusteel.com'])],
    });
    const SRI = sanitizePartner({
        id: 'p_sri', company: 'Sri Logistics', role: 'transporter',
        people: [person('Ravi', ['ravi@srilogistics.com'])],
    });

    const QUEUED = {
        id: 'pd_1', origin: 'gmail', from: 'manish@kalpatarusteel.com',
        subject: 'Rate list', file: 'rates.pdf', kind: 'pdf', text: '',
        finds: [{ kind: 'field', key: 'company', label: 'Company', value: 'Manish Trading Co' }],
        receivedAt: '2026-08-27T10:00:00.000Z', preview: null,
    };

    /** The real router over an in-memory storage layer — the same two blobs it reads live. */
    function makeApp() {
        const blobs = {
            [CONFIG_KEY_CONTACTS]: JSON.stringify({ contacts: [KALP, SRI], changes: [] }),
            [CONFIG_KEY_CONTACTS_PENDING]: JSON.stringify({ items: [QUEUED] }),
        };
        const written = [];
        const storage = {
            readText: async (key) => (key in blobs ? blobs[key] : ''),
            saveText: async (key, text) => { written.push(key); blobs[key] = text; },
        };
        const app = express();
        app.use('/api', createContactsRouter({ storage, openai: null }));
        return { app, blobs, written, before: Object.assign({}, blobs) };
    }

    test('POST /contacts/save refuses an address another card holds, and stores nothing', async () => {
        const { app, blobs, written, before } = makeApp();

        const res = await request(app).post('/api/contacts/save').send({
            partner: Object.assign({}, SRI, { people: [person('M', ['manish@kalpatarusteel.com'])] }),
            fields: ['people'],
        });

        expect(res.status).toBe(409);
        // Refusing without naming the other card is a dead end — the owner cannot act on it.
        expect(res.body.error).toContain('manish@kalpatarusteel.com');
        expect(res.body.error).toContain('Kalpataru Steel');
        expect(written).toEqual([]);
        expect(blobs[CONFIG_KEY_CONTACTS]).toBe(before[CONFIG_KEY_CONTACTS]);
    });

    test('POST /contacts/save still saves a clean edit — the guard is not a blanket refusal', async () => {
        // Without this the 409 test above passes just as well against a route that refuses
        // everything, and "nothing was written" would mean nothing.
        const { app, blobs, written } = makeApp();

        const res = await request(app).post('/api/contacts/save')
            .send({ partner: Object.assign({}, SRI, { city: 'Madurai' }), fields: ['city'] });

        expect(res.status).toBe(200);
        expect(written).toEqual([CONFIG_KEY_CONTACTS]);
        expect(JSON.parse(blobs[CONFIG_KEY_CONTACTS]).contacts
            .find(p => p.id === 'p_sri').city).toBe('Madurai');
    });

    test('POST /contacts/pending/approve refuses too — and leaves the item IN the queue', async () => {
        // Half-applying is the failure that matters here: dropping the queue item while
        // refusing the write loses the email altogether, and the owner never learns a firm
        // wrote in. It stays queued so they can fix the other card and approve again.
        const { app, blobs, written, before } = makeApp();

        const res = await request(app).post('/api/contacts/pending/approve').send({
            id: 'pd_1',
            partner: { company: 'Manish Trading Co', people: [person('Manish', ['manish@kalpatarusteel.com'])] },
        });

        expect(res.status).toBe(409);
        expect(res.body.error).toContain('manish@kalpatarusteel.com');
        expect(res.body.error).toContain('Kalpataru Steel');
        expect(written).toEqual([]);
        expect(blobs[CONFIG_KEY_CONTACTS]).toBe(before[CONFIG_KEY_CONTACTS]);
        expect(blobs[CONFIG_KEY_CONTACTS_PENDING]).toBe(before[CONFIG_KEY_CONTACTS_PENDING]);
        expect(JSON.parse(blobs[CONFIG_KEY_CONTACTS_PENDING]).items.map(i => i.id)).toEqual(['pd_1']);
    });

    test('POST /contacts/pending/approve still adds a firm with a fresh address', async () => {
        const { app, blobs, written } = makeApp();

        const res = await request(app).post('/api/contacts/pending/approve').send({
            id: 'pd_1',
            partner: { company: 'Vikas Tubes', people: [person('Vikas', ['sales@vikastubes.in'])] },
        });

        expect(res.status).toBe(200);
        expect(written).toContain(CONFIG_KEY_CONTACTS);
        expect(JSON.parse(blobs[CONFIG_KEY_CONTACTS]).contacts.map(p => p.company))
            .toContain('Vikas Tubes');
        expect(JSON.parse(blobs[CONFIG_KEY_CONTACTS_PENDING]).items).toEqual([]);
    });

    test('a card with no name yet is called "another card", not its own address twice', async () => {
        // An imported card starts with the address AS its company. "x@y.com is already on
        // x@y.com" reads like a glitch, and tells the owner nothing they can act on.
        const { app, blobs } = makeApp();
        blobs[CONFIG_KEY_CONTACTS] = JSON.stringify({
            changes: [],
            contacts: [sanitizePartner({
                id: 'p_stub', company: 'manish@kalpatarusteel.com',
                people: [person('', ['manish@kalpatarusteel.com'])],
            })],
        });

        const res = await request(app).post('/api/contacts/save').send({
            partner: { company: 'Manish Trading Co', people: [person('M', ['manish@kalpatarusteel.com'])] },
        });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe('manish@kalpatarusteel.com is already on another card.'
            + ' One address belongs to one company — remove it there first, or add this person to that card.');
    });

    test('GET /contacts hands the duplicates that pre-date the rule to the browser', async () => {
        // The rule stops NEW ones. Anything written before it has to be visible, or it sits
        // there for ever quietly splitting one firm across two cards.
        const { app } = makeApp();
        const res = await request(app).get('/api/contacts');
        expect(res.status).toBe(200);
        expect(res.body.duplicates).toEqual([]);          // this fixture is clean

        const dirty = makeApp();
        dirty.blobs[CONFIG_KEY_CONTACTS] = JSON.stringify({
            changes: [],
            contacts: [KALP, Object.assign({}, SRI, {
                people: [person('Ravi', ['manish@kalpatarusteel.com'])],
            })],
        });
        const res2 = await request(dirty.app).get('/api/contacts');
        expect(res2.body.duplicates).toEqual([{
            email: 'manish@kalpatarusteel.com',
            cards: [{ id: 'p_kalp', company: 'Kalpataru Steel' },
                { id: 'p_sri', company: 'Sri Logistics' }],
        }]);
    });
});

describe('source guard — the conflict is checked BEFORE the write, not after it', () => {
    // The behavioural tests above cannot see one particular mutation on /contacts/save:
    // moving the 409 return BELOW `await saveDirectory(...)` writes the SAME contacts back
    // (mergePartner hands the untouched list back on a clash), so the stored blob is
    // unchanged either way. What is pinned here is therefore the ORDER — an early return —
    // not the presence of the number 409 anywhere in the file.
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contacts.js'), 'utf8');
    const GUARD = 'if (merged.conflict) return res.status(409).json({ error: conflictMessage(merged.conflict) });';

    function handler(from, to) {
        const a = source.indexOf(from);
        const b = source.indexOf(to, a + 1);
        if (a === -1 || b === -1) throw new Error('handler markers not found: ' + from);
        return source.slice(a, b);
    }

    test('/contacts/save returns 409 and returns before saveDirectory', () => {
        const body = handler("'/contacts/save'", "'/contacts/delete'");
        const guard = body.indexOf(GUARD);
        const write = body.indexOf('await saveDirectory(');
        expect(guard).toBeGreaterThan(-1);
        expect(write).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(write);
    });

    test('/contacts/pending/approve returns 409 before it touches EITHER blob', () => {
        // Two writes here, and the queue one is the dangerous half: writing the filtered
        // queue first drops the email while refusing the partner.
        const body = handler("'/contacts/pending/approve'", "'/contacts/pending/discard'");
        const guard = body.indexOf(GUARD);
        const writeDir = body.indexOf('await saveDirectory(');
        const writeQueue = body.indexOf('await savePending(');
        expect(guard).toBeGreaterThan(-1);
        expect(writeDir).toBeGreaterThan(-1);
        expect(writeQueue).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(writeDir);
        expect(guard).toBeLessThan(writeQueue);
    });

});

// ── one enquiry to a firm is ONE enquiry ─────────────────────────────────────

/**
 * "Asked 12 times" is read as twelve enquiries, and five of them makes a firm "Regular".
 * Counting per ADDRESS made a two-person firm climb twice as fast as a one-person firm for
 * exactly the same amount of business — and the owner has no way to correct the number.
 */
describe('bumpUsage counts firms, not addresses', () => {
    function jco() {
        return sanitizePartner({
            id: 'p_jco', company: 'Jco Pipe',
            people: [person('Manish', ['manish@jcopipe.com']), person('CP', ['cp@jcopipe.com'])],
        });
    }
    function sri() {
        return sanitizePartner({
            id: 'p_sri', company: 'Sri Logistics',
            people: [person('Ravi', ['ravi@srilogistics.com'])],
        });
    }

    test('one enquiry Cc’d to two people at one firm counts once', () => {
        const res = bumpUsage([jco()], {
            emails: ['manish@jcopipe.com', 'cp@jcopipe.com'], kind: 'enquiry',
        });
        expect(res.contacts[0].enq).toBe(1);
    });

    test('one reply from a firm counts once, however many of its addresses are on it', () => {
        const res = bumpUsage([jco()], {
            emails: ['manish@jcopipe.com', 'cp@jcopipe.com'], kind: 'reply',
        });
        expect(res.contacts[0].rep).toBe(1);
        expect(res.contacts[0].enq).toBe(0);
    });

    test('two firms on the same enquiry each get one — the count is not simply dropped', () => {
        const res = bumpUsage([jco(), sri()], {
            emails: ['manish@jcopipe.com', 'cp@jcopipe.com', 'ravi@srilogistics.com'],
            kind: 'enquiry',
        });
        expect(res.contacts.map(p => p.enq)).toEqual([1, 1]);
    });

    test('two separate enquiries to the same firm are still two', () => {
        let list = [jco()];
        list = bumpUsage(list, { emails: ['manish@jcopipe.com', 'cp@jcopipe.com'] }).contacts;
        list = bumpUsage(list, { emails: ['cp@jcopipe.com'] }).contacts;
        expect(list[0].enq).toBe(2);
    });

    test('a new firm we wrote to twice in one send is offered for approval once', () => {
        const res = bumpUsage([], { emails: ['a@vikastubes.in', 'a@vikastubes.in'] });
        expect(res.unknown).toEqual(['a@vikastubes.in']);
    });
});

// ── the app's own spelling for a pipe type ───────────────────────────────────

describe('imported pipe types come back in the spelling the cards use', () => {
    const { applyAddFind } = contactsLib._test;

    test('the remembered "seamless" bucket becomes Seamless, not SEAMLESS', () => {
        // partner-directory.js offers GI / ERW / Seamless / SS / MS / Alloy and checks for a
        // duplicate letter by letter, so SEAMLESS lands on the card a second time.
        const res = pendingFromSuggestions([], {}, {
            byType: { seamless: [{ email: 'sales@vikastubes.in', count: 4, lastUsed: '2026-08-01' }] },
        });
        expect(res.items).toHaveLength(1);
        expect(res.items[0].preview.types).toEqual(['Seamless']);
    });

    test('GI and ERW keep their capitals', () => {
        const res = pendingFromSuggestions([], {}, {
            byType: { gi: [{ email: 'a@vikastubes.in', count: 1 }], erw: [{ email: 'a@vikastubes.in', count: 1 }] },
        });
        expect(res.items[0].preview.types.sort()).toEqual(['ERW', 'GI']);
    });

    test('a type read off a brochure matches what the card already says', () => {
        const card = { types: ['Seamless'] };
        applyAddFind(card, { kind: 'field', key: 'types', value: 'seamless, erw' }, 'brochure');
        expect(card.types).toEqual(['Seamless', 'ERW']);
    });

    test('a type nobody has a spelling for is kept exactly as it was written', () => {
        const card = { types: [] };
        applyAddFind(card, { kind: 'field', key: 'types', value: 'Boiler Tube' }, 'brochure');
        expect(card.types).toEqual(['Boiler Tube']);
    });
});

// ── deleting a partner is logged, and can be undone ──────────────────────────

describe('deleting a partner is logged, and Undo puts the card back', () => {
    const { removalEntry } = contactsLib;

    function deleted() {
        return sanitizePartner({
            id: 'p_sri', company: 'Sri Logistics', city: 'Chennai',
            notes: [{ d: '2026-01-04', t: 'Pays in 30 days' }],
            people: [person('Ravi', ['ravi@srilogistics.com'])],
        });
    }

    test('the entry keeps the WHOLE card, not just its name', () => {
        const entry = removalEntry(deleted(), 'Deleted by hand');
        expect(entry.removed).toBe(true);
        expect(entry.title).toBe('Deleted Sri Logistics');
        expect(entry.partnerId).toBe('p_sri');
        expect(entry.before.city).toBe('Chennai');
        expect(entry.before.notes[0].t).toBe('Pays in 30 days');
        expect(entry.before.people[0].emails[0].v).toBe('ravi@srilogistics.com');
    });

    test('it says a whole card went, not "nothing measurable changed"', () => {
        // The log describes a change by its lines. A deletion with none reads, when opened,
        // as though the delete did nothing.
        expect(removalEntry(deleted(), 'Deleted by hand').lines)
            .toEqual([{ label: 'Card removed', from: 'Sri Logistics', to: 'gone from the directory' }]);
    });

    test('a card with no firm name is named by its address, never left blank', () => {
        const entry = removalEntry(
            sanitizePartner({ id: 'p_x', people: [person('', ['sales@vikastubes.in'])] }), 'Deleted by hand');
        expect(entry.title).toBe('Deleted sales@vikastubes.in');
    });

    test('undo puts the deleted card back exactly as it was', () => {
        const changes = pushChange([], removalEntry(deleted(), 'Deleted by hand'));
        const res = undoChange([], changes, changes[0].id);
        expect(res.ok).toBe(true);
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].id).toBe('p_sri');
        expect(res.contacts[0].city).toBe('Chennai');
        expect(res.contacts[0].notes[0].t).toBe('Pays in 30 days');
        expect(res.changes[0].undone).toBe(true);
    });

    test('undo refuses when another card has since been given that address', () => {
        // One address, one company. Putting the card back anyway would split one firm's
        // history across two cards — the thing the whole rule exists to stop.
        const other = sanitizePartner({
            id: 'p_other', company: 'Other Firm', people: [person('Ravi', ['ravi@srilogistics.com'])],
        });
        const changes = pushChange([], removalEntry(deleted(), 'Deleted by hand'));
        const res = undoChange([other], changes, changes[0].id);
        expect(res.ok).toBe(false);
        expect(res.conflict.email).toBe('ravi@srilogistics.com');
        expect(res.conflict.company).toBe('Other Firm');
        expect(res.contacts).toHaveLength(1);
        expect(changes[0].undone).toBe(false);      // still there to press once the clash is cleared
    });

    test('undoing an EDIT to a card that has since been deleted says so, instead of "done"', () => {
        const before = deleted();
        const after = Object.assign({}, before, { city: 'Madurai' });
        const changes = pushChange([], changeEntry('AI edit', 'brochure.pdf', 'ai', before.id, before, after));
        const res = undoChange([], changes, changes[0].id);
        expect(res.ok).toBe(false);
        expect(res.missing).toBe(true);
        expect(res.contacts).toEqual([]);
        expect(changes[0].undone).toBe(false);
    });
});

// ── the routes behind all three ──────────────────────────────────────────────

describe('routes/contacts.js — deleting, approving and an email nobody could read', () => {
    const express = require('express');
    const request = require('supertest');
    const createContactsRouter = require('../routes/contacts');
    const { CONFIG_KEY_CONTACTS, CONFIG_KEY_CONTACTS_PENDING } = require('../utils/constants');

    // Stats the APP owns: twelve enquiries, five replies, last dealt with on 30 Aug.
    const SRI = sanitizePartner({
        id: 'p_sri', company: 'Sri Logistics', role: 'transporter',
        people: [person('Ravi', ['ravi@srilogistics.com'])],
        enq: 12, rep: 5, last: '2026-08-30',
    });

    const QUEUED = {
        id: 'pd_9', origin: 'gmail', from: 'ravi@srilogistics.com',
        subject: 'New branch', file: 'note.pdf', kind: 'pdf', text: '',
        finds: [{ kind: 'field', key: 'city', label: 'City', value: 'Madurai' }],
        receivedAt: '2026-08-31T10:00:00.000Z', preview: null,
    };

    function makeApp() {
        const blobs = {
            [CONFIG_KEY_CONTACTS]: JSON.stringify({ contacts: [SRI], changes: [] }),
            [CONFIG_KEY_CONTACTS_PENDING]: JSON.stringify({ items: [QUEUED] }),
        };
        const written = [];
        const storage = {
            readText: async (key) => (key in blobs ? blobs[key] : ''),
            saveText: async (key, text) => { written.push(key); blobs[key] = text; },
        };
        const app = express();
        app.use('/api', createContactsRouter({ storage, openai: null }));
        return { app, blobs, written };
    }

    const dirOf = (blobs) => JSON.parse(blobs[CONFIG_KEY_CONTACTS]);

    let savedSecret;
    beforeEach(() => { savedSecret = process.env.INGEST_SECRET; delete process.env.INGEST_SECRET; });
    afterEach(() => {
        if (savedSecret === undefined) delete process.env.INGEST_SECRET;
        else process.env.INGEST_SECRET = savedSecret;
    });

    test('approving a queued email does not roll back the counts the app keeps', async () => {
        // The browser's copy of the card was loaded before this morning's enquiries went out.
        // Approving one email must not carry those old numbers back over the stored ones.
        const { app, blobs } = makeApp();

        const res = await request(app).post('/api/contacts/pending/approve').send({
            id: 'pd_9',
            partner: Object.assign({}, SRI, { city: 'Madurai', enq: 0, rep: 0, last: '' }),
        });

        expect(res.status).toBe(200);
        const saved = dirOf(blobs).contacts.find(p => p.id === 'p_sri');
        expect(saved.city).toBe('Madurai');          // the reviewed change still lands
        expect(saved.enq).toBe(12);
        expect(saved.rep).toBe(5);
        expect(saved.last).toBe('2026-08-30');
    });

    test('approving a card with no firm name logs its address, not "Added "', async () => {
        const { app, blobs } = makeApp();

        await request(app).post('/api/contacts/pending/approve').send({
            id: 'pd_9', partner: { company: '', people: [person('', ['sales@vikastubes.in'])] },
        });

        expect(dirOf(blobs).changes[0].title).toBe('Added sales@vikastubes.in');
    });

    test('deleting a partner writes a change entry holding the whole card', async () => {
        const { app, blobs } = makeApp();

        const res = await request(app).post('/api/contacts/delete').send({ id: 'p_sri' });

        expect(res.status).toBe(200);
        const dir = dirOf(blobs);
        expect(dir.contacts.map(p => p.id)).not.toContain('p_sri');
        expect(dir.changes).toHaveLength(1);
        expect(dir.changes[0].removed).toBe(true);
        expect(dir.changes[0].title).toBe('Deleted Sri Logistics');
        expect(dir.changes[0].before.enq).toBe(12);
    });

    test('and Undo puts that partner back, counts and all', async () => {
        const { app, blobs } = makeApp();
        await request(app).post('/api/contacts/delete').send({ id: 'p_sri' });
        const changeId = dirOf(blobs).changes[0].id;

        const res = await request(app).post('/api/contacts/change-undo').send({ id: changeId });

        expect(res.status).toBe(200);
        const back = dirOf(blobs).contacts.find(p => p.id === 'p_sri');
        expect(back).toBeTruthy();
        expect(back.company).toBe('Sri Logistics');
        expect(back.enq).toBe(12);
    });

    test('deleting something that is not in the directory says so, instead of answering "done"', async () => {
        // The Delete button also renders inside a queued email's review card, whose id is a
        // preview id the directory has never held. It used to report success and remove nothing.
        const { app, written } = makeApp();

        const res = await request(app).post('/api/contacts/delete').send({ id: 'p_new_pd_9' });

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('nothing was deleted');
        expect(written).toEqual([]);
    });

    test('an email nobody could read is marked unread, not read-with-nothing-in-it', async () => {
        // openai is off in this app, so the read never happened. "0 details" on its own reads
        // as "there was nothing in that email", and the owner files it away.
        const { app, blobs } = makeApp();

        const res = await request(app).post('/api/contacts/pending')
            .send({ from: 'sales@vikastubes.in', subject: 'Brochure', text: 'we make ERW pipes' });

        expect(res.status).toBe(200);
        expect(res.body.finds).toBe(0);
        expect(res.body.readFailed).toBe(true);
        expect(JSON.parse(blobs[CONFIG_KEY_CONTACTS_PENDING]).items[0].readFailed).toBe(true);
    });

    test('an email that arrives WITH its findings is not marked unread', async () => {
        const { app } = makeApp();

        const res = await request(app).post('/api/contacts/pending').send({
            from: 'sales@vikastubes.in', subject: 'Brochure', text: 'x',
            finds: [{ kind: 'field', key: 'company', label: 'Company', value: 'Vikas Tubes' }],
        });

        expect(res.body.finds).toBe(1);
        expect(res.body.readFailed).toBe(false);
    });
});
