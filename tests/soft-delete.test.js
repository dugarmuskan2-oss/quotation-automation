/**
 * @jest-environment node
 *
 * tests/soft-delete.test.js
 *
 * The margin-desk "delete an accidental quote" feature — soft delete, never a hard one.
 *
 *   1. POST /quotations/:id/delete (routes/quotations.js) — flags the STORED payload
 *      (deleted + deletedAt), `undo:true` strips both flags again, 404 for an unknown id.
 *      It is a flag-only mutation: lineItems / tableHTML / headerHTML must survive, because
 *      the desk only holds a list summary and must never be able to wipe the real quote.
 *   2. GET /quotations projects `deleted` (it is in SUMMARY_NESTED_PATHS), so the flag
 *      reaches the client from the list alone — no per-quote fetch needed to know it.
 *   3. Every client-side path that can put a quote into `approvedQuotations` must drop the
 *      deleted ones. This pins a real bug: the feed loader filtered them, but the two
 *      server-MERGE paths did not — so a deleted quote was resurrected into the list as soon
 *      as a month/freight filter or a search happened to match it. Covered here by running
 *      the REAL index.html functions (extracted + eval'd, same pattern as margin-desk.test.js):
 *      loadQuotationsFromBackend, applyApprovalServerFilter, serverSearchApprovedQuotations,
 *      loadRevisionQuotesForCount, renderMarginDesk — plus source guards on the marker strings
 *      so the guards can't be quietly deleted again.
 *
 * DynamoDB is faked with an in-memory store; lib-dynamodb command classes are mocked to tiny
 * tagged wrappers the fake send() dispatches on.
 */

'use strict';

jest.mock('@aws-sdk/lib-dynamodb', () => {
    const tag = (t) => class { constructor(input) { this.input = input; this.__type = t; } };
    return {
        DynamoDBDocumentClient: { from: jest.fn() },
        GetCommand: tag('Get'), PutCommand: tag('Put'),
        UpdateCommand: tag('Update'), QueryCommand: tag('Query'), ScanCommand: tag('Scan'),
        DeleteCommand: tag('Delete'),
    };
});

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const createQuotationsRouter = require('../routes/quotations');

const ROUTE_PATH = path.join(__dirname, '..', 'routes', 'quotations.js');
const routeSrc = fs.readFileSync(ROUTE_PATH, 'utf8');
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

// ── Route harness ─────────────────────────────────────────────────────────────

// Build an app backed by an in-memory DynamoDB. `store` maps id -> Item.
// `sent` records every command the routes issued, so we can inspect projections.
function makeApp(store, { withDdb = true, sent = [] } = {}) {
    const app = express();
    app.use(express.json());
    const ddbDocClient = withDdb ? {
        send: async (cmd) => {
            sent.push(cmd);
            if (cmd.__type === 'Get')   return { Item: store[cmd.input.Key.id] };
            if (cmd.__type === 'Put')   { store[cmd.input.Item.id] = cmd.input.Item; return {}; }
            if (cmd.__type === 'Query') return { Items: Object.values(store), LastEvaluatedKey: null };
            throw new Error('unexpected command: ' + cmd.__type);
        },
    } : null;
    app.use('/api', createQuotationsRouter({ ddbDocClient, ddbTableName: withDdb ? 'T' : null }));
    return app;
}

const LINE_ITEMS = [
    { lineItemId: 'a', originalDescription: '2" NB X Heavy -- GI', quantity: '10', unitRate: '100' },
    { lineItemId: 'b', originalDescription: '3" NB X Sch 40', quantity: '5', unitRate: '250' },
    { lineItemId: 'c', originalDescription: '1" NB X Medium -- ERW', quantity: '8', unitRate: '40' },
];

function seed(extra) {
    return {
        q1: {
            id: 'q1',
            _entity: 'QUOTATION',
            updatedAt: '2026-01-01T00:00:00.000Z',
            payload: Object.assign({
                id: 'q1', quoteNumber: 'DSC-200', companyName: 'Acme',
                adminStatus: 'awaiting',
                lineItems: JSON.parse(JSON.stringify(LINE_ITEMS)),
                tableHTML: '<table>rows</table>',
                headerHTML: '<div>header</div>',
                termsText: 'Terms apply',
                grandTotal: '3,250',
            }, extra),
        },
    };
}

