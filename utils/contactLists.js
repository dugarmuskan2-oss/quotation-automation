'use strict';

/**
 * utils/contactLists.js — reading a Google contact that is really a directory.
 *
 * 167 of the owner's contacts are not people. They are lists, built up over years, each with
 * a heading naming what kind of firm is inside — "P (15) PURCHASE DEP - COATING & OTHER JOB
 * WORK", "PD (2) PIPE DEALERS (STAINLESS) - BOMBAY" — and then ten to seventy firms typed
 * into the notes, numbered, with people, phone numbers, addresses and remarks like "his shop
 * is in Satangadu" or "see complete details under Purchase Dep larger dia".
 *
 * Grouping cannot touch this: there is nothing to group on. It has to be READ. That is what
 * this file builds the prompt for, and why it is worth an Opus call per contact — a firm
 * filed under the wrong heading, or a phone number attached to the wrong man, is a wrong
 * enquiry sent to a real supplier.
 *
 * What comes back is proposed, never applied. Every firm found lands in Recent changes and
 * waits for the owner's yes, one at a time, like everything else in this directory.
 */

const str = (v) => String(v == null ? '' : v).trim();

/** How much of one contact to send. The biggest is 10,940 characters; none is near this. */
const MAX_TEXT = 24000;

/**
 * The instructions.
 *
 * Written against the owner's real lists, and every rule in it is here because the data
 * breaks the obvious assumption:
 *
 *  - The HEADING is the trade. It is the only place the kind of firm is written down, and
 *    without it every card would come back as "other".
 *  - A numbered entry is a FIRM, but the numbering restarts, repeats and skips. Never count.
 *  - Some entries are one man with a mobile; some are a firm with six departments and a
 *    board line. Both are firms here.
 *  - Remarks matter as much as numbers — "they are dealers for SAIL & Vizag, they do not
 *    keep Rourkela material" is exactly what the owner keeps these lists for.
 *  - Cross-references ("see complete details under Purchase Dep larger dia") must survive
 *    as notes. Following them is not possible; losing them is worse.
 */
function listPrompt(contactName, text) {
    return [
        'This is one entry from an Indian pipe trader\'s phone book. Its TITLE names the kind',
        'of firm it holds, and its notes are a list of firms he has built up over years.',
        '',
        'TITLE: ' + str(contactName),
        '',
        'NOTES:',
        str(text).slice(0, MAX_TEXT),
        '',
        'Return every FIRM in the notes as JSON. Nothing else — no explanation, no markdown.',
        '',
        '{"firms":[{',
        '  "company": "the firm\'s name, as written",',
        '  "trade": "what they do, in a few words, taken from the TITLE",',
        '  "city": "only if a town is actually named for this firm, else \\"\\"",',
        '  "people": [{"name":"", "role":"", "phones":["",""], "emails":[""]}],',
        '  "phones": ["numbers that belong to the firm, not to a named person"],',
        '  "emails": ["addresses that belong to the firm"],',
        '  "notes": ["any remark about them, copied as written"],',
        '  "relations": [{"firm":"the other firm named", "how":"what they do for them"}]',
        '}]}',
        '',
        'RULES — these matter more than tidiness:',
        '1. NEVER invent. If a field is not in the text, leave it empty. A guessed phone',
        '   number or town is worse than a blank one.',
        '2. Copy numbers digit for digit. Do not reformat, do not add or drop a country code.',
        '3. A number in brackets after a name — (OWNER), (SALES), (A/C DEPT) — is that',
        '   person\'s role. Keep it.',
        '4. Numbers with no owner named (a board line, a landline) belong to the FIRM, in',
        '   "phones", not to the first person you see.',
        '5. Remarks are the point of these lists. "They do not keep Rourkela material", "his',
        '   shop is in Satangadu", "factory at Trichy and Chennai" — put each in "notes",',
        '   word for word. Do not summarise them.',
        '6. A cross-reference like "see complete details under Purchase Dep larger dia" is a',
        '   note. Keep it as written.',
        '7. The list is numbered, but the numbers restart, repeat and skip. Use them only to',
        '   see where one firm ends and the next begins, never to count.',
        '8. An entry that is plainly a WhatsApp group, a website, or a note to self is NOT a',
        '   firm. Leave it out of "firms".',
        '9. If the whole entry is really ONE firm with several branches or departments, return',
        '   one firm and put the branches in "notes" and the people in "people".',
        '10. A firm named INSIDE another firm\'s entry is STILL A FIRM — return it separately,',
        '    with whatever name, number or person is given for it. "Maharashtra Seamless uses',
        '    ABC Roadlines for Chennai" is TWO firms: Maharashtra Seamless, and ABC Roadlines',
        '    with a relation {"firm":"Maharashtra Seamless","how":"transporter for them"}.',
        '    The same for a coater, a galvaniser, a testing lab or an agent working for them.',
        '    This matters: a firm buried in somebody else\'s notes never gets a card, and a',
        '    firm with no card is never sent an enquiry.',
        '11. Put the relation on the firm that PROVIDES the service, naming who they do it',
        '    for. Do not invent a relation where the text only mentions two firms nearby.',
    ].join('\n');
}

