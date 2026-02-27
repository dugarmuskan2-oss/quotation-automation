/**
 * Gmail Ingest – HTML builder helpers
 * Builds table and header HTML for quotations created from Gmail (no DOM).
 */

const { formatItemDescriptionByPipeType, getPipeHeaderLabel } = require('./descriptionFormatter');

/**
 * Escape a string for safe use in HTML text/attributes.
 * @param {string} str - Raw string (e.g. from email or AI)
 * @returns {string} HTML-safe string
 */
function escapeHtmlForTable(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Compute grand total from line items (quantity * finalRate per row).
 * @param {Array<{ quantity?: string|number, finalRate?: string|number }>} lineItems
 * @returns {{ total: number, formatted: string }}
 */
function computeGrandTotalFromLineItems(lineItems) {
    if (!lineItems || !Array.isArray(lineItems)) {
        return { total: 0, formatted: '0.00' };
    }
    let total = 0;
    for (const item of lineItems) {
        const qty = parseFloat(item.quantity) || 0;
        const rate = parseFloat(item.finalRate) || 0;
        total += qty * rate;
    }
    return {
        total,
        formatted: Number(total).toFixed(2)
    };
}

/**
 * Build HTML for a single item row so Approval section can add buttons and bind handlers.
 * Column order matches manual Creation: row#, description, qty, base rate, margin, rate-per-mtr, amount; Approval appends actions td.
 * Description, base rate, and margin are inputs (editable); quantity, rate-per-mtr, and amount are spans so Approval replaces them with inputs.
 * @param {{ originalDescription?: string, identifiedPipeType?: string, quantity?: string, unitRate?: string, marginPercent?: string, finalRate?: string }} item
 * @param {number} rowIndex - 0-based index for row number
 * @param {number} lineTotal - precomputed quantity * finalRate for this row
 * @returns {string} HTML for one <tr class="item-row"> with 7 <td>s (row#, desc input, qty span, base input, margin input, rate span, amount span)
 */
function buildItemRowHTML(item, rowIndex, lineTotal) {
    const formattedDesc = formatItemDescriptionByPipeType(item) || item.originalDescription || item.identifiedPipeType || '';
    const desc = escapeHtmlForTable(formattedDesc);
    const quantityStr = escapeHtmlForTable(item.quantity);
    const unitRateStr = escapeHtmlForTable(item.unitRate || '');
    const marginStr = escapeHtmlForTable(item.marginPercent || '');
    const finalRateStr = escapeHtmlForTable(item.finalRate || '');
    const amountStr = String(Math.round(Number(lineTotal)));
    return (
        '<tr class="item-row">' +
        '<td></td>' +
        '<td><input type="text" class="editable-field" data-field="originalDescription" value="' + desc + '" placeholder="Enter description" style="width:100%;border:none;background:transparent;"></td>' +
        '<td><span data-field="quantity">' + quantityStr + '</span></td>' +
        '<td class="col-base-rate">₹<input type="number" class="editable-field" data-field="unitRate" value="' + unitRateStr + '" min="0" step="0.01" style="width:80px;"></td>' +
        '<td class="col-margin"><input type="number" class="editable-field" data-field="marginPercent" value="' + marginStr + '" min="0" step="0.01" style="width:60px;"></td>' +
        '<td><span class="rate-per-mtr">₹' + finalRateStr + '</span></td>' +
        '<td><span class="line-total">₹' + amountStr + '</span></td>' +
        '</tr>'
    );
}

/**
 * Build a quotation table HTML string from AI line items.
 * Matches the structure expected by the Approval section (same column count/headers).
 * @param {Array<{ originalDescription?: string, identifiedPipeType?: string, quantity?: string, unitRate?: string, marginPercent?: string, finalRate?: string, lineTotal?: string }>} lineItems
 * @returns {{ tableHTML: string, grandTotal: number, grandTotalFormatted: string }}
 */
function buildTableHTMLFromLineItems(lineItems) {
    // 7 columns so Approval can add ACTIONS (8th) without removing our first column; first th must be S.NO so "remove empty first" does not run
    const emptyTable = '<table id="quotationTable"><thead><tr><th style="width:50px">S. NO</th><th>ITEMS AND DESCRIPTION</th><th>QTY (Mtrs)</th><th class="col-base-rate">BASE RATE</th><th class="col-margin">MARGIN %</th><th>Rate per Mtr</th><th>AMOUNT</th></tr></thead><tbody></tbody></table>';
    if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
        return { tableHTML: emptyTable, grandTotal: 0, grandTotalFormatted: '0' };
    }

    const thead = '<thead><tr><th style="width:50px">S. NO</th><th>ITEMS AND DESCRIPTION</th><th>QTY (Mtrs)</th><th class="col-base-rate">BASE RATE</th><th class="col-margin">MARGIN %</th><th>Rate per Mtr</th><th>AMOUNT</th></tr></thead>';
    const rows = [];
    let grandTotal = 0;

    for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i];
        const qty = parseFloat(item.quantity) || 0;
        const finalRate = parseFloat(item.finalRate) || 0;
        const lineTotal = qty * finalRate;
        grandTotal += lineTotal;
        rows.push(buildItemRowHTML(item, i, Math.round(lineTotal)));
    }
    const roundedGrandTotal = Math.round(grandTotal);

    const firstItem = lineItems[0];
    const pipeHeaderLabel = getPipeHeaderLabel(firstItem && firstItem.identifiedPipeType) || 'Items';
    const pipeHeaderValue = escapeHtmlForTable(pipeHeaderLabel);
    const pipeHeaderRow = '<tr class="pipe-type-header"><td colspan="7"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><input type="text" class="editable-field" data-field="pipeTypeHeader" value="' + pipeHeaderValue + '" style="flex:1;border:none;background:transparent;font-weight:bold;"><div class="pipe-header-actions" style="display:flex;gap:6px;"></div></div></td></tr>';
    const tableHTML = '<table id="quotationTable">' + thead + '<tbody>' + pipeHeaderRow + rows.join('') + '</tbody></table>';
    return {
        tableHTML,
        grandTotal: roundedGrandTotal,
        grandTotalFormatted: String(roundedGrandTotal)
    };
}

