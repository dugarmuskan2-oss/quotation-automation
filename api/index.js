/*
    ============================================
    VERCEL SERVERLESS FUNCTION HANDLER
    ============================================
    This file imports the Express app from server.js
    and exports it as a serverless function for Vercel.
    Gmail ingest is handled here before Express so it always works regardless of routing.
*/

const express = require('express');
const jsonParser = express.json({ limit: '30mb' });

// Import the Express app from server.js
let app;
try {
    app = require('../server.js');
} catch (error) {
    console.error('Error loading server.js:', error);
    app = (req, res) => {
        res.status(500).json({
            error: 'Server initialization failed',
            details: error.message
        });
    };
}

function isIngestPath(req) {
    // Vercel can pass Web Request (req.url = full URL) or Node (req.url = path)
    const raw = req.url || req.path || (req.originalUrl);
    const path = typeof raw === 'string' ? raw.split('?')[0] : '';
    const pathPart = path.includes('://') ? new URL(path).pathname : path;
    const isPost = (req.method || '').toUpperCase() === 'POST';
return isPost && pathPart && pathPart.includes('ingest-from-gmail');
}

function handler(req, res) {
    if (isIngestPath(req)) {
        jsonParser(req, res, () => {
            if (app.ingestFromGmailHandler) {
                app.ingestFromGmailHandler(req, res);
            } else {
                res.status(500).json({ error: 'Ingest handler not available' });
            }
        });
        return;
    }
    app(req, res);
}

module.exports = handler;