/**
 * What came back, made safe.
 *
 * The model is asked for JSON and normally returns it, but a stray sentence around it is
 * cheap to survive and expensive to crash on — this is the owner's whole phone book.
 */
function parseFirms(raw) {
    const text = str(raw);
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        const a = text.indexOf('{'), b = text.lastIndexOf('}');
        if (a === -1 || b <= a) return { firms: [], failed: true };
        try { data = JSON.parse(text.slice(a, b + 1)); } catch (e2) { return { firms: [], failed: true }; }
    }
    const list = (data && Array.isArray(data.firms)) ? data.firms : [];
    return { firms: list.map(cleanFirm).filter(f => f.company || f.people.length), failed: false };
}

function cleanFirm(f) {
    const src = (f && typeof f === 'object') ? f : {};
    return {
        company: str(src.company).slice(0, 200),
        trade: str(src.trade).slice(0, 80),
        city: str(src.city).slice(0, 80),
        people: (Array.isArray(src.people) ? src.people : []).slice(0, 20).map(cleanPerson),
        phones: strings(src.phones, 12),
        emails: strings(src.emails, 12).map(e => e.toLowerCase()).filter(e => e.indexOf('@') !== -1),
        notes: strings(src.notes, 12).map(n => n.slice(0, 400)),
        relations: (Array.isArray(src.relations) ? src.relations : []).slice(0, 8)
            .map(r => ({ firm: str(r && r.firm).slice(0, 200), how: str(r && r.how).slice(0, 120) }))
            .filter(r => r.firm),
    };
}

function cleanPerson(p) {
    const src = (p && typeof p === 'object') ? p : {};
    return {
        name: str(src.name).slice(0, 120),
        role: str(src.role).slice(0, 60),
        phones: strings(src.phones, 8),
        emails: strings(src.emails, 8).map(e => e.toLowerCase()).filter(e => e.indexOf('@') !== -1),
    };
}

function strings(v, cap) {
    return (Array.isArray(v) ? v : []).map(str).filter(Boolean).slice(0, cap);
}

/**
 * One firm as a card to approve.
 *
 * The trade read off the heading goes in as free text, not as a role: "coating & job work"
 * is not dealer, manufacturer, transporter or fabricator, and forcing it into one of those
 * would be putting words in his mouth. He picks the role as he approves, as agreed — so the
 * trade rides along as a note and in roleOther, where he can see what the list called them.
 */
function previewFromListFirm(firm, sourceTitle) {
    const people = firm.people.map((c, i) => ({
        name: c.name,
        role: c.role || (i === 0 ? 'Main contact' : ''),
        phones: c.phones.map(v => ({ label: 'Mobile', v })),
        emails: c.emails.map(v => ({ label: 'Work', v })),
    }));
    // Numbers and addresses nobody was named for still belong to the firm.
    if (firm.phones.length || firm.emails.length) {
        people.push({
            name: '', role: people.length ? 'Office' : 'Main contact',
            phones: firm.phones.map(v => ({ label: 'Office', v })),
            emails: firm.emails.map(v => ({ label: 'Work', v })),
        });
    }
    const today = new Date().toISOString().slice(0, 10);
    return {
        role: '',                       // his to choose
        roleOther: firm.trade,
        company: firm.company,
        city: firm.city,
        people,
        address: '', branches: [], types: [], products: [], rules: [], routes: [], images: [],
        moq: 0,
        partLoad: null,
        notes: firm.notes.map(t => ({ t, d: today }))
            .concat([{ t: 'From your phone book, under "' + str(sourceTitle) + '"', d: today }]),
        fromGoogle: true,
    };
}

