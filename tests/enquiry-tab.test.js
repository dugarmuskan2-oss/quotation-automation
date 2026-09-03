/**
 * @jest-environment node
 *
 * tests/enquiry-tab.test.js
 *
 * The quote card's ENQUIRY tab (quote-enquiry-tab.js) — asking suppliers/dealers for their
 * best rate on the items you are already quoting, without leaving the quote. Everything below
 * runs the REAL shipped code; nothing here is a re-implementation.
 *
 *  1. ROW DERIVATION. The tab must build its rows with the standalone Enquiry Preparer's OWN
 *     functions (window.enquiryPreparerModel), not a lookalike. They had drifted before: the
 *     Size column ended up holding the whole description and the UOM defaulted differently, so
 *     the same quote produced two different enquiry tables depending on which screen sent it.
 *     The tests pin buildRowsFromQuote to be JSON-identical to normalizeQuotation ->
 *     buildEnquiryRowModel run directly, and pin the no-model fallback to the same field names
 *     (so the table still renders while enquiry-preparer.js is still initialising).
 *
 *  2. THE EMAILED TABLE. A supplier must not be able to tell which screen an enquiry came from,
 *     so enquiryTableHtml has to match buildEnquiryHtmlForCopy in enquiry-preparer.js: the S. NO
 *     column, the exact header words (read out of the preparer's source here, so a reword there
 *     fails this file), the OUR REQUIREMENT (ENQUIRY) / YOUR OFFER group headers at colspan 7/3,
 *     the #0b4aa2 / #2e7d32 colours, 1px solid #000 borders and #eef5ff zebra striping. Cell
 *     values are escaped — a description carrying markup must not become markup.
 *
 *  3. THE MESSAGE. buildDraft takes its wording from the preparer's defaultHeaderText (same text
 *     as resetEnquiryDefaults), and messageToHtml swaps [TABLE] for the real table, wraps
 *     everything in the Arial block and renders header lines as per-line divs with a bolder
 *     greeting. A leftover "[TABLE]" would be mailed to the supplier verbatim.
 *
 *  4. PIPE TYPES + SUGGESTIONS. pipeTypeOf buckets a line item to gi/erw/seamless, and
 *     suggestedSuppliers floats the suppliers used for THIS quote's pipe types above everyone
 *     else, de-duplicated, filtered by what is typed, capped.
 *
 *  5. SUPPLIER MEMORY (routes/config.js). normalizePipeType can never invent a fourth bucket;
 *     mergeSupplierUsage bumps the global list and each covered type, most-used first, and
 *     survives junk input.
 *
 *  6. ROUTES. POST /quotations/:id/supplier-enquiries is a field-only MERGE (a second sender
 *     posting only its own entry must not erase a colleague's, exactly like the freight route),
 *     GET /quotations-filter?enquiry=1 powers the Enquiry filter, and supplierEnquiries is both
 *     projected into the list summary and server-owned so a stale whole-object /save-quotation
 *     cannot wipe it.
 *
 *  7. BCC SEND. Each supplier gets their own email with the supplier on Bcc, so nobody sees
 *     anyone else. That means a message with NO To. It first emitted the RFC group placeholder
 *     "To: undisclosed-recipients:;" — valid by the spec, but the Gmail API rejects it outright
 *     ("Invalid To header"), so every supplier enquiry failed to send. sendEmail now addresses
 *     such a message to our own mailbox, and buildRawMessage omits a To it does not have. The
 *     send route must still accept a bcc-only request while rejecting one with no recipient.
 *
 * NOTES ON HOW THE BROWSER MODULES ARE LOADED (reality, not the brief):
 *   - enquiry-preparer.js does NOT export defaultHeaderText on its `_test` object; that function
 *     only exists on the window.enquiryPreparerModel that init() publishes. So instead of hand-
 *     building a stub model, this file stubs `document` and requires the real enquiry-preparer.js,
 *     letting its own init() publish the real model onto window. Strictly more faithful: the tab
 *     is exercised against the very object the browser gives it.
 *   - DynamoDB is faked in memory with the tagged-command pattern from tests/admin-routes.test.js;
 *     the fake honours the route's _rev ConditionExpression (tests/sweep-fixes-server.test.js).
 */

'use strict';

