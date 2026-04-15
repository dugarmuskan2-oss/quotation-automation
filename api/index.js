/*
    ============================================
    VERCEL SERVERLESS FUNCTION - EXPRESS APP
    ============================================
    Vercel rewrite /api/(.*) -> /api?path=$1 so we get req.query.path.
    For ingest and health we call the handler directly (bypass Express routing).
    All other paths go through the Express app.
*/

const express = require('express');
const jsonParser = express.json({ limit: '30mb' });

let app;
try {
    app = require('../server.js');
} catch (error) {
    console.error('Error loading server.js:', error);
    app = express();
    app.use((req, res) => {
        res.status(500).json({
            error: 'Server initialization failed',
            details: error.message
        });
    });
}

function handler(req, res) {
    const pathSeg = (req.query && req.query.path) || '';
    const method = (req.method || '').toUpperCase();

    // Bypass Express routing: call handler directly so Vercel req.path doesn't matter
    if (pathSeg === 'ingest-from-gmail' && method === 'POST' && app.ingestFromGmailHandler) {
        jsonParser(req, res, () => app.ingestFromGmailHandler(req, res));
        return;
    }
    if (pathSeg === 'health') {
        if (method === 'POST') {
            jsonParser(req, res, () => {
                if (req.body && Array.isArray(req.body.emails) && app.ingestFromGmailHandler) {
                    return app.ingestFromGmailHandler(req, res);
                }
                res.status(200).json({ status: 'ok', message: 'Server is running' });
            });
            return;
        }
        res.status(200).json({ status: 'ok', message: 'Server is running' });
        return;
    }

    // Restore path for other routes
    if (req.query && req.query.path) {
        const rest = { ...req.query };
        delete rest.path;
        const qs = Object.keys(rest).length ? '?' + new URLSearchParams(rest).toString() : '';
        req.url = '/api/' + req.query.path + qs;
        req.path = '/api/' + req.query.path;
        req.originalUrl = req.url;
    }
    app(req, res);
}

module.exports = handler;
