'use strict';

/**
 * utils/onceClaim.js — "only the first caller wins" for a named slot, e.g. one day's reminder email.
 *
 * With the database: a tiny marker row written with attribute_not_exists, the same pattern as the
 * Gmail import's reserveGmailMessageId — two runs at the same instant cannot both win.
 * Without a database (a copy running on a computer): a marker file, which is good enough there.
 *
 * `release` gives the slot back, so a run that failed after claiming can be retried.
 */

const { ENTITY_ONCE_CLAIM, ONCE_CLAIM_PREFIX } = require('./constants');

function createOnceClaim({ getDb, storage }) {
    async function claim(name) {
        const { client, table } = getDb() || {};
        if (!client || !table) return claimInStorage(name);
        const { PutCommand } = require('@aws-sdk/lib-dynamodb');
        try {
            await client.send(new PutCommand({
                TableName: table,
                Item: { id: ONCE_CLAIM_PREFIX + name, _entity: ENTITY_ONCE_CLAIM, createdAt: new Date().toISOString() },
                ConditionExpression: 'attribute_not_exists(id)',
            }));
            return true;
        } catch (err) {
            if (err && err.name === 'ConditionalCheckFailedException') return false;
            throw err;                       // can't tell → don't send; the caller reports the failure
        }
    }

    async function release(name) {
        const { client, table } = getDb() || {};
        if (!client || !table) return storage.saveText('once-claim-' + name + '.json', '');
        const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
        await client.send(new DeleteCommand({ TableName: table, Key: { id: ONCE_CLAIM_PREFIX + name } }));
    }

    async function claimInStorage(name) {
        const k = 'once-claim-' + name + '.json';
        if (await storage.readText(k)) return false;
        await storage.saveText(k, JSON.stringify({ createdAt: new Date().toISOString() }));
        return true;
    }

    return { claim, release };
}

module.exports = { createOnceClaim };
