'use strict';

/**
 * tools/notes-into-cards.js — turn what was read out of the notes boxes into cards.
 *
 * 962 of the owner's contacts had something typed into the notes box, and until now the app
 * copied that text onto the card word for word and never read it. One box held this:
 *
 *     sampath (9003081202  /  7708106940 )
 *     godown number : 044 - 25741916
 *     bill preparing person  (ARUMUGAM ) :9840586003
 *     RISHABH MEHTA ---- 9500000177 (CHETNA STEEL)
 *
 * Four people and a second firm, sitting in a remarks field where nothing could search it,
 * rank it, or send it an enquiry. That reading has now been done. This puts the result where
 * the app can use it: people become people, the godown line becomes a labelled firm number,
 * and CHETNA STEEL gets its own card with a note saying who named it.
 *
 *   node tools/notes-into-cards.js               # say what it would do, change nothing
 *   node tools/notes-into-cards.js --only 25     # the same, for the first 25 firms
 *   node tools/notes-into-cards.js --only 25 --go   # actually write those 25
 *   node tools/notes-into-cards.js --go          # write all of them
 *
 * It writes ONE file — the same waiting list the Add tab already reads — so these firms
 * arrive through the button that is already there, twenty-five at a time. NOTHING is added
 * to the directory: every firm still has to be approved one at a time, which is the rule the
 * whole directory is built on.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const storage = require('../storage');
const contacts = require('../utils/contacts');
const { CONFIG_KEY_GOOGLE_FIRMS } = require('../utils/constants');

const GO = process.argv.includes('--go');
const ONLY = (() => {
    const at = process.argv.indexOf('--only');
    return at === -1 ? 0 : Math.max(0, parseInt(process.argv[at + 1], 10) || 0);
})();
const READ_DIR = (() => {
    const at = process.argv.indexOf('--from');
    return at === -1 ? path.join(__dirname, '..', '.notes-read') : process.argv[at + 1];
})();

const str = (v) => String(v == null ? '' : v).trim();
const today = () => new Date().toISOString().slice(0, 10);
function say(line) { process.stdout.write(line + '\n'); }

/**
 * Every contact the reading produced, each one only once.
 *
 * The reading ran in batches and a batch that looked wrong was read again, so the same
 * contact can appear in two files. The first copy wins — a later file is a rewrite of an
 * earlier one, not new information.
 */
function readAll(dir) {
    const seen = new Set();
    const out = [];
    const bad = [];
    fs.readdirSync(dir).filter(f => /\.json$/.test(f)).sort().forEach(f => {
        let rows;
        try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch (e) { bad.push(f + ': ' + e.message); return; }
        (Array.isArray(rows) ? rows : []).forEach(c => {
            if (!c || !c.id || seen.has(c.id)) return;
            seen.add(c.id);
            out.push(c);
        });
    });
    return { contacts: out, bad };
}

// ── one firm, in the shape the app's cards use ───────────────────────────────

/** Emails came back as plain strings in some batches and {label,v} in others. */
function asLines(list, label) {
    return (Array.isArray(list) ? list : []).map(x => (x && typeof x === 'object')
        ? { label: str(x.label) || label, v: str(x.v) }
        : { label, v: str(x) }).filter(x => x.v);
}

function peopleOf(firm) {
    const people = (firm.people || []).map((p, i) => ({
        name: str(p.name),
        role: str(p.role) || (i === 0 ? 'Main contact' : ''),
        phones: asLines(p.phones, 'Mobile'),
        emails: asLines(p.emails, 'Work'),
    }));
    // A number nobody was named for belongs to the FIRM — the godown line, the board line.
    // It keeps whatever the owner called it, because "Godown" is the useful part.
    const firmLines = asLines(firm.phones, 'Office');
    const firmMails = asLines(firm.emails, 'Work');
    if (firmLines.length || firmMails.length) {
        people.push({
            name: '',
            role: people.length ? 'Office' : 'Main contact',
            phones: firmLines,
            emails: firmMails,
        });
    }
    return people.length ? people : [{ name: '', role: 'Main contact', phones: [], emails: [] }];
}

