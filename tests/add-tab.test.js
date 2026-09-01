/**
 * tests/add-tab.test.js
 *
 * Guards the Partner Directory's ADD TAB — the one box the owner drops a visiting card,
 * a brochure or a typed sentence into, and the popup that shows exactly what would change
 * before anything is written.
 *
 * The tab was built and checked by hand. These are its first tests, and they exist to stop
 * the specific things that have already gone wrong here from coming back:
 *
 *  - READING must not WRITE. /contacts/add-draft costs a paid AI call and shows a popup;
 *    if it also stored something, "Cancel" would be a lie. Every add-draft test below
 *    asserts the RECORDED storage writes are [], not that a blob merely looks unchanged —
 *    a re-save of identical bytes is still a write, and the next careless change makes it
 *    a destructive one.
 *  - APPLYING must rebuild onto the card as it is STORED NOW. The browser's copy of the
 *    card can be minutes old; an enquiry sent in between must not have its count rolled
 *    back, and a colleague's note added in between must not vanish (CLAUDE.md checks #1
 *    and #2).
 *  - An untick must really mean "do not write that", not "grey it out on screen".
 *  - Nothing may be guessed. A pipe size with no type, on a firm dealing in two types, is
 *    a half-fact — ask (CLAUDE.md check #5). A role, a city or a company name the owner's
 *    own words never contained is a guess, and gets dropped.
 *  - "add 24 inch to msl" once proposed updating adarshroadcarriers@yahoo.com. A matching
 *    id is not evidence; the owner's words have to point at the card.
 *  - A FAILURE MUST LOOK LIKE A FAILURE, and the failures must not all read alike
 *    (CLAUDE.md check #4). "I could not read your photo" and "it is all already on the
 *    card" call for opposite actions from the owner.
 *
 * House rule, same as tests/contacts.test.js: every negative assertion is paired with a
 * positive one that fails if the behaviour is deleted rather than merely satisfied.
 */

const express = require('express');
const request = require('supertest');

const createContactsRouter = require('../routes/contacts');
const contactsLib = require('../utils/contacts');
const { sanitizePartner, groundInText, addDraftMode, addSteps, addChangeList,
    applyAddSteps } = contactsLib;
const { CONFIG_KEY_CONTACTS } = require('../utils/constants');

// ── the harness: the real router over storage that REMEMBERS every write ─────

/**
 * A stub of the one OpenAI call the Add tab makes. `reply` is the raw text the model would
 * hand back — an object is JSON-stringified for convenience, an Error is thrown instead.
 * `filesThrow` makes the PDF upload fail, which is how a real unreadable PDF behaves.
 */
function stubAi(reply, { filesThrow = false } = {}) {
    const asked = [];
    return {
        asked,
        responses: {
            create: async (req) => {
                asked.push(req);
                if (reply instanceof Error) throw reply;
                return { output_text: typeof reply === 'string' ? reply : JSON.stringify(reply) };
            },
        },
        files: {
            create: async () => {
                if (filesThrow) throw new Error('upload refused');
                return { id: 'file_stub' };
            },
        },
    };
}

/** The real router, an in-memory directory, and a log of every saveText that happened. */
function makeApp({ contacts = [], changes = [], ai = null } = {}) {
    const blobs = { [CONFIG_KEY_CONTACTS]: JSON.stringify({ contacts, changes }) };
    const writes = [];
    const storage = {
        readText: async (key) => (key in blobs ? blobs[key] : ''),
        saveText: async (key, text) => { writes.push({ key, text }); blobs[key] = text; },
    };
    const app = express();
    app.use('/api', createContactsRouter({ storage, openai: ai }));
    return { app, blobs, writes, storage };
}

function stored(blobs) { return JSON.parse(blobs[CONFIG_KEY_CONTACTS]); }
function cardsIn(blobs) { return stored(blobs).contacts; }
function writtenKeys(writes) { return writes.map(w => w.key); }

const MSL = () => sanitizePartner({
    id: 'p_msl', company: 'MSL Tubes', role: 'manufacturer', city: 'Chennai',
    types: ['GI', 'ERW'],
    people: [{ name: 'Suresh', role: 'Main contact', emails: [{ label: 'Work', v: 'suresh@msltubes.in' }] }],
    enq: 12, rep: 5, last: '2026-08-30',
});

const ARC = () => sanitizePartner({
    id: 'p_arc', company: 'adarshroadcarriers@yahoo.com', role: 'transporter',
    people: [{ name: '', role: 'Main contact', emails: [{ label: 'Work', v: 'adarshroadcarriers@yahoo.com' }] }],
});

// A whole new transporter, worded so every field it fills is actually IN the sentence —
// groundInText drops anything the words do not support, which is the point of that test.
const NEW_FIRM_TEXT = 'Sri Balaji Steels, Coimbatore, they run lorries to Chennai, Ravi 98400 12345';
const NEW_FIRM_JSON = {
    mode: 'new', company: 'Sri Balaji Steels', city: 'Coimbatore', role: 'transporter',
    person: 'Ravi', phone: '98400 12345', routes: [{ from: 'Coimbatore', to: 'Chennai' }],
    notes: [], read: 'Adding Sri Balaji Steels of Coimbatore as a new transporter.',
};

// ── reading writes NOTHING ───────────────────────────────────────────────────

