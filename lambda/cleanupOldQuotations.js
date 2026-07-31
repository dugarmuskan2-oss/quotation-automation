/*
    ============================================
    SCHEDULED CLEANUP LAMBDA
    ============================================
    Permanently deletes from DynamoDB:
      • quotations older than 1 year, and
      • quotations soft-deleted from the desk (deleted=true) more than 7 days ago —
        the recovery window for accidental deletes, after which they are purged so
        junk doesn't pile up.
    Schedule this to run at least daily/weekly so the 7-day purge stays timely.
*/

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient,
    ScanCommand,
    DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const TABLE_NAME = process.env.DYNAMODB_TABLE;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SOFT_DELETE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;   // recovery window for desk deletes

function getExpiryCutoffTimestamp() {
    return Date.now() - ONE_YEAR_MS;
}

function isQuotationExpired(quotation) {
    if (!quotation) return false;
    const dateText = quotation.updatedAt || quotation.createdAt;
    const timestamp = dateText ? new Date(dateText).getTime() : NaN;
    if (isNaN(timestamp)) return false;
    return timestamp < getExpiryCutoffTimestamp();
}

// A quote soft-deleted from the desk is purged once its 7-day recovery window has passed.
// Requires a valid deletedAt so a flag without a timestamp is never silently purged.
function isSoftDeleteExpired(quotation) {
    if (!quotation || quotation.deleted !== true) return false;
    const timestamp = quotation.deletedAt ? new Date(quotation.deletedAt).getTime() : NaN;
    if (isNaN(timestamp)) return false;
    return timestamp < (Date.now() - SOFT_DELETE_RETENTION_MS);
}

function getDdbClient() {
    const client = new DynamoDBClient({ region: REGION });
    return DynamoDBDocumentClient.from(client);
}

async function scanAllItems(ddbDocClient) {
    const items = [];
    let lastKey = undefined;
    do {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            ExclusiveStartKey: lastKey
        }));
        if (result.Items && result.Items.length > 0) {
            items.push(...result.Items);
        }
        lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
}

async function deleteExpiredItems(ddbDocClient, items) {
    const expiredItems = (items || []).filter(item => {
        const quotation = item.payload || item.data || item;
        return isQuotationExpired(quotation) || isSoftDeleteExpired(quotation);
    });

    let deletedCount = 0;
    for (const item of expiredItems) {
        if (!item.id) continue;
        await ddbDocClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { id: String(item.id) }
        }));
        deletedCount += 1;
    }

    return deletedCount;
}

exports.handler = async () => {
    if (!TABLE_NAME) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'DYNAMODB_TABLE not configured' })
        };
    }

    const ddbDocClient = getDdbClient();
    const items = await scanAllItems(ddbDocClient);
    const deleted = await deleteExpiredItems(ddbDocClient, items);

    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            deleted,
            scanned: items.length
        })
    };
};

// Test-only export (see tests/cleanup-lambda.test.js). Appended to the same
// module.exports object that already carries `handler`, so it doesn't clobber it.
module.exports._test = {
    isQuotationExpired,
    isSoftDeleteExpired,
    getExpiryCutoffTimestamp,
    deleteExpiredItems,
    ONE_YEAR_MS,
    SOFT_DELETE_RETENTION_MS
};
