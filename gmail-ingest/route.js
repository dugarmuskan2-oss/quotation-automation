/**
 * Gmail Ingest – Express route
 * POST /api/ingest-from-gmail
 * Body: { emails: [ { id, subject, from, date, body, bodyHtml?, attachments: [ { name, contentType, base64 } ] } ] }
 * Optional header: X-Ingest-Secret (required if INGEST_SECRET env is set)
 */

const { processAllEmails } = require('./ingestLogic');

/**
 * Create the Express route handler for Gmail ingest.
 * @param {object} ctx - Ingest context from server:
 *   - getInstructionsContent: () => Promise<string>
 *   - getDefaultTermsContent: () => Promise<string>
 *   - generateQuotationData: (opts) => Promise<object>
 *   - getNextQuoteNumber: () => Promise<number>
 *   - saveQuotation: (quotation) => Promise<void>
 *   - findQuotationByGmailMessageId: (messageId) => Promise<object|null>
 *   - uploadEnquiryFileToOpenAI: (file) => Promise<string|null>
 * @returns {function(req, res)} Express middleware
 */
function createIngestFromGmailRoute(ctx) {
    return async function ingestFromGmailHandler(req, res) {
        try {
            const secret = process.env.INGEST_SECRET;
            if (secret) {
                const provided = req.headers['x-ingest-secret'];
                if (provided !== secret) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: 'Missing or invalid X-Ingest-Secret header'
                    });
                }
            }

            const emails = req.body && req.body.emails;
            if (!emails || !Array.isArray(emails)) {
                return res.status(400).json({
                    error: 'Bad request',
                    message: 'Body must contain { emails: [ ... ] }'
                });
            }

            if (!ctx.saveQuotation || !ctx.getNextQuoteNumber) {
                return res.status(501).json({
                    error: 'Not implemented',
                    message: 'Gmail ingest requires DynamoDB (save-quotation and next-quote-number). Set DYNAMODB_TABLE and related env vars.'
                });
            }

            const result = await processAllEmails(ctx, emails);

            return res.status(200).json({
                success: true,
                created: result.created,
                ids: result.ids,
                errors: result.errors.length ? result.errors : undefined
            });
        } catch (err) {
            console.error('Gmail ingest error:', err);
            return res.status(500).json({
                error: 'Internal server error',
                details: err.message || String(err)
            });
        }
    };
}

module.exports = {
    createIngestFromGmailRoute
};
