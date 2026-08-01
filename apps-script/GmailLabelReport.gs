/**
 * Gmail Label Report – PRODUCTION (Report sheet)
 * ===============================================
 * Writes label counts and Gmail links to the "Report" sheet.
 * Sends labeled emails to the Quotation app at the end of each run.
 * Only emails in the current run's time window are sent; first message per thread.
 *
 * Copy this file into your Apps Script project alongside SendLabeledEmailsToApp.gs.
 * Run runReportNow() from the script editor or assign to your report button.
 */

/***** CONFIG *****/
const SHEET_NAME = 'Report';
const START_ROW_OFFSET = 5;
const HEADER_ROWS = 3;
const MAX_DATA_ROWS = 30;
const VISIBLE_DATA_ROWS = 5;
const INCLUDE_NO_LABEL = true;
const PROP_LAST_END = 'LAST_RUN_END_MS';
const FLAG_LABEL = 'Enquiry - Needs Reply';
const ENQUIRY_LABEL = 'Enquiry';
const QUOTATION_LABEL = 'Quotation';
const OVERDUE_DAYS = 2;
/** Lookback window (days) for the "Create Quotations" catch-up button. It scans emails that
 *  currently carry the Create Quotation label within this many days, regardless of when the
 *  label was applied. Bump it if you sometimes label enquiries older than this. */
const CREATE_QUOTATIONS_LOOKBACK_DAYS = 7;

function isCommonLabel_(label) {
  if (typeof label !== 'string') return false;
  return label.trim().toLowerCase().indexOf('common') === 0;
}

function buildLabelsWithCommonFirst_() {
  const all = [
    "Auditor", "Bank Statement/ Related", "Bigin", "COMMON VIMAL", "Common Email",
    "Common Email/Deekshit", "Common Email/Jayanthi", "Common Email/Pavithra",
    "Common Email/Ramesh", "Common Email/Ramya", "Common Martin", "Credit Note",
    "Debit Note", "Enquiry Client", "Enquiry Market", "Quotation Automation/Create Quotation",
    "Expense", "Expense Bill", "FORMAT", "Freight Bill", "GRN", "Income Tax/ GST/ MCA",
    "MC JAIN", "OC(ORDER CONFIRMATION)/S.O(ORDER CONFIRMATION)/F.G/STOCK POSITION",
    "Other", "PAYMENT ADVICE", "PO Sent to Manufacturer Vendor", "POARTAL/DALMIA",
    "PURCHASE BILL", "Payment Reminders", "Portal", "Portal/Direct from Company",
    "Portal/E-Auction", "Portal/Gem", "Portal/LnT", "Portal/Portal - Dalmia",
    "Portal/Tender 24/7", "Prepaid Card", "Price List", "Purchase Order Client",
    "Purchase Order Market", "Quotation", "Returned Email", "TC", "mca",
    "new manufactures", "purchase enq"
  ];
  const common = all.filter(isCommonLabel_);
  const rest = all.filter(function (l) { return !isCommonLabel_(l); });
  return common.concat(rest);
}

const LABELS = buildLabelsWithCommonFirst_();

/***** TIME / DATE HELPERS *****/
function getStartMsFromProps_(props, now, propKey) {
  let startMs = Number(props.getProperty(propKey));
  if (!startMs || isNaN(startMs)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    startMs = d.getTime();
  }
  return startMs;
}

/**
 * Derive startMs from the last row currently in the sheet (its end time).
 * When a row is deleted, the next run starts from the end of the last remaining row.
 * Falls back to props or today 00:00 if no data rows exist.
 */
function getStartMsFromLastSheetRow_(sh, props, now, propKey) {
  const firstDataRow = START_ROW_OFFSET + 1 + HEADER_ROWS;
  const lastRow = sh.getLastRow();
  if (lastRow < firstDataRow) return getStartMsFromProps_(props, now, propKey);

  const values = sh.getRange(lastRow, 1, 1, 2).getValues();
  let dateTxt = values[0][0];
  if (dateTxt instanceof Date) {
    dateTxt = Utilities.formatDate(dateTxt, Session.getScriptTimeZone(), 'dd MMM yyyy');
  } else {
    dateTxt = String(dateTxt || '').trim();
  }
  const timeWindowTxt = String(values[0][1] || '').trim();
  const parsed = parseEndMsFromRow_(dateTxt, timeWindowTxt);
  if (!dateTxt || !timeWindowTxt) return getStartMsFromProps_(props, now, propKey);
  if (parsed !== null) return parsed;
  return getStartMsFromProps_(props, now, propKey);
}

