/**
 * Google Apps Script: Send labeled Gmail emails to Quotation Automation app
 *
 * USE WITH YOUR EXISTING "RUN REPORT" BUTTON
 * ------------------------------------------
 * There is no separate "Send to app" button. At the END of your existing
 * "Run Report" function (the one that reads labels and lists email counts
 * and Gmail links), add ONE line:
 *
 *   sendLabeledEmailsToAppForLabel('Quotation Request');
 *
 * Replace 'Quotation Request' with the exact name of the label whose emails
 * should be sent to the app. Then when you click "Run Report", the report
 * runs as usual AND those labeled emails are pushed to the Quotation app.
 *
 * Setup (once):
 * 1. File > Project properties > Script properties
 *    - APP_URL: your deployment URL (e.g. https://quotation-automation.vercel.app).
 *      Must be the actual app URL, NOT the Vercel dashboard/project page.
 *    - INGEST_SECRET: same as on the server (optional)
 * 2. Copy this file into your report project, then add the call above to your
 *    Run Report function.
 */

var LABEL_NAME = 'Quotation Automation/Create Quotation'; // Default; overridden when you call sendLabeledEmailsToAppForLabel('YourLabel')

/**
 * Get the app URL from Script Properties (no trailing slash).
 * @return {string}
 */
function getAppUrl() {
  var url = PropertiesService.getScriptProperties().getProperty('APP_URL');
  if (!url) {
    throw new Error('Set APP_URL in Script Properties (e.g. https://your-app.vercel.app)');
  }
  return url.replace(/\/$/, '');
}

/**
 * Get the optional ingest secret from Script Properties.
 * @return {string|null}
 */
function getIngestSecret() {
  return PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
}

/** Max attachment size in bytes (3 MB binary -> ~4 MB base64, under Vercel's 4.5 MB).
 *  Larger attachments can't be forwarded, but their names are noted in the body
 *  (see buildEmailPayload) so they're never silently lost. */
var MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Max bodyHtml length; truncate if larger to reduce payload. */
var MAX_BODYHTML_LENGTH = 200000;

/** Max request body size in bytes. Vercel caps at ~4.5 MB; 4.3 MB leaves headroom. */
var MAX_PAYLOAD_BYTES = 4300 * 1024;

/** Max emails per request. Keep at 1 so each request finishes within Vercel's 60s timeout (AI generation per email takes ~30–60s). */
var MAX_EMAILS_PER_REQUEST = 1;

/** Images larger than this (bytes) are shrunk, so oversized photos fit and several
 *  photos of one requirement can travel together. ~1 MB stays well readable. */
var IMAGE_COMPRESS_TARGET_BYTES = 1024 * 1024;

/** Widths to try when shrinking an image (largest first), via Drive's thumbnail renderer. */
var IMAGE_RESIZE_WIDTHS = [2000, 1400, 1000];

/**
 * Shrink an image to fit under maxBytes. Apps Script has no native image resizer,
 * so this uses Drive's thumbnail renderer: save the blob to Drive, fetch a
 * width-limited render, delete the temp file. Returns { bytes, contentType }
 * (<= maxBytes) or null if it couldn't. Requires Drive access — the script will
 * prompt to re-authorize once when this is first used.
 * @param {number[]} bytes
 * @param {string} contentType
 * @param {string} name
 * @param {number} maxBytes
 * @return {{bytes: number[], contentType: string}|null}
 */
function compressImageToFit(bytes, contentType, name, maxBytes) {
  var tempFile = null;
  try {
    var blob = Utilities.newBlob(bytes, contentType, name || 'image');
    tempFile = DriveApp.createFile(blob);
    var fileId = tempFile.getId();
    var token = ScriptApp.getOAuthToken();
    for (var w = 0; w < IMAGE_RESIZE_WIDTHS.length; w++) {
      var url = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + IMAGE_RESIZE_WIDTHS[w];
      for (var attempt = 0; attempt < 2; attempt++) {
        var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
        if (resp.getResponseCode() === 200) {
          var out = resp.getBlob();
          var outBytes = out.getBytes();
          var outCt = out.getContentType() || 'image/jpeg';
          if (outCt.indexOf('image/') === 0 && outBytes.length > 0 && outBytes.length <= maxBytes) {
            return { bytes: outBytes, contentType: outCt };
          }
          break; // rendered but still too big at this width — try a smaller one
        }
        Utilities.sleep(400); // thumbnail may not be ready yet; brief retry
      }
    }
    return null;
  } catch (e) {
    Logger.log('Image compression failed for ' + name + ': ' + e.toString());
    return null;
  } finally {
    if (tempFile) { try { tempFile.setTrashed(true); } catch (e2) {} }
  }
}

