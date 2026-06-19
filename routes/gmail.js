'use strict';

const express = require('express');
const { sendEmail, lookupMessageThread } = require('../utils/gmail');
const { generateQuotationPdf } = require('../utils/pdf-generator');
const { quotationFromItem } = require('./quotations');

// Prefix a subject with "Re:" unless it already has one (avoids "Re: Re: ...").
function replySubject(original) {
  const s = String(original || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function createGmailRouter({ ddbDocClient, ddbTableName } = {}) {
  const router = express.Router();

  router.get('/resolve-thread', async (req, res) => {
    const { messageId } = req.query;
    if (!messageId) return res.status(400).json({ error: 'messageId is required' });
    try {
      const info = await lookupMessageThread(messageId);
      res.json(info);
    } catch (err) {
      console.error('Thread resolve error:', err.message);
      res.status(500).json({ error: 'Could not read original email thread: ' + err.message });
    }
  });

  // Send quotation PDF — fetches quotation from DynamoDB and generates PDF server-side.
  // Client sends only quotation ID + email params (no PDF base64), bypassing Vercel's 4.5MB limit.
  router.post('/send-quotation', async (req, res) => {
    const { quotationId, bodyHtml, replyToMessageId, threadId: providedThreadId, inReplyTo: providedInReplyTo, references: providedReferences, to: providedTo, subject: providedSubject } = req.body;

    if (!quotationId) return res.status(400).json({ error: 'quotationId is required' });
    if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml is required' });
    if (!ddbDocClient || !ddbTableName) return res.status(500).json({ error: 'Database not configured' });

    // Fetch quotation from DynamoDB
    let quotation;
    try {
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      const result = await ddbDocClient.send(new GetCommand({
        TableName: ddbTableName,
        Key: { id: String(quotationId) },
        ConsistentRead: true,   // ensure we read edits the client just flushed before sending
      }));
      if (!result.Item) return res.status(404).json({ error: 'Quotation not found' });
      quotation = quotationFromItem(result.Item);
      if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    } catch (err) {
      console.error('DynamoDB fetch error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch quotation: ' + err.message });
    }

    // Resolve thread info (use pre-resolved values from client if provided)
    let to = providedTo;
    let subject = providedSubject;
    let threadId = providedThreadId;
    let inReplyTo = providedInReplyTo;
    let references = providedReferences;

    if (replyToMessageId && (!to || !threadId)) {
      try {
        const info = await lookupMessageThread(replyToMessageId);
        if (!threadId && info.threadId) threadId = info.threadId;
        if (!inReplyTo && info.rfcMessageId) { inReplyTo = info.rfcMessageId; references = info.rfcMessageId; }
        if (!to && info.fromEmail) to = info.fromEmail;
        if (!subject && info.subject) subject = replySubject(info.subject);
      } catch (err) {
        console.error('Thread lookup failed:', err.message);
        return res.status(500).json({ error: 'Could not read original email thread: ' + err.message });
      }
    }

    if (!to) return res.status(400).json({ error: 'Could not determine recipient' });
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    // Generate PDF server-side
    let pdfBuffer;
    try {
      pdfBuffer = await generateQuotationPdf(quotation);
    } catch (err) {
      console.error('PDF generation error:', err.message);
      return res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
    }

    const pdfBase64 = pdfBuffer.toString('base64');
    const pdfFilename = `Quotation-${(quotation.quoteNumber || quotation.id || 'DSC').replace(/[^a-zA-Z0-9-]/g, '-')}.pdf`;

    try {
      const result = await sendEmail({ to, subject, bodyHtml, pdfBase64, pdfFilename, threadId, inReplyTo, references });
      res.json({ success: true, messageId: result.messageId, threadId: result.threadId, sentTo: to });
    } catch (err) {
      console.error('Gmail send error:', err.message);
      res.status(500).json({ error: 'Failed to send email: ' + err.message });
    }
  });

  // Legacy route kept for non-Vercel use (direct base64 send)
  router.post('/send-email', async (req, res) => {
    let { to, subject, bodyHtml, pdfBase64, pdfFilename, replyToMessageId, threadId, inReplyTo, references } = req.body;

    if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml is required' });
    if (!to && !replyToMessageId) return res.status(400).json({ error: 'to or replyToMessageId is required' });

    if (replyToMessageId && (!to || !threadId)) {
      try {
        const info = await lookupMessageThread(replyToMessageId);
        if (!threadId) threadId = info.threadId;
        if (!inReplyTo && info.rfcMessageId) { inReplyTo = info.rfcMessageId; references = info.rfcMessageId; }
        if (!to && info.fromEmail) to = info.fromEmail;
        if (!subject && info.subject) subject = replySubject(info.subject);
      } catch (err) {
        console.error('Thread lookup failed:', err.message);
        return res.status(500).json({ error: 'Could not read original email thread: ' + err.message });
      }
    }

    if (!to) return res.status(400).json({ error: 'Could not determine recipient' });
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    try {
      const result = await sendEmail({ to, subject, bodyHtml, pdfBase64, pdfFilename, threadId, inReplyTo, references });
      res.json({ success: true, messageId: result.messageId, threadId: result.threadId, sentTo: to });
    } catch (err) {
      console.error('Gmail send error:', err.message);
      res.status(500).json({ error: 'Failed to send email: ' + err.message });
    }
  });

  return router;
}

module.exports = createGmailRouter;