/** Parse end time from "dd MMM yyyy" + "HH:mm → HH:mm" into milliseconds */
function parseEndMsFromRow_(dateTxt, timeWindowTxt) {
  const dateParts = dateTxt.split(/\s+/);
  if (dateParts.length !== 3) return null;
  const day = parseInt(dateParts[0], 10);
  const monthStr = dateParts[1];
  const year = parseInt(dateParts[2], 10);
  const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = monthMap[monthStr];
  if (month === undefined || isNaN(day) || isNaN(year)) return null;

  const arrowIdx = timeWindowTxt.indexOf('\u2192');  // Unicode arrow →
  const arrowIdxAlt = timeWindowTxt.indexOf('->');   // ASCII fallback
  const sep = arrowIdx >= 0 ? arrowIdx : arrowIdxAlt;
  const endTimeStr = (sep >= 0 ? timeWindowTxt.substring(sep + (arrowIdx >= 0 ? 1 : 2)) : timeWindowTxt).trim();
  const timeParts = endTimeStr.split(':');
  if (timeParts.length < 2) return null;
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1], 10);
  if (isNaN(hour) || isNaN(minute)) return null;

  const d = new Date(year, month, day, hour, minute, 0, 0);
  return d.getTime();
}

function getSearchDateStrings_(tz, startMs, nowMs) {
  const startDateStr = Utilities.formatDate(new Date(startMs), tz, 'yyyy/MM/dd');
  const endPlusOne = new Date(nowMs);
  endPlusOne.setDate(endPlusOne.getDate() + 1);
  const endDatePlusOneStr = Utilities.formatDate(endPlusOne, tz, 'yyyy/MM/dd');
  return { startDateStr: startDateStr, endDatePlusOneStr: endDatePlusOneStr };
}

function getMaxLabelMessageTimestamp_(labels, startDateStr, endDatePlusOneStr, startMs, nowMs) {
  let maxTs = 0;
  for (let i = 0; i < labels.length; i++) {
    const lbl = labels[i];
    try {
      const threads = GmailApp.search('label:"' + lbl + '" after:' + startDateStr + ' before:' + endDatePlusOneStr + ' -in:spam -in:trash');
      for (let t = 0; t < threads.length; t++) {
        const msgs = threads[t].getMessages();
        for (let m = 0; m < msgs.length; m++) {
          const ts = msgs[m].getDate().getTime();
          if (ts >= startMs && ts <= nowMs && ts > maxTs) maxTs = ts;
        }
      }
    } catch (e) {
      continue;
    }
  }
  return maxTs;
}

function getEndMs_(maxLabelMsgTs, nowMs) {
  return nowMs;
}

function getDisplayDateAndTimeWindow_(now, startMs, endMs, tz) {
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const startDateStr = Utilities.formatDate(startDate, tz, 'dd MMM yyyy');
  const endDateStr = Utilities.formatDate(endDate, tz, 'dd MMM yyyy');
  const dateTxt = (startDateStr === endDateStr)
    ? startDateStr
    : startDateStr + ' – ' + endDateStr;
  const startTimeTxt = Utilities.formatDate(startDate, tz, 'HH:mm');
  const endTimeTxt = Utilities.formatDate(endDate, tz, 'HH:mm');
  const timeWindowTxt = startTimeTxt + ' → ' + endTimeTxt;
  const windowKey = dateTxt + ' ' + timeWindowTxt;
  return { dateTxt: dateTxt, timeWindowTxt: timeWindowTxt, windowKey: windowKey };
}

/***** GMAIL QUERY HELPERS *****/
function quoteLabelForSearch_(label) {
  return (label.indexOf(' ') !== -1 || label.indexOf('/') !== -1)
    ? 'label:"' + label + '"'
    : 'label:' + label;
}

function buildGmailSearchQuery_(quotedLabelOrExcludes, startSec, endSec) {
  const base = (typeof quotedLabelOrExcludes === 'string')
    ? quotedLabelOrExcludes
    : quotedLabelOrExcludes.join(' ');
  return base + ' after:' + startSec + ' before:' + endSec + ' -in:spam -in:trash';
}

function buildGmailSearchUrl_(query) {
  return 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(query);
}

function buildHyperlinkFormula_(url) {
  return '=HYPERLINK("' + url + '","Open in Gmail")';
}

/***** LABEL / COUNT HELPERS *****/
function searchLabelWithinWindow_(label, startDateStr, endDatePlusOneStr, startMs, endMs) {
  try {
    const threads = GmailApp.search('label:"' + label + '" after:' + startDateStr + ' before:' + endDatePlusOneStr + ' -in:spam -in:trash');
    const kept = [];
    for (let i = 0; i < threads.length; i++) {
      if (threadHasMessageInWindow_(threads[i], startMs, endMs)) kept.push(threads[i]);
    }
    return { count: kept.length, threadIds: kept.map(function (t) { return t.getId(); }) };
  } catch (e) {
    return { count: 0, threadIds: [] };
  }
}

function threadHasMessageInWindow_(thread, startMs, endMs) {
  const msgs = thread.getMessages();
  for (let i = 0; i < msgs.length; i++) {
    const ts = msgs[i].getDate().getTime();
    if (ts >= startMs && ts <= endMs) return true;
  }
  return false;
}

