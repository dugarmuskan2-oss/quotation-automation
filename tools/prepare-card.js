'use strict';

/**
 * tools/prepare-card.js — run everything Bombay Hardware taught over ONE card, before he sees it.
 *
 * He works one card at a time and finds the faults by eye. That is slow because he is doing the
 * mechanical work as well as the judging: folding one man's three spellings, emptying the notes
 * box into the fields things belong in, noticing that a note is really about somebody else.
 * Those are now rules, and rules do not need him.
 *
 * What is LEFT needs him, and always will: which town is the head office, whether "MOKSHI
 * MOTHILA" is one firm or two, whether a nine-digit number is a typo. So this ends by writing a
 * short list of questions onto the card — `asks` — and the review screen shows them at the top.
 * He answers three questions instead of hunting for twenty faults.
 *
 *   node tools/prepare-card.js "BOMBAY HARDWARE"          # say what it would do
 *   node tools/prepare-card.js "BOMBAY HARDWARE" --go     # do it
 *
 * ONE card. Never a sweep — rule §0! in DIRECTORY-DATA-RULES.md. It creates cards for firms
 * this one names that have none, because a note about another firm has nowhere else to go, and
 * those go to the QUEUE, never the directory.
 */

require('dotenv').config();

const storage = require('../storage');
const contacts = require('../utils/contacts');
const { CONFIG_KEY_CONTACTS, CONFIG_KEY_CONTACTS_PENDING, CONFIG_KEY_PHONE_BOOK } = require('../utils/constants');

const GO = process.argv.includes('--go');
const NAME = process.argv.slice(2).filter(a => a.indexOf('--') !== 0)[0];

const str = (v) => String(v == null ? '' : v).trim();
const today = () => new Date().toISOString().slice(0, 10);
const norm = (v) => str(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
function say(line) { process.stdout.write(line + '\n'); }

// ── reading his wording ───────────────────────────────────────────────────────────────────
// The same tests the card itself uses, so what this tool decides is what he will see.
const REL_WORD = /\b(dealers?|stockists?|distributors?|transporters?|transport|roadlines?|carriers?|cargo|coaters?|coating|galvanis\w*|testing|agents?|brokers?|suppliers?|works with|buy from|purchas\w*|pure?lasing|buys\w*|buying|bought|f(?:ro|or)m them|manufactur\w*|factory)\b/i;
const BUYS_FROM_THEM = /\b(?:purchas\w*|pure?lasing|buy|buys|buying|bought)\b[^—]{0,60}?\bf(?:ro|or)m\s*(?:them|him)/i;
/** A line about money owed or allowed is a price rule, not a remark. */
const IS_RULE = /\bcredit\b|\bpdc\b|\blc only\b|\bwork with lc\b|\badvance\b|\bpayment terms\b|\bup to [\d,]+\b|\bupto [\d,]+\b/i;

/**
 * Read exactly the way the card reads it — and it was not.
 *
 * "Dealer — Tamilnadu & Chennai — SANKARA" is three parts: the relationship, the place, and
 * the firm. Joining everything after the first made the firm "Tamilnadu & Chennai — SANKARA",
 * and the tool then asked thirty times whether that was one firm or two.
 */
function splitRelation(text) {
    const parts = str(text).replace(/\s*—\s*no number given\s*$/i, '').split(' — ');
    if (parts.length < 2) return null;
    const first = parts[0].trim(), last = parts[parts.length - 1].trim();
    if (!first || !last) return null;
    const f = REL_WORD.test(first), l = REL_WORD.test(last);
    if (f && !l) return { firm: last, how: parts.slice(0, -1).join(' — ').trim() };
    if (l && !f) return { firm: first, how: parts.slice(1).join(' — ').trim() };
    if (f && l) {
        return first.length >= last.length
            ? { firm: last, how: parts.slice(0, -1).join(' — ').trim() }
            : { firm: first, how: parts.slice(1).join(' — ').trim() };
    }
    return null;
}
/** "JAFEE ALI (98401-06593)" is a firm with his number written after it. */
const bareName = (s) => str(s).replace(/\s*\(([^)]*\d[^)]*)\)\s*$/, '');

