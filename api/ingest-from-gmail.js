/*
    Dedicated Vercel serverless function for Gmail ingest.
    Handles POST /api/ingest-from-gmail - bypasses Express routing.
*/
const express = require('express');
const server = require('../server.js');
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(server.ingestFromGmailHandler);
module.exports = (req, res) => app(req, res);
