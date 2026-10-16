/**
 * @jest-environment node
 *
 * tests/quote-permission-routes.test.js
 *
 * Per-person permissions on the quote routes (routes/quotations.js + utils/permissions.js).
 * The REAL quotations router is mounted on express and driven with supertest, backed by an
 * in-memory DynamoDB. A small stand-in for the auth gate (routes/auth.js) puts the person on
 * req.user exactly the way the gate does: who they are, and their ticks on req.user.permissions;
 * req.permissionsUnknown when the people list could not be read; req.authOpen (and no req.user)
 * when no logins are set up at all.
 *
 * What is pinned here, route by route:
 *   apply-admin-margins  — Allocate margins on a waiting quote; Edit margins only once reopened;
 *                          never on a ready / sent / regretted / deleted quote; allocatedBy comes
 *                          from the sign-in; the "From the admin" note needs Add notes to change
 *                          and Delete notes to empty, and the old words are kept.
 *   reopen-margins       — Edit margins; only an untouched ready quote; never once sent, never
 *                          with freight in it, never after staff have saved their own table.
 *   regret / delete      — Allocate margins; regret only from the box, undo only a regret;
 *                          check:true changes nothing.
 *   revision-request     — a note needs Add notes, an ask needs Add revisions; the name is the
 *                          signed-in person's, never what the browser claims.
 *   note deletes         — Delete notes; a tombstone is kept; deletedNotes capped at 50 and never
 *                          served by the public GET.
 *   save-quotation       — the admin fields are server-owned; a brand-new quote can't arrive
 *                          pre-allocated or pre-signed.
 *   permissionsUnknown   — 503 "try again", never 403 "not allowed".
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

const express = require('express');
const request = require('supertest');
const createQuotationsRouter = require('../routes/quotations');
const PERMS = require('../utils/permissions');

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// ── Harness ───────────────────────────────────────────────────────────────────

/**
 * An app over an in-memory table. `store` maps id -> Item. Reads hand back COPIES (as DynamoDB
 * does), so a route that throws half-way can't leave its edits behind in the store, and `writes`
 * records every Put that landed. The _rev condition on mutateStoredQuotation's Put is honoured.
 * `users` (optional) makes the gate stand-in work out ticks from a people list, as the real gate does.
 */
function makeHarness(store, { users } = {}) {
    const writes = [];
    const state = { failGet: false };
    const ddbDocClient = {
        send: async (cmd) => {
            if (cmd.__type === 'Get') {
                if (state.failGet) { const e = new Error('ProvisionedThroughputExceededException'); e.name = 'ProvisionedThroughputExceededException'; throw e; }
                return { Item: clone(store[cmd.input.Key.id]) };
            }
            if (cmd.__type === 'Put') {
                const item = cmd.input.Item;
                const cur = store[item.id];
                const cond = cmd.input.ConditionExpression;
                const clash = (cond === '#r = :prev' && !(cur && cur._rev === cmd.input.ExpressionAttributeValues[':prev']))
                    || (cond === 'attribute_not_exists(#r)' && cur && cur._rev !== undefined);
                if (clash) { const e = new Error('The conditional request failed'); e.name = 'ConditionalCheckFailedException'; throw e; }
                store[item.id] = clone(item);
                writes.push(clone(item));
                return {};
            }
            throw new Error('unexpected command: ' + cmd.__type);
        },
    };
    const storage = { upload: jest.fn(async () => {}) };
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    // Stand-in for the auth gate in routes/auth.js.
    app.use((req, res, next) => {
        const h = req.headers;
        if (h['x-auth-open']) req.authOpen = true;
        if (h['x-no-user']) return next();
        const who = h['x-who'] || 'Asha';
        const email = h['x-email'] || (who.toLowerCase().replace(/\s+/g, '.') + '@dscpipes.com');
        const unknown = !!h['x-perm-unknown'];
        let list;
        if (unknown) list = [];                                            // the gate gives nothing
        else if (users) list = PERMS.effectivePermissions(users, email);    // worked out like the gate
        else if (h['x-perms'] === undefined) list = PERMS.ALL.slice();
        else list = String(h['x-perms']).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
        req.user = { who, kind: h['x-kind'] || 'person', email, permissions: list };
        if (unknown) req.permissionsUnknown = true;
        next();
    });
    app.use('/api', createQuotationsRouter({ ddbDocClient, ddbTableName: 'T', storage }));
    return { app, store, writes, state, storage };
}

/** POST as someone. `as.perms` is the tick list (omit = every tick); [] = none at all. */
function post(h, path, body, as = {}) {
    let r = request(h.app).post('/api' + path).set('x-who', as.who || 'Asha');
    if (as.perms !== undefined) r = r.set('x-perms', as.perms.length ? as.perms.join(',') : 'none');
    if (as.kind) r = r.set('x-kind', as.kind);
    if (as.email) r = r.set('x-email', as.email);
    if (as.unknown) r = r.set('x-perm-unknown', '1');
    if (as.open) r = r.set('x-auth-open', '1');
    if (as.noUser) r = r.set('x-no-user', '1');
    return r.send(body || {});
}

