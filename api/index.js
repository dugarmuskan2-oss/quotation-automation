/*
    ============================================
    VERCEL SERVERLESS FUNCTION HANDLER
    ============================================
    This file imports the Express app from server.js
    and exports it as a serverless function for Vercel
*/

// Import the Express app from server.js
const app = require('../server.js');

// Export as serverless function handler
module.exports = app;