/**
 * The same firm, written a dozen different ways.
 *
 * Maharashtra Seamless appears in the coating list with one man, in the purchase list with
 * its branches, and somewhere else again with the transporters it uses. Read list by list
 * that is three thin cards; merged it is the card the owner actually wanted. This is the
 * half that answers his complaint.
 *
 * A firm is written as "M/S MAHARASHTRA SEAMLESS LTD.", "Maharashtra Seamless Limited" and
 * "MAHA SEAMLESS" across three lists, so the name is tidied before comparing: the trade
 * words that carry no meaning come off, punctuation goes, spacing collapses.
 *
 * Matched on the WHOLE tidied name, never on one containing another. "Jindal Pipe" and
 * "Jindal Saw" are different firms and both are real; so are "Sri Steel" and "Sri Steel
 * Traders". A duplicate card he can see and tidy. Two firms welded into one he cannot.
 */
const NOISE = /\b(m\/s|ms|the|pvt|private|ltd|limited|co|company|corporation|corp|inc|and|&)\b/g;

function tidyName(name) {
    return str(name).toLowerCase()
        .replace(/[.,'"`()\[\]-]/g, ' ')
        .replace(NOISE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The last ten digits — what actually dials, whatever the +91 and spacing look like. */
function dialKey(phone) {
    const digits = str(phone).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
}

/** Everything that can identify one firm: its tidied name, its numbers, its addresses. */
function firmKeys(firm) {
    const keys = [];
    const name = tidyName(firm.company);
    if (name) keys.push('n:' + name);
    allPhones(firm).forEach(p => { const d = dialKey(p); if (d) keys.push('p:' + d); });
    allMails(firm).forEach(e => keys.push('e:' + e.toLowerCase()));
    return keys;
}

function allPhones(firm) {
    return (firm.phones || []).concat(
        (firm.people || []).reduce((acc, c) => acc.concat(c.phones || []), []));
}

function allMails(firm) {
    return (firm.emails || []).concat(
        (firm.people || []).reduce((acc, c) => acc.concat(c.emails || []), []));
}

/**
 * Fold the firms read out of every list into one card each.
 *
 * Two firms join when they share ANY key — the same tidied name, the same number, or the
 * same address. Joining is contagious on purpose: if A shares a number with B and B shares a
 * name with C, all three are one firm, which is exactly how these lists cross-reference.
 */
function mergeListFirms(found) {
    const groups = [];
    const byKey = new Map();

    (found || []).forEach(entry => {
        const keys = firmKeys(entry.firm);
        const hit = [...new Set(keys.map(k => byKey.get(k)).filter(g => g !== undefined))];
        let group;
        if (!hit.length) {
            group = { entries: [], keys: new Set() };
            groups.push(group);
        } else {
            // Several groups turn out to be one firm: fold them together.
            group = hit[0];
            hit.slice(1).forEach(other => {
                other.entries.forEach(e => group.entries.push(e));
                other.keys.forEach(k => { group.keys.add(k); byKey.set(k, group); });
                other.entries.length = 0;
                other.dead = true;
            });
        }
        group.entries.push(entry);
        keys.forEach(k => { group.keys.add(k); byKey.set(k, group); });
    });

    return groups.filter(g => !g.dead && g.entries.length).map(joinEntries);
}

/** One firm, with everything every list knew about it. */
function joinEntries(group) {
    const firms = group.entries.map(e => e.firm);
    const sources = [...new Set(group.entries.map(e => str(e.source)).filter(Boolean))];
    return {
        // The longest name, which is nearly always the fullest — "Maharashtra Seamless
        // Limited" over "MAHA SEAMLESS".
        company: firms.map(f => str(f.company)).filter(Boolean)
            .sort((a, b) => b.length - a.length)[0] || '',
        trade: firms.map(f => str(f.trade)).filter(Boolean)[0] || '',
        city: firms.map(f => str(f.city)).filter(Boolean)[0] || '',
        people: joinPeople(firms),
        phones: uniqBy(firms.reduce((a, f) => a.concat(f.phones || []), []), dialKey),
        emails: [...new Set(firms.reduce((a, f) => a.concat(f.emails || []), []).map(e => e.toLowerCase()))],
        notes: [...new Set(firms.reduce((a, f) => a.concat(f.notes || []), []))],
        relations: uniqBy(firms.reduce((a, f) => a.concat(f.relations || []), []),
            r => tidyName(r.firm) + '|' + str(r.how).toLowerCase()),
        sources,
    };
}

/**
 * The people, without the same man three times.
 *
 * Matched on his number first: the lists spell names every possible way, but the mobile is
 * the mobile. Failing that, on the tidied name.
 */
function joinPeople(firms) {
    const out = [];
    firms.reduce((a, f) => a.concat(f.people || []), []).forEach(person => {
        const dials = (person.phones || []).map(dialKey).filter(Boolean);
        const mails = (person.emails || []).map(e => e.toLowerCase());
        const at = out.findIndex(x =>
            (dials.length && (x.phones || []).map(dialKey).some(d => d && dials.indexOf(d) !== -1))
            || (mails.length && (x.emails || []).map(e => e.toLowerCase()).some(e => mails.indexOf(e) !== -1))
            || (tidyName(person.name) && tidyName(x.name) === tidyName(person.name)));
        if (at === -1) { out.push(JSON.parse(JSON.stringify(person))); return; }
        const keep = out[at];
        if (str(person.name).length > str(keep.name).length) keep.name = person.name;
        if (!str(keep.role) && str(person.role)) keep.role = person.role;
        keep.phones = uniqBy((keep.phones || []).concat(person.phones || []), dialKey);
        keep.emails = [...new Set((keep.emails || []).concat(person.emails || []).map(e => e.toLowerCase()))];
    });
    return out.slice(0, 40);
}

function uniqBy(list, key) {
    const seen = new Set();
    return (list || []).filter(v => {
        const k = key(v) || str(v).toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/**
 * Write the relationship onto BOTH cards.
 *
 * "Maharashtra Seamless uses ABC Roadlines for Chennai" is two firms, and the owner needs
 * both: ABC Roadlines has to have its own card or it is never ranked and never sent an
 * enquiry. Burying it as a line on the MSL card loses a transporter entirely.
 *
 * So the transporter's card says who it hauls for, and the mill's card says who hauls for
 * it. Whichever one he opens, the connection is on the page.
 *
 * The named firm may not be in these lists at all — plenty are mentioned only in passing.
 * The note still goes on the card that IS here, because half a connection is worth keeping.
 */
function linkFirms(firms) {
    const byName = new Map();
    (firms || []).forEach(f => { const k = tidyName(f.company); if (k) byName.set(k, f); });

    (firms || []).forEach(f => {
        (f.relations || []).forEach(rel => {
            const how = str(rel.how) || 'works with them';
            // On the firm that does the work: "transporter for them → Maharashtra Seamless".
            addNote(f, capital(how) + ' — ' + str(rel.firm));
            // And on the firm it is done for, if that firm is here too.
            const other = byName.get(tidyName(rel.firm));
            if (other && other !== f) {
                addNote(other, str(f.company) + ' — ' + how);
            }
        });
    });
    return firms || [];
}

function addNote(firm, text) {
    const t = str(text);
    if (!t) return;
    firm.notes = firm.notes || [];
    if (firm.notes.indexOf(t) === -1) firm.notes.push(t);
}

function capital(s) {
    const t = str(s);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

module.exports = {
    listPrompt, parseFirms, previewFromListFirm, cleanFirm, MAX_TEXT, linkFirms,
    tidyName, dialKey, firmKeys, mergeListFirms, joinPeople,
};