// utils/gmail is mocked for the ROUTE test (nothing is actually sent); the real MIME builder is
// pulled in with requireActual so buildRawMessage itself is still the shipped code.
const mockSendEmail = jest.fn();
const mockLookupMessageThread = jest.fn();
jest.mock('../utils/gmail', () => ({
    sendEmail: mockSendEmail,
    lookupMessageThread: mockLookupMessageThread,
    fetchThreadMessages: jest.fn(),
    searchContactSuggestions: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
    const tag = (t) => class { constructor(input) { this.input = input; this.__type = t; } };
    return {
        DynamoDBDocumentClient: { from: jest.fn() },
        GetCommand: tag('Get'), PutCommand: tag('Put'),
        UpdateCommand: tag('Update'), QueryCommand: tag('Query'), ScanCommand: tag('Scan'),
    };
});

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const createQuotationsRouter = require('../routes/quotations');
const createGmailRouter = require('../routes/gmail');
const { ENTITY_QUOTATION } = require('../utils/constants');
const { normalizePipeType, mergeSupplierUsage, sanitizeSupplierSuggestions } = require('../routes/config')._test;
const { buildRawMessage } = jest.requireActual('../utils/gmail')._test;

const ROOT = path.join(__dirname, '..');
const TAB_PATH = path.join(ROOT, 'quote-enquiry-tab.js');
const PREP_PATH = path.join(ROOT, 'enquiry-preparer.js');
const QUOTES_ROUTE_PATH = path.join(ROOT, 'routes', 'quotations.js');

const tabSrc = fs.readFileSync(TAB_PATH, 'utf8');
const prepSrc = fs.readFileSync(PREP_PATH, 'utf8');
const quotesRouteSrc = fs.readFileSync(QUOTES_ROUTE_PATH, 'utf8');

// ── Load the two browser modules the way the browser does ─────────────────────
// enquiry-preparer.js publishes window.enquiryPreparerModel from its own init(); the tab reads
// that at call time. Stub just enough `document` for init() to run against no DOM.
global.window = {};
global.document = { readyState: 'complete', getElementById: () => null, addEventListener: () => {} };
const preparer = require('../enquiry-preparer.js')._test;   // normalizeQuotation, buildEnquiryRowModel, ...
const tab = require('../quote-enquiry-tab.js')._test;
delete global.document;                                     // nothing else in this file needs a DOM

const {
    pipeTypeOf, quotePipeTypes, isFreightRow, buildRowsFromQuote,
    enquiryTableHtml, messageToHtml, buildDraft, suggestedSuppliers, _setSuggest,
} = tab;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// A realistic quote: one ERW line whose description carries a parseable size + spec, one GI line,
// one seamless line with its own UOM, and a freight line that a supplier never quotes on.
const QUOTE = {
    id: 'q1',
    quoteNumber: 'DSC-700',
    companyName: 'Acme Engineering',
    lineItems: [
        { lineItemId: 'li-1', originalDescription: '8" X 6.35 MM ERW BLACK PIPE IS 3589 GR. 410', identifiedPipeType: 'ERW', quantity: '250', unit: 'Mtrs' },
        { lineItemId: 'li-2', originalDescription: '2" NB X Heavy -- GI', identifiedPipeType: 'GI', quantity: '100' },
        { lineItemId: 'li-3', originalDescription: '6" NB X Sch 40 ASTM A106 GR. B', identifiedPipeType: 'Seamless', quantity: '80', uom: 'MT' },
        { lineItemId: 'li-4', originalDescription: 'Freight', quantity: '1', unitRate: '18500' },
    ],
};

const ROW_FIELDS = ['productSpec', 'size', 'qty', 'uom', 'lengthReqByUs', 'makeRequiredByUs', 'rate', 'offerUom', 'makeOfferedByYou'];

const blankRow = (over) => Object.assign({
    productSpec: '', size: '', qty: '', uom: '',
    lengthReqByUs: '', makeRequiredByUs: '', rate: '', offerUom: '', makeOfferedByYou: '',
}, over);

/** Run the Enquiry Preparer's own chain, exactly as populateEnquiryTableFromQuotation does. */
function preparerRows(quotation) {
    const live = (quotation.lineItems || []).filter((li) => li && !isFreightRow(li));
    const normalized = preparer.normalizeQuotation({ lineItems: live });
    return normalized.lineItems.map(preparer.buildEnquiryRowModel);
}

/** Pull a `[ ... ].join('')` array of th('LABEL', ...) calls out of a source file. */
function headerLabelsFrom(source, declaration) {
    const m = new RegExp(declaration + ' colHeaderRow = \\[([\\s\\S]*?)\\]\\.join\\(\'\'\\);').exec(source);
    if (!m) throw new Error('colHeaderRow block not found for: ' + declaration);
    return (m[1].match(/th\('([^']*)'/g) || []).map((s) => s.slice(4, -1));
}

/** Split the <tbody> of a rendered table into its <tr> inner strings. */
function bodyRowsOf(html) {
    const body = html.slice(html.indexOf('<tbody>') + '<tbody>'.length, html.indexOf('</tbody>'));
    return body.split('<tr>').slice(1).map((s) => s.split('</tr>')[0]);
}

const esc = (v) => String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ══════════════════════════════════════════════════════════════════════════════
// 1. Rows are built by the Enquiry Preparer's own code
// ══════════════════════════════════════════════════════════════════════════════

describe('buildRowsFromQuote — the preparer\'s own chain, not a lookalike', () => {
    test('the model is really the one enquiry-preparer.js published on window', () => {
        expect(typeof global.window.enquiryPreparerModel).toBe('object');
        expect(global.window.enquiryPreparerModel.normalizeQuotation).toBe(preparer.normalizeQuotation);
        expect(global.window.enquiryPreparerModel.buildEnquiryRowModel).toBe(preparer.buildEnquiryRowModel);
        expect(typeof global.window.enquiryPreparerModel.defaultHeaderText).toBe('function');
    });

    test('output is JSON-identical to normalizeQuotation -> buildEnquiryRowModel', () => {
        expect(JSON.stringify(buildRowsFromQuote(QUOTE))).toBe(JSON.stringify(preparerRows(QUOTE)));
    });

    test('...and identical field by field, for every row', () => {
        const rows = buildRowsFromQuote(QUOTE);
        const expected = preparerRows(QUOTE);
        expect(rows).toHaveLength(expected.length);
        rows.forEach((r, i) => { expect(r).toEqual(expected[i]); });
    });

    test('freight lines are excluded — a supplier is never asked to quote freight', () => {
        const rows = buildRowsFromQuote(QUOTE);
        expect(rows).toHaveLength(3);                                  // 4 line items, 1 is freight
        expect(JSON.stringify(rows).toLowerCase()).not.toContain('freight');
        expect(JSON.stringify(rows)).not.toContain('18500');
    });

    test.each([
        ['Freight', true],
        ['freight', true],
        ['  FREIGHT  ', true],
        ['Freight charges', false],
        ['2" NB X Heavy -- GI', false],
        ['', false],
    ])('isFreightRow(%j) -> %s', (description, expected) => {
        expect(isFreightRow({ originalDescription: description })).toBe(expected);
        expect(isFreightRow({ description })).toBe(expected);
    });

    test('isFreightRow tolerates a missing/empty item', () => {
        expect(isFreightRow(null)).toBe(false);
        expect(isFreightRow(undefined)).toBe(false);
        expect(isFreightRow({})).toBe(false);
    });

    test('SIZE holds the parsed size, not the whole description (the old drift)', () => {
        const rows = buildRowsFromQuote(QUOTE);
        expect(rows[0].size).toBe('8" X 6.35 MM');
        expect(rows[0].size).not.toBe(QUOTE.lineItems[0].originalDescription);
        expect(rows[0].size.length).toBeLessThan(QUOTE.lineItems[0].originalDescription.length);
    });

    test('PRODUCT & SPEC is the item\'s own type, and the inferred standard when it has none', () => {
        // Reality (not assumed): normalizeQuotation fills productSpec from identifiedPipeType, and
        // buildEnquiryRowModel only falls back to inferring a standard/grade when that is blank.
        expect(buildRowsFromQuote(QUOTE)[0].productSpec).toBe('ERW');

        const desc = '8" X 6.35 MM BLACK PIPE IS 3589 GR. 410';
        const inferred = buildRowsFromQuote({ lineItems: [{ originalDescription: desc, quantity: '250', unit: 'Mtrs' }] });
        expect(inferred[0].productSpec).toContain('IS 3589');
        expect(inferred[0].productSpec).toBe(preparer.inferProductSpecFromText(desc, inferred[0].size));
    });

    test('UOM comes from the line item, and is left blank when the item does not say', () => {
        const rows = buildRowsFromQuote(QUOTE);
        expect(rows[0].uom).toBe('Mtrs');   // item.unit
        expect(rows[2].uom).toBe('MT');     // item.uom
        // Was 'Nos' — a guess, and the wrong one for pipe, printed as fact on a supplier enquiry.
        // With no quote tableHTML to read a quantity heading from, the column stays empty.
        expect(rows[1].uom).toBe('');
    });

    test('quantities are carried across', () => {
        expect(buildRowsFromQuote(QUOTE).map((r) => r.qty)).toEqual(['250', '100', '80']);
    });

    test('the offer columns start empty — the supplier fills them in', () => {
        buildRowsFromQuote(QUOTE).forEach((r) => {
            expect(r.rate).toBe('');
            expect(r.offerUom).toBe('');
            expect(r.makeOfferedByYou).toBe('');
            expect(r.lengthReqByUs).toBe('');
        });
    });

    test('a quote with no line items yields no rows (and does not throw)', () => {
        expect(buildRowsFromQuote({ id: 'x' })).toEqual([]);
        expect(buildRowsFromQuote({ id: 'x', lineItems: [] })).toEqual([]);
        expect(buildRowsFromQuote(null)).toEqual([]);
    });
});

describe('buildRowsFromQuote — fallback while enquiry-preparer.js is still initialising', () => {
    // The preparer initialises on DOMContentLoaded; if the tab renders first there is no model
    // yet. The fallback must still return the SAME field names or the table renders blank cells.
    function withoutModel(fn) {
        const saved = global.window.enquiryPreparerModel;
        delete global.window.enquiryPreparerModel;
        try { return fn(); } finally { global.window.enquiryPreparerModel = saved; }
    }

    test('the same field names, in the same order', () => {
        const fallback = withoutModel(() => buildRowsFromQuote(QUOTE));
        const model = buildRowsFromQuote(QUOTE);
        expect(fallback).toHaveLength(model.length);
        fallback.forEach((r, i) => {
            expect(Object.keys(r).sort()).toEqual(Object.keys(model[i]).sort());
            expect(Object.keys(r).sort()).toEqual(ROW_FIELDS.slice().sort());
        });
    });

    test('every field is a string, so the table renders rather than printing "undefined"', () => {
        withoutModel(() => buildRowsFromQuote(QUOTE)).forEach((r) => {
            ROW_FIELDS.forEach((f) => expect(typeof r[f]).toBe('string'));
        });
    });

    test('freight is still excluded on the fallback path', () => {
        expect(withoutModel(() => buildRowsFromQuote(QUOTE))).toHaveLength(3);
    });

    test('the rendered table is still well-formed from fallback rows', () => {
        const html = enquiryTableHtml(withoutModel(() => buildRowsFromQuote(QUOTE)));
        expect(bodyRowsOf(html)).toHaveLength(3);
        expect(html).not.toContain('undefined');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. The emailed table matches enquiry-preparer.js buildEnquiryHtmlForCopy
// ══════════════════════════════════════════════════════════════════════════════

describe('enquiryTableHtml — indistinguishable from the Enquiry Preparer\'s table', () => {
    const rows = buildRowsFromQuote(QUOTE);
    const html = enquiryTableHtml(rows);
    const prepLabels = headerLabelsFrom(prepSrc, 'const');
    const tabLabels = headerLabelsFrom(tabSrc, 'var');

    test('the preparer really declares the ten columns this test reads', () => {
        expect(prepLabels).toEqual([
            'S. NO', 'PRODUCT & SPECIFICATION', 'SIZE', 'QTY', 'UOM',
            'LENGTH REQ BY US', 'MAKE REQUIRED BY US', 'RATE', 'UOM', 'MAKE OFFERED BY YOU',
        ]);
    });

    test('the tab declares exactly the same column words, in the same order', () => {
        expect(tabLabels).toEqual(prepLabels);
    });

    test('every column word is rendered as a header cell (& escaped to &amp;)', () => {
        prepLabels.forEach((label) => {
            expect(html).toContain('>' + esc(label) + '</th>');
        });
        expect(html).toContain('>PRODUCT &amp; SPECIFICATION</th>');
        expect(html).not.toContain('>PRODUCT & SPECIFICATION</th>');
    });

    test('there is an S. NO column — the first header cell', () => {
        const firstTh = html.slice(html.indexOf('</tr><tr>'));
        expect(firstTh.indexOf('>S. NO</th>')).toBeGreaterThan(-1);
        expect(firstTh.indexOf('>S. NO</th>')).toBeLessThan(firstTh.indexOf('>SIZE</th>'));
    });

    test('the OUR REQUIREMENT (ENQUIRY) / YOUR OFFER group headers use colspan 7 and 3', () => {
        expect(html).toContain('<th colspan="7"');
        expect(html).toContain('<th colspan="3"');
        expect(html).toContain('>OUR REQUIREMENT (ENQUIRY)</th>');
        expect(html).toContain('>YOUR OFFER</th>');
        const group = html.slice(html.indexOf('<thead>'), html.indexOf('</tr><tr>'));
        expect(group).toContain('colspan="7"');
        expect(group).toContain('colspan="3"');
    });

    test('the group headers keep the preparer\'s colours (#0b4aa2 requirement, #2e7d32 offer)', () => {
        expect(html).toContain('<th colspan="7" style="background:#0b4aa2;color:#fff;');
        expect(html).toContain('<th colspan="3" style="background:#2e7d32;color:#fff;');
        expect(prepSrc).toContain("thGroup('OUR REQUIREMENT (ENQUIRY)', 7, '#0b4aa2', '#fff')");
        expect(prepSrc).toContain("thGroup('YOUR OFFER', 3, '#2e7d32', '#fff')");
    });

    test('both palettes appear on the column headers too', () => {
        expect(html).toContain('background:#0b4aa2;color:#ffffff;');
        expect(html).toContain('background:#ffffff;color:#0b4aa2;');
        expect(html).toContain('background:#2e7d32;color:#ffffff;');
        expect(html).toContain('background:#ffffff;color:#2e7d32;');
    });

    test('every header and body cell carries the 1px solid #000 border', () => {
        const cells = html.match(/<t[hd]\s[^>]*>/g) || [];   // \s so <thead> is not counted
        expect(cells.length).toBe(2 + 10 + rows.length * 10);   // 2 group + 10 column + body
        cells.forEach((cell) => expect(cell).toContain('border:1px solid #000;'));
    });

    test('alternate rows are zebra-striped #ffffff / #eef5ff', () => {
        const body = bodyRowsOf(html);
        expect(body).toHaveLength(3);
        expect(body[0]).toContain('bgcolor="#ffffff"');
        expect(body[0]).toContain('background-color:#ffffff;');
        expect(body[1]).toContain('bgcolor="#eef5ff"');
        expect(body[1]).toContain('background-color:#eef5ff;');
        expect(body[2]).toContain('bgcolor="#ffffff"');
        expect(body[1]).not.toContain('#ffffff');
    });

    test('S.NO is auto-numbered 1..n and ignores anything the row itself carries', () => {
        const numbered = enquiryTableHtml([
            blankRow({ slNo: '99', productSpec: 'A' }),
            blankRow({ slNo: '99', productSpec: 'B' }),
            blankRow({ slNo: '99', productSpec: 'C' }),
        ]);
        const body = bodyRowsOf(numbered);
        expect(body.map((r) => /style="[^"]*">(\d+)<\/td>/.exec(r)[1])).toEqual(['1', '2', '3']);
        expect(numbered).not.toContain('>99</td>');
    });

    test('the S.NO cell is centred and the QTY cell right-aligned, like the preparer', () => {
        const row = bodyRowsOf(enquiryTableHtml([blankRow({ productSpec: 'A', qty: '250' })]))[0];
        const cells = row.split('</td>');
        expect(cells[0]).toContain('text-align:center;');
        expect(cells[3]).toContain('text-align:right;');   // QTY is the 4th column
        expect(cells[3]).toContain('>250');
    });

    test('markup in a cell is escaped, never emitted as markup', () => {
        const nasty = enquiryTableHtml([blankRow({
            productSpec: '<b>Bold</b> & "quoted" \'x\'',
            size: '<img src=x onerror=alert(1)>',
        })]);
        expect(nasty).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot; &#39;x&#39;');
        expect(nasty).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(nasty).not.toContain('<b>Bold');
        expect(nasty).not.toContain('<img');
        expect(bodyRowsOf(nasty)).toHaveLength(1);
    });

    test('no rows still produces a valid, empty-bodied table', () => {
        const empty = enquiryTableHtml([]);
        expect(empty).toContain('<tbody></tbody>');
        expect(empty).toContain('>S. NO</th>');
        expect(bodyRowsOf(empty)).toEqual([]);
    });

    test('the table is email-safe: collapsed borders and the Outlook mso hints', () => {
        expect(html).toContain('border-collapse:collapse');
        expect(html).toContain('mso-table-lspace:0pt');
        expect(html).toContain('mso-table-rspace:0pt');
        expect(html).toContain('cellpadding="0" cellspacing="0" border="0"');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. The message: buildDraft + messageToHtml
// ══════════════════════════════════════════════════════════════════════════════

// The wording the Enquiry Preparer resets its header box to — read from source so a reword there
// fails here rather than silently letting the two screens send different covering notes.
function resetDefaultsWording() {
    const m = /function resetEnquiryDefaults\(\)[\s\S]*?headerEl\.value = (\[[\s\S]*?\])\.join\('\\n'\)/.exec(prepSrc);
    if (!m) throw new Error('resetEnquiryDefaults wording not found');
    // eslint-disable-next-line no-eval
    return eval(m[1]).join('\n');
}

describe('buildDraft — the preparer\'s wording, taken from it rather than copied', () => {
    const wording = resetDefaultsWording();

    test('the wording really is the enquiry covering note', () => {
        expect(wording).toContain("Dear Sir/Ma'am,");
        expect(wording).toContain('KINDLY QUOTE YOUR BEST RATE WITH MINIMUM DELIVERY PERIOD.');
        expect(wording).toContain('NOTE: PLEASE MENTION UOM (MTR /KG /MT - METRIC TON) CLEARLY.');
    });

    test('the draft is exactly that wording plus the [TABLE] placeholder', () => {
        expect(buildDraft(QUOTE)).toBe(wording + '\n\n[TABLE]');
    });

    test('it comes from defaultHeaderText, not from a copy inside the tab', () => {
        expect(buildDraft(QUOTE).startsWith(global.window.enquiryPreparerModel.defaultHeaderText())).toBe(true);
        expect(global.window.enquiryPreparerModel.defaultHeaderText()).toBe(wording);
    });

    test('the no-model fallback wording matches the preparer\'s too', () => {
        const saved = global.window.enquiryPreparerModel;
        delete global.window.enquiryPreparerModel;
        try {
            expect(buildDraft(QUOTE)).toBe(wording + '\n\n[TABLE]');
        } finally {
            global.window.enquiryPreparerModel = saved;
        }
    });
});

describe('messageToHtml — the placeholder becomes the real table', () => {
    const rows = buildRowsFromQuote(QUOTE);
    const html = messageToHtml(buildDraft(QUOTE), rows);

    test('[TABLE] is replaced — no placeholder is ever mailed to a supplier', () => {
        expect(html).not.toContain('[TABLE]');
        expect(html).not.toContain('TABLE]');
    });

    test('the real enquiry table is spliced in where the placeholder was', () => {
        expect(html).toContain(enquiryTableHtml(rows));
        expect(html.indexOf('<table')).toBeGreaterThan(html.indexOf('KINDLY QUOTE'));
    });

    test('everything is wrapped in the Arial block', () => {
        expect(html.startsWith('<div style="font-family: Arial, sans-serif; color:#111; font-size:13px;">')).toBe(true);
        expect(html.endsWith('</div>')).toBe(true);
    });

    test('header lines render as one div per line', () => {
        const wording = resetDefaultsWording();
        wording.split('\n').forEach((line) => {
            expect(html).toContain('margin:2px 0;">' + esc(line) + '</div>');
        });
    });

    test('the greeting is bolder than the rest of the note', () => {
        expect(html).toContain('<div style="font-weight:700; margin:2px 0;">Dear Sir/Ma&#39;am,</div>');
        expect(html).toContain('<div style="font-weight:600; margin:2px 0;">KINDLY QUOTE YOUR BEST RATE WITH MINIMUM DELIVERY PERIOD.</div>');
    });

    test('text typed after [TABLE] is rendered below the table', () => {
        const out = messageToHtml('Dear Sir/Ma\'am,\n\n[TABLE]\n\nRegards,\nDSC Pipes', rows);
        expect(out).not.toContain('[TABLE]');
        expect(out).toContain('>Regards,</div>');
        expect(out).toContain('>DSC Pipes</div>');
        expect(out.indexOf('>Regards,</div>')).toBeGreaterThan(out.indexOf('</table>'));
    });

    test('a message with no placeholder still gets the table appended', () => {
        const out = messageToHtml('Please quote.', rows);
        expect(out).toContain('>Please quote.</div>');
        expect(out).toContain('<table');
    });

    test('an empty message still produces the table inside the wrapper', () => {
        const out = messageToHtml('', rows);
        expect(out).toContain('<table');
        expect(out).not.toContain('[TABLE]');
    });

    test('typed message text is escaped, not injected', () => {
        const out = messageToHtml('<script>bad()</script>\n\n[TABLE]', rows);
        expect(out).toContain('&lt;script&gt;bad()&lt;/script&gt;');
        expect(out).not.toContain('<script>');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Pipe types + supplier suggestions
// ══════════════════════════════════════════════════════════════════════════════

describe('pipeTypeOf — bucket a line item to gi / erw / seamless', () => {
    test.each([
        ['explicit GI', { identifiedPipeType: 'GI' }, 'gi'],
        ['explicit ERW', { identifiedPipeType: 'ERW' }, 'erw'],
        ['explicit Seamless', { identifiedPipeType: 'Seamless' }, 'seamless'],
        ['a SCH 40 description', { originalDescription: '6" NB X SCH 40' }, 'seamless'],
        ['a "-- GI" description', { originalDescription: '2" NB X Heavy -- GI' }, 'gi'],
        ['a "-- ERW" description', { originalDescription: '3" NB X Medium -- ERW' }, 'erw'],
        ['galvanised spelled out', { originalDescription: 'Galvanised pipe, 2 inch' }, 'gi'],
        ['the `description` field', { description: '4" NB X Sch 80' }, 'seamless'],
        ['nothing recognisable', { originalDescription: 'Miscellaneous fittings' }, ''],
        ['an empty item', {}, ''],
    ])('%s -> %j', (_label, item, expected) => {
        expect(pipeTypeOf(item)).toBe(expected);
    });

    test('a missing item is not a crash', () => {
        expect(pipeTypeOf(null)).toBe('');
        expect(pipeTypeOf(undefined)).toBe('');
    });

    test('seamless wins over a stray GI/ERW word — it is checked first', () => {
        expect(pipeTypeOf({ identifiedPipeType: 'Seamless', originalDescription: 'ERW replacement' })).toBe('seamless');
    });
});

describe('quotePipeTypes — the distinct types in one quote', () => {
    test('de-duplicates repeated types', () => {
        expect(quotePipeTypes({ lineItems: [
            { identifiedPipeType: 'GI' }, { identifiedPipeType: 'GI' }, { identifiedPipeType: 'ERW' },
        ] })).toEqual(['gi', 'erw']);
    });

    test('reads all three off the real quote, freight and unknowns aside', () => {
        expect(quotePipeTypes(QUOTE).sort()).toEqual(['erw', 'gi', 'seamless']);
    });

    test('a quote with no recognisable types gives an empty list', () => {
        expect(quotePipeTypes({ lineItems: [{ originalDescription: 'Freight' }] })).toEqual([]);
        expect(quotePipeTypes({})).toEqual([]);
        expect(quotePipeTypes(null)).toEqual([]);
    });
});

describe('suggestedSuppliers — this quote\'s pipe types first, then everyone else', () => {
    const SEED = {
        suppliers: [
            { email: 'everyone@steel.com', count: 9, lastUsed: '2026-07-30' },
            { email: 'GI-DEALER@steel.com', count: 5, lastUsed: '2026-07-29' },   // same as the gi bucket, different case
        ],
        byType: {
            gi: [{ email: 'gi-dealer@steel.com', count: 5, lastUsed: '2026-07-29' }],
            erw: [{ email: 'erw-dealer@steel.com', count: 2, lastUsed: '2026-07-28' }],
            seamless: [{ email: 'seamless-dealer@steel.com', count: 1, lastUsed: '2026-07-27' }],
        },
    };
    const giQuote = { lineItems: [{ identifiedPipeType: 'GI' }] };

    beforeEach(() => { _setSuggest(clone(SEED)); });
    afterAll(() => { _setSuggest(null); });

    test('the GI dealer for a GI quote outranks the more-used general supplier', () => {
        const out = suggestedSuppliers(giQuote, '');
        expect(out[0].email).toBe('gi-dealer@steel.com');
        expect(out.map((s) => s.email)).toContain('everyone@steel.com');
        expect(out.indexOf(out.find((s) => s.email === 'everyone@steel.com')))
            .toBeGreaterThan(0);
    });

    test('a mixed quote floats every one of its types above the general list', () => {
        const out = suggestedSuppliers(QUOTE, '').map((s) => s.email);
        expect(out.slice(0, 3).sort()).toEqual(['erw-dealer@steel.com', 'gi-dealer@steel.com', 'seamless-dealer@steel.com']);
        expect(out[3]).toBe('everyone@steel.com');
    });

    test('the same address is never offered twice, whatever its casing', () => {
        const out = suggestedSuppliers(giQuote, '').map((s) => s.email.toLowerCase());
        expect(out).toEqual(Array.from(new Set(out)));
        expect(out.filter((e) => e === 'gi-dealer@steel.com')).toHaveLength(1);
    });

    test('the typed query filters the list', () => {
        expect(suggestedSuppliers(QUOTE, 'erw').map((s) => s.email)).toEqual(['erw-dealer@steel.com']);
        expect(suggestedSuppliers(QUOTE, 'STEEL')).toHaveLength(4);        // case-insensitive
        expect(suggestedSuppliers(QUOTE, '  every  ').map((s) => s.email)).toEqual(['everyone@steel.com']);
        expect(suggestedSuppliers(QUOTE, 'nobody')).toEqual([]);
    });

    test('counts are carried through, defaulting to 0', () => {
        _setSuggest({ suppliers: [{ email: 'a@x.com' }], byType: { gi: [], erw: [], seamless: [] } });
        expect(suggestedSuppliers({}, '')).toEqual([{ email: 'a@x.com', count: 0 }]);
    });

    test('the list is capped so the dropdown cannot run off the screen', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ email: 'dealer' + i + '@steel.com', count: 1 }));
        _setSuggest({ suppliers: many, byType: { gi: [], erw: [], seamless: [] } });
        expect(suggestedSuppliers(QUOTE, '')).toHaveLength(12);
    });

    test('nothing remembered yet -> no suggestions, no crash', () => {
        _setSuggest(null);
        expect(suggestedSuppliers(QUOTE, '')).toEqual([]);
        _setSuggest({ suppliers: [], byType: {} });
        expect(suggestedSuppliers(QUOTE, '')).toEqual([]);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Supplier memory (routes/config.js)
// ══════════════════════════════════════════════════════════════════════════════

describe('normalizePipeType — three buckets, and only three', () => {
    test.each([
        ['GI', 'gi'], ['gi', 'gi'], ['Galvanised Iron', 'gi'],
        ['ERW', 'erw'], ['erw pipe', 'erw'],
        ['Seamless', 'seamless'], ['SEAMLESS', 'seamless'],
        ['6" NB X SCH 40', 'seamless'], ['Seamless Sch 40', 'seamless'],
    ])('%j -> %j', (input, expected) => {
        expect(normalizePipeType(input)).toBe(expected);
    });

    test.each([
        ['banana'], [''], ['   '], [null], [undefined], ['0'], ['{}'],
    ])('junk %j is rejected rather than bucketed', (input) => {
        expect(normalizePipeType(input)).toBe('');
    });

    test('it agrees with the client-side pipeTypeOf on the same descriptions', () => {
        ['GI', 'ERW', 'Seamless', '6" NB X SCH 40', '2" NB X Heavy -- GI', 'Miscellaneous fittings']
            .forEach((d) => expect(normalizePipeType(d)).toBe(pipeTypeOf({ originalDescription: d })));
    });
});

describe('mergeSupplierUsage — remember who was asked, per pipe type', () => {
    const TYPES = ['gi', 'erw', 'seamless'];

    test('one enquiry bumps the global list and the covered type', () => {
        const out = mergeSupplierUsage({}, { recipients: ['a@steel.com'], pipeTypes: ['GI'] });
        expect(out.suppliers).toEqual([expect.objectContaining({ email: 'a@steel.com', count: 1 })]);
        expect(out.byType.gi).toEqual([expect.objectContaining({ email: 'a@steel.com', count: 1 })]);
        expect(out.byType.erw).toEqual([]);
        expect(out.byType.seamless).toEqual([]);
        expect(out.suppliers[0].lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('several pipe types in one enquiry all get the supplier', () => {
        const out = mergeSupplierUsage({}, { recipients: ['a@steel.com'], pipeTypes: ['GI', 'ERW', 'Seamless'] });
        TYPES.forEach((t) => expect(out.byType[t].map((s) => s.email)).toEqual(['a@steel.com']));
    });

    test('a repeat enquiry bumps the count, and the most-used comes first', () => {
        let out = mergeSupplierUsage({}, { recipients: ['rare@steel.com'], pipeTypes: ['gi'] });
        out = mergeSupplierUsage(out, { recipients: ['often@steel.com'], pipeTypes: ['gi'] });
        out = mergeSupplierUsage(out, { recipients: ['often@steel.com'], pipeTypes: ['gi'] });
        expect(out.suppliers.map((s) => [s.email, s.count]))
            .toEqual([['often@steel.com', 2], ['rare@steel.com', 1]]);
        expect(out.byType.gi.map((s) => s.email)).toEqual(['often@steel.com', 'rare@steel.com']);
    });

    test('the singular pipeType form is honoured as well as pipeTypes', () => {
        const out = mergeSupplierUsage({}, { recipients: ['a@steel.com'], pipeType: 'erw' });
        expect(out.byType.erw.map((s) => s.email)).toEqual(['a@steel.com']);
        expect(out.byType.gi).toEqual([]);
    });

    test('no recipients changes nothing (a failed send must not be remembered)', () => {
        const existing = mergeSupplierUsage({}, { recipients: ['a@steel.com'], pipeTypes: ['gi'] });
        expect(mergeSupplierUsage(existing, { recipients: [], pipeTypes: ['gi'] })).toEqual(existing);
        expect(mergeSupplierUsage(existing, {})).toEqual(existing);
        expect(mergeSupplierUsage(existing, { recipients: ['', '   '] })).toEqual(existing);
    });

    test('junk pipe types still record the supplier globally, but bucket nothing', () => {
        const out = mergeSupplierUsage({}, { recipients: ['a@steel.com'], pipeTypes: ['banana', '', null] });
        expect(out.suppliers.map((s) => s.email)).toEqual(['a@steel.com']);
        TYPES.forEach((t) => expect(out.byType[t]).toEqual([]));
    });

    test('a fourth bucket can never appear, however it is asked for', () => {
        const out = mergeSupplierUsage(
            { suppliers: [], byType: { banana: [{ email: 'x@x.com', count: 3 }] } },
            { recipients: ['a@steel.com'], pipeTypes: ['banana', 'GI'] }
        );
        expect(Object.keys(out.byType).sort()).toEqual(TYPES.slice().sort());
        expect(JSON.stringify(out)).not.toContain('banana');
        expect(JSON.stringify(out)).not.toContain('x@x.com');
    });

    test('junk/absent existing memory is tolerated', () => {
        [null, undefined, 'not an object', 42, [], { byType: 'nope' }].forEach((existing) => {
            const out = mergeSupplierUsage(existing, { recipients: ['a@steel.com'], pipeTypes: ['gi'] });
            expect(Object.keys(out.byType).sort()).toEqual(TYPES.slice().sort());
            expect(out.suppliers.map((s) => s.email)).toEqual(['a@steel.com']);
        });
    });
});

describe('sanitizeSupplierSuggestions — always the three keys', () => {
    test.each([
        ['null', null], ['undefined', undefined], ['{}', {}],
        ['a string', 'nope'], ['a number', 7], ['an array', []],
        ['an unknown bucket', { byType: { banana: [{ email: 'x@x.com' }] } }],
    ])('%s still yields gi/erw/seamless', (_label, input) => {
        const out = sanitizeSupplierSuggestions(input);
        expect(Object.keys(out).sort()).toEqual(['byType', 'suppliers']);
        expect(Object.keys(out.byType).sort()).toEqual(['erw', 'gi', 'seamless']);
        expect(Array.isArray(out.suppliers)).toBe(true);
        Object.values(out.byType).forEach((v) => expect(Array.isArray(v)).toBe(true));
    });

    test('entries without an email address are dropped', () => {
        const out = sanitizeSupplierSuggestions({
            suppliers: [{ email: 'good@x.com', count: 2 }, { email: '  ' }, { count: 5 }, null],
            byType: { gi: [{ email: 'gi@x.com' }] },
        });
        expect(out.suppliers.map((s) => s.email)).toEqual(['good@x.com']);
        expect(out.byType.gi[0]).toEqual({ email: 'gi@x.com', count: 1, lastUsed: '' });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Routes
// ══════════════════════════════════════════════════════════════════════════════

/** In-memory DynamoDB that clones on read/write and honours the route's _rev condition. */
function makeDdb(store, opts = {}) {
    const stats = { conditionalFailures: 0, puts: 0 };
    const send = async (cmd) => {
        if (cmd.__type === 'Get') {
            if (opts.onGet) await opts.onGet();
            return { Item: clone(store[cmd.input.Key.id]) };
        }
        if (cmd.__type === 'Put') {
            const item = cmd.input.Item;
            const cond = cmd.input.ConditionExpression;
            if (cond) {
                const current = store[item.id];
                const ok = /#r = :prev/.test(cond)
                    ? (!!current && Number(current._rev) === cmd.input.ExpressionAttributeValues[':prev'])
                    : (!current || current._rev === undefined);
                if (!ok) {
                    stats.conditionalFailures++;
                    throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
                }
            }
            stats.puts++;
            store[item.id] = clone(item);
            return {};
        }
        if (cmd.__type === 'Query' || cmd.__type === 'Scan') return { Items: clone(Object.values(store)) };
        throw new Error('unexpected command: ' + cmd.__type);
    };
    return { send, stats };
}

function makeApp(store, opts = {}) {
    const app = express();
    app.use(express.json());
    const ddb = makeDdb(store, opts);
    app.use('/api', createQuotationsRouter({ ddbDocClient: { send: ddb.send }, ddbTableName: 'T', storage: null }));
    app.__stats = ddb.stats;
    return app;
}

function quoteItem(id, payload) {
    return { id, _entity: ENTITY_QUOTATION, updatedAt: '2026-07-30T12:00:00.000Z', payload: Object.assign({ id }, payload) };
}

const HEAVY = {
    lineItems: clone(QUOTE.lineItems),
    tableHTML: '<table>the real rows</table>',
    headerHTML: '<div>header</div>',
};

const enquirySeed = (extra) => ({
    q1: quoteItem('q1', Object.assign({ quoteNumber: 'DSC-700', companyName: 'Acme Engineering' }, clone(HEAVY), extra)),
});

/** Hold the first (n-1) callers until the n-th arrives — a guaranteed interleaving. */
function makeLatch(n) {
    let count = 0, released = false;
    const waiters = [];
    return async function wait() {
        if (released) return;
        count++;
        if (count >= n) { released = true; waiters.splice(0).forEach((r) => r()); return; }
        await new Promise((resolve) => waiters.push(resolve));
    };
}

const ENQ_A = { email: 'supplier-a@steel.com', threadId: 't-A', sentAt: '2026-07-31T09:00:00.000Z', replied: false, replyText: '', rate: 0 };
const ENQ_B = { email: 'supplier-b@steel.com', threadId: 't-B', sentAt: '2026-07-31T09:00:01.000Z', replied: false, replyText: '', rate: 0 };
const postEnq = (app, body, id = 'q1') => request(app).post('/api/quotations/' + id + '/supplier-enquiries').send(body);

describe('POST /quotations/:id/supplier-enquiries', () => {
    test('records the enquiry against the quote', async () => {
        const store = enquirySeed();
        const res = await postEnq(makeApp(store), { supplierEnquiries: [clone(ENQ_A)] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, count: 1 });
        expect(store.q1.payload.supplierEnquiries).toEqual([ENQ_A]);
    });

    test('a second sender who posts only its own entry does NOT erase the first', async () => {
        const store = enquirySeed({ supplierEnquiries: [clone(ENQ_A)] });
        const res = await postEnq(makeApp(store), { supplierEnquiries: [clone(ENQ_B)] });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(store.q1.payload.supplierEnquiries.map((t) => t.email).sort())
            .toEqual(['supplier-a@steel.com', 'supplier-b@steel.com']);
    });

    test('two senders at the same moment both keep their enquiry', async () => {
        const store = enquirySeed();
        const app = makeApp(store, { onGet: makeLatch(2) });
        const [a, b] = await Promise.all([
            postEnq(app, { supplierEnquiries: [clone(ENQ_A)] }),
            postEnq(app, { supplierEnquiries: [clone(ENQ_B)] }),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(store.q1.payload.supplierEnquiries.map((t) => t.threadId).sort()).toEqual(['t-A', 't-B']);
        expect(app.__stats.conditionalFailures).toBeGreaterThan(0);   // the retry loop earned its keep
    });

    test('an update to an existing threadId replaces that entry rather than duplicating it', async () => {
        const store = enquirySeed({ supplierEnquiries: [clone(ENQ_A)] });
        const res = await postEnq(makeApp(store), {
            supplierEnquiries: [Object.assign(clone(ENQ_A), { replied: true, replyText: 'Rs 62/kg ex-works', rate: 62 })],
        });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        const saved = store.q1.payload.supplierEnquiries;
        expect(saved).toHaveLength(1);
        expect(saved[0].threadId).toBe('t-A');
        expect(saved[0].replied).toBe(true);
        expect(saved[0].replyText).toBe('Rs 62/kg ex-works');
        expect(saved[0].rate).toBe(62);
    });

    test('an entry with no threadId is keyed by supplier + send time, so it is not duplicated', async () => {
        const noThread = { email: 'nothread@steel.com', threadId: '', sentAt: '2026-07-31T10:00:00.000Z', replied: false };
        const store = enquirySeed({ supplierEnquiries: [clone(noThread)] });
        await postEnq(makeApp(store), { supplierEnquiries: [Object.assign(clone(noThread), { replied: true })] });
        expect(store.q1.payload.supplierEnquiries).toHaveLength(1);
        expect(store.q1.payload.supplierEnquiries[0].replied).toBe(true);
    });

    test('the heavy fields survive — this is a field-only merge', async () => {
        const store = enquirySeed();
        await postEnq(makeApp(store), { supplierEnquiries: [clone(ENQ_A)] });
        expect(store.q1.payload.lineItems).toEqual(HEAVY.lineItems);
        expect(store.q1.payload.tableHTML).toBe(HEAVY.tableHTML);
        expect(store.q1.payload.headerHTML).toBe(HEAVY.headerHTML);
        expect(store.q1.payload.quoteNumber).toBe('DSC-700');
    });

    test.each([
        ['a string', { supplierEnquiries: 'supplier-a@steel.com' }],
        ['an object', { supplierEnquiries: { email: 'a@b.com' } }],
        ['null', { supplierEnquiries: null }],
        ['nothing at all', {}],
    ])('400 when supplierEnquiries is %s', async (_label, body) => {
        const store = enquirySeed();
        const res = await postEnq(makeApp(store), body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/must be an array/);
        expect(store.q1.payload.supplierEnquiries).toBeUndefined();
    });

    test('404 for a quote id that does not exist', async () => {
        const res = await postEnq(makeApp(enquirySeed()), { supplierEnquiries: [clone(ENQ_A)] }, 'nope');
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
});

describe('GET /quotations-filter?enquiry=1 — the Enquiry filter button', () => {
    const filterStore = () => ({
        'with-enquiry': quoteItem('with-enquiry', { quoteNumber: 'DSC-701', updatedAt: '2026-07-31T10:00:00.000Z', supplierEnquiries: [clone(ENQ_A)] }),
        'empty-array': quoteItem('empty-array', { quoteNumber: 'DSC-702', updatedAt: '2026-07-31T09:00:00.000Z', supplierEnquiries: [] }),
        'no-field': quoteItem('no-field', { quoteNumber: 'DSC-703', updatedAt: '2026-07-31T08:00:00.000Z' }),
    });

    test('returns the quote that has entries and not the one with an empty array', async () => {
        const res = await request(makeApp(filterStore())).get('/api/quotations-filter?enquiry=1');
        expect(res.status).toBe(200);
        expect(res.body.quotations.map((q) => q.id)).toEqual(['with-enquiry']);
    });

    test('a quote that never had the field is not returned either', async () => {
        const res = await request(makeApp(filterStore())).get('/api/quotations-filter?enquiry=1');
        expect(res.body.quotations.map((q) => q.id)).not.toContain('no-field');
    });

    test('an enquiry recorded through the route makes the quote appear on the filter', async () => {
        const store = filterStore();
        await postEnq(makeApp(store), { supplierEnquiries: [clone(ENQ_B)] }, 'empty-array');
        const res = await request(makeApp(store)).get('/api/quotations-filter?enquiry=1');
        expect(res.body.quotations.map((q) => q.id).sort()).toEqual(['empty-array', 'with-enquiry']);
    });

    test('the enquiry filter is independent of the freight one', async () => {
        const store = filterStore();
        store['with-enquiry'].payload.freightEnquiries = [];
        const freight = await request(makeApp(store)).get('/api/quotations-filter?freight=1');
        expect(freight.body.quotations).toEqual([]);
        const enquiry = await request(makeApp(store)).get('/api/quotations-filter?enquiry=1');
        expect(enquiry.body.quotations.map((q) => q.id)).toEqual(['with-enquiry']);
    });

    test('the client-side filter predicate agrees with the server', () => {
        // quote-enquiry-tab.js publishes window.quoteHasSupplierEnquiry for the list button.
        const hasEnquiry = global.window.quoteHasSupplierEnquiry;
        expect(typeof hasEnquiry).toBe('function');
        expect(hasEnquiry({ supplierEnquiries: [ENQ_A] })).toBe(true);
        expect(hasEnquiry({ supplierEnquiries: [] })).toBe(false);
        expect(hasEnquiry({})).toBe(false);
        expect(hasEnquiry(null)).toBe(false);
    });
});

describe('supplierEnquiries is projected into the list summary and owned by the server', () => {
    test('it is in SUMMARY_NESTED_PATHS, so the Enquiry filter works from the list alone', () => {
        const m = /const SUMMARY_NESTED_PATHS = \[([\s\S]*?)\n\];/.exec(quotesRouteSrc);
        expect(m).toBeTruthy();
        expect(m[1]).toContain("'supplierEnquiries'");
    });

    test('it is in SERVER_OWNED on POST /save-quotation', () => {
        const m = /const SERVER_OWNED = \[([^\]]*)\]/.exec(quotesRouteSrc);
        expect(m).toBeTruthy();
        expect(m[1]).toContain("'supplierEnquiries'");
    });

    test('a stale whole-object save cannot wipe a colleague\'s enquiries', async () => {
        const store = enquirySeed({ supplierEnquiries: [clone(ENQ_A), clone(ENQ_B)] });
        const res = await request(makeApp(store)).post('/api/save-quotation').send({
            // exactly what a tab that loaded the quote before the enquiry existed posts
            quotation: Object.assign({ id: 'q1', quoteNumber: 'DSC-700', checkedBy: 'PAVI' }, clone(HEAVY)),
        });
        expect(res.status).toBe(200);
        expect(store.q1.payload.supplierEnquiries).toEqual([ENQ_A, ENQ_B]);
        expect(store.q1.payload.checkedBy).toBe('PAVI');   // the real edit still lands
    });

    test('...and cannot overwrite them with its own version either', async () => {
        const store = enquirySeed({ supplierEnquiries: [clone(ENQ_A)] });
        await request(makeApp(store)).post('/api/save-quotation').send({
            quotation: Object.assign({ id: 'q1', supplierEnquiries: [] }, clone(HEAVY)),
        });
        expect(store.q1.payload.supplierEnquiries).toEqual([ENQ_A]);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. BCC send — one email per supplier, the supplier on Bcc
// ══════════════════════════════════════════════════════════════════════════════

/** Decode the base64url RFC 2822 message and return just its header block. */
function headersOf(raw) {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    return text.slice(0, text.indexOf('\r\n\r\n')).split('\r\n');
}

describe('buildRawMessage — a Bcc-only message is still well-formed', () => {
    const base = { subject: 'Enquiry — DSC-700', bodyHtml: '<p>Please quote.</p>' };

    // REPORTED: every supplier enquiry failed with "Failed to send email: Invalid To header".
    // This used to emit the RFC group placeholder "undisclosed-recipients:;" for a Bcc-only
    // message. That is valid by the spec, but the Gmail API refuses it. sendEmail now fills
    // `to` with our own address before building; buildRawMessage simply omits a To it does not
    // have, which Gmail accepts — rather than inventing one Gmail will reject.
    test('the placeholder Gmail rejects is never emitted', () => {
        const headers = headersOf(buildRawMessage(Object.assign({ bcc: 'supplier-a@steel.com' }, base)));
        expect(headers.join('\n')).not.toContain('undisclosed-recipients');
        expect(headers).toContain('Bcc: supplier-a@steel.com');
    });

    test('no To given: no To header at all, rather than an empty or invented one', () => {
        const headers = headersOf(buildRawMessage(Object.assign({ bcc: 'supplier-a@steel.com' }, base)));
        expect(headers.filter((h) => /^To:/.test(h))).toHaveLength(0);
        expect(headers.join('\n')).not.toContain('To: undefined');
        expect(headers.join('\n')).not.toMatch(/^To:\s*$/m);
    });

    test('an empty-string To (what the Enquiry tab posts) is treated the same', () => {
        const headers = headersOf(buildRawMessage(Object.assign({ to: '', bcc: 'supplier-a@steel.com' }, base)));
        expect(headers.filter((h) => /^To:/.test(h))).toHaveLength(0);
    });

    test('sendEmail addresses a message with no To to our own mailbox', () => {
        // Source guard: the fill happens in sendEmail, which needs a live Gmail client.
        // It must cover EVERY no-To shape — Bcc-only, Cc-only (the open one-email send),
        // or both — or that shape goes out with no To header at all.
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'utils', 'gmail.js'), 'utf8');
        expect(src).toContain('if (!to && (bcc || cc)) to = await getOwnAddress();');
        expect(src).toContain('gmail.users.getProfile({ userId: \'me\' })');
        // …and it must run BEFORE the message is built, or it would have no effect.
        const fn = src.slice(src.indexOf('async function sendEmail('));
        expect(fn.indexOf('getOwnAddress()')).toBeLessThan(fn.indexOf('buildRawMessage('));
    });

    test('a real To is used verbatim, with no placeholder', () => {
        const headers = headersOf(buildRawMessage(Object.assign({ to: 'customer@acme.com' }, base)));
        expect(headers[0]).toBe('To: customer@acme.com');
        expect(headers.join('\n')).not.toContain('undisclosed-recipients');
        expect(headers.some((h) => /^Bcc:/.test(h))).toBe(false);
    });

    test('To / Cc / Bcc are all emitted, in that order, when all three are given', () => {
        const headers = headersOf(buildRawMessage(Object.assign({
            to: 'customer@acme.com', cc: 'boss@dscpipes.com', bcc: 'supplier-a@steel.com',
        }, base)));
        expect(headers.slice(0, 3)).toEqual([
            'To: customer@acme.com', 'Cc: boss@dscpipes.com', 'Bcc: supplier-a@steel.com',
        ]);
    });

    test('the enquiry body still travels as the HTML part', () => {
        const raw = buildRawMessage(Object.assign({ bcc: 'supplier-a@steel.com' }, base));
        const text = Buffer.from(raw, 'base64url').toString('utf8');
        expect(text).toContain('Content-Type: text/html; charset=UTF-8');
        const body = text.slice(text.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '');
        expect(Buffer.from(body, 'base64').toString('utf8')).toBe('<p>Please quote.</p>');
    });
});

describe('POST /send-email — a Bcc-only supplier enquiry is accepted', () => {
    function gmailApp() {
        const app = express();
        app.use(express.json());
        app.use('/api', createGmailRouter());
        return app;
    }

    beforeEach(() => {
        mockSendEmail.mockReset();
        mockLookupMessageThread.mockReset();
        mockSendEmail.mockResolvedValue({ messageId: 'msg-1', threadId: 'thread-1' });
    });

    test('bcc alone is a legitimate recipient — not a 400', async () => {
        const res = await request(gmailApp()).post('/api/send-email').send({
            to: '', bcc: 'supplier-a@steel.com', subject: 'Enquiry — DSC-700', bodyHtml: '<p>Please quote.</p>',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.threadId).toBe('thread-1');
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ bcc: 'supplier-a@steel.com' }));
    });

    test('the reply id comes back so the tab can watch that thread', async () => {
        const res = await request(gmailApp()).post('/api/send-email').send({
            bcc: 'supplier-a@steel.com', subject: 'E', bodyHtml: '<p>x</p>',
        });
        expect(res.body.messageId).toBe('msg-1');
        expect(res.body.sentTo).toBe('supplier-a@steel.com');   // falls back to bcc for the log line
    });

    test('cc alone is accepted too', async () => {
        const res = await request(gmailApp()).post('/api/send-email').send({
            cc: 'boss@dscpipes.com', subject: 'E', bodyHtml: '<p>x</p>',
        });
        expect(res.status).toBe(200);
    });

    test('but a send with nobody at all is still rejected', async () => {
        const res = await request(gmailApp()).post('/api/send-email').send({
            subject: 'E', bodyHtml: '<p>x</p>',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/to, cc, bcc or replyToMessageId is required/);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('empty strings for every recipient field count as nobody', async () => {
        const res = await request(gmailApp()).post('/api/send-email').send({
            to: '', cc: '', bcc: '', subject: 'E', bodyHtml: '<p>x</p>',
        });
        expect(res.status).toBe(400);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('the tab really posts one bcc recipient per email, with an empty To', () => {
        // Source guard: the send loop in quote-enquiry-tab.js is what depends on the two rules above.
        // Asserted piecewise rather than as one literal so that adding a field to the payload
        // (the Gmail `label`, or the user's own Cc/Bcc) doesn't fail a test that is really about
        // "one email per supplier, supplier on Bcc, To left empty".
        expect(tabSrc).toContain('Promise.all(sends.map(function (addr) {');
        // Each Bcc email carries exactly ONE supplier — that email's own recipient. Anything
        // that put the hidden list on one message would let suppliers see each other and would
        // break the per-supplier reply tracking. (The cc-only branch is one OPEN email by
        // design — visibility is the whole point of Cc.)
        expect(tabSrc).toMatch(/: \{ to: '', cc: extra\.cc, bcc: addr,/);
    });
});

// ── Latest sent enquiry first ─────────────────────────────────────────────────────────
//
// The list was in the order the sends happened, so the newest supplier ended up at the
// bottom — the wrong way round for a list you scan to see who has come back. Sorting has one
// trap: the row index keys st.openReplies AND the "Read reply" button's data-i, so sorting
// the array itself would open a DIFFERENT supplier's reply than the one clicked. The index
// is carried alongside instead.

describe('threadsHtml — newest send at the top, replies still correctly wired', () => {
    const src2 = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');
    function cut(name) {
        const i = src2.indexOf('function ' + name + '(');
        const o = src2.indexOf('{', i);
        let d = 0;
        for (let k = o; k < src2.length; k++) {
            if (src2[k] === '{') d++;
            else if (src2[k] === '}') { d--; if (!d) return src2.slice(i, k + 1); }
        }
        throw new Error('not found: ' + name);
    }
    // eslint-disable-next-line no-new-func
    const threadsHtml = new Function(
        'function escTxt(v){return String(v==null?"":v);}\n'
        + 'function getThreads(q){return q.supplierEnquiries||[];}\n'
        + cut('threadsHtml') + '\nreturn threadsHtml;')();

    const QUOTE = { supplierEnquiries: [
        { email: 'oldest@a.com', sentAt: '2026-03-01T09:00:00.000Z', replied: true, replyText: 'FROM OLDEST' },
        { email: 'middle@b.com', sentAt: '2026-03-05T09:00:00.000Z', replied: false },
        { email: 'newest@c.com', sentAt: '2026-03-09T09:00:00.000Z', replied: true, replyText: 'FROM NEWEST' },
    ] };
    const emailsIn = (html) => (html.match(/qet-th-email">([^<]+)/g) || []).map((s) => s.split('>')[1]);

    test('the most recent send is listed first', () => {
        expect(emailsIn(threadsHtml(QUOTE, { openReplies: {} })))
            .toEqual(['newest@c.com', 'middle@b.com', 'oldest@a.com']);
    });

    test('"Read reply" keeps each supplier\'s ORIGINAL index, so it opens the right reply', () => {
        const html = threadsHtml(QUOTE, { openReplies: {} });
        // newest is array index 2, oldest is 0 — and they appear in that display order.
        expect((html.match(/data-i="(\d+)"/g) || [])).toEqual(['data-i="2"', 'data-i="0"']);
        const opened = threadsHtml(QUOTE, { openReplies: { 2: true } });
        expect(opened).toContain('FROM NEWEST');
        expect(opened).not.toContain('FROM OLDEST');
    });

    test('a send with no timestamp still renders rather than disappearing', () => {
        const q = { supplierEnquiries: [
            { email: 'undated@x.com' },
            { email: 'dated@y.com', sentAt: '2026-03-01T09:00:00.000Z' },
        ] };
        expect(emailsIn(threadsHtml(q, { openReplies: {} })).sort())
            .toEqual(['dated@y.com', 'undated@x.com']);
    });

    test('the stored order itself is untouched — only the display is reordered', () => {
        const before = QUOTE.supplierEnquiries.map((t) => t.email);
        threadsHtml(QUOTE, { openReplies: {} });
        expect(QUOTE.supplierEnquiries.map((t) => t.email)).toEqual(before);
    });
});

// ── Pulling supplier replies ──────────────────────────────────────────────────────────
//
// Mirrors checkFreightRepliesForQuote, with one deliberate difference: NO rate parsing. A
// transporter quotes one freight figure worth extracting; a supplier's reply is a price list
// against many sizes, so guessing a single number from it would be worse than useless.
// Requested behaviour: reply text only, run automatically when the app opens.

describe('checkSupplierRepliesForQuote', () => {
    const src3 = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');
    function cut(name) {
        const i = src3.indexOf('function ' + name + '(');
        const o = src3.indexOf('{', i);
        let d = 0;
        for (let k = o; k < src3.length; k++) {
            if (src3[k] === '{') d++;
            else if (src3[k] === '}') { d--; if (!d) return src3.slice(i, k + 1); }
        }
        throw new Error('not found: ' + name);
    }
    // MAX_REPLY_CHARS is a module-level var, so it must be supplied alongside the extracted
    // functions — without it trimReplyForStorage throws, the catch swallows it, and the check
    // silently reports "no new replies" after half-updating the thread. (That happened while
    // building this: the harness, not the shipped code, but the failure mode is worth pinning.)
    // saveOk mimics the real persistThreads, which answers a PROMISE of whether the write
    // landed. The directory is now told about a reply only once that promise says yes.
    function load(fetchStub, persisted, saveOk = true) {
        // eslint-disable-next-line no-new-func
        return new Function('fetchStub', 'persisted', 'saveOk',
            'function apiBase(){return "/api";}\n'
            + 'function getThreads(q){return q.supplierEnquiries||[];}\n'
            + 'function persistThreads(q){persisted.push(q); return Promise.resolve(saveOk);}\n'
            // The sweep now also repaints an Enquiry tab that happens to be open. That needs the
            // DOM, so it is stubbed out here — this suite tests the reply-reading logic only.
            + 'function repaintOpenTab(){}\n'
            + 'var MAX_REPLY_CHARS = 2000;\n'
            + 'var fetch = fetchStub;\n'
            // The REAL directory hook, not a stub: it must no-op safely without a DOM, and
            // running it here is what proves that. A stub would hide exactly the bug it
            // guards against (an unguarded window reference blowing up the reply sweep).
            + cut('tellDirectoryReplied') + '\n'
            + cut('trimReplyForStorage') + '\n' + cut('checkSupplierRepliesForQuote') + '\n'
            + 'return checkSupplierRepliesForQuote;')(fetchStub, persisted, saveOk);
    }
    const reply = (msgs) => () => Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: msgs }) });

    test('stores the reply, dated from the Gmail header, and persists once', async () => {
        const calls = [], persisted = [];
        const run = load((url) => { calls.push(url); return reply([
            { direction: 'you', auto: false, body: 'our enquiry' },
            { direction: 'customer', auto: false, date: 'Tue, 5 Aug 2026 10:00:00 +0530', body: '2 inch @ Rs 62/kg' },
        ])(); }, persisted);
        const q = { id: 1, supplierEnquiries: [{ email: 'a@x.com', threadId: 'T1', replied: false, replyText: '', rate: 0 }] };
        await expect(run(q)).resolves.toEqual({ checked: 1, newReplies: 1, failed: 0 });
        expect(calls).toEqual(['/api/thread-messages?threadId=T1']);
        expect(q.supplierEnquiries[0]).toMatchObject({
            replied: true, replyAt: 'Tue, 5 Aug 2026 10:00:00 +0530', replyText: '2 inch @ Rs 62/kg',
        });
        expect(persisted).toHaveLength(1);
    });

    test('NO rate is guessed from a supplier reply, even when it names a price', async () => {
        const run = load(reply([{ direction: 'customer', auto: false, body: 'Rs 18,500 for the lot' }]), []);
        const q = { id: 1, supplierEnquiries: [{ threadId: 'T1', replied: false, rate: 0 }] };
        await run(q);
        expect(q.supplierEnquiries[0].rate).toBe(0);
    });

    test('our own send and auto-replies are not mistaken for a supplier answer', async () => {
        const persisted = [];
        const run = load(reply([
            { direction: 'you', auto: false, body: 'our enquiry' },
            { direction: 'customer', auto: true, body: 'OUT OF OFFICE' },
        ]), persisted);
        const q = { id: 1, supplierEnquiries: [{ threadId: 'T1', replied: false }] };
        await expect(run(q)).resolves.toEqual({ checked: 1, newReplies: 0, failed: 0 });
        expect(q.supplierEnquiries[0].replied).toBeFalsy();
        expect(persisted).toHaveLength(0);      // nothing changed -> no write
    });

    test('the quoted chain of our own enquiry is cut off the stored reply', async () => {
        const run = load(reply([{ direction: 'customer', auto: false,
            body: '2 inch @ Rs 62/kg\nOn Mon, 4 Aug 2026 wrote:\n> our original enquiry' }]), []);
        const q = { id: 1, supplierEnquiries: [{ threadId: 'T1', replied: false }] };
        await run(q);
        expect(q.supplierEnquiries[0].replyText).toBe('2 inch @ Rs 62/kg');
    });

    test('a very long reply is capped and says so', async () => {
        const run = load(reply([{ direction: 'customer', auto: false, body: 'x'.repeat(5000) }]), []);
        const q = { id: 1, supplierEnquiries: [{ threadId: 'T1', replied: false }] };
        await run(q);
        expect(q.supplierEnquiries[0].replyText).toContain('[truncated]');
        expect(q.supplierEnquiries[0].replyText.length).toBeLessThan(2100);
    });

    test('only threads still awaiting AND carrying a threadId are polled', async () => {
        const calls = [];
        const run = load((url) => { calls.push(url); return reply([])(); }, []);
        const q = { id: 1, supplierEnquiries: [
            { threadId: 'T1', replied: false },                        // polled
            { threadId: 'T2', replied: true, replyText: 'kept' },       // already answered
            { threadId: '',  replied: false },                          // never got a thread
        ] };
        await run(q);
        expect(calls).toEqual(['/api/thread-messages?threadId=T1']);
        expect(q.supplierEnquiries[1].replyText).toBe('kept');
    });

    test('a failed lookup is REPORTED as failed, not as "no reply"', async () => {
        // Both used to come back the same, so "No new replies." was what you were told whether
        // the inbox was quiet or Gmail never answered at all. Suppliers then looked like they
        // were ignoring you, and their reply rates sat at 0% while the directory ranked on it.
        const persisted = [];
        const run = load(() => Promise.reject(new Error('network')), persisted);
        const q = { id: 1, supplierEnquiries: [{ threadId: 'T1', replied: false }] };
        await expect(run(q)).resolves.toEqual({ checked: 1, newReplies: 0, failed: 1 });
        expect(q.supplierEnquiries[0].replied).toBeFalsy();   // still awaiting, for the retry
        expect(persisted).toHaveLength(0);
    });

    test('a quote with nothing awaiting does no work at all', async () => {
        const calls = [];
        const run = load((url) => { calls.push(url); return reply([])(); }, []);
        await expect(run({ id: 1, supplierEnquiries: [] })).resolves.toEqual({ checked: 0, newReplies: 0 });
        await expect(run({ id: 2 })).resolves.toEqual({ checked: 0, newReplies: 0 });
        expect(calls).toEqual([]);
    });
});

describe('source guard — supplier replies are pulled when the app opens', () => {
    const fs4 = require('fs');
    const path4 = require('path');
    const html5 = fs4.readFileSync(path4.join(__dirname, '..', 'index.html'), 'utf8');
    const tab = fs4.readFileSync(path4.join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');

    test('the sweep includes suppliers, and NOT only on an explicit click', () => {
        const fn = html5.slice(html5.indexOf('async function checkAllReplies('));
        const body = fn.slice(0, fn.indexOf('\n        }'));
        expect(body).toContain('window.quoteAwaitsSupplierReply');
        expect(body).toContain('window.checkSupplierRepliesForQuote(q)');
        // Customer threads are deliberately click-only (`background ? [] : …`). Suppliers must
        // NOT be gated that way, or they would never run on open.
        expect(body).not.toMatch(/supplierQuotes\s*=\s*background\s*\?/);
        expect(body).toContain('const total = freightNew + supplierNew + custNew;');
    });

    test('the module exposes what the sweep calls', () => {
        expect(tab).toContain('window.checkSupplierRepliesForQuote = checkSupplierRepliesForQuote;');
        expect(tab).toContain('window.quoteAwaitsSupplierReply = quoteAwaitsSupplierReply;');
    });
});

describe('source guard — the Enquiry recipient box uses the SAME dropdown as Freight', () => {
    const fsG = require('fs');
    const pathG = require('path');
    const tabG = fsG.readFileSync(pathG.join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');
    const freightG = fsG.readFileSync(pathG.join(__dirname, '..', 'freight-tab-weight-editor.js'), 'utf8');

    test('both tabs attach the shared Gmail-contact autocomplete', () => {
        // Freight had it; Enquiry never called it, so the box only ever offered the remembered
        // list as small chips — an address never emailed before could not be completed at all.
        expect(freightG).toContain('attachContactAutocomplete(');
        expect(tabG).toContain('attachContactAutocomplete(');
    });

    test('the Enquiry local source is the remembered suppliers, in {name,email} shape', () => {
        // Anchor on the TO field's call specifically. Cc/Bcc also attach the dropdown now (and
        // appear earlier in the file), so "the first occurrence" would test the wrong one — they
        // deliberately pass no local source, since a colleague is not a remembered supplier.
        const marker = 'attachContactAutocomplete(input.parentElement || input, input, addRecip,';
        expect(tabG).toContain(marker);
        const call = tabG.slice(tabG.indexOf(marker), tabG.indexOf(marker) + 500);
        expect(call).toContain('suggestedSuppliers(quotation, query)');
        expect(call).toContain("return { name: '', email: s.email };");
        // Anyone already on the recipient (Bcc) list must not be offered again.
        expect(call).toContain('st.bcc.indexOf(s.email) === -1');
    });

    test('it degrades quietly if the shared helper is not loaded', () => {
        expect(tabG).toContain("typeof attachContactAutocomplete === 'function'");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// One chip, several people — Send must not treat a firm's chip as one address
// ─────────────────────────────────────────────────────────────────────────────

describe('a firm with two contacts can still be sent to', () => {
    // Reported live: picking a supplier where two people were ticked put both in ONE chip
    // (that is the per-firm rule — everyone at one firm on one email, Cc'd together), and the
    // Send button then greyed out with nothing on screen saying why. The only way out was to
    // delete the chip and type the addresses separately, which sends two emails and loses the
    // whole point. The Freight tab always read chips this way; this tab did not.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');

    /** Pull a real function out of the shipped file by brace-matching, never a copy. */
    function grab(name) {
        const start = src.indexOf('function ' + name + '(');
        if (start === -1) throw new Error('no such function: ' + name);
        let depth = 0;
        for (let i = src.indexOf('{', start); i < src.length; i++) {
            if (src[i] === '{') depth++;
            if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
        }
        throw new Error('unterminated: ' + name);
    }

    // eslint-disable-next-line no-eval
    const scope = eval('(function () {'
        // The REAL isEmail, not a lookalike — a re-implementation here could pass while the
        // shipped one rejected the very addresses this test says are fine.
        + grab('isEmail')
        + grab('chipAddrs') + grab('chipIsSendable')
        + 'return { chipAddrs: chipAddrs, chipIsSendable: chipIsSendable };'
        + '})()');

    test('a chip holding two addresses at one firm is sendable', () => {
        expect(scope.chipIsSendable('manish@jcopipe.com, cp@jcopipe.com')).toBe(true);
        expect(scope.chipIsSendable('a@m.com; b@m.com; c@m.com')).toBe(true);
    });

    test('a single address is still sendable, and rubbish still is not', () => {
        // Both directions, or a guard that simply returned true would pass the test above.
        expect(scope.chipIsSendable('ravi@mill.com')).toBe(true);
        expect(scope.chipIsSendable('manish@jcopipe.com, notanemail')).toBe(false);
        expect(scope.chipIsSendable('')).toBe(false);
        expect(scope.chipIsSendable('   ')).toBe(false);
    });

    test('BOTH gates read the chip the same way — the button and the send itself', () => {
        // The greyed-out button and the guard inside the send were separate checks; fixing one
        // and not the other swaps a dead button for a refusal after the click.
        expect(src).toContain('st.bcc.concat(st.cc).every(chipIsSendable)');
        expect(src.match(/every\(chipIsSendable\)/g)).toHaveLength(2);
        // ...and neither call site still reads the chip as a single address. (chipIsSendable
        // uses parts.every(isEmail) internally, which is right — the call SITES must not.)
        expect(src).not.toContain('st.bcc.concat(st.cc).every(isEmail)');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adding a SECOND supplier, and pressing Send a second time
// ─────────────────────────────────────────────────────────────────────────────

/** Pull a real function out of the shipped tab file by brace-matching, never a copy. */
function grabFromTab(name) {
    const start = tabSrc.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('no such function: ' + name);
    let depth = 0;
    for (let i = tabSrc.indexOf('{', start); i < tabSrc.length; i++) {
        if (tabSrc[i] === '{') depth++;
        if (tabSrc[i] === '}' && --depth === 0) return tabSrc.slice(start, i + 1);
    }
    throw new Error('unterminated: ' + name);
}

describe('addChip — one firm can never end up on two chips', () => {
    // Each chip is its own email. Matching on the chip STRING meant picking a firm twice —
    // once with one contact ticked, once with two — left "a@x.com" and "a@x.com, b@x.com" side
    // by side, so that firm got the SAME enquiry twice and its own colleagues were split
    // across the two mails. That is the exact opposite of the one-firm-one-email rule.
    const { addChip } = tab;

    test('picking the firm again with another contact merges into its existing chip', () => {
        const bcc = [];
        addChip(bcc, 'manish@jcopipe.com');
        addChip(bcc, 'manish@jcopipe.com, cp@jcopipe.com');
        expect(bcc).toEqual(['manish@jcopipe.com, cp@jcopipe.com']);
    });

    test('the merge works the other way round too', () => {
        const bcc = [];
        addChip(bcc, 'manish@jcopipe.com, cp@jcopipe.com');
        addChip(bcc, 'cp@jcopipe.com');
        expect(bcc).toEqual(['manish@jcopipe.com, cp@jcopipe.com']);
    });

    test('a different firm still gets its own chip — one email each', () => {
        const bcc = [];
        addChip(bcc, 'a@annai.com');
        addChip(bcc, 'ravi@mill.com');
        expect(bcc).toEqual(['a@annai.com', 'ravi@mill.com']);
    });

    test('the same person twice, in any case, changes nothing', () => {
        const bcc = [];
        expect(addChip(bcc, 'A@Annai.com')).toBe(true);
        expect(addChip(bcc, 'a@annai.com')).toBe(false);
        expect(bcc).toEqual(['A@Annai.com']);
    });

    test('nothing at all is not a chip', () => {
        const bcc = [];
        expect(addChip(bcc, '')).toBe(false);
        expect(addChip(bcc, '  ')).toBe(false);
        expect(bcc).toEqual([]);
    });
});

describe('Send goes dead after a send that worked', () => {
    // Reported: a Bcc send empties Bcc but leaves the Cc'd colleague, so Send stayed blue right
    // under the green tick. An unsure second press mailed that colleague ALONE — a fresh open
    // email, a new "awaiting reply" row, and a directory record saying they were asked.
    const { canSendNow } = tab;
    const st = (over) => Object.assign(
        { bcc: [], cc: [], sending: false, sentLock: false, rows: [{}] }, over);

    test('a recipient and a row is enough to send', () => {
        expect(canSendNow(st({ bcc: ['a@x.com'] }))).toBe(true);
        expect(canSendNow(st({ cc: ['a@x.com'] }))).toBe(true);
    });

    test('the leftover Cc cannot re-arm Send after the enquiry has gone', () => {
        expect(canSendNow(st({ bcc: [], cc: ['colleague@dscpipes.com'], sentLock: true }))).toBe(false);
    });

    test('changing the recipients clears the lock, so a real second enquiry can go', () => {
        expect(canSendNow(st({ bcc: ['new@firm.com'], cc: ['colleague@dscpipes.com'] }))).toBe(true);
    });

    test('a clean send sets the lock — and a part-failed one does not', () => {
        const doSend = grabFromTab('doSend');
        const clean = doSend.slice(doSend.indexOf('if (!failed.length) {'),
            doSend.indexOf('} else if (sentOk.length)'));
        expect(clean).toContain('st.sentLock = true;');
        // Only there. A send that failed for two of five firms must stay retryable.
        expect(doSend.match(/st\.sentLock = true;/g)).toHaveLength(1);
    });

    test('the old blocks are all still blocks', () => {
        expect(canSendNow(st({}))).toBe(false);                                  // nobody to send to
        expect(canSendNow(st({ bcc: ['a@x.com'], rows: [] }))).toBe(false);       // nothing to ask for
        expect(canSendNow(st({ bcc: ['a@x.com'], sending: true }))).toBe(false);  // already going
        expect(canSendNow(st({ bcc: ['not an email'] }))).toBe(false);            // a typo anywhere
    });
});

describe('one open email is confirmed before it goes', () => {
    // Bcc empty means the Cc list IS the send: ONE email where every firm sees the others.
    // That is the one thing the owner said must never happen, and the only warning beforehand
    // was a small grey line.
    function load(answer, asked) {
        // eslint-disable-next-line no-new-func
        return new Function('answer', 'asked',
            'var window = { confirm: function (m) { asked.push(m); return answer; } };\n'
            + grabFromTab('confirmOpenCcSend') + '\nreturn confirmOpenCcSend;')(answer, asked);
    }

    test('two firms in Cc with Bcc empty is asked about, and they are named', () => {
        const asked = [];
        expect(load(true, asked)({ bcc: [], cc: ['a@one.com', 'b@two.com'] })).toBe(true);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain('a@one.com');
        expect(asked[0]).toContain('b@two.com');
    });

    test('saying no stops the send', () => {
        expect(load(false, [])({ bcc: [], cc: ['a@one.com', 'b@two.com'] })).toBe(false);
    });

    test('the ordinary Bcc send is never interrupted', () => {
        const asked = [];
        expect(load(false, asked)({ bcc: ['a@one.com'], cc: ['colleague@dscpipes.com', 'x@y.com'] })).toBe(true);
        expect(asked).toEqual([]);
    });

    test('and the send really does ask, rather than only being able to', () => {
        expect(grabFromTab('sendEnquiry')).toContain('if (!confirmOpenCcSend(st)) return;');
    });

    test('one address in Cc on its own is not an open email to anyone', () => {
        const asked = [];
        expect(load(false, asked)({ bcc: [], cc: ['a@one.com'] })).toBe(true);
        expect(asked).toEqual([]);
    });
});

describe('checkResultText — a Gmail failure never reads as "nobody answered"', () => {
    const { checkResultText } = tab;

    test('a clean read with nothing new says so', () => {
        expect(checkResultText({ checked: 3, newReplies: 0, failed: 0 })).toBe('No new replies yet.');
    });

    test('a failed read says it failed, and never "No new replies"', () => {
        const msg = checkResultText({ checked: 2, newReplies: 0, failed: 2 });
        expect(msg).toContain('Could not read Gmail');
        expect(msg).toContain('2 suppliers');
        expect(msg).not.toContain('No new replies');
    });

    test('a find and a failure in the same sweep are both reported', () => {
        const msg = checkResultText({ checked: 2, newReplies: 1, failed: 1 });
        expect(msg).toContain('1 new reply came in.');
        expect(msg).toContain('1 supplier');
    });

    test('replies found are counted in plain words', () => {
        expect(checkResultText({ newReplies: 2, failed: 0 })).toBe('2 new replies came in.');
    });
});

describe('source guard — the Enquiry tab has its own "Check for replies" button', () => {
    // The Freight tab has had one all along. Here the only way to pull a reply was to reload
    // the whole app, or find the global "Check all replies" far up beside the month filters.
    // The REAL threadsHtml, run for its output — a source guard alone passes happily while the
    // button is built and then left out of the returned HTML.
    // eslint-disable-next-line no-new-func
    const threadsHtml = new Function(
        grabFromTab('escTxt') + '\n'
        + 'function getThreads(q){ return q.supplierEnquiries || []; }\n'
        + grabFromTab('threadsHtml') + '\n'
        + 'return threadsHtml;')();
    const st = (over) => Object.assign({ openReplies: {}, checking: false, checkResult: '' }, over);
    const waiting = { supplierEnquiries: [{ email: 'a@x.com', threadId: 'T1', replied: false }] };

    test('the button is on screen while anyone is still awaited', () => {
        const html = threadsHtml(waiting, st());
        expect(html).toContain('qet-check');
        expect(html).toContain('Check for replies');
    });

    test('it disables itself and says what it is doing while it reads', () => {
        const html = threadsHtml(waiting, st({ checking: true }));
        expect(html).toContain('disabled');
        expect(html).toContain('Checking');
    });

    test('what the read found is printed under it', () => {
        const html = threadsHtml(waiting, st({ checkResult: 'No new replies yet.' }));
        expect(html).toContain('No new replies yet.');
    });

    test('once everyone has replied there is nothing left to press', () => {
        const done = { supplierEnquiries: [{ email: 'a@x.com', threadId: 'T1', replied: true }] };
        expect(threadsHtml(done, st())).not.toContain('qet-check');
    });

    test('the button is wired to the real reply reader', () => {
        expect(tabSrc).toContain("checkBtn.onclick = function () { checkSupplierReplies(quotation, st, mountEl); }");
        expect(grabFromTab('checkSupplierReplies')).toContain('checkSupplierRepliesForQuote(q)');
    });

    test('a read that failed is counted as failed, not as "no reply"', () => {
        // res.ok === false used to fall through to `return false` — the same value as a thread
        // nobody has answered — so Gmail being down read as "nobody answered you".
        const fn = grabFromTab('checkSupplierRepliesForQuote');
        // Both exits must say it: the unreadable answer AND the request that never landed.
        // Asserting the bare string was worthless — the catch already carried it, so putting
        // the bug back passed. (Found by mutation-checking this very test.)
        expect(fn).toContain("if (!data || !Array.isArray(data.messages)) return 'failed';");
        expect(fn.match(/return 'failed'/g)).toHaveLength(2);
    });
});

describe('source guard — picking a supplier keeps the ranked list on screen', () => {
    // render() rebuilds the whole tab, including an EMPTY "Ask AI" panel. addTo called it on
    // every pick, so the ranked list vanished and adding a second supplier meant asking again.
    test('adding a recipient repaints only the chips', () => {
        const addTo = grabFromTab('addTo');
        expect(addTo).toContain('paintChips(kind)');
        expect(addTo).not.toContain('render(quotation, mountEl)');
    });

    test('a pasted list of addresses does the same', () => {
        const addTypedList = grabFromTab('addTypedList');
        expect(addTypedList).toContain('paintChips(kind)');
        expect(addTypedList).not.toContain('render(quotation, mountEl)');
    });

    test('both routes in add the address way, so one firm stays on one chip', () => {
        expect(grabFromTab('addTo')).toContain('addChip(listFor(st, kind), email)');
        expect(grabFromTab('addTypedList')).toContain('addChip(list, email)');
        expect(tabSrc).not.toContain('if (list.indexOf(email) === -1) list.push(email)');
    });
});

describe('a reply is counted only after the "answered" flag has saved', () => {
    // If that write is lost, the next sweep finds the same reply again. Counting it now takes
    // the firm's replied % past 100 with nothing on the card to explain it.
    function load(saveOk, told) {
        // eslint-disable-next-line no-new-func
        return new Function('saveOk', 'told',
            'function apiBase(){return "/api";}\n'
            + 'function getThreads(q){return q.supplierEnquiries||[];}\n'
            + 'function persistThreads(q){return Promise.resolve(saveOk);}\n'
            + 'function repaintOpenTab(){}\n'
            + 'var MAX_REPLY_CHARS = 2000;\n'
            // A stub window, so the REAL tellDirectoryReplied actually reaches the directory.
            + 'var window = { partnerDirectory: { recordUsage: function (u) { told.push(u); } } };\n'
            + 'var fetch = function () { return Promise.resolve({ ok: true, json: function () {\n'
            + '  return Promise.resolve({ messages: [{ direction: "customer", auto: false, body: "Rs 62/kg" }] });\n'
            + '} }); };\n'
            + grabFromTab('repliedThreadsForUsage') + '\n'
            + grabFromTab('tellDirectoryReplied') + '\n'
            + grabFromTab('trimReplyForStorage') + '\n'
            + grabFromTab('checkSupplierRepliesForQuote') + '\n'
            + 'return checkSupplierRepliesForQuote;')(saveOk, told);
    }
    const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
    const quote = () => ({ id: 1, supplierEnquiries: [{ email: 'a@x.com', threadId: 'T1', replied: false }] });

    test('the save landed — the directory is told once', async () => {
        const told = [];
        await load(true, told)(quote());
        await settle();
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({ kind: 'reply', emails: ['a@x.com'] });
    });

    test('the save was lost — nothing is counted, so the next sweep can find it again', async () => {
        const told = [];
        await load(false, told)(quote());
        await settle();
        expect(told).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Gmail-label script that feeds the Partner Directory
// ─────────────────────────────────────────────────────────────────────────────

describe('SendDirectoryEmailsToApp.gs — the labelled reply, and every attachment', () => {
    const vm = require('vm');
    const gsSrc = fs.readFileSync(path.join(ROOT, 'apps-script', 'SendDirectoryEmailsToApp.gs'), 'utf8');
    // Apps Script cannot run here, so the file is parsed and its pure helpers exercised.
    const ctx = { Logger: { log() {} } };
    vm.createContext(ctx);
    new vm.Script(gsSrc, { filename: 'SendDirectoryEmailsToApp.gs' }).runInContext(ctx);

    const att = (name, size) => ({ getName: () => name, getSize: () => size });
    const msg = (attachments) => ({ getAttachments: () => attachments });

    test('a reply in an old thread is read, not our own enquiry at the top of it', () => {
        // Labels sit on the THREAD. messages[0] is the OLDEST — in a reply that is our own
        // outgoing enquiry, so the rate list he attached was never looked at and the card
        // came back carrying our own address.
        // BOTH messages carry a PDF here — our quotation went out as one. With only his
        // carrying a file, a first-to-last scan finds the same message and the test proves
        // nothing. (Found by mutation-checking this test.)
        const ours = msg([att('DSC-108.pdf', 200000)]);
        const his = msg([att('rates.pdf', 400000)]);
        expect(ctx.pickMessage_([ours, his])).toBe(his);
    });

    test('with no attachment anywhere, the newest message is still the one meant', () => {
        const first = msg([]); const last = msg([]);
        expect(ctx.pickMessage_([first, last])).toBe(last);
    });

    test('an empty thread is nothing to send, not a crash', () => {
        expect(ctx.pickMessage_([])).toBe(null);
    });

    test('the files that were not read are named', () => {
        // Three rate lists in one email, or an .xlsx one, used to vanish without a word — the
        // card was then built from the covering note alone and looked complete.
        const names = ctx.skippedNames_(
            [att('gi.pdf', 900000), att('erw.pdf', 500000), att('rates.xlsx', 300000)], 'gi.pdf');
        expect(names).toEqual(['erw.pdf', 'rates.xlsx']);
    });

    test('an email whose only rate list is a spreadsheet says so', () => {
        expect(ctx.skippedNames_([att('rates.xlsx', 300000)], '')).toEqual(['rates.xlsx']);
    });

    test('signature artwork is not reported as a dropped rate list', () => {
        expect(ctx.skippedNames_([att('image001.png', 4000), att('logo.png', 9000)], '')).toEqual([]);
    });

    test('the skipped names travel with the email', () => {
        expect(gsSrc).toContain('skippedNames_(attachments, firstFile)');
        expect(gsSrc).toContain('[Not read: ');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// One firm, one chip — and one send
// ─────────────────────────────────────────────────────────────────────────────

describe('a supplier can never end up on two chips', () => {
    // Reported by the review: addChip merged an incoming chip into the FIRST existing chip
    // holding any of its people, and left the others where they were. Two colleagues added one
    // at a time sit on two chips; picking that firm from Ask AI then merged into the first and
    // left the second — so that person received the same enquiry TWICE, as two emails in two
    // threads. That is the owner's per-firm rule broken in the worst direction.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');

    function grab(name) {
        const start = src.indexOf('function ' + name + '(');
        if (start === -1) throw new Error('no such function: ' + name);
        let depth = 0;
        for (let i = src.indexOf('{', start); i < src.length; i++) {
            if (src[i] === '{') depth++;
            if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
        }
        throw new Error('unterminated: ' + name);
    }
    // eslint-disable-next-line no-eval
    const fns = eval('(function () {' + grab('chipAddrs') + grab('chipHolding') + grab('addChip')
        + 'return { chipAddrs: chipAddrs, addChip: addChip };})()');

    /** Every address across every chip, lowercased — what actually gets emailed. */
    const everyone = (list) => list.flatMap(fns.chipAddrs).map((a) => a.toLowerCase());
    const duplicates = (list) => {
        const all = everyone(list);
        return all.filter((v, i) => all.indexOf(v) !== i);
    };

    test('two colleagues already on separate chips are folded into one', () => {
        const list = ['manish@jcopipe.com', 'cp@jcopipe.com'];
        fns.addChip(list, 'manish@jcopipe.com, cp@jcopipe.com');
        expect(list).toHaveLength(1);
        expect(duplicates(list)).toEqual([]);
        expect(everyone(list).sort()).toEqual(['cp@jcopipe.com', 'manish@jcopipe.com']);
    });

    test('three chips for one firm collapse to one, losing nobody', () => {
        const list = ['a@mill.com', 'b@mill.com', 'c@mill.com'];
        fns.addChip(list, 'a@mill.com, b@mill.com, c@mill.com');
        expect(list).toHaveLength(1);
        expect(everyone(list).sort()).toEqual(['a@mill.com', 'b@mill.com', 'c@mill.com']);
    });

    test('an unrelated firm is NOT swallowed by the merge', () => {
        // The other direction. A merge that hoovered up everything would also produce no
        // duplicates, and would be far worse — one email to two firms who then see each other.
        const list = ['zz@elsewhere.com', 'a@mill.com'];
        fns.addChip(list, 'a@mill.com, b@mill.com');
        expect(list).toHaveLength(2);
        expect(fns.chipAddrs(list[0])).toEqual(['zz@elsewhere.com']);
        expect(fns.chipAddrs(list[1]).sort()).toEqual(['a@mill.com', 'b@mill.com']);
    });

    test('a firm nobody has yet becomes its own chip', () => {
        const list = ['x@other.com'];
        expect(fns.addChip(list, 'a@mill.com, b@mill.com')).toBe(true);
        expect(list).toHaveLength(2);
    });

    test('adding someone already there changes nothing and says so', () => {
        const list = ['a@mill.com, b@mill.com'];
        expect(fns.addChip(list, 'a@mill.com')).toBe(false);
        expect(list).toEqual(['a@mill.com, b@mill.com']);
    });

    test('matching ignores capitals, so one person is never two', () => {
        const list = ['Manish@JcoPipe.com', 'cp@jcopipe.com'];
        fns.addChip(list, 'manish@jcopipe.com, cp@jcopipe.com');
        expect(list).toHaveLength(1);
        expect(duplicates(list)).toEqual([]);
    });
});

describe('editing the message cannot bring a spent Send back', () => {
    // The same hole that was found twice on the Freight tab, sitting here as well: a send
    // clears whichever list acted as the recipients but leaves anyone copied in, so re-arming
    // Send on a keystroke armed it to email that colleague ALONE — and record them as a
    // supplier who had been asked.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'quote-enquiry-tab.js'), 'utf8');

    test('the message box does not clear the send lock', () => {
        const at = src.indexOf('msg.oninput = function ()');
        expect(at).toBeGreaterThan(-1);
        const body = src.slice(at, src.indexOf('};', at));
        expect(body).toContain('st.messageEdited = true;');
        expect(body).not.toContain('st.sentLock = false');
    });

    test('and the only thing that DOES clear it is a change to the SUPPLIER list', () => {
        // Tightened after a real hole: a Cc added AFTER a send used to clear the lock too, and
        // canSendNow is satisfied by cc alone. Send lit up with no suppliers left, and pressing
        // it emailed the whole supplier enquiry to that colleague on their own — logging them
        // in the quote as a supplier awaiting a reply, and in the Partner Directory as a dealer
        // who had been asked. Cc copies someone in; it is never a send of its own.
        //
        // Every path now goes through one guard, so there is exactly ONE release in the file.
        const releases = src.split('st.sentLock = false').length - 1;
        expect(releases).toBe(1);
        expect(src).toContain("if (kind !== 'cc') st.sentLock = false;");

        // ...and all three chip paths call it rather than unlocking on their own.
        expect(src).toContain('recipientsChanged(st, el.dataset.kind);');
        expect(src).toContain('if (addChip(listFor(st, kind), email)) recipientsChanged(st, kind);');
        expect(src).toContain('if (email && addChip(list, email)) recipientsChanged(st, kind);');
    });
});
