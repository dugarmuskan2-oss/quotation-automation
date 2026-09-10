'use strict';

/**
 * tools/phone-book-save.js — put the readings of his phone book somewhere they cannot be lost.
 *
 * The 1,912 pages of his address book were read once, by AI, at real cost, and until now they
 * existed only in a scratch folder on this machine. Bombay Hardware needed them twice: to find
 * out that "HYD FACTORY" was a heading rather than a note, and to build cards for the 29 firms
 * it named that had none. Neither could have been answered from the cards, because a card is
 * what the pages were turned INTO.
 *
 * This copies them into the same store as everything else, under phone-book.json:
 *
 *     { builtAt, pages: [{ title, body }], firms: [{ key, page, firm }] }
 *
 *   node tools/phone-book-save.js <folder> [<folder>…]      # say what it would save
 *   node tools/phone-book-save.js <folder> [<folder>…] --go # save it
 *
 * Each folder holds .json files of read pages. A page is { title, notes|text|body } and may
 * carry `firms`, which is what the reading pulled out of it.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const storage = require('../storage');
const contacts = require('../utils/contacts');
const { CONFIG_KEY_PHONE_BOOK } = require('../utils/constants');

const GO = process.argv.includes('--go');
const DIRS = process.argv.slice(2).filter(a => a.indexOf('--') !== 0);

const str = (v) => String(v == null ? '' : v).trim();
function say(line) { process.stdout.write(line + '\n'); }

/** Every page in a folder of readings, however that reading wrapped them. */
function pagesIn(dir) {
    if (!fs.existsSync(dir)) { say('   no such folder: ' + dir); return []; }
    const out = [];
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach((f) => {
        let blob;
        try { blob = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch (e) { say('   unreadable, skipped: ' + f); return; }
        const list = Array.isArray(blob) ? blob : (blob.items || blob.pages || blob.results || []);
        list.forEach((p) => {
            const title = str(p && (p.title || p.heading));
            const body = str(p && (p.notes || p.text || p.body));
            if (!title && !body) return;
            out.push({ title, body, firms: Array.isArray(p.firms) ? p.firms : [] });
        });
    });
    return out;
}

/**
 * The richest reading of each firm, and the page it came off.
 *
 * One firm appears on many pages — once on its own, and in passing on every page that names
 * it. The one with the most on it is its own page, and that is the one worth keeping.
 */
function firmIndex(pages) {
    const best = new Map();
    pages.forEach((page) => {
        (page.firms || []).forEach((firm) => {
            const key = contacts.firmNameKey(firm && firm.company);
            if (!key) return;
            const score = (firm.people || []).reduce((a, p) => a + (p.phones || []).length + (p.emails || []).length, 0)
                + (firm.phones || []).length + (firm.emails || []).length
                + (firm.address ? 2 : 0) + (firm.city ? 1 : 0);
            const had = best.get(key);
            if (!had || score > had.score) best.set(key, { key, page: page.title, score, firm });
        });
    });
    return [...best.values()];
}

/** One page read twice by two passes is one page. */
function dropRepeats(pages) {
    const seen = new Set();
    return pages.filter((p) => {
        const k = p.title + '||' + p.body.length + '||' + (p.firms || []).length;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

async function main() {
    if (!DIRS.length) {
        say('Name the folders holding the readings:');
        say('   node tools/phone-book-save.js ./readings ./readings-2 --go');
        process.exitCode = 1;
        return;
    }
    let pages = [];
    DIRS.forEach((dir) => {
        const got = pagesIn(dir);
        say('   ' + got.length + ' pages from ' + dir);
        pages = pages.concat(got);
    });
    pages = dropRepeats(pages);
    const firms = firmIndex(pages);
    const withText = pages.filter(p => p.body).length;

    say('');
    say('   ' + pages.length + ' pages, ' + withText + ' of them with text');
    say('   ' + firms.length + ' firms the readings found');
    say('   ' + (JSON.stringify({ pages, firms }).length / 1048576).toFixed(2) + ' MB');

    const already = await storage.readText(CONFIG_KEY_PHONE_BOOK);
    if (already) {
        const old = JSON.parse(already);
        say('   already stored: ' + ((old.pages || []).length) + ' pages, built ' + (old.builtAt || '?'));
        // Never trade a bigger reading for a smaller one by accident.
        if ((old.pages || []).length > pages.length) {
            say('');
            say('   REFUSED: what is stored has MORE pages than this. Saving would lose '
                + ((old.pages || []).length - pages.length) + ' of them.');
            process.exitCode = 1;
            return;
        }
    }
    if (!GO) { say('\n   DRY RUN — nothing saved. Add --go to write.'); return; }
    await storage.saveText(CONFIG_KEY_PHONE_BOOK, JSON.stringify({
        builtAt: new Date().toISOString(), pages, firms,
    }));
    say('\n   saved to ' + CONFIG_KEY_PHONE_BOOK + '.');
}

main().catch((e) => { say('FAILED: ' + e.message); process.exitCode = 1; });