const SEAMLESS = { lineItemId: 'l1', originalDescription: '2" NB X Sch 40 -- Seamless', identifiedPipeType: 'Seamless',
    quantity: '10', unitRate: '500', costRate: '400', marginPercent: '', kgPerMeter: '5.44' };
const ERW = { lineItemId: 'l2', originalDescription: '1" NB X Heavy -- ERW', identifiedPipeType: 'ERW',
    quantity: '20', unitRate: '100', marginPercent: '', kgPerMeter: '2.40' };

function waitingQuote(over) {
    return Object.assign({
        id: 'q1', quoteNumber: 'DSC-3001', companyName: 'Acme Tubes',
        adminStatus: 'awaiting', adminNote: '',
        saved: true, everApproved: true,
        lineItems: [clone(SEAMLESS), clone(ERW)],
        tableHTML: '<table><tr><td>AI draft</td></tr></table>',
    }, over || {});
}
function storeWith(payload) {
    return { [payload.id]: { id: payload.id, _entity: 'quotation', payload: clone(payload) } };
}
const stored = (h, id = 'q1') => h.store[id].payload;

const MARGINS = { seamless: { mode: 'price' }, erw: { pct: 10 } };

/** A quote that has been through the Margins box via the real route (allocated, status 'ready'). */
async function allocatedHarness(over, margins) {
    const h = makeHarness(storeWith(waitingQuote(over)));
    const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: margins || MARGINS }, { who: 'Desk Admin', perms: ['allocateMargins'] });
    expect(res.status).toBe(200);
    expect(stored(h).adminStatus).toBe('ready');
    h.writes.length = 0;
    return h;
}

/** What a staff member's browser does: load the full quote, change it, Save. */
async function staffSave(h, change) {
    const got = await request(h.app).get('/api/quotations/q1').set('x-who', 'Ravi');
    expect(got.status).toBe(200);
    const q = got.body.quotation;
    change(q);
    const res = await post(h, '/save-quotation', { quotation: q }, { who: 'Ravi', perms: ['addRevisions'] });
    expect(res.status).toBe(200);
}

// ── apply-admin-margins ───────────────────────────────────────────────────────

describe('POST /quotations/:id/apply-admin-margins — who may allocate', () => {
    test('a waiting quote needs Allocate margins: Edit margins alone is refused and nothing is written', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS }, { perms: ['editMargins', 'addNotes', 'deleteNotes'] });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('no-permission');
        expect(res.body.permission).toBe('allocateMargins');
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminStatus).toBe('awaiting');
    });

    test('with Allocate margins: ready, allocatedBy is the signed-in person (a body allocatedBy is ignored), fingerprint stamped', async () => {
        const h = makeHarness(storeWith(waitingQuote({ _adminMarginsDraft: { erw: { pct: 3 } } })));
        const res = await post(h, '/quotations/q1/apply-admin-margins',
            { adminMargins: MARGINS, allocatedBy: 'Mallory', allocatedTableFp: 'forged' }, { who: 'Asha', perms: ['allocateMargins'] });
        expect(res.status).toBe(200);
        const p = stored(h);
        expect(p.adminStatus).toBe('ready');
        expect(p.allocatedBy).toBe('Asha');
        expect(p.allocatedAt).toBeTruthy();
        expect(p.allocatedTableFp).toMatch(/^[0-9a-f]{16}$/);
        expect(p.lineItems[1].marginPercent).toBe('10');
        expect(p._adminMarginsDraft).toBeUndefined();
        // A first allocation is not a re-price: an approval the quote had is left alone.
        expect(p.saved).toBe(true);
        expect(p.everApproved).toBe(true);
        expect(h.writes).toHaveLength(1);
    });

    test('a shared-password sign-in is stamped "Shared login", not the name its browser types', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS }, { who: 'Office', kind: 'shared', perms: ['allocateMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).allocatedBy).toBe('Shared login');
    });

    test.each([
        ['already allocated (ready)', { adminStatus: 'ready' }, /already set/],
        ['sent to the customer', { sent: true }, /already sent/],
        ['regretted', { adminStatus: 'regretted' }, /regretted/],
        ['deleted', { deleted: true }, /deleted/],
    ])('409 on a quote that is %s — even with every tick — and nothing is written', async (label, over, msg) => {
        const h = makeHarness(storeWith(waitingQuote(over)));
        const before = clone(stored(h));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(msg);
        expect(h.writes).toHaveLength(0);
        expect(stored(h)).toEqual(before);
    });
});

