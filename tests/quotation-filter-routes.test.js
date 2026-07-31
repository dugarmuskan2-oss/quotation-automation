/**
 * @jest-environment node
 *
 * tests/quotation-filter-routes.test.js
 *
 * Functional tests for the whole-table lookup endpoints on the quotations router —
 * the ones that reach past the pages the client has already loaded:
 *   GET  /quotations-filter            — month dropdown + freight button
 *   GET  /quotations-search            — search box (company / bill-to / contact / number)
 *   POST /quotations/:id/freight-enquiries — field-merge save of transporter enquiries
 *
 * Why these matter:
 *  - the freight predicate was deliberately WIDENED (a genuinely sent enquiry stores an
 *    empty threadId, so requiring one hid real freight quotes) — the tests below pin the
 *    widened shape so it cannot silently narrow again;
 *  - both read endpoints scan the table in a paging loop and report `truncated` instead of
 *    quietly returning a short list, so one test drives the loop across several pages;
 *  - the freight-enquiries route exists precisely because the old whole-object save could
 *    wipe lineItems / tableHTML, so the survival of those heavy fields is asserted directly.
 *
 * DynamoDB is faked with an in-memory store (Get / Put / Scan); lib-dynamodb command
 * classes are mocked to tiny tagged wrappers the fake send() dispatches on — same pattern
 * as tests/admin-routes.test.js.
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
const { ENTITY_QUOTATION, QUOTE_COUNTER_ID } = require('../utils/constants');

// ── Fake DynamoDB ─────────────────────────────────────────────────────────────
// `store` maps id -> Item. Scan returns every stored item (the fake ignores the
// FilterExpression — the route's own JS predicates are what we're testing).
// `scanPageSize` makes Scan hand back a LastEvaluatedKey so the paging loop runs.
function makeApp(store, { withDdb = true, scanPageSize = 0, scanCalls = null } = {}) {
    const app = express();
    app.use(express.json());
    const ddbDocClient = withDdb ? {
        send: async (cmd) => {
            if (cmd.__type === 'Get') return { Item: store[cmd.input.Key.id] };
            if (cmd.__type === 'Put') { store[cmd.input.Item.id] = cmd.input.Item; return {}; }
            if (cmd.__type === 'Scan') {
                if (scanCalls) scanCalls.push(cmd.input);
                const all = Object.values(store);
                if (!scanPageSize) return { Items: all };
                const start = cmd.input.ExclusiveStartKey ? Number(cmd.input.ExclusiveStartKey._offset) : 0;
                const page  = all.slice(start, start + scanPageSize);
                const next  = start + page.length;
                return { Items: page, LastEvaluatedKey: next < all.length ? { _offset: next } : undefined };
            }
            throw new Error('unexpected command: ' + cmd.__type);
        },
    } : null;
    app.use('/api', createQuotationsRouter({ ddbDocClient, ddbTableName: withDdb ? 'T' : null }));
    return app;
}

// A stored DynamoDB item. Top-level createdAt/updatedAt mirror the payload only when the
// payload actually has them — quotationFromItem back-fills from the item otherwise, which
// would defeat the quotationDate tests below.
function quoteItem(id, payload) {
    const item = { id, _entity: ENTITY_QUOTATION, payload: Object.assign({ id }, payload) };
    if (payload.createdAt) item.createdAt = payload.createdAt;
    if (payload.updatedAt) item.updatedAt = payload.updatedAt;
    return item;
}

function storeOf(items) {
    const store = {};
    items.forEach(it => { store[it.id] = it; });
    return store;
}

const idsOf = (res) => res.body.quotations.map(q => q.id).sort();

// ── Month filter ──────────────────────────────────────────────────────────────

describe('GET /quotations-filter?month=YYYY-MM', () => {
    // quoteMonth(x) reads x.createdAt || x.quotationDate || x.updatedAt — first TRUTHY wins,
    // and whatever it picks must be parseable by `new Date`.
    const monthStore = () => storeOf([
        quoteItem('m-created',  { companyName: 'March Co',  createdAt: '2026-03-10T09:00:00.000Z', updatedAt: '2026-03-11T09:00:00.000Z' }),
        quoteItem('m-other',    { companyName: 'April Co',  createdAt: '2026-04-02T09:00:00.000Z', updatedAt: '2026-04-02T09:00:00.000Z' }),
        quoteItem('m-isodate',  { companyName: 'Iso Date',  quotationDate: '2026-03-05', updatedAt: '2026-04-20T09:00:00.000Z' }),
        quoteItem('m-dotted',   { companyName: 'Dotted',    quotationDate: '15.03.26',   updatedAt: '2026-03-20T09:00:00.000Z' }),
        { id: QUOTE_COUNTER_ID, type: 'counter', value: 300 },
    ]);

    test('returns only quotes created in that month', async () => {
        const res = await request(makeApp(monthStore())).get('/api/quotations-filter?month=2026-03');
        expect(res.status).toBe(200);
        expect(idsOf(res)).toContain('m-created');
        expect(idsOf(res)).not.toContain('m-other');
    });

    test('a parseable quotationDate is used when createdAt is absent (and beats updatedAt)', async () => {
        // m-isodate has no createdAt and an updatedAt in APRIL, yet its March quotationDate
        // is what decides the month — proving quoteMonth really consults quotationDate.
        const res = await request(makeApp(monthStore())).get('/api/quotations-filter?month=2026-03');
        expect(idsOf(res)).toContain('m-isodate');
        const april = await request(makeApp(monthStore())).get('/api/quotations-filter?month=2026-04');
        expect(idsOf(april)).not.toContain('m-isodate');
    });

    test('ACTUAL BEHAVIOUR: a DD.MM.YY quotationDate does not match, and hides the usable updatedAt', async () => {
        // `new Date('15.03.26')` is Invalid Date, so quoteMonth returns '' — and because
        // quotationDate is truthy it is picked ahead of the perfectly good March updatedAt,
        // so the quote falls out of EVERY month. Documenting, not endorsing (see notes).
        const march = await request(makeApp(monthStore())).get('/api/quotations-filter?month=2026-03');
        expect(idsOf(march)).not.toContain('m-dotted');
        const april = await request(makeApp(monthStore())).get('/api/quotations-filter?month=2026-04');
        expect(idsOf(april)).not.toContain('m-dotted');
    });

    test('the quote-number counter row is never returned as a quotation', async () => {
        const res = await request(makeApp(monthStore())).get('/api/quotations-filter?month=2026-03');
        expect(idsOf(res)).not.toContain(QUOTE_COUNTER_ID);
    });

    test('the scan asks DynamoDB for quotation rows only', async () => {
        const scanCalls = [];
        await request(makeApp(monthStore(), { scanCalls })).get('/api/quotations-filter?month=2026-03');
        expect(scanCalls).toHaveLength(1);
        expect(scanCalls[0].FilterExpression).toBe('#ent = :ent');
        expect(scanCalls[0].ExpressionAttributeValues[':ent']).toBe(ENTITY_QUOTATION);
    });
});

// ── Freight filter (the widened predicate) ────────────────────────────────────

describe('GET /quotations-filter?freight=1', () => {
    const freightStore = () => storeOf([
        // An enquiry that really was emailed but whose send response carried no thread id.
        quoteItem('f-empty-thread', { updatedAt: '2026-03-05T09:00:00.000Z', freightEnquiries: [{ to: 'a@t.com', threadId: '' }] }),
        // Done and dusted — still "has freight activity".
        quoteItem('f-replied',      { updatedAt: '2026-03-04T09:00:00.000Z', freightEnquiries: [{ to: 'b@t.com', threadId: 'th-2', replied: true, status: 'finished' }] }),
        // Reply flag only, no enquiry records kept.
        quoteItem('f-reply-in',     { updatedAt: '2026-03-03T09:00:00.000Z', transporterReplyIn: true }),
        // Never sent anything.
        quoteItem('f-empty-array',  { updatedAt: '2026-03-02T09:00:00.000Z', freightEnquiries: [] }),
        quoteItem('f-none',         { updatedAt: '2026-03-01T09:00:00.000Z' }),
    ]);

    test('includes empty-threadId, replied/finished and transporterReplyIn-only quotes', async () => {
        const res = await request(makeApp(freightStore())).get('/api/quotations-filter?freight=1');
        expect(res.status).toBe(200);
        expect(idsOf(res)).toEqual(['f-empty-thread', 'f-replied', 'f-reply-in']);
    });

    test('excludes an empty freightEnquiries array and a quote with no freight data at all', async () => {
        const res = await request(makeApp(freightStore())).get('/api/quotations-filter?freight=1');
        expect(idsOf(res)).not.toContain('f-empty-array');
        expect(idsOf(res)).not.toContain('f-none');
    });

    test('month and freight combine (both must hold)', async () => {
        const store = freightStore();
        store['f-old-freight'] = quoteItem('f-old-freight', {
            createdAt: '2026-01-09T09:00:00.000Z', updatedAt: '2026-01-09T09:00:00.000Z',
            freightEnquiries: [{ to: 'c@t.com', threadId: 'th-9' }],
        });
        const res = await request(makeApp(store)).get('/api/quotations-filter?month=2026-01&freight=1');
        expect(idsOf(res)).toEqual(['f-old-freight']);
    });

    test('results come back newest-first', async () => {
        const res = await request(makeApp(freightStore())).get('/api/quotations-filter?freight=1');
        expect(res.body.quotations.map(q => q.id)).toEqual(['f-empty-thread', 'f-replied', 'f-reply-in']);
    });
});

// ── No filter / bad filter ────────────────────────────────────────────────────

describe('GET /quotations-filter — nothing to filter on', () => {
    const store = () => storeOf([quoteItem('a', { createdAt: '2026-03-10T09:00:00.000Z', updatedAt: '2026-03-10T09:00:00.000Z', freightEnquiries: [{ to: 'x@t.com', threadId: '' }] })]);

    test('neither month nor freight -> empty array (and no scan at all)', async () => {
        const scanCalls = [];
        const res = await request(makeApp(store(), { scanCalls })).get('/api/quotations-filter');
        expect(res.status).toBe(200);
        expect(res.body.quotations).toEqual([]);
        expect(scanCalls).toHaveLength(0);
    });

    test.each(['2026-3', 'March', '202603', '2026-03-10'])('an invalid month (%s) is ignored', async (month) => {
        const res = await request(makeApp(store())).get('/api/quotations-filter?month=' + encodeURIComponent(month));
        expect(res.status).toBe(200);
        expect(res.body.quotations).toEqual([]);
    });

    test('freight=0 is not treated as the freight filter', async () => {
        const res = await request(makeApp(store())).get('/api/quotations-filter?freight=0');
        expect(res.body.quotations).toEqual([]);
    });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe('GET /quotations-search?q=', () => {
    const searchStore = () => storeOf([
        quoteItem('s-company',  { companyName: 'Acme Industries',   updatedAt: '2026-03-05T09:00:00.000Z', quoteNumber: 'DSC-201' }),
        quoteItem('s-contact',  { companyName: 'Other Ltd',         customerName: 'Priya Sharma', updatedAt: '2026-03-04T09:00:00.000Z', quoteNumber: 'DSC-202' }),
        quoteItem('s-project',  { companyName: 'Third Co',          projectName: 'Harbour Terminal', updatedAt: '2026-03-03T09:00:00.000Z', quoteNumber: 'DSC-203' }),
        quoteItem('s-number',   { companyName: 'Fourth Co',         updatedAt: '2026-03-02T09:00:00.000Z', quoteNumber: 'DSC-999' }),
    ]);

    test.each([
        ['company name',  'acme',             's-company'],
        ['contact name',  'priya',            's-contact'],
        ['project / bill-to', 'harbour',      's-project'],
        ['quote number',  'dsc-999',          's-number'],
    ])('matches on %s', async (_label, q, expectedId) => {
        const res = await request(makeApp(searchStore())).get('/api/quotations-search?q=' + encodeURIComponent(q));
        expect(res.status).toBe(200);
        expect(idsOf(res)).toEqual([expectedId]);
    });

    test('matching is case-insensitive and collapses runs of whitespace', async () => {
        const res = await request(makeApp(searchStore())).get('/api/quotations-search?q=' + encodeURIComponent('  AcMe   INDUSTRIES '));
        expect(idsOf(res)).toEqual(['s-company']);
    });

    test('a term shared by several quotes returns them newest-first', async () => {
        const res = await request(makeApp(searchStore())).get('/api/quotations-search?q=dsc-20');
        expect(res.body.quotations.map(q => q.id)).toEqual(['s-company', 's-contact', 's-project']);
    });

    test('empty q -> empty array without scanning', async () => {
        const scanCalls = [];
        const res = await request(makeApp(searchStore(), { scanCalls })).get('/api/quotations-search?q=');
        expect(res.status).toBe(200);
        expect(res.body.quotations).toEqual([]);
        expect(scanCalls).toHaveLength(0);
    });

    test('a whitespace-only q counts as empty', async () => {
        const res = await request(makeApp(searchStore())).get('/api/quotations-search?q=' + encodeURIComponent('   '));
        expect(res.body.quotations).toEqual([]);
    });

    test('no match -> empty list, still a 200', async () => {
        const res = await request(makeApp(searchStore())).get('/api/quotations-search?q=zzzz');
        expect(res.status).toBe(200);
        expect(res.body.quotations).toEqual([]);
    });
});

// ── truncated flag + the scan paging loop ─────────────────────────────────────

describe('scan paging and the truncated flag', () => {
    const pagedStore = () => storeOf([
        quoteItem('p1', { companyName: 'Paging Co', createdAt: '2026-05-01T09:00:00.000Z', updatedAt: '2026-05-01T09:00:00.000Z' }),
        quoteItem('p2', { companyName: 'Paging Co', createdAt: '2026-05-02T09:00:00.000Z', updatedAt: '2026-05-02T09:00:00.000Z' }),
        quoteItem('p3', { companyName: 'Paging Co', createdAt: '2026-05-03T09:00:00.000Z', updatedAt: '2026-05-03T09:00:00.000Z' }),
    ]);

    test('the filter follows LastEvaluatedKey across more than one page', async () => {
        const scanCalls = [];
        const res = await request(makeApp(pagedStore(), { scanPageSize: 1, scanCalls })).get('/api/quotations-filter?month=2026-05');
        expect(res.status).toBe(200);
        expect(scanCalls.length).toBe(3);                       // one page per item
        expect(scanCalls[0].ExclusiveStartKey).toBeUndefined(); // first page starts at the top
        expect(scanCalls[1].ExclusiveStartKey).toEqual({ _offset: 1 });
        expect(scanCalls[2].ExclusiveStartKey).toEqual({ _offset: 2 });
        expect(idsOf(res)).toEqual(['p1', 'p2', 'p3']);         // nothing lost on later pages
        expect(res.body.truncated).toBe(false);                 // the loop finished the table
    });

    test('the search follows LastEvaluatedKey across more than one page', async () => {
        const scanCalls = [];
        const res = await request(makeApp(pagedStore(), { scanPageSize: 2, scanCalls })).get('/api/quotations-search?q=paging');
        expect(res.status).toBe(200);
        expect(scanCalls.length).toBe(2);
        expect(idsOf(res)).toEqual(['p1', 'p2', 'p3']);
        expect(res.body.truncated).toBe(false);
    });

    test('truncated is false for a small single-page result set on both endpoints', async () => {
        const filtered = await request(makeApp(pagedStore())).get('/api/quotations-filter?month=2026-05');
        expect(filtered.body.truncated).toBe(false);
        const searched = await request(makeApp(pagedStore())).get('/api/quotations-search?q=paging');
        expect(searched.body.truncated).toBe(false);
    });
});

// ── POST /quotations/:id/freight-enquiries ────────────────────────────────────

describe('POST /quotations/:id/freight-enquiries', () => {
    const LINE_ITEMS = [
        { lineItemId: 'li-1', originalDescription: '2" NB X Heavy -- GI', quantity: '100', unitRate: '250', lineTotal: '25000' },
        { lineItemId: 'li-2', originalDescription: '3" NB X Sch 40', quantity: '50', unitRate: '400', lineTotal: '20000' },
    ];
    const seed = (extra) => storeOf([quoteItem('q1', Object.assign({
        quoteNumber: 'DSC-300', companyName: 'Acme',
        lineItems: LINE_ITEMS,
        tableHTML: '<table>the real rows</table>',
        headerHTML: '<div>header</div>',
        updatedAt: '2026-03-01T09:00:00.000Z',
    }, extra))]);

    const ENQUIRIES = [
        { to: 'transporter@x.com', subject: 'Freight enquiry DSC-300', threadId: '', sentAt: '2026-03-02T09:00:00.000Z' },
        { to: 'other@x.com',       subject: 'Freight enquiry DSC-300', threadId: 'th-7', replied: true },
    ];

    test('200, and the enquiries land on the stored payload', async () => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries')
            .send({ freightEnquiries: ENQUIRIES });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, count: 2 });
        expect(store['q1'].payload.freightEnquiries).toEqual(ENQUIRIES);
        expect(store['q1'].payload.updatedAt).not.toBe('2026-03-01T09:00:00.000Z');   // re-stamped
    });

    test('lineItems and tableHTML survive the merge untouched', async () => {
        // The whole point of this route: the client often holds only a list summary, and the
        // old whole-object save would have overwritten these heavy fields with nothing.
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries')
            .send({ freightEnquiries: ENQUIRIES });
        expect(res.status).toBe(200);
        expect(store['q1'].payload.lineItems).toEqual(LINE_ITEMS);
        expect(store['q1'].payload.tableHTML).toBe('<table>the real rows</table>');
        expect(store['q1'].payload.headerHTML).toBe('<div>header</div>');
        expect(store['q1'].payload.quoteNumber).toBe('DSC-300');
        expect(store['q1'].payload.companyName).toBe('Acme');
    });

    test('an empty array is a legitimate save (clears the records)', async () => {
        const store = seed({ freightEnquiries: ENQUIRIES });
        const res = await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries')
            .send({ freightEnquiries: [] });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
        expect(store['q1'].payload.freightEnquiries).toEqual([]);
        expect(store['q1'].payload.lineItems).toEqual(LINE_ITEMS);
    });

    test('persists transporterReplyIn when true', async () => {
        const store = seed();
        await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries')
            .send({ freightEnquiries: ENQUIRIES, transporterReplyIn: true });
        expect(store['q1'].payload.transporterReplyIn).toBe(true);
    });

    test('persists transporterReplyIn when FALSE (clearing the flag must work)', async () => {
        const store = seed({ transporterReplyIn: true });
        await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries')
            .send({ freightEnquiries: ENQUIRIES, transporterReplyIn: false });
        expect(store['q1'].payload.transporterReplyIn).toBe(false);
    });

    test('leaves transporterReplyIn untouched when omitted, or sent as a non-boolean', async () => {
        const store = seed({ transporterReplyIn: true });
        await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries').send({ freightEnquiries: ENQUIRIES });
        expect(store['q1'].payload.transporterReplyIn).toBe(true);
        await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries')
            .send({ freightEnquiries: ENQUIRIES, transporterReplyIn: 'no' });
        expect(store['q1'].payload.transporterReplyIn).toBe(true);
    });

    test('the saved enquiries make the quote show up under ?freight=1', async () => {
        const store = seed();
        await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries').send({ freightEnquiries: ENQUIRIES });
        const res = await request(makeApp(store)).get('/api/quotations-filter?freight=1');
        expect(idsOf(res)).toEqual(['q1']);
    });

    test.each([
        ['missing',      {}],
        ['null',         { freightEnquiries: null }],
        ['a string',     { freightEnquiries: 'a@t.com' }],
        ['an object',    { freightEnquiries: { to: 'a@t.com' } }],
    ])('400 when freightEnquiries is %s', async (_label, body) => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/freight-enquiries').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/must be an array/i);
        expect(store['q1'].payload.freightEnquiries).toBeUndefined();   // nothing written
    });

    test('the array check runs before the lookup — a bad body on an unknown id is still 400', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/nope/freight-enquiries').send({});
        expect(res.status).toBe(400);
    });

    test('404 for an unknown quote id', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/nope/freight-enquiries')
            .send({ freightEnquiries: ENQUIRIES });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
});

// ── No DynamoDB configured ────────────────────────────────────────────────────

describe('when DynamoDB is not configured', () => {
    // requireDdb answers 500 (not 503) with an actionable message — pinning the real behaviour.
    const noDdb = () => makeApp({}, { withDdb: false });

    test('GET /quotations-filter -> 500 with the "not configured" message', async () => {
        const res = await request(noDdb()).get('/api/quotations-filter?month=2026-03');
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/DynamoDB not configured/);
        expect(res.body.error).toMatch(/DYNAMODB_TABLE/);
    });

    test('GET /quotations-search -> 500 (the guard runs before the empty-q short-circuit)', async () => {
        const res = await request(noDdb()).get('/api/quotations-search?q=acme');
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/DynamoDB not configured/);
        const blankQ = await request(noDdb()).get('/api/quotations-search?q=');
        expect(blankQ.status).toBe(500);
    });

    test('POST /quotations/:id/freight-enquiries -> 500', async () => {
        const res = await request(noDdb()).post('/api/quotations/q1/freight-enquiries').send({ freightEnquiries: [] });
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/DynamoDB not configured/);
    });
});
