/*
    ============================================
    MONTHLY CLEANUP LAMBDA
    ============================================
    Deletes quotations older than 1 year from DynamoDB.
*/

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient,
    ScanCommand,
    DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const TABLE_NAME = process.env.DYNAMODB_TABLE;

function getExpiryCutoffTimestamp() {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    return Date.now() - oneYearMs;
}

function isQuotationExpired(quotation) {
    if (!quotation) return false;
    const dateText = quotation.updatedAt || quotation.createdAt;
    const timestamp = dateText ? new Date(dateText).getTime() : NaN;
    if (isNaN(timestamp)) return false;
    return timestamp < getExpiryCutoffTimestamp();
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
        const quotation = item.data || item;
        return isQuotationExpired(quotation);
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
