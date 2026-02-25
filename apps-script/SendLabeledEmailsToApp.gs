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
 *    - APP_URL: your app base URL (e.g. https://your-app.vercel.app)
 *    - INGEST_SECRET: same as on the server (optional)
 * 2. Copy this file into your report project, then add the call above to your
 *    Run Report function.
 */

var LABEL_NAME = 'Quotation Request'; // Default; overridden when you call sendLabeledEmailsToAppForLabel('YourLabel')

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

/**
 * Build the payload for one message: id, subject, from, date, body, attachments (name, contentType, base64).
 * @param {GmailApp.GmailMessage} message
 * @return {Object}
 */
function buildEmailPayload(message) {
  var id = message.getId();
  var subject = message.getSubject();
  var from = message.getFrom();
  var date = message.getDate();
  var body = message.getPlainBody();
  var attachments = [];
  var attachmentBlobs = message.getAttachments();
  for (var i = 0; i < attachmentBlobs.length; i++) {
    var att = attachmentBlobs[i];
    // #region agent log
    var attName;
    try {
      attName = att.getName();
      Logger.log('[DEBUG E] buildEmailPayload attachment ' + i + ' msgId=' + id + ' attName=' + JSON.stringify(attName));
    } catch (e) {
      Logger.log('[DEBUG E] buildEmailPayload attachment ' + i + ' msgId=' + id + ' getName() threw: ' + e.toString());
      attName = 'attachment_' + i;
    }
    // #endregion
    attachments.push({
      name: attName,
      contentType: att.getContentType(),
      base64: Utilities.base64Encode(att.getBytes())
    });
  }
  return {
    id: id,
    subject: subject,
    from: from,
    date: date ? date.toISOString() : '',
    body: body || '',
    attachments: attachments
  };
}

/**
 * Fetch all messages with the given label (from all threads that have that label).
 * @param {string} labelName - Gmail label name
 * @return {Array<Object>} Array of email payloads
 */
function getEmailsWithLabel(labelName) {
  // #region agent log
  Logger.log('[DEBUG A-D] getEmailsWithLabel entry: labelName=' + JSON.stringify(labelName) +
    ' type=' + typeof labelName + ' isUndef=' + (labelName === undefined) + ' isNull=' + (labelName === null) +
    ' isEmpty=' + (labelName === '') + ' length=' + (labelName && labelName.length));
  // #endregion
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    Logger.log('Label not found: ' + labelName);
    return [];
  }
  var threads = label.getThreads();
  var emails = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      emails.push(buildEmailPayload(messages[m]));
    }
  }
  return emails;
}

/**
 * POST the emails array to the app's ingest endpoint.
 * @param {string} appUrl - Base URL of the app (no trailing slash)
 * @param {Array<Object>} emails - Array from getEmailsWithLabel
 * @param {string|null} secret - Optional X-Ingest-Secret value
 * @return {Object} Response object with status and body
 */
function postEmailsToApp(appUrl, emails, secret) {
  var endpoint = appUrl + '/api/ingest-from-gmail';
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
  return UrlFetchApp.fetch(endpoint, options);
}

/**
 * Get all emails with the given label and send them to the Quotation app.
 * Call this from your existing "Run Report" function.
 * @param {string} labelName - Exact Gmail label name (e.g. "Quotation Request")
 */
function sendLabeledEmailsToAppForLabel(labelName) {
  // #region agent log
  Logger.log('[DEBUG A-D] sendLabeledEmailsToAppForLabel entry: labelName=' + JSON.stringify(labelName) +
    ' type=' + typeof labelName + ' isUndef=' + (labelName === undefined) + ' isNull=' + (labelName === null));
  // #endregion
  if (labelName === undefined || labelName === null || (typeof labelName === 'string' && labelName.trim() === '')) {
    labelName = LABEL_NAME;
    Logger.log('[DEBUG post-fix] labelName was empty/undefined, using LABEL_NAME: ' + LABEL_NAME);
  }
  var appUrl = getAppUrl();
  var secret = getIngestSecret();
  var emails = getEmailsWithLabel(labelName);

  if (emails.length === 0) {
    Logger.log('No emails found with label: ' + labelName);
    return;
  }

  Logger.log('Sending ' + emails.length + ' email(s) to app for label: ' + labelName);

  var response = postEmailsToApp(appUrl, emails, secret);
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 200 && code < 300) {
    var data = JSON.parse(body);
    Logger.log('App: created ' + (data.created || 0) + ' quotation(s)');
    if (data.errors && data.errors.length > 0) {
      Logger.log('App errors: ' + JSON.stringify(data.errors));
    }
  } else {
    Logger.log('App request failed: ' + code + ' - ' + body);
  }
}

/**
 * Same as sendLabeledEmailsToAppForLabel but uses the default LABEL_NAME variable.
 * Use this if you prefer to set the label once at the top of this file.
 */
function sendLabeledEmailsToApp() {
  sendLabeledEmailsToAppForLabel(LABEL_NAME);
}
