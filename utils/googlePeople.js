'use strict';

/**
 * utils/googlePeople.js — reading the owner's Google Contacts.
 *
 * Everything here is READ ONLY. Nothing in this file writes to Google, and nothing decides
 * what reaches the directory — it fetches, and hands back what it found.
 *
 * It uses the same Gmail credentials the rest of the app already has. The consent granted by
 * tools/gmail-auth.js already covers contacts.readonly and contacts.other.readonly, so no
 * separate sign-in is needed.
 *
 * The volumes are the reason this is its own file and not part of a route: 5,507 saved
 * contacts arrive over six pages, and the 18,548 addresses the owner has ever written to
 * take nineteen more. Together that is well over a minute — past the sixty seconds the live
 * site allows a request — so the caller is tools/google-contacts-scan.js, run once from his
 * own computer, and the app only ever reads the result it cached.
 */

const { google } = require('googleapis');

const PAGE = 1000;
const MAX_PAGES = 40;               // 40,000 contacts is far past anything real; a stop, not a limit

/** null when Gmail was never set up, so the caller can say so rather than crash. */
function peopleApi() {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
    const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
    return google.people({ version: 'v1', auth });
}

function isAvailable() { return !!peopleApi(); }

/** The fields the directory has a home for. Asking for less is faster and reads less. */
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,biographies,addresses';

/**
 * Every saved contact.
 *
 * `onPage` is called after each page so a long read can say where it has got to — a silent
 * two-minute wait is indistinguishable from a hang.
 */
async function savedContacts(onPage) {
    const api = peopleApi();
    if (!api) return [];
    const out = [];
    let token = null, pages = 0;
    do {
        const r = await api.people.connections.list({
            resourceName: 'people/me', pageSize: PAGE, pageToken: token, personFields: PERSON_FIELDS,
        });
        out.push(...(r.data.connections || []));
        token = r.data.nextPageToken;
        if (onPage) onPage(out.length, r.data.totalPeople || 0);
    } while (token && ++pages < MAX_PAGES);
    return out;
}

/**
 * The domains of everyone the owner has ever exchanged mail with.
 *
 * This is what "Contacted" means on a card: a firm he has actually dealt with, as against
 * one that has sat in his phone untouched for years. Domains only — the addresses
 * themselves are none of the directory's business.
 */
async function emailedDomains(onPage) {
    const api = peopleApi();
    if (!api) return new Set();
    const out = new Set();
    let token = null, pages = 0;
    do {
        const r = await api.otherContacts.list({
            pageSize: PAGE, pageToken: token, readMask: 'emailAddresses',
        });
        (r.data.otherContacts || []).forEach((p) => (p.emailAddresses || []).forEach((e) => {
            const d = String((e && e.value) || '').toLowerCase().split('@')[1];
            if (d) out.add(d);
        }));
        token = r.data.nextPageToken;
        if (onPage) onPage(out.size);
    } while (token && ++pages < MAX_PAGES);
    return out;
}

module.exports = { isAvailable, savedContacts, emailedDomains, PERSON_FIELDS };