describe('POST /quotations/:id/apply-admin-margins — the "From the admin" note', () => {
    test('changing the note needs Add notes: Allocate margins alone refuses the whole send', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS, adminNote: 'quote at list' }, { perms: ['allocateMargins'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('addNotes');
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminNote).toBe('');
        expect(stored(h).adminStatus).toBe('awaiting');
    });

    test('with Add notes a new note lands, signed by the signed-in person', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS, adminNote: 'quote at list', adminNoteBy: 'Mallory' }, { who: 'Asha', perms: ['allocateMargins', 'addNotes'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminNote).toBe('quote at list');
        expect(stored(h).adminNoteBy).toBe('Asha');
        expect(stored(h).deletedNotes).toBeUndefined();   // nothing was written over
    });

    test('words written over are kept in deletedNotes (kind admin-edit), with who wrote them and who replaced them', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'quote at list', adminNoteBy: 'Ravi' })));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS, adminNote: 'quote list +5%' }, { who: 'Asha', perms: ['allocateMargins', 'addNotes'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminNote).toBe('quote list +5%');
        expect(stored(h).deletedNotes).toHaveLength(1);
        expect(stored(h).deletedNotes[0]).toMatchObject({ kind: 'admin-edit', text: 'quote at list', addedBy: 'Ravi', deletedBy: 'Asha' });
    });

    test('emptying a note that had words needs Delete notes — Add notes is not enough', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'quote at list', adminNoteBy: 'Ravi' })));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS, adminNote: '' }, { perms: ['allocateMargins', 'addNotes'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('deleteNotes');
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminNote).toBe('quote at list');
    });

    test('with Delete notes the note is emptied and the old words are kept (kind admin)', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'quote at list', adminNoteBy: 'Ravi' })));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS, adminNote: '<p>&nbsp;</p>' }, { who: 'Asha', perms: ['allocateMargins', 'deleteNotes'] });
        expect(res.status).toBe(200);
        expect(stored(h).deletedNotes).toHaveLength(1);
        expect(stored(h).deletedNotes[0]).toMatchObject({ kind: 'admin', text: 'quote at list', addedBy: 'Ravi', deletedBy: 'Asha' });
    });

    test('expectedAdminNote that no longer matches the stored note → 409, nothing written', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'colleague changed this' })));
        const res = await post(h, '/quotations/q1/apply-admin-margins',
            { adminMargins: MARGINS, adminNote: 'my version', expectedAdminNote: 'what I saw' });
        expect(res.status).toBe(409);
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminNote).toBe('colleague changed this');
        expect(stored(h).adminStatus).toBe('awaiting');
    });

    test('expectedAdminNote that matches → the change goes through', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'what I saw' })));
        const res = await post(h, '/quotations/q1/apply-admin-margins',
            { adminMargins: MARGINS, adminNote: 'my version', expectedAdminNote: 'what I saw' });
        expect(res.status).toBe(200);
        expect(stored(h).adminNote).toBe('my version');
    });

    test('adminNote left out of the request leaves the note alone — no note permission needed', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'keep me', adminNoteBy: 'Ravi', adminNoteAt: '2026-10-01T00:00:00.000Z' })));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS }, { perms: ['allocateMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminNote).toBe('keep me');
        expect(stored(h).adminNoteBy).toBe('Ravi');
        expect(stored(h).adminNoteAt).toBe('2026-10-01T00:00:00.000Z');
        expect(stored(h).deletedNotes).toBeUndefined();
    });
});

// ── reopen-margins ("Edit margins") ───────────────────────────────────────────

