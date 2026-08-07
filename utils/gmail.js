const { google } = require('googleapis');

let _gmailClient = null;
let _peopleClient = null;

function getGoogleAuth() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail credentials missing from .env (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return auth;
}

function createGmailClient() {
  if (_gmailClient) return _gmailClient;
  _gmailClient = google.gmail({ version: 'v1', auth: getGoogleAuth() });
  return _gmailClient;
}

function createPeopleClient() {
  if (_peopleClient) return _peopleClient;
  _peopleClient = google.people({ version: 'v1', auth: getGoogleAuth() });
  return _peopleClient;
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
function buildRawMessage({ to, subject, bodyHtml, pdfBase64, pdfFilename, inReplyTo, references, cc, bcc }) {
  const { html, inlineImages } = extractInlineImages(bodyHtml || '');

  let content = htmlEntity(html);
  if (inlineImages.length) {
    content = multipartEntity('related', [content, ...inlineImages.map(imageEntity)]);
  }
  if (pdfBase64) {
    content = multipartEntity('mixed', [content, pdfEntity(pdfBase64, pdfFilename)]);
  }

  // Only emit To when there is a real address. A Bcc-only message (the supplier enquiry) used
  // the RFC group placeholder "undisclosed-recipients:;" here — valid by the spec, but the Gmail
  // API rejects it outright with "Invalid To header", so every supplier enquiry failed to send.
  // sendEmail now fills `to` with our own address for Bcc-only mail; if that lookup fails we
  // send with no To header at all, which Gmail accepts, rather than one it refuses.
  const headers = [];
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: =?UTF-8?B?${Buffer.from(subject || '', 'utf8').toString('base64')}?=`);
  headers.push('MIME-Version: 1.0');
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const raw = headers.concat(content.headers).join('\r\n') + '\r\n\r\n' + content.body;
  return Buffer.from(raw).toString('base64url');
}

/**
 * Send an email via Gmail API.
 * Returns { messageId, threadId } on success.
 */
// The address this mailbox sends as. Looked up once — it cannot change for a given refresh
// token, and a Bcc-only message needs it so the To header is a real address.
let _ownAddress = null;
async function getOwnAddress() {
  if (_ownAddress !== null) return _ownAddress;
  try {
    const gmail = createGmailClient();
    const me = await gmail.users.getProfile({ userId: 'me' });
    _ownAddress = (me.data && me.data.emailAddress) || '';
  } catch (err) {
    console.error('Could not read the sending address:', err.message);
    _ownAddress = '';
  }
  return _ownAddress;
}

async function sendEmail({ to, subject, bodyHtml, pdfBase64, pdfFilename, threadId, inReplyTo, references, cc, bcc }) {
  const gmail = createGmailClient();
  // A supplier enquiry goes out one-per-supplier with the supplier on Bcc, so nobody sees who
  // else was asked — which leaves no To. Address it to ourselves: Gmail refuses the RFC
  // "undisclosed-recipients:;" placeholder, and the supplier seeing our own address in To is
  // both accurate and unremarkable.
  // Applies whether or not a Cc is present: with both boxes now Bcc+Cc, a send that carried a
  // Cc used to go out with NO To header at all, which reads as malformed to some clients.
  if (!to && bcc) to = await getOwnAddress();
  const raw = buildRawMessage({ to, subject, bodyHtml, pdfBase64, pdfFilename, inReplyTo, references, cc, bcc });
  const requestBody = { raw };
  if (threadId) requestBody.threadId = threadId;
  const res = await gmail.users.messages.send({ userId: 'me', requestBody });
  return { messageId: res.data.id, threadId: res.data.threadId };
}

// ── Labelling what we send (needs the gmail.modify scope) ──────────────────────
//
// Gmail has no "label this" option on send, so labelling is a second call made
// straight after. Nesting is by name: "Quotation Automation/Regret" shows up as
// Regret sitting inside the Quotation Automation group, and Gmail creates the
// parent implicitly, so there is nothing to set up by hand.

// Label ids are stable for the life of the mailbox, so one lookup per name is enough.
const _labelIdCache = new Map();

async function listLabelId(gmail, name) {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const wanted = String(name).toLowerCase();
  const hit = (res.data.labels || []).find(l => String(l.name || '').toLowerCase() === wanted);
  return hit ? hit.id : null;
}

async function findOrCreateLabelId(gmail, name) {
  if (_labelIdCache.has(name)) return _labelIdCache.get(name);

  let id = await listLabelId(gmail, name);
  if (!id) {
    try {
      const created = await gmail.users.labels.create({
        userId: 'me',
        requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      });
      id = created.data.id;
    } catch (err) {
      // Two sends racing to create the same label: Gmail rejects the loser with 409.
      // The winner's label is what we wanted anyway, so re-read rather than fail.
      if (err.code !== 409 && err.status !== 409) throw err;
      id = await listLabelId(gmail, name);
      if (!id) throw err;
    }
  }
  _labelIdCache.set(name, id);
  return id;
}

/**
 * Add a label to a thread we have just sent into.
 * Labelling a thread labels the conversation, which is what shows in the Gmail list.
 */
async function applyLabelToThread(threadId, labelName) {
  if (!threadId || !labelName) return false;
  const gmail = createGmailClient();
  const labelId = await findOrCreateLabelId(gmail, labelName);
  await gmail.users.threads.modify({ userId: 'me', id: threadId, requestBody: { addLabelIds: [labelId] } });
  return true;
}

async function lookupMessageThread(messageId) {
  const gmail = createGmailClient();
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'From', 'To', 'Cc', 'Subject'],
  });
  const threadId = msg.data.threadId;
  const headers = msg.data.payload.headers || [];
  const get = name => (headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase()) || {}).value || null;
  return {
    threadId,
    rfcMessageId: get('Message-ID'),
    fromEmail: get('From'),
    to: get('To'),   // other recipients on the enquiry — used to reply-all
    cc: get('Cc'),
    subject: get('Subject'),
  };
}

// ── Thread reading (Phase 5) — needs the gmail.readonly scope ───────────────────
function decodeGmailB64(data) {
  if (!data) return '';
  try { return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch (e) { return ''; }
}
function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|br|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
// Recursively pull the best readable body text from a Gmail message payload.
function extractBodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return decodeGmailB64(payload.body.data);
  if (Array.isArray(payload.parts) && payload.parts.length) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain' && p.body && p.body.data);
    if (plain) return decodeGmailB64(plain.body.data);
    for (let i = 0; i < payload.parts.length; i++) {
      const t = extractBodyText(payload.parts[i]);
      if (t) return t;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) return stripHtmlToText(decodeGmailB64(payload.body.data));
  return '';
}
// True for machine-generated messages that must NOT count as a real counterpart reply:
// out-of-office / vacation auto-replies (Auto-Submitted, X-Autoreply), and bounces or
// no-reply system senders. Keeps the reply detectors from flagging these as a reply.
function isAutoOrSystemMessage(getHeader, from) {
  const autoSubmitted = (getHeader('Auto-Submitted') || '').trim();
  if (autoSubmitted && !/^no$/i.test(autoSubmitted)) return true;   // auto-replied / auto-generated
  if (getHeader('X-Autoreply') || getHeader('X-Autorespond') || getHeader('X-Auto-Response-Suppress')) return true;
  if ((getHeader('Precedence') || '').toLowerCase().trim() === 'auto_reply') return true;
  const fromLc = String(from || '').toLowerCase();
  if (/(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(fromLc)) return true;
  return false;
}

// Read all messages in a thread (full format). `direction` is 'you' for messages we
// sent (SENT label) and 'customer' otherwise — used to tell whose reply is latest.
// `auto` marks machine messages (auto-replies/bounces) so they aren't counted as replies.
async function fetchThreadMessages(threadId) {
  const gmail = createGmailClient();
  const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = (res.data.messages || []).map(function (m) {
    const headers = (m.payload && m.payload.headers) || [];
    const get = name => (headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
    const from = get('From');
    return {
      id: m.id,
      direction: (m.labelIds || []).indexOf('SENT') >= 0 ? 'you' : 'customer',
      auto: isAutoOrSystemMessage(get, from),
      from: from,
      date: get('Date'),
      subject: get('Subject'),
      snippet: m.snippet || '',
      body: extractBodyText(m.payload) || m.snippet || '',
    };
  });
  return { threadId: threadId, messages: messages };
}

// ── Recipient autocomplete (People API) — mirrors Gmail's CC autocomplete ────────
// otherContacts.search = people you've emailed (auto-saved); searchContacts = saved
// contacts. Needs the People API enabled + contacts.other.readonly (+ contacts.readonly)
// scopes. The search endpoints need a one-time "warm-up" call (empty query) to prime
// their cache before they return results, so we do that once per process.
let _contactsWarmed = false;
async function warmContactsCache(people, readMask) {
  if (_contactsWarmed) return;
  _contactsWarmed = true;
  try {
    await Promise.all([
      people.otherContacts.search({ query: '', pageSize: 1, readMask }),
      people.people.searchContacts({ query: '', pageSize: 1, readMask }),
    ]);
  } catch (e) { /* warm-up is best-effort */ }
}
async function searchContactSuggestions(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const people = createPeopleClient();
  const readMask = 'names,emailAddresses';
  await warmContactsCache(people, readMask);
  const [other, saved] = await Promise.all([
    people.otherContacts.search({ query: q, pageSize: 10, readMask }).then(r => r.data.results || []).catch(() => []),
    people.people.searchContacts({ query: q, pageSize: 10, readMask }).then(r => r.data.results || []).catch(() => []),
  ]);
  const seen = {}, out = [];
  [].concat(other, saved).forEach(function (res) {
    const person = res.person || {};
    const name = (person.names && person.names[0] && person.names[0].displayName) || '';
    (person.emailAddresses || []).forEach(function (e) {
      const email = (e.value || '').trim();
      const key = email.toLowerCase();
      if (email && !seen[key]) { seen[key] = true; out.push({ name, email }); }
    });
  });
  return out.slice(0, 12);
}

module.exports = { sendEmail, lookupMessageThread, fetchThreadMessages, searchContactSuggestions, applyLabelToThread };
// Pure helpers exposed for unit testing (MIME structure, inline-image CID rewrite, body parse).
module.exports._test = { buildRawMessage, extractInlineImages, wrapBase64, extractBodyText, stripHtmlToText, isAutoOrSystemMessage, findOrCreateLabelId, _labelIdCache };
