/**
 * @jest-environment node
 *
 * tests/sweep-fixes-server.test.js
 *
 * Five server-side defects that shipped, hurt real quotes, and were fixed. Each block
 * below pins the FIXED behaviour of routes/quotations.js so it cannot regress.
 *
 *  1. SERVER-OWNED FIELDS on POST /save-quotation.
 *     The route writes the client's whole object with a PutCommand. A browser tab that
 *     loaded a quote BEFORE a field existed held `undefined` for it and, on the next
 *     Save/Approve/Send (or a reply sweep), erased it: a revision the admin had asked for
 *     was DELETED rather than marked done — the wording gone, the quote silently dropped
 *     off the Revision list. The same overwrite un-deleted soft-deleted quotes and dropped
 *     freight-enquiry records. The route now takes the STORED values for
 *     revisionRequests / extraNotes / deleted / deletedAt / freightEnquiries /
 *     transporterReplyIn and ignores whatever the client sent.
 *
 *  2. PATH TRAVERSAL on POST /quotations/:id/archive-pdf and GET /quotations/:id/pdf.
 *     The version beside it was sanitised but the id was not, so "../../.." in the URL
 *     walked the composed key out of quote-pdfs/ (nothing under /api is auth-gated).
 *     Both now run the id through safeStorageSegment.
 *
 *  3. GET /enquiry-register returned soft-deleted quotes — the one place a junk entry
 *     stayed visible, counted in the monthly headline and mirrored into the Google Sheet.
 *
 *  4. MONTH BUCKETING (quoteMonth, behind GET /quotations-filter?month=).
 *     It bucketed on createdAt, so a quote saved in the early hours of the 1st IST was
 *     dated the new month on its face but filed under the previous one — pick that month
 *     and the quote was missing. quotationDate now wins, and the server understands the
 *     DD.MM.YY the app prints.
 *
 *  5. CONCURRENCY (mutateStoredQuotation). Two simultaneous revision asks used to lose one
 *     while BOTH callers were told it succeeded. Writes are now conditional on updatedAt
 *     and re-applied on a clash. The freight route additionally MERGES, so a second sender
 *     posting only its own entry cannot erase a colleague's.
 *
 * DynamoDB is faked with an in-memory store; lib-dynamodb command classes are mocked to
 * tiny tagged wrappers the fake send() dispatches on (same pattern as
 * tests/admin-routes.test.js). The fake CLONES on read and on write — the real client
 * hands back a freshly deserialised object each time, and sharing one object reference
 * would hide exactly the lost-update bug block 5 exists to catch. It also honours the
 * ConditionExpression, throwing a real ConditionalCheckFailedException.
 *
 * REALITY CHECK on block 5 (found while writing these tests, not assumed):
 * mutateStoredQuotation's version token is `new Date().toISOString()` — MILLISECOND
 * resolution. An in-process retry (re-read, mutate, write) finishes well inside one
 * millisecond, so a retry can stamp the very same updatedAt it just replaced. With TWO
 * writers that is harmless (the loser reads the winner's value, and there is nobody left
 * to fool) and the tests below are exact. With THREE OR MORE it re-opens a narrow
 * lost-update window: writer C's condition, still holding the pre-race timestamp, passes
 * against B's identically-stamped write and clobbers B's entry — all three still answer
 * 200. The three-way test therefore runs with `distinctWrites`, which holds each re-read
 * until the clock ticks past the record's updatedAt, isolating the retry loop from the
 * token-resolution hazard (in production, network + DynamoDB round trips put writes
 * milliseconds apart, so distinct stamps are the normal case). The hazard itself is left
 * documented rather than asserted — an assertion on it would be flaky by construction.
 */

'use strict';

jest.mock('@aws-sdk/lib-dynamodb', () => {
    const tag = (t) => class { constructor(input) { this.input = input; this.__type = t; } };
    return {
        DynamoDBDocumentClient: { from: jest.fn() },
        GetCommand: tag('Get'), PutCommand: tag('Put'),
        UpdateCommand: tag('Update'), QueryCommand: tag('Query'), ScanCommand: tag('Scan'),
    };
});

const express = require('express');
const request = require('supertest');
const createQuotationsRouter = require('../routes/quotations');
const { ENTITY_QUOTATION } = require('../utils/constants');

// ── Fakes ─────────────────────────────────────────────────────────────────────

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Hold until the process clock is strictly past `iso`. See `distinctWrites` below.
async function waitPastMs(iso) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return;
    for (let i = 0; i < 200 && Date.now() <= t; i++) await new Promise((r) => setTimeout(r, 1));
}