describe('POST /quotations/:id/reopen-margins', () => {
    test('needs Edit margins — Allocate margins alone is refused', async () => {
        const h = await allocatedHarness();
        const res = await post(h, '/quotations/q1/reopen-margins', {}, { perms: ['allocateMargins', 'addNotes', 'deleteNotes', 'addRevisions'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('editMargins');
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminStatus).toBe('ready');
    });

    test('an untouched ready quote goes back to the box, stamped with who reopened it', async () => {
        const h = await allocatedHarness();
        h.store.q1.payload._adminMarginsDraft = { erw: { pct: 99 } };   // a stale in-browser draft from an old record
        const res = await post(h, '/quotations/q1/reopen-margins', { adminReopenedBy: 'Mallory' }, { who: 'Asha', perms: ['editMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminStatus).toBe('awaiting');
        expect(stored(h).adminReopenedBy).toBe('Asha');
        expect(stored(h).adminReopenedAt).toBeTruthy();
        expect(stored(h)._adminMarginsDraft).toBeUndefined();
    });

    test('409 for a quote still waiting in the box, and for one that never went through it', async () => {
        const h1 = makeHarness(storeWith(waitingQuote()));
        expect((await post(h1, '/quotations/q1/reopen-margins', {})).status).toBe(409);
        const h2 = makeHarness(storeWith(waitingQuote({ adminStatus: undefined })));
        expect((await post(h2, '/quotations/q1/reopen-margins', {})).status).toBe(409);
        expect(h1.writes.length + h2.writes.length).toBe(0);
    });

    test('409 on a second reopen — the quote is already back in the box (its table is untouched, so only the status stops it)', async () => {
        const h = await allocatedHarness();
        expect((await post(h, '/quotations/q1/reopen-margins', {}, { who: 'Asha', perms: ['editMargins'] })).status).toBe(200);
        const firstReopen = clone(stored(h));
        h.writes.length = 0;
        const res = await post(h, '/quotations/q1/reopen-margins', {}, { who: 'Ravi', perms: ['editMargins'] });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already in the Margins box/);
        expect(h.writes).toHaveLength(0);
        expect(stored(h)).toEqual(firstReopen);
    });

    test('409 for an untouched allocated quote whose status is no longer ready', async () => {
        const h = await allocatedHarness();
        delete h.store.q1.payload.adminStatus;
        const res = await post(h, '/quotations/q1/reopen-margins', {});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/not been through/);
        expect(h.writes).toHaveLength(0);
    });

    test('409 once the quote has been sent to the customer', async () => {
        const h = await allocatedHarness();
        h.store.q1.payload.sent = true;
        const res = await post(h, '/quotations/q1/reopen-margins', {});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/sent/);
        expect(stored(h).adminStatus).toBe('ready');
    });

    test('409 when the table carries a freight row', async () => {
        const h = await allocatedHarness();
        h.store.q1.payload.tableHTML += '<tr class="freight-row"><td>Freight</td><td>5000</td></tr>';
        const res = await post(h, '/quotations/q1/reopen-margins', {});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/freight/i);
        expect(h.writes).toHaveLength(0);
    });

    test('409 when freight was distributed into the margins (FOR)', async () => {
        const h = await allocatedHarness();
        h.store.q1.payload.freightDistributedIntoMargin = true;
        const res = await post(h, '/quotations/q1/reopen-margins', {});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/freight/i);
        expect(h.writes).toHaveLength(0);
    });

    test('409 after a staff Save put their own table in', async () => {
        const h = await allocatedHarness();
        await staffSave(h, (q) => { q.tableHTML = '<table><tr><td>2&quot; NB hand edited</td></tr></table>'; });
        expect(stored(h).adminStatus).toBe('ready');   // the save could not touch the desk status
        const res = await post(h, '/quotations/q1/reopen-margins', {});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/worked on/);
        expect(stored(h).adminStatus).toBe('ready');
    });

    test('409 after a staff Save synced the lines (cost rate dropped) even with the same table', async () => {
        const h = await allocatedHarness();
        await staffSave(h, (q) => { q.lineItems = q.lineItems.map((li) => { const c = Object.assign({}, li); delete c.costRate; return c; }); });
        const res = await post(h, '/quotations/q1/reopen-margins', {});
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/worked on/);
    });

    test('a staff Save that changed nothing in the table or lines does not block a reopen', async () => {
        const h = await allocatedHarness();
        await staffSave(h, (q) => { q.checkedBy = 'Ravi'; });
        const res = await post(h, '/quotations/q1/reopen-margins', {}, { perms: ['editMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminStatus).toBe('awaiting');
    });
});

describe('apply-admin-margins on a reopened quote', () => {
    async function reopenedHarness(margins) {
        const h = await allocatedHarness({}, margins);
        const r = await post(h, '/quotations/q1/reopen-margins', {}, { who: 'Asha', perms: ['editMargins'] });
        expect(r.status).toBe(200);
        h.writes.length = 0;
        return h;
    }

    test('Edit margins alone may re-price it: ready again, approval cleared, reopen fields gone', async () => {
        const h = await reopenedHarness();
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: { seamless: { mode: 'price' }, erw: { pct: 12 } } }, { who: 'Asha', perms: ['editMargins'] });
        expect(res.status).toBe(200);
        const p = stored(h);
        expect(p.adminStatus).toBe('ready');
        expect(p.lineItems[1].marginPercent).toBe('12');
        expect(p.saved).toBe(false);
        expect(p.everApproved).toBe(false);
        expect(p.adminReopenedAt).toBeUndefined();
        expect(p.adminReopenedBy).toBeUndefined();
        expect(p.allocatedBy).toBe('Asha');
    });

    test('someone with neither margins tick is refused, naming Edit margins', async () => {
        const h = await reopenedHarness();
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS }, { perms: ['addNotes', 'deleteNotes', 'addRevisions'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('editMargins');
        expect(h.writes).toHaveLength(0);
    });

    test('409 when staff saved their own table after the reopen', async () => {
        const h = await reopenedHarness();
        await staffSave(h, (q) => { q.tableHTML = '<table><tr><td>staff table</td></tr></table>'; });
        expect(stored(h).adminStatus).toBe('awaiting');
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/worked on/);
        expect(stored(h).tableHTML).toBe('<table><tr><td>staff table</td></tr></table>');
    });

    test('seamless at cost, then back to price list after a reopen, restores the list rate', async () => {
        const h = await reopenedHarness({ seamless: { mode: 'cost', pct: 5 }, erw: { pct: 10 } });
        expect(parseFloat(stored(h).lineItems[0].unitRate)).toBe(400);           // cost while allocated at cost
        expect(stored(h).lineItems[0].listUnitRate).toBe('500');
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: { seamless: { mode: 'price' }, erw: { pct: 10 } } }, { perms: ['editMargins'] });
        expect(res.status).toBe(200);
        const seamless = stored(h).lineItems[0];
        expect(parseFloat(seamless.unitRate)).toBe(500);
        expect(seamless.finalRate).toBe('500');
        expect(seamless.marginPercent).toBe('0');
        expect(seamless.listUnitRate).toBeUndefined();
    });
});

// ── regret ────────────────────────────────────────────────────────────────────

