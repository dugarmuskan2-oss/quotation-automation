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
    router.post('/contacts/save', express.json({ limit: '1mb' }), async (req, res) => {
        try {
            const dir = await loadDirectory();
            const merged = contactsLib.mergePartner(dir.contacts, req.body && req.body.partner);
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

    // Best-effort AI read of the email text. A failure returns [] — the owner still sees
    // the raw email in the queue and fills the card by hand; it must never block ingest.
    async function extractFinds(item) {
        if (!openai || !item.text) return [];
        try {
            const response = await openai.responses.create({
                model: 'gpt-4o-mini',
                input: contactsLib.extractionPrompt(item),
            });
            const text = String(response.output_text || '');
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            return jsonMatch ? contactsLib.findsFromExtraction(JSON.parse(jsonMatch[0])) : [];
        } catch (error) {
            return [];
        }
    }

    return router;
};
