/**
 * EnquiryRegister.gs — auto-fills the enquiry register sheet from the app.
 *
 * Runs INSIDE the register Google Sheet (Extensions → Apps Script; paste this file).
 * One-time setup, in the Apps Script editor:
 *   1. Project Settings → Script Properties:
 *        APP_URL       = your deployment URL, no trailing slash
 *                        (e.g. https://quotation-automation-phi.vercel.app)
 *        INGEST_SECRET = the same secret the Gmail ingest script uses
 *   2. Reload the spreadsheet — an "Enquiry register" menu appears.
 *   3. Menu → "Set up daily refresh" once (installs a 7am trigger).
 *
 * What it does on each refresh:
 *   - Pulls every quote from the app (last ~62 days) with live status:
 *       REGRET (regretted on the margins desk) / SENT (quote emailed) / PENDING
 *   - Also scans the Gmail label "Enquiry Client": emails that never became a
 *     quote appear as PENDING rows with no quote number (nothing slips through).
 *   - Rewrites one tab per month (e.g. "JUL 26"), oldest date first, with the
 *     per-day enquiry total computed automatically.
 *
 * The sheet is a MIRROR — the app is the source of truth. Manual edits to
 * these tabs are overwritten on the next refresh.
 */

var ENQUIRY_LABEL = 'Enquiry Client';
var REGISTER_DAYS = 62;   // how far back to mirror
var HEADER = ['Quotation Number', 'Enquiry Date', 'Total Enquiry per day', 'STATUS (REGRET/SENT/PENDING)', 'Company Name', 'Contact Name', 'Prepared By'];
var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Enquiry register')
    .addItem('Refresh now', 'refreshEnquiryRegister')
    .addItem('Set up daily refresh (7am)', 'installDailyRefresh')
    .addToUi();
}

function installDailyRefresh() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'refreshEnquiryRegister';
  });
  if (!exists) {
    ScriptApp.newTrigger('refreshEnquiryRegister').timeBased().everyDays(1).atHour(7).create();
  }
  SpreadsheetApp.getUi().alert('Daily refresh is set for ~7am. You can still use "Refresh now" anytime.');
}

/** Fetch the register rows from the app. */
function fetchAppRegister_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('APP_URL');
  if (!url) throw new Error('Set APP_URL in Script Properties (e.g. https://your-app.vercel.app)');
  var options = { muteHttpExceptions: true, headers: {} };
  var secret = props.getProperty('INGEST_SECRET');
  if (secret) options.headers['X-Ingest-Secret'] = secret;
  var resp = UrlFetchApp.fetch(url + '/api/enquiry-register?days=' + REGISTER_DAYS, options);
  if (resp.getResponseCode() !== 200) {
    throw new Error('App register fetch failed: HTTP ' + resp.getResponseCode() + ' — ' + resp.getContentText().slice(0, 200));
  }
  return JSON.parse(resp.getContentText()).rows || [];
}

/** Gmail "Enquiry Client" emails in the window that never became app quotes → PENDING rows. */
function fetchUnquotedEnquiries_(knownGmailIds) {
  var rows = [];
  var query = 'label:"' + ENQUIRY_LABEL + '" newer_than:' + REGISTER_DAYS + 'd';
  var threads;
  try { threads = GmailApp.search(query, 0, 200); }
  catch (e) { return rows; }   // label may not exist — skip silently
  threads.forEach(function (thread) {
    var msg = thread.getMessages()[0];
    if (!msg) return;
    if (knownGmailIds[msg.getId()]) return;   // already a quote in the app
    var from = msg.getFrom();                  // "Name <a@b.com>" or bare address
    var nameMatch = from.match(/^"?([^"<]+?)"?\s*</);
    rows.push({
      quoteNumber: '',
      enquiryDate: msg.getDate().toISOString(),
      status: 'PENDING',
      company: '',
      contact: nameMatch ? nameMatch[1].trim() : from,
      preparedBy: '',
      gmailMessageId: msg.getId(),
    });
  });
  return rows;
}

/** "14.7.26" — the sheet's date style. */
function formatSheetDate_(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getDate() + '.' + (d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(-2);
}

function monthTabName_(iso) {
  var d = new Date(iso);
  return MONTHS[d.getMonth()] + ' ' + String(d.getFullYear()).slice(-2);   // e.g. "JUL 26"
}

/** Find an existing tab for this month (tolerates JULY26 / JUNE-26 / APRIL 26 styles) or create one. */
function sheetForMonth_(ss, iso) {
  var d = new Date(iso);
  var canonical = monthTabName_(iso);
  var monthLong = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'][d.getMonth()];
  var yy = String(d.getFullYear()).slice(-2);
  var found = ss.getSheets().filter(function (sh) {
    var n = sh.getName().toUpperCase().replace(/[\s\-_]/g, '');
    return (n.indexOf(MONTHS[d.getMonth()]) === 0 || n.indexOf(monthLong) === 0) && n.indexOf(yy) !== -1;
  })[0];
  return found || ss.insertSheet(canonical, 0);
}

function refreshEnquiryRegister() {
  var appRows = fetchAppRegister_();
  var knownGmailIds = {};
  appRows.forEach(function (r) { if (r.gmailMessageId) knownGmailIds[r.gmailMessageId] = true; });
  var allRows = appRows.concat(fetchUnquotedEnquiries_(knownGmailIds));

  // Bucket by month tab, sort oldest-first within the month (like the manual sheet)
  var byMonth = {};
  allRows.forEach(function (r) {
    if (!r.enquiryDate) return;
    var key = monthTabName_(r.enquiryDate);
    (byMonth[key] = byMonth[key] || []).push(r);
  });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(byMonth).forEach(function (monthKey) {
    var rows = byMonth[monthKey].sort(function (a, b) { return a.enquiryDate < b.enquiryDate ? -1 : 1; });

    // Per-day totals
    var perDay = {};
    rows.forEach(function (r) { var day = formatSheetDate_(r.enquiryDate); perDay[day] = (perDay[day] || 0) + 1; });

    var values = [HEADER];
    rows.forEach(function (r) {
      var day = formatSheetDate_(r.enquiryDate);
      values.push([r.quoteNumber, day, perDay[day], r.status, r.company, r.contact, r.preparedBy]);
    });

    var sheet = sheetForMonth_(ss, rows[0].enquiryDate);
    sheet.clearContents();
    sheet.getRange(1, 1, values.length, HEADER.length).setValues(values);
    sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });

  Logger.log('Enquiry register refreshed: ' + allRows.length + ' rows across ' + Object.keys(byMonth).length + ' month tab(s).');
}