describe('POST /quotations/:id/regret', () => {
    test('needs Allocate margins', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/regret', { emailSent: true }, { perms: ['editMargins', 'addNotes', 'deleteNotes', 'addRevisions'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('allocateMargins');
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminStatus).toBe('awaiting');
    });

    test('from the box: regretted, stamped with who regretted it', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/regret', { emailSent: true, regrettedBy: 'Mallory' }, { who: 'Asha', perms: ['allocateMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminStatus).toBe('regretted');
        expect(stored(h).regretSentAt).toBeTruthy();
        expect(stored(h).regrettedBy).toBe('Asha');
    });

    test.each([
        ['already allocated (ready)', { adminStatus: 'ready' }],
        ['sent', { sent: true }],
        ['deleted', { deleted: true }],
    ])('regret is refused (409) for a quote that is %s', async (label, over) => {
        const h = makeHarness(storeWith(waitingQuote(over)));
        const res = await post(h, '/quotations/q1/regret', { emailSent: true });
        expect(res.status).toBe(409);
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminStatus).toBe(over.adminStatus || 'awaiting');
    });

    test('undo only from regretted: an allocated quote is NOT put back in the box', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminStatus: 'ready' })));
        const res = await post(h, '/quotations/q1/regret', { undo: true });
        expect(res.status).toBe(409);
        expect(stored(h).adminStatus).toBe('ready');
        const h2 = makeHarness(storeWith(waitingQuote()));
        expect((await post(h2, '/quotations/q1/regret', { undo: true })).status).toBe(409);
        expect(h.writes.length + h2.writes.length).toBe(0);
    });

    test('undo on a regretted quote puts it back in the box and drops the regret time', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminStatus: 'regretted', regretSentAt: '2026-10-10T00:00:00.000Z' })));
        const res = await post(h, '/quotations/q1/regret', { undo: true }, { perms: ['allocateMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminStatus).toBe('awaiting');
        expect(stored(h).regretSentAt).toBeUndefined();
    });

    test('check:true on a waiting quote answers ok and changes nothing', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const before = clone(stored(h));
        const res = await post(h, '/quotations/q1/regret', { check: true, emailSent: true });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(h.writes).toHaveLength(0);
        expect(stored(h)).toEqual(before);
    });

    test.each([
        ['ready', { adminStatus: 'ready' }],
        ['regretted', { adminStatus: 'regretted' }],
        ['sent', { sent: true }],
        ['deleted', { deleted: true }],
    ])('check:true on a quote that is %s → 409, nothing written', async (label, over) => {
        const h = makeHarness(storeWith(waitingQuote(over)));
        const res = await post(h, '/quotations/q1/regret', { check: true });
        expect(res.status).toBe(409);
        expect(h.writes).toHaveLength(0);
    });
});

// ── desk delete ───────────────────────────────────────────────────────────────

describe('POST /quotations/:id/delete (Margins box)', () => {
    test('needs Allocate margins', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/delete', {}, { perms: ['editMargins', 'deleteNotes', 'addNotes', 'addRevisions'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('allocateMargins');
        expect(stored(h).deleted).toBeUndefined();
        expect(h.writes).toHaveLength(0);
    });

    test('stamps deletedBy from the sign-in; undo clears it', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/delete', { deletedBy: 'Mallory' }, { who: 'Asha', perms: ['allocateMargins'] });
        expect(res.status).toBe(200);
        expect(stored(h).deleted).toBe(true);
        expect(stored(h).deletedBy).toBe('Asha');
        expect(stored(h).deletedAt).toBeTruthy();
        const undo = await post(h, '/quotations/q1/delete', { undo: true }, { perms: ['allocateMargins'] });
        expect(undo.status).toBe(200);
        expect(stored(h).deleted).toBeUndefined();
        expect(stored(h).deletedBy).toBeUndefined();
    });
});

// ── revision-request (asks + notes) ───────────────────────────────────────────

describe('POST /quotations/:id/revision-request', () => {
    test('a note needs Add notes — Add revisions is not enough', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/revision-request', { kind: 'note', text: 'call him' }, { perms: ['addRevisions'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('addNotes');
        expect(stored(h).extraNotes).toBeUndefined();
        expect(h.writes).toHaveLength(0);
    });

    test('a revision ask needs Add revisions — Add notes is not enough', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/revision-request', { text: 'make it 2%' }, { perms: ['addNotes'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('addRevisions');
        expect(stored(h).revisionRequests).toBeUndefined();
    });

    test('a note goes into extraNotes, signed by the sign-in; a body addedBy is ignored', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/revision-request', { kind: 'note', text: 'call him', addedBy: 'Mallory' }, { who: 'Asha', perms: ['addNotes'] });
        expect(res.status).toBe(200);
        expect(stored(h).extraNotes).toHaveLength(1);
        expect(stored(h).extraNotes[0]).toMatchObject({ text: 'call him', addedBy: 'Asha' });
        expect(stored(h).extraNotes[0].done).toBeUndefined();
        expect(stored(h).revisionRequests).toBeUndefined();
    });

    test('an ask goes into revisionRequests as open, signed by the sign-in; a body addedBy is ignored', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/revision-request', { text: 'make it 2%', addedBy: 'Mallory' }, { who: 'Asha', perms: ['addRevisions'] });
        expect(res.status).toBe(200);
        expect(stored(h).revisionRequests).toHaveLength(1);
        expect(stored(h).revisionRequests[0]).toMatchObject({ text: 'make it 2%', addedBy: 'Asha', done: false });
        expect(stored(h).extraNotes).toBeUndefined();
    });

    test('a shared-password sign-in is signed "Shared login"', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/revision-request', { text: 'redo', addedBy: 'Dhanesh' }, { who: 'Front desk', kind: 'shared', perms: ['addRevisions'] });
        expect(res.status).toBe(200);
        expect(stored(h).revisionRequests[0].addedBy).toBe('Shared login');
    });
});

