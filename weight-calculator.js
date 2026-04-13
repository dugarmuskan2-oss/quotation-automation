// Pipe Weight Calculator Module
// This file is intentionally self-contained and only talks to the existing app
// via approvedQuotations, API_BASE_URL and a few helper functions that already exist.

(function () {
    'use strict';

    /**
     * Simple in-memory map of pipe size -> kg per meter.
     * Populated from a CSV uploaded by the user.
     * Example key: "2\" NB" or "2 inch"
     */
    let pipeWeightMap = {};

    /**
     * Utility: trim and normalize a size key so lookups are more forgiving.
     */
    function normalizeSizeKey(raw) {
        if (!raw) return '';
        let key = String(raw).trim().toLowerCase();
        key = key.replace(/\s+/g, ' ');
        return key;
    }

    /**
     * Utility: safely parse a number from text.
     */
    function parseNumber(value) {
        if (value == null) return NaN;
        const num = parseFloat(String(value).replace(/,/g, '').trim());
        return Number.isFinite(num) ? num : NaN;
    }

    /**
     * Utility: format number to 2 decimals.
     */
    function formatKg(value) {
        if (!Number.isFinite(value)) return '0.00';
        return value.toFixed(2);
    }

    function resolveKgPerMeter(item, sizeKey) {
        const directKgPerMeter = parseNumber(
            item && (item.kgPerMeter || item.kg_per_meter || item.kgPerMtr || item.kg_per_mtr)
        );
        if (Number.isFinite(directKgPerMeter)) {
            return directKgPerMeter;
        }
        return pipeWeightMap[sizeKey];
    }

    /**
     * CSV parser for the simple "size,kgPerMeter" table.
     */
    function parsePipeWeightCsv(text) {
        const lines = text.split(/\r?\n/);
        const map = {};

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i].trim();
            if (!rawLine || rawLine.startsWith('#')) continue;

            const parts = rawLine.split(',');
            if (parts.length < 2) continue;

            const size = parts[0].trim();
            const kgPerMeterRaw = parts[1].trim();
            const kgPerMeter = parseNumber(kgPerMeterRaw);
            if (!size || !Number.isFinite(kgPerMeter)) continue;

            map[normalizeSizeKey(size)] = kgPerMeter;
        }

        return map;
    }

    /**
     * Helper: get DOM elements in a safe way.
     */
    function $(id) {
        return document.getElementById(id);
    }

    /**
     * Tab switching between quotation generator and weight calculator.
     */
    function switchToQuotationTab() {
        const quotationApp = $('quotationApp');
        const weightApp = $('weightCalculatorApp');
        const qBtn = $('mainToolQuotationButton');
        const wBtn = $('mainToolWeightButton');

        if (quotationApp) quotationApp.style.display = '';
        if (weightApp) weightApp.style.display = 'none';
        if (qBtn) qBtn.classList.add('main-tools-button--active');
        if (wBtn) wBtn.classList.remove('main-tools-button--active');
    }

    function switchToWeightTab() {
        const quotationApp = $('quotationApp');
        const weightApp = $('weightCalculatorApp');
        const qBtn = $('mainToolQuotationButton');
        const wBtn = $('mainToolWeightButton');

        if (quotationApp) quotationApp.style.display = 'none';
        if (weightApp) weightApp.style.display = '';
        if (qBtn) qBtn.classList.remove('main-tools-button--active');
        if (wBtn) wBtn.classList.add('main-tools-button--active');
    }

    /**
     * Pipe weight table helpers.
     */
    function clearPipeWeightTable() {
        const tbody = $('pipeWeightTableBody');
        if (tbody) {
            tbody.innerHTML = '';
        }
        const totalEl = $('pipeWeightGrandTotal');
        if (totalEl) {
            totalEl.textContent = '0.00';
        }
    }

    function addPipeRowToTable(description, kgPerMeter, qtyMeters, insertAfterRow) {
        const tbody = $('pipeWeightTableBody');
        if (!tbody) return;

        const row = document.createElement('tr');

        const actionCell = document.createElement('td');
        const descCell = document.createElement('td');
        const kgCell = document.createElement('td');
        const qtyCell = document.createElement('td');
        const totalCell = document.createElement('td');

        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.value = description || '';
        descInput.style.width = '100%';

        const kgInput = document.createElement('input');
        kgInput.type = 'number';
        kgInput.step = '0.01';
        kgInput.min = '0';
        kgInput.value = Number.isFinite(kgPerMeter) ? kgPerMeter : '';
        kgInput.style.width = '100%';

        const qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.step = '0.01';
        qtyInput.min = '0';
        qtyInput.value = Number.isFinite(qtyMeters) ? qtyMeters : '';
        qtyInput.style.width = '100%';

        const totalSpan = document.createElement('span');
        totalSpan.textContent = '0.00';
        totalSpan.className = 'pipe-row-total';

        const actionWrap = document.createElement('div');
        actionWrap.style.display = 'flex';
        actionWrap.style.flexDirection = 'column';
        actionWrap.style.alignItems = 'center';
        actionWrap.style.gap = '6px';
        actionWrap.style.justifyContent = 'center';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.title = 'Add row';
        addBtn.textContent = '➕';
        addBtn.style.cssText = 'background:#4CAF50;color:#fff;border:none;padding:4px 8px;cursor:pointer;border-radius:3px;font-size:14px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;';
        addBtn.addEventListener('click', function () {
            addPipeRowToTable('', NaN, NaN, row);
            recalculateFromTable();
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.title = 'Delete row';
        deleteBtn.textContent = '➖';
        deleteBtn.style.cssText = 'background:#f44336;color:#fff;border:none;padding:4px 8px;cursor:pointer;border-radius:3px;font-size:14px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;';
        deleteBtn.addEventListener('click', function () {
            row.remove();
            recalculateFromTable();
        });

        actionWrap.appendChild(addBtn);
        actionWrap.appendChild(deleteBtn);
        actionCell.appendChild(actionWrap);
        descCell.appendChild(descInput);
        kgCell.appendChild(kgInput);
        qtyCell.appendChild(qtyInput);
        totalCell.appendChild(totalSpan);

        row.appendChild(actionCell);
        row.appendChild(descCell);
        row.appendChild(kgCell);
        row.appendChild(qtyCell);
        row.appendChild(totalCell);

        if (insertAfterRow && insertAfterRow.parentNode === tbody) {
            tbody.insertBefore(row, insertAfterRow.nextElementSibling);
        } else {
            tbody.appendChild(row);
        }
    }

    function populatePipeWeightTable(lineItems) {
        clearPipeWeightTable();

        (Array.isArray(lineItems) ? lineItems : []).forEach(item => {
            const desc = item.originalDescription || item.description || '';
            const sizeKey = normalizeSizeKey(desc);
            const kgPerMeter = resolveKgPerMeter(item, sizeKey);
            const qtyMeters = parseNumber(item.quantity || item.qty || item.meters);
            addPipeRowToTable(desc, kgPerMeter, qtyMeters);
        });

        recalculateFromTable();
    }

    /**
     * Recalculate totals based on the current table content.
     */
    function recalculateFromTable() {
        const tbody = $('pipeWeightTableBody');
        if (!tbody) return;

        const rows = Array.from(tbody.querySelectorAll('tr'));
        let grandTotal = 0;

        rows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            if (inputs.length < 3) return;

            const kgPerMeter = parseNumber(inputs[1].value);
            const qtyMeters = parseNumber(inputs[2].value);
            const rowTotal = Number.isFinite(kgPerMeter) && Number.isFinite(qtyMeters)
                ? kgPerMeter * qtyMeters
                : 0;

            const totalSpan = row.querySelector('.pipe-row-total');
            if (totalSpan) {
                totalSpan.textContent = formatKg(rowTotal);
            }

            grandTotal += rowTotal;
        });

        const totalEl = $('pipeWeightGrandTotal');
        if (totalEl) {
            totalEl.textContent = formatKg(grandTotal);
        }
    }

    /**
     * Option 1: from existing quotation number.
     * This uses approvedQuotations (if available) and their lineItems.
     */
    function calculateFromQuotationNumber() {
        const input = $('weightFromQuoteNumber');
        const statusEl = $('weightFromQuoteStatus');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.style.color = '#666';
        }
        if (!input) return;

        const quoteNumber = String(input.value || '').trim();

        if (!quoteNumber) {
            if (statusEl) {
                statusEl.textContent = 'Please enter a quotation number.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        if (!Array.isArray(window.approvedQuotations) || window.approvedQuotations.length === 0) {
            if (statusEl) {
                statusEl.textContent = 'No approved quotations are loaded yet. Open the Approval tab once to load them.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        const match = window.approvedQuotations.find(q => {
            const header = q.header || {};
            const qn = q.quoteNumber || header.quoteNumber || '';
            return String(qn).trim().toLowerCase() === quoteNumber.toLowerCase();
        });

        if (!match) {
            if (statusEl) {
                statusEl.textContent = 'Quotation not found in the loaded approvals.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        // Prefer AI lineItems if present; otherwise try to parse table HTML.
        let lineItems = Array.isArray(match.lineItems) ? match.lineItems : null;

        if (!lineItems && typeof window.parseQuotationTableForPdf === 'function' && match.tableHTML) {
            try {
                const rows = window.parseQuotationTableForPdf(match.tableHTML);
                lineItems = rows
                    .filter(r => r && (r.type === 'pipe' || r.type === 'item'))
                    .map(r => ({
                        originalDescription: r.desc || '',
                        quantity: r.qty || ''
                    }));
            } catch (e) {
                console.warn('Failed to parse quotation table for weight calculation:', e);
            }
        }

        if (!lineItems || lineItems.length === 0) {
            if (statusEl) {
                statusEl.textContent = 'Quotation found, but no line items available for weight calculation.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        populatePipeWeightTable(lineItems);

        if (statusEl) {
            statusEl.textContent = 'Loaded line items from quotation. You can adjust kg/m and quantities if required.';
            statusEl.style.color = '#2e7d32';
        }
    }

    /**
     * Option 2: manual entry – just adds an empty row for the user.
     */
    function addManualRow() {
        addPipeRowToTable('', NaN, NaN);
    }

    /**
     * Option 2: AI-assisted extraction from pasted content and/or an uploaded file.
     */
    async function calculateFromAiInput() {
        const contentInput = $('weightExtractionText');
        const fileInput = $('weightExtractionFile');
        const statusEl = $('weightExtractionStatus');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.style.color = '#666';
        }

        const contentText = String(contentInput && contentInput.value || '').trim();
        const file = fileInput && fileInput.files && fileInput.files.length > 0
            ? fileInput.files[0]
            : null;

        if (!contentText && !file) {
            if (statusEl) {
                statusEl.textContent = 'Please paste content or choose a file first.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        if (typeof window.extractPipeWeightsWithAI !== 'function') {
            if (statusEl) {
                statusEl.textContent = 'AI pipe weight extraction is not available in this build.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        try {
            if (statusEl) {
                statusEl.textContent = 'Calling AI to extract pipe sizes and kg/meter...';
                statusEl.style.color = '#666';
            }

            const extractionData = await window.extractPipeWeightsWithAI(contentText, file);
            const lineItems = Array.isArray(extractionData && extractionData.lineItems)
                ? extractionData.lineItems
                : [];

            if (!lineItems.length) {
                if (statusEl) {
                    statusEl.textContent = 'AI did not return any pipe rows for this input.';
                    statusEl.style.color = '#c62828';
                }
                return;
            }

            populatePipeWeightTable(lineItems);

            if (statusEl) {
                statusEl.textContent = 'AI pipe rows loaded. Please verify kg/m values and quantities.';
                statusEl.style.color = '#2e7d32';
            }
        } catch (error) {
            console.error('Weight calculator: AI extraction failed', error);
            if (statusEl) {
                statusEl.textContent = 'Failed to extract pipe sizes and kg/meter: ' + (error.message || 'Unknown error');
                statusEl.style.color = '#c62828';
            }
        }
    }

    /**
     * Pipe weight CSV loader.
     */
    function loadPipeWeightFile() {
        const input = $('pipeWeightFile');
        const statusEl = $('pipeWeightStatus');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.style.color = '#666';
        }
        if (!input || !input.files || input.files.length === 0) {
            if (statusEl) {
                statusEl.textContent = 'Please choose a CSV file.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        const file = input.files[0];
        const reader = new FileReader();

        reader.onload = function (e) {
            try {
                pipeWeightMap = parsePipeWeightCsv(e.target.result || '');
                const entries = Object.keys(pipeWeightMap).length;
                if (statusEl) {
                    statusEl.textContent = entries
                        ? `Loaded ${entries} pipe sizes from CSV.`
                        : 'CSV loaded but no valid rows were found.';
                    statusEl.style.color = entries ? '#2e7d32' : '#c62828';
                }
            } catch (error) {
                console.error('Failed to parse pipe weight CSV', error);
                if (statusEl) {
                    statusEl.textContent = 'Failed to parse CSV: ' + (error.message || 'Unknown error');
                    statusEl.style.color = '#c62828';
                }
            }
        };

        reader.onerror = function () {
            if (statusEl) {
                statusEl.textContent = 'Could not read the selected file.';
                statusEl.style.color = '#c62828';
            }
        };

        reader.readAsText(file);
    }

    function printWeightTable() {
        const tbody = $('pipeWeightTableBody');
        const totalEl = $('pipeWeightGrandTotal');
        if (!tbody) return;

        const rows = Array.from(tbody.querySelectorAll('tr')).map(row => {
            const inputs = row.querySelectorAll('input');
            const desc = inputs[0] ? (inputs[0].value || '').trim() : '';
            const kgPerMeter = inputs[1] ? (inputs[1].value || '').trim() : '';
            const qtyMeters = inputs[2] ? (inputs[2].value || '').trim() : '';
            const totalKg = row.querySelector('.pipe-row-total')
                ? (row.querySelector('.pipe-row-total').textContent || '').trim()
                : '';
            return { desc, kgPerMeter, qtyMeters, totalKg };
        }).filter(r => r.desc || r.kgPerMeter || r.qtyMeters || r.totalKg);

        if (!rows.length) {
            return;
        }

        const tableRowsHtml = rows.map(r => `
            <tr>
                <td>${escapeHtml(r.desc)}</td>
                <td>${escapeHtml(r.kgPerMeter)}</td>
                <td>${escapeHtml(r.qtyMeters)}</td>
                <td>${escapeHtml(r.totalKg)}</td>
            </tr>
        `).join('');

        const grandTotal = totalEl ? (totalEl.textContent || '0.00') : '0.00';
        const html = `
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Pipe Weight Calculation</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; color: #222; }
                    h1 { margin: 0 0 6px; font-size: 22px; }
                    .meta { margin-bottom: 14px; color: #555; font-size: 13px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background: #f5f5f5; }
                    .total { margin-top: 14px; font-size: 18px; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Pipe Weight Calculation</h1>
                <div class="meta">Generated on ${new Date().toLocaleString()}</div>
                <table>
                    <thead>
                        <tr>
                            <th>Items and Description</th>
                            <th>Kg / Meter</th>
                            <th>Qty (Meters)</th>
                            <th>Total Weight (Kg)</th>
                        </tr>
                    </thead>
                    <tbody>${tableRowsHtml}</tbody>
                </table>
                <div class="total">Total Weight: ${escapeHtml(grandTotal)} Kg</div>
            </body>
            </html>
        `;

        // Hidden iframe + document.write: avoids popup/blob timing issues that yield blank print previews in Chromium.
        // Use real dimensions off-screen (not 0×0 or opacity:0) so the print engine lays out content.
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.cssText =
            'position:absolute;left:-9999px;top:0;width:8.5in;min-height:11in;border:0;';
        document.body.appendChild(iframe);

        const idoc = iframe.contentDocument || iframe.contentWindow.document;
        idoc.open();
        idoc.write(html);
        idoc.close();

        const pwin = iframe.contentWindow;
        function runPrint() {
            let bodyLen = -1;
            try {
                if (idoc.body) {
                    bodyLen = (idoc.body.innerHTML || '').length;
                }
            } catch (e) {
                bodyLen = -2;
            }
            // #region agent log
            fetch('http://127.0.0.1:7704/ingest/401e8f63-b24f-4a79-ac2c-9ba6e0d45a1a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e575a6'},body:JSON.stringify({sessionId:'e575a6',runId:'iframe-print',hypothesisId:'H7',location:'weight-calculator.js:printWeightTable:runPrint',message:'iframe print',data:{bodyInnerHtmlLen:bodyLen,htmlLen:html.length,rowCount:rows.length},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            pwin.focus();
            pwin.print();
            pwin.addEventListener(
                'afterprint',
                function removeIframe() {
                    iframe.remove();
                },
                { once: true }
            );
        }

        pwin.requestAnimationFrame(function () {
            pwin.requestAnimationFrame(runPrint);
        });
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Initialisation: expose a small, well-defined surface on window.
     */
    function init() {
        // Expose tab switchers for the buttons in index.html
        window.switchToQuotationTab = switchToQuotationTab;
        window.switchToWeightTab = switchToWeightTab;

        // Public API for the weight calculator UI
        window.pipeWeightCalculator = {
            loadPipeWeightFile,
            calculateFromQuotationNumber,
            addManualRow,
            calculateFromAiInput,
            calculateFromUploadedFile: calculateFromAiInput,
            recalculateFromTable,
            printWeightTable
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