describe('/contacts/add-draft reads and stores nothing at all', () => {
    test('a read that would add a whole new firm records ZERO storage writes', async () => {
        const { app, writes, blobs } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });

        const res = await request(app).post('/api/contacts/add-draft').send({ text: NEW_FIRM_TEXT });

        // Positive first: the read really did understand a new firm, so "nothing was written"
        // is a statement about a WORKING read, not about a route that fell over.
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('new');
        expect(res.body.after.company).toBe('Sri Balaji Steels');
        expect(res.body.changes.length).toBeGreaterThan(1);

        expect(writes).toEqual([]);
        expect(cardsIn(blobs)).toEqual([]);
    });

    test('a read that would update a firm we hold records ZERO storage writes', async () => {
        const { app, writes, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });
        const before = blobs[CONFIG_KEY_CONTACTS];

        const res = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });

        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('update');
        expect(res.body.matchId).toBe('p_msl');
        expect(res.body.lines.length).toBeGreaterThan(0);

        expect(writes).toEqual([]);
        expect(blobs[CONFIG_KEY_CONTACTS]).toBe(before);
    });

    test('even a read that understood NOTHING writes nothing', async () => {
        const { app, writes } = makeApp({ ai: stubAi({ mode: 'new', read: '' }) });
        const res = await request(app).post('/api/contacts/add-draft').send({ text: 'zzz qqq' });
        expect(res.body.mode).toBe('nothing');
        expect(writes).toEqual([]);
    });

    test('the popup shows the card as it WOULD be, and the stored card is untouched', async () => {
        // `after` is what the owner is being asked to approve. It must show the change — and
        // it must not be mistaken for something already saved.
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });

        const res = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });

        expect(res.body.after.products.map(p => p.p)).toEqual(['24 inch pipes']);
        expect(res.body.before.id).toBe('p_msl');
        expect(cardsIn(blobs)[0].products).toEqual([]);
    });
});

// ── applying is the one write ────────────────────────────────────────────────

describe('/contacts/add-apply is the only write the Add tab makes', () => {
    /** Read, then apply exactly what the popup offered — the owner's real path. */
    async function readThenApply(app, body, pick) {
        const draft = await request(app).post('/api/contacts/add-draft').send(body);
        const steps = (draft.body.changes || []).filter(pick || (() => true)).map(c => c.step);
        const applied = await request(app).post('/api/contacts/add-apply').send({
            after: draft.body.after, matchId: draft.body.matchId || '',
            steps, source: draft.body.source || '',
        });
        return { draft: draft.body, applied };
    }

    test('read then apply writes the directory ONCE, and only on the apply', async () => {
        const { app, writes, blobs } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });

        const { applied } = await readThenApply(app, { text: NEW_FIRM_TEXT });

        expect(applied.status).toBe(200);
        expect(writtenKeys(writes)).toEqual([CONFIG_KEY_CONTACTS]);
        const card = cardsIn(blobs).find(p => p.company === 'Sri Balaji Steels');
        expect(card.city).toBe('Coimbatore');
        expect(card.role).toBe('transporter');
        expect(card.people[0].name).toBe('Ravi');
        expect(card.people[0].phones[0].v).toBe('98400 12345');
    });

    test('it goes through mergePartner: an address another card holds is a 409 and nothing is stored', async () => {
        // One address, one company. The Add tab must not be a back door around the rule the
        // Directory tab enforces.
        const { app, writes, blobs } = makeApp({ contacts: [MSL()] });
        const before = blobs[CONFIG_KEY_CONTACTS];

        const res = await request(app).post('/api/contacts/add-apply').send({
            after: { company: 'Vikas Tubes', people: [{ name: 'V', emails: [{ label: 'Work', v: 'suresh@msltubes.in' }] }] },
        });

        expect(res.status).toBe(409);
        expect(res.body.error).toContain('suresh@msltubes.in');
        expect(res.body.error).toContain('MSL Tubes');
        expect(writes).toEqual([]);
        expect(blobs[CONFIG_KEY_CONTACTS]).toBe(before);
    });

    test('and it still saves a clean one — the 409 is not a blanket refusal', async () => {
        const { app, blobs } = makeApp({ contacts: [MSL()] });
        const res = await request(app).post('/api/contacts/add-apply').send({
            after: { company: 'Vikas Tubes', people: [{ name: 'V', emails: [{ label: 'Work', v: 'sales@vikastubes.in' }] }] },
        });
        expect(res.status).toBe(200);
        expect(cardsIn(blobs).map(p => p.company)).toContain('Vikas Tubes');
    });

    test('the apply is logged as an undoable change, and the undo really removes the card', async () => {
        const { app, blobs } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        await readThenApply(app, { text: NEW_FIRM_TEXT });

        const listed = await request(app).get('/api/contacts');
        const entry = listed.body.changes[0];
        expect(entry.title).toBe('Added Sri Balaji Steels');
        expect(entry.source).toBe('Added by hand');
        expect(entry.before).toBeNull();               // a new card: undo means remove it
        expect(entry.detail).toMatch(/details you checked and applied$/);
        expect(entry.lines.length).toBeGreaterThan(0);

        const undone = await request(app).post('/api/contacts/change-undo').send({ id: entry.id });
        expect(undone.status).toBe(200);
        expect(cardsIn(blobs).map(p => p.company)).not.toContain('Sri Balaji Steels');
        expect(cardsIn(blobs)).toEqual([]);
    });

    test('an update is logged with the BEFORE card, so undo restores it rather than deleting it', async () => {
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes', spec: 'ERW' }], read: 'ok' }),
        });
        await readThenApply(app, { text: 'MSL now has 24 inch pipes also' });
        expect(cardsIn(blobs)[0].products.map(p => p.p)).toEqual(['24 inch pipes']);

        const entry = (await request(app).get('/api/contacts')).body.changes[0];
        expect(entry.title).toBe('MSL Tubes updated');
        expect(entry.before.id).toBe('p_msl');

        const undone = await request(app).post('/api/contacts/change-undo').send({ id: entry.id });
        expect(undone.status).toBe(200);
        expect(cardsIn(blobs)).toHaveLength(1);
        expect(cardsIn(blobs)[0].company).toBe('MSL Tubes');
        expect(cardsIn(blobs)[0].products).toEqual([]);
    });

    // ── pressing Apply twice (CLAUDE.md check #3) ─────────────────────────────
    //
    // The Apply button is one click away from writing to the directory, and the popup
    // stays put while the request is in flight. An impatient second click must be a
    // no-op, not a second card for the same firm — nobody notices a duplicate on the day
    // it is made, and by the time they do, half a year of enquiries has gone to one copy
    // and half to the other.

    test('applying the same whole card twice lands on ONE card, not two', async () => {
        // The route keeps the id it was handed when there is no match, so the second press
        // finds the card the first press made and rewrites it.
        const { app, blobs } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        const draft = await request(app).post('/api/contacts/add-draft').send({ text: NEW_FIRM_TEXT });
        const body = { after: draft.body.after, matchId: '' };

        const first = await request(app).post('/api/contacts/add-apply').send(body);
        const second = await request(app).post('/api/contacts/add-apply').send(body);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(cardsIn(blobs).map(p => p.company)).toEqual(['Sri Balaji Steels']);
    });

    // KNOWN BUG, pinned here on purpose — see the note this test returns with.
    //
    // This is the path the popup actually uses: it posts the ticked `steps`, not the whole
    // card. On that path add-apply rebuilds the card from the steps with a BRAND NEW id and
    // throws away the id on `after`, so the second press cannot find the first press's card
    // and files a second one. Two "Sri Balaji Steels" in the directory, from one double-click.
    //
    // Marked `failing` so the suite stays honest without this agent editing a route it does
    // not own: it is green while the bug is there and turns RED the moment somebody fixes
    // add-apply — which is the reminder to delete the `.failing` and keep the guard.
    test.failing('DOUBLE-CLICKING Apply on the ticked steps makes a SECOND card (bug)', async () => {
        const { app, blobs } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        const draft = await request(app).post('/api/contacts/add-draft').send({ text: NEW_FIRM_TEXT });
        const body = {
            after: draft.body.after, matchId: '',
            steps: draft.body.changes.map(c => c.step), source: draft.body.source,
        };

        await request(app).post('/api/contacts/add-apply').send(body);
        await request(app).post('/api/contacts/add-apply').send(body);

        expect(cardsIn(blobs).map(p => p.company)).toEqual(['Sri Balaji Steels']);
    });

    test('a second Apply onto a firm we already hold rewrites it instead of duplicating', async () => {
        // With a matchId the write is aimed at the stored card, so the second press is
        // harmless. This is the half that already works, and it must keep working.
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes', spec: 'ERW' }], read: 'ok' }),
        });
        const draft = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });
        const body = {
            after: draft.body.after, matchId: 'p_msl',
            steps: draft.body.changes.map(c => c.step), source: draft.body.source,
        };

        await request(app).post('/api/contacts/add-apply').send(body);
        await request(app).post('/api/contacts/add-apply').send(body);

        expect(cardsIn(blobs)).toHaveLength(1);
        expect(cardsIn(blobs)[0].id).toBe('p_msl');
        expect(cardsIn(blobs)[0].products.map(p => p.p)).toEqual(['24 inch pipes']);
    });

    test('applying against a firm that has since been deleted says so, and writes nothing', async () => {
        const { app, writes } = makeApp({ contacts: [] });
        const res = await request(app).post('/api/contacts/add-apply')
            .send({ after: { company: 'MSL Tubes' }, matchId: 'p_gone', steps: [] });
        expect(res.status).toBe(404);
        expect(res.body.error).toContain('no longer in your directory');
        expect(writes).toEqual([]);
    });
});