function buildLabelPairs_(labels, startDateStr, endDatePlusOneStr, startMs, endMs, startSec, endSec) {
  const pairs = [];
  for (let i = 0; i < labels.length; i++) {
    const lbl = labels[i];
    const res = searchLabelWithinWindow_(lbl, startDateStr, endDatePlusOneStr, startMs, endMs);
    const count = res.count || 0;
    const quotedLabel = quoteLabelForSearch_(lbl);
    const query = buildGmailSearchQuery_(quotedLabel, startSec, endSec);
    const url = buildGmailSearchUrl_(query);
    const formula = buildHyperlinkFormula_(url);
    pairs.push({ count: count, formula: formula });
  }
  return pairs;
}

function buildNoLabelPair_(trackedLabels, startDateStr, endDatePlusOneStr, startMs, endMs, startSec, endSec) {
  const allThreads = GmailApp.search('after:' + startDateStr + ' before:' + endDatePlusOneStr + ' -in:spam -in:trash');
  const unlabeled = [];
  for (let t = 0; t < allThreads.length; t++) {
    const thread = allThreads[t];
    if (!threadHasMessageInWindow_(thread, startMs, endMs)) continue;
    const tLabels = thread.getLabels().map(function (l) { return l.getName(); });
    let hasTracked = false;
    for (let k = 0; k < trackedLabels.length; k++) {
      if (tLabels.indexOf(trackedLabels[k]) !== -1) { hasTracked = true; break; }
    }
    if (!hasTracked) unlabeled.push(thread);
  }
  const count = unlabeled.length;
  const excludeParts = trackedLabels.map(function (lbl) {
    return (lbl.indexOf(' ') !== -1 || lbl.indexOf('/') !== -1) ? '-label:"' + lbl + '"' : '-label:' + lbl;
  });
  const noLabelQuery = buildGmailSearchQuery_(excludeParts, startSec, endSec);
  const noLabelUrl = buildGmailSearchUrl_(noLabelQuery);
  const noLabelFormula = buildHyperlinkFormula_(noLabelUrl);
  return { count: count, formula: noLabelFormula };
}

function buildFlagPair_(flagLabel, startMs, endMs, startSec, endSec) {
  const flagThreads = GmailApp.search('label:"' + flagLabel + '" -in:spam -in:trash newer_than:365d');
  const keptFlag = [];
  for (let t = 0; t < flagThreads.length; t++) {
    if (threadHasMessageInWindow_(flagThreads[t], startMs, endMs)) keptFlag.push(flagThreads[t]);
  }
  const flagCount = keptFlag.length;
  const flagQuery = buildGmailSearchQuery_('label:"' + flagLabel + '"', startSec, endSec);
  const flagUrl = buildGmailSearchUrl_(flagQuery);
  const flagFormula = buildHyperlinkFormula_(flagUrl);
  return { count: flagCount, formula: flagFormula };
}

function collectOutputPairs_(includeNoLabel, labelPairs, noLabelPair, flagPair) {
  const outputPairs = [];
  if (includeNoLabel) outputPairs.push(noLabelPair);
  for (let i = 0; i < labelPairs.length; i++) outputPairs.push(labelPairs[i]);
  outputPairs.push(flagPair);
  return outputPairs;
}

/***** SHEET HELPERS *****/
function getOrCreateSheet_(ss, sheetName) {
  return ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
}

const COLOR_WHITE = '#FFFFFF';
const COLOR_LIGHT_BLUE = '#DEEBF7';
const COLOR_HEADER_GREY = '#F3F3F3';
const BORDER_COLOR = '#999999';

