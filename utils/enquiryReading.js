'use strict';

// Who the customer is, and reading every file — rules added to the generation prompt.
//
// DSC-2930 (Enexio, 9 Oct 2026): one email for three of Enexio's projects (Coffers, Rungta, Max
// Cement), with one PDF per project. The AI was only ever shown the email TEXT, which never names
// Enexio — so it billed the quote to "Max Cement Limited", one of the end clients, and on that run
// left Max Cement's own sheet out entirely. Now the AI is shown who sent the email, and told the
// customer is the sender's company and that every attached file is part of the enquiry.
//
// The saved instructions' JSON format has no "unit" or "wallThicknessMm" key, and the AI follows that
// format exactly — so both were silently dropped (the kg-quantity rule never received a unit).
// LINE ITEM FORMAT spells out the full shape.
//
// Ships with the code (not the editable instructions) so these can't be edited away by accident.
//
// Pure module: no I/O.

const ENQUIRY_READING_RULES = `
LINE ITEM FORMAT — this EXTENDS the JSON format in the system instructions, which leaves two keys out. Every object in "lineItems" must have ALL of these keys: {"originalDescription": "", "identifiedPipeType": "", "quantity": "", "unit": "", "wallThicknessMm": "", "kgPerMeter": "", "unitRate": "", "marginPercent": "", "finalRate": "", "lineTotal": ""}. Never drop "unit" or "wallThicknessMm".
THE CUSTOMER — "companyName" is the company that SENT this enquiry: take it from the signature or letterhead, else from the sender's email address in the "From:" line (e.g. someone@enexioindia.com → Enexio). NEVER use the name of an end client, project, plant or site the pipes are for — a contractor often asks for several of its clients' projects in one email. Put those names in "projectName" instead. If the sender's company cannot be found, leave "companyName" empty rather than using a project name.
EVERY FILE — every attached file is part of the enquiry. Extract the items of EVERY file and EVERY table; when an email covers several projects (often one file each), include every project's items. In a table whose columns are pipe sizes, the quantity for each size is in its total row (e.g. "INDENT QTY", "TOTAL"), not the individual drawing rows.
WALL THICKNESS — every line item has "wallThicknessMm". When the enquiry gives a wall thickness in mm for that line (e.g. a table with OD and THK columns, "114.3 x 6.02", "6.35 mm"), copy that number into "wallThicknessMm" exactly as written (e.g. 6.02) — even if you also write a schedule in "originalDescription". When the enquiry gives no thickness in mm for that line, set "wallThicknessMm" to "". Never replace a thickness the customer gave with a different schedule's thickness.`;

/** "From: …" and "Subject: …" lines for the AI, so it can see who is asking. Empty when unknown. */
function senderHeader(email) {
    const lines = [];
    const from = String((email && email.from) || '').trim();
    const subject = String((email && email.subject) || '').trim();
    if (from) lines.push('From: ' + from);
    if (subject) lines.push('Subject: ' + subject);
    return lines.length ? lines.join('\n') + '\n\n' : '';
}

module.exports = { ENQUIRY_READING_RULES, senderHeader };