// ── the tick-boxes ───────────────────────────────────────────────────────────

describe('the owner ticks what to keep, and an untick really excludes it', () => {
    async function draftNewFirm() {
        const app = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        const draft = await request(app.app).post('/api/contacts/add-draft').send({ text: NEW_FIRM_TEXT });
        return { app, draft: draft.body };
    }

    test('the reading is broken into separate ticked changes, one per thing it would do', async () => {
        const { draft } = await draftNewFirm();
        const labels = draft.changes.map(c => c.lines.map(l => l.label).join('+'));
        expect(labels).toEqual(expect.arrayContaining(['Company', 'City', 'Route added', 'Contact added']));
        expect(draft.changes.every(c => c.lines.length > 0)).toBe(true);   // no empty tick-boxes
    });

    test('a part of the reading that changes nothing is not offered as an empty tick-box', async () => {
        // Two products read off one page, one of them already on the card. The one that would
        // change nothing must be left out — an empty tick-box asks the owner to approve a
        // blank, and makes the "Apply 2 of 3" count a lie.
        const card = Object.assign(MSL(), { products: [{ p: '24 inch pipes', spec: 'ERW' }] });
        const { app } = makeApp({
            contacts: [sanitizePartner(card)],
            ai: stubAi({
                mode: 'update', matchId: 'p_msl',
                products: [{ p: '24 inch pipes' }, { p: '12 inch pipes' }], read: 'ok',
            }),
        });

        const res = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes and 12 inch pipes' });

        expect(res.body.changes).toHaveLength(1);
        expect(res.body.changes[0].lines.map(l => l.to)).toEqual(['12 inch pipes — no minimum given']);
    });

    test('keeping every change writes every one of them', async () => {
        const { app, draft } = await draftNewFirm();
        await request(app.app).post('/api/contacts/add-apply').send({
            after: draft.after, matchId: '', steps: draft.changes.map(c => c.step), source: draft.source,
        });
        const card = cardsIn(app.blobs)[0];
        expect(card.city).toBe('Coimbatore');
        expect(card.role).toBe('transporter');
        expect(card.routes).toEqual([{ from: 'Coimbatore', to: 'Chennai' }]);
        expect(card.people[0].name).toBe('Ravi');
    });

    test('unticking the city and the route leaves BOTH out — and keeps the rest', async () => {
        // The negatives here are carried by the positives beside them: a route that ignored
        // `steps` entirely would put the city and the route back, and a route that wrote
        // nothing would drop the company too.
        const { app, draft } = await draftNewFirm();
        const dropped = ['City', 'Route added'];
        const kept = draft.changes.filter(c => !c.lines.some(l => dropped.indexOf(l.label) !== -1));
        expect(kept.length).toBe(draft.changes.length - 2);

        const res = await request(app.app).post('/api/contacts/add-apply').send({
            after: draft.after, matchId: '', steps: kept.map(c => c.step), source: draft.source,
        });

        expect(res.status).toBe(200);
        const card = cardsIn(app.blobs)[0];
        expect(card.company).toBe('Sri Balaji Steels');
        expect(card.role).toBe('transporter');
        expect(card.people[0].name).toBe('Ravi');
        expect(card.city).toBe('');
        expect(card.routes).toEqual([]);
    });

    test('unticking EVERYTHING writes nothing and says nothing was kept', async () => {
        const { app, draft } = await draftNewFirm();
        const res = await request(app.app).post('/api/contacts/add-apply').send({
            after: draft.after, matchId: '', steps: [], source: draft.source,
        });
        expect(res.status).toBe(200);
        expect(res.body.skipped).toBe('nothing-kept');
        expect(app.writes).toEqual([]);
        expect(cardsIn(app.blobs)).toEqual([]);
    });

    test('an answered pipe-type question rides on the step and is what gets stored', async () => {
        // The popup asks "which of these is the 24 inch pipes?" and the owner presses ERW.
        // That answer is written onto the step, so the card records ERW rather than the blank
        // the model left.
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });
        const draft = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });

        const step = JSON.parse(JSON.stringify(draft.body.changes[0].step));
        step.product[draft.body.changes[0].ask.key] = 'ERW';
        await request(app).post('/api/contacts/add-apply').send({
            after: draft.body.after, matchId: 'p_msl', steps: [step], source: draft.body.source,
        });

        expect(cardsIn(blobs)[0].products).toEqual([
            expect.objectContaining({ p: '24 inch pipes', spec: 'ERW' }),
        ]);
    });
});