function ensureHeader_Date_Time_Window_(sh, labels, flagLabel) {
  const labelsWithNoLabel = INCLUDE_NO_LABEL ? ['No Label Added'].concat(labels) : labels.slice();

  const totalPairs = labelsWithNoLabel.length + 1;
  const totalCols = 2 + totalPairs * 2;
  const headerRow0 = START_ROW_OFFSET + 1;
  const headerRow1 = START_ROW_OFFSET + 2;
  const headerRow2 = START_ROW_OFFSET + 3;

  if (sh.getMaxRows() < headerRow2) sh.insertRowsAfter(sh.getMaxRows(), headerRow2 - sh.getMaxRows());
  if (sh.getMaxColumns() < totalCols) sh.insertColumnsAfter(sh.getMaxColumns(), totalCols - sh.getMaxColumns());

  sh.setFrozenRows(0);

  try {
    const rngAll = sh.getRange(headerRow0, 1, HEADER_ROWS, totalCols);
    const merges = rngAll.getMergedRanges();
    merges.forEach(function (m) { m.breakApart(); });
    rngAll.clear({ contentsOnly: true });
  } catch (e) {}

  const row0 = new Array(totalCols).fill('');
  const row1 = new Array(totalCols).fill('');
  row1[0] = 'Date';
  row1[1] = 'Time window';
  const row2 = new Array(totalCols).fill('');
  row2[0] = 'Date';
  row2[1] = 'Time window';

  for (let i = 0; i < labelsWithNoLabel.length; i++) {
    const c = 3 + i * 2;
    row2[c - 1] = 'Count';
    row2[c] = 'Open';
  }
  const finalC = 3 + labelsWithNoLabel.length * 2;
  row2[finalC - 1] = 'Count';
  row2[finalC] = 'Open';

  sh.getRange(headerRow0, 1, 1, totalCols).setValues([row0]);
  sh.getRange(headerRow1, 1, 1, totalCols).setValues([row1]);
  sh.getRange(headerRow2, 1, 1, totalCols).setValues([row2]);
  sh.getRange(headerRow0, 1, HEADER_ROWS, totalCols).setFontWeight('bold').setHorizontalAlignment('center');

  sh.getRange(headerRow0, 1, HEADER_ROWS, 1).merge().setValue('Date').setHorizontalAlignment('center').setFontWeight('bold');
  sh.getRange(headerRow0, 2, HEADER_ROWS, 1).merge().setValue('Time window').setHorizontalAlignment('center').setFontWeight('bold');

  for (let i = 0; i < labelsWithNoLabel.length; i++) {
    const startCol = 3 + i * 2;
    const rng = sh.getRange(headerRow1, startCol, 1, 2);
    rng.merge();
    rng.setValue(labelsWithNoLabel[i]).setHorizontalAlignment('center').setFontWeight('bold');
  }
  const rngf = sh.getRange(headerRow1, 3 + labelsWithNoLabel.length * 2, 1, 2);
  rngf.merge();
  rngf.setValue(flagLabel).setHorizontalAlignment('center').setFontWeight('bold');

  const headerRng = sh.getRange(headerRow0, 1, HEADER_ROWS, totalCols);
  headerRng.setBackground(COLOR_HEADER_GREY);
  var headerBgColors = [];
  for (var hr = 0; hr < HEADER_ROWS; hr++) {
    var headerRow = [];
    for (var hc = 0; hc < totalCols; hc++) {
      if (hc < 2) {
        headerRow.push(COLOR_HEADER_GREY);
      } else {
        var blockIdx = Math.floor(hc / 2);
        headerRow.push((blockIdx % 2 === 0) ? COLOR_WHITE : COLOR_LIGHT_BLUE);
      }
    }
    headerBgColors.push(headerRow);
  }
  headerRng.setBackgrounds(headerBgColors);
  var fullHeaderRng = sh.getRange(headerRow0, 1, HEADER_ROWS, totalCols);
  fullHeaderRng.setBorder(true, true, true, true, true, true, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  SpreadsheetApp.flush();
  sh.setFrozenRows(headerRow2);
  sh.setColumnWidth(1, 140);
  sh.setColumnWidth(2, 150);
  for (let i = 0; i < totalPairs; i++) {
    const countCol = 3 + i * 2;
    const openCol = countCol + 1;
    sh.setColumnWidth(countCol, 80);
    sh.setColumnWidth(openCol, 360);
  }
}

function getOrCreateRowByKey_(sh, key) {
  const firstDataRow = START_ROW_OFFSET + 1 + HEADER_ROWS;
  const lastRow = sh.getLastRow();
  if (lastRow < firstDataRow) return firstDataRow;
  const numRows = Math.max(1, lastRow - firstDataRow + 1);
  const values = sh.getRange(firstDataRow, 1, numRows, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === key) return firstDataRow + i;
  }
  return lastRow + 1;
}

function buildReportRow_(dateTxt, timeWindowTxt, outputPairs) {
  const totalCols = 2 + outputPairs.length * 2;
  const row = [];
  row[0] = dateTxt;
  row[1] = timeWindowTxt;
  for (let p = 0; p < outputPairs.length; p++) {
    const baseCol = 3 + p * 2;
    row[baseCol - 1] = outputPairs[p].count;
    row[baseCol] = outputPairs[p].formula;
  }
  for (let c = 0; c < totalCols; c++) if (typeof row[c] === 'undefined') row[c] = '';
  return { row: row, totalCols: totalCols };
}

function writeRowToSheet_(sh, rowIndex, row, totalCols) {
  sh.getRange(rowIndex, 1, 1, totalCols).setValues([row]);
}

function applyFormattingAfterWrite_(sh, totalCols) {
  const firstDataRow = START_ROW_OFFSET + 1 + HEADER_ROWS;
  const lastRow = sh.getLastRow();
  const numRows = Math.max(1, lastRow - firstDataRow + 1);
  for (let col = 3; col <= totalCols; col += 2) {
    try { sh.getRange(firstDataRow, col, numRows, 1).setNumberFormat('0'); } catch (e) {}
    try {
      const openRange = sh.getRange(firstDataRow, col + 1, numRows, 1);
      if (typeof SpreadsheetApp.WrapStrategy !== 'undefined') openRange.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
      else openRange.setWrap(false);
    } catch (e) {}
  }
  applyAlternatingColorsAndBorders_(sh, firstDataRow, numRows, totalCols);
}

