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

// Wrap a base64 string into 76-character lines (RFC 2045 §6.8).
function wrapBase64(str) {
  return String(str || '').replace(/(.{76})/g, '$1\r\n');
}

// Pull "data:" image URIs out of the HTML and replace them with cid: references.
// Email clients (Gmail) block data: images in received mail, so embedded images
// must be sent as inline (CID) attachments to render. Returns rewritten HTML and
// the list of inline images to attach. Remote http(s) image URLs are left as-is.
function extractInlineImages(html) {
  const inlineImages = [];
  let idx = 0;
  const rewritten = String(html || '').replace(
    /src\s*=\s*(['"])data:(image\/[a-zA-Z0-9.+-]+);base64,([^'"]+)\1/gi,
    (match, quote, contentType, data) => {
      idx += 1;
      const cid = `img${idx}@dscpipes`;
      inlineImages.push({ cid, contentType, base64: data.replace(/\s+/g, '') });
      return `src="cid:${cid}"`;
    }
  );
  return { html: rewritten, inlineImages };
}

// A MIME entity is { headers: string[], body: string }.
function serializeEntity(entity) {
  return entity.headers.join('\r\n') + '\r\n\r\n' + entity.body;
}

function htmlEntity(html) {
  return {
    headers: ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'],
    body: wrapBase64(Buffer.from(html || '', 'utf8').toString('base64')),
  };
}

function imageEntity(img) {
  return {
    headers: [
      `Content-Type: ${img.contentType}`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${img.cid}"`,
    ],
    body: wrapBase64(img.base64),
  };
}

function pdfEntity(pdfBase64, pdfFilename) {
  const name = pdfFilename || 'quotation.pdf';
  return {
    headers: [
      `Content-Type: application/pdf; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
    ],
    body: wrapBase64(pdfBase64),
  };
}

function multipartEntity(subtype, children) {
  const boundary = `dsc_${subtype}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body = children.map(c => `--${boundary}\r\n${serializeEntity(c)}`).join('\r\n') + `\r\n--${boundary}--`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

/**
 * Build a raw RFC 2822 email message encoded as base64url.
 * Nests as needed: HTML, optionally multipart/related (HTML + inline images),
 * optionally multipart/mixed (body + PDF attachment).
 */
function buildRawMessage({ to, subject, bodyHtml, pdfBase64, pdfFilename, inReplyTo, references }) {
  const { html, inlineImages } = extractInlineImages(bodyHtml || '');

  let content = htmlEntity(html);
  if (inlineImages.length) {
    content = multipartEntity('related', [content, ...inlineImages.map(imageEntity)]);
  }
  if (pdfBase64) {
    content = multipartEntity('mixed', [content, pdfEntity(pdfBase64, pdfFilename)]);
  }

  const headers = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject || '', 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const raw = headers.concat(content.headers).join('\r\n') + '\r\n\r\n' + content.body;
  return Buffer.from(raw).toString('base64url');
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
