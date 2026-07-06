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

/** Counter starts here so the first real quote number is QUOTE_COUNTER_START + 1. */
const QUOTE_COUNTER_START = 107;

/** Name of the GSI that indexes quotations by updatedAt (fast list query). */
const QUOTATIONS_GSI_INDEX = 'entity-updatedAt-index';

// ── Storage config file keys ───────────────────────────────────────────────────

const CONFIG_KEY_INSTRUCTIONS         = 'instructions.txt';
const CONFIG_KEY_DEFAULT_TERMS        = 'default-terms.txt';
const CONFIG_KEY_DEFAULT_MARGINS      = 'default-margins.json';
const CONFIG_KEY_DEFAULT_EMAIL_MESSAGE = 'default-email-message.txt';
const CONFIG_KEY_DEFAULT_SIGNATURE    = 'default-signature.txt';
/** Remembered freight-enquiry recipients + pickup/drop points (for instant suggestions). */
const CONFIG_KEY_FREIGHT_SUGGESTIONS  = 'freight-suggestions.json';

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    ENTITY_QUOTATION,
    ENTITY_GMAIL_MSG_MARKER,
    GMAIL_MSG_MARKER_PREFIX,
    QUOTE_COUNTER_ID,
    QUOTE_COUNTER_START,
    QUOTATIONS_GSI_INDEX,
    CONFIG_KEY_INSTRUCTIONS,
    CONFIG_KEY_DEFAULT_TERMS,
    CONFIG_KEY_DEFAULT_MARGINS,
    CONFIG_KEY_DEFAULT_EMAIL_MESSAGE,
    CONFIG_KEY_DEFAULT_SIGNATURE,
    CONFIG_KEY_FREIGHT_SUGGESTIONS,
};
