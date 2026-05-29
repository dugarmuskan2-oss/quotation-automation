/**
 * tools/migrate-add-entity.mjs
 *
 * One-time migration: adds `_entity = 'QUOTATION'` to all existing quotation
 * items in DynamoDB so they appear in the entity-updatedAt-index GSI.
 *
 * Run AFTER creating the GSI in the AWS Console.
 *
 * Usage:
 *   node tools/migrate-add-entity.mjs
 *
 * Dry-run (lists items that would be updated, makes no changes):
 *   DRY_RUN=1 node tools/migrate-add-entity.mjs
 */

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { ENTITY_QUOTATION, QUOTE_COUNTER_ID, QUOTATIONS_GSI_INDEX } = require('../utils/constants');

// Load .env
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
    }
}

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const tableName = process.env.DYNAMODB_TABLE;
const region    = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const dryRun    = process.env.DRY_RUN === '1';

if (!tableName) {
    console.error('ERROR: DYNAMODB_TABLE env var is not set.');
    process.exit(1);
}

const clientConfig = { region };
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
}

const raw       = new DynamoDBClient(clientConfig);
const docClient = DynamoDBDocumentClient.from(raw);

async function migrate() {
    console.log(`Table   : ${tableName}`);
    console.log(`Region  : ${region}`);
    console.log(`Dry-run : ${dryRun ? 'YES — no writes will be made' : 'NO — items will be updated'}`);
    console.log('');

    let lastKey  = null;
    let scanned  = 0;
    let updated  = 0;
    let skipped  = 0;

    do {
        const result = await docClient.send(new ScanCommand({
            TableName:            tableName,
            ProjectionExpression: 'id, _entity, updatedAt',
            ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));

        for (const item of result.Items || []) {
            scanned++;

            // Skip the quote-number counter and any item that already has _entity set
            if (item.id === QUOTE_COUNTER_ID || item._entity) {
                skipped++;
                continue;
            }

            if (dryRun) {
                console.log(`  [dry-run] would tag id=${item.id}`);
            } else {
                await docClient.send(new UpdateCommand({
                    TableName:                 tableName,
                    Key:                       { id: item.id },
                    UpdateExpression:          'SET #ent = :ent',
                    ExpressionAttributeNames:  { '#ent': '_entity' },
                    ExpressionAttributeValues: { ':ent': ENTITY_QUOTATION },
                }));
            }
            updated++;

            if (!dryRun && updated % 25 === 0) {
                console.log(`  Tagged ${updated} items so far...`);
            }
        }

        lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    console.log('');
    console.log('─'.repeat(50));
    console.log(`Scanned : ${scanned}`);
    console.log(`Tagged  : ${updated}`);
    console.log(`Skipped : ${skipped} (already tagged or counter)`);
    if (dryRun) {
        console.log('\nDry-run complete. Re-run without DRY_RUN=1 to apply changes.');
    } else {
        console.log('\nMigration complete. All quotations now have _entity = "QUOTATION".');
        console.log(`The ${QUOTATIONS_GSI_INDEX} GSI will start serving queries immediately.`);
    }
}

migrate().catch(err => {
    console.error('\nMigration failed:', err.message || err);
    process.exit(1);
});
