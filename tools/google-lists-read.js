'use strict';

/**
 * tools/google-lists-read.js — read the phone-book lists, one Opus call at a time.
 *
 * 167 of the owner's contacts are directories rather than people: a heading naming the
 * trade, then ten to seventy firms typed into the notes over years. One holds 67 phone
 * numbers. Altogether 3,744 numbers live inside notes, more than are in a proper phone
 * field — and none of it can be grouped, only read.
 *
 * Measured on a median list it is eight seconds and under three cents — the whole book is
 * roughly forty minutes and eight dollars. A first guess of ninety seconds and nine cents
 * came from one BIG list read at full thinking effort, and said $28 and eight hours; that
 * is the sort of number an owner reasonably refuses. Even so it is far past what a web
 * request allows, which is why this runs here and the app only reads what it leaves behind.
 *
 *   node tools/google-lists-read.js              # say what it would do, read nothing
 *   node tools/google-lists-read.js --go         # actually read them
 *   node tools/google-lists-read.js --go --only 5   # read five, to see what comes out
 *
 * It is RESUMABLE, which matters at four hours: every list is saved the moment it is read,
 * and running it again picks up where it stopped. Nothing is ever read twice.
 *
 * It writes ONE file — the same one the Add tab already reads — so the firms it finds join
 * the queue through the button that is already there. Nothing reaches the directory without
 * being approved, one firm at a time, as always.
 */

require('dotenv').config();

const storage = require('../storage');
const googlePeople = require('../utils/googlePeople');
const anthropic = require('../utils/anthropic');
const lists = require('../utils/contactLists');
const { CONFIG_KEY_GOOGLE_FIRMS } = require('../utils/constants');

const GO = process.argv.includes('--go');
const ONLY = (() => {
    const at = process.argv.indexOf('--only');
    return at === -1 ? 0 : Math.max(0, parseInt(process.argv[at + 1], 10) || 0);
})();

/** A contact is a LIST when its notes hold several firms' worth of numbers. */
const PHONES_IN_NOTES = /\b[6-9]\d{9}\b|\b\d{5}[ -]\d{5}\b|\b\d{3,4}[ -]\d{6,8}\b/g;
const IS_A_LIST = 3;

function say(line) { process.stdout.write(line + '\n'); }

function notesOf(person) {
    return (person.biographies || []).map(b => String((b && b.value) || '')).join('\n').trim();
}

function titleOf(person) {
    return String((((person.names || [])[0] || {}).displayName) || '').trim();
}

/** Its own id, so a renamed list is not read twice. */
function keyOf(person) {
    return String(person.resourceName || titleOf(person));
}

/**
 * A list about a firm already judged NOT to be a supplier is not worth reading.
 *
 * The first three read were ETA Engineering, HNGL and Saint Gobain — all three already held
 * back in the contacts scan as customers or as firms with a whole staff in the address book.
 * Reading them cost ninety seconds and nine cents each to produce cards he would discard.
 * The scan already wrote down who those are; this uses that list rather than paying to
 * learn it twice.
 */
function heldBackNames(blob) {
    const held = (blob && blob.heldBack) || {};
    const names = (held.quotedTo || []).concat(held.crowded || []);
    return new Set(names
        // "ETA ENGINEERING PVT LTD (68)" — the count comes off before comparing.
        .map(n => lists.tidyName(String(n).replace(/\s*\(\d+\)\s*$/, '')))
        .filter(Boolean));
}

/**
 * The title with its filing marks stripped, so it can be compared with a firm name.
 * "P (15) PURCHASE DEP - COATING" and "SAINT GOBAIN ALL DETAILS" are both titles; only the
 * second is a firm's name.
 */
function titleAsFirmName(title) {
    return lists.tidyName(String(title)
        .replace(/^[A-Z]{1,3}\s*\(\s*\d+\s*\)/i, '')
        .replace(/\(\s*ALL\s+DETAILS\s*\)|ALL\s+DETAILS/ig, '')
        .replace(/\s*\(\s*\d+\s*\)\s*$/, ''));
}