function applyAlternatingColorsAndBorders_(sh, firstDataRow, numDataRows, totalCols) {
  if (numDataRows < 1) return;
  var bgColors = [];
  for (var r = 0; r < numDataRows; r++) {
    var row = [];
    for (var c = 0; c < totalCols; c++) {
      var blockIdx = Math.floor(c / 2);
      row.push((blockIdx % 2 === 0) ? COLOR_WHITE : COLOR_LIGHT_BLUE);
    }
    bgColors.push(row);
  }
  var rng = sh.getRange(firstDataRow, 1, numDataRows, totalCols);
  rng.setBackgrounds(bgColors);
  rng.setBorder(true, true, true, true, true, true, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
  SpreadsheetApp.flush();
}

function applyTableBorders_(sh, totalCols) {
  var headerRow0 = START_ROW_OFFSET + 1;
  var lastRow = sh.getLastRow();
  var firstDataRow = START_ROW_OFFSET + 1 + HEADER_ROWS;
  if (lastRow < firstDataRow) return;
  var numRows = lastRow - headerRow0 + 1;
  var fullRng = sh.getRange(headerRow0, 1, numRows, totalCols);
  fullRng.setBorder(true, true, true, true, true, true, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
}

function trimToMaxDataRows_(sh) {
  const firstDataRow = START_ROW_OFFSET + 1 + HEADER_ROWS;
  const lastRow = sh.getLastRow();
  if (lastRow < firstDataRow) return;
  const numDataRows = lastRow - firstDataRow + 1;
  if (numDataRows <= MAX_DATA_ROWS) return;
  const toDelete = numDataRows - MAX_DATA_ROWS;
  sh.deleteRows(firstDataRow, toDelete);
}

function applyRowVisibility_(sh) {
  const firstDataRow = START_ROW_OFFSET + 1 + HEADER_ROWS;
  const lastRow = sh.getLastRow();
  if (lastRow < firstDataRow) return;
  const numDataRows = lastRow - firstDataRow + 1;
  if (numDataRows <= VISIBLE_DATA_ROWS) return;
  sh.showRows(firstDataRow, numDataRows);
  const toHide = numDataRows - VISIBLE_DATA_ROWS;
  sh.hideRows(firstDataRow, toHide);
}

/***** MAIN REPORT FUNCTION *****/
function dailyLabelReport() {
  const tz = Session.getScriptTimeZone();
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const nowMs = now.getTime();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEET_NAME);
  const startMs = getStartMsFromLastSheetRow_(sh, props, now, PROP_LAST_END);

  const dateStrings = getSearchDateStrings_(tz, startMs, nowMs);
  const maxLabelMsgTs = getMaxLabelMessageTimestamp_(LABELS, dateStrings.startDateStr, dateStrings.endDatePlusOneStr, startMs, nowMs);
  const endMs = getEndMs_(maxLabelMsgTs, nowMs);
  const display = getDisplayDateAndTimeWindow_(now, startMs, endMs, tz);

  ensureHeader_Date_Time_Window_(sh, LABELS, FLAG_LABEL);

  const rowIndex = getOrCreateRowByKey_(sh, display.windowKey);

  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  const trackedLabels = LABELS.slice();

  const labelPairs = buildLabelPairs_(LABELS, dateStrings.startDateStr, dateStrings.endDatePlusOneStr, startMs, endMs, startSec, endSec);

  let noLabelPair = null;
  if (INCLUDE_NO_LABEL) {
    noLabelPair = buildNoLabelPair_(trackedLabels, dateStrings.startDateStr, dateStrings.endDatePlusOneStr, startMs, endMs, startSec, endSec);
  }

  const flagPair = buildFlagPair_(FLAG_LABEL, startMs, endMs, startSec, endSec);
  const outputPairs = collectOutputPairs_(INCLUDE_NO_LABEL, labelPairs, noLabelPair, flagPair);

  const built = buildReportRow_(display.dateTxt, display.timeWindowTxt, outputPairs);
  writeRowToSheet_(sh, rowIndex, built.row, built.totalCols);
  applyFormattingAfterWrite_(sh, built.totalCols);
  trimToMaxDataRows_(sh);
  applyRowVisibility_(sh);
  applyTableBorders_(sh, built.totalCols);

  SpreadsheetApp.flush();
  props.setProperty(PROP_LAST_END, String(endMs));

  // Same run also emails each enquirer a short acknowledgement — but ONLY when their email
  // becomes a brand-new quote. The acknowledger fires per newly-created quote, so repeats
  // are never emailed twice.
  const created = sendLabeledEmailsToAppForLabel(
    'Quotation Automation/Create Quotation',
    startMs,
    endMs,
    dateStrings.startDateStr,
    dateStrings.endDatePlusOneStr,
    buildEnquiryAcknowledger_()
  );

  // Label the enquiries WE sent out, so they are findable in Gmail. Done here rather than from the
  // app because GmailApp already has full Gmail access — the app's OAuth token would need the
  // gmail.modify scope and a re-consent. The trade-off is timing: labels appear when this report
  // runs, not the instant an enquiry is sent.
  labelSentEnquiries_(dateStrings.startDateStr, dateStrings.endDatePlusOneStr);

  return created;
}

/***** LABEL THE ENQUIRIES WE SENT *****/
const SENT_ENQUIRY_LABELS = [
  {
    // Freight enquiries to transporters — subject: "Freight enquiry — DSC-123 (to Hyderabad)".
    label: 'Quotation Automation/Freight Enquiry',
    query: 'from:me subject:"Freight enquiry"'
  },
  {
    // Supplier/dealer enquiries from the quote card's Enquiry tab — subject: "Enquiry — DSC-123".
    //
    // The quote number is REQUIRED in the match. Searching for the bare word "Enquiry" also hit
    // the customer's own enquiry thread (we reply into it, so it is "from:me"), stamping an
    // incoming customer enquiry with the label that means "an enquiry we sent to a supplier" —
    // and it caught the regret replies too. The app labels these at send time anyway; this sweep
    // is only a backstop for anything sent before that, so it errs towards missing one rather
    // than mislabelling a customer thread.
    label: 'Quotation Automation/Enquiry Sent by us',
    query: 'from:me subject:"Enquiry" subject:"DSC-" -subject:"Freight enquiry"'
  }
  // Regret replies are NOT listed here. They go out as "Re: <the customer's own subject>" with
  // wording that is editable in Settings, so there is nothing dependable to search on. The app
  // labels those itself the moment you click Regret (GMAIL_SENT_LABELS in utils/constants.js).
];

/**
 * Apply the sent-enquiry labels to threads we sent in this report's window.
 * Idempotent: a thread that already carries the label is skipped, so repeat runs are cheap.
 * Fails soft — a labelling problem must never abort the report or the ingest that ran before it.
 * @param {string} startDateStr - yyyy/MM/dd, inclusive
 * @param {string} endDatePlusOneStr - yyyy/MM/dd, exclusive
 */
function labelSentEnquiries_(startDateStr, endDatePlusOneStr) {
  SENT_ENQUIRY_LABELS.forEach(function (spec) {
    try {
      const labelObj = GmailApp.getUserLabelByName(spec.label) || GmailApp.createLabel(spec.label);
      const window = (startDateStr && endDatePlusOneStr)
        ? ' after:' + startDateStr + ' before:' + endDatePlusOneStr
        : '';
      const threads = GmailApp.search(spec.query + window, 0, 200);
      let applied = 0;
      threads.forEach(function (thread) {
        const already = thread.getLabels().some(function (l) { return l.getName() === spec.label; });
        if (already) return;
        thread.addLabel(labelObj);
        applied++;
      });
      Logger.log('Labelled ' + applied + ' thread(s) as "' + spec.label + '" (' + threads.length + ' matched)');
    } catch (e) {
      Logger.log('Could not apply "' + spec.label + '": ' + e.toString());
    }
  });
}

/***** BUTTON FUNCTIONS *****/
function runReportNow() {
  SpreadsheetApp.getActive().toast('Running Gmail report…');
  let created;
  try {
    created = dailyLabelReport();
  } catch (e) {
    showReportCompleteAlert('Error: ' + (e.message || String(e)), true);
    throw e;
  }
  const msg = typeof created === 'number' ? 'Created ' + created + ' quotation(s) in the app.' : 'Report complete.';
  showReportCompleteAlert(msg, false);
  SpreadsheetApp.getActive().toast(msg, 'Report complete', 8);
}

/**
 * Create quotations from emails that currently carry the
 * "Quotation Automation/Create Quotation" label, regardless of when they arrived
 * or when the label was applied. Use this when you add the label to an email AFTER
 * a report has already run: the report's time window filters by the email's received
 * date, so a back-labelled older email would otherwise be skipped. Scans the last
 * CREATE_QUOTATIONS_LOOKBACK_DAYS days; the app de-duplicates by Gmail message id, so
 * quotes already created are skipped cheaply (no duplicates, no AI cost).
 */
function createQuotationsFromLatest() {
  // Also acknowledges any enquiry that becomes a brand-new quote here (e.g. late-labelled
  // emails the report's time window missed), through the same per-new-quote path.
  return sendLabeledEmailsToAppRecent(
    'Quotation Automation/Create Quotation',
    CREATE_QUOTATIONS_LOOKBACK_DAYS,
    buildEnquiryAcknowledger_()
  );
}

/**
 * Button handler for "Create Quotations". Use when emails arrive after the
 * report was generated. Processes labeled emails from last report end to now.
 */
function runCreateQuotationsNow() {
  SpreadsheetApp.getActive().toast('Creating quotations from latest labeled emails…');
  let created;
  try {
    created = createQuotationsFromLatest();
  } catch (e) {
    showReportCompleteAlert('Error: ' + (e.message || String(e)), true);
    throw e;
  }
  const msg = typeof created === 'number' ? 'Created ' + created + ' quotation(s).' : 'No new emails to process.';
  SpreadsheetApp.getActive().toast(msg, 'Create Quotations', 8);
  try {
    const ui = SpreadsheetApp.getUi();
    if (ui) ui.alert('Create Quotations', msg, ui.ButtonSet.OK);
  } catch (e) {}
}

const CREATE_QUOT_BTN_COL = 3;
const CREATE_QUOT_BTN_ROW = 1;
const CREATE_QUOT_BTN_COLS = 2;
const CREATE_QUOT_BTN_ROWS = 3;
const BUTTON_BG_COLOR = '#4285F4';

/**
 * Add custom menu and Create Quotations button (next to Run Report) on spreadsheet open.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Gmail Report')
    .addItem('Run Report', 'runReportNow')
    .addItem('Create Quotations', 'runCreateQuotationsNow')
    .addToUi();
  ensureCreateQuotationsButton_();
}

/**
 * Add a "Create Quotations" button next to Run Report (C1:D3). Same style as Run Report.
 * To make it clickable: Insert > Drawing, draw a rectangle, place over C1:D3,
 * right-click the drawing > Assign script > runCreateQuotationsNow.
 * Or use the Gmail Report menu > Create Quotations.
 */
function ensureCreateQuotationsButton_() {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sh) return;
    const rng = sh.getRange(CREATE_QUOT_BTN_ROW, CREATE_QUOT_BTN_COL, CREATE_QUOT_BTN_ROW + CREATE_QUOT_BTN_ROWS - 1, CREATE_QUOT_BTN_COL + CREATE_QUOT_BTN_COLS - 1);
    rng.merge().setValue('Create Quotations')
      .setBackground(BUTTON_BG_COLOR)
      .setFontColor('#FFFFFF')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
  } catch (e) {}
}

