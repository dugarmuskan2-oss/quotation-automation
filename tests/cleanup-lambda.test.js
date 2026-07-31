/**
 * @jest-environment node
 *
 * tests/cleanup-lambda.test.js
 *
 * lambda/cleanupOldQuotations.js — the scheduled permanent purge. Two independent
 * rules decide whether a stored quotation is destroyed for good:
 *   • age      — updatedAt (falling back to createdAt) older than 1 year
 *   • soft-delete — deleted === true and deletedAt older than the 7-day recovery
 *     window the margin desk gives you to undo an accidental delete
 *
 * Because this deletes customer data irreversibly, the FALSE cases matter as much
 * as the true ones: a quote 6 days into its recovery window, a `deleted` flag with
 * no/unparseable timestamp, and an unparseable date must all survive. Those are
 * pinned here alongside deleteExpiredItems, which is driven with a fake
 * ddbDocClient so we can assert exactly which ids were destroyed.
 *
 * The predicates aren't part of the lambda's public surface, so they're reached
 * through the `_test` export (same house pattern as server.js `_test`). Both AWS
 * SDK modules are mocked: lib-dynamodb to tiny tagged command wrappers the fake
 * send() dispatches on, client-dynamodb so we can prove that merely requiring the
 * module never constructs a DynamoDB client.
 */

'use strict';

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn(function (config) { this.config = config; }),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
    const tag = (t) => class { constructor(input) { this.input = input; this.__type = t; } };
    return {
        DynamoDBDocumentClient: { from: jest.fn() },
        GetCommand: tag('Get'), PutCommand: tag('Put'),
        UpdateCommand: tag('Update'), QueryCommand: tag('Query'), ScanCommand: tag('Scan'),
        DeleteCommand: tag('Delete'),
    };
});

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// The lambda reads DYNAMODB_TABLE once at module load, so set it before requiring.
process.env.DYNAMODB_TABLE = 'T';
const cleanupModule = require('../lambda/cleanupOldQuotations');
const {
    isQuotationExpired,
    isSoftDeleteExpired,
    getExpiryCutoffTimestamp,
    deleteExpiredItems,
    ONE_YEAR_MS,
    SOFT_DELETE_RETENTION_MS,
} = cleanupModule._test;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - (n * DAY_MS)).toISOString();

// Records every DeleteCommand it is sent, so a test can read back the exact ids purged.
function makeFakeDdb() {
    const deletedKeys = [];
    return {
        deletedKeys,
        send: jest.fn(async (cmd) => {
            if (cmd.__type !== 'Delete') throw new Error('unexpected command: ' + cmd.__type);
            deletedKeys.push(cmd.input);
            return {};
        }),
    };
}

describe('module load is side-effect free', () => {
    test('requiring the lambda opens no DynamoDB connection', () => {
        expect(DynamoDBClient).not.toHaveBeenCalled();
        expect(DynamoDBDocumentClient.from).not.toHaveBeenCalled();
    });

    test('the test-only export sits alongside the real handler (not clobbering it)', () => {
        expect(typeof cleanupModule.handler).toBe('function');
        expect(typeof cleanupModule._test).toBe('object');
    });
});