// ── apply rebuilds onto the STORED card ──────────────────────────────────────

describe('apply is rebuilt onto the card as it is stored NOW, not the browser copy', () => {
    test("a colleague's note added between Read and Apply survives the apply", async () => {
        // The popup's `after` was built minutes ago. Writing that back would silently drop
        // whatever landed on the card in between (CLAUDE.md check #2).
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes', spec: 'ERW' }], read: 'ok' }),
        });
        const draft = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });

        // ...meanwhile, in the Directory tab, somebody adds a note to the same card.
        const dir = stored(blobs);
        dir.contacts[0].notes = [{ d: '2026-09-01', t: 'Rang about the September rates', src: 'by hand' }];
        blobs[CONFIG_KEY_CONTACTS] = JSON.stringify(dir);

        const res = await request(app).post('/api/contacts/add-apply').send({
            after: draft.body.after, matchId: 'p_msl',
            steps: draft.body.changes.map(c => c.step), source: draft.body.source,
        });

        expect(res.status).toBe(200);
        const card = cardsIn(blobs)[0];
        expect(card.notes.map(n => n.t)).toEqual(['Rang about the September rates']);
        expect(card.products.map(p => p.p)).toEqual(['24 inch pipes']);   // the read still landed
    });

    test('enq, rep and last are the app\'s own — a stale copy cannot roll them back', async () => {
        // No `steps` in this body: that is the real path when the reading is a single change,
        // and the ONLY thing standing between an old browser copy and the counters is the
        // narrowed field list on the write.
        const { app, blobs } = makeApp({ contacts: [MSL()] });
        const stale = Object.assign(MSL(), {
            enq: 0, rep: 0, last: '', city: 'Coimbatore',
        });

        const res = await request(app).post('/api/contacts/add-apply')
            .send({ after: stale, matchId: 'p_msl' });

        expect(res.status).toBe(200);
        const card = cardsIn(blobs)[0];
        expect(card.city).toBe('Coimbatore');      // what the owner actually approved DID land
        expect(card.enq).toBe(12);
        expect(card.rep).toBe(5);
        expect(card.last).toBe('2026-08-30');
    });

    test('the write aims at the STORED card, whatever id the browser sent back', async () => {
        const { app, blobs } = makeApp({ contacts: [MSL()] });
        const res = await request(app).post('/api/contacts/add-apply')
            .send({ after: { id: 'p_somewhere_else', company: 'MSL Tubes', city: 'Madurai' }, matchId: 'p_msl' });
        expect(res.status).toBe(200);
        expect(cardsIn(blobs)).toHaveLength(1);
        expect(cardsIn(blobs)[0].id).toBe('p_msl');
        expect(cardsIn(blobs)[0].city).toBe('Madurai');
    });
});

// ── a size with no type is a half-fact: ask ──────────────────────────────────