/**
 * Does this line name the very firm whose card it is on?
 *
 * A page about a firm does not keep saying the firm's name — the page heading has already said
 * it. When a sentence names them, the sentence was written somewhere else, about dealing with
 * them. Matched on the distinctive words of the name, so "Sreevatsa Venkateswara" is found by
 * "SREEVATSA": trade words like PIPE or STEEL are too common to prove anything.
 */
const COMMON = /^(pipe|pipes|steel|steels|tube|tubes|metal|metals|trading|traders|trader|industries|industry|enterprises|enterprise|corporation|agencies|agency|engineering|engineers|systems|solutions|india|indian|and|the|of)$/i;
function namesItself(text, company) {
    const words = str(company).split(/[^A-Za-z0-9]+/).filter(w => w.length > 3 && !COMMON.test(w));
    if (!words.length) return false;
    const hay = norm(text);
    return words.some(w => hay.indexOf(norm(w)) !== -1);
}

/**
 * Which page of his phone book a sentence is written on.
 *
 * The surest test of whose fact something is — better than guessing from the wording. The note
 * may have been tidied since, spacing changed or a bracket added, so it is matched on a long
 * run of its letters; the words are his and those do not move.
 */
/**
 * A page heading turned into the firm it is about.
 *
 * He heads a firm's page with its name and a note to himself — "ARVOS ENERGY INDIA PVT LTD ALL
 * DETAILS", "SNO 20 CHETNA STEEL ( ALL DETAILS ) SNO 20", "shree venus (ALL DETAILS)". Those
 * trimmings are his filing, not part of anybody's name, and leaving them on meant a page could
 * not be matched to the card it belongs to.
 */
const FILING = /\bALL\s*D(?:E|)T(?:E|)AILS?\b|\bALL\s*DETIALS?\b|\bINFO\b|^\s*SNO\s*\d+|\bSNO\s*\d+\s*$|^\s*P\s*\(\s*\d+\s*\)|^\s*PD\s*\(\s*\d+\s*\)|^\s*TR\s*\(\s*\d+\s*\)/gi;
function pageFirmKey(title) {
    return contacts.firmNameKey(str(title).replace(/\(.*?\)/g, ' ').replace(FILING, ' '));
}

/**
 * Is this page the card's OWN page?
 *
 * He heads a page with more than one name where one firm sells two things — "SNO 12 APL
 * APOLLO/SG PREMIUM (ALL DETAILS) SNO 12" is Apollo's own page, and matching the whole heading
 * made it somebody else's, so the tool offered to move Apollo's own factory list away from it.
 */
function isOwnPage(title, company) {
    const clean = str(title).replace(/\(.*?\)/g, ' ').replace(FILING, ' ');
    return clean.split(/[\/,]/).some(part => contacts.sameFirmName(part, company));
}

/** A "firm" that is only relationship words is not a firm — "Who is Dealer?" is not a question. */
function looksLikeAFirm(name) {
    const left = str(name).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/).filter(w => w && !PLAIN.test(w)).join('');
    return left.length > 2;
}

/**
 * What a relation note says BEYOND the relationship itself.
 *
 * "SWASTIK — dealer" says nothing that the heading and the firm's own name do not already say,
 * so there is nothing to move and nothing to ask. "THEY ARE PURCHASING FROM BOMBAY H/W BY
 * GIVING PDC UPTO 15 LAC" carries a payment term, and losing that would be a real loss.
 */
