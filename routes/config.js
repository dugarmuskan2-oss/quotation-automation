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
    CONFIG_KEY_FREIGHT_SUGGESTIONS,
    CONFIG_KEY_STAFF_LIST,
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

const STAFF_LIST_MAX = 50;

/** Trimmed, de-duplicated (case-insensitive) list of staff names, capped. */
function sanitizeStaffList(input) {
    const seen = {};
    return (Array.isArray(input) ? input : [])
        .map(n => String(n || '').trim())
        .filter(n => {
            if (!n) return false;
            const key = n.toLowerCase();
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        })
        .slice(0, STAFF_LIST_MAX);
}

// ── Freight suggestions (transporters remembered per route + pickup/drop) ─────
// Shape: {
//   transporters: [{email, count, lastUsed}],              // global, all routes
//   routes: [{pickup, drop, transporters: [{...}]}],       // per pickup(+drop) lane
//   pickups: [string], drops: [string],                    // MRU place lists
// }

const FREIGHT_MAX_TRANSPORTERS = 50;
const FREIGHT_MAX_PLACES = 10;
const FREIGHT_MAX_ROUTES = 60;

function normalizePlace(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizeTransporterList(list) {
    return (Array.isArray(list) ? list : [])
        .filter(t => t && typeof t.email === 'string' && t.email.trim())
        .map(t => ({
            email: t.email.trim(),
            count: Number.isFinite(Number(t.count)) ? Number(t.count) : 1,
            lastUsed: typeof t.lastUsed === 'string' ? t.lastUsed : '',
        }));
}

function sanitizeFreightSuggestions(input) {
    const source = (input && typeof input === 'object') ? input : {};
    const transporters = sanitizeTransporterList(source.transporters);
    const routes = (Array.isArray(source.routes) ? source.routes : [])
        .map(r => ({
            pickup: String((r && r.pickup) || '').trim(),
            drop: String((r && r.drop) || '').trim(),
            transporters: sanitizeTransporterList(r && r.transporters),
        }))
        .filter(r => r.pickup && r.transporters.length)
        .slice(0, FREIGHT_MAX_ROUTES);
    const places = list => (Array.isArray(list) ? list : [])
        .map(p => String(p || '').trim())
        .filter(Boolean)
        .slice(0, FREIGHT_MAX_PLACES);
    return { transporters, routes, pickups: places(source.pickups), drops: places(source.drops) };
}

// Bump each recipient's usage count in a transporter list, most-used first.
function bumpTransporters(list, recipients, now) {
    const byEmail = {};
    (list || []).forEach(t => { byEmail[t.email.toLowerCase()] = t; });
    recipients.forEach(email => {
        const key = email.toLowerCase();
        if (byEmail[key]) { byEmail[key].count += 1; byEmail[key].lastUsed = now; }
        else { byEmail[key] = { email, count: 1, lastUsed: now }; }
    });
    return Object.values(byEmail)
        .sort((a, b) => (b.count - a.count) || String(b.lastUsed).localeCompare(String(a.lastUsed)))
        .slice(0, FREIGHT_MAX_TRANSPORTERS);
}

// Record one enquiry: bump the global list, the route (pickup+drop) list, and the
// MRU place lists. Route is keyed by normalized pickup+drop; needs a pickup to bind.
function mergeFreightUsage(existing, usage) {
    const now = new Date().toISOString();
    const recipients = (Array.isArray(usage.recipients) ? usage.recipients : [])
        .map(r => String(r || '').trim()).filter(Boolean);

    const transporters = bumpTransporters(existing.transporters, recipients, now);

    const pickup = String(usage.pickup || '').trim();
    const drop = String(usage.drop || '').trim();
    let routes = existing.routes.slice();
    if (pickup && recipients.length) {
        const npk = normalizePlace(pickup), ndp = normalizePlace(drop);
        let route = routes.find(r => normalizePlace(r.pickup) === npk && normalizePlace(r.drop) === ndp);
        if (!route) { route = { pickup, drop, transporters: [] }; routes.unshift(route); }
        else { route.pickup = pickup; route.drop = drop; }   // refresh display casing
        route.transporters = bumpTransporters(route.transporters, recipients, now);
        routes = routes.slice(0, FREIGHT_MAX_ROUTES);
    }

    const mru = (list, value) => {
        const v = String(value || '').trim();
        if (!v) return list;
        return [v].concat(list.filter(p => p.toLowerCase() !== v.toLowerCase())).slice(0, FREIGHT_MAX_PLACES);
    };
    return { transporters, routes, pickups: mru(existing.pickups, pickup), drops: mru(existing.drops, drop) };
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

    // ── Staff list (admin desk "Assign to" names) ─────────────────────────────
    router.post('/save-staff-list', express.json(), async (req, res) => {
        try {
            const sanitized = sanitizeStaffList(req.body && req.body.staffList);
            await storage.saveText(CONFIG_KEY_STAFF_LIST, JSON.stringify(sanitized));
            res.json({ success: true, staffList: sanitized });
        } catch (error) {
            console.error('Error saving staff list:', error);
            res.status(500).json({ error: 'Failed to save staff list', details: error.message });
        }
    });

    router.get('/get-staff-list', async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_STAFF_LIST);
            let parsed = [];
            if (content) {
                try { parsed = JSON.parse(content); } catch { parsed = []; }
            }
            res.json({ hasFile: content !== null, staffList: sanitizeStaffList(parsed) });
        } catch (error) {
            console.error('Error getting staff list:', error);
            res.status(500).json({ error: 'Failed to get staff list', details: error.message });
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

    // ── Freight suggestions ───────────────────────────────────────────────────
    router.get('/get-freight-suggestions', async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_FREIGHT_SUGGESTIONS);
            let parsed = {};
            if (content) {
                try { parsed = JSON.parse(content); } catch { parsed = {}; }
            }
            res.json({ hasFile: content !== null, suggestions: sanitizeFreightSuggestions(parsed) });
        } catch (error) {
            console.error('Error getting freight suggestions:', error);
            res.status(500).json({ error: 'Failed to get freight suggestions', details: error.message });
        }
    });

    // Record one enquiry's usage: { recipients: [emails], pickup, drop }
    router.post('/save-freight-suggestions', express.json(), async (req, res) => {
        try {
            const content = await storage.readText(CONFIG_KEY_FREIGHT_SUGGESTIONS);
            let existing = {};
            if (content) {
                try { existing = JSON.parse(content); } catch { existing = {}; }
            }
            const merged = mergeFreightUsage(sanitizeFreightSuggestions(existing), req.body || {});
            await storage.saveText(CONFIG_KEY_FREIGHT_SUGGESTIONS, JSON.stringify(merged));
            res.json({ success: true, suggestions: merged });
        } catch (error) {
            console.error('Error saving freight suggestions:', error);
            res.status(500).json({ error: 'Failed to save freight suggestions', details: error.message });
        }
    });

    return router;
};

// Pure helpers exposed for unit testing (see tests/freight-suggestions.test.js).
module.exports._test = { sanitizeFreightSuggestions, mergeFreightUsage, bumpTransporters, normalizePlace, sanitizeStaffList };
