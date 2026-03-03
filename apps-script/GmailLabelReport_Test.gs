/**
 * Gmail Label Report – TESTING VERSION (Modular)
 * ==============================================
 * Safe copy for experiments. Uses separate sheet, function names, and property.
 * Set DRY_RUN_MODE = true to simulate without writing to the sheet or Gmail.
 *
 * Copy this file into your Apps Script project alongside SendLabeledEmailsToApp.gs.
 * Run runReportNow_Test() from the script editor or assign to a test button.
 */

/***** CONFIG *****/
const SHEET_NAME_TEST = 'Report_Test';
const START_ROW_OFFSET = 5;
const HEADER_ROWS = 3;
const MAX_DATA_ROWS = 30;
const VISIBLE_DATA_ROWS = 5;
const INCLUDE_NO_LABEL = true;
const PROP_LAST_END_TEST = 'LAST_RUN_END_MS_TEST';
const FLAG_LABEL = 'Enquiry - Needs Reply';
const ENQUIRY_LABEL = 'Enquiry';
const QUOTATION_LABEL = 'Quotation';
const OVERDUE_DAYS = 2;
const DRY_RUN_MODE = false;

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
function searchLabelWithinWindow_Test(label, startDateStr, endDatePlusOneStr, startMs, endMs) {
  try {
    const threads = GmailApp.search('label:"' + label + '" after:' + startDateStr + ' before:' + endDatePlusOneStr + ' -in:spam -in:trash');
    const kept = [];
    for (let i = 0; i < threads.length; i++) {
      if (threadHasMessageInWindow_Test(threads[i], startMs, endMs)) kept.push(threads[i]);
    }
    return { count: kept.length, threadIds: kept.map(function (t) { return t.getId(); }) };
  } catch (e) {
    return { count: 0, threadIds: [] };
  }
}

function threadHasMessageInWindow_Test(thread, startMs, endMs) {
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
    const res = searchLabelWithinWindow_Test(lbl, startDateStr, endDatePlusOneStr, startMs, endMs);
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
    if (!threadHasMessageInWindow_Test(thread, startMs, endMs)) continue;
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
    if (threadHasMessageInWindow_Test(flagThreads[t], startMs, endMs)) keptFlag.push(flagThreads[t]);
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

function ensureHeader_Date_Time_Window_Test(sh, labels, flagLabel) {
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

function getOrCreateRowByKey_Test(sh, key) {
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

const COLOR_WHITE = '#FFFFFF';
const COLOR_LIGHT_BLUE = '#DEEBF7';
const COLOR_HEADER_GREY = '#F3F3F3';
const BORDER_COLOR = '#999999';

function applyFormattingAfterWrite_Test(sh, totalCols) {
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

function applyTableBorders_Test(sh, totalCols) {
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

/***** MAIN REPORT FUNCTION (TEST) *****/
function dailyLabelReport_Test() {
  const tz = Session.getScriptTimeZone();
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const nowMs = now.getTime();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEET_NAME_TEST);
  const startMs = getStartMsFromLastSheetRow_(sh, props, now, PROP_LAST_END_TEST);

  const dateStrings = getSearchDateStrings_(tz, startMs, nowMs);
  const maxLabelMsgTs = getMaxLabelMessageTimestamp_(LABELS, dateStrings.startDateStr, dateStrings.endDatePlusOneStr, startMs, nowMs);
  const endMs = getEndMs_(maxLabelMsgTs, nowMs);
  const display = getDisplayDateAndTimeWindow_(now, startMs, endMs, tz);

  if (DRY_RUN_MODE) {
    Logger.log('[DRY RUN] dailyLabelReport_Test would write to sheet "' + SHEET_NAME_TEST + '"');
    Logger.log('[DRY RUN] Window: ' + display.dateTxt + ' ' + display.timeWindowTxt);
    Logger.log('[DRY RUN] Skipping sheet write and property save.');
    return;
  }

  ensureHeader_Date_Time_Window_Test(sh, LABELS, FLAG_LABEL);

  const rowIndex = getOrCreateRowByKey_Test(sh, display.windowKey);

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
  applyFormattingAfterWrite_Test(sh, built.totalCols);
  trimToMaxDataRows_(sh);
  applyRowVisibility_(sh);
  applyTableBorders_Test(sh, built.totalCols);

  SpreadsheetApp.flush();
  props.setProperty(PROP_LAST_END_TEST, String(endMs));

  const created = sendLabeledEmailsToAppForLabel(
    'Quotation Automation/Create Quotation',
    startMs,
    endMs,
    dateStrings.startDateStr,
    dateStrings.endDatePlusOneStr
  );
  return created;
}

/***** BUTTON FUNCTIONS *****/
function runReportNow() {
  runReportNow_Test();
}

function runReportNow_Test() {
  SpreadsheetApp.getActive().toast('Running Gmail report (TEST)…');
  const created = dailyLabelReport_Test();
  const msg = DRY_RUN_MODE ? 'Dry run complete (no changes)' : (typeof created === 'number' ? 'Created ' + created + ' quotation(s)' : 'Report complete ✅');
  SpreadsheetApp.getActive().toast(msg, 'Report complete', 5);
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

function removeFlagIfPresent_Test(thread, flagLabelObj) {
  if (thread.getLabels().some(function (l) { return l.getName() === FLAG_LABEL; })) {
    thread.removeLabel(flagLabelObj);
  }
}

function processEnquiryThread_(thread, flagLabelObj, myAddresses, nowMs, overdueMs) {
  const lastInboundMs = getLastInboundMessageTime_(thread, myAddresses);
  if (!lastInboundMs) {
    removeFlagIfPresent_Test(thread, flagLabelObj);
    return;
  }
  if (threadHasQuotationLabel_(thread)) {
    removeFlagIfPresent_Test(thread, flagLabelObj);
    return;
  }
  if ((nowMs - lastInboundMs) >= overdueMs) {
    thread.addLabel(flagLabelObj);
  } else {
    removeFlagIfPresent_Test(thread, flagLabelObj);
  }
}

/***** ENQUIRY FOLLOW-UP CHECKER (TEST) *****/
function checkEnquiryFollowUps_Test() {
  if (DRY_RUN_MODE) {
    Logger.log('[DRY RUN] checkEnquiryFollowUps_Test would add/remove flag labels. Skipping.');
    return;
  }

  const flagLabelObj = GmailApp.getUserLabelByName(FLAG_LABEL) || GmailApp.createLabel(FLAG_LABEL);
  const myAddresses = getMyEmailAddresses_();
  const nowMs = Date.now();
  const overdueMs = OVERDUE_DAYS * 24 * 60 * 60 * 1000;
  const threads = GmailApp.search('label:"' + ENQUIRY_LABEL + '" -in:spam -in:trash newer_than:60d');

  threads.forEach(function (thread) {
    processEnquiryThread_(thread, flagLabelObj, myAddresses, nowMs, overdueMs);
  });
}