describe('POST /quotations/:id/delete — soft delete', () => {
    test('flags the stored payload with deleted=true and an ISO deletedAt', async () => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/delete').send({});
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(store.q1.payload.deleted).toBe(true);
        expect(store.q1.payload.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // storeQuotationPayload also bumps the record's updatedAt
        expect(store.q1.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
        expect(store.q1.payload.updatedAt).toBe(store.q1.updatedAt);
    });

    test('it is a flag-only mutation — the heavy fields all survive', async () => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/delete').send({});
        expect(res.status).toBe(200);
        const p = store.q1.payload;
        expect(p.lineItems).toEqual(LINE_ITEMS);        // items untouched, not wiped
        expect(p.tableHTML).toBe('<table>rows</table>');
        expect(p.headerHTML).toBe('<div>header</div>');
        expect(p.termsText).toBe('Terms apply');
        expect(p.quoteNumber).toBe('DSC-200');
        expect(p.companyName).toBe('Acme');
        expect(p.grandTotal).toBe('3,250');
    });

    test('undo:true restores the quote — both flags are removed from the payload', async () => {
        const store = seed({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' });
        const res = await request(makeApp(store)).post('/api/quotations/q1/delete').send({ undo: true });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        // deleted properly, not just set to false — the client filters on truthiness
        expect('deleted' in store.q1.payload).toBe(false);
        expect('deletedAt' in store.q1.payload).toBe(false);
        expect(store.q1.payload.lineItems).toHaveLength(3);   // restore keeps the body too
    });

    test('404 when the quote does not exist', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/nope/delete').send({});
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Quotation not found');
    });

    test('500 when DynamoDB is not configured', async () => {
        const res = await request(makeApp({}, { withDdb: false })).post('/api/quotations/q1/delete').send({});
        expect(res.status).toBe(500);
    });
});

describe('GET /quotations — the deleted flag rides along in the list summary', () => {
    test('the summary projection asks DynamoDB for payload.deleted / data.deleted', async () => {
        const sent = [];
        await request(makeApp(seed(), { sent })).get('/api/quotations?limit=10');
        const query = sent.find(c => c.__type === 'Query');
        expect(query).toBeTruthy();
        expect(query.input.ProjectionExpression).toContain('#p.deleted');
        expect(query.input.ProjectionExpression).toContain('#d.deleted');
    });

    test('a soft-deleted quote comes back with deleted:true so the client can filter it', async () => {
        const res = await request(makeApp(seed({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })))
            .get('/api/quotations?limit=10');
        expect(res.status).toBe(200);
        const q = res.body.quotations.find(x => x.id === 'q1');
        expect(q.deleted).toBe(true);
    });
});

// ── index.html harness — run the REAL client functions under Node ─────────────

// Pull a top-level function out of source by brace-matching; keep a leading `async`.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

/**
 * Evaluate the named index.html functions together. `sandbox` values are bound as the
 * free variables the SPA code reads; `vars` are declared INSIDE the factory so the code
 * may reassign them (and are readable back through getters on the returned object).
 */
function loadFns(names, sandbox, vars) {
    const body = names.map(n => extractFunction(html, n)).join('\n');
    const keys = Object.keys(sandbox || {});
    const varNames = Object.keys(vars || {});
    const decls = varNames.map((v, i) => 'var ' + v + ' = __v[' + i + '];').join('\n');
    const members = names.map(n => n + ': ' + n)
        .concat(varNames.map(v => 'get ' + v + '() { return ' + v + '; }'));
    const src = decls + '\n' + body + '\nreturn { ' + members.join(', ') + ' };';
    // eslint-disable-next-line no-new-func
    const factory = new Function(['__v'].concat(keys).join(','), src);
    return factory.apply(null, [varNames.map(v => vars[v])].concat(keys.map(k => sandbox[k])));
}

// A fetch stub that answers every URL with the same JSON body (the real safeJsonParse
// is extracted alongside, so the content-type path is exercised for real).
function jsonFetch(body) {
    return async function () {
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => body,
        };
    };
}

const LIVE    = { id: 'live',  quoteNumber: 'DSC-201' };
const DELETED = { id: 'gone',  quoteNumber: 'DSC-202', deleted: true };