/** How many firms a list is likely to hold — the biggest are worth reading first. */
function sizeOf(person) {
    return (notesOf(person).match(PHONES_IN_NOTES) || []).length;
}

/**
 * What the reading will really cost, worked out from the size of the lists themselves.
 *
 * The first estimate was a flat ninety seconds and nine cents a list, taken from one BIG
 * list read at full thinking effort — and it said $28 and eight hours. Measured properly on
 * a median list it is eight seconds and under three cents, because most of these are short:
 * the median holds 605 characters, not thousands. Guessing from the worst case turned a
 * forty-minute job into one the owner would reasonably refuse, and he was right to ask.
 *
 * Opus 5 is $5 per million tokens in and $25 out. Four characters to a token is close enough
 * for a number that has to be honest rather than exact.
 */
function estimate(people) {
    const PROMPT_TOKENS = 1200;              // the instructions, sent on every call
    let inTokens = 0, outTokens = 0;
    (people || []).forEach((p) => {
        const notes = Math.ceil(notesOf(p).length / 4);
        inTokens += PROMPT_TOKENS + notes;
        // Extraction hands back roughly what it was given: the names, numbers and remarks,
        // rewritten as JSON.
        outTokens += Math.ceil(notes * 1.2) + 200;
    });
    return {
        dollars: (inTokens * 5 + outTokens * 25) / 1e6,
        minutes: Math.max(1, Math.round((people || []).length * 9 / 60)),
    };
}

function parseBlob(raw, fallback) {
    try {
        const v = JSON.parse(String(raw || ''));
        return v && typeof v === 'object' ? v : fallback;
    } catch (e) { return fallback; }
}

async function loadBlob() {
    const blob = parseBlob(await storage.readText(CONFIG_KEY_GOOGLE_FIRMS), null);
    return blob || { builtAt: '', counts: {}, firms: [], heldBack: {} };
}

/**
 * What has been read already, kept beside the firms.
 *
 * Four hours is long enough that it WILL be interrupted — a laptop lid, a lost connection,
 * a change of mind. Losing three hours of paid reading to that would be unforgivable, so
 * every list is written the moment it comes back.
 */
function progressOf(blob) {
    const p = blob.lists && typeof blob.lists === 'object' ? blob.lists : {};
    return { read: p.read || {}, found: Array.isArray(p.found) ? p.found : [], failed: p.failed || {} };
}

async function saveProgress(blob, progress) {
    blob.lists = progress;
    await storage.saveText(CONFIG_KEY_GOOGLE_FIRMS, JSON.stringify(blob));
}

/** Everything read so far, folded into one card per firm and linked both ways. */
function buildCards(found) {
    const merged = lists.mergeListFirms(found);
    const linked = lists.linkFirms(merged);
    return linked.map(firm => ({
        key: 'list:' + lists.tidyName(firm.company || (firm.people[0] || {}).name || ''),
        preview: lists.previewFromListFirm(firm, (firm.sources || []).join(' · ')),
    })).filter(c => c.preview.company || c.preview.people.length);
}

