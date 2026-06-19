'use strict';

const express = require('express');
const { sendEmail, lookupMessageThread } = require('../utils/gmail');

// Prefix a subject with "Re:" unless it already has one (avoids "Re: Re: ...").
function replySubject(original) {
  const s = String(original || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function createGmailRouter() {
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

  // Send an email with an optional PDF attachment. The client generates the PDF
  // (same jsPDF used for Download/Print) and sends its base64 here. If
  // replyToMessageId is provided, the original sender/subject/thread are auto-filled.
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
