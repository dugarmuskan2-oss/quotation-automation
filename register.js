/**
 * register.js — the in-app Enquiry Register (📊 tool).
 *
 * Live report over every quotation, mirroring the Google-Sheet register layout:
 * quote number, merged enquiry-date cells, per-day totals, STATUS (as per App)
 * + STATUS (Manual), company, contact, prepared by, auto Checked By, Sent By,
 * Sent On, days from received to sent, value — plus the manual workflow
 * columns saved per quote via POST /api/quotations/:id/register-meta.
 *
 * Loads ONE MONTH AT A TIME (?month=YYYY-MM): the month you open is fetched on
 * demand, painted instantly from a per-month localStorage cache on revisits,
 * and refreshed silently in the background. Other months cost nothing until
 * you pick them. The optional Google-Sheet mirror still uses ?days=N.
 */
(function () {
    'use strict';

    var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    var FIRST_YEAR = 2024;      // year dropdown reaches back to the app's first data
    var CACHE_KEY = 'enquiryRegisterCache-v2';
    var CACHE_MONTHS_KEPT = 6;  // bound localStorage size

    // rowsByMonth: 'JUL 26' -> rows[]; loadingMonths guards duplicate fetches.
    var state = { rowsByMonth: {}, month: '', loadingMonths: {} };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Months & years ────────────────────────────────────────────────────────
    // Month + year dropdowns are fixed lists (independent of fetched data), so
    // any month back to FIRST_YEAR can be picked and is lazily loaded.
    function monthLabelOf(date) {
        return MONTHS[date.getMonth()] + ' ' + String(date.getFullYear()).slice(-2);
    }

    // 'JUL 26' -> { monthIndex: 6, year: 2026 } (null if malformed)
    function parseLabel(label) {
        var m = /^([A-Z]{3}) (\d{2})$/.exec(String(label || ''));
        if (!m) return null;
        var monthIndex = MONTHS.indexOf(m[1]);
        if (monthIndex === -1) return null;
        return { monthIndex: monthIndex, year: 2000 + parseInt(m[2], 10) };
    }

    // The viewer's LOCAL month edges as ISO instants — sent to the server so
    // month boundaries match exactly what the user sees on screen (an enquiry
    // at 2am on the 1st stays in the month the viewer would file it under).
    function monthBoundsOf(label) {
        var p = parseLabel(label);
        if (!p) return null;
        return {
            from: new Date(p.year, p.monthIndex, 1).toISOString(),
            to:   new Date(p.year, p.monthIndex + 1, 1).toISOString(),
        };
    }

    function yearOptions() {
        var out = [];
        for (var y = new Date().getFullYear(); y >= FIRST_YEAR; y--) out.push(y);
        return out;
    }

    // ── Tab switching ─────────────────────────────────────────────────────────
    function hideRegister() {
        var app = $('registerApp');
        var btn = $('mainToolRegisterButton');
        if (app) app.style.display = 'none';
        if (btn) btn.classList.remove('main-tools-button--active');
    }

    // weight-calculator.js exposes these on DOMContentLoaded — wrap them after
    // (listeners fire in registration order, and this script loads later).
    function wrapSwitchers() {
        ['switchToQuotationTab', 'switchToWeightTab', 'switchToEnquiryTab'].forEach(function (name) {
            var original = window[name];
            if (typeof original !== 'function' || original._registerWrapped) return;
            var wrapped = function () {
                original.apply(this, arguments);
                hideRegister();
            };
            wrapped._registerWrapped = true;
            window[name] = wrapped;
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wrapSwitchers);
    } else {
        wrapSwitchers();
    }

    function switchToRegisterTab() {
        ['quotationApp', 'weightCalculatorApp', 'enquiryPreparerApp'].forEach(function (id) {
            var el = $(id);
            if (el) el.style.display = 'none';
        });
        ['mainToolQuotationButton', 'mainToolWeightButton', 'mainToolEnquiryButton'].forEach(function (id) {
            var el = $(id);
            if (el) el.classList.remove('main-tools-button--active');
        });
        var app = $('registerApp');
        var btn = $('mainToolRegisterButton');
        if (app) app.style.display = '';
        if (btn) btn.classList.add('main-tools-button--active');
        if (!state.month) state.month = monthLabelOf(new Date());
        openMonth(state.month);
    }

    // ── Data ──────────────────────────────────────────────────────────────────
    function apiBase() {
        var origin = window.location.origin;
        return (origin && origin !== 'null' && origin.indexOf('http') === 0) ? origin + '/api' : 'http://localhost:3001/api';
    }

    function readCache() {
        try {
            var parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            return (parsed && parsed.months && typeof parsed.months === 'object') ? parsed : { months: {} };
        } catch (e) { return { months: {} }; }
    }

    function writeCacheMonth(label, rows) {
        try {
            var cache = readCache();
            cache.months[label] = { rows: rows, savedAt: new Date().toISOString() };
            // Trim to the most recently saved months so the cache stays small.
            var labels = Object.keys(cache.months)
                .sort(function (a, b) { return cache.months[a].savedAt < cache.months[b].savedAt ? 1 : -1; })
                .slice(0, CACHE_MONTHS_KEPT);
            var trimmed = {};
            labels.forEach(function (key) { trimmed[key] = cache.months[key]; });
            localStorage.setItem(CACHE_KEY, JSON.stringify({ months: trimmed }));
        } catch (e) { /* cache is best-effort */ }
    }

    // Open a month: paint instantly from memory/cache when possible, then
    // (or otherwise) fetch it fresh in the background.
    function openMonth(label) {
        state.month = label;
        var cachedEntry = !state.rowsByMonth[label] && readCache().months[label];
        if (cachedEntry) state.rowsByMonth[label] = cachedEntry.rows;
        render();
        if (state.rowsByMonth[label]) {
            var meta = $('registerMeta');
            if (meta && !state.loadingMonths[label]) meta.textContent += ' · updating…';
        }
        fetchMonth(label);
    }

    function fetchMonth(label) {
        if (state.loadingMonths[label]) return;
        var bounds = monthBoundsOf(label);
        if (!bounds) return;
        state.loadingMonths[label] = true;
        fetch(apiBase() + '/enquiry-register?from=' + encodeURIComponent(bounds.from) + '&to=' + encodeURIComponent(bounds.to))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var rows = Array.isArray(data.rows) ? data.rows : [];
                state.rowsByMonth[label] = rows;
                writeCacheMonth(label, rows);
                if (state.month === label) render();
            })
            .catch(function (err) {
                console.error('Register month load failed:', err);
                if (state.month === label && !state.rowsByMonth[label]) {
                    var container = $('registerTableContainer');
                    if (container) container.innerHTML = '<p style="text-align:center; color:#c62828; padding:24px;">Could not load the register. Check the server and try Refresh.</p>';
                }
            })
            .finally(function () { state.loadingMonths[label] = false; });
    }

    function refresh() { delete state.rowsByMonth[state.month]; openMonth(state.month); }
    function setMonth(label) { openMonth(label); }

    // Read the two dropdowns and open that month.
    function pickMonthYear() {
        var monthSelect = $('registerMonthSelect');
        var yearSelect = $('registerYearSelect');
        if (!monthSelect || !yearSelect) return;
        var label = monthLabelOf(new Date(parseInt(yearSelect.value, 10), parseInt(monthSelect.value, 10), 1));
        openMonth(label);
    }

    // ── Formatting ────────────────────────────────────────────────────────────
    function fmtDay(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.getDate() + '.' + (d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(-2);
    }

    function fmtValue(v) {
        var n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
        return isFinite(n) && n > 0 ? '₹' + n.toLocaleString('en-IN') : '';
    }

    // Whole days between enquiry received and quote sent ('' until sent).
    function daysBetween(enquiryIso, sentIso) {
        if (!enquiryIso || !sentIso) return '';
        var a = new Date(enquiryIso), b = new Date(sentIso);
        if (isNaN(a.getTime()) || isNaN(b.getTime())) return '';
        // Compare calendar days, not raw hours, so same-day sends show 0.
        var dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate());
        var dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate());
        return String(Math.round((dayB - dayA) / 86400000));
    }

    function statusPillHtml(status) {
        var cls = { 'SENT': 'q-sent', 'REVISION SENT': 'q-revised', 'REGRET': 'q-regretted', 'MARGIN ALLOCATION PENDING': 'q-awaiting', 'PENDING': 'q-new' }[status] || 'q-new';
        return '<span class="q-pill ' + cls + '">' + esc(status) + '</span>';
    }

    // ── Manual workflow fields ────────────────────────────────────────────────
    function saveMeta(rowId, field, value, cellEl) {
        var rows = state.rowsByMonth[state.month] || [];
        var row = rows.filter(function (r) { return String(r.id) === String(rowId); })[0];
        if (row) {
            row.registerMeta = row.registerMeta || {};
            row.registerMeta[field] = value;
        }
        var meta = {};
        meta[field] = value;
        fetch(apiBase() + '/quotations/' + encodeURIComponent(rowId) + '/register-meta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registerMeta: meta })
        })
            .then(function (r) {
                if (!r.ok) throw new Error('save failed');
                writeCacheMonth(state.month, rows);   // typed values survive into the instant paint
                flashSaved(cellEl);
            })
            .catch(function (err) {
                console.error('Register field save failed:', err);
                alert('Could not save that field — check the connection and try again.');
            });
    }

    function flashSaved(cellEl) {
        if (!cellEl) return;
        var tick = document.createElement('span');
        tick.className = 'reg-saved';
        tick.textContent = '✓';
        cellEl.appendChild(tick);
        setTimeout(function () { tick.remove(); }, 1500);
    }

    function textCell(row, field, width) {
        var value = (row.registerMeta && row.registerMeta[field]) || '';
        return '<td><input type="text" value="' + esc(value) + '"' + (width ? ' style="width:' + width + 'px;"' : '')
            + ' onchange="enquiryRegister.saveField(\'' + esc(String(row.id)) + '\',\'' + field + '\',this.value,this.parentElement)"></td>';
    }

    function ynCell(row, field) {
        var value = (row.registerMeta && row.registerMeta[field]) || '';
        function opt(v, label) { return '<option value="' + v + '"' + (value === v ? ' selected' : '') + '>' + label + '</option>'; }
        return '<td><select onchange="enquiryRegister.saveField(\'' + esc(String(row.id)) + '\',\'' + field + '\',this.value,this.parentElement)">'
            + opt('', '—') + opt('Y', 'Y') + opt('N', 'N') + '</select></td>';
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        var picked = parseLabel(state.month) || { monthIndex: new Date().getMonth(), year: new Date().getFullYear() };
        var monthSelect = $('registerMonthSelect');
        if (monthSelect) {
            monthSelect.innerHTML = MONTHS.map(function (name, i) {
                return '<option value="' + i + '"' + (i === picked.monthIndex ? ' selected' : '') + '>' + name + '</option>';
            }).join('');
        }
        var yearSelect = $('registerYearSelect');
        if (yearSelect) {
            yearSelect.innerHTML = yearOptions().map(function (y) {
                return '<option value="' + y + '"' + (y === picked.year ? ' selected' : '') + '>' + y + '</option>';
            }).join('');
        }

        var container = $('registerTableContainer');
        var meta = $('registerMeta');
        var monthRows = state.rowsByMonth[state.month];

        if (!monthRows) {
            if (meta) meta.textContent = '';
            if (container) container.innerHTML = '<p style="text-align:center; color:#999; padding:24px;">Loading ' + esc(state.month) + '…</p>';
            return;
        }

        var rows = monthRows.slice().sort(function (a, b) { return a.enquiryDate < b.enquiryDate ? -1 : 1; });

        var perDay = {};
        rows.forEach(function (r) { var day = fmtDay(r.enquiryDate); perDay[day] = (perDay[day] || 0) + 1; });

        if (meta) meta.textContent = rows.length + ' enquiries in ' + (state.month || '—');

        if (!container) return;
        if (!rows.length) {
            container.innerHTML = '<p style="text-align:center; color:#999; padding:24px;">No enquiries in this month.</p>';
            return;
        }

        var h = '<table class="reg-table"><thead><tr>'
            + '<th>Quotation No</th><th>Enquiry Date</th><th>Per day</th>'
            + '<th>Status (as per App)</th><th>Status (Manual)</th>'
            + '<th>Company</th><th>Contact</th><th>Prepared By</th>'
            + '<th>Checked By</th><th>Sent By</th><th>Sent On</th>'
            + '<th>Days: Recd → Sent</th><th class="r">Value</th>'
            + '<th>BIGIN (Y/N)</th><th>Phone checked</th><th>Email checked</th>'
            + '</tr></thead><tbody>';
        var prevDay = null;
        rows.forEach(function (r) {
            var day = fmtDay(r.enquiryDate);
            h += '<tr>'
                + '<td><b>' + esc(r.quoteNumber || '—') + '</b></td>';
            // Merge the Enquiry Date + Per day cells across rows of the same day
            // (rowspan on the first row, like the merged cells in the sheet).
            if (day !== prevDay) {
                h += '<td class="reg-merged" rowspan="' + perDay[day] + '">' + esc(day) + '</td>'
                    + '<td class="reg-merged reg-day" rowspan="' + perDay[day] + '">' + perDay[day] + '</td>';
                prevDay = day;
            }
            h += '<td>' + statusPillHtml(r.status) + '</td>'
                + textCell(r, 'statusManual', 100)
                + '<td>' + esc(r.company) + '</td>'
                + '<td>' + esc(r.contact) + '</td>'
                + '<td>' + esc(r.preparedBy) + '</td>'
                + '<td>' + esc(r.checkedBy || '') + '</td>'
                + textCell(r, 'sentBy', 90)
                + '<td>' + esc(r.sentDate ? fmtDay(r.sentDate) : '') + '</td>'
                + '<td class="reg-day">' + esc(daysBetween(r.enquiryDate, r.sentDate)) + '</td>'
                + '<td class="r">' + esc(fmtValue(r.value)) + '</td>'
                + ynCell(r, 'biginUploaded')
                + ynCell(r, 'phoneCheckedInBigin')
                + ynCell(r, 'emailCheckedInBigin')
                + '</tr>';
        });
        h += '</tbody></table>';
        container.innerHTML = h;
    }

    // ── Expose ────────────────────────────────────────────────────────────────
    window.switchToRegisterTab = switchToRegisterTab;
    window.enquiryRegister = { refresh: refresh, setMonth: setMonth, pickMonthYear: pickMonthYear, saveField: saveMeta, _state: state };
})();
