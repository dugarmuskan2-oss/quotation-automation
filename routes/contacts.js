'use strict';

/**
 * routes/contacts.js — the partner directory's storage routes.
 *
 * Holds two config blobs (via storage.readText/saveText, same as staff-list and the
 * freight/supplier suggestion files):
 *   contacts.json          { contacts: [partner…], changes: [change…] }
 *   contacts-pending.json  { items: [pending…] }   ← emails from the Add-to-Directory label
 *
 * Every write is a read-modify-write of ONE partner or ONE item — never a whole-list
 * overwrite from the client, so two open tabs can't clobber each other's partners.
 * Handlers orchestrate only; the logic lives in utils/contacts.js.
 */

const express = require('express');

const {
    CONFIG_KEY_CONTACTS,
    CONFIG_KEY_CONTACTS_PENDING,
    CONFIG_KEY_FREIGHT_SUGGESTIONS,
    CONFIG_KEY_SUPPLIER_SUGGESTIONS,
} = require('../utils/constants');

const contactsLib = require('../utils/contacts');
const MAX_PENDING = contactsLib.MAX_PENDING;

// One address belongs to ONE company. Say which one already has it, so the owner can act
// instead of guessing — refusing without naming the other card is a dead end.
function conflictMessage(clash) {
    // An imported card often has no name yet, so its company IS the address — "x@y.com is
    // already on x@y.com" reads like a glitch. Name the card only when it says something new.
    const name = String(clash.company || '').trim();
    const where = (!name || name.toLowerCase() === String(clash.email).toLowerCase())
        ? 'another card' : name;
    return clash.email + ' is already on ' + where
        + '. One address belongs to one company — remove it there first, or add this person to that card.';
}

function str(v) { return String(v == null ? '' : v).trim(); }

/**
 * What an Add-tab apply is allowed to write onto a card that already exists.
 *
 * Everything the AI can propose, and nothing else. A wholesale write would put back the
 * browser's minutes-old copy of the fields the APP maintains — enq, rep, last — so an
 * enquiry that went out between pressing Read and pressing Apply would have its count
 * silently rolled back. `checked` is stamped by mergePartner on every scoped write, which
 * is right: reading a fresh brochure into a card IS checking it.
 */
const ADD_FIELDS = ['company', 'role', 'roleOther', 'city', 'address', 'branches', 'types',
    'moq', 'products', 'rules', 'routes', 'vehicles', 'partLoad', 'notes', 'people', 'images'];

/**
 * Only what the reader can actually see. Anything else was base64'd as a fake JPEG and sent
 * to the model anyway, which comes back having read nothing — and a Word or Excel rate list
 * is a perfectly normal thing to hand it, since the quote side accepts both.
 */
function readableFile(name) {
    return /\.(pdf|jpe?g|png|webp|gif)$/i.test(str(name));
}

function parseBlob(content, fallback) {
    try {
        const parsed = JSON.parse(content);
        return (parsed && typeof parsed === 'object') ? parsed : fallback;
    } catch (e) { return fallback; }
}