/**
 * In-memory DynamoDB. `store` maps id -> Item.
 *   onGet          — awaited before every Get (used to force a real interleaving)
 *   failGet        — every Get throws (the "read blip" path in /save-quotation)
 *   alwaysClash    — every conditional Put fails, so the retry loop runs out of attempts
 *   distinctWrites — hold each read until the clock is past the record's updatedAt, so the
 *                    route's next write cannot reuse the timestamp it is replacing. The
 *                    route's optimistic-lock token only has millisecond resolution (see the
 *                    reality check in the file docblock); this keeps a 3-way race about the
 *                    retry loop rather than about clock granularity.
 */
function makeDdb(store, opts = {}) {
    const stats = { gets: 0, puts: 0, conditionalFailures: 0 };
    const send = async (cmd) => {
        if (cmd.__type === 'Get') {
            stats.gets++;
            if (opts.onGet) await opts.onGet();
            if (opts.failGet) throw Object.assign(new Error('read blip'), { name: 'InternalServerError' });
            const item = clone(store[cmd.input.Key.id]);
            if (opts.distinctWrites) await waitPastMs(item && item.updatedAt);
            return { Item: item };
        }
        if (cmd.__type === 'Put') {
            const item = cmd.input.Item;
            const cond = cmd.input.ConditionExpression;
            if (cond) {
                const current = store[item.id];
                // The optimistic lock is the _rev COUNTER, not updatedAt: an ISO timestamp only
                // resolves to the millisecond, and an in-process retry finishes well inside one, so
                // a retry could re-stamp the value it had just replaced and a third writer holding
                // the pre-race value would sail through. A counter cannot collide that way.
                // (`#r` is the ExpressionAttributeName the route uses for _rev.)
                // alwaysClash means "this write can never win", so it must defeat BOTH branches —
                // a record that predates _rev takes the attribute_not_exists path.
                const ok = opts.alwaysClash ? false : (/#r = :prev/.test(cond)
                    ? (!!current && Number(current._rev) === cmd.input.ExpressionAttributeValues[':prev'])
                    : (!current || current._rev === undefined));
                if (!ok) {
                    stats.conditionalFailures++;
                    throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
                }
            }
            stats.puts++;
            store[item.id] = clone(item);
            return {};
        }
        // The fake ignores FilterExpression / ProjectionExpression — the route's own JS
        // predicates are what these tests are about.
        if (cmd.__type === 'Query' || cmd.__type === 'Scan') return { Items: clone(Object.values(store)) };
        throw new Error('unexpected command: ' + cmd.__type);
    };
    return { send, stats };
}

// Storage fake: `files` maps "<folder>/<name>" -> Buffer, and `keys` records every key
// the routes composed — the whole point of the traversal block.
function makeStorage() {
    const files = {};
    const keys = { uploaded: [], read: [] };
    return {
        files, keys,
        upload: jest.fn(async (buffer, fileName, folder) => {
            const key = folder + '/' + fileName;
            keys.uploaded.push(key);
            files[key] = buffer;
            return key;
        }),
        streamToResponse: jest.fn(async (key, res) => {
            keys.read.push(key);
            const buf = files[key];
            if (!buf) throw new Error('Not found: ' + key);
            res.end(buf);
        }),
    };
}

function makeApp(store, opts = {}) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    const ddb = makeDdb(store, opts);
    app.use('/api', createQuotationsRouter({
        ddbDocClient: ddb.send ? { send: ddb.send } : null,
        ddbTableName: 'T',
        storage: opts.storage,
    }));
    app.__stats = ddb.stats;
    return app;
}

// A stored DynamoDB item. Top-level createdAt/updatedAt mirror the payload only when the
// payload has them — quotationFromItem back-fills from the item otherwise, which would
// defeat the quotationDate tests in block 4.
function quoteItem(id, payload) {
    const item = { id, _entity: ENTITY_QUOTATION, payload: Object.assign({ id }, payload) };
    if (payload.createdAt) item.createdAt = payload.createdAt;
    if (payload.updatedAt) item.updatedAt = payload.updatedAt;
    return item;
}

function storeOf(items) {
    const store = {};
    items.forEach((it) => { store[it.id] = it; });
    return store;
}

/**
 * A latch that holds the first (n-1) callers until the n-th arrives, then lets everyone
 * through for good. Turns "fire two requests and hope they overlap" into a guaranteed
 * interleaving: every racer has READ before any of them WRITES. Retry reads sail through.
 */
