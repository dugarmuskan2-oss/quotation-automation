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
    var msg = thread.getMessages()[0];
    if (postDirectoryEmail_(msg)) {
      thread.removeLabel(label);
      thread.addLabel(done);
      sent++;
    }
  });
  Logger.log('Sent ' + sent + ' email(s) to the directory queue.');
  return sent;
}

/** POST one message to /api/contacts/pending. Returns true only on a 2xx response. */
function postDirectoryEmail_(msg) {
  var attachments = msg.getAttachments() || [];
  var firstFile = attachments.length ? attachments[0].getName() : '';
  var payload = {
    from: extractAddress_(msg.getFrom()),
    subject: msg.getSubject() || '',
    file: firstFile,
    kind: /pdf$/i.test(firstFile) ? 'pdf' : 'photo',
    text: (msg.getPlainBody() || '').slice(0, 18000),
  };
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

/** "Rakesh Shah <sales@x.com>" → "sales@x.com". */
function extractAddress_(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}
