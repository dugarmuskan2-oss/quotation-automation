/*
    ============================================
    VERCEL SERVERLESS FUNCTION - EXPRESS APP
    ============================================
    Exports the Express app from server.js so Vercel's zero-config
    treats it as the serverless handler. All routes (including
    /api/health, /api/ingest-from-gmail) are handled by the app.
    See: https://vercel.com/docs/frameworks/backend/express
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

module.exports = app;