function makeLatch(n) {
    let count = 0, released = false;
    const waiters = [];
    return async function wait() {
        if (released) return;
        count++;
        if (count >= n) { released = true; waiters.splice(0).forEach((r) => r()); return; }
        await new Promise((resolve) => waiters.push(resolve));
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Server-owned fields survive a whole-object save from a stale tab
// ══════════════════════════════════════════════════════════════════════════════

const SERVER_OWNED = ['revisionRequests', 'extraNotes', 'deleted', 'deletedAt', 'freightEnquiries', 'transporterReplyIn'];

const STORED_OWNED = {
    revisionRequests: [
        { id: 'rr_1', text: 'Change the freight to FOR Chennai', addedAt: '2026-07-30T09:00:00.000Z', addedBy: 'Admin', done: false },
        { id: 'rr_2', text: 'Drop the 3" line', addedAt: '2026-07-30T09:05:00.000Z', addedBy: 'Admin', done: true, doneAt: '2026-07-30T11:00:00.000Z' },
    ],
    extraNotes: [{ id: 'rr_3', text: 'Customer phoned about delivery', addedAt: '2026-07-30T10:00:00.000Z' }],
    deleted: true,
    deletedAt: '2026-07-30T12:00:00.000Z',
    freightEnquiries: [{ email: 'bharat@roadways.com', threadId: 't-A', sentAt: '2026-07-30T08:00:00.000Z', replied: true, amount: 9000 }],
    transporterReplyIn: true,
};

const HEAVY = {
    lineItems: [
        { lineItemId: 'li-1', originalDescription: '2" NB X Heavy -- GI', quantity: '100', unitRate: '250', lineTotal: '25000' },
        { lineItemId: 'li-2', originalDescription: '3" NB X Sch 40', quantity: '50', unitRate: '400', lineTotal: '20000' },
    ],
    tableHTML: '<table>the real rows</table>',
    headerHTML: '<div>header</div>',
};

const saveSeed = (extra) => storeOf([quoteItem('q1', Object.assign(
    { quoteNumber: 'DSC-300', companyName: 'Acme', checkedBy: '', updatedAt: '2026-07-30T12:00:00.000Z' },
    clone(HEAVY), clone(STORED_OWNED), extra
))]);

// What a stale tab posts: the whole quote as it knew it, WITHOUT the six fields, plus one
// innocuous edit. This is the exact shape that used to delete the admin's revision ask.
const stalePayload = (over) => Object.assign({ id: 'q1', quoteNumber: 'DSC-300', companyName: 'Acme' }, clone(HEAVY), over);

const save = (app, quotation) => request(app).post('/api/save-quotation').send({ quotation });

describe('POST /save-quotation — the six server-owned fields are never taken from the client', () => {
    test('a payload that OMITS them leaves every one intact, byte for byte', async () => {
        const store = saveSeed();
        const res = await save(makeApp(store), stalePayload({ checkedBy: 'PAVI' }));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });

        const p = store.q1.payload;
        SERVER_OWNED.forEach((field) => { expect(p[field]).toEqual(STORED_OWNED[field]); });
        expect(JSON.stringify(SERVER_OWNED.map((f) => p[f])))
            .toBe(JSON.stringify(SERVER_OWNED.map((f) => STORED_OWNED[f])));
    });

    test('...and the innocuous edit the tab really made still lands', async () => {
        const store = saveSeed();
        await save(makeApp(store), stalePayload({ checkedBy: 'PAVI', assignedTo: 'Ravi' }));
        expect(store.q1.payload.checkedBy).toBe('PAVI');
        expect(store.q1.payload.assignedTo).toBe('Ravi');
        expect(store.q1.payload.updatedAt).not.toBe('2026-07-30T12:00:00.000Z');   // re-stamped
    });

    test('the revision ask keeps its exact wording and its open/done flags', async () => {
        // The real damage: the ask was DELETED, not marked done, and the text went with it.
        const store = saveSeed();
        await save(makeApp(store), stalePayload({ checkedBy: 'PAVI' }));
        const asks = store.q1.payload.revisionRequests;
        expect(asks).toHaveLength(2);
        expect(asks[0].text).toBe('Change the freight to FOR Chennai');
        expect(asks[0].done).toBe(false);       // still open -> still on the Revision list
        expect(asks[0].addedBy).toBe('Admin');
        expect(asks[1].done).toBe(true);        // done asks are kept for History
        expect(asks[1].doneAt).toBe('2026-07-30T11:00:00.000Z');
    });

    test.each([
        ['emptied arrays / cleared flags (what an old tab actually holds)', {
            revisionRequests: [], extraNotes: [], deleted: false, deletedAt: null,
            freightEnquiries: [], transporterReplyIn: false,
        }],
        ['plausible-looking but different values', {
            revisionRequests: [{ id: 'client', text: 'something else', done: true }],
            extraNotes: [{ id: 'client-note', text: 'nope' }],
            deleted: false, deletedAt: '1999-01-01T00:00:00.000Z',
            freightEnquiries: [{ email: 'attacker@x.com', threadId: 't-A' }],
            transporterReplyIn: false,
        }],
        ['nulls', {
            revisionRequests: null, extraNotes: null, deleted: null, deletedAt: null,
            freightEnquiries: null, transporterReplyIn: null,
        }],
    ])('a client CANNOT overwrite them by sending %s', async (_label, sent) => {
        const store = saveSeed();
        const res = await save(makeApp(store), stalePayload(Object.assign({ checkedBy: 'PAVI' }, sent)));
        expect(res.status).toBe(200);
        const p = store.q1.payload;
        SERVER_OWNED.forEach((field) => { expect(p[field]).toEqual(STORED_OWNED[field]); });
        expect(p.checkedBy).toBe('PAVI');       // the legitimate edit is not collateral damage
    });

    test('a soft-deleted quote is NOT resurrected by a stale tab pressing Save', async () => {
        const store = saveSeed();
        await save(makeApp(store), stalePayload({ checkedBy: 'PAVI', deleted: false }));
        expect(store.q1.payload.deleted).toBe(true);
        expect(store.q1.payload.deletedAt).toBe('2026-07-30T12:00:00.000Z');
    });

    test('a field the stored record does NOT have is not invented from the client', async () => {
        // Mirror image of the bug: the server owns these, so a client value for a field the
        // record has never carried must be dropped, not written.
        const store = storeOf([quoteItem('q1', Object.assign({ quoteNumber: 'DSC-301', companyName: 'Acme', updatedAt: '2026-07-30T12:00:00.000Z' }, clone(HEAVY)))]);
        const res = await save(makeApp(store), stalePayload({
            quoteNumber: 'DSC-301',
            revisionRequests: [{ id: 'x', text: 'invented' }],
            extraNotes: [{ id: 'y', text: 'invented' }],
            deleted: true, deletedAt: '2026-07-30T13:00:00.000Z',
            freightEnquiries: [{ email: 'x@y.com', threadId: 't-Z' }],
            transporterReplyIn: true,
        }));
        expect(res.status).toBe(200);
        SERVER_OWNED.forEach((field) => {
            expect(Object.prototype.hasOwnProperty.call(store.q1.payload, field)).toBe(false);
        });
    });

    test('the guard only bites when there IS a stored record — a brand-new quote saves as sent', async () => {
        const store = {};
        const res = await save(makeApp(store), Object.assign(stalePayload({ id: 'new-1' }), {
            id: 'new-1', freightEnquiries: [{ email: 'a@b.com', threadId: 't-1' }],
        }));
        expect(res.status).toBe(200);
        expect(store['new-1'].payload.freightEnquiries).toEqual([{ email: 'a@b.com', threadId: 't-1' }]);
    });

    test('a failed read is best-effort — the save still goes through', async () => {
        const store = saveSeed();
        const res = await save(makeApp(store, { failGet: true }), stalePayload({ checkedBy: 'PAVI' }));
        expect(res.status).toBe(200);
        expect(store.q1.payload.checkedBy).toBe('PAVI');
    });

    test('lineItems / tableHTML / headerHTML still survive the empty-payload guard', async () => {
        // Guard 1, unchanged by the server-owned rework: a bare list summary must not wipe
        // the body. Both guards have to hold at once.
        const store = saveSeed();
        const res = await save(makeApp(store), { id: 'q1', companyName: 'Acme', grandTotal: '999', custReplyPending: true });
        expect(res.status).toBe(200);
        const p = store.q1.payload;
        expect(p.lineItems).toEqual(HEAVY.lineItems);
        expect(p.tableHTML).toBe(HEAVY.tableHTML);
        expect(p.headerHTML).toBe(HEAVY.headerHTML);
        expect(p.custReplyPending).toBe(true);
        SERVER_OWNED.forEach((field) => { expect(p[field]).toEqual(STORED_OWNED[field]); });
    });

    test('a full payload still overwrites the items normally (the guard is not a freeze)', async () => {
        const store = saveSeed();
        const newItems = [{ lineItemId: 'x', originalDescription: 'X', quantity: '5' }];
        await save(makeApp(store), { id: 'q1', lineItems: newItems, tableHTML: '<table>new</table>', grandTotal: '5' });
        expect(store.q1.payload.lineItems).toEqual(newItems);
        expect(store.q1.payload.tableHTML).toBe('<table>new</table>');
        SERVER_OWNED.forEach((field) => { expect(store.q1.payload[field]).toEqual(STORED_OWNED[field]); });
    });

    test('400 without an id — nothing is read or written', async () => {
        const store = saveSeed();
        const app = makeApp(store);
        expect((await save(app, { companyName: 'Acme' })).status).toBe(400);
        expect((await request(app).post('/api/save-quotation').send({})).status).toBe(400);
        expect(app.__stats.puts).toBe(0);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Path traversal — the id is sanitised into exactly one key segment
// ══════════════════════════════════════════════════════════════════════════════

const PDF_BYTES = Buffer.from('%PDF-1.4 archived original', 'utf8');
const PDF_B64 = PDF_BYTES.toString('base64');

// [label, id as the route sees it after express decodes the param, expected segment]
const TRAVERSAL_IDS = [
    ['a normal numeric id',            '1783593483622',              '1783593483622'],
    ['a relative-path id',             '../../../../OUTSIDE',        '.._.._.._.._OUTSIDE'],
    ['an already-encoded traversal',   '..%2F..%2F',                 '.._2F.._2F'],
    ['an id containing slashes',       'quotes/2026/../etc/passwd',  'quotes_2026_.._etc_passwd'],
];

// "quote-pdfs/<one segment>/<version>.pdf" — three parts, and the middle one cannot be a
// directory hop of any kind.
function expectKeyIsContained(key, version) {
    const parts = key.split('/');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('quote-pdfs');
    expect(key.startsWith('quote-pdfs/')).toBe(true);
    expect(parts[1]).not.toContain('\\');
    expect(parts[1]).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(parts[2]).toBe(version + '.pdf');
}

describe('POST /quotations/:id/archive-pdf — the id can never walk out of quote-pdfs/', () => {
    test.each(TRAVERSAL_IDS)('%s stays inside the prefix', async (_label, id, segment) => {
        const store = saveSeed();
        const storage = makeStorage();
        const res = await request(makeApp(store, { storage }))
            .post('/api/quotations/' + encodeURIComponent(id) + '/archive-pdf')
            .send({ base64: PDF_B64, versionKey: 'v2' });

        expect(res.status).toBe(200);
        expect(storage.upload).toHaveBeenCalledTimes(1);
        const [buffer, fileName, folder] = storage.upload.mock.calls[0];
        expect(folder).toBe('quote-pdfs/' + segment);
        expect(fileName).toBe('v2.pdf');
        expect(buffer.equals(PDF_BYTES)).toBe(true);
        expect(res.body.key).toBe('quote-pdfs/' + segment + '/v2.pdf');
        expectKeyIsContained(storage.keys.uploaded[0], 'v2');
        expectKeyIsContained(res.body.key, 'v2');
    });

    test('a hostile id and a hostile version together still compose one contained key', async () => {
        const storage = makeStorage();
        const res = await request(makeApp(saveSeed(), { storage }))
            .post('/api/quotations/' + encodeURIComponent('../../../../etc') + '/archive-pdf')
            .send({ base64: PDF_B64, versionKey: '../../authorized_keys' });
        expect(res.status).toBe(200);
        expect(res.body.key).toBe('quote-pdfs/.._.._.._.._etc/.._.._authorized_keys.pdf');
        expectKeyIsContained(res.body.key, '.._.._authorized_keys');
    });

    test('nothing is written outside quote-pdfs/ for any of the hostile ids', async () => {
        const storage = makeStorage();
        const app = makeApp(saveSeed(), { storage });
        for (const [, id] of TRAVERSAL_IDS) {
            await request(app).post('/api/quotations/' + encodeURIComponent(id) + '/archive-pdf')
                .send({ base64: PDF_B64, versionKey: 'v1' });
        }
        expect(Object.keys(storage.files)).toHaveLength(TRAVERSAL_IDS.length);
        Object.keys(storage.files).forEach((key) => expectKeyIsContained(key, 'v1'));
    });
});

describe('GET /quotations/:id/pdf — the read path sanitises the id the same way', () => {
    test.each(TRAVERSAL_IDS)('%s only ever reads one key inside the prefix', async (_label, id, segment) => {
        const storage = makeStorage();
        const res = await request(makeApp(saveSeed(), { storage }))
            .get('/api/quotations/' + encodeURIComponent(id) + '/pdf?version=v2');

        expect(res.status).toBe(404);                                   // nothing archived yet
        expect(storage.streamToResponse).toHaveBeenCalledTimes(1);
        expect(storage.keys.read[0]).toBe('quote-pdfs/' + segment + '/v2.pdf');
        expectKeyIsContained(storage.keys.read[0], 'v2');
    });

    test('the default "current" version is contained too, for a hostile id', async () => {
        const storage = makeStorage();
        await request(makeApp(saveSeed(), { storage }))
            .get('/api/quotations/' + encodeURIComponent('../../../../OUTSIDE') + '/pdf');
        expect(storage.keys.read[0]).toBe('quote-pdfs/.._.._.._.._OUTSIDE/current.pdf');
        expectKeyIsContained(storage.keys.read[0], 'current');
    });

    test('a sanitised id still round-trips its own archive (the fix did not break the feature)', async () => {
        const storage = makeStorage();
        const app = makeApp(saveSeed(), { storage });
        await request(app).post('/api/quotations/q1/archive-pdf').send({ base64: PDF_B64, versionKey: 'v2' });
        const res = await request(app).get('/api/quotations/q1/pdf?version=v2')
            .buffer().parse((r, cb) => {
                r.setEncoding('binary');
                let data = '';
                r.on('data', (c) => { data += c; });
                r.on('end', () => cb(null, Buffer.from(data, 'binary')));
            });
        expect(res.status).toBe(200);
        expect(res.body.equals(PDF_BYTES)).toBe(true);
        expect(storage.keys.read[0]).toBe('quote-pdfs/q1/v2.pdf');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. The register hides soft-deleted quotes
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /enquiry-register — soft-deleted quotes are gone from the register too', () => {
    const inJuly = { createdAt: '2026-07-15T09:00:00.000Z', updatedAt: '2026-07-15T09:00:00.000Z' };
    const registerStore = () => storeOf([
        quoteItem('reg-live',    Object.assign({ quoteNumber: 'DSC-400', companyName: 'Acme',      sent: true, sentAt: '2026-07-16T09:00:00.000Z', grandTotal: '22,68,656' }, inJuly)),
        quoteItem('reg-deleted', Object.assign({ quoteNumber: 'DSC-401', companyName: 'Junk Entry', deleted: true, deletedAt: '2026-07-16T09:00:00.000Z' }, inJuly)),
    ]);
    const rowIds = (res) => res.body.rows.map((r) => r.id);

    test('the live quote is listed and the deleted one is absent', async () => {
        const res = await request(makeApp(registerStore())).get('/api/enquiry-register?month=2026-07');
        expect(res.status).toBe(200);
        expect(rowIds(res)).toEqual(['reg-live']);
        expect(rowIds(res)).not.toContain('reg-deleted');
        expect(JSON.stringify(res.body.rows)).not.toContain('Junk Entry');
    });

    test('it does not count towards the monthly headline either', async () => {
        const res = await request(makeApp(registerStore())).get('/api/enquiry-register?month=2026-07');
        expect(res.body.rows).toHaveLength(1);
    });

    test('hidden on the from/to window and the rolling ?days window as well', async () => {
        const app = makeApp(registerStore());
        const ranged = await request(app).get('/api/enquiry-register?from=2026-06-30T18:30:00.000Z&to=2026-07-31T18:30:00.000Z');
        expect(rowIds(ranged)).toEqual(['reg-live']);

        // ?days is measured from "now", so seed a fresh pair for the rolling window.
        const now = new Date().toISOString();
        const rolling = await request(makeApp(storeOf([
            quoteItem('r-live',    { quoteNumber: 'DSC-500', createdAt: now, updatedAt: now }),
            quoteItem('r-deleted', { quoteNumber: 'DSC-501', createdAt: now, updatedAt: now, deleted: true }),
        ]))).get('/api/enquiry-register?days=30');
        expect(rolling.body.rows.map((r) => r.id)).toEqual(['r-live']);
    });

    test('the row is hidden, not destroyed — undo brings it straight back', async () => {
        const store = registerStore();
        const app = makeApp(store);
        expect(store['reg-deleted'].payload.quoteNumber).toBe('DSC-401');   // still stored

        const undo = await request(app).post('/api/quotations/reg-deleted/delete').send({ undo: true });
        expect(undo.status).toBe(200);
        const res = await request(app).get('/api/enquiry-register?month=2026-07');
        expect(rowIds(res).sort()).toEqual(['reg-deleted', 'reg-live']);
    });

    test('deleting a quote removes it from the register on the next read', async () => {
        const store = registerStore();
        const app = makeApp(store);
        await request(app).post('/api/quotations/reg-live/delete').send({});
        const res = await request(app).get('/api/enquiry-register?month=2026-07');
        expect(res.body.rows).toEqual([]);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Month bucketing — the date printed on the quote wins
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /quotations-filter?month= — quoteMonth prefers quotationDate over createdAt', () => {
    const monthStore = () => storeOf([
        // Saved 00:30 IST on 1 Aug = 19:00 UTC on 31 Jul. The quote's own face says 01.08.26.
        quoteItem('m-midnight-ist', { companyName: 'Midnight Co', quotationDate: '01.08.26', createdAt: '2026-07-31T19:00:00.000Z', updatedAt: '2026-07-31T19:00:00.000Z' }),
        // A day past the 12th: only DD.MM.YY parses it, and it must not follow createdAt.
        quoteItem('m-late-day',     { companyName: 'Late Day Co', quotationDate: '31.07.26', createdAt: '2026-08-02T09:00:00.000Z', updatedAt: '2026-08-02T09:00:00.000Z' }),
        // Ambiguous day (<= 12) — proves DD.MM, not MM.DD.
        quoteItem('m-ambiguous',    { companyName: 'Ambiguous Co', quotationDate: '05.08.26', createdAt: '2026-05-08T09:00:00.000Z', updatedAt: '2026-05-08T09:00:00.000Z' }),
        // No quotationDate at all — the createdAt fallback still has to work.
        quoteItem('m-fallback',     { companyName: 'Fallback Co', createdAt: '2026-07-05T09:00:00.000Z', updatedAt: '2026-07-05T09:00:00.000Z' }),
    ]);
    const idsOf = (res) => res.body.quotations.map((q) => q.id).sort();
    const month = (m) => request(makeApp(monthStore())).get('/api/quotations-filter?month=' + m);

    test('a quote dated 01.08.26 but createdAt 31 Jul UTC files under 2026-08', async () => {
        const aug = await month('2026-08');
        expect(aug.status).toBe(200);
        expect(idsOf(aug)).toContain('m-midnight-ist');
    });

    test('...and NOT under 2026-07, where the old createdAt bucketing hid it', async () => {
        expect(idsOf(await month('2026-07'))).not.toContain('m-midnight-ist');
    });

    test('a DD.MM.YY date after the 12th files under its printed month', async () => {
        expect(idsOf(await month('2026-07'))).toContain('m-late-day');
        expect(idsOf(await month('2026-08'))).not.toContain('m-late-day');
    });

    test('an ambiguous 05.08.26 is read as 5 August, not 8 May', async () => {
        expect(idsOf(await month('2026-08'))).toContain('m-ambiguous');
        expect(idsOf(await month('2026-05'))).not.toContain('m-ambiguous');
    });

    test('a quote with no quotationDate still falls back to createdAt', async () => {
        expect(idsOf(await month('2026-07'))).toContain('m-fallback');
        expect(idsOf(await month('2026-08'))).not.toContain('m-fallback');
    });

    test('the whole July / August split is exactly as the printed dates say', async () => {
        expect(idsOf(await month('2026-07'))).toEqual(['m-fallback', 'm-late-day']);
        expect(idsOf(await month('2026-08'))).toEqual(['m-ambiguous', 'm-midnight-ist']);
    });

    test('an unparseable quotationDate falls back rather than dropping the quote entirely', async () => {
        const store = storeOf([
            quoteItem('m-bad-month', { quotationDate: '01.13.26', createdAt: '2026-07-05T09:00:00.000Z', updatedAt: '2026-07-05T09:00:00.000Z' }),
            quoteItem('m-junk',      { quotationDate: 'not a date', createdAt: '2026-07-06T09:00:00.000Z', updatedAt: '2026-07-06T09:00:00.000Z' }),
        ]);
        const res = await request(makeApp(store)).get('/api/quotations-filter?month=2026-07');
        expect(res.body.quotations.map((q) => q.id).sort()).toEqual(['m-bad-month', 'm-junk']);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Concurrency — mutateStoredQuotation cannot lose a simultaneous update
// ══════════════════════════════════════════════════════════════════════════════

const concurrencySeed = () => storeOf([quoteItem('q1', Object.assign(
    { quoteNumber: 'DSC-600', companyName: 'Acme', updatedAt: '2026-07-30T12:00:00.000Z' }, clone(HEAVY)
))]);

const addAsk = (app, body) => request(app).post('/api/quotations/q1/revision-request').send(body);

describe('POST /quotations/:id/revision-request — simultaneous asks all survive', () => {
    test('two at once: BOTH are stored, and the clash really happened', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(2) });   // neither may write before both have read

        const [a, b] = await Promise.all([
            addAsk(app, { text: 'Change the freight to FOR Chennai', addedBy: 'Admin' }),
            addAsk(app, { text: 'Add 2% cash discount', addedBy: 'Pavi' }),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);

        const asks = store.q1.payload.revisionRequests;
        expect(asks).toHaveLength(2);
        expect(asks.map((r) => r.text).sort()).toEqual(['Add 2% cash discount', 'Change the freight to FOR Chennai']);
        expect(asks.map((r) => r.addedBy).sort()).toEqual(['Admin', 'Pavi']);
        asks.forEach((r) => expect(r.done).toBe(false));
        expect(app.__stats.conditionalFailures).toBeGreaterThan(0);   // the retry loop earned its keep
    });

    test('the entry each caller was told about is the one that got stored', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(2) });
        const [a, b] = await Promise.all([
            addAsk(app, { text: 'first' }),
            addAsk(app, { text: 'second' }),
        ]);
        const storedIds = store.q1.payload.revisionRequests.map((r) => r.id);
        expect(storedIds).toContain(a.body.entry.id);
        expect(storedIds).toContain(b.body.entry.id);
    });

    // `distinctWrites` keeps this about the retry loop stacking three writers on top of one
    // another, not about the millisecond resolution of the updatedAt token — see the
    // reality check in the file docblock.
    test('three at once: all three are stored', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(3), distinctWrites: true });
        const results = await Promise.all([
            addAsk(app, { text: 'ask one' }),
            addAsk(app, { text: 'ask two' }),
            addAsk(app, { text: 'ask three' }),
        ]);
        results.forEach((r) => expect(r.status).toBe(200));
        expect(store.q1.payload.revisionRequests.map((r) => r.text).sort())
            .toEqual(['ask one', 'ask three', 'ask two']);
        expect(app.__stats.conditionalFailures).toBeGreaterThan(0);
    });

    test('a note and a revision racing land in their own arrays, not each other\'s', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(2) });
        await Promise.all([
            addAsk(app, { text: 'please revise the freight' }),
            addAsk(app, { text: 'customer phoned', kind: 'note' }),
        ]);
        expect(store.q1.payload.revisionRequests.map((r) => r.text)).toEqual(['please revise the freight']);
        expect(store.q1.payload.extraNotes.map((r) => r.text)).toEqual(['customer phoned']);
        expect(store.q1.payload.extraNotes[0].done).toBeUndefined();   // notes never join the filter
    });

    test('the heavy fields are untouched by a concurrent burst', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(3) });
        await Promise.all([addAsk(app, { text: 'a' }), addAsk(app, { text: 'b' }), addAsk(app, { text: 'c' })]);
        expect(store.q1.payload.lineItems).toEqual(HEAVY.lineItems);
        expect(store.q1.payload.tableHTML).toBe(HEAVY.tableHTML);
    });

    test('when the write can never win, the caller is told so — no false success', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { alwaysClash: true });
        const res = await addAsk(app, { text: 'never lands' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to add');
        expect(store.q1.payload.revisionRequests).toBeUndefined();
    });

    test('404 for an unknown quote, 400 for empty text', async () => {
        const app = makeApp(concurrencySeed());
        expect((await request(app).post('/api/quotations/nope/revision-request').send({ text: 'x' })).status).toBe(404);
        expect((await addAsk(app, { text: '   ' })).status).toBe(400);
    });
});

