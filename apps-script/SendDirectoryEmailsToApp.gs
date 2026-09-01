/**
 * SendDirectoryEmailsToApp.gs — feed the app's Partner Directory from a Gmail label.
 *
 * Paste this file into the SAME Apps Script project as SendLabeledEmailsToApp.gs
 * (it reuses getAppUrl() and getIngestSecret() from there — no new setup).
 *
 * Flow: tag any email in Gmail with the DIRECTORY_LABEL below — a supplier's brochure,
 * a transporter's rate card, a visiting-card photo. Run "Add to Directory" (menu or this
 * function directly) and each tagged email is POSTed to /api/contacts/pending, where it
 * waits in the app's 📇 Recent-changes queue. NOTHING is saved to the directory until
 * the owner approves it there. After a successful send the label is swapped for the
 * -processed one so the same email is never sent twice.
 *
 * Attachment text: PDFs can't be read here, but their NAME travels with the email so the
 * app knows what arrived; the email body and any plain-text content go across in full.
 */

var DIRECTORY_LABEL = 'Quotation Automation/Add to Directory';
var DIRECTORY_DONE_LABEL = 'Quotation Automation/Add to Directory-processed';

function sendDirectoryEmailsToApp() {
  var label = GmailApp.getUserLabelByName(DIRECTORY_LABEL);
  if (!label) {
    Logger.log('Label not found: ' + DIRECTORY_LABEL + ' — create it in Gmail first.');
    return 0;
  }
  var done = GmailApp.getUserLabelByName(DIRECTORY_DONE_LABEL) || GmailApp.createLabel(DIRECTORY_DONE_LABEL);
  var threads = label.getThreads(0, 20);
  var sent = 0;
  threads.forEach(function (thread) {
    var msg = pickMessage_(thread.getMessages());
    if (msg && postDirectoryEmail_(msg)) {
      thread.removeLabel(label);
      thread.addLabel(done);
      sent++;
    }
  });
  Logger.log('Sent ' + sent + ' email(s) to the directory queue.');
  return sent;
}

/**
 * Which message in the labelled thread is the one meant?
 *
 * Labels in Gmail sit on the whole THREAD, so tagging a supplier's reply used to read
 * messages[0] — the OLDEST, which in a reply is our own outgoing enquiry. The rate list he
 * attached was never looked at, and the card came back with our own address on it.
 * So: the newest message carrying a readable file, else simply the newest.
 */
function pickMessage_(messages) {
  var list = messages || [];
  for (var i = list.length - 1; i >= 0; i--) {
    if (pickReadableAttachment_(list[i].getAttachments())) return list[i];
  }
  return list.length ? list[list.length - 1] : null;
}

/** Attachments bigger than this can't be forwarded (Vercel caps the request at ~4.5 MB
 *  and base64 inflates by a third). The name still travels, so nothing is silently lost. */
var MAX_DIRECTORY_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** POST one message to /api/contacts/pending. Returns true only on a 2xx response. */
function postDirectoryEmail_(msg) {
  var attachments = msg.getAttachments() || [];
  var first = pickReadableAttachment_(attachments);
  var firstFile = first ? first.getName() : '';
  var payload = {
    from: extractAddress_(msg.getFrom()),
    subject: msg.getSubject() || '',
    file: firstFile,
    kind: /pdf$/i.test(firstFile) ? 'pdf' : 'photo',
    text: (msg.getPlainBody() || '').slice(0, 18000),
  };
  // Send the brochure itself, not just its name — reading it is the entire point.
  if (first && first.getSize() <= MAX_DIRECTORY_ATTACHMENT_BYTES) {
    payload.fileBase64 = Utilities.base64Encode(first.getBytes());
  } else if (first) {
    payload.text += '\n\n[Attachment ' + firstFile + ' was too large to send for reading.]';
  }
  // Three rate lists in one email, or an .xlsx one, used to vanish without a word — the card
  // was then built from the covering note alone and looked complete.
  var skipped = skippedNames_(attachments, firstFile);
  if (skipped.length) {
    payload.text += '\n\n[Not read: ' + skipped.join(', ') + '. Only one PDF or photo per email'
      + ' is read. Send the others as their own email.]';
  }
  var headers = {};
  var secret = getIngestSecret();
  if (secret) headers['X-Ingest-Secret'] = secret;
  var resp = UrlFetchApp.fetch(getAppUrl() + '/api/contacts/pending', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: headers,
    muteHttpExceptions: true,
  });
  var ok = resp.getResponseCode() >= 200 && resp.getResponseCode() < 300;
  if (!ok) Logger.log('Directory ingest failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
  return ok;
}

/** The first PDF or image — a signature logo is skipped, a brochure is not. */
function pickReadableAttachment_(attachments) {
  var best = null;
  (attachments || []).forEach(function (a) {
    var name = a.getName() || '';
    if (!/\.(pdf|jpe?g|png)$/i.test(name)) return;
    if (a.getSize() < 20000 && /logo|signature|image00/i.test(name)) return;  // inline sig art
    if (!best || a.getSize() > best.getSize()) best = a;
  });
  return best;
}

/** Every attachment that was NOT read, by name. Signature artwork is left out — it is not
 *  something anyone meant to send. */
function skippedNames_(attachments, readName) {
  var out = [];
  (attachments || []).forEach(function (a) {
    var name = a.getName() || '';
    if (!name || name === readName) return;
    if (a.getSize() < 20000 && /logo|signature|image00/i.test(name)) return;  // inline sig art
    out.push(name);
  });
  return out;
}

/** "Rakesh Shah <sales@x.com>" → "sales@x.com". */
function extractAddress_(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}