async function main() {
    if (!googlePeople.isAvailable()) {
        say('Gmail is not set up on this computer, so your contacts cannot be read.');
        process.exitCode = 1;
        return;
    }
    if (!anthropic.isAvailable()) {
        say('ANTHROPIC_API_KEY is missing from .env — the reading needs it.');
        process.exitCode = 1;
        return;
    }

    say('Looking through your contacts for the lists...');
    const all = await googlePeople.savedContacts((n) => process.stdout.write('  ' + n + '\r'));
    const candidates = all.filter((p) => {
        const notes = notesOf(p);
        return (notes.match(PHONES_IN_NOTES) || []).length >= IS_A_LIST;
    });

    const blob = await loadBlob();
    const progress = progressOf(blob);
    const held = heldBackNames(blob);

    const skipped = candidates.filter((p) => held.has(titleAsFirmName(titleOf(p))));
    const todo = candidates
        .filter((p) => !progress.read[keyOf(p)] && !held.has(titleAsFirmName(titleOf(p))))
        // Biggest first: the most firms per call, and stopping early still gets the best of it.
        .sort((a, b) => sizeOf(b) - sizeOf(a));

    say('  ' + all.length + ' contacts, ' + candidates.length + ' of them lists');
    say('  skipped, already judged customers: ' + skipped.length);
    say('  already read: ' + Object.keys(progress.read).length
        + '   still to read: ' + todo.length);
    if (todo.length) {
        say('  biggest first: ' + titleOf(todo[0]).slice(0, 50) + ' (' + sizeOf(todo[0]) + ' numbers)');
    }

    if (!todo.length) {
        say('\nNothing left to read.');
    }
    if (!GO) {
        const guess = estimate(todo);
        say('\nReading them takes about ' + guess.minutes + ' minutes and costs roughly $'
            + guess.dollars.toFixed(2) + ' in AI.');
        say('Nothing was read. Run it again with --go when you are ready.');
        return;
    }

    const batch = ONLY ? todo.slice(0, ONLY) : todo;
    say('\nReading ' + batch.length + ' list' + (batch.length === 1 ? '' : 's') + '...\n');

    let firmsSoFar = 0;
    for (let i = 0; i < batch.length; i++) {
        const person = batch[i];
        const title = titleOf(person) || '(untitled)';
        const notes = notesOf(person);
        process.stdout.write('  ' + (i + 1) + '/' + batch.length + '  ' + title.slice(0, 58) + ' ... ');
        try {
            const raw = await anthropic.readLongWithClaude({ prompt: lists.listPrompt(title, notes) });
            const out = lists.parseFirms(raw);
            if (out.failed) {
                // A list that could not be read is RECORDED, never quietly skipped: it is
                // the ones that fail that are worth going back to by hand.
                progress.failed[keyOf(person)] = title;
                say('could not be read');
            } else {
                out.firms.forEach(f => progress.found.push({ source: title, firm: f }));
                firmsSoFar += out.firms.length;
                say(out.firms.length + ' firms');
            }
            progress.read[keyOf(person)] = title;
        } catch (e) {
            // Running out of room is not the same as failing to read, and the owner can act
            // on one of them: that list is worth opening by hand.
            const why = e.ranOutOfRoom ? 'too long to read in one go'
                : String(e.message || '').slice(0, 80);
            progress.failed[keyOf(person)] = title + ' — ' + why;
            progress.read[keyOf(person)] = title;      // do not pay to fail on it twice
            say('FAILED: ' + why);
        }
        // Written every time, so stopping here loses nothing that was paid for.
        await saveProgress(blob, progress);
    }

    const cards = buildCards(progress.found);
    const already = new Set((blob.firms || []).map(f => f.key));
    const fresh = cards.filter(c => !already.has(c.key));
    blob.firms = (blob.firms || []).concat(fresh);
    blob.counts = Object.assign({}, blob.counts, {
        lists: candidates.length,
        listsRead: Object.keys(progress.read).length,
        listsFailed: Object.keys(progress.failed).length,
        firmsFromLists: cards.length,
    });
    await saveProgress(blob, progress);

    say('');
    say('  firms read this time:   ' + firmsSoFar);
    say('  firms after merging:    ' + cards.length);
    say('  added to the queue list: ' + fresh.length);
    say('  lists that failed:      ' + Object.keys(progress.failed).length);
    say('  still to read:          ' + (todo.length - batch.length));
    say('');
    say('Open the Partner Directory, go to Add, and bring them in a batch at a time.');
    say('Nothing has been added to your directory — every firm still needs approving.');
}

main().catch((e) => {
    say('Failed: ' + e.message);
    process.exitCode = 1;
});