// ── deleting notes ────────────────────────────────────────────────────────────

describe('POST /quotations/:id/extra-notes/:noteId/delete', () => {
    const withNote = () => storeWith(waitingQuote({ extraNotes: [
        { id: 'n1', text: 'call him', addedBy: 'Ravi', addedAt: '2026-10-01T00:00:00.000Z' },
        { id: 'n2', text: 'keep me', addedBy: 'Ravi' },
    ] }));

    test('needs Delete notes', async () => {
        const h = makeHarness(withNote());
        const res = await post(h, '/quotations/q1/extra-notes/n1/delete', {}, { perms: ['addNotes', 'allocateMargins', 'editMargins', 'addRevisions'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('deleteNotes');
        expect(stored(h).extraNotes).toHaveLength(2);
        expect(h.writes).toHaveLength(0);
    });

    test('removes that note only and keeps a tombstone with who wrote it and who deleted it', async () => {
        const h = makeHarness(withNote());
        const res = await post(h, '/quotations/q1/extra-notes/n1/delete', {}, { who: 'Asha', perms: ['deleteNotes'] });
        expect(res.status).toBe(200);
        expect(res.body.removed).toBe(true);
        expect(stored(h).extraNotes.map((n) => n.id)).toEqual(['n2']);
        expect(stored(h).deletedNotes).toHaveLength(1);
        expect(stored(h).deletedNotes[0]).toMatchObject({ kind: 'extra', id: 'n1', text: 'call him', addedBy: 'Ravi', deletedBy: 'Asha' });
    });

    test('a note already gone is a harmless 200 with removed:false and no new tombstone', async () => {
        const h = makeHarness(withNote());
        const res = await post(h, '/quotations/q1/extra-notes/nope/delete', {}, { perms: ['deleteNotes'] });
        expect(res.status).toBe(200);
        expect(res.body.removed).toBe(false);
        expect(stored(h).extraNotes).toHaveLength(2);
        expect(stored(h).deletedNotes || []).toHaveLength(0);
    });

    test('deletedNotes is capped at the newest 50', async () => {
        const old = Array.from({ length: 50 }, (_, i) => ({ kind: 'extra', id: 'old' + i, text: 't' + i }));
        const h = makeHarness(storeWith(waitingQuote({ deletedNotes: old, extraNotes: [{ id: 'n1', text: 'bye' }] })));
        const res = await post(h, '/quotations/q1/extra-notes/n1/delete', {}, { perms: ['deleteNotes'] });
        expect(res.status).toBe(200);
        const list = stored(h).deletedNotes;
        expect(list).toHaveLength(50);
        expect(list[0].id).toBe('old1');                 // the oldest one fell off
        expect(list[49]).toMatchObject({ id: 'n1', text: 'bye' });
    });

    test('under the cap nothing is dropped (49 + 1 = 50)', async () => {
        const old = Array.from({ length: 49 }, (_, i) => ({ kind: 'extra', id: 'old' + i, text: 't' + i }));
        const h = makeHarness(storeWith(waitingQuote({ deletedNotes: old, extraNotes: [{ id: 'n1', text: 'bye' }] })));
        await post(h, '/quotations/q1/extra-notes/n1/delete', {}, { perms: ['deleteNotes'] });
        expect(stored(h).deletedNotes).toHaveLength(50);
        expect(stored(h).deletedNotes[0].id).toBe('old0');
    });
});

describe('POST /quotations/:id/admin-note/clear', () => {
    const withAdminNote = () => storeWith(waitingQuote({ adminNote: 'quote at list', adminNoteBy: 'Ravi' }));

    test('needs Delete notes', async () => {
        const h = makeHarness(withAdminNote());
        const res = await post(h, '/quotations/q1/admin-note/clear', { expected: 'quote at list' }, { perms: ['addNotes', 'allocateMargins'] });
        expect(res.status).toBe(403);
        expect(res.body.permission).toBe('deleteNotes');
        expect(stored(h).adminNote).toBe('quote at list');
    });

    test('expected text that no longer matches → 409, the note is left as it is', async () => {
        const h = makeHarness(withAdminNote());
        const res = await post(h, '/quotations/q1/admin-note/clear', { expected: 'something older' }, { perms: ['deleteNotes'] });
        expect(res.status).toBe(409);
        expect(stored(h).adminNote).toBe('quote at list');
        expect(h.writes).toHaveLength(0);
    });

    test('sets the note to "" (not removed) and keeps a tombstone', async () => {
        const h = makeHarness(withAdminNote());
        const res = await post(h, '/quotations/q1/admin-note/clear', { expected: 'quote at list' }, { who: 'Asha', perms: ['deleteNotes'] });
        expect(res.status).toBe(200);
        expect(stored(h).adminNote).toBe('');
        expect(stored(h).adminNoteBy).toBe('Asha');
        expect(stored(h).deletedNotes).toHaveLength(1);
        expect(stored(h).deletedNotes[0]).toMatchObject({ kind: 'admin', text: 'quote at list', addedBy: 'Ravi', deletedBy: 'Asha' });
    });

    test('clearing an already-empty note leaves no tombstone', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: '' })));
        const res = await post(h, '/quotations/q1/admin-note/clear', { expected: '' }, { perms: ['deleteNotes'] });
        expect(res.status).toBe(200);
        expect(stored(h).deletedNotes || []).toHaveLength(0);
    });
});