function showReportCompleteAlert(message, isError) {
  try {
    const ui = SpreadsheetApp.getUi();
    if (ui) {
      ui.alert(isError ? 'Report Error' : 'Report complete', message, ui.ButtonSet.OK);
    }
  } catch (e) {
    // getUi() may be unavailable when run from script editor; toast still shows
  }
}

/***** ENQUIRY FOLLOW-UP HELPERS *****/
function getMyEmailAddresses_() {
  return new Set([Session.getActiveUser().getEmail(), ...GmailApp.getAliases()].map(function (a) { return a.toLowerCase(); }));
}

function getLastInboundMessageTime_(thread, myAddresses) {
  const msgs = thread.getMessages();
  if (msgs.length === 0) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const from = msgs[i].getFrom().toLowerCase();
    if (![...myAddresses].some(function (m) { return from.indexOf(m) !== -1; })) {
      return msgs[i].getDate().getTime();
    }
  }
  return null;
}

function threadHasQuotationLabel_(thread) {
  return thread.getLabels().some(function (l) { return l.getName() === QUOTATION_LABEL; });
}

function removeFlagIfPresent_(thread, flagLabelObj) {
  if (thread.getLabels().some(function (l) { return l.getName() === FLAG_LABEL; })) {
    thread.removeLabel(flagLabelObj);
  }
}

