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

    function addPipeRowToTable(description, kgPerMeter, qtyMeters) {
        const tbody = $('pipeWeightTableBody');
        if (!tbody) return;

        const row = document.createElement('tr');

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

        descCell.appendChild(descInput);
        kgCell.appendChild(kgInput);
        qtyCell.appendChild(qtyInput);
        totalCell.appendChild(totalSpan);

        row.appendChild(descCell);
        row.appendChild(kgCell);
        row.appendChild(qtyCell);
        row.appendChild(totalCell);

        tbody.appendChild(row);
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

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/401e8f63-b24f-4a79-ac2c-9ba6e0d45a1a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e575a6'},body:JSON.stringify({sessionId:'e575a6',runId:'pre-fix',hypothesisId:'H4/H5',location:'weight-calculator.js:calculateFromQuotationNumber',message:'Matched quotation for weight calculation',data:{quoteNumber,hasMatch:!!match,lineItemsPresent:Array.isArray(match.lineItems),lineItemCount:Array.isArray(match.lineItems)?match.lineItems.length:0,kgPerMeterCount:Array.isArray(match.lineItems)?match.lineItems.filter(item=>String(item.kgPerMeter||'').trim()!=='').length:0,sample:Array.isArray(match.lineItems)?match.lineItems.slice(0,3).map(item=>({desc:item.originalDescription||item.description||'',kgPerMeter:item.kgPerMeter||''})):[]},timestamp:Date.now()})}).catch(()=>{});
        // #endregion agent log

        if (!lineItems && typeof window.parseQuotationTableForPdf === 'function' && match.tableHTML) {
            try {
                const rows = window.parseQuotationTableForPdf(match.tableHTML);
                lineItems = rows
                    .filter(r => r && (r.type === 'pipe' || r.type === 'item'))
                    .map(r => ({
                        originalDescription: r.desc || '',
                        quantity: r.qty || ''
                    }));
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/401e8f63-b24f-4a79-ac2c-9ba6e0d45a1a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e575a6'},body:JSON.stringify({sessionId:'e575a6',runId:'pre-fix',hypothesisId:'H5',location:'weight-calculator.js:calculateFromQuotationNumber',message:'Fell back to parsing tableHTML for line items',data:{quoteNumber,parsedLineItemCount:Array.isArray(lineItems)?lineItems.length:0,sample:Array.isArray(lineItems)?lineItems.slice(0,3).map(item=>({desc:item.originalDescription||'',kgPerMeter:item.kgPerMeter||''})):[]},timestamp:Date.now()})}).catch(()=>{});
                // #endregion agent log
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

        clearPipeWeightTable();

        lineItems.forEach(item => {
            const desc = item.originalDescription || item.description || '';
            const sizeKey = normalizeSizeKey(desc);
            const kgPerMeter = resolveKgPerMeter(item, sizeKey);
            const qtyMeters = parseNumber(item.quantity || item.qty || item.meters);
            addPipeRowToTable(desc, kgPerMeter, qtyMeters);
        });

        recalculateFromTable();

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
     * Option 3: upload file and use the same AI backend to extract pipe sizes.
     * This sends content to the existing /generate-quotation endpoint and then
     * reuses the lineItems exactly like option 1.
     */
    async function calculateFromUploadedFile() {
        const fileInput = $('weightFromFileUpload');
        const statusEl = $('weightFromFileStatus');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.style.color = '#666';
        }

        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            if (statusEl) {
                statusEl.textContent = 'Please choose a file first.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        const file = fileInput.files[0];

        if (typeof window.readUploadedFileContent !== 'function' ||
            typeof window.fetchQuotationData !== 'function') {
            if (statusEl) {
                statusEl.textContent = 'AI quotation extraction is not available in this build.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        try {
            if (statusEl) {
                statusEl.textContent = 'Reading file and calling AI...';
                statusEl.style.color = '#666';
            }

            const fileContent = await window.readUploadedFileContent(file);
            const quotationData = await window.fetchQuotationData('', fileContent, file);

            const lineItems = Array.isArray(quotationData && quotationData.lineItems)
                ? quotationData.lineItems
                : [];

            if (!lineItems.length) {
                if (statusEl) {
                    statusEl.textContent = 'AI did not return any line items for this file.';
                    statusEl.style.color = '#c62828';
                }
                return;
            }

            clearPipeWeightTable();

            lineItems.forEach(item => {
                const desc = item.originalDescription || item.description || '';
                const sizeKey = normalizeSizeKey(desc);
                const kgPerMeter = resolveKgPerMeter(item, sizeKey);
                const qtyMeters = parseNumber(item.quantity || item.qty || item.meters);
                addPipeRowToTable(desc, kgPerMeter, qtyMeters);
            });

            recalculateFromTable();

            if (statusEl) {
                statusEl.textContent = 'AI line items loaded. Please verify kg/m values and quantities.';
                statusEl.style.color = '#2e7d32';
            }
        } catch (error) {
            console.error('Weight calculator: AI extraction failed', error);
            if (statusEl) {
                statusEl.textContent = 'Failed to extract pipes from file: ' + (error.message || 'Unknown error');
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
            calculateFromUploadedFile,
            recalculateFromTable
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