// ── note-image ────────────────────────────────────────────────────────────────

describe('POST /quotations/:id/note-image', () => {
    const IMG = { base64: Buffer.from('fake png bytes').toString('base64'), contentType: 'image/png' };

    test('refused without Add notes or Add revisions — nothing is uploaded', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/note-image', IMG, { perms: ['allocateMargins', 'editMargins', 'deleteNotes'] });
        expect(res.status).toBe(403);
        expect(h.storage.upload).not.toHaveBeenCalled();
    });

    test.each([['addNotes'], ['addRevisions']])('allowed with %s alone', async (perm) => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/note-image', IMG, { perms: [perm] });
        expect(res.status).toBe(200);
        expect(res.body.key).toMatch(/^enquiries\/note-images\/q1\//);
        expect(h.storage.upload).toHaveBeenCalledTimes(1);
    });
});

// ── permissions that could not be read ───────────────────────────────────────

describe('req.permissionsUnknown → 503 "try again", never 403', () => {
    const ROUTES = [
        ['apply-admin-margins', '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS }],
        ['reopen-margins', '/quotations/q1/reopen-margins', {}],
        ['regret', '/quotations/q1/regret', { emailSent: true }],
        ['delete', '/quotations/q1/delete', {}],
        ['revision ask', '/quotations/q1/revision-request', { text: 'redo' }],
        ['note', '/quotations/q1/revision-request', { kind: 'note', text: 'fyi' }],
        ['extra-note delete', '/quotations/q1/extra-notes/n1/delete', {}],
        ['admin-note clear', '/quotations/q1/admin-note/clear', {}],
        ['note-image', '/quotations/q1/note-image', { base64: 'aGk=', contentType: 'image/png' }],
    ];
    test.each(ROUTES)('%s', async (label, path, body) => {
        const h = makeHarness(storeWith(waitingQuote({ adminNote: 'x', extraNotes: [{ id: 'n1', text: 'a' }] })));
        const res = await post(h, path, body, { unknown: true });
        expect(res.status).toBe(503);
        expect(h.writes).toHaveLength(0);
        expect(h.storage.upload).not.toHaveBeenCalled();
    });
});

// ── what a request may do (utils/permissions.js, through the routes) ─────────

describe('who the request is', () => {
    test('a site with no logins at all (req.authOpen, no req.user) may do everything', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS, adminNote: 'n' }, { open: true, noUser: true });
        expect(res.status).toBe(200);
        expect(stored(h).adminStatus).toBe('ready');
    });

    test('no req.user and not open (a machine call) may do nothing', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        expect((await post(h, '/quotations/q1/regret', { emailSent: true }, { noUser: true })).status).toBe(403);
        expect((await post(h, '/quotations/q1/revision-request', { text: 'x' }, { noUser: true })).status).toBe(403);
        expect(h.writes).toHaveLength(0);
    });

    describe('ticks worked out from the people list, as the gate does', () => {
        const USERS = [
            { email: 'owner@dscpipes.com', permissions: PERMS.ALL.slice() },
            { email: 'old.admin@dscpipes.com', role: 'admin' },
            { email: 'staff@dscpipes.com' },
        ];

        test('legacy role:"admin" holds every tick (may reopen and allocate)', async () => {
            const h = await allocatedHarness();
            const hu = makeHarness(h.store, { users: USERS });
            const res = await post(hu, '/quotations/q1/reopen-margins', {}, { email: 'old.admin@dscpipes.com' });
            expect(res.status).toBe(200);
        });

        test('someone with no permissions recorded may only add revision asks', async () => {
            const h = makeHarness(storeWith(waitingQuote()), { users: USERS });
            expect((await post(h, '/quotations/q1/revision-request', { text: 'redo' }, { email: 'staff@dscpipes.com' })).status).toBe(200);
            expect((await post(h, '/quotations/q1/revision-request', { kind: 'note', text: 'fyi' }, { email: 'staff@dscpipes.com' })).status).toBe(403);
            expect((await post(h, '/quotations/q1/regret', {}, { email: 'staff@dscpipes.com' })).status).toBe(403);
            expect(stored(h).adminStatus).toBe('awaiting');
        });

        test('someone not on the list at all (shared-password sign-in) gets the staff default', async () => {
            const h = makeHarness(storeWith(waitingQuote()), { users: USERS });
            expect((await post(h, '/quotations/q1/apply-admin-margins', { adminMargins: MARGINS }, { email: 'stranger@dscpipes.com', kind: 'shared' })).status).toBe(403);
            expect((await post(h, '/quotations/q1/revision-request', { text: 'redo' }, { email: 'stranger@dscpipes.com', kind: 'shared' })).status).toBe(200);
            expect(stored(h).revisionRequests[0].addedBy).toBe('Shared login');
        });

        test('until someone holds Manage people the lists are off: everyone may do everything', async () => {
            const noManager = [{ email: 'staff@dscpipes.com' }, { email: 'other@dscpipes.com', permissions: ['addNotes'] }];
            const h = makeHarness(storeWith(waitingQuote()), { users: noManager });
            const res = await post(h, '/quotations/q1/regret', { emailSent: true }, { email: 'staff@dscpipes.com' });
            expect(res.status).toBe(200);
            expect(stored(h).adminStatus).toBe('regretted');
        });
    });
});

