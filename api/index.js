/*
    ============================================
    VERCEL SERVERLESS FUNCTION HANDLER
    ============================================
    This file imports the Express app from server.js
    and exports it as a serverless function for Vercel
*/

// Import the Express app from server.js
// The app is already exported from server.js and won't start listening on Vercel
const app = require('../server.js');

// Export the app - Vercel will handle it as a serverless function
module.exports = app;

