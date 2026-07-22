/**
 * Gmail Ingest – Core logic
 * Process one or many emails: generate quotation, build HTML, save (with duplicate check).
 */

const { buildTableHTMLFromLineItems, buildHeaderHTMLFromQuotation } = require('./htmlBuilder');
const { getAllPdfAttachments, getAllExcelAttachments, getAllWordAttachments, getAllImageAttachments } = require('./attachmentUtils');
const { buildItemSummary } = require('../utils/calculations');

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
/** Safe storage filename for an attachment (keeps extension, strips oddities). */
function sanitizeAttachmentName(name) {
    return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
}

/**
 * Persist the ORIGINAL enquiry attachments to storage so the quote card can
 * view/print them later (go-forward; older quotes have none). Best-effort:
 * a failed file is skipped, never blocks the quote.
 * @returns {Array<{name, key, contentType, size}>}
 */
async function persistEnquiryAttachments(ctx, attachments, emailId) {
    if (!ctx.saveEnquiryFile) return [];
    const files = [];
    const list = Array.isArray(attachments) ? attachments : [];
    for (let i = 0; i < list.length; i++) {
        const att = list[i];
        if (!att || !att.base64) continue;
        try {
            const buffer = Buffer.from(att.base64, 'base64');
            const fileName = emailId + '-' + i + '-' + sanitizeAttachmentName(att.name);
            const key = await ctx.saveEnquiryFile({ buffer, fileName });
            files.push({ name: att.name || fileName, key: String(key), contentType: att.contentType || '', size: buffer.length });
        } catch (err) {
            console.warn('Gmail ingest: failed to persist attachment ' + (att && att.name) + ' for email ' + emailId, err.message);
        }
    }
    return files;
}

function buildQuotationToSave({ aiResult, quoteNumber, termsText, emailContent, emailContentHtml, gmailMessageId, emailLink, enquiryFiles, enquiryFileNotes }) {
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
        saved: false,
        // Admin margin-allocation flow: new enquiries wait on the admin desk
        // until margins are allocated (adminStatus -> 'ready') or regretted.
        adminStatus: 'awaiting',
        adminNote: '',
        itemSummary: buildItemSummary(aiResult.lineItems || []),
        enquiryFiles: Array.isArray(enquiryFiles) ? enquiryFiles : [],
        // Originals not forwarded as-is (e.g. an oversized PDF whose text was
        // extracted) — shown as non-clickable info chips on the card.
        enquiryFileNotes: Array.isArray(enquiryFileNotes) ? enquiryFileNotes : []
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

    if (await isDuplicateEmail(ctx, emailId)) {
        return { success: false, error: 'Already imported (duplicate)', emailId };
    }

    const result = await generateAndSaveQuotation(ctx, email, emailId);
    // If we claimed the message id (reserve) but creation failed, release the claim
    // so a later run can retry this email instead of it being blocked forever.
    if (!result.success && ctx.releaseGmailMessageId) {
        await ctx.releaseGmailMessageId(emailId);
    }
    return result;
}

/**
 * Duplicate guard. Prefers reserveGmailMessageId — an atomic conditional write that
 * only the FIRST ingest of a given message can win, so concurrent/rapid re-sends
 * cannot each create a quote. Falls back to the older findQuotationByGmailMessageId
 * lookup when reserve isn't wired up (e.g. in tests).
 * @param {object} ctx
 * @param {string} emailId - Gmail message id
 * @returns {Promise<boolean>} true if this email is a duplicate (skip it)
 */
async function isDuplicateEmail(ctx, emailId) {
    if (ctx.reserveGmailMessageId) {
        const reserved = await ctx.reserveGmailMessageId(emailId);
        return !reserved;
    }
    if (ctx.findQuotationByGmailMessageId) {
        const existing = await ctx.findQuotationByGmailMessageId(emailId);
        return !!existing;
    }
    return false;
}

/**
 * Generate the quotation for one email and save it. The duplicate guard in
 * processOneEmail has already claimed this message id before we get here.
 * @param {object} ctx
 * @param {object} email
 * @param {string} emailId
 * @returns {{ success: true, id: number, emailId: string } | { success: false, error: string, emailId: string }}
 */
async function generateAndSaveQuotation(ctx, email, emailId) {
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

    // Send EVERY enquiry image to the AI — a photographed requirement often
    // spans several photos, so page 2+ must not be dropped.
    const enquiryImageDataUrls = getAllImageAttachments(allAttachments).map(function (img) {
        const mime = (img.contentType || 'image/png').split(';')[0].trim();
        return 'data:' + mime + ';base64,' + img.buffer.toString('base64');
    });
    if (enquiryImageDataUrls.length > 0) {
        if (!body.trim()) {
            body = enquiryImageDataUrls.length > 1
                ? '(Enquiry is in the ' + enquiryImageDataUrls.length + ' attached images. Read ALL of them and extract every item.)'
                : '(Enquiry is in the attached image. Please extract all relevant details from the image.)';
        }
        console.log('Gmail ingest: sending all ' + enquiryImageDataUrls.length + ' image(s) to the AI for email ' + emailId);
    }

    if (!body.trim() && enquiryFileIds.length === 0 && enquiryImageDataUrls.length === 0) {
        return { success: false, error: 'Email has no body and no supported attachment (PDF, Excel, Word, Image)', emailId };
    }

    let aiResult;
    try {
        aiResult = await ctx.generateQuotationData({
            emailContent: body,
            instructions,
            enquiryFileIds: enquiryFileIds.length > 0 ? enquiryFileIds : undefined,
            enquiryImageDataUrls: enquiryImageDataUrls.length > 0 ? enquiryImageDataUrls : undefined
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
    const enquiryFiles = await persistEnquiryAttachments(ctx, allAttachments, emailId);
    // Large originals the Apps Script uploaded straight to storage (bypassing the
    // request-size limit) — already stored, so just record them as viewable files.
    const preUploaded = (Array.isArray(email.uploadedFiles) ? email.uploadedFiles : [])
        .filter(function (f) { return f && f.key; })
        .map(function (f) { return { name: f.name || 'file', key: String(f.key), contentType: f.contentType || '', size: f.size || 0 }; });
    const quotation = buildQuotationToSave({
        aiResult,
        quoteNumber,
        termsText: defaultTerms,
        emailContent: body,
        emailContentHtml: email.bodyHtml || '',
        gmailMessageId: emailId,
        emailLink,
        enquiryFiles: enquiryFiles.concat(preUploaded),
        enquiryFileNotes: Array.isArray(email.attachmentNotes) ? email.attachmentNotes : []
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
