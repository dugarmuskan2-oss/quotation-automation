'use strict';

/**
 * tools/google-contacts-scan.js — work out which firms are worth bringing in, once.
 *
 * Reading the whole address book takes minutes: 5,507 saved contacts over six pages, then
 * nineteen more for the 18,548 addresses ever written to, then every saved quotation to see
 * who is a customer. The live site cuts a request off at sixty seconds, so this runs here,
 * on the owner's own computer, and writes the answer where the app can read it instantly.
 *
 *   node tools/google-contacts-scan.js
 *
 * It writes ONE file — the worked-out list of firms — and touches nothing else. No card, no
 * queue, no contact in Google is changed. Bringing a firm in is a separate, deliberate step
 * in the app, one batch at a time, and every firm still has to be approved by hand.
 *
 * Run it again whenever the address book has moved on; it replaces the list wholesale.
 */

require('dotenv').config();

const storage = require('../storage');
const googlePeople = require('../utils/googlePeople');
const { firmsFromPeople, sortFirmsForImport, previewFromFirm } = require('../utils/googleContacts');
const { CONFIG_KEY_GOOGLE_FIRMS } = require('../utils/constants');

const FREE = /^(gmail|yahoo|hotmail|outlook|rediffmail|live|icloud)\./;

/**
 * The firms he has QUOTED to — customers, who do not belong in a supplier directory.
 *
 * Their address is read out of the enquiry email each quotation was built from. It is a
 * partial signal on its own (it caught 20 of 254), which is why the crowded-firm rule backs
 * it up — but every one it does catch is certain, because he sent them a price.
 */
async function customerDomains() {
    let doc;
    try {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        doc = DynamoDBDocumentClient.from(new DynamoDBClient({
            region: process.env.AWS_REGION || 'ap-south-1',
        }));
    } catch (e) {
        return new Set();
    }
    if (!process.env.DYNAMODB_TABLE) return new Set();
    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');

    const out = new Set();
    let key;
    do {
        const r = await doc.send(new ScanCommand({
            TableName: process.env.DYNAMODB_TABLE, ExclusiveStartKey: key,
        }));
        (r.Items || []).forEach((it) => {
            if (it._entity !== 'QUOTATION') return;
            const q = it.payload || it.data || it;
            const found = String(q.emailContent || '')
                .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
            found.forEach((e) => {
                const d = e.toLowerCase().split('@')[1];
                if (d && !FREE.test(d) && d !== 'dscpipes.com') out.add(d);
            });
        });
        key = r.LastEvaluatedKey;
    } while (key);
    return out;
}

function say(line) { process.stdout.write(line + '\n'); }

async function main() {
    if (!googlePeople.isAvailable()) {
        say('Gmail is not set up on this computer, so Google Contacts cannot be read.');
        say('Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN in .env first.');
        process.exitCode = 1;
        return;
    }

    say('Reading your saved contacts...');
    const saved = await googlePeople.savedContacts((n) => process.stdout.write('  ' + n + '\r'));
    say('  ' + saved.length + ' contacts');

    say('Reading who you have emailed...');
    const emailed = await googlePeople.emailedDomains((n) => process.stdout.write('  ' + n + '\r'));
    say('  ' + emailed.size + ' firms you have written to');

    say('Reading your quotations, to spot customers...');
    const customers = await customerDomains();
    say('  ' + customers.size + ' customer firms');

    const { firms, phoneOnly } = firmsFromPeople(saved, emailed);
    const contacted = firms.filter((f) => f.contacted);
    const sorted = sortFirmsForImport(contacted, { customerDomains: [...customers] });

    const blob = {
        builtAt: new Date().toISOString(),
        counts: {
            contacts: saved.length,
            firms: firms.length,
            contacted: contacted.length,
            quotedTo: sorted.quotedTo.length,
            crowded: sorted.crowded.length,
            phoneOnly: phoneOnly.length,
        },
        // Only the ones to bring in are stored as cards. The held-back firms are kept as
        // NAMES so the app can say what was left out and why, without carrying anybody's
        // details around for no reason.
        firms: sorted.toImport.map((f) => ({ key: f.key, preview: previewFromFirm(f) })),
        heldBack: {
            quotedTo: sorted.quotedTo.map((f) => f.company || f.key).sort(),
            crowded: sorted.crowded.map((f) => (f.company || f.key) + ' (' + f.people.length + ')').sort(),
        },
    };

    await storage.saveText(CONFIG_KEY_GOOGLE_FIRMS, JSON.stringify(blob));

    say('');
    say('  ready to bring in:     ' + blob.firms.length + '   (' + Math.ceil(blob.firms.length / 50) + ' batches of 50)');
    say('  held back, customers:  ' + blob.counts.quotedTo);
    say('  held back, 10+ people: ' + blob.counts.crowded);
    say('  phone only, waiting:   ' + blob.counts.phoneOnly);
    say('');
    say('Saved. Open the Partner Directory, go to Add, and bring them in a batch at a time.');
    say('Nothing has been added to your directory — every firm still needs approving.');
}

main().catch((e) => {
    say('Failed: ' + e.message);
    process.exitCode = 1;
});
