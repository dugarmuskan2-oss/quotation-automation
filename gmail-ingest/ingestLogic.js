/**
 * Gmail Ingest – Core logic
 * Process one or many emails: generate quotation, build HTML, save (with duplicate check).
 */

const { buildTableHTMLFromLineItems, buildHeaderHTMLFromQuotation } = require('./htmlBuilder');
const { getAllPdfAttachments, getAllExcelAttachments, getAllWordAttachments, getAllImageAttachments } = require('./attachmentUtils');

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
 * @param {string} [params.emailContentHtml] - HTML body for display with tables intact
 * @param {string} params.gmailMessageId
 * @param {string} params.emailLink
 * @returns {object} Quotation object with id, tableHTML, headerHTML, grandTotal, saved, etc.
 */
function buildQuotationToSave({ aiResult, quoteNumber, termsText, emailContent, emailContentHtml, gmailMessageId, emailLink }) {
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
        emailContentHtml: emailContentHtml || '',
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
    let body = email.body || '';

    const enquiryFileIds = [];
    const pdfAttachments = getAllPdfAttachments(email.attachments || []);
    if (pdfAttachments.length > 0 && ctx.uploadEnquiryFileToOpenAI) {
        for (const pdf of pdfAttachments) {
            try {
                const fileId = await ctx.uploadEnquiryFileToOpenAI({
                    buffer: pdf.buffer,
                    originalname: pdf.name,
                    contentType: pdf.contentType
                });
                if (fileId) enquiryFileIds.push(fileId);
            } catch (err) {
                console.warn('Gmail ingest: failed to upload attachment ' + pdf.name + ' to OpenAI for email ' + emailId, err.message);
            }
        }
    }

    const extractedTextParts = [];
    const allAttachments = email.attachments || [];
    if (allAttachments.length > 0) {
        console.log('Gmail ingest: email ' + emailId + ' has ' + allAttachments.length + ' attachment(s): ' + allAttachments.map(a => a.name || 'unnamed').join(', '));
        // #region agent log
        const imageAtts = allAttachments.filter(a => {
            const ct = (a.contentType || '').toLowerCase();
            const n = (a.name || '').toLowerCase();
            return ct.includes('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(e => n.endsWith(e));
        });
        try {
            fetch('http://127.0.0.1:7242/ingest/401e8f63-b24f-4a79-ac2c-9ba6e0d45a1a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7c69cb' }, body: JSON.stringify({ sessionId: '7c69cb', location: 'ingestLogic.js:processOneEmail', message: 'Attachment audit', data: { emailId, totalAttachments: allAttachments.length, attachmentTypes: allAttachments.map(a => ({ name: a.name, contentType: a.contentType })), imageAttachmentCount: imageAtts.length, hasBodyHtml: !!(email.bodyHtml && email.bodyHtml.trim()) }, hypothesisId: 'H2', timestamp: Date.now() }) }).catch(() => {});
        } catch (_) {}
        // #endregion
    }
    if (ctx.extractTextFromAttachment) {
        const excelAttachments = getAllExcelAttachments(allAttachments);
        const wordAttachments = getAllWordAttachments(allAttachments);
        if (excelAttachments.length > 0 || wordAttachments.length > 0) {
            console.log('Gmail ingest: Excel=' + excelAttachments.length + ', Word=' + wordAttachments.length);
        }
        for (const att of excelAttachments) {
            try {
                const text = await ctx.extractTextFromAttachment({ buffer: att.buffer, originalname: att.name });
                if (text && text.trim()) {
                    extractedTextParts.push(`[Excel: ${att.name}]\n${text.trim()}`);
                    console.log('Gmail ingest: extracted ' + text.length + ' chars from Excel ' + att.name);
                } else {
                    console.warn('Gmail ingest: Excel ' + att.name + ' extracted empty text');
                }
            } catch (err) {
                console.warn('Gmail ingest: failed to extract text from Excel ' + att.name + ' for email ' + emailId, err.message);
            }
        }
        for (const att of wordAttachments) {
            try {
                const text = await ctx.extractTextFromAttachment({ buffer: att.buffer, originalname: att.name });
                if (text && text.trim()) extractedTextParts.push(`[Word: ${att.name}]\n${text.trim()}`);
            } catch (err) {
                console.warn('Gmail ingest: failed to extract text from Word ' + att.name + ' for email ' + emailId, err.message);
            }
        }
    }
    if (extractedTextParts.length > 0) {
        body = (body ? body + '\n\n' : '') + extractedTextParts.join('\n\n');
    }

    let enquiryImageDataUrl = null;
    const imageAttachments = getAllImageAttachments(allAttachments);
    if (imageAttachments.length > 0) {
        const first = imageAttachments[0];
        const mime = (first.contentType || 'image/png').split(';')[0].trim();
        enquiryImageDataUrl = 'data:' + mime + ';base64,' + first.buffer.toString('base64');
        if (!body.trim()) {
            body = '(Enquiry is in the attached image. Please extract all relevant details from the image.)';
        }
        console.log('Gmail ingest: using first of ' + imageAttachments.length + ' image(s) for email ' + emailId);
    }

    if (!body.trim() && enquiryFileIds.length === 0 && !enquiryImageDataUrl) {
        return { success: false, error: 'Email has no body and no supported attachment (PDF, Excel, Word, Image)', emailId };
    }

    let aiResult;
    // #region agent log
    try {
        fetch('http://127.0.0.1:7242/ingest/401e8f63-b24f-4a79-ac2c-9ba6e0d45a1a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7c69cb' }, body: JSON.stringify({ sessionId: '7c69cb', location: 'ingestLogic.js:processOneEmail', message: 'Before generateQuotationData', data: { emailId, hasEnquiryImageDataUrl: !!enquiryImageDataUrl, enquiryFileIdsCount: enquiryFileIds.length }, hypothesisId: 'H3', timestamp: Date.now() }) }).catch(() => {});
    } catch (_) {}
    // #endregion
    try {
        aiResult = await ctx.generateQuotationData({
            emailContent: body,
            instructions,
            enquiryFileIds: enquiryFileIds.length > 0 ? enquiryFileIds : undefined,
            enquiryImageDataUrl: enquiryImageDataUrl || undefined
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
        emailContentHtml: email.bodyHtml || '',
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