// ── save-quotation: the admin fields are the server's ─────────────────────────

describe('POST /save-quotation — server-owned admin fields', () => {
    test('a brand-new quote cannot arrive allocated, noted or signed — adminStatus forced to awaiting', async () => {
        const h = makeHarness({});
        const res = await post(h, '/save-quotation', { quotation: {
            id: 'new1', quoteNumber: 'DSC-3002', lineItems: [clone(ERW)], tableHTML: '<table></table>',
            adminStatus: 'ready', adminNote: '<b>approved by owner</b>', adminNoteBy: 'Owner', adminMargins: { erw: { pct: 1 } },
            allocatedBy: 'Owner', allocatedAt: '2026-10-01', allocatedTableFp: 'abcdef0123456789',
            extraNotes: [{ id: 'x', text: 'forged', addedBy: 'Owner' }],
            revisionRequests: [{ id: 'r', text: 'forged', addedBy: 'Owner', done: false }],
            deletedNotes: [{ text: 'x' }], regrettedBy: 'Owner', deleted: true, deletedBy: 'Owner',
            adminReopenedBy: 'Owner', _adminMarginsDraft: { erw: { pct: 9 } },
        } }, { perms: ['addRevisions'] });
        expect(res.status).toBe(200);
        const p = stored(h, 'new1');
        expect(p.adminStatus).toBe('awaiting');
        expect(p.adminNote).toBe('');
        ['adminNoteBy', 'adminMargins', 'allocatedBy', 'allocatedAt', 'allocatedTableFp', 'extraNotes', 'revisionRequests',
            'deletedNotes', 'regrettedBy', 'deleted', 'deletedBy', 'adminReopenedBy', '_adminMarginsDraft'].forEach((f) => {
            expect(p[f]).toBeUndefined();
        });
        expect(p.lineItems).toHaveLength(1);   // the quote itself is saved
    });

    test('an existing quote keeps its stored adminStatus / adminNote / adminMargins / asks, whatever the browser sends', async () => {
        const h = await allocatedHarness({ adminNote: 'quote at list', revisionRequests: [{ id: 'r1', text: 'make it 2%', done: false }] });
        const fpBefore = stored(h).allocatedTableFp;
        const marginsBefore = clone(stored(h).adminMargins);
        const res = await post(h, '/save-quotation', { quotation: Object.assign(clone(stored(h)), {
            adminStatus: 'awaiting', adminNote: 'changed in a stale tab', adminMargins: { erw: { pct: 0 } },
            allocatedTableFp: 'forged', revisionRequests: [], _adminMarginsDraft: { erw: { pct: 7 } },
        }) }, { perms: ['addRevisions'] });
        expect(res.status).toBe(200);
        const p = stored(h);
        expect(p.adminStatus).toBe('ready');
        expect(p.adminNote).toBe('quote at list');
        expect(p.adminMargins).toEqual(marginsBefore);
        expect(p.allocatedTableFp).toBe(fpBefore);
        expect(p.revisionRequests).toHaveLength(1);
        expect(p._adminMarginsDraft).toBeUndefined();
    });

    test('a server-owned field the stored quote does not have is dropped, not taken from the browser', async () => {
        const h = makeHarness(storeWith(waitingQuote()));
        const res = await post(h, '/save-quotation', { quotation: Object.assign(waitingQuote(), {
            allocatedBy: 'Mallory', regrettedBy: 'Mallory', deletedNotes: [{ text: 'planted' }],
        }) });
        expect(res.status).toBe(200);
        expect(stored(h).allocatedBy).toBeUndefined();
        expect(stored(h).regrettedBy).toBeUndefined();
        expect(stored(h).deletedNotes).toBeUndefined();
    });

    test('a failed read of the stored quote → 503 and nothing is written', async () => {
        const h = makeHarness(storeWith(waitingQuote({ adminStatus: 'ready', adminNote: 'keep' })));
        h.state.failGet = true;
        const res = await post(h, '/save-quotation', { quotation: Object.assign(waitingQuote(), { adminStatus: 'awaiting', adminNote: '' }) });
        expect(res.status).toBe(503);
        expect(h.writes).toHaveLength(0);
        expect(stored(h).adminStatus).toBe('ready');
        expect(stored(h).adminNote).toBe('keep');
    });
});

// ── the public read ──────────────────────────────────────────────────────────

describe('GET /quotations/:id', () => {
    test('never returns deletedNotes (the record still keeps them)', async () => {
        const h = makeHarness(storeWith(waitingQuote({ deletedNotes: [{ kind: 'admin', text: 'private words', deletedBy: 'Asha' }] })));
        const res = await request(h.app).get('/api/quotations/q1');
        expect(res.status).toBe(200);
        expect(res.body.quotation.id).toBe('q1');
        expect(res.body.quotation).not.toHaveProperty('deletedNotes');
        expect(JSON.stringify(res.body)).not.toContain('private words');
        expect(stored(h).deletedNotes).toHaveLength(1);
    });
});