/**
 * Get the content out of an oversized PDF (too big to forward as-is):
 *   - TEXT via Google's OCR/conversion — great for digital PDFs and clean scans
 *   - PAGE IMAGES when the conversion embeds them (scanned/non-text PDFs), each
 *     compressed to fit, so the AI's vision can read them
 *   - as a last resort, a rendered image of the first page
 * Returns { text: string, images: [{bytes, contentType, name}] } (best-effort;
 * any failure returns what it has, then the caller notes the file as too large).
 * Requires the Drive advanced service (Services > Drive API) for OCR conversion.
 * @return {{text: string, images: Array}}
 */
function extractLargePdf(bytes, name) {
  var result = { text: '', images: [] };
  var docId = null;
  try {
    var blob = Utilities.newBlob(bytes, 'application/pdf', (name || 'enquiry') + '.pdf');
    // Convert + OCR the PDF into a Google Doc (extracts the text layer, or OCRs a scan).
    var doc = Drive.Files.insert(
      { title: (name || 'enquiry') + ' (ocr)', mimeType: 'application/vnd.google-apps.document' },
      blob,
      { ocr: true }
    );
    docId = doc.id;
    var body = DocumentApp.openById(docId).getBody();
    result.text = (body.getText() || '').trim();
    var imgs = body.getImages();
    for (var k = 0; k < imgs.length && result.images.length < 4; k++) {
      try {
        var ib = imgs[k].getBlob();
        var ibytes = ib.getBytes();
        var ict = ib.getContentType() || 'image/png';
        if (ibytes.length > IMAGE_COMPRESS_TARGET_BYTES) {
          var c = compressImageToFit(ibytes, ict, (name || 'pdf') + '-p' + (k + 1), IMAGE_COMPRESS_TARGET_BYTES);
          if (c) { ibytes = c.bytes; ict = c.contentType; }
        }
        if (ibytes.length <= MAX_ATTACHMENT_BYTES) {
          result.images.push({ bytes: ibytes, contentType: ict, name: (name || 'pdf') + '-p' + (k + 1) + (ict.indexOf('png') >= 0 ? '.png' : '.jpg') });
        }
      } catch (eImg) { /* skip a bad page image */ }
    }
  } catch (e) {
    Logger.log('Large PDF OCR/convert failed for ' + name + ': ' + e.toString());
  } finally {
    if (docId) { try { DriveApp.getFileById(docId).setTrashed(true); } catch (e2) {} }
  }
  // Nothing usable yet — render the first page as an image so vision can read it.
  if (!result.text && result.images.length === 0) {
    var page1 = renderPdfFirstPageImage(bytes, name);
    if (page1) result.images.push(page1);
  }
  return result;
}

/** Render a PDF's first page to a compressed image via Drive's thumbnail renderer. */
function renderPdfFirstPageImage(bytes, name) {
  var tempFile = null;
  try {
    tempFile = DriveApp.createFile(Utilities.newBlob(bytes, 'application/pdf', (name || 'enquiry') + '.pdf'));
    var token = ScriptApp.getOAuthToken();
    var url = 'https://drive.google.com/thumbnail?id=' + tempFile.getId() + '&sz=w2000';
    for (var attempt = 0; attempt < 3; attempt++) {
      var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        var out = resp.getBlob();
        var b = out.getBytes();
        var c = out.getContentType() || 'image/jpeg';
        if (c.indexOf('image/') === 0 && b.length > 0 && b.length <= MAX_ATTACHMENT_BYTES) {
          return { bytes: b, contentType: c, name: (name || 'pdf') + '-p1.jpg' };
        }
      }
      Utilities.sleep(500); // thumbnail may still be rendering
    }
  } catch (e) {
    Logger.log('PDF first-page render failed for ' + name + ': ' + e.toString());
  } finally {
    if (tempFile) { try { tempFile.setTrashed(true); } catch (e2) {} }
  }
  return null;
}