const PLAIN = /^(they|he|she|we|is|are|was|were|it|this|that|the|an?|and|to|of|in|at|on|for|from|them|him|her|his|its|our|their|with|by|as|be|been|do|does|doing|regular|regularly|purchases?|purchased|purchasing|purelasing|buys?|buying|bought|takes?|taking|took|dealers?|stockists?|distributors?|transport|transporters?|suppliers?|supply|materials?|pipes?|working|works|work|main|one|sub|only|no|number|given|manufactur\w*|factory)$/i;
function relDetail(rel, card) {
    const drop = new Set();
    (str(rel.firm) + ' ' + str(card && card.company)).toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').split(' ').forEach(w => { if (w) drop.add(w); });
    return str(rel.how).toLowerCase().replace(/[^a-z0-9\/". ]+/g, ' ').split(/\s+/)
        .filter(w => w && !drop.has(w) && !PLAIN.test(w)).join(' ').trim();
}

function whosePage(text, world) {
    const key = norm(text).slice(0, 40);
    if (key.length < 20) return '';          // too short to be sure it is the same sentence
    const hit = (world.pages || []).find(pg => norm(str(pg.title) + ' ' + str(pg.body)).indexOf(key) !== -1);
    return hit ? str(hit.title) : '';
}

// ── the card the note is really about ─────────────────────────────────────────────────────
function cardFromReading(rec, name) {
    const f = (rec && rec.firm) || {};
    const people = (f.people || []).map(p => ({
        name: str(p.name), role: str(p.role), branch: '',
        phones: (p.phones || []).map(x => ({ label: str(x.label) || 'Mobile', v: str(x.v) })),
        emails: (p.emails || []).map(x => ({ label: str(x.label) || 'Work', v: str(x.v) })),
    }));
    if ((f.phones || []).length || (f.emails || []).length) {
        people.push({
            name: '', role: 'Office', branch: '',
            phones: (f.phones || []).map(x => ({ label: str(x.label) || 'Office', v: str(x.v) })),
            emails: (f.emails || []).map(x => ({ label: str(x.label) || 'Work', v: str(x.v) })),
        });
    }
    const card = contacts.sanitizePartner({
        company: str(f.company) || name, city: str(f.city), address: str(f.address),
        branches: (f.branches || []).map(b => ({ city: str(b.city || b), area: '', address: str(b.address) })),
        products: (f.products || []).map(p => ({ p: str(p.p || p), spec: str(p.spec) })),
        people, notes: (f.notes || []).map(t => ({ t: str(t.t || t), d: today() })),
        categories: rec && rec.page ? [rec.page] : [],
    });
    // Named the way HE writes it, or the link on the card he is reading finds nothing.
    card.company = name;
    return card;
}
const canBeACard = (rec) => {
    const f = (rec && rec.firm) || {};
    return (f.people || []).some(p => (p.phones || []).length || (p.emails || []).length)
        || (f.phones || []).length || (f.emails || []).length;
};

function newItem(preview) {
    return {
        id: 'pd_prep_' + Math.random().toString(36).slice(2, 10), origin: 'google',
        from: '', subject: preview.company, file: '', kind: 'photo', text: '', finds: [],
        receivedAt: new Date().toISOString(), freshened: today(), preview,
    };
}

// ── the pass itself ───────────────────────────────────────────────────────────────────────
function prepare(card, world) {
    const did = [], asks = [], made = [];
    const book = world.book;
    const findCard = (n) => {
        const k = contacts.firmNameKey(bareName(n));
        return k ? world.all.find(c => contacts.firmNameKey(c.company) === k) : null;
    };
    const reading = (n) => book.byKey.get(contacts.firmNameKey(bareName(n)));

    // 1. Every heading his provenance notes name becomes a category, then those notes go.
    const heads = {};
    (card.categories || []).forEach(c => { if (str(c)) heads[str(c)] = 1; });
    let provenance = 0;
    (card.notes || []).forEach((n) => {
        const m = str(n.t).match(/^From your phone book, under "(.+)"$/);
        if (m && str(m[1])) { heads[m[1]] = 1; provenance++; }
    });
    if (provenance) {
        card.categories = Object.keys(heads).sort();
        card.notes = (card.notes || []).filter(n => !/^From your phone book, under "/.test(str(n.t)));
        did.push(provenance + ' "from your phone book" notes became Filed under (' + card.categories.length + ' headings)');
    }

    // 2. A note pointing the card at itself says nothing.
    const selfKey = contacts.firmNameKey(card.company);
    const before = (card.notes || []).length;
    card.notes = (card.notes || []).filter((n) => {
        const rel = splitRelation(n.t);
        return !(rel && contacts.firmNameKey(bareName(rel.firm)) === selfKey);
    });
    if (before !== card.notes.length) did.push((before - card.notes.length) + ' notes that pointed the card at itself removed');

    // 3. Money terms are price rules, not remarks.
    const rules = (card.rules || []).slice();
    const kept = [];
    (card.notes || []).forEach((n) => {
        const t = str(n.t);
        // A note ending "— SOME FIRM" is about that firm, whatever words are in it. Sreevatsa
        // had "Unimech has worked with them for 20 years on immediate and credit payment terms
        // — UNIMECH SYSTEM INDIA PVT LTD" lifted into Price rules because it says "credit".
        // It is Unimech's dealing, not a rule of Sreevatsa's. A rule he wrote is a plain line.
        if (t.indexOf(' — ') !== -1 || !IS_RULE.test(t)) { kept.push(n); return; }
        // A line that NAMES this firm came off somebody else's page. A firm's own page does not
        // say "SREEVATSA ON 12 LAKS ORDERS LAST WEEK OPEN CREDIT 30 DAYS" — Enexio's page does,
        // about buying from Sreevatsa. *His words: "these seem like something written for
        // srivatsas client".* It is the client's terms, not a rule of this firm's own.
        // Better than guessing from the name: look the sentence up in his phone book and see
        // whose page it is written on. "DOING BUSINESS 4 YEARS ON ADVANCE PAYMENT" names
        // nobody, and is on JP ENERGY's page under "HE IS PURCHASING FROM (A). SREEVATSA".
        const page = whosePage(t, world);
        const mine = page && (pageFirmKey(page) === selfKey || isOwnPage(page, card.company));
        if ((page && !mine) || (!page && namesItself(t, card.company))) {
            kept.push(n);
            asks.push({ key: 'theirs:' + norm(t).slice(0, 24),
                q: 'Whose terms are these — "' + t.slice(0, 66) + (t.length > 66 ? '…' : '') + '"?',
                why: page
                    ? 'It is written on your "' + page + '" page, not on ' + str(card.company) + '\'s, so it is that firm\'s dealing with them rather than a rule of their own.'
                    : 'It names ' + str(card.company) + ' in the third person, so it was written on somebody else\'s page about dealing with them.' });
            return;
        }
        if (!rules.some(r => norm(r) === norm(t))) rules.push(t);
    });
    if (rules.length !== (card.rules || []).length) {
        did.push((rules.length - (card.rules || []).length) + ' notes about credit or payment became Price rules');
        card.rules = rules;
        card.notes = kept;
    }

    // 4. A note about ANOTHER firm belongs on that firm's card — which may have to be made.
    let moved = 0;
    card.notes = (card.notes || []).map((n) => {
        const rel = splitRelation(n.t);
        if (!rel) return n;
        const firm = bareName(rel.firm);
        let other = findCard(firm);
        if (!other) {
            const rec = reading(firm);
            if (!rec || !canBeACard(rec)) {
                // Only worth asking when something would otherwise be LOST. Apollo names two
                // dozen dealers as bare "X — dealer" lines: there is no detail to move, so
                // there is nothing to ask, and asking anyway produced forty questions with
                // Swastik in it three times.
                if (relDetail(rel, card) && looksLikeAFirm(firm)) {
                    asks.push({ key: 'who:' + contacts.firmNameKey(firm),
                        q: 'Who is "' + firm + '"?',
                        why: 'Your note says "' + str(rel.how).slice(0, 60) + '" — but nothing in your phone book has a number for them, so there is no card to move that onto. It stays here for now.' });
                }
                return n;
            }
            other = cardFromReading(rec, firm);
            made.push(other);
            world.all.push(other);
        }
        // Direction is not carried by the words: on THEIR card, this firm is the supplier.
        const theirs = BUYS_FROM_THEM.test(rel.how)
            ? card.company + ' — supplier to them'
            : card.company + ' — ' + rel.how;
        if (!(other.notes || []).some(x => norm(x.t) === norm(theirs))) {
            other.notes = (other.notes || []).concat([{ t: theirs, d: today() }]);
        }
        const words = str(rel.how);
        if (!(other.notes || []).some(x => norm(x.t).indexOf(norm(words).slice(0, 30)) !== -1)) {
            other.notes = (other.notes || []).concat([{ t: words, d: today() }]);
        }
        moved++;
        return n;                       // his wording stays here too — it shows beside the name
    });
    if (moved) did.push(moved + ' relations carried onto the other firm\'s card, the right way round');
    if (made.length) did.push(made.length + ' firms had no card at all — built from their own page');

    // 4a. A plain note written on somebody ELSE's page is that firm's, not this one's.
    //     *His words: "these notes also seem to be for clients".* "FROM LAST 2 YEARS THEY ARE
    //     NOT HAVING BUSINESS WITH THEM" is on the page of the firm that stopped, and reads as
    //     nonsense here because "them" is this card. The page it is written on decides.
    let sent = 0;
    card.notes = (card.notes || []).filter((n) => {
        const t = str(n.t);
        if (splitRelation(t)) return true;              // a relation is shown, not moved
        const page = whosePage(t, world);
        if (!page) return true;
        const pageKey = pageFirmKey(page);
        if (!pageKey || pageKey === selfKey || isOwnPage(page, card.company)) return true;
        const other = world.all.find(c => contacts.firmNameKey(c.company) === pageKey);
        if (!other) {
            asks.push({ key: 'theirs:' + norm(t).slice(0, 24),
                q: 'This is written on your "' + page + '" page — should it be on their card?',
                why: '"' + t.slice(0, 70) + (t.length > 70 ? '…' : '') + '" — but that firm has no card yet, so it stays here for now.' });
            return true;
        }
        if (!(other.notes || []).some(x => norm(x.t) === norm(t))) other.notes = (other.notes || []).concat([{ t, d: today() }]);
        // Never leave here until it is standing there.
        if (!(other.notes || []).some(x => norm(x.t) === norm(t))) return true;
        sent++;
        return false;
    });
    if (sent) did.push(sent + ' notes written on another firm\'s page moved onto that firm\'s card');

    // 5. One man, several spellings.
    const wasPeople = (card.people || []).length;
    card.people = contacts.foldPeople(card.people || []);
    if (card.people.length !== wasPeople) did.push(wasPeople + ' people folded to ' + card.people.length);

    // ── what only he can answer ───────────────────────────────────────────────────────────
    if (!str(card.city)) {
        asks.push({ key: 'headoffice', q: 'Which town is the head office?', why: 'Nothing in your pages says. Never guess it from an area code — Bombay Hardware\'s numbers are all 044 and its head office is Bangalore.' });
    }
    // "other" is what the card holds when nobody has said — it is not an answer.
    if (!str(card.role) || card.role === 'other') {
        asks.push({ key: 'role', q: 'What kind of firm is this — dealer, manufacturer, transporter?', why: 'Nothing was guessed, because it decides who gets sent a freight enquiry.' });
    }
    // A town the app does not know is not scored for distance, and is usually a misspelling —
    // Sreevatsa's card says "coimbatter". Repairing it is a guess; asking is not.
    if (str(card.city) && !world.towns.has(norm(card.city))) {
        asks.push({ key: 'town:' + norm(card.city), q: 'Is the town "' + str(card.city) + '" spelt right?', why: 'The app does not know that town, so it cannot work out the distance to a delivery. It is left exactly as written.' });
    }
    (card.people || []).forEach((p) => {
        (p.phones || []).forEach((x) => {
            const digits = str(x.v).replace(/\D/g, '');
            if (digits.length >= 6 && digits.length < 10 && !/^0\d/.test(digits)) {
                asks.push({ key: 'number:' + digits, q: 'Is "' + str(x.v) + '" right, against ' + (str(p.name) || 'the office') + '?', why: 'It is ' + digits.length + ' digits. Completing a number is a guess, so it is left exactly as written.' });
            }
        });
    });
    // A name that matches nothing in 1,941 pages is usually two names with the comma lost.
    (card.notes || []).forEach((n) => {
        const rel = splitRelation(n.t);
        if (!rel) return;
        const firm = bareName(rel.firm);
        if (findCard(firm) || reading(firm)) return;
        if (!looksLikeAFirm(firm)) return;
        if (asks.some(a => a.q.indexOf('"' + firm + '"') !== -1)) return;
        asks.push({ key: 'split:' + contacts.firmNameKey(firm), q: 'Is "' + firm + '" one firm, or two run together?', why: 'That name is nowhere in your phone book. "MOKSHI MOTHILA" turned out to be Mokshi and Motilal with the comma lost.' });
    });

    card.checked = today();
    // A question he has already answered is not asked again. He told me POLYFIT was a customer
    // and the next run asked who POLYFIT was — a tool that nags is worse than no tool.
    const settled = new Set(world.settled || []);
    // One question per thing. The same firm named on three notes is one question about that
    // firm, not three identical ones — Apollo produced forty, with Swastik in it three times.
    const asked = new Set();
    const list = asks.filter((a) => {
        const k = str(a.key);
        if (settled.has(k) || asked.has(k)) return false;
        asked.add(k);
        return true;
    });
    return { card: contacts.sanitizePartner(card), did, made, asks: list };
}

// ── running it ────────────────────────────────────────────────────────────────────────────
async function main() {
    if (!NAME) { say('Name the firm: node tools/prepare-card.js "BOMBAY HARDWARE" [--go]'); process.exitCode = 1; return; }

    const [qRaw, dRaw, bRaw] = await Promise.all([
        storage.readText(CONFIG_KEY_CONTACTS_PENDING),
        storage.readText(CONFIG_KEY_CONTACTS),
        storage.readText(CONFIG_KEY_PHONE_BOOK),
    ]);
    if (!bRaw) { say('No phone-book.json yet — run tools/phone-book-save.js first.'); process.exitCode = 1; return; }
    const items = (JSON.parse(qRaw || '{}').items) || [];
    const dir = (JSON.parse(dRaw || '{}').contacts) || [];
    const blob = JSON.parse(bRaw);
    const book = { byKey: new Map((blob.firms || []).map(f => [f.key, f])) };

    // A card he has already approved is worked on in place; one still waiting is worked on in
    // the queue. Both are the same card to him, and he should not have to know which it is.
    const key = contacts.firmNameKey(NAME);
    const item = items.find(i => contacts.firmNameKey((i.preview || {}).company) === key);
    const approved = item ? null : dir.find(p => contacts.firmNameKey(p.company) === key);
    if (!item && !approved) { say('No card called "' + NAME + '" — not in the queue and not in the directory.'); process.exitCode = 1; return; }
    if (approved) say('(this one is already in your directory — working on it there)');
    const source = item ? item.preview : approved;

    // The towns the app can measure a distance to, read out of the page itself so the two
    // never drift apart.
    const towns = new Set();
    try {
        const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'partner-directory.js'), 'utf8');
        const at = page.indexOf('var COORD = {');
        page.slice(at, page.indexOf('};', at)).replace(/'([^']+)'\s*:/g, (m, t) => { towns.add(norm(t)); return m; });
    } catch (e) { /* no towns known — then no town is questioned */ }

    const world = { book, towns, pages: blob.pages || [],
        settled: (item && item.settled) || (approved && approved.settled) || [],
        all: items.map(i => i.preview || {}).concat(dir) };
    const out = prepare(JSON.parse(JSON.stringify(source)), world);

    say(NAME);
    say('');
    if (out.did.length) { say('   done for you:'); out.did.forEach(l => say('      · ' + l)); }
    else say('   nothing mechanical left to do.');
    if (out.made.length) { say(''); say('   new cards: ' + out.made.map(c => c.company).join(', ')); }
    say('');
    if (out.asks.length) {
        say('   ' + out.asks.length + ' thing' + (out.asks.length === 1 ? '' : 's') + ' only you can answer:');
        out.asks.forEach((a, i) => { say('      ' + (i + 1) + '. ' + a.q); say('         ' + a.why); });
    } else say('   nothing to ask you.');

    if (!GO) { say(''); say('   DRY RUN — nothing saved. Add --go to write.'); return; }

    // A firm this card names, with no card of its own, always goes to the QUEUE — never
    // straight into the directory. Every firm is still approved one at a time.
    out.made.forEach((c) => {
        if (items.some(i => contacts.firmNameKey((i.preview || {}).company) === contacts.firmNameKey(c.company))) return;
        items.push(newItem(c));
    });
    if (item) {
        item.preview = out.card;
        item.asks = out.asks;
        item.freshened = today();
    }
    await storage.saveText(CONFIG_KEY_CONTACTS_PENDING, JSON.stringify({ items }));
    if (approved) {
        const blob = JSON.parse(dRaw || '{}');
        const at = (blob.contacts || []).findIndex(p => p.id === approved.id);
        blob.contacts[at] = out.card;
        await storage.saveText(CONFIG_KEY_CONTACTS, JSON.stringify(blob));
        say('');
        say('   saved onto the directory card. queue is ' + items.length + ' cards.');
        if (out.asks.length) say('   (its questions are listed above — an approved card has no place to show them)');
        return;
    }
    say('');
    say('   saved. queue is ' + items.length + ' cards.');
}

main().catch((e) => { say('FAILED: ' + e.message); process.exitCode = 1; });
