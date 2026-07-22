/**
 * register.js — the in-app Enquiry Register (📊 tool).
 *
 * Live report over every quotation, mirroring the Google-Sheet register layout:
 * quote number, enquiry date, per-day totals, STATUS (REGRET / MARGIN
 * ALLOCATION PENDING / REVISION SENT / SENT / PENDING), company, contact,
 * prepared by — plus the manual workflow columns (Given for checking to,
 * Sent By, BIGIN checks) which are typed HERE and saved onto the quotation
 * via POST /api/quotations/:id/register-meta (Date and Value fill themselves).
 *
 * Reads GET /api/enquiry-register. The optional Google-Sheet mirror
 * (apps-script/EnquiryRegister.gs) reads the same endpoint.
 */
(function () {
    'use strict';

    var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    var REGISTER_DAYS = 180;

    var state = { rows: [], month: '', loaded: false, loading: false };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Tab switching ─────────────────────────────────────────────────────────
    // The other tools' switchers don't know this app exists — wrap them so
    // switching away always hides the register too.
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
        if (!state.loaded) load();
    }

    // ── Data ──────────────────────────────────────────────────────────────────
    function apiBase() {
        var origin = window.location.origin;
        return (origin && origin !== 'null' && origin.indexOf('http') === 0) ? origin + '/api' : 'http://localhost:3001/api';
    }

    function load() {
        if (state.loading) return;
        state.loading = true;
        var container = $('registerTableContainer');
        if (container && !state.loaded) container.innerHTML = '<p style="text-align:center; color:#999; padding:24px;">Loading register…</p>';
        fetch(apiBase() + '/enquiry-register?days=' + REGISTER_DAYS)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                state.rows = Array.isArray(data.rows) ? data.rows : [];
                state.loaded = true;
                if (!state.month || monthOptions().indexOf(state.month) === -1) {
                    state.month = monthOptions()[0] || '';
                }
                render();
            })
            .catch(function (err) {
                console.error('Register load failed:', err);
                if (container) container.innerHTML = '<p style="text-align:center; color:#c62828; padding:24px;">Could not load the register. Check the server and try Refresh.</p>';
            })
            .finally(function () { state.loading = false; });
    }

    function refresh() { state.loaded = false; load(); }
    function setMonth(value) { state.month = value; render(); }

    // ── Formatting ────────────────────────────────────────────────────────────
    function monthKeyOf(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return MONTHS[d.getMonth()] + ' ' + String(d.getFullYear()).slice(-2);
    }

    function monthOptions() {
        var seen = [];
        state.rows.forEach(function (r) {
            var key = monthKeyOf(r.enquiryDate);
            if (key && seen.indexOf(key) === -1) seen.push(key);
        });
        // newest first (rows arrive unsorted; sort keys by their first row date)
        return seen.sort(function (a, b) {
            var da = firstDateOfMonth(a), db = firstDateOfMonth(b);
            return da < db ? 1 : -1;
        });
    }

    function firstDateOfMonth(key) {
        for (var i = 0; i < state.rows.length; i++) {
            if (monthKeyOf(state.rows[i].enquiryDate) === key) return state.rows[i].enquiryDate;
        }
        return '';
    }

    function fmtDay(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.getDate() + '.' + (d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(-2);
    }

    function fmtValue(v) {
        var n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
        return isFinite(n) && n > 0 ? '₹' + n.toLocaleString('en-IN') : '';
    }

    function statusPillHtml(status) {
        var cls = { 'SENT': 'q-sent', 'REVISION SENT': 'q-revised', 'REGRET': 'q-regretted', 'MARGIN ALLOCATION PENDING': 'q-awaiting', 'PENDING': 'q-new' }[status] || 'q-new';
        return '<span class="q-pill ' + cls + '">' + esc(status) + '</span>';
    }

    // ── Manual workflow fields ────────────────────────────────────────────────
    function saveMeta(rowId, field, value, cellEl) {
        var row = state.rows.filter(function (r) { return String(r.id) === String(rowId); })[0];
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
        var select = $('registerMonthSelect');
        if (select) {
            select.innerHTML = monthOptions().map(function (key) {
                return '<option' + (key === state.month ? ' selected' : '') + '>' + esc(key) + '</option>';
            }).join('') || '<option>—</option>';
        }

        var rows = state.rows
            .filter(function (r) { return monthKeyOf(r.enquiryDate) === state.month; })
            .sort(function (a, b) { return a.enquiryDate < b.enquiryDate ? -1 : 1; });

        var perDay = {};
        rows.forEach(function (r) { var day = fmtDay(r.enquiryDate); perDay[day] = (perDay[day] || 0) + 1; });

        var meta = $('registerMeta');
        if (meta) meta.textContent = rows.length + ' enquiries in ' + (state.month || '—');

        var container = $('registerTableContainer');
        if (!container) return;
        if (!rows.length) {
            container.innerHTML = '<p style="text-align:center; color:#999; padding:24px;">No enquiries in this month.</p>';
            return;
        }

        var h = '<table class="reg-table"><thead><tr>'
            + '<th>Quotation No</th><th>Enquiry Date</th><th>Per day</th><th>Status</th><th>Company</th><th>Contact</th><th>Prepared By</th>'
            + '<th>Given for checking to</th><th>Sent By</th><th>Date</th><th class="r">Value</th>'
            + '<th>BIGIN (Y/N)</th><th>Phone checked</th><th>Email checked</th>'
            + '</tr></thead><tbody>';
        rows.forEach(function (r) {
            var day = fmtDay(r.enquiryDate);
            h += '<tr>'
                + '<td><b>' + esc(r.quoteNumber || '—') + '</b></td>'
                + '<td>' + esc(day) + '</td>'
                + '<td class="reg-day">' + perDay[day] + '</td>'
                + '<td>' + statusPillHtml(r.status) + '</td>'
                + '<td>' + esc(r.company) + '</td>'
                + '<td>' + esc(r.contact) + '</td>'
                + '<td>' + esc(r.preparedBy) + '</td>'
                + textCell(r, 'givenForCheckingTo')
                + textCell(r, 'sentBy', 90)
                + '<td>' + esc(r.sentDate ? fmtDay(r.sentDate) : '') + '</td>'
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
    window.enquiryRegister = { refresh: refresh, setMonth: setMonth, saveField: saveMeta, _state: state };
})();