describe('retention constants', () => {
    test('SOFT_DELETE_RETENTION_MS is exactly 7 days — the accidental-delete recovery window', () => {
        expect(SOFT_DELETE_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
        expect(SOFT_DELETE_RETENTION_MS).toBe(604800000);
    });

    test('ONE_YEAR_MS is exactly 365 days', () => {
        expect(ONE_YEAR_MS).toBe(365 * 24 * 60 * 60 * 1000);
        expect(ONE_YEAR_MS).toBe(31536000000);
    });

    test('getExpiryCutoffTimestamp is now minus one year', () => {
        const before = Date.now();
        const cutoff = getExpiryCutoffTimestamp();
        const after = Date.now();
        expect(cutoff).toBeGreaterThanOrEqual(before - ONE_YEAR_MS);
        expect(cutoff).toBeLessThanOrEqual(after - ONE_YEAR_MS);
    });
});

describe('isSoftDeleteExpired — purge only after the 7-day recovery window', () => {
    test('deleted 8 days ago -> purge', () => {
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: daysAgo(8) })).toBe(true);
    });

    test('deleted 30 days ago -> purge', () => {
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: daysAgo(30) })).toBe(true);
    });

    test('deleted 6 days ago -> KEEP, still inside the recovery window', () => {
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: daysAgo(6) })).toBe(false);
    });

    test('deleted moments ago -> keep', () => {
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: new Date().toISOString() })).toBe(false);
    });

    test('no deleted flag -> keep', () => {
        expect(isSoftDeleteExpired({ deletedAt: daysAgo(99) })).toBe(false);
    });

    test('deleted === false -> keep, even with an ancient deletedAt', () => {
        expect(isSoftDeleteExpired({ deleted: false, deletedAt: daysAgo(99) })).toBe(false);
    });

    test('a truthy-but-not-true flag (string "true") -> keep; the check is strict ===', () => {
        expect(isSoftDeleteExpired({ deleted: 'true', deletedAt: daysAgo(99) })).toBe(false);
    });

    test('deleted=true with NO deletedAt -> keep; a flag without a timestamp is never silently purged', () => {
        expect(isSoftDeleteExpired({ deleted: true })).toBe(false);
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: '' })).toBe(false);
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: null })).toBe(false);
    });

    test('deleted=true with an unparseable deletedAt -> keep', () => {
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: 'yesterday-ish' })).toBe(false);
        expect(isSoftDeleteExpired({ deleted: true, deletedAt: 'not a date' })).toBe(false);
    });

    test('null / undefined quotation -> keep (no throw)', () => {
        expect(isSoftDeleteExpired(null)).toBe(false);
        expect(isSoftDeleteExpired(undefined)).toBe(false);
    });
});

describe('isQuotationExpired — purge quotations older than a year', () => {
    test('updatedAt 400 days ago -> purge', () => {
        expect(isQuotationExpired({ updatedAt: daysAgo(400) })).toBe(true);
    });

    test('updatedAt 366 days ago -> purge (just past the line)', () => {
        expect(isQuotationExpired({ updatedAt: daysAgo(366) })).toBe(true);
    });

    test('updatedAt 364 days ago -> keep (just inside the line)', () => {
        expect(isQuotationExpired({ updatedAt: daysAgo(364) })).toBe(false);
    });

    test('a recent quote is kept', () => {
        expect(isQuotationExpired({ updatedAt: daysAgo(30) })).toBe(false);
    });

    test('falls back to createdAt when updatedAt is absent', () => {
        expect(isQuotationExpired({ createdAt: daysAgo(400) })).toBe(true);
        expect(isQuotationExpired({ createdAt: daysAgo(10) })).toBe(false);
    });

    test('updatedAt wins over createdAt: an old quote recently touched is kept', () => {
        expect(isQuotationExpired({ updatedAt: daysAgo(5), createdAt: daysAgo(900) })).toBe(false);
    });

    test('updatedAt wins over createdAt: a stale quote is purged even if created recently', () => {
        expect(isQuotationExpired({ updatedAt: daysAgo(900), createdAt: daysAgo(5) })).toBe(true);
    });

    test('no dates at all -> keep', () => {
        expect(isQuotationExpired({})).toBe(false);
        expect(isQuotationExpired({ quoteNumber: 'DSC-108' })).toBe(false);
    });

    test('unparseable dates -> keep', () => {
        expect(isQuotationExpired({ updatedAt: 'sometime last year' })).toBe(false);
        expect(isQuotationExpired({ createdAt: 'garbage' })).toBe(false);
    });

    test('null / undefined quotation -> keep (no throw)', () => {
        expect(isQuotationExpired(null)).toBe(false);
        expect(isQuotationExpired(undefined)).toBe(false);
    });
});

describe('the two rules are independent', () => {
    test('a RECENT quote soft-deleted long ago is purged by the soft-delete rule alone', () => {
        const q = { updatedAt: daysAgo(2), createdAt: daysAgo(3), deleted: true, deletedAt: daysAgo(20) };
        expect(isQuotationExpired(q)).toBe(false);      // not old
        expect(isSoftDeleteExpired(q)).toBe(true);      // but past the recovery window
    });

    test('an OLD quote that was never deleted is purged by the age rule alone', () => {
        const q = { updatedAt: daysAgo(400) };
        expect(isSoftDeleteExpired(q)).toBe(false);     // never soft-deleted
        expect(isQuotationExpired(q)).toBe(true);       // but a year stale
    });

    test('a recent quote deleted 6 days ago survives both rules', () => {
        const q = { updatedAt: daysAgo(2), deleted: true, deletedAt: daysAgo(6) };
        expect(isQuotationExpired(q)).toBe(false);
        expect(isSoftDeleteExpired(q)).toBe(false);
    });
});

