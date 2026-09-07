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
        '  "notes": ["any remark about them, copied as written"]',
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

module.exports = { listPrompt, parseFirms, previewFromListFirm, cleanFirm, MAX_TEXT };
