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

function handler(req, res) {
    const isPost = (req.method || '').toUpperCase() === 'POST';
    if (isPost) {
        jsonParser(req, res, () => {
            if (req.body && Array.isArray(req.body.emails) && app.ingestFromGmailHandler) {
                return app.ingestFromGmailHandler(req, res);
            }
            app(req, res);
        });
        return;
    }
    app(req, res);
}

module.exports = handler;

