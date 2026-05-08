(function () {
    'use strict';

    function $(id) {
        return document.getElementById(id);
    }

    function parseNumber(value) {
        const n = parseFloat(String(value == null ? '' : value).replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : NaN;
    }

    function getDefaults() {
        return {
            productSpec: String(($('enquiryDefaultProductSpec') && $('enquiryDefaultProductSpec').value) || '').trim(),
            uom: String(($('enquiryDefaultUom') && $('enquiryDefaultUom').value) || '').trim(),
            makeRequired: String(($('enquiryDefaultMake') && $('enquiryDefaultMake').value) || '').trim()
        };
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function resetEnquiryDefaults() {
        const headerEl = $('enquiryHeaderText');
        if (headerEl) {
            headerEl.value = [
                'DEAR SIR',
                '        KINDLY QUOTE YOUR BEST RATE WITH MINIMUM DELIVERY PERIOD. Please quote the rates for NO NEGATIVE TOLERANCE.',
                '               NOTE: PLEASE MENTION UOM (MTR /KG /MT - METRIC TON) CLEARLY.'
            ].join('\n');
        }
        const prodEl = $('enquiryDefaultProductSpec');
        const uomEl = $('enquiryDefaultUom');
        const makeEl = $('enquiryDefaultMake');
        if (prodEl) prodEl.value = 'MS ERW PIPE AS PER IS 1239/3589';
        if (uomEl) uomEl.value = 'MTR';
        if (makeEl) makeEl.value = 'JINDAL';
    }

    function normalizeQuotation(quotation) {
        if (!quotation || typeof quotation !== 'object') {
            return null;
        }
        const header = quotation.header || {};
        const lineItems = Array.isArray(quotation.lineItems) ? quotation.lineItems : [];
        return {
            quoteNumber: quotation.quoteNumber || header.quoteNumber || '',
            customerName: quotation.customerName || header.billTo || header.customerName || '',
            kindAttn: header.kindAttn || '',
            projectName: quotation.projectName || header.projectName || '',
            lineItems: lineItems.map(function (item, idx) {
                const qty = parseNumber(item.quantity || item.qty);
                return {
                    slNo: idx + 1,
                    description: item.originalDescription || item.description || item.identifiedPipeType || '',
                    quantity: Number.isFinite(qty) ? String(qty) : String(item.quantity || item.qty || '').trim(),
                    unit: String(item.unit || item.uom || 'Nos').trim()
                };
            }).filter(function (item) {
                return item.description || item.quantity;
            })
        };
    }

    function setStatus(id, text, ok) {
        var el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.style.color = ok ? '#2e7d32' : '#c62828';
    }

    function setInlineStatus(id, text, ok) {
        var el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.style.color = ok ? '#2e7d32' : '#c62828';
    }

    // ===== Enquiry Table Functions (and sub-functions) =====

    function getEnquiryTbody() {
        return $('enquiryTableBody');
    }

    function renumberEnquiryRows() {
        const tbody = getEnquiryTbody();
        if (!tbody) return;
        Array.from(tbody.querySelectorAll('tr')).forEach((tr, idx) => {
            const slInput = tr.querySelector('input[data-col="slNo"]');
            if (slInput) slInput.value = String(idx + 1);
        });
    }

    function extractSizeFromDescription(description) {
        const text = String(description || '').trim();
        if (!text) return '';
        // Prefer inch + thickness patterns like: 8" X 6.35 MM
        const m = text.match(/(\d+(\.\d+)?\s*"?\s*(?:inch|in)?\s*[xX×]\s*\d+(\.\d+)?\s*mm)/i);
        if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim().toUpperCase();
        // Try: 8" X 6.35 MM already formatted
        const m2 = text.match(/(\d+(\.\d+)?\s*"\s*[xX×]\s*\d+(\.\d+)?\s*mm)/i);
        if (m2 && m2[1]) return m2[1].replace(/\s+/g, ' ').trim().toUpperCase();
        // Fallback: first line if description contains newlines
        const firstLine = text.split(/\r?\n/)[0].trim();
        return firstLine;
    }

    function buildEnquiryRowModel(fromLineItem) {
        const d = getDefaults();
        const desc = (fromLineItem && fromLineItem.description) || '';
        const qty = (fromLineItem && fromLineItem.quantity) || '';
        const size = extractSizeFromDescription(desc);

        return {
            productSpec: d.productSpec || 'MS ERW PIPE AS PER IS 1239/3589',
            size: size || desc,
            qty: qty,
            uom: (fromLineItem && fromLineItem.unit) || d.uom || 'MTR',
            lengthReqByUs: '',
            makeRequiredByUs: d.makeRequired || 'JINDAL',
            rate: '',
            offerUom: '',
            makeOfferedByYou: ''
        };
    }

    function createActionButtonsCell(tr) {
        const td = document.createElement('td');
        const wrap = document.createElement('div');
        wrap.className = 'enquiry-actions';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'enquiry-action-btn enquiry-action-btn--add';
        addBtn.title = 'Add row';
        addBtn.textContent = '➕';
        addBtn.addEventListener('click', function () {
            addEnquiryRowToTable(buildEnquiryRowModel(null), tr);
            renumberEnquiryRows();
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'enquiry-action-btn enquiry-action-btn--del';
        delBtn.title = 'Delete row';
        delBtn.textContent = '➖';
        delBtn.addEventListener('click', function () {
            tr.remove();
            ensureEnquiryTableHasRow();
            renumberEnquiryRows();
        });

        wrap.appendChild(addBtn);
        wrap.appendChild(delBtn);
        td.appendChild(wrap);
        return td;
    }

    function createInputCell(colKey, value, placeholder) {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value == null ? '' : String(value);
        input.placeholder = placeholder || '';
        input.setAttribute('data-col', colKey);
        td.appendChild(input);
        return td;
    }

    function addEnquiryRowToTable(model, insertAfterRow) {
        const tbody = getEnquiryTbody();
        if (!tbody) return;

        const tr = document.createElement('tr');
        tr.appendChild(createActionButtonsCell(tr));
        tr.appendChild(createInputCell('slNo', '', ''));
        tr.appendChild(createInputCell('productSpec', model.productSpec, 'PRODUCT & SPECIFICATION'));
        tr.appendChild(createInputCell('size', model.size, 'SIZE'));
        tr.appendChild(createInputCell('qty', model.qty, 'QTY'));
        tr.appendChild(createInputCell('uom', model.uom, 'UOM'));
        tr.appendChild(createInputCell('lengthReqByUs', model.lengthReqByUs, ''));
        tr.appendChild(createInputCell('makeRequiredByUs', model.makeRequiredByUs, ''));
        tr.appendChild(createInputCell('rate', model.rate, ''));
        tr.appendChild(createInputCell('offerUom', model.offerUom, ''));
        tr.appendChild(createInputCell('makeOfferedByYou', model.makeOfferedByYou, ''));

        if (insertAfterRow && insertAfterRow.parentNode === tbody) {
            tbody.insertBefore(tr, insertAfterRow.nextElementSibling);
        } else {
            tbody.appendChild(tr);
        }

        renumberEnquiryRows();
    }

    function clearEnquiryTable() {
        const tbody = getEnquiryTbody();
        if (tbody) tbody.innerHTML = '';
    }

    function ensureEnquiryTableHasRow() {
        const tbody = getEnquiryTbody();
        if (!tbody) return;
        if (tbody.querySelectorAll('tr').length > 0) return;
        addEnquiryRowToTable(buildEnquiryRowModel(null));
        renumberEnquiryRows();
    }

    function populateEnquiryTableFromQuotation(rawQuotation) {
        const normalized = normalizeQuotation(rawQuotation);
        if (!normalized) throw new Error('Could not read quotation details.');
        if (!normalized.lineItems.length) throw new Error('Quotation found, but it has no line items.');

        clearEnquiryTable();
        normalized.lineItems.forEach(li => {
            addEnquiryRowToTable(buildEnquiryRowModel(li));
        });
        renumberEnquiryRows();
    }

    // ===== Upload rows (CSV) =====

    function normalizeHeaderKey(key) {
        return String(key || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/_/g, '');
    }

    function splitCsvLine(line) {
        const out = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                // handle escaped quote ""
                if (inQuotes && line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }
            if (ch === ',' && !inQuotes) {
                out.push(cur);
                cur = '';
                continue;
            }
            cur += ch;
        }
        out.push(cur);
        return out.map(v => String(v || '').trim());
    }

    function parseEnquiryRowsCsv(text) {
        const raw = String(text || '').replace(/^\uFEFF/, '');
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) return { rows: [], error: 'CSV is empty.' };

        const first = splitCsvLine(lines[0]);
        const looksLikeHeader = first.some(c => /[a-zA-Z]/.test(c));
        let header = null;
        let startIdx = 0;
        if (looksLikeHeader) {
            header = first.map(normalizeHeaderKey);
            startIdx = 1;
        }

        const rows = [];
        for (let i = startIdx; i < lines.length; i++) {
            const cols = splitCsvLine(lines[i]);
            if (!cols.length || cols.every(c => !c)) continue;

            const obj = {};
            if (header) {
                header.forEach((h, idx) => {
                    obj[h] = cols[idx] || '';
                });
            } else {
                // positional fallback
                obj.productspec = cols[0] || '';
                obj.size = cols[1] || '';
                obj.qty = cols[2] || '';
                obj.uom = cols[3] || '';
                obj.lengthreqbyus = cols[4] || '';
                obj.makerequiredbyus = cols[5] || '';
                obj.rate = cols[6] || '';
                obj.offeruom = cols[7] || '';
                obj.makeofferedbyyou = cols[8] || '';
            }

            rows.push({
                productSpec: obj.productspec || obj.productspecification || obj.product || obj.specification || '',
                size: obj.size || '',
                qty: obj.qty || obj.quantity || '',
                uom: obj.uom || '',
                lengthReqByUs: obj.lengthreqbyus || obj.length || '',
                makeRequiredByUs: obj.makerequiredbyus || obj.makerequired || obj.make || '',
                rate: obj.rate || '',
                offerUom: obj.offeruom || obj.offerunit || '',
                makeOfferedByYou: obj.makeofferedbyyou || obj.makeoffered || ''
            });
        }

        return { rows, error: '' };
    }

    function modelFromUploadedRow(row) {
        const d = getDefaults();
        return {
            productSpec: String(row.productSpec || d.productSpec || 'MS ERW PIPE AS PER IS 1239/3589').trim(),
            size: String(row.size || '').trim(),
            qty: String(row.qty || '').trim(),
            uom: String(row.uom || d.uom || 'MTR').trim(),
            lengthReqByUs: String(row.lengthReqByUs || '').trim(),
            makeRequiredByUs: String(row.makeRequiredByUs || d.makeRequired || 'JINDAL').trim(),
            rate: String(row.rate || '').trim(),
            offerUom: String(row.offerUom || '').trim(),
            makeOfferedByYou: String(row.makeOfferedByYou || '').trim()
        };
    }

    function loadRowsFromUploadedCsv() {
        const fileEl = $('enquiryRowsFile');
        if (!fileEl || !fileEl.files || fileEl.files.length === 0) {
            setInlineStatus('enquiryRowsFileStatus', 'Please choose a CSV file first.', false);
            return;
        }
        const file = fileEl.files[0];
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const text = String(e && e.target && e.target.result || '');
                const parsed = parseEnquiryRowsCsv(text);
                if (parsed.error) {
                    setInlineStatus('enquiryRowsFileStatus', parsed.error, false);
                    return;
                }
                if (!parsed.rows.length) {
                    setInlineStatus('enquiryRowsFileStatus', 'No valid rows found in CSV.', false);
                    return;
                }
                clearEnquiryTable();
                parsed.rows.forEach(r => addEnquiryRowToTable(modelFromUploadedRow(r)));
                renumberEnquiryRows();
                setInlineStatus('enquiryRowsFileStatus', `Loaded ${parsed.rows.length} row(s) from CSV.`, true);
            } catch (err) {
                setInlineStatus('enquiryRowsFileStatus', 'Failed to parse CSV: ' + (err.message || 'Unknown error'), false);
            }
        };
        reader.onerror = function () {
            setInlineStatus('enquiryRowsFileStatus', 'Could not read the selected file.', false);
        };
        reader.readAsText(file);
    }

    function readHeaderText() {
        return String(($('enquiryHeaderText') && $('enquiryHeaderText').value) || '').trim();
    }

    function buildEnquiryHtmlForCopy() {
        const headerText = readHeaderText();
        const tbody = getEnquiryTbody();
        const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];

        const headerLines = headerText
            ? headerText.split(/\r?\n/).map(l => `<div style="font-weight:${l.trim().toUpperCase()==='DEAR SIR'?'700':'600'}; margin:2px 0;">${escapeHtml(l)}</div>`).join('')
            : '';

        const tableRows = rows.map((tr, idx) => {
            const getVal = (key) => (tr.querySelector(`input[data-col="${key}"]`)?.value || '').trim();
            const bg = (idx % 2 === 0) ? '#ffffff' : '#eef5ff';
            const cellBase = `border:1px solid #c7d5ee;padding:8px;background-color:${bg};`;
            // Outlook often ignores <tr background>, so apply on each <td> + bgcolor.
            return `
                <tr>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('slNo'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}">${escapeHtml(getVal('productSpec'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}">${escapeHtml(getVal('size'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:right;">${escapeHtml(getVal('qty'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('uom'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('lengthReqByUs'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('makeRequiredByUs'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('rate'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('offerUom'))}</td>
                    <td bgcolor="${bg}" style="${cellBase}text-align:center;">${escapeHtml(getVal('makeOfferedByYou'))}</td>
                </tr>
            `;
        }).join('');

        return `
            <div style="font-family: Arial, sans-serif; color:#111; font-size:13px;">
                ${headerLines}
                <div style="height:10px;"></div>
                <table cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt;">
                    <thead>
                        <tr>
                            <th colspan="7" style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;text-align:center;">OUR REQUIREMENT (ENQUIRY)</th>
                            <th colspan="3" style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;text-align:center;">YOUR OFFER</th>
                        </tr>
                        <tr>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">S. NO</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">PRODUCT &amp; SPECIFICATION</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">SIZE</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">QTY</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">UOM</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">LENGTH REQ BY US</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">MAKE REQUIRED BY US</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">RATE</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">UOM</th>
                            <th style="background:#0b4aa2;color:#fff;border:1px solid #0b4aa2;padding:8px;">MAKE OFFERED BY YOU</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        `.trim();
    }

    function buildEnquiryTextForCopy() {
        const headerText = readHeaderText();
        const tbody = getEnquiryTbody();
        const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
        const lines = [];
        if (headerText) lines.push(headerText, '');
        lines.push('OUR REQUIREMENT (ENQUIRY) / YOUR OFFER');
        lines.push('S.NO | PRODUCT & SPEC | SIZE | QTY | UOM | LENGTH | MAKE REQUIRED | RATE | OFFER UOM | MAKE OFFERED');
        rows.forEach((tr) => {
            const getVal = (key) => (tr.querySelector(`input[data-col="${key}"]`)?.value || '').trim();
            lines.push([
                getVal('slNo'),
                getVal('productSpec'),
                getVal('size'),
                getVal('qty'),
                getVal('uom'),
                getVal('lengthReqByUs'),
                getVal('makeRequiredByUs'),
                getVal('rate'),
                getVal('offerUom'),
                getVal('makeOfferedByYou')
            ].join(' | '));
        });
        return lines.join('\n');
    }

    async function copyHtmlToClipboard(html, plainTextFallback) {
        if (navigator.clipboard && window.ClipboardItem) {
            try {
                const item = new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([plainTextFallback || ''], { type: 'text/plain' })
                });
                await navigator.clipboard.write([item]);
                return true;
            } catch (_) { }
        }
        // Fallback: copy plain text
        try {
            await navigator.clipboard.writeText(plainTextFallback || '');
            return true;
        } catch (_) {
            return false;
        }
    }

    function copyHtmlWithExecCommand(html) {
        // Outlook-friendly fallback: copy selection from DOM.
        const container = document.createElement('div');
        container.setAttribute('contenteditable', 'true');
        container.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
        container.innerHTML = html;
        document.body.appendChild(container);

        // Some editors require the element to be focused for rich copy.
        try { container.focus(); } catch (_) { }

        const range = document.createRange();
        range.selectNodeContents(container);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (_) {
            ok = false;
        }

        sel.removeAllRanges();
        container.remove();
        return ok;
    }

    function findByQuotationNumber(quoteNumber) {
        var all = Array.isArray(window.approvedQuotations) ? window.approvedQuotations : [];
        var target = String(quoteNumber || '').trim().toLowerCase();
        if (!target) return null;
        return all.find(function (q) {
            var header = q.header || {};
            var qn = q.quoteNumber || header.quoteNumber || '';
            return String(qn).trim().toLowerCase() === target;
        }) || null;
    }

    function createEnquiryFromQuotationNumber() {
        setStatus('enquiryFromQuoteStatus', '', false);
        var quoteInput = $('enquiryFromQuoteNumber');
        var quoteNumber = quoteInput ? String(quoteInput.value || '').trim() : '';

        if (!quoteNumber) {
            setStatus('enquiryFromQuoteStatus', 'Please enter a quotation number.', false);
            return;
        }
        if (!Array.isArray(window.approvedQuotations) || !window.approvedQuotations.length) {
            setStatus('enquiryFromQuoteStatus', 'No approved quotations are loaded yet. Open Approval once to load data.', false);
            return;
        }

        var match = findByQuotationNumber(quoteNumber);
        if (!match) {
            setStatus('enquiryFromQuoteStatus', 'Quotation not found in loaded approvals.', false);
            return;
        }

        populateEnquiryTableFromQuotation(match);
        setStatus('enquiryFromQuoteStatus', 'Enquiry table created from quotation number.', true);
    }

    async function createEnquiryFromAiInput() {
        setStatus('enquiryInputStatus', '', false);
        var text = String(($('enquiryInputText') && $('enquiryInputText').value) || '').trim();
        var fileEl = $('enquiryInputFile');
        var file = fileEl && fileEl.files && fileEl.files.length > 0 ? fileEl.files[0] : null;

        if (!text && !file) {
            setStatus('enquiryInputStatus', 'Please paste content or choose a file first.', false);
            return;
        }
        if (typeof window.extractQuotationWithAIFile !== 'function') {
            setStatus('enquiryInputStatus', 'AI extraction is not available in this build.', false);
            return;
        }

        try {
            setStatus('enquiryInputStatus', 'Calling AI to extract enquiry details...', true);
            var aiData = await window.extractQuotationWithAIFile(text, file);
            populateEnquiryTableFromQuotation(aiData);
            setStatus('enquiryInputStatus', 'Enquiry table created from pasted/uploaded content.', true);
        } catch (error) {
            console.error('Enquiry preparer failed:', error);
            setStatus('enquiryInputStatus', 'Failed to create enquiry: ' + (error.message || 'Unknown error'), false);
        }
    }

    async function copyEnquiryAsHtml() {
        const statusEl = $('generatedEnquiryStatus');
        ensureEnquiryTableHasRow();
        const html = buildEnquiryHtmlForCopy();
        const text = buildEnquiryTextForCopy();
        // IMPORTANT: Many Windows email clients (notably Outlook) will ignore ClipboardItem HTML
        // and paste the text/plain fallback. Prefer execCommand rich copy first.
        let ok = copyHtmlWithExecCommand(html);
        if (!ok) ok = await copyHtmlToClipboard(html, text);
        if (statusEl) {
            statusEl.textContent = ok ? 'Enquiry copied (HTML table).' : 'Copy failed. Try Copy as Text.';
            statusEl.style.color = ok ? '#2e7d32' : '#c62828';
        }
    }

    async function copyEnquiryAsText() {
        const statusEl = $('generatedEnquiryStatus');
        ensureEnquiryTableHasRow();
        const text = buildEnquiryTextForCopy();
        try {
            await navigator.clipboard.writeText(text);
            if (statusEl) {
                statusEl.textContent = 'Enquiry copied (text).';
                statusEl.style.color = '#2e7d32';
            }
        } catch (e) {
            if (statusEl) {
                statusEl.textContent = 'Copy failed: ' + (e && e.message ? e.message : 'Unknown error');
                statusEl.style.color = '#c62828';
            }
        }
    }

    function addManualRow() {
        addEnquiryRowToTable(buildEnquiryRowModel(null));
        renumberEnquiryRows();
    }

    function init() {
        resetEnquiryDefaults();
        ensureEnquiryTableHasRow();

        window.enquiryPreparer = {
            createEnquiryFromQuotationNumber: createEnquiryFromQuotationNumber,
            createEnquiryFromAiInput: createEnquiryFromAiInput,
            copyEnquiryAsHtml: copyEnquiryAsHtml,
            copyEnquiryAsText: copyEnquiryAsText,
            addManualRow: addManualRow,
            resetEnquiryDefaults: resetEnquiryDefaults,
            loadRowsFromUploadedCsv: loadRowsFromUploadedCsv
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