function processEnquiryThread_(thread, flagLabelObj, myAddresses, nowMs, overdueMs) {
  const lastInboundMs = getLastInboundMessageTime_(thread, myAddresses);
  if (!lastInboundMs) {
    removeFlagIfPresent_(thread, flagLabelObj);
    return;
  }
  if (threadHasQuotationLabel_(thread)) {
    removeFlagIfPresent_(thread, flagLabelObj);
    return;
  }
  if ((nowMs - lastInboundMs) >= overdueMs) {
    thread.addLabel(flagLabelObj);
  } else {
    removeFlagIfPresent_(thread, flagLabelObj);
  }
}

/***** ENQUIRY FOLLOW-UP CHECKER *****/
function checkEnquiryFollowUps() {
  const flagLabelObj = GmailApp.getUserLabelByName(FLAG_LABEL) || GmailApp.createLabel(FLAG_LABEL);
  const myAddresses = getMyEmailAddresses_();
  const nowMs = Date.now();
  const overdueMs = OVERDUE_DAYS * 24 * 60 * 60 * 1000;
  const threads = GmailApp.search('label:"' + ENQUIRY_LABEL + '" -in:spam -in:trash newer_than:60d');

  threads.forEach(function (thread) {
    processEnquiryThread_(thread, flagLabelObj, myAddresses, nowMs, overdueMs);
  });
}

