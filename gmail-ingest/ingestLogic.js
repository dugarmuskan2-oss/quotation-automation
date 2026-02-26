/**
 * Gmail Ingest – Core logic
 * Process one or many emails: generate quotation, build HTML, save (with duplicate check).
 */

const { buildTableHTMLFromLineItems, buildHeaderHTMLFromQuotation } = require('./htmlBuilder');
const { getFirstPdfAttachment } = require('./attachmentUtils');

/**
 * Default Gmail inbox URL template. Use 0 for first account.
 */
const GMAIL_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox/';

/** Quote number display prefix; must match frontend formatQuoteNumber (DSC-xxx). */
const QUOTE_NUMBER_PREFIX = 'DSC-';

/**
 * Format the numeric quote counter as the display quote number (e.g. 108 -> "DSC-108").
 * @param {number|string} value - Raw value from getNextQuoteNumber
 * @returns {string}
 */
function formatQuoteNumber(value) {
    if (value == null || value === '') return '';
    return QUOTE_NUMBER_PREFIX + String(value);
}

/**
 * Build the full quotation object to save (Approval section shape).
 * @param {object} params
 * @param {object} params.aiResult - Result from generateQuotationData (customerName, lineItems, etc.)
 * @param {string} params.quoteNumber
 * @param {string} params.termsText
 * @param {string} params.emailContent
 * @param {string} params.gmailMessageId
 * @param {string} params.emailLink
 * @returns {object} Quotation object with id, tableHTML, headerHTML, grandTotal, saved, etc.
 */
function buildQuotationToSave({ aiResult, quoteNumber, termsText, emailContent, gmailMessageId, emailLink }) {
    const { tableHTML, grandTotalFormatted } = buildTableHTMLFromLineItems(aiResult.lineItems || []);
    const headerHTML = buildHeaderHTMLFromQuotation({
        ...aiResult,
        quoteNumber
    });

    const id = Date.now();
    const now = new Date().toISOString();

    return {
        id,
        createdAt: now,
        updatedAt: now,
        customerName: aiResult.customerName,
        companyName: aiResult.companyName,
        projectName: aiResult.projectName,
        quotationDate: aiResult.quotationDate,
        phoneNumber: aiResult.phoneNumber,
        mobileNumber: aiResult.mobileNumber,
        lineItems: aiResult.lineItems || [],
        quoteNumber,
        termsText: termsText || '',
        grandTotal: grandTotalFormatted,
        tableHTML,
        headerHTML,
        emailContent: emailContent || '',
        emailLink: emailLink || (gmailMessageId ? GMAIL_INBOX_URL + gmailMessageId : ''),
        gmailMessageId: gmailMessageId || '',
        saved: false
    };
}

/**
 * Process a single email: optional duplicate check, generate quotation, assign quote number, save.
 * @param {object} ctx - Ingest context (getInstructionsContent, getDefaultTermsContent, generateQuotationData, getNextQuoteNumber, saveQuotation, findQuotationByGmailMessageId, uploadEnquiryFileToOpenAI)
 * @param {object} email - { id, subject, from, date, body, attachments: [ { name, contentType, base64 } ] }
 * @returns {{ success: true, id: number } | { success: false, error: string, emailId?: string }}
 */
async function processOneEmail(ctx, email) {
    const emailId = email.id;
    if (!emailId) {
        return { success: false, error: 'Missing email id', emailId: undefined };
    }

    if (ctx.findQuotationByGmailMessageId) {
        const existing = await ctx.findQuotationByGmailMessageId(emailId);
        if (existing) {
            return { success: false, error: 'Already imported (duplicate)', emailId };
        }
    }

    const instructions = await ctx.getInstructionsContent();
    if (!instructions || !instructions.trim()) {
        return { success: false, error: 'No instructions configured on server', emailId };
    }

    const defaultTerms = await ctx.getDefaultTermsContent();
    const body = email.body || '';

    let enquiryFileId = null;
    const pdfAttachment = getFirstPdfAttachment(email.attachments || []);
    if (pdfAttachment && ctx.uploadEnquiryFileToOpenAI) {
        try {
            enquiryFileId = await ctx.uploadEnquiryFileToOpenAI({
                buffer: pdfAttachment.buffer,
                originalname: pdfAttachment.name,
                contentType: pdfAttachment.contentType
            });
        } catch (err) {
            console.warn('Gmail ingest: failed to upload attachment to OpenAI for email ' + emailId, err.message);
        }
    }

    if (!body.trim() && !enquiryFileId) {
        return { success: false, error: 'Email has no body and no PDF attachment', emailId };
    }

    let aiResult;
    try {
        aiResult = await ctx.generateQuotationData({
            emailContent: body,
            instructions,
            enquiryFileId: enquiryFileId || undefined
        });
    } catch (err) {
        const message = err && (err.message || err.error || String(err));
        return { success: false, error: message || 'Failed to generate quotation', emailId };
    }

    if (!aiResult || !aiResult.lineItems) {
        aiResult = { ...aiResult, lineItems: [] };
    }

    let quoteNumber = '';
    if (ctx.getNextQuoteNumber) {
        try {
            const num = await ctx.getNextQuoteNumber();
            quoteNumber = formatQuoteNumber(num);
        } catch (err) {
            console.warn('Gmail ingest: getNextQuoteNumber failed', err.message);
        }
    }

    const emailLink = emailId ? GMAIL_INBOX_URL + emailId : '';
    const quotation = buildQuotationToSave({
        aiResult,
        quoteNumber,
        termsText: defaultTerms,
        emailContent: body,
        gmailMessageId: emailId,
        emailLink
    });

    if (ctx.saveQuotation) {
        try {
            await ctx.saveQuotation(quotation);
        } catch (err) {
            const message = err && (err.message || err.error || String(err));
            return { success: false, error: message || 'Failed to save quotation', emailId };
        }
    }

    return { success: true, id: quotation.id, emailId };
}

/**
 * Process all emails; collect created ids and errors.
 * @param {object} ctx - Same as processOneEmail
 * @param {Array<object>} emails - Array of email objects
 * @returns {{ created: number, ids: number[], errors: Array<{ emailId?: string, error: string }> }}
 */
async function processAllEmails(ctx, emails) {
    const ids = [];
    const errors = [];

    if (!emails || !Array.isArray(emails)) {
        return { created: 0, ids: [], errors: [{ error: 'Missing or invalid emails array' }] };
    }

    for (const email of emails) {
        const result = await processOneEmail(ctx, email);
        if (result.success) {
            ids.push(result.id);
        } else {
            errors.push({
                emailId: result.emailId,
                error: result.error || 'Unknown error'
            });
        }
    }

    return {
        created: ids.length,
        ids,
        errors
    };
}

module.exports = {
    buildQuotationToSave,
    processOneEmail,
    processAllEmails,
    GMAIL_INBOX_URL
};