describe('POST /quotations/:id/freight-enquiries — merges instead of replacing', () => {
    const A = { email: 'bharat@roadways.com', threadId: 't-A', sentAt: '2026-07-31T09:00:00.000Z', replied: false, amount: 0 };
    const B = { email: 'vrl@vrl.com',         threadId: 't-B', sentAt: '2026-07-31T09:00:01.000Z', replied: false, amount: 0 };
    const post = (app, body) => request(app).post('/api/quotations/q1/freight-enquiries').send(body);

    test('a second sender who posts only its own entry does not erase the first', async () => {
        const store = concurrencySeed();
        store.q1.payload.freightEnquiries = [clone(A)];
        const res = await post(makeApp(store), { freightEnquiries: [clone(B)] });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(store.q1.payload.freightEnquiries.map((t) => t.email).sort())
            .toEqual(['bharat@roadways.com', 'vrl@vrl.com']);
    });

    test('an update to an existing threadId replaces that entry rather than duplicating it', async () => {
        const store = concurrencySeed();
        store.q1.payload.freightEnquiries = [clone(A)];
        const res = await post(makeApp(store), { freightEnquiries: [Object.assign(clone(A), { replied: true, amount: 9000 })] });
        expect(res.status).toBe(200);
        const saved = store.q1.payload.freightEnquiries;
        expect(saved).toHaveLength(1);
        expect(res.body.count).toBe(1);
        expect(saved[0].threadId).toBe('t-A');
        expect(saved[0].replied).toBe(true);
        expect(saved[0].amount).toBe(9000);
    });

    test('an entry with no threadId is keyed by transporter + send time, so it is not duplicated', async () => {
        const noThread = { email: 'noreply@t.com', threadId: '', sentAt: '2026-07-31T10:00:00.000Z', replied: false };
        const store = concurrencySeed();
        store.q1.payload.freightEnquiries = [clone(noThread)];
        await post(makeApp(store), { freightEnquiries: [Object.assign(clone(noThread), { replied: true })] });
        expect(store.q1.payload.freightEnquiries).toHaveLength(1);
        expect(store.q1.payload.freightEnquiries[0].replied).toBe(true);
    });

    test('two senders posting at the same moment both keep their enquiry', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(2) });
        const [ra, rb] = await Promise.all([
            post(app, { freightEnquiries: [clone(A)] }),
            post(app, { freightEnquiries: [clone(B)] }),
        ]);
        expect(ra.status).toBe(200);
        expect(rb.status).toBe(200);
        expect(store.q1.payload.freightEnquiries.map((t) => t.threadId).sort()).toEqual(['t-A', 't-B']);
        expect(app.__stats.conditionalFailures).toBeGreaterThan(0);
    });

    test('the surviving records still make the quote show up under ?freight=1', async () => {
        const store = concurrencySeed();
        const app = makeApp(store, { onGet: makeLatch(2) });
        await Promise.all([
            post(app, { freightEnquiries: [clone(A)] }),
            post(app, { freightEnquiries: [clone(B)] }),
        ]);
        const res = await request(makeApp(store)).get('/api/quotations-filter?freight=1');
        expect(res.body.quotations.map((q) => q.id)).toEqual(['q1']);
    });
});
