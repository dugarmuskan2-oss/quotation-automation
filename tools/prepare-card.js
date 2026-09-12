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
function splitRelation(text, knows) {
    const parts = str(text).replace(/\s*—\s*no number given\s*$/i, '').split(' — ');
    if (parts.length < 2) return null;
    const first = parts[0].trim(), last = parts[parts.length - 1].trim();
    if (!first || !last) return null;
    const f = REL_WORD.test(first), l = REL_WORD.test(last);
    // Neither side names a relationship, but one of them names a firm he HAS. The card reads
    // it that way and this did not, so "He keeps Gandhi 007 matarial — GANDHI 007" was a
    // relation on screen and a plain note to the tool — which is how Gandhi 007 kept two lines
    // after the fold. Both must read a note the same way or they will disagree for ever.
    if (!f && !l && knows) {
        if (knows(last) && !knows(first)) return { firm: last, how: parts.slice(0, -1).join(' — ').trim() };
        if (knows(first) && !knows(last)) return { firm: first, how: parts.slice(1).join(' — ').trim() };
    }
    if (f && !l) return { firm: last, how: parts.slice(0, -1).join(' — ').trim() };
    if (l && !f) return { firm: first, how: parts.slice(1).join(' — ').trim() };
    if (f && l) {
        // Both sides carry a trade word — "Dealer" on one, "SUPPLIERS" inside the firm's own
        // name on the other. Length alone read "Dealer — Tamilnadu & Chennai — SHRI LAKSHMI
        // STEEL SUPPLIERS" as a firm called "Dealer". He writes these as "Dealer — where — WHO",
        // so with a middle part the firm is last; length only decides between two parts.
        if (parts.length > 2) return { firm: last, how: parts.slice(0, -1).join(' — ').trim() };
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
function isOwnPage(title, company, card) {
    // The surest test, and it needs no spelling at all: the card is FILED UNDER that page. ABS
    // Fuijico's only heading is "ABS FUJITSU Yuganand" — his own two spellings of one firm —
    // and matching on the name made the card's own page somebody else's, so the tool offered
    // to move its own dealings away from it.
    const filed = (card && card.categories) || [];
    if (filed.some(c => norm(c) === norm(title))) return true;
    const clean = str(title).replace(/\(.*?\)/g, ' ').replace(FILING, ' ');
    return clean.split(/[\/,]/).some(part => contacts.sameFirmName(part, company));
}

/**
 * Two names a letter or two apart are one firm spelt two ways.
 *
 * sameFirmName only matches whole words and prefixes, so "SRIVATSA" and "SREEVATSA" read as two
 * different firms and ABS Fuijico's notes were about to add both beside the two Sreevatsa cards
 * he already has. One missing letter is not a new company.
 *
 * Deliberately tight: six letters or more, and at most two letters different. "JPI" and "API"
 * are three letters apart in meaning and one in spelling, which is exactly why short names are
 * left out of this.
 */
function nearlyTheSameName(a, b) {
    const x = norm(contacts.firmNameKey(a)), y = norm(contacts.firmNameKey(b));
    if (x.length < 6 || y.length < 6) return false;
    if (Math.abs(x.length - y.length) > 2) return false;
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const row = [i];
        for (let j = 1; j <= y.length; j++) {
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        }
        prev = row;
    }
    return prev[y.length] <= 2;
}

/**
 * The first OTHER firm this line names, if any.
 *
 * Matched against firms he actually has cards for, on their distinctive words — never the trade
 * words, because PIPE, STEEL and TUBES name half his book and would match everything.
 */
function namesAnotherFirm(text, card, world) {
    const hay = norm(text);
    const selfKey = contacts.firmNameKey(card && card.company);
    let found = '';
    (world.all || []).some((c) => {
        const key = contacts.firmNameKey(c.company);
        if (!key || key === selfKey) return false;
        const words = str(c.company).split(/[^A-Za-z0-9]+/).filter(w => w.length > 4 && !COMMON.test(w));
        if (!words.length) return false;
        if (!words.some(w => hay.indexOf(norm(w)) !== -1)) return false;
        found = str(c.company);
        return true;
    });
    return found;
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

function whosePage(text, world, card) {
    const key = norm(text).slice(0, 40);
    if (key.length < 20) return '';          // too short to be sure it is the same sentence
    const hits = (world.pages || []).filter(pg => norm(str(pg.title) + ' ' + str(pg.body)).indexOf(key) !== -1);
    if (!hits.length) return '';
    // He fills in the SAME form on many pages, so the same words appear on several of them —
    // "HOW PARTY WILL MAKE PAYMENT / 60 DAYS PDC" is on twelve. Taking the first match blamed
    // Merit Technologies for a line that is also on shree venus's own page, and the tool
    // offered to move shree venus's own payment terms away from it. If ANY of the pages
    // carrying it is this card's own, the line is this card's.
    if (card && hits.some(pg => pageFirmKey(pg.title) === contacts.firmNameKey(card.company)
        || isOwnPage(pg.title, card.company, card))) {
        return str(hits.find(pg => pageFirmKey(pg.title) === contacts.firmNameKey(card.company)
            || isOwnPage(pg.title, card.company, card)).title);
    }
    return str(hits[0].title);
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
    const held = [];                 // names questioned rather than made into cards
    const book = world.book;
    const findCard = (n) => {
        const k = contacts.firmNameKey(bareName(n));
        if (!k) return null;
        // A firm is found by ANY of the names he writes it under, not just the one on the
        // card. He answered "all same" once for SREEVATSA / SRIVATSA / Sreevatsa Tube, and
        // that answer has to hold on every card that mentions them.
        return world.all.find(c => contacts.firmNameKey(c.company) === k
            || (c.aka || []).some(x => contacts.firmNameKey(x) === k)) || null;
    };
    const reading = (n) => book.byKey.get(contacts.firmNameKey(bareName(n)));
    // Does he have a card for this name? The splitter needs it for its last resort.
    const knows = (n) => !!findCard(n);

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
        const rel = splitRelation(n.t, knows);
        return !(rel && contacts.firmNameKey(bareName(rel.firm)) === selfKey);
    });
    if (before !== card.notes.length) did.push((before - card.notes.length) + ' notes that pointed the card at itself removed');

    // 3. Money terms are price rules, not remarks.
    const rules = (card.rules || []).slice();
    let notMine = 0;
    const kept = [];
    (card.notes || []).forEach((n) => {
        const t = str(n.t);
        // A note ending "— SOME FIRM" is about that firm, whatever words are in it. Sreevatsa
        // had "Unimech has worked with them for 20 years on immediate and credit payment terms
        // — UNIMECH SYSTEM INDIA PVT LTD" lifted into Price rules because it says "credit".
        // It is Unimech's dealing, not a rule of Sreevatsa's. A rule he wrote is a plain line.
        if (t.indexOf(' — ') !== -1 || !IS_RULE.test(t)) { kept.push(n); return; }
        // A line that names ANOTHER firm is about that firm, not a rule of this one's.
        // Crescon's page says "VIMAL SPOKE TO CHRISTOPHER SIR ON (04.08.21). HE SAID VARDHAMAN
        // GIVE OPEN CREDIT UP TO 1.5 CRORE ON 90 DAYS" — the word "credit" is in it, but the
        // firm giving the credit is Vardhaman. Filing it as Crescon's terms would have the app
        // offering Crescon a crore of credit it never mentioned.
        // Left as a note, and not asked about: the answer is always "leave it", which is
        // already what happens. His rule from Apollo — never ask him to confirm what the app
        // was going to do anyway.
        if (namesAnotherFirm(t, card, world)) { kept.push(n); notMine++; return; }
        // A line that NAMES this firm came off somebody else's page. A firm's own page does not
        // say "SREEVATSA ON 12 LAKS ORDERS LAST WEEK OPEN CREDIT 30 DAYS" — Enexio's page does,
        // about buying from Sreevatsa. *His words: "these seem like something written for
        // srivatsas client".* It is the client's terms, not a rule of this firm's own.
        // Better than guessing from the name: look the sentence up in his phone book and see
        // whose page it is written on. "DOING BUSINESS 4 YEARS ON ADVANCE PAYMENT" names
        // nobody, and is on JP ENERGY's page under "HE IS PURCHASING FROM (A). SREEVATSA".
        const page = whosePage(t, world, card);
        const mine = page && (pageFirmKey(page) === selfKey || isOwnPage(page, card.company, card));
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
    }
    if (notMine) {
        did.push(notMine + ' lines about money left as notes, because they name another firm');
        card.rules = rules;
        card.notes = kept;
    }

    // 4. A note about ANOTHER firm belongs on that firm's card — which may have to be made.
    let moved = 0, stayed = 0;
    card.notes = (card.notes || []).map((n) => {
        const rel = splitRelation(n.t, knows);
        if (!rel) return n;
        const firm = bareName(rel.firm);
        let other = findCard(firm);
        if (!other) {
            const rec = reading(firm);
            // A firm with no card and nothing in his phone book is left exactly where it is.
            // *His words: "if a name doesnt have any other contact cards in google contact, let
            // it stay as is in the card -- most questions in apollo were just that".* Five of
            // Apollo's seven questions were this, and the answer to every one of them is "leave
            // it alone" — which is already what happens, so there was nothing to ask.
            if (!rec || !canBeACard(rec)) { stayed++; return n; }
            // Never make a card that is another spelling of one he already has. He has
            // "Sreevatsa Venkateswara" and "Sreevatsa Tube"; ABS Fuijico's notes say
            // "SREEVATSA" and "SRIVATSA", and creating both would have given him four cards
            // for what may be one firm. Which one it is, is his to say — so the note stays
            // where it is and nothing is invented.
            // sameFirmName answers "true" when either side is blank — nothing to disagree
            // about — so an unnamed card matched every firm on the card.
            // Compared against the cards he has AND the names already questioned on this run.
            // "SREEVATSA" was held back as a question, so "SRIVATSA" two notes later had
            // nothing to be near and a fourth Sreevatsa card went in anyway.
            const near = world.all.concat(held).find(c => str(c.company)
                && (contacts.sameFirmName(c.company, firm) || nearlyTheSameName(c.company, firm)));
            if (near) {
                stayed++;
                held.push({ company: firm });
                asks.push({ key: 'same:' + contacts.firmNameKey(firm),
                    q: 'Is "' + firm + '" the same firm as "' + str(near.company) + '"?',
                    why: 'Close enough in name that making a second card might split one firm in two, so nothing was made. Say which and the note goes to the right card.' });
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
    if (stayed) did.push(stayed + ' firms with no card anywhere left exactly as he wrote them');
    if (made.length) did.push(made.length + ' firms had no card at all — built from their own page');

    // 4a. A plain note written on somebody ELSE's page is that firm's, not this one's.
    //     *His words: "these notes also seem to be for clients".* "FROM LAST 2 YEARS THEY ARE
    //     NOT HAVING BUSINESS WITH THEM" is on the page of the firm that stopped, and reads as
    //     nonsense here because "them" is this card. The page it is written on decides.
    let sent = 0;
    card.notes = (card.notes || []).filter((n) => {
        const t = str(n.t);
        if (splitRelation(t)) return true;              // a relation is shown, not moved
        const page = whosePage(t, world, card);
        if (!page) return true;
        const pageKey = pageFirmKey(page);
        if (!pageKey || pageKey === selfKey || isOwnPage(page, card.company, card)) return true;
        const other = world.all.find(c => contacts.firmNameKey(c.company) === pageKey);
        // No card for that firm, so nowhere to move it to and nothing to ask. His rule: "if a
        // name doesnt have any other contact cards in google contact, let it stay as is in the
        // card". shree venus produced eight of these about one page.
        if (!other) { stayed++; return true; }
        if (!(other.notes || []).some(x => norm(x.t) === norm(t))) other.notes = (other.notes || []).concat([{ t, d: today() }]);
        // Never leave here until it is standing there.
        if (!(other.notes || []).some(x => norm(x.t) === norm(t))) return true;
        sent++;
        return false;
    });
    if (sent) did.push(sent + ' notes written on another firm\'s page moved onto that firm\'s card');

    // 4b. One firm, one relation line.
    //
    //     Hydraulic & Pneumatic carried the same fact FOUR ways for each of its three
    //     suppliers, because his own line was read once and then re-worded by three passes:
    //
    //       (II) He buys from saiffuddin & dehgamwala, & Taher Tube
    //       saiffuddin & dehgamwala — He buys from saiffuddin & dehgamwala
    //       SAIFFUDDIN & DEHGAMWALA — supplier — Hydraulic & Pneumatic buys from them
    //       He buys from them — SAIFFUDDIN & DEHGAMWALA
    //
    //     And the wordings disagree. "He buys from them" is the same shape as Bombay
    //     Hardware's "they purchase from them" and means the opposite — who "he" is depends on
    //     whose page it came off, which the words cannot say. The cure is not a better guess
    //     but fewer lines: the one that NAMES this firm as the buyer or seller says plainly
    //     which way round it is, so that is the one kept.
    const byFirm = new Map();
    (card.notes || []).forEach((n, i) => {
        const rel = splitRelation(n.t, knows);
        if (!rel) return;
        const k = contacts.firmNameKey(bareName(rel.firm));
        if (!k) return;
        const plain = namesItself(rel.how, card.company) ? 2 : (str(rel.how).length > 24 ? 1 : 0);
        const had = byFirm.get(k);
        if (!had || plain > had.plain) byFirm.set(k, { at: i, plain });
    });
    let folded = 0;
    card.notes = (card.notes || []).filter((n, i) => {
        const rel = splitRelation(n.t, knows);
        if (!rel) return true;
        const k = contacts.firmNameKey(bareName(rel.firm));
        if (!k) return true;
        if (byFirm.get(k).at === i) return true;
        folded++;
        return false;
    });
    if (folded) did.push(folded + ' repeated relation lines folded away — one line per firm');

    // 5. One man, several spellings.
    const wasPeople = (card.people || []).length;
    card.people = contacts.foldPeople(card.people || []);
    if (card.people.length !== wasPeople) did.push(wasPeople + ' people folded to ' + card.people.length);

    // ── what only he can answer ───────────────────────────────────────────────────────────
    // A blank head office is not a gap to be filled. *His words: "if head office isnt mentioned
    // -- no need to add -- leave it blank and no need to ask me everytime".* It was asked on
    // every card that did not name one, which is most of them, and the honest answer is that
    // his pages do not say — the same answer Jindal Saw ended on. Blank IS the record.
    // What kind of firm they are is NOT asked. *His words: "what kind of firm I can input
    // myself when reviewing".* The card already has the buttons and the review screen already
    // says so when nothing is set; a question saying the same thing is a second reminder.
    // A town the app does not know is not scored for distance, and is usually a misspelling —
    // Sreevatsa's card says "coimbatter". Repairing it is a guess; asking is not.
    // Only when it is CLOSE to a town the app knows, which is what a misspelling looks like.
    // "coimbatter" is two letters from Coimbatore and was worth asking. Tirupur and
    // Sriperumbudur are spelt perfectly and simply are not among the app's 24 towns — asking
    // whether a real town is spelt right is noise, and that gap is the app's, not his.
    if (str(card.city) && !world.towns.has(norm(card.city))) {
        const near = [...world.towns].find(t => nearlyTheSameName(t, card.city));
        if (near) {
            asks.push({ key: 'town:' + norm(card.city),
                q: 'Is the town "' + str(card.city) + '" meant to be ' + near.charAt(0) + near.slice(1).toLowerCase() + '?',
                why: 'Two letters apart, so it reads as a slip. Left exactly as written until you say.' });
        }
    }
    // A nine-digit mobile is dropped, not questioned. *His instruction: "remove all 9 digit
    // numbers".* An Indian mobile is ten digits starting 6, 7, 8 or 9, so nine of them is one
    // lost in the typing — and it cannot be completed without guessing, which Kerala Roadways
    // settled long ago. A number nobody can ring is not a contact, and leaving it makes the
    // card look fuller than it is. A 7- or 8-digit LANDLINE is complete and is left alone:
    // 25342560 is a Chennai number without its 044.
    let short = 0;
    (card.people || []).forEach((p) => {
        const keep = (p.phones || []).filter((x) => {
            const digits = str(x.v).replace(/\D/g, '');
            if (!(digits.length === 9 && /^[6-9]/.test(digits))) return true;
            short++;
            return false;
        });
        if (keep.length !== (p.phones || []).length) p.phones = keep;
    });
    if (short) did.push(short + ' mobile number' + (short === 1 ? '' : 's') + ' one digit short dropped — they cannot be rung');
    // A name that matches nothing in 1,941 pages is usually two names with the comma lost.
    (card.notes || []).forEach((n) => {
        const rel = splitRelation(n.t, knows);
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