/**
 * Build the payload for one message: id, subject, from, date, body, bodyHtml, attachments (name, contentType, base64).
 * Attachments over MAX_ATTACHMENT_BYTES are skipped. bodyHtml is truncated if too long.
 * @param {GmailApp.GmailMessage} message
 * @return {Object}
 */
function buildEmailPayload(message) {
  var id = message.getId();
  var subject = message.getSubject();
  var from = message.getFrom();
  var date = message.getDate();
  var body = message.getPlainBody();
  var bodyHtml = '';
  try {
    bodyHtml = message.getBody() || '';
  } catch (e) {
    // Some messages may not support getBody(); keep bodyHtml empty
  }
  if (bodyHtml && bodyHtml.length > MAX_BODYHTML_LENGTH) {
    bodyHtml = bodyHtml.substring(0, MAX_BODYHTML_LENGTH) + ' [truncated]';
  }
  var attachments = [];
  var skipped = [];       // attachments too large to forward — noted in the body
  var pdfTextParts = [];  // text pulled out of oversized PDFs
  var attachmentBlobs = message.getAttachments();
  if (attachmentBlobs.length > 0) {
    Logger.log('Email has ' + attachmentBlobs.length + ' attachment(s) from getAttachments()');
  }
  for (var i = 0; i < attachmentBlobs.length; i++) {
    var att = attachmentBlobs[i];
    var bytes = att.getBytes();
    var ct = (att.getContentType() || '').toLowerCase();
    var attName;
    try {
      attName = att.getName();
    } catch (e) {
      attName = 'attachment_' + i;
    }
    Logger.log('Attachment[' + i + ']: name="' + attName + '", contentType="' + ct + '", size=' + bytes.length + ' bytes');
    var nameLow = (attName || '').trim().toLowerCase();
    var isImage = ct.indexOf('image/') === 0 ||
      ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif'].some(function (e) { return nameLow.endsWith(e); });
    var isPdf = ct.indexOf('pdf') !== -1 || nameLow.endsWith('.pdf');

    var outBytes = bytes;
    var outCt = att.getContentType();
    // Shrink large photos so they fit under the request limit (and so several
    // photos of one requirement can travel together). Non-images can't be
    // compressed here — they fall through to the too-large note below.
    if (isImage && bytes.length > IMAGE_COMPRESS_TARGET_BYTES) {
      var compressed = compressImageToFit(bytes, att.getContentType(), attName, IMAGE_COMPRESS_TARGET_BYTES);
      if (compressed) {
        Logger.log('Compressed image ' + attName + ': ' + (bytes.length / 1024 / 1024).toFixed(1) + ' MB -> ' + (compressed.bytes.length / 1024 / 1024).toFixed(2) + ' MB');
        outBytes = compressed.bytes;
        outCt = compressed.contentType;
      }
    }
    if (outBytes.length > MAX_ATTACHMENT_BYTES) {
      if (isPdf) {
        // Oversized PDF: pull its text (digital PDFs / clean scans) and, for
        // scans, its page images — so the content still reaches the app.
        var ex = extractLargePdf(bytes, attName);
        var gotSomething = false;
        if (ex.text) { pdfTextParts.push('[PDF: ' + attName + ']\n' + ex.text); gotSomething = true; }
        for (var pi = 0; pi < ex.images.length; pi++) {
          attachments.push({ name: ex.images[pi].name, contentType: ex.images[pi].contentType, base64: Utilities.base64Encode(ex.images[pi].bytes) });
          gotSomething = true;
        }
        if (gotSomething) {
          Logger.log('Large PDF ' + attName + ': text=' + (ex.text ? ex.text.length : 0) + ' chars, page-images=' + ex.images.length);
          continue;
        }
      }
      // Couldn't shrink or extract — note it so staff open the original email.
      skipped.push(attName + ' (' + (bytes.length / 1024 / 1024).toFixed(1) + ' MB)');
      Logger.log('Skipping attachment (too large): ' + attName + ' (' + (bytes.length / 1024).toFixed(1) + ' KB)');
      continue;
    }
    // Forward EVERY type. The app extracts from PDF/Excel/Word/image and retains
    // all originals (including unreadable ones like .zip/.dwg) for viewing.
    Logger.log('Including attachment: ' + attName + ' (' + (outBytes.length / 1024).toFixed(1) + ' KB, ' + outCt + ')');
    attachments.push({
      name: attName,
      contentType: outCt,
      base64: Utilities.base64Encode(outBytes)
    });
  }
  if (pdfTextParts.length > 0) {
    body = (body || '') + '\n\n' + pdfTextParts.join('\n\n');
  }
  if (skipped.length > 0) {
    body = (body || '') + '\n\n[Note: ' + skipped.length + ' attachment(s) were too large to auto-process — ' +
      skipped.join(', ') + '. Open the original email (View in Gmail) to see them.]';
  }
  return {
    id: id,
    subject: subject,
    from: from,
    date: date ? date.toISOString() : '',
    body: body || '',
    bodyHtml: bodyHtml || '',
    attachments: attachments
  };
}

