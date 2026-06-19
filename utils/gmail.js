const { google } = require('googleapis');

let _gmailClient = null;

function createGmailClient() {
  if (_gmailClient) return _gmailClient;
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail credentials missing from .env (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  _gmailClient = google.gmail({ version: 'v1', auth });
  return _gmailClient;
}

/**
 * Build a raw RFC 2822 email message encoded as base64url.
 * Supports an optional PDF attachment (base64-encoded string).
 */
// Wrap a base64 string into 76-character lines (RFC 2045 §6.8).
function wrapBase64(str) {
  return String(str || '').replace(/(.{76})/g, '$1\r\n');
}

function buildRawMessage({ to, subject, bodyHtml, pdfBase64, pdfFilename, inReplyTo, references }) {
  const boundary = 'dsc_boundary_' + Date.now();
  // Base64-encode the HTML body so any '=', non-ASCII, or long lines survive intact.
  const htmlBase64 = wrapBase64(Buffer.from(bodyHtml || '', 'utf8').toString('base64'));
  const lines = [];

  lines.push(`To: ${to}`);
  lines.push(`Subject: =?UTF-8?B?${Buffer.from(subject || '', 'utf8').toString('base64')}?=`);
  lines.push('MIME-Version: 1.0');
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);

  if (pdfBase64) {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(htmlBase64);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: application/pdf; name="${pdfFilename || 'quotation.pdf'}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${pdfFilename || 'quotation.pdf'}"`);
    lines.push('');
    lines.push(wrapBase64(pdfBase64));
    lines.push('');
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(htmlBase64);
  }

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
  return raw;
}

/**
 * Send an email via Gmail API.
 * Returns { messageId, threadId } on success.
 */
async function sendEmail({ to, subject, bodyHtml, pdfBase64, pdfFilename, threadId, inReplyTo, references }) {
  const gmail = createGmailClient();
  const raw = buildRawMessage({ to, subject, bodyHtml, pdfBase64, pdfFilename, inReplyTo, references });
  const requestBody = { raw };
  if (threadId) requestBody.threadId = threadId;
  const res = await gmail.users.messages.send({ userId: 'me', requestBody });
  return { messageId: res.data.id, threadId: res.data.threadId };
}

async function lookupMessageThread(messageId) {
  const gmail = createGmailClient();
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'From', 'Subject'],
  });
  const threadId = msg.data.threadId;
  const headers = msg.data.payload.headers || [];
  const get = name => (headers.find(h => h.name === name) || {}).value || null;
  return {
    threadId,
    rfcMessageId: get('Message-ID'),
    fromEmail: get('From'),
    subject: get('Subject'),
  };
}

module.exports = { sendEmail, lookupMessageThread };
