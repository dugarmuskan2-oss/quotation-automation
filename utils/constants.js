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

/** Counter starts here so the first real quote number is QUOTE_COUNTER_START + 1. */
const QUOTE_COUNTER_START = 107;

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
};