describe('a product with no pipe type asks which — but only when there is a real choice', () => {
    /** The change list the popup renders, for one product read onto one card. */
    function changesFor(card, product) {
        return addChangeList(card, addSteps({ products: [product] }), 'typed in');
    }

    test('two pipe types and a bare size: it asks, and offers exactly those types', () => {
        const rows = changesFor(MSL(), { p: '24 inch pipes' });
        expect(rows).toHaveLength(1);
        expect(rows[0].ask).toEqual({
            key: 'spec', question: 'Which of these is the 24 inch pipes?', options: ['GI', 'ERW'],
        });
    });

    test('three pipe types offers all three', () => {
        const card = Object.assign(MSL(), { types: ['GI', 'ERW', 'Seamless'] });
        expect(changesFor(card, { p: '24 inch pipes' })[0].ask.options).toEqual(['GI', 'ERW', 'Seamless']);
    });

    test('ONE pipe type asks nothing — there is nothing to choose', () => {
        const card = Object.assign(MSL(), { types: ['ERW'] });
        const rows = changesFor(card, { p: '24 inch pipes' });
        expect(rows).toHaveLength(1);            // the change is still offered...
        expect(rows[0].ask).toBeUndefined();     // ...it just needs no question
    });

    test('no pipe types at all asks nothing', () => {
        const card = Object.assign(MSL(), { types: [] });
        expect(changesFor(card, { p: '24 inch pipes' })[0].ask).toBeUndefined();
    });

    test('a size the owner already qualified asks nothing', () => {
        expect(changesFor(MSL(), { p: '24 inch ERW pipes' })[0].ask).toBeUndefined();
        expect(changesFor(MSL(), { p: '2 inch heavy GI' })[0].ask).toBeUndefined();
    });

    test('a spec the model already read asks nothing', () => {
        expect(changesFor(MSL(), { p: '24 inch pipes', spec: 'Seamless' })[0].ask).toBeUndefined();
    });

    test('the question reaches the popup through the route, not just the helper', async () => {
        const { app } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });
        const res = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });
        expect(res.body.changes[0].ask.options).toEqual(['GI', 'ERW']);
    });

    // Everything above reads onto a card with an EMPTY product list, which is the rarer
    // half of the job — a firm you have dealt with for years already stocks things. On a
    // stocked card the new size is not the only product on the card when the question is
    // built, so anything that reaches for "the product" rather than THIS one gets the
    // question wrong while every empty-card test stays green.
    const STOCKED = () => sanitizePartner(Object.assign(MSL(), {
        products: [{ p: '12 inch pipes', spec: 'GI', sizes: [], moq: 0, rule: '' }],
    }));

    test('a firm that already stocks things is still asked about a NEW bare size', () => {
        const rows = changesFor(STOCKED(), { p: '24 inch pipes' });
        expect(rows).toHaveLength(1);
        expect(rows[0].lines[0].to).toContain('24 inch pipes');
        expect(rows[0].ask).toEqual({
            key: 'spec', question: 'Which of these is the 24 inch pipes?', options: ['GI', 'ERW'],
        });
    });

    test('two bare sizes onto a stocked card ask twice, each about its OWN size', () => {
        const rows = addChangeList(STOCKED(),
            addSteps({ products: [{ p: '24 inch pipes' }, { p: '36 inch pipes' }] }), 'typed in');
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.ask.question)).toEqual([
            'Which of these is the 24 inch pipes?',
            'Which of these is the 36 inch pipes?',
        ]);
    });

    test('on a stocked card, a size the owner qualified still asks nothing', () => {
        // The other half: the guard must not start firing just because the card has stock.
        expect(changesFor(STOCKED(), { p: '24 inch ERW pipes' })[0].ask).toBeUndefined();
    });

    test('and the stocked case reaches the popup through the route too', async () => {
        const { app } = makeApp({
            contacts: [STOCKED()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });
        const res = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'MSL now has 24 inch pipes also' });
        expect(res.body.changes).toHaveLength(1);
        expect(res.body.changes[0].ask.question).toBe('Which of these is the 24 inch pipes?');
    });
});

// ── nothing the owner did not say ────────────────────────────────────────────

describe('groundInText drops what the typed words never supported', () => {
    const TYPED = 'MSL now has 24 inch pipes also';

    test('a role invented from a product line is dropped', () => {
        // Live: this exact sentence came back proposing MSL was a DEALER. The card says
        // manufacturer. Nothing in those six words is about what kind of firm they are.
        const out = groundInText({ mode: 'update', matchId: 'p_msl', role: 'dealer' }, TYPED, false);
        expect(out.role).toBe('');
    });

    test('a city and a company name the sentence never contained are dropped', () => {
        const out = groundInText({ city: 'Coimbatore', company: 'Sri Balaji Steels' }, TYPED, false);
        expect(out.city).toBe('');
        expect(out.company).toBe('');
    });

    test('a role the words DO support is kept', () => {
        // The positive half: without this, "drop the role" passes just as well as "drop
        // everything", and the Add tab could never record a transporter again.
        const out = groundInText({ role: 'transporter' }, NEW_FIRM_TEXT, false);
        expect(out.role).toBe('transporter');
    });

    test('a city and a company the words DO contain are kept', () => {
        const out = groundInText({ city: 'Coimbatore', company: 'Sri Balaji Steels' }, NEW_FIRM_TEXT, false);
        expect(out.city).toBe('Coimbatore');
        expect(out.company).toBe('Sri Balaji Steels');
    });

    test('only four things are checked — role, company, city, vehicles', () => {
        // Named exactly, because "it drops what the words did not support" reads as if it
        // checked everything. It does not, and it must not: a product, a note, a person, a
        // phone number and a pipe type are all things a sentence states without repeating
        // them word for word, and grounding those would throw away real readings.
        const out = groundInText({
            products: [{ p: '24 inch pipes' }], notes: ['Payment in 30 days'],
            person: 'Ravi', phone: '98400 12345', types: 'GI, ERW', branches: 'Salem',
        }, TYPED, false);
        expect(out.products).toEqual([{ p: '24 inch pipes' }]);
        expect(out.notes).toEqual(['Payment in 30 days']);
        expect(out.person).toBe('Ravi');
        expect(out.phone).toBe('98400 12345');
        expect(out.types).toBe('GI, ERW');
        expect(out.branches).toBe('Salem');
    });

    test('vehicles the words never mentioned are dropped, and ones they did are kept', () => {
        // The fourth checked field, and the only one with no test of its own — a fleet the
        // owner never typed is as much a guess as a city they never typed.
        expect(groundInText({ vehicles: '10 wheeler trucks' }, TYPED, false).vehicles).toBe('');
        expect(groundInText({ vehicles: 'lorries' }, NEW_FIRM_TEXT, false).vehicles).toBe('lorries');
    });

    test('with a file attached nothing is grounded — the words are inside the file', () => {
        // The typed words here would FAIL the check: no role word in them, and no Salem. It
        // is the attached file that lets both through. Handing '' as the text instead would
        // pass whether the file mattered or not — the old version of this test did, and could
        // not fail.
        const kept = groundInText({ role: 'dealer', city: 'Salem' }, TYPED, true);
        expect(kept.role).toBe('dealer');
        expect(kept.city).toBe('Salem');

        const dropped = groundInText({ role: 'dealer', city: 'Salem' }, TYPED, false);
        expect(dropped.role).toBe('');
        expect(dropped.city).toBe('');
    });

    test('with nothing typed at all there is nothing to check against, so nothing is dropped', () => {
        const out = groundInText({ role: 'dealer', city: 'Salem' }, '', false);
        expect(out.role).toBe('dealer');
        expect(out.city).toBe('Salem');
    });

    test('the route really applies it — a read cannot smuggle a role past it', async () => {
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', role: 'dealer', products: [{ p: '24 inch pipes', spec: 'ERW' }], read: 'ok' }),
        });
        const draft = await request(app).post('/api/contacts/add-draft').send({ text: TYPED });

        expect(draft.body.changes.map(c => c.lines.map(l => l.label).join())).not.toContain('They are a');
        await request(app).post('/api/contacts/add-apply').send({
            after: draft.body.after, matchId: 'p_msl',
            steps: draft.body.changes.map(c => c.step), source: draft.body.source,
        });
        expect(cardsIn(blobs)[0].role).toBe('manufacturer');
        expect(cardsIn(blobs)[0].products.map(p => p.p)).toEqual(['24 inch pipes']);
    });
});

