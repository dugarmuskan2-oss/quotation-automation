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

/** Max attachment size in bytes (3 MB). Larger attachments are skipped to avoid 413. */
var MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Max bodyHtml length; truncate if larger to reduce payload. */
var MAX_BODYHTML_LENGTH = 200000;

/** Max request body size in bytes (Vercel limit ~4.5 MB). Use 4 MB to stay safe. */
var MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Max emails per request. Keep at 1 so each request finishes within Vercel's 60s timeout (AI generation per email takes ~30–60s). */
var MAX_EMAILS_PER_REQUEST = 1;

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
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      Logger.log('Skipping attachment (too large): ' + attName + ' (' + (bytes.length / 1024).toFixed(1) + ' KB)');
      continue;
    }
    var isPdf = ct.indexOf('pdf') !== -1 || nameLow.endsWith('.pdf');
    var excelExts = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.xlx', '.xlw', '.ods', '.fods', '.csv', '.dif', '.sylk', '.slk', '.prn', '.xml'];
    var isExcel = ct.indexOf('spreadsheet') !== -1 || ct.indexOf('ms-excel') !== -1 || ct.indexOf('opendocument.spreadsheet') !== -1 || excelExts.some(function(e) { return nameLow.endsWith(e); });
    var isWord = ct.indexOf('msword') !== -1 || ct.indexOf('wordprocessingml') !== -1 || ct.indexOf('rtf') !== -1 || nameLow.endsWith('.docx') || nameLow.endsWith('.doc') || nameLow.endsWith('.rtf');
    if (!isPdf && !isExcel && !isWord) {
      Logger.log('Skipping attachment (unsupported type): ' + attName + ' (contentType: ' + ct + ')');
      continue;
    }
    Logger.log('Including attachment: ' + attName + ' (' + (bytes.length / 1024).toFixed(1) + ' KB, ' + (isPdf ? 'PDF' : isExcel ? 'Excel' : 'Word') + ')');
    attachments.push({
      name: attName,
      contentType: att.getContentType(),
      base64: Utilities.base64Encode(bytes)
    });
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

  var totalCreated = 0;
  for (var i = 0; i < emails.length; i += MAX_EMAILS_PER_REQUEST) {
    var batch = emails.slice(i, i + MAX_EMAILS_PER_REQUEST);
    var payloadStr = JSON.stringify({ emails: batch });
    if (payloadStr.length > MAX_PAYLOAD_BYTES) {
      Logger.log('Skipping email ' + (i + 1) + ': payload too large');
      continue;
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