/**
 * Fetch all messages with the given label (from all threads that have that label).
 * @param {string} labelName - Gmail label name
 * @return {Array<Object>} Array of email payloads
 */
function getEmailsWithLabel(labelName) {
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    Logger.log('Label not found: ' + labelName);
    return [];
  }
  var threads = label.getThreads();
  var emails = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    if (messages.length > 0) {
      emails.push(buildEmailPayload(messages[0]));
    }
  }
  return emails;
}

/**
 * Fetch messages with the given label only within the specified time window (same window as report).
 * Takes the first message per thread that has at least one message in the window.
 * @param {string} labelName - Gmail label name
 * @param {string} startDateStr - Start date for search (yyyy/MM/dd)
 * @param {string} endDatePlusOneStr - End date for search (yyyy/MM/dd, exclusive)
 * @param {number} startMs - Start of window (ms)
 * @param {number} endMs - End of window (ms)
 * @return {Array<Object>} Array of email payloads
 */
function getEmailsWithLabelInWindow(labelName, startDateStr, endDatePlusOneStr, startMs, endMs) {
  try {
    var threads = GmailApp.search('label:"' + labelName + '" after:' + startDateStr + ' before:' + endDatePlusOneStr + ' -in:spam -in:trash');
  } catch (e) {
    Logger.log('Search failed for label ' + labelName + ': ' + e.toString());
    return [];
  }
  var emails = [];
  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    if (messages.length === 0) continue;
    var firstMsg = messages[0];
    var firstTs = firstMsg.getDate().getTime();
    if (firstTs >= startMs && firstTs <= endMs) {
      emails.push(buildEmailPayload(firstMsg));
    }
  }
  return emails;
}

/**
 * Fetch the first message of every thread that currently carries the label,
 * limited to the last `days` days (by received date) to keep the scan bounded.
 * Unlike getEmailsWithLabelInWindow, this does NOT filter by a report time window,
 * so it catches emails labelled AFTER a report already advanced past them.
 * The app de-duplicates by Gmail message id, so already-created quotes are skipped cheaply.
 * @param {string} labelName - Gmail label name
 * @param {number} [days] - Recency cap in days (default 60)
 * @return {Array<Object>} Array of email payloads
 */
function getEmailsWithLabelRecent(labelName, days) {
  var recency = (days && days > 0) ? days : 60;
  var threads;
  try {
    threads = GmailApp.search('label:"' + labelName + '" newer_than:' + recency + 'd -in:spam -in:trash');
  } catch (e) {
    Logger.log('Search failed for label ' + labelName + ': ' + e.toString());
    return [];
  }
  var emails = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    if (messages.length === 0) continue;
    emails.push(buildEmailPayload(messages[0]));
  }
  return emails;
}