describe('deleteExpiredItems — deletes exactly the expired ids and leaves survivors alone', () => {
    // The lambda reads each DynamoDB record as `item.payload || item.data || item`,
    // but keys the DeleteCommand off the TOP-LEVEL item.id. Both shapes appear here.
    const mixedItems = () => ([
        // --- should be deleted ---
        { id: 'old-payload', payload: { quoteNumber: 'DSC-1', updatedAt: daysAgo(400) } },
        { id: 'old-data', data: { quoteNumber: 'DSC-2', createdAt: daysAgo(500) } },
        { id: 'old-flat', quoteNumber: 'DSC-3', updatedAt: daysAgo(800) },
        { id: 'trashed-payload', payload: { quoteNumber: 'DSC-4', updatedAt: daysAgo(1), deleted: true, deletedAt: daysAgo(8) } },
        { id: 'trashed-flat', quoteNumber: 'DSC-5', updatedAt: daysAgo(1), deleted: true, deletedAt: daysAgo(45) },
        // --- should survive ---
        { id: 'fresh', payload: { quoteNumber: 'DSC-6', updatedAt: daysAgo(10) } },
        { id: 'recoverable', payload: { quoteNumber: 'DSC-7', updatedAt: daysAgo(6), deleted: true, deletedAt: daysAgo(6) } },
        { id: 'flag-no-timestamp', payload: { quoteNumber: 'DSC-8', updatedAt: daysAgo(3), deleted: true } },
        { id: 'undated', payload: { quoteNumber: 'DSC-9' } },
        { id: 'bad-dates', payload: { quoteNumber: 'DSC-10', updatedAt: 'whenever', deleted: true, deletedAt: 'whenever' } },
        { id: 'counter', counterValue: 142 },
    ]);

    test('purges only the five expired records', async () => {
        const ddb = makeFakeDdb();
        const count = await deleteExpiredItems(ddb, mixedItems());

        const ids = ddb.deletedKeys.map(k => k.Key.id);
        expect(ids.sort()).toEqual(['old-data', 'old-flat', 'old-payload', 'trashed-flat', 'trashed-payload']);
        expect(count).toBe(5);
        expect(ddb.send).toHaveBeenCalledTimes(5);
    });

    test('survivors are never touched — nothing inside the recovery window is deleted', async () => {
        const ddb = makeFakeDdb();
        await deleteExpiredItems(ddb, mixedItems());

        const ids = ddb.deletedKeys.map(k => k.Key.id);
        ['fresh', 'recoverable', 'flag-no-timestamp', 'undated', 'bad-dates', 'counter']
            .forEach(id => expect(ids).not.toContain(id));
    });

    test('every delete targets the configured table and a string id key', async () => {
        const ddb = makeFakeDdb();
        await deleteExpiredItems(ddb, [{ id: 12345, updatedAt: daysAgo(400) }]);
        expect(ddb.deletedKeys).toEqual([{ TableName: 'T', Key: { id: '12345' } }]);
    });

    test('an expired record with no top-level id is skipped, not deleted blind', async () => {
        const ddb = makeFakeDdb();
        const count = await deleteExpiredItems(ddb, [
            { payload: { id: 'buried', updatedAt: daysAgo(400) } },   // id only inside payload
            { id: '', updatedAt: daysAgo(400) },                      // empty id
        ]);
        expect(count).toBe(0);
        expect(ddb.send).not.toHaveBeenCalled();
    });

    test('an all-fresh list deletes nothing', async () => {
        const ddb = makeFakeDdb();
        const count = await deleteExpiredItems(ddb, [
            { id: 'a', payload: { updatedAt: daysAgo(1) } },
            { id: 'b', payload: { updatedAt: daysAgo(300) } },
            { id: 'c', payload: { deleted: true, deletedAt: daysAgo(2) } },
        ]);
        expect(count).toBe(0);
        expect(ddb.send).not.toHaveBeenCalled();
    });

    test('an empty or missing item list is tolerated', async () => {
        const ddb = makeFakeDdb();
        expect(await deleteExpiredItems(ddb, [])).toBe(0);
        expect(await deleteExpiredItems(ddb, null)).toBe(0);
        expect(await deleteExpiredItems(ddb, undefined)).toBe(0);
        expect(ddb.send).not.toHaveBeenCalled();
    });
});
