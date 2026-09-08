'use strict';

/**
 * utils/constants.js
 *
 * Named constants shared across multiple files.
 * Never use raw strings or numbers for these values — always import from here.
 */

// ── DynamoDB ──────────────────────────────────────────────────────────────────

/** The _entity value written to every quotation item. Used by the GSI. */
const ENTITY_QUOTATION = 'QUOTATION';

/** Primary key of the atomic quote-number counter item in DynamoDB. */
const QUOTE_COUNTER_ID = 'QUOTE_NUMBER_COUNTER';

/** _entity value for the tiny "this Gmail message was ingested" marker rows.
 *  Different from ENTITY_QUOTATION so markers never show up in the quotations list. */
const ENTITY_GMAIL_MSG_MARKER = 'GMAIL_MSG_MARKER';

/** Primary-key prefix for a Gmail-message ingest marker (prefix + gmailMessageId).
 *  The marker is written with attribute_not_exists so only the first ingest of a
 *  given message wins — this is the atomic duplicate guard. */
const GMAIL_MSG_MARKER_PREFIX = 'GMAILMSG#';

/** Gmail labels the app puts on threads it sends into, keyed by a short tag the
 *  client sends. The client passes the KEY, never the label name — otherwise a
 *  stray request could create arbitrary labels in the mailbox. "/" nests them, so
 *  all three appear inside the Quotation Automation group in Gmail. */
const GMAIL_SENT_LABELS = {
  freight: 'Quotation Automation/Freight Enquiry',
  supplier: 'Quotation Automation/Enquiry Sent by us',
  regret: 'Quotation Automation/Regret',
};

/** Counter starts here so the first real quote number is QUOTE_COUNTER_START + 1.
 *
 *  Settable per deployment, because a SECOND setup on its own table starts its own counter —
 *  and left at 107 its first quote would be DSC-108, a number already sent to a customer years
 *  ago. The m@dscpipes.com setup starts far above the live run instead (QUOTE_COUNTER_START=10000
 *  -> DSC-10001). Nothing here can renumber an existing setup: both callers use
 *  `if_not_exists(#v, :start)`, so this value is read ONLY when the counter has never existed. */
const QUOTE_COUNTER_START = (() => {
    const n = Number(process.env.QUOTE_COUNTER_START);
    return Number.isInteger(n) && n >= 0 ? n : 107;
})();

/** Name of the GSI that indexes quotations by updatedAt (fast list query). */
const QUOTATIONS_GSI_INDEX = 'entity-updatedAt-index';

// ── Storage config file keys ───────────────────────────────────────────────────

const CONFIG_KEY_INSTRUCTIONS         = 'instructions.txt';
const CONFIG_KEY_DEFAULT_TERMS        = 'default-terms.txt';
const CONFIG_KEY_DEFAULT_MARGINS      = 'default-margins.json';
const CONFIG_KEY_DEFAULT_EMAIL_MESSAGE = 'default-email-message.txt';
// The reply sent when an enquiry is regretted. Editable in Settings like the two above —
// it used to be hardcoded, so changing a word needed a code change.
const CONFIG_KEY_REGRET_MESSAGE       = 'regret-message.txt';
const CONFIG_KEY_DEFAULT_SIGNATURE    = 'default-signature.txt';
/** Remembered freight-enquiry recipients + pickup/drop points (for instant suggestions). */
const CONFIG_KEY_FREIGHT_SUGGESTIONS  = 'freight-suggestions.json';
// Suppliers/dealers remembered per PIPE TYPE (GI / ERW / Seamless) for the quote card's
// Enquiry tab — the buying-side mirror of the route-keyed freight transporter memory.
const CONFIG_KEY_SUPPLIER_SUGGESTIONS = 'supplier-suggestions.json';
/** Editable staff-name list (admin desk "Assign to" + Bigin owner later). */
const CONFIG_KEY_STAFF_LIST           = 'staff-list.json';
// The partner directory: dealers, manufacturers, transporters and fabricators, with what
// each one handles. The two *-suggestions.json files above remember bare emails
// automatically; this holds the curated records those get promoted into, plus the log of
// every change the app made on its own ({ contacts: [...], changes: [...] }).
const CONFIG_KEY_CONTACTS             = 'contacts.json';
/** Emails tagged with the Add-to-Directory Gmail label, waiting for the owner's approval. */
const CONFIG_KEY_CONTACTS_PENDING     = 'contacts-pending.json';
/** Firms worked out from Google Contacts, waiting to be brought in a batch at a time.
 *  Built by tools/google-contacts-scan.js, which takes minutes — far past the live
 *  site's 60-second limit — so the slow read happens once and the app only ever
 *  reads this. */