/**
 * POST the emails array to the app's ingest endpoint.
 * Tries /api/ingest-from-gmail first; falls back to /api/health if 404 (Vercel routing).
 * @param {string} appUrl - Base URL of the app (no trailing slash), e.g. https://your-app.vercel.app
 * @param {Array<Object>} emails - Array from getEmailsWithLabel
 * @param {string|null} secret - Optional X-Ingest-Secret value
 * @return {Object} Response object with status and body
 */
function postEmailsToApp(appUrl, emails, secret) {
  var payload = JSON.stringify({ emails: emails });
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true
  };
  if (secret) {
    options.headers = { 'X-Ingest-Secret': secret };
  }
  var endpoint = appUrl + '/api/ingest-from-gmail';
  var response = UrlFetchApp.fetch(endpoint, options);
  if (response.getResponseCode() === 404) {
    endpoint = appUrl + '/api/health';
    response = UrlFetchApp.fetch(endpoint, options);
  }
  return response;
}

/**
 * Get all emails with the given label and send them to the Quotation app.
 * Call this from your existing "Run Report" function.
 * @param {string} labelName - Exact Gmail label name (e.g. "Quotation Request")
 * @param {number} [startMs] - Optional start of time window (ms). If provided with endMs and date strings, only emails in this window are sent.
 * @param {number} [endMs] - Optional end of time window (ms)
 * @param {string} [startDateStr] - Optional start date for Gmail search (yyyy/MM/dd)
 * @param {string} [endDatePlusOneStr] - Optional end date for Gmail search (yyyy/MM/dd, exclusive)
 */
function sendLabeledEmailsToAppForLabel(labelName, startMs, endMs, startDateStr, endDatePlusOneStr) {
  if (labelName === undefined || labelName === null || (typeof labelName === 'string' && labelName.trim() === '')) {
    labelName = LABEL_NAME;
  }
  var appUrl = getAppUrl();
  var secret = getIngestSecret();
  var emails;
  if (startMs != null && endMs != null && startDateStr && endDatePlusOneStr) {
    emails = getEmailsWithLabelInWindow(labelName, startDateStr, endDatePlusOneStr, startMs, endMs);
  } else {
    emails = getEmailsWithLabel(labelName);
  }

  if (emails.length === 0) {
    Logger.log('No emails found with label: ' + labelName);
    return 0;
  }

  Logger.log('Sending ' + emails.length + ' email(s) to app for label: ' + labelName);
  var totalCreated = postEmailBatchesToApp_(appUrl, secret, emails);
  Logger.log('App: created ' + totalCreated + ' quotation(s) total');
  return totalCreated;
}

/**
 * POST a pre-fetched array of email payloads to the app, one email per request
 * (see MAX_EMAILS_PER_REQUEST). Payloads over MAX_PAYLOAD_BYTES are skipped.
 * @param {string} appUrl - Base app URL (no trailing slash)
 * @param {string|null} secret - Optional X-Ingest-Secret value
 * @param {Array<Object>} emails - Email payloads from a getEmailsWithLabel* helper
 * @return {number} Total quotations created (sum of app `created` counts)
 */
function postEmailBatchesToApp_(appUrl, secret, emails) {
  var totalCreated = 0;
  for (var i = 0; i < emails.length; i += MAX_EMAILS_PER_REQUEST) {
    var batch = emails.slice(i, i + MAX_EMAILS_PER_REQUEST);
    var payloadStr = JSON.stringify({ emails: batch });
    if (payloadStr.length > MAX_PAYLOAD_BYTES) {
      // Don't drop the enquiry — resend WITHOUT attachments plus a visible note,
      // so a quote still gets created and staff can open the original email.
      Logger.log('Email ' + (i + 1) + ' payload too large (' + (payloadStr.length / 1024 / 1024).toFixed(1) + ' MB) — resending without attachments + note.');
      batch = batch.map(function (e) {
        var names = (e.attachments || []).map(function (a) { return a.name; }).join(', ');
        return {
          id: e.id, subject: e.subject, from: e.from, date: e.date,
          body: (e.body || '') + '\n\n[Note: attachment(s) too large to send automatically' +
            (names ? ' — ' + names : '') + '. Open the original email (View in Gmail) to view them.]',
          bodyHtml: e.bodyHtml, attachments: []
        };
      });
      payloadStr = JSON.stringify({ emails: batch });
    }
    var r = postEmailsToApp(appUrl, batch, secret);
    var c = r.getResponseCode();
    var b = r.getContentText();
    if (c >= 200 && c < 300) {
      var d = JSON.parse(b);
      totalCreated += (d.created || 0);
      if (d.errors && d.errors.length > 0) {
        Logger.log('App errors for email ' + (i + 1) + ': ' + JSON.stringify(d.errors));
      }
    } else {
      Logger.log('App request failed for email ' + (i + 1) + ': ' + c + ' - ' + (b.length > 200 ? b.substring(0, 200) + '...' : b));
    }
  }
  return totalCreated;
}