function previewOf(firm, sourceTitle) {
    const d = today();
    const notes = (firm.notes || []).map(t => ({ t: str(t), d })).filter(n => n.t);
    notes.push({ t: 'From your phone book, under "' + str(sourceTitle) + '"', d });
    return {
        role: '',                                  // his to choose, never guessed
        roleOther: '',
        company: str(firm.company),
        city: str(firm.city),
        address: str(firm.address),
        people: peopleOf(firm),
        branches: (firm.branches || []).map(b => (b && typeof b === 'object')
            ? { city: str(b.city), address: str(b.address) }
            : { city: str(b), address: '' }).filter(b => b.city || b.address),
        types: [],
        products: (firm.products || []).map(p => (p && typeof p === 'object')
            ? { p: str(p.p), spec: str(p.spec) }
            : { p: str(p), spec: '' }).filter(p => p.p),
        rules: [],
        routes: [],
        images: [],
        moq: 0,
        partLoad: null,
        notes,
        fromGoogle: true,
    };
}

// ── the same firm named in several contacts is ONE card ──────────────────────

/**
 * Fold every mention of a firm into one card.
 *
 * A mill named in six different phone-book pages is one mill. Matching is on the identities
 * the app already uses to decide "same firm" — the email domain, the tidied name, any shared
 * phone — so this agrees with what the Add tab will do rather than inventing a second rule.
 */
function foldFirms(rows) {
    const cards = [];
    const byIdentity = new Map();

    rows.forEach(({ firm, source }) => {
        if (!str(firm.company) && !(firm.people || []).length) return;
        const preview = previewOf(firm, source);
        const keys = contacts.identitiesOf(preview);
        let hit = null;
        for (const k of keys) { if (byIdentity.has(k)) { hit = byIdentity.get(k); break; } }
        if (!hit) {
            hit = { preview, relations: [] };
            cards.push(hit);
        } else {
            hit.preview = contacts.mergePreviews(hit.preview, preview);
        }
        (firm.relations || []).forEach(r => {
            if (str(r && r.firm)) hit.relations.push({ firm: str(r.firm), how: str(r.how) });
        });
        contacts.identitiesOf(hit.preview).forEach(k => byIdentity.set(k, hit));
    });
    return cards;
}

/**
 * Write the connection onto BOTH cards.
 *
 * "Bombay Hardware uses ABC Roadlines for Chennai" is two firms and the owner needs both:
 * a transporter with no card of its own is never ranked and never sent an enquiry. So the
 * transporter's card says who it hauls for, and the mill's card says who hauls for it.
 * Whichever he opens, the connection is on the page.
 */
function linkBothWays(cards) {
    const byName = new Map();
    cards.forEach(c => {
        const n = str(c.preview.company).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (n) byName.set(n, c);
    });
    let written = 0;
    cards.forEach(c => {
        c.relations.forEach(rel => {
            const how = str(rel.how) || 'works with them';
            written += addNote(c.preview, cap(how) + ' — ' + str(rel.firm));
            const other = byName.get(str(rel.firm).toLowerCase().replace(/[^a-z0-9]/g, ''));
            // The firm named may not be in the book at all. Half a connection still beats none.
            if (other && other !== c) written += addNote(other.preview, str(c.preview.company) + ' — ' + how);
        });
    });
    return written;
}

