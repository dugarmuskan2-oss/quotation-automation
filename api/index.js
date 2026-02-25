/*
    ============================================
    VERCEL SERVERLESS FUNCTION - EXPRESS APP
    ============================================
    Exports the Express app from server.js so Vercel's zero-config
    treats it as the serverless handler. All routes (including
    /api/health, /api/ingest-from-gmail) are handled by the app.
    See: https://vercel.com/docs/frameworks/backend/express

    Vercel rewrite sends path as query param (path=ingest-from-gmail);
    we restore req.url so Express routing matches.
*/

let app;
try {
    app = require('../server.js');
} catch (error) {
    console.error('Error loading server.js:', error);
    const express = require('express');
    app = express();
    app.use((req, res) => {
        res.status(500).json({
            error: 'Server initialization failed',
            details: error.message
        });
    });
}

function handler(req, res) {
    // [ingest-debug] One-line so it's easy to find in Vercel: method, url, query
    console.log('[ingest-debug]', req.method, req.url, JSON.stringify(req.query || {}));
    // Rewrite /api/(.*) -> /api?path=$1 sends path in req.query.path; restore for Express routing
    if (req.query && req.query.path) {
        const rest = { ...req.query };
        delete rest.path;
        const qs = Object.keys(rest).length ? '?' + new URLSearchParams(rest).toString() : '';
        const pathname = '/api/' + req.query.path;
        req.url = pathname + qs;
        req.path = pathname;       // Express route matching uses req.path
        req.originalUrl = req.url;
        console.log('[ingest-debug] path restored ->', req.path);
    }
    app(req, res);
}

module.exports = handler;