describe('soft-deleted quotes never reach approvedQuotations', () => {
    test('loadQuotationsFromBackend filters them out of the feed', async () => {
        const noop = () => {};
        const m = loadFns(
            ['safeJsonParse', 'loadQuotationsFromBackend'],
            {
                API_BASE_URL: '/api',
                APPROVED_QUOTATIONS_PAGE_SIZE: 50,
                fetch: jsonFetch({ quotations: [LIVE, DELETED], hasMore: false }),
                updateLoadMoreApprovedButton: noop,
                syncApprovedQuotationsGlobal: noop,
                displayAllApprovedQuotations: noop,
            },
            {
                approvedQuotations: [],
                approvedQuotationsLoading: false,
                approvedQuotationsCursor: null,
                approvedQuotationsHasMore: false,
            }
        );
        await m.loadQuotationsFromBackend(false);
        expect(m.approvedQuotations.map(q => q.id)).toEqual(['live']);
    });

    // The bug: this merge path used to push whatever the filter endpoint returned, so a
    // deleted quote reappeared as a live card the moment a month/freight filter matched it.
    test('applyApprovalServerFilter skips them when merging filter results', async () => {
        const list = [];
        const noop = () => {};
        const m = loadFns(
            ['safeJsonParse', 'idsMatch', 'applyApprovalServerFilter'],
            {
                API_BASE_URL: '/api',
                fetch: jsonFetch({ quotations: [LIVE, DELETED] }),
                approvedQuotations: list,
                approvalRevisionFilter: false,
                approvalEnquiryFilter: false,
                approvalFreightFilter: false,
                approvalMonthFilter: '2026-01',
                syncApprovedQuotationsGlobal: noop,
                displayAllApprovedQuotations: noop,
            },
            { _approvalFilterSeq: 0, approvalFilterFetchFailed: false, approvalFilterLoading: false }
        );
        await m.applyApprovalServerFilter();
        expect(list.map(q => q.id)).toEqual(['live']);
    });

    // Same bug on the search path — a search that happened to match resurrected the quote.
    test('serverSearchApprovedQuotations skips them when merging search results', async () => {
        const list = [];
        const noop = () => {};
        const m = loadFns(
            ['safeJsonParse', 'idsMatch', 'serverSearchApprovedQuotations'],
            {
                API_BASE_URL: '/api',
                fetch: jsonFetch({ quotations: [LIVE, DELETED] }),
                approvedQuotations: list,
                syncApprovedQuotationsGlobal: noop,
                displayAllApprovedQuotations: noop,
            },
            { _lastServerSearchQ: '' }
        );
        await m.serverSearchApprovedQuotations('acme');
        expect(list.map(q => q.id)).toEqual(['live']);
    });

    test('loadRevisionQuotesForCount skips them in the revision-count prefetch', async () => {
        const list = [];
        const noop = () => {};
        const m = loadFns(
            ['safeJsonParse', 'idsMatch', 'loadRevisionQuotesForCount'],
            {
                API_BASE_URL: '/api',
                fetch: jsonFetch({ quotations: [LIVE, DELETED] }),
                approvedQuotations: list,
                syncApprovedQuotationsGlobal: noop,
                displayAllApprovedQuotations: noop,
                updateApprovalRevisionCount: noop,
            },
            {}
        );
        await m.loadRevisionQuotesForCount();
        expect(list.map(q => q.id)).toEqual(['live']);
    });

    test('renderMarginDesk drops them from the margins-to-allocate desk', () => {
        const section = { style: {}, innerHTML: '' };
        const m = loadFns(['renderMarginDesk'], {
            document: { getElementById: id => (id === 'marginDeskSection' ? section : null) },
            approvedQuotations: [
                { id: 'a', adminStatus: 'awaiting', sent: false },                 // keep
                { id: 'b', adminStatus: 'awaiting', sent: false, deleted: true },  // drop
            ],
            buildMarginDeskRow: q => '[row:' + q.id + ']',
            ensureDeskEnquiryLoaded: () => {},
            mdkExpandedIds: {},
        }, {});
        m.renderMarginDesk();
        expect(section.innerHTML).toContain('[row:a]');
        expect(section.innerHTML).not.toContain('[row:b]');
        expect(section.innerHTML).toContain('1 waiting');
    });

    test('a desk holding only deleted quotes hides the section entirely', () => {
        const section = { style: {}, innerHTML: 'stale' };
        const m = loadFns(['renderMarginDesk'], {
            document: { getElementById: id => (id === 'marginDeskSection' ? section : null) },
            approvedQuotations: [{ id: 'b', adminStatus: 'awaiting', sent: false, deleted: true }],
            buildMarginDeskRow: q => '[row:' + q.id + ']',
            ensureDeskEnquiryLoaded: () => {},
            mdkExpandedIds: {},
        }, {});
        m.renderMarginDesk();
        expect(section.style.display).toBe('none');
        expect(section.innerHTML).toBe('');
    });
});

// Marker guards — cheap tripwires so the filters above can't be dropped in a refactor
// without a red test (they are one-liners buried in long functions).
describe('source guards — the soft-delete filters stay put', () => {
    test('index.html feed loader filters !q.deleted', () => {
        expect(extractFunction(html, 'loadQuotationsFromBackend')).toContain('!q.deleted');
    });

    test('BOTH server-merge paths skip deleted quotes', () => {
        // applyApprovalServerFilter was rewritten with an early return (it now also refreshes
        // quotes it has already loaded), so the old `!f.deleted` literal is gone. What matters —
        // a soft-deleted quote must not come back as a live card — is unchanged.
        expect(extractFunction(html, 'applyApprovalServerFilter')).toContain('f.deleted) return;');
        expect(extractFunction(html, 'serverSearchApprovedQuotations')).toContain('!f.deleted');
    });

    test('the revision-count prefetch skips them too', () => {
        expect(extractFunction(html, 'loadRevisionQuotesForCount')).toContain('!f.deleted');
    });

    test('renderMarginDesk excludes deleted quotes', () => {
        expect(extractFunction(html, 'renderMarginDesk'))
            .toContain("q.adminStatus === 'awaiting' && !q.sent && !q.deleted");
    });

    test("routes/quotations.js lists 'deleted' in SUMMARY_NESTED_PATHS", () => {
        const block = routeSrc.slice(
            routeSrc.indexOf('const SUMMARY_NESTED_PATHS'),
            routeSrc.indexOf('const SUMMARY_PROJECTION')
        );
        expect(block).toContain("'deleted'");
    });

    test('the delete route is a soft delete — no DeleteCommand anywhere in the router', () => {
        expect(routeSrc).toContain("router.post('/quotations/:id/delete'");
        expect(routeSrc).not.toContain('new DeleteCommand');
    });
});
