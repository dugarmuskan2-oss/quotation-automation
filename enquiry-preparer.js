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
        // Defaults only when inputs do not provide values.
        return {
            uom: 'MTRS',
            makeRequired: 'JINDAL'
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
                "Dear Sir/Ma'am,",
                '',
                'KINDLY QUOTE YOUR BEST RATE WITH MINIMUM DELIVERY PERIOD.',
                '',
                'NOTE: PLEASE MENTION UOM (MTR /KG /MT - METRIC TON) CLEARLY.'
            ].join('\n');
        }
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
                    // If using the quotation option, treat the pipe type header as the specification.
                    productSpec: String(item.identifiedPipeType || '').trim(),
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

    // ===== Spec extraction (functions/sub-functions) =====

    function normalizeSpecToken(token) {
        return String(token || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*-\s*/g, '-')
            .trim()
            .toUpperCase();
    }

    function extractGradeTokens(text) {
        const t = String(text || '');
        const tokens = [];

        // Gr / Grade tokens (allow multi-part like "Gr. B", "Grade X42", "Gr B PSL2")
        const gr = t.match(/\bGR(?:ADE)?\.?\s*([A-Z0-9][A-Z0-9\-\/\.]{0,10})\b/gi);
        if (gr) {
            gr.forEach(raw => {
                const m = raw.match(/\bGR(?:ADE)?\.?\s*(.+)$/i);
                if (m && m[1]) tokens.push('GR. ' + normalizeSpecToken(m[1]));
            });
        }

        // PSL1 / PSL2
        const psl = t.match(/\bPSL\s*([12])\b/gi);
        if (psl) psl.forEach(v => tokens.push(normalizeSpecToken(v)));

        // X42 / X52 / X60 / etc
        const x = t.match(/\bX\s*([0-9]{2,3})\b/gi);
        if (x) x.forEach(v => tokens.push(normalizeSpecToken(v)));

        // L245 / L290 etc (common EN/API grade style)
        const l = t.match(/\bL\s*([0-9]{3})\b/gi);
        if (l) l.forEach(v => tokens.push(normalizeSpecToken(v)));

        // P-number / WPB-like common pipe fittings grades
        const wp = t.match(/\bW(P)?B\b/gi);
        if (wp) wp.forEach(v => tokens.push(normalizeSpecToken(v)));

        return uniqTokens(tokens);
    }

    function uniqTokens(tokens) {
        const seen = new Set();
        const out = [];
        (Array.isArray(tokens) ? tokens : []).forEach(t => {
            const key = normalizeSpecToken(t);
            if (!key) return;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(key);
        });
        return out;
    }

    function extractStandardTokens(text) {
        const t = String(text || '');

        // Standard bodies + codes/numbers.
        // Examples:
        // IS 1239, IS:3589, API 5L, API5CT, ASTM A106, ASTM-A53, EN 10255, DIN 2448, BS 1387, JIS G3452, ISO 3183, ASME B36.10, AWWA C200
        const bodies = [
            'IS', 'API', 'ASTM', 'EN', 'DIN', 'BS', 'JIS', 'ISO', 'ASME', 'AWWA', 'NACE', 'CSA', 'GOST', 'SS'
        ];
        const bodyRe = new RegExp(
            `\\b(?:${bodies.join('|')})\\b\\s*[:\\-]?\\s*` +
            // Allow: A106, B36.10, G3452, 5L, 5CT, 3183, 10255, C200 etc.
            `([A-Z]{0,2}\\s*[0-9]{1,5}(?:\\.[0-9]{1,4})?(?:\\s*[A-Z]{0,3})?)`,
            'gi'
        );

        const matches = [];
        let m;
        while ((m = bodyRe.exec(t)) !== null) {
            const full = (m[0] || '').trim();
            const body = full.split(/\s|:/)[0].toUpperCase();
            const rest = (m[1] || '').replace(/\s+/g, '').toUpperCase();
            if (body && rest) matches.push(`${body} ${rest}`);
        }

        // Also allow patterns like "API5L" without space
        const compact = t.match(/\b(API|ASTM|JIS|ISO|ASME|AWWA|NACE|CSA|DIN|BS|EN|IS)([A-Z]{0,2}[0-9]{1,5}(?:\.[0-9]{1,4})?(?:[A-Z]{0,3})?)\b/gi);
        if (compact) {
            compact.forEach(v => {
                const mm = v.match(/\b([A-Z]+)(.+)\b/i);
                if (mm && mm[1] && mm[2]) matches.push(`${mm[1].toUpperCase()} ${mm[2].toUpperCase()}`);
            });
        }

        return uniqTokens(matches);
    }

    function inferProductSpecFromText(description, fallbackText) {
        const src = String(description || fallbackText || '').trim();
        if (!src) return '';

        const standards = extractStandardTokens(src);
        const grades = extractGradeTokens(src);
        const tokens = standards.concat(grades);

        if (!tokens.length) return '';
        // Keep concise but informative.
        return tokens.join(' ');
    }

    function buildEnquiryRowModel(fromLineItem) {
        const d = getDefaults();
        const desc = (fromLineItem && fromLineItem.description) || '';
        const qty = (fromLineItem && fromLineItem.quantity) || '';
        const size = extractSizeFromDescription(desc);
        const inferredSpec = inferProductSpecFromText(desc, size);
        const productSpec = String((fromLineItem && fromLineItem.productSpec) || '').trim() || inferredSpec;

        // #region agent log
        __dbg('H6', 'enquiry-preparer.js:buildEnquiryRowModel', 'spec inference', {
            hasInferred: !!inferredSpec,
            inferred: inferredSpec ? inferredSpec.slice(0, 40) : '',
            used: productSpec ? productSpec.slice(0, 40) : ''
        });
        // #endregion

        return {
            productSpec,
            size: size || desc,
            qty: qty,
            uom: String((fromLineItem && (fromLineItem.unit || fromLineItem.uom)) || '').trim() || d.uom,
            lengthReqByUs: '',
            makeRequiredByUs: String((fromLineItem && fromLineItem.makeRequiredByUs) || '').trim() || d.makeRequired,
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
        let normalized = normalizeQuotation(rawQuotation);
        if (!normalized) throw new Error('Could not read quotation details.');

        // Fallback: some API responses may omit lineItems but include tableHTML.
        if (!normalized.lineItems.length && rawQuotation && rawQuotation.tableHTML && typeof window.parseQuotationTableForPdf === 'function') {
            try {
                const rows = window.parseQuotationTableForPdf(rawQuotation.tableHTML);
                const extracted = Array.isArray(rows)
                    ? rows
                        .filter(r => r && (r.type === 'pipe' || r.type === 'item' || r.desc || r.qty))
                        .map((r, idx) => ({
                            slNo: idx + 1,
                            description: String(r.desc || '').trim(),
                            productSpec: String(r.desc || '').trim(), // best-effort; user can edit
                            quantity: String(r.qty || '').trim(),
                            unit: 'MTRS'
                        }))
                        .filter(li => li.description || li.quantity)
                    : [];
                if (extracted.length) {
                    normalized = { ...normalized, lineItems: extracted };
                    __dbg('H10', 'enquiry-preparer.js:populateEnquiryTableFromQuotation', 'used tableHTML fallback', { count: extracted.length });
                } else {
                    __dbg('H10', 'enquiry-preparer.js:populateEnquiryTableFromQuotation', 'tableHTML fallback empty', {});
                }
            } catch (e) {
                __dbg('H10', 'enquiry-preparer.js:populateEnquiryTableFromQuotation', 'tableHTML fallback error', { message: String(e && e.message || e || '') });
            }
        }

        if (!normalized.lineItems.length) throw new Error('Quotation found, but it has no line items.');

        // #region agent log
        __dbg('H9', 'enquiry-preparer.js:populateEnquiryTableFromQuotation', 'normalized line items', {
            quoteNumber: String(normalized.quoteNumber || ''),
            lineItemCount: normalized.lineItems.length,
            first: normalized.lineItems[0]
                ? {
                    hasDesc: !!String(normalized.lineItems[0].description || '').trim(),
                    hasQty: !!String(normalized.lineItems[0].quantity || '').trim(),
                    productSpec: String(normalized.lineItems[0].productSpec || '').slice(0, 60)
                }
                : null
        });
        // #endregion

        clearEnquiryTable();
        normalized.lineItems.forEach(li => {
            addEnquiryRowToTable(buildEnquiryRowModel(li));
        });
        renumberEnquiryRows();

        // #region agent log
        __dbg('H9', 'enquiry-preparer.js:populateEnquiryTableFromQuotation', 'table populated', {
            rowCount: getEnquiryTbody() ? getEnquiryTbody().querySelectorAll('tr').length : null
        });
        // #endregion
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
        const inferredSpec = inferProductSpecFromText(row.productSpec, row.size);
        const productSpec = String(row.productSpec || '').trim() || inferredSpec;
        return {
            productSpec,
            size: String(row.size || '').trim(),
            qty: String(row.qty || '').trim(),
            uom: String(row.uom || '').trim() || d.uom,
            lengthReqByUs: String(row.lengthReqByUs || '').trim(),
            makeRequiredByUs: String(row.makeRequiredByUs || '').trim() || d.makeRequired,
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
            const cellBase = `border:1px solid #000;padding:8px;background-color:${bg};`;
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

        // ===== Header styling helpers (functions/sub-functions) =====
        const BORDER = 'border:1px solid #000;';
        function th(text, bg, color) {
            return `<th style="background:${bg};color:${color};${BORDER}padding:8px;text-align:center;">${escapeHtml(text)}</th>`;
        }
        function thGroup(text, colspan, bg, color) {
            const background = bg || '#0b4aa2';
            const fg = color || '#fff';
            return `<th colspan="${colspan}" style="background:${background};color:${fg};${BORDER}padding:8px;text-align:center;font-weight:700;">${escapeHtml(text)}</th>`;
        }
        // Requirement headers alternate white/blue. Offer headers alternate green/blue.
        const reqA = { bg: '#ffffff', color: '#0b4aa2' };
        const reqB = { bg: '#0b4aa2', color: '#ffffff' };
        const offA = { bg: '#2e7d32', color: '#ffffff' };
        const offB = { bg: '#ffffff', color: '#2e7d32' };
        const colHeaderRow = [
            th('S. NO', reqA.bg, reqA.color),
            th('PRODUCT & SPECIFICATION', reqB.bg, reqB.color),
            th('SIZE', reqA.bg, reqA.color),
            th('QTY', reqB.bg, reqB.color),
            th('UOM', reqA.bg, reqA.color),
            th('LENGTH REQ BY US', reqB.bg, reqB.color),
            th('MAKE REQUIRED BY US', reqA.bg, reqA.color),
            th('RATE', offA.bg, offA.color),
            th('UOM', offB.bg, offB.color),
            th('MAKE OFFERED BY YOU', offA.bg, offA.color)
        ].join('');

        // #region agent log
        __dbg('H3', 'enquiry-preparer.js:buildEnquiryHtmlForCopy', 'header scheme applied', {
            requirement: 'white/blue alternating',
            offer: 'green/white alternating'
        });
        // #endregion

        return `
            <div style="font-family: Arial, sans-serif; color:#111; font-size:13px;">
                ${headerLines}
                <div style="height:10px;"></div>
                <table cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt;">
                    <thead>
                        <tr>
                            ${thGroup('OUR REQUIREMENT (ENQUIRY)', 7, '#0b4aa2', '#fff')}
                            ${thGroup('YOUR OFFER', 3, '#2e7d32', '#fff')}
                        </tr>
                        <tr>
                            ${colHeaderRow}
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

    // #region agent log
    function __dbg(hypothesisId, location, message, data) {
        fetch('http://127.0.0.1:7704/ingest/401e8f63-b24f-4a79-ac2c-9ba6e0d45a1a', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5f7ab2' },
            body: JSON.stringify({
                sessionId: '5f7ab2',
                runId: 'copy-debug',
                hypothesisId,
                location,
                message,
                data: data || {},
                timestamp: Date.now()
            })
        }).catch(() => { });
        fetch('/api/debug-ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: '5f7ab2',
                runId: 'copy-debug',
                hypothesisId,
                location,
                message,
                data: data || {},
                timestamp: Date.now()
            })
        }).catch(() => { });
    }
    // #endregion

    function copyHtmlWithExecCommand(html, plainTextFallback) {
        // Outlook-friendly fallback: copy selection from DOM.
        const container = document.createElement('div');
        container.setAttribute('contenteditable', 'true');
        container.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
        container.innerHTML = html;
        document.body.appendChild(container);

        // Some editors require the element to be focused for rich copy.
        try { container.focus(); } catch (_) { }

        // Hypothesis H1: execCommand copy succeeds but clipboard lacks text/html → email pastes plain text.
        // We force clipboard payload via a copy handler.
        const onCopy = function (e) {
            try {
                const hasClipboard = !!(e && e.clipboardData);
                if (hasClipboard) {
                    e.clipboardData.setData('text/html', html);
                    e.clipboardData.setData('text/plain', plainTextFallback || '');
                    e.preventDefault();
                }
                __dbg('H1', 'enquiry-preparer.js:copyHtmlWithExecCommand', 'onCopy fired', {
                    hasClipboard,
                    htmlLen: String(html || '').length,
                    hasTable: String(html || '').toLowerCase().includes('<table'),
                    textLen: String(plainTextFallback || '').length
                });
            } catch (err) {
                __dbg('H1', 'enquiry-preparer.js:copyHtmlWithExecCommand', 'onCopy error', { message: String(err && err.message || err || '') });
            }
        };
        document.addEventListener('copy', onCopy, true);

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
        document.removeEventListener('copy', onCopy, true);
        container.remove();
        __dbg('H2', 'enquiry-preparer.js:copyHtmlWithExecCommand', 'execCommand result', { ok });
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

    function getApiBaseUrl() {
        // Mirror index.html logic but without depending on its local-scope const.
        const origin = window.location && window.location.origin;
        return (origin && origin !== 'null' && String(origin).startsWith('http'))
            ? origin + '/api'
            : 'http://127.0.0.1:3000/api';
    }

    async function fetchJson(url) {
        const res = await fetch(url, { method: 'GET' });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
        if (!res.ok) {
            const msg = (json && (json.error || json.message)) || text || (`HTTP ${res.status}`);
            throw new Error(msg);
        }
        return json;
    }

    async function fetchQuotationByNumber(quoteNumber) {
        const api = getApiBaseUrl();
        // Fast path: lookup id, then fetch full quotation with lineItems.
        __dbg('H8', 'enquiry-preparer.js:fetchQuotationByNumber', 'lookup start', { quoteNumber });
        const lookup = await fetchJson(`${api}/quotations/by-number/${encodeURIComponent(quoteNumber)}`);
        if (!lookup || !lookup.found || !lookup.id) {
            __dbg('H8', 'enquiry-preparer.js:fetchQuotationByNumber', 'lookup not found', { quoteNumber });
            return null;
        }
        __dbg('H8', 'enquiry-preparer.js:fetchQuotationByNumber', 'lookup found', { id: String(lookup.id) });
        const full = await fetchJson(`${api}/quotations/${encodeURIComponent(String(lookup.id))}`);
        return full && full.quotation ? full.quotation : null;
    }

    async function createEnquiryFromQuotationNumber() {
        // #region agent log
        __dbg('H7', 'enquiry-preparer.js:createEnquiryFromQuotationNumber', 'enter', {
            hasInput: !!$('enquiryFromQuoteNumber'),
            approvedCount: Array.isArray(window.approvedQuotations) ? window.approvedQuotations.length : null
        });
        // #endregion
        setStatus('enquiryFromQuoteStatus', '', false);
        var quoteInput = $('enquiryFromQuoteNumber');
        var quoteNumber = quoteInput ? String(quoteInput.value || '').trim() : '';

        if (!quoteNumber) {
            setStatus('enquiryFromQuoteStatus', 'Please enter a quotation number.', false);
            // #region agent log
            __dbg('H7', 'enquiry-preparer.js:createEnquiryFromQuotationNumber', 'exit:emptyQuoteNumber', {});
            // #endregion
            return;
        }

        // Prefer already-loaded approvals; otherwise fetch directly from API.
        let match = findByQuotationNumber(quoteNumber);
        if (!match) {
            try {
                setStatus('enquiryFromQuoteStatus', 'Fetching quotation from server...', true);
                match = await fetchQuotationByNumber(quoteNumber);
            } catch (e) {
                setStatus('enquiryFromQuoteStatus', 'Failed to fetch quotation: ' + (e.message || 'Unknown error'), false);
                __dbg('H8', 'enquiry-preparer.js:createEnquiryFromQuotationNumber', 'fetch error', { quoteNumber, message: String(e && e.message || e || '') });
                return;
            }
        }

        if (!match) {
            setStatus('enquiryFromQuoteStatus', 'Quotation not found.', false);
            __dbg('H7', 'enquiry-preparer.js:createEnquiryFromQuotationNumber', 'exit:notFound', { quoteNumber });
            return;
        }

        try {
            populateEnquiryTableFromQuotation(match);
            setStatus('enquiryFromQuoteStatus', 'Enquiry table created from quotation number.', true);
            __dbg('H7', 'enquiry-preparer.js:createEnquiryFromQuotationNumber', 'exit:success', { quoteNumber, usedFetch: !Array.isArray(window.approvedQuotations) || !window.approvedQuotations.length });
        } catch (e) {
            setStatus('enquiryFromQuoteStatus', 'Failed to populate table: ' + (e && e.message ? e.message : 'Unknown error'), false);
            __dbg('H9', 'enquiry-preparer.js:createEnquiryFromQuotationNumber', 'exit:populateError', {
                quoteNumber,
                message: String(e && e.message || e || '')
            });
        }
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
        // #region agent log
        __dbg('H4', 'enquiry-preparer.js:copyEnquiryAsHtml', 'copy start', {
            htmlHasTable: String(html || '').toLowerCase().includes('<table'),
            htmlLen: String(html || '').length,
            textLen: String(text || '').length
        });
        // #endregion
        // IMPORTANT: Some editors ignore programmatic HTML clipboard from the browser.
        // Provide an explicit "copy from rendered preview" fallback by selecting actual DOM nodes.
        let ok = false;
        try {
            // 1) Try execCommand with explicit clipboardData (best for Outlook).
            ok = copyHtmlWithExecCommand(html, text);
        } catch (_) {
            ok = false;
        }
        if (!ok) {
            try {
                // 2) Try ClipboardItem (works for many web editors).
                ok = await copyHtmlToClipboard(html, text);
            } catch (_) {
                ok = false;
            }
        }
        if (!ok) {
            // 3) Last resort: open preview automatically so user can copy manually.
            openEnquiryPreview();
        }
        // #region agent log
        __dbg('H4', 'enquiry-preparer.js:copyEnquiryAsHtml', 'copy done', { ok });
        // #endregion
        if (statusEl) {
            statusEl.textContent = ok
                ? 'Enquiry copied (HTML table).'
                : 'Your email editor is blocking rich paste. Preview opened — copy the table from the preview page.';
            statusEl.style.color = ok ? '#2e7d32' : '#c62828';
        }
    }

    // ===== Preview / Download (email-safe) =====

    function buildEnquiryFullHtmlDocument() {
        const fragment = buildEnquiryHtmlForCopy();
        return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enquiry</title>
</head>
<body style="margin:0;padding:18px;background:#fff;">
  ${fragment}
  <div style="margin-top:14px;color:#666;font-size:12px;font-family:Arial,sans-serif;">
    Tip: Select the table and copy from this preview if your email client blocks rich paste.
  </div>
</body>
</html>
        `.trim();
    }

    function openEnquiryPreview() {
        ensureEnquiryTableHasRow();
        const htmlDoc = buildEnquiryFullHtmlDocument();
        const w = window.open('', '_blank');
        if (!w) {
            setStatus('generatedEnquiryStatus', 'Popup blocked. Please allow popups for preview.', false);
            return;
        }
        w.document.open();
        w.document.write(htmlDoc);
        w.document.close();
        setStatus('generatedEnquiryStatus', 'Preview opened. Copy from the preview if needed.', true);
    }

    function downloadBlob(filename, content, mime) {
        const blob = new Blob([content], { type: mime || 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function downloadEnquiryHtml() {
        ensureEnquiryTableHasRow();
        const htmlDoc = buildEnquiryFullHtmlDocument();
        downloadBlob('enquiry.html', htmlDoc, 'text/html');
        setStatus('generatedEnquiryStatus', 'Downloaded enquiry.html', true);
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

        // #region agent log
        __dbg('H5', 'enquiry-preparer.js:init', 'enquiry UI elements', {
            hasCopyHtmlBtn: !!document.getElementById('copyEnquiryHtmlBtn'),
            hasTable: !!document.getElementById('enquiryTable'),
            hasTbody: !!document.getElementById('enquiryTableBody')
        });
        // #endregion

        window.enquiryPreparer = {
            createEnquiryFromQuotationNumber: createEnquiryFromQuotationNumber,
            createEnquiryFromAiInput: createEnquiryFromAiInput,
            copyEnquiryAsHtml: copyEnquiryAsHtml,
            addManualRow: addManualRow,
            loadRowsFromUploadedCsv: loadRowsFromUploadedCsv
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
