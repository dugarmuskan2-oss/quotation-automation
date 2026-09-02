'use strict';

/**
 * tools/unapproved-to-queue.js — put the cards nobody approved back in the queue.
 *
 * The rule has always been that nothing enters the Partner Directory without the owner
 * saying yes. Ten cards were in there anyway, built from addresses an enquiry had been sent
 * to: the firm name read off the email address, every other box left at its default. On the
 * list they looked exactly like entries the owner had made himself.
 *
 * This moves each one into Recent changes as something to approve or discard. Nothing is
 * thrown away — the whole card travels as the queue item's preview, id and all, so approving
 * it puts back precisely what was there, history included. A card that will not fit in the
 * queue is LEFT in the directory rather than dropped.
 *
 *   node tools/unapproved-to-queue.js           # say what would happen, change nothing
 *   node tools/unapproved-to-queue.js --apply   # actually do it
 *
 * It reads and writes the same two blobs the app uses, so it works against whatever storage
 * the environment points at. Run it once; a second run finds nothing to do.
 */

require('dotenv').config();

const storage = require('../storage');
const contactsLib = require('../utils/contacts');
const {
    CONFIG_KEY_CONTACTS,
    CONFIG_KEY_CONTACTS_PENDING,
} = require('../utils/constants');

const APPLY = process.argv.includes('--apply');

function parseBlob(raw, fallback) {
    try {
        const v = JSON.parse(String(raw || ''));
        return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
        return fallback;
    }
}

async function main() {
    const [dirRaw, pendRaw] = await Promise.all([
        storage.readText(CONFIG_KEY_CONTACTS),
        storage.readText(CONFIG_KEY_CONTACTS_PENDING),
    ]);
    const dir = parseBlob(dirRaw, { contacts: [], changes: [] });
    const pend = parseBlob(pendRaw, { items: [] });
    const contacts = Array.isArray(dir.contacts) ? dir.contacts : [];
    const items = Array.isArray(pend.items) ? pend.items : [];

    console.log('directory: ' + contacts.length + ' card' + (contacts.length === 1 ? '' : 's'));
    console.log('queue:     ' + items.length + ' waiting');

    const result = contactsLib.unapprovedToPending(contacts, items);
    if (!result.moved.length && !result.noRoom) {
        console.log('\nNothing to move — every card in the directory was approved.');
        return;
    }

    console.log('\nWould move ' + result.moved.length + ' card'
        + (result.moved.length === 1 ? '' : 's') + ' back to the queue:');
    result.moved.forEach((name) => console.log('  - ' + name));
    if (result.noRoom) {
        console.log('\n' + result.noRoom + ' could not be queued (the queue is full) and are '
            + 'LEFT in the directory. Approve or discard some, then run this again.');
    }
    console.log('\ndirectory after: ' + result.contacts.length
        + '   queue after: ' + result.pending.length);

    if (!APPLY) {
        console.log('\nNothing was changed. Re-run with --apply to do it.');
        return;
    }

    // Two blobs, two writes, and the queue goes FIRST. If the second write fails the card is
    // in both places — annoying and visible. The other order loses it from both.
    await storage.saveText(CONFIG_KEY_CONTACTS_PENDING, JSON.stringify({ items: result.pending }));
    await storage.saveText(CONFIG_KEY_CONTACTS, JSON.stringify({
        contacts: result.contacts,
        changes: Array.isArray(dir.changes) ? dir.changes : [],
    }));
    console.log('\nDone. Open the Partner Directory — they are under Recent changes.');
}

main().catch((e) => {
    console.error('Failed: ' + e.message);
    process.exitCode = 1;
});
