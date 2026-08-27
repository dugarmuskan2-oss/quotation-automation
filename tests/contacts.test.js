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
 * House rule for this file: a negative assertion (`not.toContain`) is never left to carry a
 * behaviour on its own — deleting the behaviour only makes a negative MORE true. Every field
 * the module tracks has a POSITIVE assertion somewhere below.
 */

const contactsLib = require('../utils/contacts');

const {
    ROLES, sanitizePartner, mergePartner, findByEmail, allEmails, bumpUsage,
    importFromSuggestions, companyFromEmail, changeEntry, pushChange, diffLines,
    undoChange, sanitizePendingItem, extractionPrompt, findsFromExtraction,
} = contactsLib;

const { normalizeRole, sanitizePerson, sanitizePeople } = contactsLib._test;

/** Today, read at the moment it is needed — a module-load constant flakes across midnight. */
function todayStamp() { return new Date().toISOString().slice(0, 10); }

/**
 * Assert a date stamp was written "now". `before` is todayStamp() captured just before the
 * call; the only other legal answer is today read again now (the midnight rollover case).
 */
function expectStampedToday(value, before) {
    expect([before, todayStamp()]).toContain(value);
}

/** Every address held anywhere on a card, flattened — used to assert who got imported. */
function emailsOf(contacts) {
    return (contacts || []).reduce((acc, c) => acc.concat(allEmails(c)), []);
}

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

    test('a 22-address import (the batch that broke) yields 22 distinct ids', () => {
        const res = withFrozenEntropy(1756000000000, () => 0.5, () => {
            const transporters = [];
            for (let i = 0; i < 22; i++) transporters.push({ email: 'office' + i + '@carrier' + i + '.in', count: 1 });
            return importFromSuggestions([], { transporters }, null);
        });
        expect(res.added).toBe(22);
        expect(new Set(res.contacts.map(c => c.id)).size).toBe(22);
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

    test('the directory itself never exceeds 2000 cards, whichever door adds one', () => {
        const base = manyCards(2000);

        const merged = mergePartner(base, { company: 'Newest Traders' }, ['company']);
        expect(merged.contacts).toHaveLength(2000);
        expect(merged.contacts[0].company).toBe('Newest Traders');
        expect(merged.contacts[1999].company).toBe('Firm 1998');   // the oldest fell off the end

        const bumped = bumpUsage(base, { emails: ['brand.new@nowhere.in'] });
        expect(bumped).toHaveLength(2000);

        const imported = importFromSuggestions(base, {
            transporters: [{ email: 'brand.new@nowhere.in', count: 1 }],
        }, null);
        expect(imported.added).toBe(1);
        expect(imported.contacts).toHaveLength(2000);
    });

    test('bumpUsage reads at most 50 addresses from one send', () => {
        const emails = [];
        for (let i = 0; i < 60; i++) emails.push('bulk' + i + '@carrier' + i + '.in');
        expect(bumpUsage([], { emails })).toHaveLength(50);
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

// ── importFromSuggestions ────────────────────────────────────────────────────

describe('importFromSuggestions — the auto-learned files become partners, safely', () => {
    const ENV_KEY = 'OWN_EMAIL_DOMAINS';
    let savedOwn;
    beforeEach(() => { savedOwn = process.env[ENV_KEY]; });
    afterEach(() => {
        if (savedOwn === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedOwn;
    });

    test('a transporter address becomes a transporter card carrying its address', () => {
        const res = importFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 3, lastUsed: '2026-08-01' }],
        }, null);
        expect(res.added).toBe(1);
        const p = res.contacts[0];
        expect(p.role).toBe('transporter');
        expect(p.company).toBe('Sri Logistics');
        expect(allEmails(p)).toEqual(['ravi@srilogistics.com']);
        expect(p.fromEnquiry).toBe(true);
    });

    test('an address already in the directory is skipped — matched on ANY person on the card', () => {
        // The address the app remembers is often a person's second address, not the first one
        // on the card. Matching only people[0].emails[0] would import a duplicate and, worse,
        // let an import stamp over a card the owner curated.
        const existing = sanitizePartner({
            id: 'p_sri',
            company: 'Sri Logistics (curated by owner)',
            people: [
                person('Reception', ['front.desk@srilogistics.com']),
                person('Ravi', ['ravi.office@srilogistics.com', 'ravi@srilogistics.com']),
            ],
        });

        const res = importFromSuggestions([existing], {
            transporters: [
                { email: 'ravi@srilogistics.com', count: 9, lastUsed: '2026-08-10' },
                { email: 'vrl@vrlgroup.in', count: 2, lastUsed: '2026-08-11' },
            ],
        }, null);

        expect(res.added).toBe(1);
        expect(res.skipped).toBe(1);
        expect(res.contacts).toHaveLength(2);
        const kept = res.contacts.find(c => c.id === 'p_sri');
        expect(kept.company).toBe('Sri Logistics (curated by owner)');
        expect(kept.enq).toBe(0);            // the curated card is left completely alone
    });

    test('the caller\'s own list is not modified — the import returns a new one', () => {
        const existing = [sanitizePartner({ id: 'p_a', company: 'A', people: [person('X', ['x@a.in'])] })];
        const res = importFromSuggestions(existing, { transporters: [{ email: 'new@b.in' }] }, null);
        expect(existing).toHaveLength(1);
        expect(res.contacts).toHaveLength(2);
    });

    test('our own domain is excluded — dscpipes.com by default', () => {
        // Our address lands in the remembered files whenever an enquiry is copied to ourselves.
        // Importing it makes the firm look like its own supplier.
        delete process.env[ENV_KEY];
        const res = importFromSuggestions([], {
            transporters: [{ email: 'info@dscpipes.com' }, { email: 'ravi@srilogistics.com' }],
        }, null);
        expect(emailsOf(res.contacts)).toEqual(['ravi@srilogistics.com']);
        expect(res.added).toBe(1);
    });

    test('OWN_EMAIL_DOMAINS overrides the default, and takes a comma list', () => {
        process.env[ENV_KEY] = 'mypipes.in, second.co';
        const res = importFromSuggestions([], {
            transporters: [
                { email: 'a@mypipes.in' },
                { email: 'b@second.co' },
                { email: 'info@dscpipes.com' },   // no longer "ours" once the env names others
            ],
        }, null);
        expect(emailsOf(res.contacts)).toEqual(['info@dscpipes.com']);
        expect(res.added).toBe(1);
    });

    test('example.com / example.org placeholders are excluded', () => {
        const res = importFromSuggestions([], {
            transporters: [
                { email: 'test@example.com' },
                { email: 'demo@example.org' },
                { email: 'ravi@srilogistics.com' },
            ],
        }, null);
        expect(emailsOf(res.contacts)).toEqual(['ravi@srilogistics.com']);
        expect(res.added).toBe(1);
    });

    test('one address seen twice keeps the HIGHEST count and the NEWEST date', () => {
        // Real history is the whole reason for the import: this transporter was asked 7 times,
        // most recently in August. The global entry is read first and the route entry second,
        // so a merge that simply keeps whatever it saw first would report the July date.
        const res = importFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 7, lastUsed: '2026-07-01' }],
            routes: [{
                pickup: 'Chennai', drop: 'Hyderabad',
                transporters: [{ email: 'ravi@srilogistics.com', count: 2, lastUsed: '2026-08-01' }],
            }],
        }, null);
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].enq).toBe(7);
        expect(res.contacts[0].last).toBe('2026-08-01');
    });

    test('and the other way round — the newest date wins whichever order it arrives in', () => {
        const res = importFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 2, lastUsed: '2026-08-01' }],
            routes: [{
                pickup: 'Chennai', drop: 'Hyderabad',
                transporters: [{ email: 'ravi@srilogistics.com', count: 7, lastUsed: '2026-07-01' }],
            }],
        }, null);
        expect(res.contacts[0].enq).toBe(7);
        expect(res.contacts[0].last).toBe('2026-08-01');
    });

    test('last comes from lastUsed as a date only, not the full timestamp', () => {
        const res = importFromSuggestions([], {
            transporters: [{ email: 'ravi@srilogistics.com', count: 1, lastUsed: '2026-08-01T09:30:00.000Z' }],
        }, null);
        expect(res.contacts[0].last).toBe('2026-08-01');
    });

    test('routes are deduped (case/spacing ignored), keeping each distinct lane once', () => {
        const res = importFromSuggestions([], {
            routes: [
                { pickup: 'Chennai', drop: 'Hyderabad', transporters: [{ email: 'ravi@srilogistics.com' }] },
                { pickup: 'chennai', drop: 'HYDERABAD', transporters: [{ email: 'ravi@srilogistics.com' }] },
                { pickup: 'Chennai', drop: 'Mumbai', transporters: [{ email: 'ravi@srilogistics.com' }] },
            ],
        }, null);
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].routes).toEqual([
            { from: 'Chennai', to: 'Hyderabad' },
            { from: 'Chennai', to: 'Mumbai' },
        ]);
    });

    test('pipe types are uppercased and deduped', () => {
        const res = importFromSuggestions([], null, {
            byType: {
                erw: [{ email: 'sales@kalpatarusteel.com', count: 1 }],
                ERW: [{ email: 'sales@kalpatarusteel.com', count: 1 }],
                gi: [{ email: 'sales@kalpatarusteel.com', count: 1 }],
            },
        });
        expect(res.contacts).toHaveLength(1);
        expect(res.contacts[0].types).toEqual(['ERW', 'GI']);
        expect(res.contacts[0].role).toBe('dealer');
    });

    test('added + skipped describe what actually happened', () => {
        const existing = sanitizePartner({ company: 'Known', people: [person('X', ['known@x.in'])] });
        const res = importFromSuggestions([existing], {
            transporters: [{ email: 'known@x.in' }, { email: 'new1@y.in' }],
        }, { suppliers: [{ email: 'new2@z.in' }, { email: 'known@x.in' }] });
        expect(res.added).toBe(2);
        expect(res.skipped).toBe(1);          // one address, seen twice, is one skip
        expect(res.contacts).toHaveLength(3);
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

    test("kind:'reply' counts a reply, not an enquiry", () => {
        const list = bumpUsage([known()], { emails: ['ravi@srilogistics.com'], kind: 'reply' });
        expect(list[0].rep).toBe(1);
        expect(list[0].enq).toBe(0);
    });

    test('anything else counts an enquiry, not a reply', () => {
        const list = bumpUsage([known()], { emails: ['ravi@srilogistics.com'], kind: 'enquiry' });
        expect(list[0].enq).toBe(1);
        expect(list[0].rep).toBe(0);
        const noKind = bumpUsage([known()], { emails: ['ravi@srilogistics.com'] });
        expect(noKind[0].enq).toBe(1);
    });

    test('an address we have never seen becomes a stub partner rather than being dropped', () => {
        const list = bumpUsage([], {
            emails: ['ops@vrlgroup.in'], kind: 'enquiry', role: 'transporter',
            pipeTypes: ['ERW'], pickup: 'Chennai', drop: 'Hyderabad',
        });
        expect(list).toHaveLength(1);
        expect(allEmails(list[0])).toEqual(['ops@vrlgroup.in']);
        expect(list[0].role).toBe('transporter');
        expect(list[0].fromEnquiry).toBe(true);
        expect(list[0].enq).toBe(1);
        expect(list[0].routes).toEqual([{ from: 'Chennai', to: 'Hyderabad' }]);
    });

    test('the stub carries the pipe types the enquiry was about', () => {
        // Without these the stub is a nameless address and the owner has no idea what it was
        // for — the whole point of a self-filling directory is that it arrives with context.
        const list = bumpUsage([], {
            emails: ['sales@kalpatarusteel.com'], kind: 'enquiry', pipeTypes: ['ERW', 'GI'],
        });
        expect(list[0].types).toEqual(['ERW', 'GI']);
    });

    test('the stub guesses the firm name from the domain, same as the import does', () => {
        // A card titled "ops@vrlgroup.in" is unreadable in the list. Both doors into the
        // directory call companyFromEmail for exactly this reason; only one was ever tested.
        const list = bumpUsage([], { emails: ['ops@vrlgroup.in'] });
        expect(list[0].company).toBe('Vrl Group');
    });

    test('a free-mail stub falls back to the address, because the domain says nothing', () => {
        const list = bumpUsage([], { emails: ['ravi.transport@gmail.com'] });
        expect(list[0].company).toBe('ravi.transport@gmail.com');
    });

    test("'last' is stamped with today", () => {
        const at = todayStamp();
        const list = bumpUsage([known()], { emails: ['ravi@srilogistics.com'], kind: 'reply' });
        expectStampedToday(list[0].last, at);
    });

    test('an address already on a card is counted there, never duplicated', () => {
        let list = [known()];
        list = bumpUsage(list, { emails: ['RAVI@srilogistics.com'], kind: 'enquiry' });
        list = bumpUsage(list, { emails: ['ravi@srilogistics.com'], kind: 'enquiry' });
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('p_known');
        expect(list[0].enq).toBe(2);
    });

    test("the caller's list is not grown in place — a new list comes back", () => {
        const stored = [known()];
        const out = bumpUsage(stored, { emails: ['brand.new@nowhere.in'] });
        expect(stored).toHaveLength(1);
        expect(out).toHaveLength(2);
    });

    test('rubbish that is not an address creates nothing', () => {
        const list = bumpUsage([], { emails: ['not-an-email', '   ', 'ravi@srilogistics.com'] });
        expect(list).toHaveLength(1);
        expect(allEmails(list[0])).toEqual(['ravi@srilogistics.com']);
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