// ── the words have to point at the card ──────────────────────────────────────

describe('"add 24 inch to msl" must not land on adarshroadcarriers@yahoo.com', () => {
    const FIRMS = contactsLib.firmsForPrompt([ARC(), MSL()]);

    test('a real id with no name, on a card the words do not mention, becomes a question', () => {
        const out = addDraftMode({ mode: 'update', matchId: 'p_arc' }, FIRMS, '', 'add 24 inch to msl');
        expect(out.mode).toBe('unsure');
        expect(out.matchId).toBe('');
        expect(out.questions[0]).toContain('Which firm is that about?');
        expect(out.questions[0]).toContain('adarshroadcarriers@yahoo.com');
    });

    test('the same words pointing at the card they DO name go straight through', () => {
        const out = addDraftMode({ mode: 'update', matchId: 'p_msl' }, FIRMS, '', 'add 24 inch to msl');
        expect(out.mode).toBe('update');
        expect(out.matchId).toBe('p_msl');
        expect(out.questions).toEqual([]);
    });

    test('a name that disagrees with the card is a question too, and names both', () => {
        const out = addDraftMode({ mode: 'update', matchId: 'p_msl', company: 'ARC Limited' }, FIRMS, '',
            'ARC Limited now stock 24 inch');
        expect(out.mode).toBe('unsure');
        expect(out.matchId).toBe('');
        expect(out.questions[0]).toContain('ARC Limited');
        expect(out.questions[0]).toContain('MSL Tubes');
    });

    test('pressing the firm\'s name settles it — no name check, no second question', () => {
        const out = addDraftMode({ mode: 'update', matchId: 'p_arc' }, FIRMS, 'p_msl', 'add 24 inch to msl');
        expect(out.mode).toBe('update');
        expect(out.matchId).toBe('p_msl');
        expect(out.questions).toEqual([]);
    });

    test('the route asks rather than writing, and offers the near-miss card to press', async () => {
        const { app, writes } = makeApp({
            contacts: [ARC(), MSL()],
            ai: stubAi({ mode: 'update', matchId: 'p_arc', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });
        const res = await request(app).post('/api/contacts/add-draft').send({ text: 'add 24 inch to msl' });

        expect(res.body.mode).toBe('unsure');
        expect(res.body.matchId).toBe('');
        expect(res.body.candidates.map(c => c.id)).toEqual(['p_arc']);
        expect(writes).toEqual([]);
    });

    test('an id the directory does not hold never becomes a silent new card', () => {
        const out = addDraftMode({ mode: 'update', matchId: 'p_nowhere', company: 'Ghost Steels' }, FIRMS, '', 'ghost steels');
        expect(out.mode).toBe('unsure');
        expect(out.matchId).toBe('');
        expect(out.questions.length).toBeGreaterThan(0);
    });
});

// ── failures are loud, and they are DIFFERENT failures ───────────────────────

describe('every way the Add tab can fail says a different thing', () => {
    const PHOTO = Buffer.from('not really a jpeg').toString('base64');

    /** Whatever the owner is shown for this attempt — an error, or the "read" sentence. */
    async function shownFor(app, body) {
        const res = await request(app).post('/api/contacts/add-draft').send(body);
        return { status: res.status, text: String(res.body.error || res.body.read || ''), body: res.body };
    }

    test('nothing given at all', async () => {
        const { app, writes } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        const out = await shownFor(app, {});
        expect(out.status).toBe(400);
        expect(out.text).toBe('Nothing to read yet — type or paste something, or attach a file.');
        expect(writes).toEqual([]);
    });

    test('a file kind the reader cannot open names the file and says what to do instead', async () => {
        const { app } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        const out = await shownFor(app, { fileBase64: PHOTO, fileName: 'rates.xlsx' });
        expect(out.status).toBe(400);
        expect(out.text).toContain('I can read a PDF or a photo');
        expect(out.text).toContain('rates.xlsx');
    });

    test('the AI being switched off is its own message, and offers the way round it', async () => {
        const { app } = makeApp({ ai: null });          // no OPENAI_API_KEY on this deployment
        const out = await shownFor(app, { text: NEW_FIRM_TEXT });
        expect(out.status).toBe(500);
        expect(out.text).toContain('AI reader is switched off');
        expect(out.text).toContain('add this firm by hand');
    });

    test('a reply that is not JSON fails loudly and says nothing was changed', async () => {
        const { app, writes } = makeApp({ ai: stubAi('I am terribly sorry, I cannot help with that.') });
        const out = await shownFor(app, { text: NEW_FIRM_TEXT });
        expect(out.status).toBe(500);
        expect(out.text).toContain('Could not read that');
        expect(out.text).toContain('Nothing was changed');
        expect(writes).toEqual([]);
    });

    test('the AI call itself failing is loud too, not an empty result', async () => {
        // Checked in the owner's own words. Pinning the raw error text ("timed out",
        // "socket hang up") would make plumbing wording a promise this test enforces —
        // and would still pass if the sentence around it said nothing useful.
        const { app, writes } = makeApp({ ai: stubAi(new Error('socket hang up')) });
        const out = await shownFor(app, { text: NEW_FIRM_TEXT });
        expect(out.status).toBe(500);
        expect(out.text).toContain('Could not read that');
        expect(out.text).toContain('Nothing was changed');
        expect(out.text).toContain('add the firm by hand in the Directory tab');
        expect(out.body.mode).toBeUndefined();     // never dressed up as a finished read
        expect(writes).toEqual([]);
    });

    test('an attached PDF that could not be read is a failure, not a clean read of the typed half', async () => {
        // The dangerous version of this bug is quiet success: reading the sentence, dropping
        // the brochure, and reporting a tidy result the owner files away as done.
        const pdf = Buffer.from('%PDF-1.4 broken').toString('base64');
        const { app } = makeApp({ ai: stubAi(NEW_FIRM_JSON, { filesThrow: true }) });
        const out = await shownFor(app, { text: NEW_FIRM_TEXT, fileBase64: pdf, fileName: 'brochure.pdf' });
        expect(out.status).toBe(500);
        expect(out.text).toContain('the attached file could not be read');
    });

    test('understood nothing from typed words: says so, and leaves nothing to approve', async () => {
        const { app } = makeApp({ ai: stubAi({ mode: 'new', read: 'Adding a new firm.' }) });
        const out = await shownFor(app, { text: 'zzz qqq' });
        expect(out.status).toBe(200);
        expect(out.body.mode).toBe('nothing');
        expect(out.body.after).toBeNull();
        expect(out.body.lines).toEqual([]);
        expect(out.text).toContain('I could not find a firm, a person or a product in that');
    });

    test('understood nothing from a photo: names the photo and asks for a clearer one', async () => {
        const { app } = makeApp({ ai: stubAi({ mode: 'new', read: '' }) });
        const out = await shownFor(app, { fileBase64: PHOTO, fileName: 'card.jpg' });
        expect(out.status).toBe(200);
        expect(out.body.mode).toBe('nothing');
        expect(out.text).toBe('I could not make anything out of card.jpg. Try a clearer photo, or type what it says.');
    });

    test('understood, but already on the card: a DIFFERENT message, naming the firm', async () => {
        // The one that matters most. Told "I could not read that", the owner rewrites a
        // sentence that was perfectly clear. They need to hear that the card already says it.
        const card = Object.assign(MSL(), { products: [{ p: '24 inch pipes', spec: '', sizes: [], moq: 0, rule: '' }] });
        const { app, writes } = makeApp({
            contacts: [sanitizePartner(card)],
            ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
        });
        const out = await shownFor(app, { text: 'MSL now has 24 inch pipes also' });

        expect(out.status).toBe(200);
        expect(out.body.mode).toBe('nothing');
        expect(out.body.lines).toEqual([]);
        expect(out.text).toBe('Everything in that is already on MSL Tubes’s card. Nothing to change.');
        expect(writes).toEqual([]);
    });

    test('no two of those failures read the same', async () => {
        // The whole point. Eight different situations, eight different things for the owner
        // to do about it — a shared "something went wrong" would make all eight useless.
        const photoApp = makeApp({ ai: stubAi({ mode: 'new', read: '' }) });
        const messages = await Promise.all([
            shownFor(makeApp({ ai: stubAi(NEW_FIRM_JSON) }).app, {}),
            shownFor(makeApp({ ai: stubAi(NEW_FIRM_JSON) }).app, { fileBase64: PHOTO, fileName: 'rates.xlsx' }),
            shownFor(makeApp({ ai: null }).app, { text: NEW_FIRM_TEXT }),
            shownFor(makeApp({ ai: stubAi('sorry, no') }).app, { text: NEW_FIRM_TEXT }),
            shownFor(makeApp({ ai: stubAi(NEW_FIRM_JSON, { filesThrow: true }) }).app,
                { text: NEW_FIRM_TEXT, fileBase64: Buffer.from('%PDF').toString('base64'), fileName: 'b.pdf' }),
            shownFor(makeApp({ ai: stubAi({ mode: 'new', read: '' }) }).app, { text: 'zzz qqq' }),
            shownFor(photoApp.app, { fileBase64: PHOTO, fileName: 'card.jpg' }),
            shownFor(makeApp({
                contacts: [sanitizePartner(Object.assign(MSL(), { products: [{ p: '24 inch pipes' }] }))],
                ai: stubAi({ mode: 'update', matchId: 'p_msl', products: [{ p: '24 inch pipes' }], read: 'ok' }),
            }).app, { text: 'MSL now has 24 inch pipes also' }),
        ]);

        const texts = messages.map(m => m.text);
        expect(texts.every(t => t.length > 20)).toBe(true);      // none of them blank or a code
        expect(new Set(texts).size).toBe(texts.length);
    });

    test('a photo big enough to fill the box still gets read, not an HTML crash page', async () => {
        // The body limit on add-draft is 8mb, not the usual 4, and the comment on it records
        // why: base64 makes a file about a third bigger, so the 3 MB visiting-card photo the
        // browser happily accepts arrives as ~4.2 MB of JSON. At 4mb the body parser threw
        // before the handler ran and Express answered with an HTML stack trace — for the
        // headline case of the whole tab. Nothing tested the limit, so it was one careless
        // edit from coming back.
        const big = 'A'.repeat(4_400_000);      // ~4.4 MB of base64, a normal phone photo
        const { app } = makeApp({ ai: stubAi(NEW_FIRM_JSON) });
        const res = await request(app).post('/api/contacts/add-draft')
            .send({ fileBase64: big, fileName: 'card.jpg' });

        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('new');
        expect(res.body.after.company).toBe('Sri Balaji Steels');
    });

    test('a firm it could not place is a question, never a quiet second card', async () => {
        const { app, writes } = makeApp({
            contacts: [MSL()],
            ai: stubAi({
                mode: 'unsure', questions: [], candidates: ['MSL Tubes'],
                products: [{ p: '24 inch pipes' }], read: 'not sure',
            }),
        });
        const res = await request(app).post('/api/contacts/add-draft').send({ text: 'they now stock 24 inch' });
        expect(res.body.mode).toBe('unsure');
        expect(res.body.questions[0]).toContain('Is this a firm you already have, or a new one?');
        expect(res.body.candidates).toEqual([{ id: 'p_msl', company: 'MSL Tubes' }]);
        expect(writes).toEqual([]);
    });
});

// ── the guards that carry a scar ─────────────────────────────────────────────
//
// Four places in the Add-tab code where a comment records a thing that has ALREADY gone
// wrong on the live app. Every one of them could be deleted and the rest of this file
// stayed green — which means the scar was the only thing protecting the fix.

describe('the guards whose comments record a bug that already happened', () => {
    test('"other" never overwrites a role the card already knows', () => {
        // Seen live: a line about 24 inch pipes came back saying the firm was "other", and a
        // known TRANSPORTER became "other" — which drops them out of the freight list, so
        // they stop being asked for rates and nobody can say why.
        const carrier = sanitizePartner(Object.assign(MSL(), { role: 'transporter' }));
        const steps = addSteps({ role: 'other', products: [{ p: '24 inch pipes', spec: 'ERW' }] });

        const rows = addChangeList(carrier, steps, 'typed in');
        expect(rows.map(r => r.lines[0].label)).toEqual(['Product added']);   // no role line offered
        expect(applyAddSteps(carrier, steps, 'typed in').role).toBe('transporter');
    });

    test('but a role that really is news still lands', () => {
        // The pair. Without this, "ignore every role" passes the test above just as well,
        // and the Add tab could never record what a firm is again.
        const carrier = sanitizePartner(Object.assign(MSL(), { role: 'transporter' }));
        const steps = addSteps({ role: 'dealer' });
        expect(applyAddSteps(carrier, steps, 'typed in').role).toBe('dealer');
        expect(addChangeList(carrier, steps, 'typed in')[0].lines[0]).toEqual({
            label: 'They are a', from: 'transporter', to: 'dealer',
        });
    });

    test('a person already on the card is never renamed by a later read', () => {
        // The card says Suresh at that address. A brochure calling him something else is a
        // NEW colleague at the firm, not a correction — overwriting is how a contact the
        // owner has rung for years quietly disappears.
        const card = MSL();
        const out = applyAddSteps(card, addSteps({
            person: 'Ramesh', email: 'suresh@msltubes.in', phone: '99999 11111',
        }), 'typed in');

        expect(out.people).toHaveLength(1);
        expect(out.people[0].name).toBe('Suresh');
        expect(out.people[0].phones.map(x => x.v)).toEqual(['99999 11111']);   // the number did land
    });

    test('and a person row with no name yet DOES get named', () => {
        // The pair again: an imported card whose only content is an address must still be
        // able to gain the name that goes with it.
        const out = applyAddSteps(ARC(), addSteps({
            person: 'Adarsh', email: 'adarshroadcarriers@yahoo.com',
        }), 'typed in');
        expect(out.people[0].name).toBe('Adarsh');
    });

    test('reading the same brochure twice does not leave the same note twice', () => {
        // Checked on the STORED card, not on the change list: the change list compares notes
        // by their words, so a second identical note is invisible there and the card would
        // quietly grow a duplicate every time the owner re-read the same page.
        const card = sanitizePartner(Object.assign(MSL(), {
            notes: [{ d: '2026-08-01', t: 'Payment in 30 days', src: 'by hand' }],
        }));
        const out = applyAddSteps(card, addSteps({ notes: ['Payment in 30 days'] }), 'typed in');
        expect(out.notes.map(n => n.t)).toEqual(['Payment in 30 days']);
    });

    test('and a note that is genuinely new is kept, newest first', () => {
        const card = sanitizePartner(Object.assign(MSL(), {
            notes: [{ d: '2026-08-01', t: 'Payment in 30 days', src: 'by hand' }],
        }));
        const out = applyAddSteps(card, addSteps({ notes: ['Loads only on Tuesdays'] }), 'typed in');
        expect(out.notes.map(n => n.t)).toEqual(['Loads only on Tuesdays', 'Payment in 30 days']);
    });

    test('pressing a firm\'s name adds to that card — it never renames it', async () => {
        // "add 24 inch to msl" once proposed updating adarshroadcarriers@yahoo.com, so the
        // popup started asking which firm it was. Pressing MSL means "put this on MSL's
        // card", never "and while you are there, call them ARC Limited".
        const { app, blobs } = makeApp({
            contacts: [MSL()],
            ai: stubAi({
                mode: 'update', matchId: 'p_arc', company: 'ARC Limited',
                products: [{ p: '24 inch pipes', spec: 'ERW' }], read: 'ok',
            }),
        });

        const draft = await request(app).post('/api/contacts/add-draft')
            .send({ text: 'ARC Limited now stock 24 inch ERW pipes', matchId: 'p_msl' });

        expect(draft.body.mode).toBe('update');
        expect(draft.body.matchId).toBe('p_msl');
        const labels = draft.body.changes.map(c => c.lines.map(l => l.label).join('+'));
        expect(labels).not.toContain('Company');
        expect(labels).toContain('Product added');           // the real reading still got through

        await request(app).post('/api/contacts/add-apply').send({
            after: draft.body.after, matchId: 'p_msl',
            steps: draft.body.changes.map(c => c.step), source: draft.body.source,
        });
        expect(cardsIn(blobs)[0].company).toBe('MSL Tubes');
        expect(cardsIn(blobs)[0].products.map(p => p.p)).toEqual(['24 inch pipes']);
    });
});
