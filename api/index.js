/*
    ============================================
    VERCEL SERVERLESS FUNCTION HANDLER
    ============================================
    This file imports the Express app from server.js
    and exports it as a serverless function for Vercel
*/

// Import the Express app from server.js
// The app is already exported from server.js and won't start listening on Vercel
let app;
try {
    app = require('../server.js');
} catch (error) {
    console.error('Error loading server.js:', error);
    // Return a simple error handler if server fails to load
    app = (req, res) => {
        res.status(500).json({
            error: 'Server initialization failed',
            details: error.message
        });
    };
}

// Export the app - Vercel will handle it as a serverless function
module.exports = app;

