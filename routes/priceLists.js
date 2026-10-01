'use strict';

/**
 * routes/priceLists.js
 *
 * The in-app price lists (ERW / GI / Seamless): read, save a draft, discard it, mark it Checked
 * (draft -> live, email to the office), and a one-time read of a list out of its PDF.
 * The rules themselves live in utils/priceListBook.js.
 */

const express = require('express');
const { LIST_TYPES, normaliseDoc, assertListType, diffRows, saveDraft, discardDraft, checkDraft } = require('../utils/priceListBook');
const { buildWeightMap } = require('../utils/pipeWeights');
const { sendEmail } = require('../utils/gmail');
const { PRICE_LIST_NOTIFY_EMAIL } = require('../utils/constants');

const PDF_READ_MODEL = 'gpt-5.2';

// What the page needs: each list's live + draft, and the draft's changes against live.
function viewOf(doc) {
    const d = normaliseDoc(doc);
    const lists = {};
    LIST_TYPES.forEach(t => {
        const { live, draft } = d.lists[t];
        lists[t] = { live, draft, changes: draft ? diffRows(live ? live.rows : [], draft.rows) : [] };
    });
    return { rev: d.rev, lists };
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function checkedEmailHtml(type, live) {
    const when = new Date(live.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    return `<p>The <b>${escapeHtml(type.toUpperCase())}</b> price list was changed and checked.</p>` +
        `<p>Edited by: ${escapeHtml(live.editedBy || '—')}<br>Checked by: ${escapeHtml(live.checkedBy)}<br>` +
        `Checked on: ${escapeHtml(when)}<br>Version: ${live.version}</p>` +
        '<p>New quotes are now priced from this version.</p>';
}

// The email is told, but never undoes the check: the list is already live when it is sent.
// A failure is returned to the page so it is seen, not swallowed.
async function notifyChecked(type, live) {
    try {
        await sendEmail({ to: PRICE_LIST_NOTIFY_EMAIL, subject: `${type.toUpperCase()} price list changed and checked`,
            bodyHtml: checkedEmailHtml(type, live) });
        return { emailSent: true };
    } catch (e) {
        console.error('Price-list checked email failed:', e.message);
        return { emailSent: false, emailError: e.message };
    }
}

// Ask the AI to copy one PDF price list into rows, exactly as printed. One-time use: the result is
// only a DRAFT, and every price in it must be checked by a person before it can price a quote.
function pdfReadPrompt(type) {
    return `This PDF is the ${type.toUpperCase()} pipe price list. Copy its table EXACTLY as printed, every row, ` +
        'every column, in the same order. Use the column headings exactly as printed (for example "Size", "Inch", ' +
        '"NB", "OD", "Light/Medium/Heavy", "SCH", "Wall Thickness (mm)", "Cost/Meter", "Price", "Price per Meter", ' +
        '"KG/MTR"). Copy every number exactly as printed — never calculate, round or fill in a value; leave a cell ' +
        'empty ("") when it is empty in the PDF. Return ONLY JSON: {"rows": [[header cells...], [row cells...], ...]}.';
}

async function readListFromPdf(openai, fileId, type) {
    const response = await openai.responses.create({
        model: PDF_READ_MODEL,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: [
            { type: 'input_text', text: pdfReadPrompt(type) },
            { type: 'input_file', file_id: fileId },
        ] }],
    });
    const text = response.output_text || '';
    const json = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (!Array.isArray(json.rows)) throw new Error('The AI did not return a table for this PDF.');
    return json.rows;
}

function pdfMappingFor(mappings, type) {
    const isType = {
        erw: n => /\berw\b/i.test(n),
        gi: n => /\bgi\b/i.test(n),
        seamless: n => /seamless/i.test(n),
    }[type];
    return (mappings || []).find(m => isType(m.originalName || m.s3Key || '')) || null;
}

module.exports = function createPriceListsRouter({ storage, openai }) {
    const router = express.Router();
    const pdfReadsInFlight = new Set();   // one PDF read per list at a time — a second click is a no-op

    // Load, check the page's copy is current, apply a change, save. 409 when someone else changed
    // the lists since the page loaded — their change must not be overwritten silently.
    async function changeDoc(req, res, change) {
        const doc = normaliseDoc(await storage.loadPriceLists());
        if (req.body && req.body.rev !== undefined && Number(req.body.rev) !== doc.rev) {
            res.status(409).json({ error: 'The price lists were changed somewhere else since this page loaded. Reload and try again.' });
            return null;
        }
        const out = change(doc);
        await storage.savePriceLists(out.doc || out);
        return out;
    }

    function editorOf(req) {
        return (req.user && req.user.who) || String((req.body && req.body.editedBy) || '').trim();
    }

    router.get('/price-lists', async (req, res) => {
        try {
            res.json(viewOf(await storage.loadPriceLists()));
        } catch (e) {
            res.status(500).json({ error: 'Could not load the price lists: ' + e.message });
        }
    });

    router.put('/price-lists/:type/draft', async (req, res) => {
        try {
            assertListType(req.params.type);
            const doc = await changeDoc(req, res, d => saveDraft(d, req.params.type, req.body.rows, { editedBy: editorOf(req), source: 'edit' }));
            if (doc) res.json(viewOf(doc));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.delete('/price-lists/:type/draft', async (req, res) => {
        try {
            const doc = await changeDoc(req, res, d => discardDraft(d, req.params.type));
            if (doc) res.json(viewOf(doc));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Draft -> live. History is kept, the kg/m table follows the new list, then the office is told.
    router.post('/price-lists/:type/check', async (req, res) => {
        try {
            const type = req.params.type;
            const out = await changeDoc(req, res, d => checkDraft(d, type, req.body.checkedBy));
            if (!out) return;
            const live = out.doc.lists[type].live;
            if (out.replaced) await storage.savePriceListHistory(type, out.replaced);
            const weights = await storage.loadPipeWeights();
            const weightMap = buildWeightMap(live.rows);
            if (Object.keys(weightMap).length) {
                weights[type] = weightMap;
                weights.updatedAt = Object.assign({}, weights.updatedAt, { [type]: live.checkedAt });
                await storage.savePipeWeights(weights);
            }
            const email = await notifyChecked(type, live);
            res.json(Object.assign(viewOf(out.doc), email));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // One-time: read a list out of the PDF already uploaded for it, into a DRAFT.
    router.post('/price-lists/:type/read-pdf', async (req, res) => {
        const type = req.params.type;
        if (pdfReadsInFlight.has(type)) return res.status(409).json({ error: 'Already reading this PDF — wait for it to finish.' });
        pdfReadsInFlight.add(type);
        try {
            assertListType(type);
            const mapping = pdfMappingFor(await storage.getAllRateMappings(), type);
            if (!mapping) throw new Error(`No ${type.toUpperCase()} PDF has been uploaded.`);
            const rows = await readListFromPdf(openai, mapping.openaiFileId, type);
            const doc = await changeDoc(req, res, d => saveDraft(d, type, rows, { editedBy: editorOf(req), source: 'pdf: ' + (mapping.originalName || '') }));
            if (doc) res.json(viewOf(doc));
        } catch (e) {
            res.status(400).json({ error: e.message });
        } finally {
            pdfReadsInFlight.delete(type);
        }
    });

    return router;
};

module.exports._test = { viewOf, pdfMappingFor, checkedEmailHtml, readListFromPdf };
