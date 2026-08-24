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
            res.json({ contacts: dir.contacts, changes: dir.changes, pending });
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

    // Pull in the addresses the app already remembered from years of sends. Safe to run
    // twice: anything already in the directory is skipped, never overwritten.
    router.post('/contacts/import-remembered', express.json(), async (req, res) => {
        try {
            const [dir, freightRaw, supplierRaw] = await Promise.all([
                loadDirectory(),
                storage.readText(CONFIG_KEY_FREIGHT_SUGGESTIONS),
                storage.readText(CONFIG_KEY_SUPPLIER_SUGGESTIONS),
            ]);
            const result = contactsLib.importFromSuggestions(
                dir.contacts, parseBlob(freightRaw, {}), parseBlob(supplierRaw, {}));
            if (result.added) {
                const entry = contactsLib.changeEntry(
                    'Imported ' + result.added + ' remembered address' + (result.added === 1 ? '' : 'es'),
                    'From the addresses the app had already learned from your sends'
                    + (result.skipped ? ' · ' + result.skipped + ' already in the directory, left alone' : ''),
                    'Import', '', null, null);
                await saveDirectory({ contacts: result.contacts, changes: contactsLib.pushChange(dir.changes, entry) });
            }
            res.json({ ok: true, added: result.added, skipped: result.skipped });
        } catch (error) {
            res.status(500).json({ error: 'Could not import: ' + error.message });
        }
    });

    // Bump asked/replied stats; unknown addresses become review-me stubs.
    router.post('/contacts/usage', express.json(), async (req, res) => {
        try {
            const dir = await loadDirectory();
            const contacts = contactsLib.bumpUsage(dir.contacts, req.body || {});
            await saveDirectory({ contacts, changes: dir.changes });
            res.json({ ok: true });
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
            await savePending(items.slice(0, 50));
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