/**
 * Build the quotation header block HTML (meta rows + bill/ship) for Approval display.
 * Uses the same structure and data-field names as the creation header in the app.
 * @param {{
 *   quotationDate?: string,
 *   customerName?: string,
 *   kindAttn?: string,
 *   companyName?: string,
 *   projectName?: string,
 *   billTo?: string,
 *   shipTo?: string,
 *   phoneNumber?: string,
 *   mobileNumber?: string,
 *   quoteNumber?: string,
 *   preparedBy?: string,
 *   assignedTo?: string,
 *   checkedBy?: string
 * }} q - Quotation fields
 * @returns {string} HTML string for the header block
 */
function buildHeaderHTMLFromQuotation(q) {
    const quotationDate = escapeHtmlForTable(q.quotationDate || '');
    const kindAttn = escapeHtmlForTable(q.customerName || q.kindAttn || '');
    const billTo = escapeHtmlForTable(q.companyName || q.projectName || q.billTo || '');
    const shipTo = escapeHtmlForTable(q.projectName || q.shipTo || '');
    const phoneNumber = escapeHtmlForTable(q.phoneNumber || '');
    const mobileNumber = escapeHtmlForTable(q.mobileNumber || '');
    const quoteNumber = escapeHtmlForTable(q.quoteNumber || '');
    const preparedBy = escapeHtmlForTable(q.preparedBy || '');
    const assignedTo = escapeHtmlForTable(q.assignedTo || '');
    const checkedBy = escapeHtmlForTable(q.checkedBy || '');

    return `<div class="quotation-header" id="creationQuotationHeader">
<div class="quote-meta">
  <div>
    <div class="meta-row"><span>QUOTATION DATE</span><input type="text" data-field="quotationDate" class="header-editable" style="width:140px;" value="${quotationDate}"></div>
    <div class="meta-row"><span>KIND ATTN</span><input type="text" data-field="kindAttn" class="header-editable" style="width:140px;" value="${kindAttn}"></div>
    <div class="meta-row"><span>PHONE NUMBER</span><input type="text" data-field="phoneNumber" class="header-editable" style="width:140px;" value="${phoneNumber}"></div>
    <div class="meta-row"><span>MOBILE NUMBER</span><input type="text" data-field="mobileNumber" class="header-editable" style="width:140px;" value="${mobileNumber}"></div>
  </div>
  <div>
    <div class="meta-row"><span>PREPARED BY</span><input type="text" data-field="preparedBy" class="header-editable" style="width:140px;" value="${preparedBy}"></div>
    <div class="meta-row"><span>ASSIGNED TO</span><input type="text" data-field="assignedTo" class="header-editable" style="width:140px;" value="${assignedTo}"></div>
    <div class="meta-row"><span>CHECKED BY</span><input type="text" data-field="checkedBy" class="header-editable" style="width:140px;" value="${checkedBy}"></div>
    <div class="meta-row"><span>QUOTE NUMBER</span><input type="text" data-field="quoteNumber" class="header-editable" style="width:140px;" value="${quoteNumber}"></div>
  </div>
</div>
<div class="bill-ship">
  <div><strong>Bill To</strong><br><textarea data-field="billTo" class="header-editable" rows="2" style="width:100%; resize:vertical;">${billTo}</textarea></div>
  <div><strong>Ship To</strong><br><textarea data-field="shipTo" class="header-editable" rows="2" style="width:100%; resize:vertical;">${shipTo}</textarea></div>
</div>
</div>`;
}

module.exports = {
    escapeHtmlForTable,
    computeGrandTotalFromLineItems,
    buildItemRowHTML,
    buildTableHTMLFromLineItems,
    buildHeaderHTMLFromQuotation
};
