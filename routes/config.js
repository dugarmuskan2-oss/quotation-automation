'use strict';

/**
 * routes/config.js
 *
 * Shared configuration: instructions, default terms, default margins.
 */

const express = require('express');
const router  = express.Router();

const {
    CONFIG_KEY_INSTRUCTIONS,
    CONFIG_KEY_DEFAULT_TERMS,
    CONFIG_KEY_DEFAULT_MARGINS,
    CONFIG_KEY_DEFAULT_EMAIL_MESSAGE,
    CONFIG_KEY_DEFAULT_SIGNATURE,
} = require('../utils/constants');

function normalizeMarginValue(value) {
    if (value === '' || value === null || value === undefined) return '';
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return '';
    return String(parsed);
}

function sanitizeDefaultMargins(input) {
    const source = (input && typeof input === 'object') ? input : {};
    return {
        erw:      normalizeMarginValue(source.erw),
        gi:       normalizeMarginValue(source.gi),
        seamless: normalizeMarginValue(source.seamless),
    };
}

module.exports = function createConfigRouter({ storage }) {

    // ── Instructions ──────────────────────────────────────────────────────────
    router.post('/save-instructions', express.json(), async (req, res) => {
        try {
            const { instructions } = req.body;
            if (!instructions) return res.status(400).json({ error: 'Instructions text is required' });
            await storage.saveText(CONFIG_KEY_INSTRUCTIONS, instructions);
            res.json({ success: true, message: 'Instructions saved successfully' });
        } catch (error) {
            console.error('Error saving instructions:', error);
            res.status(500).json({ error: 'Failed to save instructions', details: error.message });
        }
    });

    router.get('/get-instructions', async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_INSTRUCTIONS);
            res.json({ hasFile: content !== null, content: content || '' });
        } catch (error) {
            console.error('Error getting instructions:', error);
            res.status(500).json({ error: 'Failed to get instructions', details: error.message });
        }
    });

    // ── Default terms ─────────────────────────────────────────────────────────
    router.post('/save-default-terms', express.json(), async (req, res) => {
        try {
            const { defaultTerms } = req.body;
            if (defaultTerms === undefined || defaultTerms === null) {
                return res.status(400).json({ error: 'Default terms text is required' });
            }
            await storage.saveText(CONFIG_KEY_DEFAULT_TERMS, String(defaultTerms));
            res.json({ success: true, message: 'Default terms saved successfully' });
        } catch (error) {
            console.error('Error saving default terms:', error);
            res.status(500).json({ error: 'Failed to save default terms', details: error.message });
        }
    });

    router.get('/get-default-terms', async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_DEFAULT_TERMS);
            res.json({ hasFile: content !== null, content: content || '' });
        } catch (error) {
            console.error('Error getting default terms:', error);
            res.status(500).json({ error: 'Failed to get default terms', details: error.message });
        }
    });

    // ── Default margins ───────────────────────────────────────────────────────
    router.post('/save-default-margins', express.json(), async (req, res) => {
        try {
            const sanitized = sanitizeDefaultMargins(req.body && req.body.defaultMargins);
            await storage.saveText(CONFIG_KEY_DEFAULT_MARGINS, JSON.stringify(sanitized));
            res.json({ success: true, defaultMargins: sanitized });
        } catch (error) {
            console.error('Error saving default margins:', error);
            res.status(500).json({ error: 'Failed to save default margins', details: error.message });
        }
    });

    router.get('/get-default-margins', async (req, res) => {
        try {
            const content  = await storage.readText(CONFIG_KEY_DEFAULT_MARGINS);
            let parsed = {};
            if (content) {
                try { parsed = JSON.parse(content); } catch { parsed = {}; }
            }
            const sanitized = sanitizeDefaultMargins(parsed);
            res.json({ hasFile: content !== null, defaultMargins: sanitized });
        } catch (error) {
            console.error('Error getting default margins:', error);
            res.status(500).json({ error: 'Failed to get default margins', details: error.message });
        }
    });

    // ── Default email message ─────────────────────────────────────────────────
    router.post('/save-default-email-message', express.json(), async (req, res) => {
        try {
            const { defaultEmailMessage } = req.body;
            if (defaultEmailMessage === undefined || defaultEmailMessage === null) {
                return res.status(400).json({ error: 'defaultEmailMessage is required' });
            }
            await storage.saveText(CONFIG_KEY_DEFAULT_EMAIL_MESSAGE, String(defaultEmailMessage));
            res.json({ success: true });
        } catch (error) {
            console.error('Error saving default email message:', error);
            res.status(500).json({ error: 'Failed to save default email message', details: error.message });
        }
    });

    router.get('/get-default-email-message', async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_DEFAULT_EMAIL_MESSAGE);
            res.json({ hasFile: content !== null, content: content || '' });
        } catch (error) {
            console.error('Error getting default email message:', error);
            res.status(500).json({ error: 'Failed to get default email message', details: error.message });
        }
    });

    // ── Default signature ─────────────────────────────────────────────────────
    router.post('/save-default-signature', express.json(), async (req, res) => {
        try {
            const { defaultSignature } = req.body;
            if (defaultSignature === undefined || defaultSignature === null) {
                return res.status(400).json({ error: 'defaultSignature is required' });
            }
            await storage.saveText(CONFIG_KEY_DEFAULT_SIGNATURE, String(defaultSignature));
            res.json({ success: true });
        } catch (error) {
            console.error('Error saving default signature:', error);
            res.status(500).json({ error: 'Failed to save default signature', details: error.message });
        }
    });

    router.get('/get-default-signature', async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_DEFAULT_SIGNATURE);
            res.json({ hasFile: content !== null, content: content || '' });
        } catch (error) {
            console.error('Error getting default signature:', error);
            res.status(500).json({ error: 'Failed to get default signature', details: error.message });
        }
    });

    return router;
};