function addNote(preview, text) {
    const t = str(text);
    if (!t) return 0;
    preview.notes = preview.notes || [];
    if (preview.notes.some(n => str(n.t) === t)) return 0;
    preview.notes.push({ t, d: today() });
    return 1;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ── into the waiting list, beside what is already there ──────────────────────

function keyFor(preview) {
    const mail = contacts.allEmails(preview)[0];
    if (mail) return contacts.firmKeyOf(mail);
    return 'n:' + str(preview.company).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Merge these cards into the waiting list, never beside it.
 *
 * The list already holds 546 cards built from the address book and the phone-book lists. A
 * firm read out of a notes box is very often one of those with more detail — the whole point
 * — so it must IMPROVE that card. Appending instead would hand the owner the very thing he
 * complained about: two cards for one firm.
 */
function mergeIntoWaiting(existing, cards) {
    const list = (existing || []).slice();
    const byIdentity = new Map();
    list.forEach((c, i) => contacts.identitiesOf(c.preview || {}).forEach(k => byIdentity.set(k, i)));

    let improved = 0, added = 0;
    cards.forEach(c => {
        let at = -1;
        for (const k of contacts.identitiesOf(c.preview)) {
            if (byIdentity.has(k)) { at = byIdentity.get(k); break; }
        }
        if (at === -1) {
            list.push({ key: keyFor(c.preview), preview: c.preview, freshened: today() });
            contacts.identitiesOf(c.preview).forEach(k => byIdentity.set(k, list.length - 1));
            added++;
            return;
        }
        // Marked, so the Add tab can put the cards that actually changed in front of him
        // instead of leaving him to find them among five hundred.
        list[at] = {
            key: list[at].key,
            freshened: today(),
            preview: contacts.mergePreviews(list[at].preview, c.preview),
        };
        contacts.identitiesOf(list[at].preview).forEach(k => byIdentity.set(k, at));
        improved++;
    });
    return { list, improved, added };
}

function show(card, n) {
    const p = card.preview;
    say('  ' + n + '. ' + (p.company || '(no name)') + (p.city ? '  ·  ' + p.city : ''));
    (p.people || []).slice(0, 4).forEach(x => say('       ' + (x.name || '(no name)')
        + (x.role ? ' (' + x.role + ')' : '')
        + '  ' + (x.phones || []).map(q => q.v).join(', ')
        + '  ' + (x.emails || []).map(q => q.v).join(', ')));
    (p.products || []).slice(0, 2).forEach(x => say('       product: ' + x.p));
    (p.branches || []).slice(0, 2).forEach(x => say('       branch:  ' + (x.city || x.address)));
    (p.notes || []).slice(0, 2).forEach(x => say('       note:    ' + x.t.slice(0, 74)));
}

async function main() {
    if (!fs.existsSync(READ_DIR)) {
        say('Nothing has been read yet — no folder at ' + READ_DIR);
        say('Point it at the reading with --from <folder>.');
        process.exitCode = 1;
        return;
    }

    const { contacts: rows, bad } = readAll(READ_DIR);
    bad.forEach(b => say('  could not read ' + b));
    say('Read ' + rows.length + ' contacts from ' + READ_DIR);

    const flat = [];
    rows.forEach(c => (c.firms || []).forEach(firm => flat.push({ firm, source: c.title })));
    say('  firms mentioned:        ' + flat.length);

    const cards = foldFirms(flat);
    say('  after folding repeats:  ' + cards.length);
    const links = linkBothWays(cards);
    say('  connections written:    ' + links);

    const batch = ONLY ? cards.slice(0, ONLY) : cards;
    if (ONLY) say('  doing the first ' + batch.length + ' only');

    const raw = await storage.readText(CONFIG_KEY_GOOGLE_FIRMS);
    let blob;
    try { blob = JSON.parse(raw || '{}'); } catch (e) { blob = {}; }
    if (!blob || typeof blob !== 'object') blob = {};
    const before = (blob.firms || []).length;

    const merged = mergeIntoWaiting(blob.firms || [], batch);
    say('');
    say('  cards waiting now:      ' + before);
    say('  of these, improved:     ' + merged.improved);
    say('  brand new firms added:  ' + merged.added);
    say('  cards waiting after:    ' + merged.list.length);

    say('');
    say('The first few, as they would look:');
    batch.slice(0, 5).forEach((c, i) => show(c, i + 1));

    if (!GO) {
        say('');
        say('Nothing was changed. Run it again with --go when you are happy.');
        return;
    }

    blob.firms = merged.list;
    blob.counts = Object.assign({}, blob.counts, {
        fromNotes: cards.length,
        notesRead: rows.length,
    });
    await storage.saveText(CONFIG_KEY_GOOGLE_FIRMS, JSON.stringify(blob));
    say('');
    say('Saved. Open the Partner Directory, go to Add, and press the button — 25 at a time.');
    say('Nothing has been added to your directory. Every firm still needs approving.');
}

main().catch((e) => {
    say('Failed: ' + e.message);
    process.exitCode = 1;
});