/***** ENQUIRY AUTO-ACKNOWLEDGEMENT *****/
/**
 * As each labelled enquiry is turned into a BRAND-NEW quote (during the report run, and
 * via the "Create Quotations" button), email that enquirer a short acknowledgement in-thread.
 *
 * No dedup tag is needed: the app already reserves each email's Gmail message id before
 * creating a quote, and tells us per email whether it made a new quote or skipped a repeat
 * (see gmail-ingest). We acknowledge ONLY the new ones, so nobody is ever emailed twice.
 *
 * The reply goes through the app's existing /api/send-email route (NOT GmailApp) so the
 * standard signature's logo renders: the app converts the signature's embedded image to
 * an inline attachment, exactly as it does for quotation emails. The signature itself is
 * pulled live from the app (/api/get-default-signature) so it always matches your quotes.
 */

/** The acknowledgement text (greeting + body paragraphs). The signature is appended from the app. */
const ACK_GREETING = "Dear Sir/Ma'am,";
const ACK_BODY_LINES = [
  'Thank you for your enquiry. We are reviewing your requirement and will share our quotation with you shortly.',
  'We look forward to the opportunity of doing business with you.'
];

/**
 * Build the acknowledger passed to the send-to-app helpers. Returns a function(email) that
 * emails one newly-created enquirer. The signature, app URL and our own addresses are fetched
 * ONCE here and reused for every enquiry in the run.
 * @return {function(Object): void}
 */
function buildEnquiryAcknowledger_() {
  const appUrl = getAppUrl();
  const secret = getIngestSecret();
  const signatureHtml = fetchDefaultSignatureHtml_(appUrl, secret);
  const myAddresses = getMyEmailAddresses_();
  return function (email) {
    acknowledgeCreatedEnquiry_(email, signatureHtml, appUrl, secret, myAddresses);
  };
}

/**
 * Email one newly-created enquirer the acknowledgement (in-thread). Skips an email we sent
 * ourselves (e.g. an internally-forwarded enquiry). Best-effort: a failure is logged, never
 * thrown, so quote creation and the report are unaffected.
 * @param {Object} email - The payload sent to the app: { id, from, subject, ... }
 */
function acknowledgeCreatedEnquiry_(email, signatureHtml, appUrl, secret, myAddresses) {
  if (!email || !email.id) return;
  const from = String(email.from || '').toLowerCase();
  const isFromUs = [...myAddresses].some(function (m) { return m && from.indexOf(m) !== -1; });
  if (isFromUs) {
    Logger.log('Acknowledgement skipped (from us): "' + (email.subject || '') + '"');
    return;
  }
  try {
    if (postAcknowledgementToApp_(appUrl, secret, email.id, signatureHtml)) {
      Logger.log('Acknowledged new enquiry: "' + (email.subject || '') + '" -> ' + email.from);
    }
  } catch (e) {
    Logger.log('Acknowledgement failed for "' + (email.subject || '') + '": ' + e.toString());
  }
}

/** Build the acknowledgement body: greeting + message paragraphs + the app's standard signature. */
function buildAcknowledgementBodyHtml_(signatureHtml) {
  let paras = '<p>' + ACK_GREETING + '</p>';
  for (let i = 0; i < ACK_BODY_LINES.length; i++) {
    paras += '<p>' + ACK_BODY_LINES[i] + '</p>';
  }
  const sig = signatureHtml || 'Regards,<br>DSC Pipes';
  return paras + '<div>' + sig + '</div>';
}

/** GET the app's saved standard signature (HTML). Falls back to a plain sign-off if unavailable. */
function fetchDefaultSignatureHtml_(appUrl, secret) {
  try {
    const headers = {};
    if (secret) headers['X-Ingest-Secret'] = secret;
    const resp = UrlFetchApp.fetch(appUrl + '/api/get-default-signature', { headers: headers, muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      const data = JSON.parse(resp.getContentText());
      if (data && data.content) return data.content;
    } else {
      Logger.log('get-default-signature returned ' + resp.getResponseCode());
    }
  } catch (e) {
    Logger.log('Could not fetch default signature: ' + e.toString());
  }
  return '';
}

/** POST the acknowledgement to the app's send route (replies in-thread; renders the logo). */
function postAcknowledgementToApp_(appUrl, secret, replyToMessageId, signatureHtml) {
  const payload = {
    replyToMessageId: replyToMessageId,
    bodyHtml: buildAcknowledgementBodyHtml_(signatureHtml)
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  if (secret) options.headers = { 'X-Ingest-Secret': secret };
  const resp = UrlFetchApp.fetch(appUrl + '/api/send-email', options);
  const code = resp.getResponseCode();
  if (code >= 200 && code < 300) return true;
  Logger.log('send-email failed (' + code + '): ' + resp.getContentText().substring(0, 300));
  return false;
}
