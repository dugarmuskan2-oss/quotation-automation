/**
 * @jest-environment node
 *
 * tests/admin-routes.test.js
 *
 * Functional tests for the admin margin-allocation routes on the quotations
 * router. All three act server-side on the STORED payload so the desk (which
 * only holds list summaries) can never clobber heavy fields:
 *   POST /quotations/:id/apply-admin-margins  — stamp margins, rebuild table, -> 'ready'
 *   POST /quotations/:id/regret               — flag regret / undo
 *   POST /quotations/:id/register-meta        — merge whitelisted register fields
 *
 * DynamoDB is faked with an in-memory store; lib-dynamodb command classes are
 * mocked to tiny tagged wrappers the fake send() dispatches on.
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

// Build an app backed by an in-memory DynamoDB. `store` maps id -> Item.
function makeApp(store, { withDdb = true } = {}) {
    const app = express();
    app.use(express.json());
    const ddbDocClient = withDdb ? {
        send: async (cmd) => {
            if (cmd.__type === 'Get') return { Item: store[cmd.input.Key.id] };
            if (cmd.__type === 'Put') { store[cmd.input.Item.id] = cmd.input.Item; return {}; }
            throw new Error('unexpected command: ' + cmd.__type);
        },
    } : null;
    app.use('/api', createQuotationsRouter({ ddbDocClient, ddbTableName: withDdb ? 'T' : null }));
    return app;
}

const li = (over) => Object.assign({
    lineItemId: 'li', originalDescription: 'd', identifiedPipeType: '',
    quantity: '10', unitRate: '100', marginPercent: '', kgPerMeter: '',
}, over);

function seed(extra) {
    const store = {};
    store['q1'] = { id: 'q1', payload: Object.assign({
        id: 'q1', quoteNumber: 'DSC-200', companyName: 'Acme',
        adminStatus: 'awaiting',
        lineItems: [
            li({ identifiedPipeType: 'Seamless Sch 40', unitRate: '250' }),
            li({ identifiedPipeType: 'ERW', unitRate: '50' }),
            li({ identifiedPipeType: 'GI', unitRate: '40' }),
        ],
    }, extra) };
    return store;
}

describe('POST /quotations/:id/apply-admin-margins', () => {
    test('stamps margins, rebuilds snapshots, and moves the quote to ready', async () => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/apply-admin-margins').send({
            adminMargins: { seamless: { mode: 'price' }, erw: { pct: 10 }, gi: { pct: 20 } },
            adminNote: 'quote seamless at list',
            isNewCompany: true,
            assignedTo: 'Ravi',
        });
        expect(res.status).toBe(200);
        const q = res.body.quotation;
        expect(q.adminStatus).toBe('ready');
        expect(q.adminNote).toBe('quote seamless at list');
        expect(q.isNewCompany).toBe(true);
        expect(q.assignedTo).toBe('Ravi');
        // margins landed on the right rows
        expect(q.lineItems[0].marginPercent).toBe('0');   // seamless price
        expect(q.lineItems[1].marginPercent).toBe('10');  // erw
        expect(q.lineItems[2].marginPercent).toBe('20');  // gi
        // derived fields rebuilt
        expect(q.itemSummary).toEqual({ count: 3, types: ['Seamless', 'ERW', 'GI'], noRate: 0 });
        expect(typeof q.tableHTML).toBe('string');
        expect(q.tableHTML).toContain('<table');
        expect(q.grandTotal).toBeTruthy();
        // and it was actually persisted
        expect(store['q1'].payload.adminStatus).toBe('ready');
        expect(store['q1'].updatedAt).toBeTruthy();
    });

    test('404 when the quote does not exist', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/nope/apply-admin-margins').send({ adminMargins: {} });
        expect(res.status).toBe(404);
    });

    test('500 when DynamoDB is not configured', async () => {
        const res = await request(makeApp({}, { withDdb: false })).post('/api/quotations/q1/apply-admin-margins').send({});
        expect(res.status).toBe(500);
    });
});

describe('POST /quotations/:id/regret', () => {
    test('regret with email sent -> regretted + timestamp', async () => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/regret').send({ emailSent: true });
        expect(res.status).toBe(200);
        expect(res.body.quotation.adminStatus).toBe('regretted');
        expect(res.body.quotation.regretSentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);   // ISO timestamp
        expect(store['q1'].payload.adminStatus).toBe('regretted');
    });

    test('regret without email sent -> regretted, blank timestamp', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/q1/regret').send({ emailSent: false });
        expect(res.status).toBe(200);
        expect(res.body.quotation.adminStatus).toBe('regretted');
        expect(res.body.quotation.regretSentAt).toBe('');
    });

    test('undo clears the regret back to awaiting and drops the timestamp', async () => {
        const store = seed({ adminStatus: 'regretted', regretSentAt: '2026-01-01T00:00:00.000Z' });
        const res = await request(makeApp(store)).post('/api/quotations/q1/regret').send({ undo: true });
        expect(res.status).toBe(200);
        expect(res.body.quotation.adminStatus).toBe('awaiting');
        expect(res.body.quotation.regretSentAt).toBeUndefined();
        expect('regretSentAt' in store['q1'].payload).toBe(false);
    });

    test('404 when the quote does not exist', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/nope/regret').send({});
        expect(res.status).toBe(404);
    });
});

describe('POST /quotations/:id/register-meta', () => {
    test('merges only whitelisted register fields', async () => {
        const store = seed();
        const res = await request(makeApp(store)).post('/api/quotations/q1/register-meta').send({
            registerMeta: { givenForCheckingTo: 'Sam', sentBy: 'Ravi', bogusField: 'ignored' },
        });
        expect(res.status).toBe(200);
        expect(res.body.registerMeta).toEqual({ givenForCheckingTo: 'Sam', sentBy: 'Ravi' });
        expect(res.body.registerMeta.bogusField).toBeUndefined();
        expect(store['q1'].payload.registerMeta.givenForCheckingTo).toBe('Sam');
    });

    test('a partial update preserves previously saved register fields', async () => {
        const store = seed({ registerMeta: { givenForCheckingTo: 'Sam', biginUploaded: 'yes' } });
        const res = await request(makeApp(store)).post('/api/quotations/q1/register-meta').send({
            registerMeta: { sentBy: 'Priya' },
        });
        expect(res.status).toBe(200);
        expect(res.body.registerMeta).toEqual({ givenForCheckingTo: 'Sam', biginUploaded: 'yes', sentBy: 'Priya' });
    });

    test('404 when the quote does not exist', async () => {
        const res = await request(makeApp(seed())).post('/api/quotations/nope/register-meta').send({ registerMeta: { sentBy: 'X' } });
        expect(res.status).toBe(404);
    });
});

// The reply-sweep and freight auto-check persist quotes by re-saving the in-memory
// object. For an unopened quote that object is only the list summary (no lineItems /
// tableHTML), and /save-quotation writes with PutCommand (full overwrite) — so saving
// a summary would WIPE the stored items. The route guards against that by refilling
// the body from the stored record when the incoming payload has none.
describe('POST /save-quotation — never wipes stored items with a bodyless payload', () => {
    test('a summary payload (no items/table) keeps the stored line items + tableHTML', async () => {
        const store = seed();
        store['q1'].payload.tableHTML = '<table>rows</table>';
        store['q1'].payload.headerHTML = '<div>header</div>';
        const res = await request(makeApp(store)).post('/api/save-quotation')
            .send({ quotation: { id: 'q1', companyName: 'Acme', grandTotal: '999', custReplyPending: true } });
        expect(res.status).toBe(200);
        expect(store['q1'].payload.lineItems).toHaveLength(3);         // preserved, not wiped
        expect(store['q1'].payload.tableHTML).toBe('<table>rows</table>');
        expect(store['q1'].payload.headerHTML).toBe('<div>header</div>');
        expect(store['q1'].payload.custReplyPending).toBe(true);       // the flag update still lands
    });
    test('a full payload overwrites the items normally', async () => {
        const store = seed();
        const newItems = [{ lineItemId: 'x', originalDescription: 'X', quantity: '5' }];
        const res = await request(makeApp(store)).post('/api/save-quotation')
            .send({ quotation: { id: 'q1', lineItems: newItems, tableHTML: '<table>new</table>', grandTotal: '5' } });
        expect(res.status).toBe(200);
        expect(store['q1'].payload.lineItems).toEqual(newItems);
        expect(store['q1'].payload.tableHTML).toBe('<table>new</table>');
    });
});