/**
 * Send every email that currently carries the label (within the last `days` days) to the app,
 * regardless of when it was received or when the label was applied. Use this for the manual
 * "Create Quotations" catch-up button so an email labelled AFTER a report still gets sent.
 * The app de-duplicates by Gmail message id, so already-created quotes are skipped cheaply.
 * @param {string} labelName - Gmail label name (defaults to LABEL_NAME)
 * @param {number} [days] - Recency cap in days (default 60)
 * @return {number} Total quotations created
 */
function sendLabeledEmailsToAppRecent(labelName, days) {
  if (labelName === undefined || labelName === null || (typeof labelName === 'string' && labelName.trim() === '')) {
    labelName = LABEL_NAME;
  }
  var appUrl = getAppUrl();
  var secret = getIngestSecret();
  var emails = getEmailsWithLabelRecent(labelName, days);

  if (emails.length === 0) {
    Logger.log('No recent emails found with label: ' + labelName);
    return 0;
  }

  Logger.log('Sending ' + emails.length + ' recently-labelled email(s) to app for label: ' + labelName);
  var totalCreated = postEmailBatchesToApp_(appUrl, secret, emails);
  Logger.log('App: created ' + totalCreated + ' quotation(s) total');
  return totalCreated;
}

/**
 * Same as sendLabeledEmailsToAppForLabel but uses the default LABEL_NAME variable.
 * Use this if you prefer to set the label once at the top of this file.
 */
function sendLabeledEmailsToApp() {
  sendLabeledEmailsToAppForLabel(LABEL_NAME);
}

/** Property key for deferred send-to-app (label name stored when report schedules background send). */
var PROP_SEND_TO_APP_LABEL = 'SEND_TO_APP_LABEL_PENDING';

/**
 * Run send-to-app when triggered (e.g. by a time trigger). Reads label from properties,
 * runs send, then removes the trigger. Call scheduleSendToAppAfterReport(labelName) to schedule.
 */
function runSendToAppWhenTriggered() {
  var labelName = PropertiesService.getScriptProperties().getProperty(PROP_SEND_TO_APP_LABEL);
  PropertiesService.getScriptProperties().deleteProperty(PROP_SEND_TO_APP_LABEL);
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'runSendToAppWhenTriggered') {
        ScriptApp.deleteTrigger(triggers[i]);
        break;
      }
    }
  } catch (e) {}
  if (!labelName || !labelName.trim()) {
    Logger.log('No pending send-to-app label; skipping.');
    return;
  }
  sendLabeledEmailsToAppForLabel(labelName.trim());
}

/**
 * Schedule send-to-app to run in the background (next minute). Report shows first; send runs after.
 * @param {string} labelName - Gmail label whose emails to send (e.g. "Quotation Automation/Create Quotation")
 */
function scheduleSendToAppAfterReport(labelName) {
  if (!labelName || (typeof labelName === 'string' && labelName.trim() === '')) {
    labelName = LABEL_NAME;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_SEND_TO_APP_LABEL, labelName);
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'runSendToAppWhenTriggered') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (e) {}
  ScriptApp.newTrigger('runSendToAppWhenTriggered')
    .timeBased()
    .after(60 * 1000)
    .create();
  Logger.log('Send to app scheduled for ~1 minute from now.');
}
