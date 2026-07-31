'use strict';

const express = require('express');
const { sendEmail, lookupMessageThread, fetchThreadMessages, searchContactSuggestions } = require('../utils/gmail');

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

  // Read all messages in a quote's email thread (Phase 5). Accepts threadId or messageId.
  // Requires the gmail.readonly scope (re-run tools/gmail-auth.js after adding it).
  router.get('/thread-messages', async (req, res) => {
    let { threadId, messageId } = req.query;
    try {
      if (!threadId && messageId) {
        const info = await lookupMessageThread(messageId);
        threadId = info.threadId;
      }
      if (!threadId) return res.status(400).json({ error: 'threadId or messageId is required' });
      const data = await fetchThreadMessages(threadId);
      res.json(data);
    } catch (err) {
      console.error('Thread messages error:', err.message);
      res.status(500).json({ error: 'Could not read the thread: ' + err.message });
    }
  });

  // Real-time recipient autocomplete (Gmail-style). Returns [{name, email}] for the typed
  // fragment via the People API. Degrades to an empty list (no error surfaced) if the People
  // API isn't enabled / re-auth not done, so the field just shows no suggestions.
  router.get('/contact-suggestions', async (req, res) => {
    try {
      const suggestions = await searchContactSuggestions(req.query.q || '');
      res.json({ suggestions });
    } catch (err) {
      console.error('Contact suggestions error:', err.message);
      res.json({ suggestions: [], error: err.message });
    }
  });

  // Send an email with an optional PDF attachment. The client generates the PDF
  // (same jsPDF used for Download/Print) and sends its base64 here. If
  // replyToMessageId is provided, the original sender/subject/thread are auto-filled.
  router.post('/send-email', async (req, res) => {
    let { to, subject, bodyHtml, pdfBase64, pdfFilename, replyToMessageId, threadId, inReplyTo, references, cc, bcc } = req.body;

    if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml is required' });
    // A BCC-only message is legitimate — the supplier enquiry sends one email per supplier with
    // that supplier on Bcc, so nobody's address is exposed. Requiring `to` rejected those outright.
    if (!to && !bcc && !cc && !replyToMessageId) {
      return res.status(400).json({ error: 'to, cc, bcc or replyToMessageId is required' });
    }

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

    // A Bcc (or Cc) alone is a real recipient — only complain when there is nobody at all.
    if (!to && !bcc && !cc) return res.status(400).json({ error: 'Could not determine recipient' });
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    try {
      const result = await sendEmail({ to, subject, bodyHtml, pdfBase64, pdfFilename, threadId, inReplyTo, references, cc, bcc });
      res.json({ success: true, messageId: result.messageId, threadId: result.threadId, sentTo: to || bcc || cc });
    } catch (err) {
      console.error('Gmail send error:', err.message);
      res.status(500).json({ error: 'Failed to send email: ' + err.message });
    }
  });

  return router;
}

module.exports = createGmailRouter;
module.exports.replySubject = replySubject;