const CONFIG_KEY_GOOGLE_FIRMS         = 'google-firms.json';
/** People who can log in: [{ name, email, hash }]. Managed with tools/manage-users.js. */
const CONFIG_KEY_USERS                = 'users.json';

// ── A second setup for the same company ──────────────────────────────────────
//
// A second deployment (m@dscpipes.com) shares this bucket, and the company's own rules stay
// shared: the AI instructions, the terms, the margins. Splitting those would mean a trade rule
// fixed here quietly staying broken over there — the drift that one codebase is meant to prevent.
//
// Everything below is that deployment's own. The signature and the email message because these
// two sign their own names. The DIRECTORY because it is not one list the company keeps — it is
// built from a mailbox: contacts-pending comes from emails labelled in that account, and
// google-firms from that account's own Google Contacts. Pointing both setups at one file would
// mean m@'s address book quietly overwriting info@'s the first time either was scanned.
const PERSONAL_CONFIG_KEYS = new Set([
    CONFIG_KEY_DEFAULT_SIGNATURE,
    CONFIG_KEY_DEFAULT_EMAIL_MESSAGE,
    CONFIG_KEY_CONTACTS,
    CONFIG_KEY_CONTACTS_PENDING,
    CONFIG_KEY_GOOGLE_FIRMS,
    // Each site keeps its own people. Sharing one list would mean anyone who can log in to the
    // m@ site can also open info@'s, which is the opposite of keeping the two sets of quotes apart.
    CONFIG_KEY_USERS,
]);

/** Where a config file actually lives for THIS deployment. Unset CONFIG_PREFIX (the live
 *  info@ setup) returns the key untouched, so nothing moves and no file needs migrating. */
function configKey(key) {
    const prefix = String(process.env.CONFIG_PREFIX || '').trim();
    return (prefix && PERSONAL_CONFIG_KEYS.has(key)) ? prefix + key : key;
}

/** The address printed on the letterhead, on screen and on the PDF. */
const COMPANY_EMAIL = String(process.env.COMPANY_EMAIL || '').trim() || 'info@dscpipes.com';

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    ENTITY_QUOTATION,
    ENTITY_GMAIL_MSG_MARKER,
    GMAIL_MSG_MARKER_PREFIX,
    GMAIL_SENT_LABELS,
    QUOTE_COUNTER_ID,
    QUOTE_COUNTER_START,
    QUOTATIONS_GSI_INDEX,
    CONFIG_KEY_INSTRUCTIONS,
    CONFIG_KEY_DEFAULT_TERMS,
    CONFIG_KEY_DEFAULT_MARGINS,
    CONFIG_KEY_DEFAULT_EMAIL_MESSAGE,
    CONFIG_KEY_REGRET_MESSAGE,
    CONFIG_KEY_DEFAULT_SIGNATURE,
    CONFIG_KEY_FREIGHT_SUGGESTIONS,
    CONFIG_KEY_SUPPLIER_SUGGESTIONS,
    CONFIG_KEY_STAFF_LIST,
    CONFIG_KEY_CONTACTS,
    CONFIG_KEY_CONTACTS_PENDING,
    CONFIG_KEY_GOOGLE_FIRMS,
    CONFIG_KEY_USERS,
    PERSONAL_CONFIG_KEYS,
    configKey,
    COMPANY_EMAIL,
};