module.exports = function createContactsRouter({ storage, openai }) {
    const router = express.Router();

    async function loadDirectory() {
        const content = await storage.readText(CONFIG_KEY_CONTACTS);
        const blob = content ? parseBlob(content, {}) : {};
        return {
            contacts: Array.isArray(blob.contacts) ? blob.contacts : [],
            changes: Array.isArray(blob.changes) ? blob.changes : [],
        };
    }

    async function saveDirectory(dir) {
        await storage.saveText(CONFIG_KEY_CONTACTS, JSON.stringify({
            contacts: dir.contacts, changes: dir.changes,
        }));
    }

    async function loadPending() {
        const content = await storage.readText(CONFIG_KEY_CONTACTS_PENDING);
        const blob = content ? parseBlob(content, {}) : {};
        return Array.isArray(blob.items) ? blob.items : [];
    }

    async function savePending(items) {
        await storage.saveText(CONFIG_KEY_CONTACTS_PENDING, JSON.stringify({ items }));
    }

    // Apps Script auth, same contract as the quote ingest: header must match INGEST_SECRET.
    function ingestAuthorized(req) {
        const secret = process.env.INGEST_SECRET;
        if (!secret) return true;
        return req.get('X-Ingest-Secret') === secret;
    }

    // ── the directory itself ──────────────────────────────────────────────────

    router.get('/contacts', async (req, res) => {
        try {
            const dir = await loadDirectory();
            const pending = await loadPending();
            res.json({
                contacts: dir.contacts, changes: dir.changes, pending,
                // Should always be empty now the rule is enforced on write. Sent anyway so a
                // duplicate that pre-dates it cannot sit there unnoticed, quietly splitting
                // one firm's history across two cards.
                duplicates: contactsLib.duplicateEmails(dir.contacts),
            });
        } catch (error) {
            res.status(500).json({ error: 'Could not load the directory: ' + error.message });
        }
    });

    // Upsert ONE partner (merged into the stored list by id — no whole-list writes).
    // `fields` narrows the write to just what the user touched, so a second tab editing a
    // different part of the SAME partner does not have its work replaced by a stale copy.
    router.post('/contacts/save', express.json({ limit: '1mb' }), async (req, res) => {
        try {
            const dir = await loadDirectory();
            const { partner, fields } = req.body || {};
            const merged = contactsLib.mergePartner(dir.contacts, partner, fields);
            if (merged.conflict) return res.status(409).json({ error: conflictMessage(merged.conflict) });
            // Nothing typed yet, so nothing to keep. Not an error the owner should see — there
            // is no lost work in refusing to store an empty card.
            if (merged.empty) return res.json({ ok: true, skipped: 'empty' });
            await saveDirectory({ contacts: merged.contacts, changes: dir.changes });
            res.json({ ok: true, partner: merged.partner });
        } catch (error) {
            res.status(500).json({ error: 'Could not save the partner: ' + error.message });
        }
    });

    router.post('/contacts/delete', express.json(), async (req, res) => {
        try {
            const id = String((req.body && req.body.id) || '');
            const dir = await loadDirectory();
            const next = dir.contacts.filter(p => p && p.id !== id);
            await saveDirectory({ contacts: next, changes: dir.changes });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: 'Could not delete the partner: ' + error.message });
        }
    });

    // Queue the addresses the app already remembered from years of sends — ONE item per firm,
    // waiting for approval. Nothing reaches the directory here: approval is the only write
    // path, the same as for an email arriving on the Gmail label. Safe to run twice; an
    // address already in the directory or already in the queue is not offered again.
    router.post('/contacts/import-remembered', express.json(), async (req, res) => {
        try {
            const [dir, items, freightRaw, supplierRaw] = await Promise.all([
                loadDirectory(),
                loadPending(),
                storage.readText(CONFIG_KEY_FREIGHT_SUGGESTIONS),
                storage.readText(CONFIG_KEY_SUPPLIER_SUGGESTIONS),
            ]);
            const result = contactsLib.pendingFromSuggestions(
                dir.contacts, parseBlob(freightRaw, {}), parseBlob(supplierRaw, {}));
            const fresh = contactsLib.dropAlreadyQueued(items, result.items);
            if (fresh.length) await savePending(fresh.concat(items).slice(0, MAX_PENDING));
            res.json({
                ok: true, queued: fresh.length,
                alreadyQueued: result.items.length - fresh.length,
                skippedFirms: result.skippedFirms, skippedAddresses: result.skippedAddresses,
            });
        } catch (error) {
            res.status(500).json({ error: 'Could not read the remembered addresses: ' + error.message });
        }
    });

    // Bump asked/replied stats on firms we already hold. An address the directory has never
    // seen is QUEUED for approval, never turned into a card behind the owner's back.
    router.post('/contacts/usage', express.json(), async (req, res) => {
        try {
            const usage = req.body || {};
            const [dir, items] = await Promise.all([loadDirectory(), loadPending()]);
            const bumped = contactsLib.bumpUsage(dir.contacts, usage);
            await saveDirectory({ contacts: bumped.contacts, changes: dir.changes });
            const proposed = contactsLib.pendingFromUsage(dir.contacts, items, bumped.unknown, usage);
            if (proposed.length) await savePending(proposed.concat(items).slice(0, MAX_PENDING));
            res.json({ ok: true, queued: proposed.length });
        } catch (error) {
            res.status(500).json({ error: 'Could not record the usage: ' + error.message });
        }
    });

    router.post('/contacts/change-undo', express.json(), async (req, res) => {
        try {
            const id = String((req.body && req.body.id) || '');
            const dir = await loadDirectory();
            const result = contactsLib.undoChange(dir.contacts, dir.changes, id);
            if (!result.ok) return res.status(404).json({ error: 'That change was not found, or is already undone.' });
            await saveDirectory({ contacts: result.contacts, changes: result.changes });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: 'Could not undo the change: ' + error.message });
        }
    });

    // ── the Gmail label queue ─────────────────────────────────────────────────

    // Apps Script posts one labelled email at a time: { from, subject, file, kind, text }.
    // The AI reads it here (best effort); nothing touches the directory until approval.
    router.post('/contacts/pending', express.json({ limit: '4mb' }), async (req, res) => {
        if (!ingestAuthorized(req)) {
            return res.status(401).json({ error: 'Missing or invalid X-Ingest-Secret header' });
        }
        try {
            const item = contactsLib.sanitizePendingItem(req.body || {});
            if (!item.from && !item.text) return res.status(400).json({ error: 'Nothing to read: no sender and no text.' });
            if (!item.finds.length) item.finds = await extractFinds(item);
            // The attachment has served its purpose — never store the base64 in the queue
            // blob, or one brochure bloats the file past what storage will hold.
            delete item.fileBase64;
            const items = await loadPending();
            if (!items.some(x => x.from === item.from && x.subject === item.subject && x.file === item.file)) {
                items.unshift(item);
            }
            await savePending(items.slice(0, MAX_PENDING));
            res.json({ ok: true, id: item.id, finds: item.finds.length });
        } catch (error) {
            res.status(500).json({ error: 'Could not store the email: ' + error.message });
        }
    });

    // Approve = the ONLY write path from the queue into the directory. The client sends the
    // reviewed partner (corrections included), so what was checked is what gets saved.
    router.post('/contacts/pending/approve', express.json({ limit: '1mb' }), async (req, res) => {
        try {
            const { id, partner, source } = req.body || {};
            const items = await loadPending();
            const item = items.find(x => x.id === String(id || ''));
            if (!item) return res.status(404).json({ error: 'That pending item was not found — it may already be handled.' });
            const dir = await loadDirectory();
            const before = dir.contacts.find(p => p && p.id === (partner && partner.id)) || null;
            const merged = contactsLib.mergePartner(dir.contacts, partner);
            // The item stays in the queue on a clash — nothing is half-applied, and the owner
            // can fix the other card and approve again.
            if (merged.conflict) return res.status(409).json({ error: conflictMessage(merged.conflict) });
            const entry = contactsLib.changeEntry(
                (before ? merged.partner.company + ' updated' : 'Added ' + merged.partner.company),
                item.finds.length + ' detail' + (item.finds.length === 1 ? '' : 's') + ' from “' + item.subject + '” (' + item.file + ')',
                String(source || 'Gmail label'), merged.partner.id, before, merged.partner);
            await saveDirectory({ contacts: merged.contacts, changes: contactsLib.pushChange(dir.changes, entry) });
            await savePending(items.filter(x => x.id !== item.id));
            res.json({ ok: true, partner: merged.partner });
        } catch (error) {
            res.status(500).json({ error: 'Could not approve the item: ' + error.message });
        }
    });

    // Keep the corrections made while reviewing ON the queue item. They used to live only in
    // the browser, so a tab switch or a refresh quietly restored the AI's original guesses —
    // and the card looked identical, so the wrong values got approved.
    router.post('/contacts/pending/preview', express.json({ limit: '1mb' }), async (req, res) => {
        try {
            const id = str((req.body || {}).id);
            const items = await loadPending();
            const item = items.find(x => x.id === id);
            if (!item) return res.status(404).json({ error: 'That item is no longer waiting — it may already be handled.' });
            item.preview = contactsLib.sanitizePartner((req.body || {}).preview);
            item.preview.id = 'p_new_' + item.id;
            const matchId = str(((req.body || {}).preview || {}).matchId);
            if (matchId) item.preview.matchId = matchId;
            await savePending(items);
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: 'Could not keep that correction: ' + error.message });
        }
    });

    router.post('/contacts/pending/discard', express.json(), async (req, res) => {
        try {
            const id = String((req.body && req.body.id) || '');
            const items = await loadPending();
            await savePending(items.filter(x => x.id !== id));
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: 'Could not discard the item: ' + error.message });
        }
    });

    // ── the Add tab: partners the owner sources by hand ───────────────────────

    // READ ONLY. The owner drops in a file and/or types into the one box; the AI works out
    // whether this is a new firm or more detail about one already held, and we hand back
    // exactly what WOULD change. Nothing is written here — not the directory, not the queue.
    // 8mb, not 4: base64 makes a file about a third bigger, so the 3 MB photo the browser
    // accepts arrives as ~4.2 MB of JSON. At a 4mb limit body-parser threw before the handler
    // ran and Express answered with an HTML stack trace — for the headline case, a photo of a
    // visiting card.
    router.post('/contacts/add-draft', express.json({ limit: '8mb' }), async (req, res) => {
        const { text, fileBase64, fileName, matchId } = req.body || {};
        if (!str(text) && !str(fileBase64)) {
            return res.status(400).json({ error: 'Nothing to read yet — type or paste something, or attach a file.' });
        }
        if (str(fileBase64) && !readableFile(fileName)) {
            return res.status(400).json({
                error: 'I can read a PDF or a photo (jpg, png). "' + str(fileName) + '" is neither — '
                    + 'export it as a PDF, or take a photo of the page.',
            });
        }
        if (!openai) {
            return res.status(500).json({ error: 'The AI reader is switched off, so nothing could be read. You can still add this firm by hand in the Directory tab.' });
        }
        try {
            const dir = await loadDirectory();
            const raw = await readAddition({ text, fileBase64, fileName }, dir.contacts);
            const parsed = contactsLib.groundInText(raw, text, !!str(fileBase64));
            res.json(addDraftReply(parsed, dir.contacts, fileName, str(matchId), str(text)));
        } catch (error) {
            // Loud on purpose. A read that FAILED must never come back looking like "found
            // nothing here" — the owner would file it away as done and the firm never gets in.
            res.status(500).json({
                error: 'Could not read that: ' + error.message
                    + '. Nothing was changed — try again, or add the firm by hand in the Directory tab.',
            });
        }
    });

    // The ONLY write from the Add tab, and only once the owner has seen the change and
    // pressed Apply. Goes through mergePartner (one address, one company) and logs a change
    // entry so it can be undone from Recent changes.
    router.post('/contacts/add-apply', express.json({ limit: '1mb' }), async (req, res) => {
        try {
            const { after, matchId, steps, source } = req.body || {};
            const dir = await loadDirectory();
            const before = str(matchId) ? (dir.contacts.find(p => p && p.id === str(matchId)) || null) : null;
            if (str(matchId) && !before) {
                return res.status(404).json({ error: 'That firm is no longer in your directory — it may have been deleted. Read this again to add it fresh.' });
            }
            // Rebuild from the steps the owner ticked, against the card as it is stored NOW.
            // Better than taking the whole card back from the browser: only what was ticked
            // can land, and anything a colleague changed in the meantime is still there.
            const wanted = Array.isArray(steps)
                ? contactsLib.applyAddSteps(before, steps, str(source))
                : addTarget(after, before);
            if (Array.isArray(steps) && !steps.length) {
                return res.json({ ok: true, skipped: 'nothing-kept' });
            }
            const merged = contactsLib.mergePartner(
                dir.contacts, addTarget(wanted, before), before ? ADD_FIELDS : null);
            if (merged.conflict) return res.status(409).json({ error: conflictMessage(merged.conflict) });
            if (merged.empty) return res.json({ ok: true, skipped: 'empty' });
            await saveDirectory(logAddition(dir, merged, before));
            res.json({ ok: true, partner: merged.partner });
        } catch (error) {
            res.status(500).json({ error: 'Could not add that to the directory: ' + error.message });
        }
    });

    // The STORED card decides which firm this is, never the id on the copy the browser sent
    // back: a tab left open since before a rename must not be able to aim the write elsewhere.
    // With no match the id is left alone on purpose — pressing Apply twice then lands on the
    // card the first press created, instead of standing up a second copy of the same firm.
    function addTarget(after, before) {
        const card = (after && typeof after === 'object') ? after : {};
        return before ? Object.assign({}, card, { id: before.id }) : card;
    }

    function logAddition(dir, merged, before) {
        const entry = contactsLib.changeEntry(
            before ? merged.partner.company + ' updated' : 'Added ' + merged.partner.company,
            addChangeDetail(before, merged.partner), 'Added by hand',
            merged.partner.id, before, merged.partner);
        return { contacts: merged.contacts, changes: contactsLib.pushChange(dir.changes, entry) };
    }

    function addChangeDetail(before, after) {
        const n = contactsLib.diffLines(before, after).length;
        return n ? n + ' detail' + (n === 1 ? '' : 's') + ' you checked and applied'
            : 'Applied from the Add tab.';
    }

    // Throws rather than returning nothing — see the handler's catch above.
    async function readAddition(input, contacts) {
        const firms = contactsLib.firmsForPrompt(contacts);
        const parts = [{ type: 'input_text', text: contactsLib.addPrompt({
            text: input.text, fileName: input.fileName, firms }) }];
        const attached = await attachFilePart({
            fileBase64: str(input.fileBase64),
            file: str(input.fileName) || 'attachment',
            kind: /\.pdf$/i.test(str(input.fileName)) ? 'pdf' : 'photo',
        });
        // Reading the typed text while quietly dropping the attached brochure would look like
        // a clean read of half the information. Say it failed instead.
        if (str(input.fileBase64) && !attached) throw new Error('the attached file could not be read');
        if (attached) parts.push(attached);
        const response = await openai.responses.create({
            model: 'gpt-4o-mini', input: [{ role: 'user', content: parts }],
        });
        return parseAddJson(String(response.output_text || ''));
    }

    function parseAddJson(text) {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('the reply did not come back in the expected form');
        return JSON.parse(match[0]);
    }

    function addDraftReply(parsed, contacts, fileName, settledId, text) {
        // The typed words go in too: they are the only evidence that the firm the model picked
        // is the firm the owner meant. Not passed when a file was attached — the name is
        // inside it, and the popup is what stands guard there.
        const decided = contactsLib.addDraftMode(
            parsed, contactsLib.firmsForPrompt(contacts), settledId, str(fileName) ? '' : text);
        // Pressing a firm's name means "add this to THAT card", never "rename it to whatever
        // the text called them" — the two names differing is why they were asked in the first place.
        if (str(settledId) && parsed && typeof parsed === 'object') parsed = Object.assign({}, parsed, { company: '' });
        const before = decided.matchId
            ? (contacts.find(p => p && p.id === decided.matchId) || null) : null;
        const source = str(fileName) ? 'read from ' + str(fileName) : 'typed in';
        // Broken into the separate things it would do, so the owner can keep some and drop
        // others. `after` is built from exactly the steps that survived, so what the popup
        // lists and what Apply would write can never drift apart.
        const changes = contactsLib.addChangeList(before, contactsLib.addSteps(parsed), source);
        const after = contactsLib.applyAddSteps(before, changes.map(c => c.step), source);
        const lines = changes.reduce((all, c) => all.concat(c.lines), []);
        // A blurry photo the model made nothing of used to come back as a confident "new firm"
        // with an empty change list and a reassuring sentence. Nothing to show means nothing
        // was understood — say so, and leave nothing to approve (CLAUDE.md check #4).
        if (!lines.length) {
            // Two very different silences. "I read it and it is all already there" must not be
            // reported as "I could not read it" — the owner would rewrite a sentence that was
            // perfectly clear.
            const understood = contactsLib.findsFromExtraction(parsed).length > 0;
            return Object.assign({}, decided, {
                mode: 'nothing', before, after: null, lines: [],
                read: understood
                    ? (before ? 'Everything in that is already on ' + str(before.company) + '’s card. Nothing to change.'
                        : 'I read that, but there was nothing in it to store.')
                    : str(fileName)
                        ? 'I could not make anything out of ' + str(fileName) + '. Try a clearer photo, or type what it says.'
                        : 'I could not find a firm, a person or a product in that. Try writing it as a sentence, like "MSL now has 24 inch pipes too".',
            });
        }
        return Object.assign({}, decided, {
            before, after, lines, changes, source,
            read: str(parsed && parsed.read).slice(0, 300)
                || 'Read what you gave me — check the change below before applying.',
        });
    }

    // Best-effort AI read of the email AND its attachment. A failure returns [] — the owner
    // still sees the raw email in the queue and fills the card by hand; it must never block
    // ingest. A brochure is the whole point, so the PDF/image goes to the model too, the same
    // way an enquiry attachment does on the quote side.
    async function extractFinds(item) {
        if (!openai || (!item.text && !item.fileBase64)) return [];
        try {
            const parts = [{ type: 'input_text', text: contactsLib.extractionPrompt(item) }];
            const attached = await attachFilePart(item);
            if (attached) parts.push(attached);
            const response = await openai.responses.create({
                model: 'gpt-4o-mini',
                input: [{ role: 'user', content: parts }],
            });
            const text = String(response.output_text || '');
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            return jsonMatch ? contactsLib.findsFromExtraction(JSON.parse(jsonMatch[0])) : [];
        } catch (error) {
            console.error('Directory extraction failed:', error.message);
            return [];
        }
    }

    // A PDF is uploaded and referenced by id; an image rides inline as a data URL. Either
    // failing is survivable — we fall back to reading the email text alone.
    async function attachFilePart(item) {
        if (!item.fileBase64) return null;
        try {
            const buffer = Buffer.from(item.fileBase64, 'base64');
            if (item.kind === 'pdf') {
                const { toFile } = require('openai');
                const upload = await toFile(buffer, item.file || 'brochure.pdf', { type: 'application/pdf' });
                const created = await openai.files.create({ file: upload, purpose: 'assistants' });
                return { type: 'input_file', file_id: created.id };
            }
            const mime = /\.png$/i.test(item.file) ? 'image/png' : 'image/jpeg';
            return { type: 'input_image', image_url: 'data:' + mime + ';base64,' + item.fileBase64 };
        } catch (error) {
            console.error('Directory attachment read failed:', error.message);
            return null;
        }
    }

    return router;
};
