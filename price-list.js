/**
 * price-list.js — the in-app Price List (💰 tool): ERW / GI / Seamless.
 *
 * The ONE copy of the prices quotes are made from. Editing makes a DRAFT; quotes keep using the
 * LIVE list. The draft is printed, checked, and only "Checked" makes it live (and emails the
 * office). While a list has an unchecked draft, that list's lines on new quotes get no prices.
 *
 * Columns are shown exactly as the list has them — same names, same order. Nothing is added,
 * hidden or renamed; the header row cannot be edited here.
 *
 * Server: routes/priceLists.js. Rules: utils/priceListBook.js.
 */
(function () {
    'use strict';

    var TYPES = [
        { key: 'erw', label: 'ERW' },
        { key: 'gi', label: 'GI' },
        { key: 'seamless', label: 'Seamless' },
    ];

    // view: last server copy. rows: the working copy shown in the table (draft, else live).
    var state = { view: null, loadError: '', type: 'erw', rows: null, dirty: false, busy: '' };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function apiBase() {
        var origin = window.location.origin;
        return (origin && origin !== 'null' && origin.indexOf('http') === 0) ? origin + '/api' : 'http://localhost:3001/api';
    }
    function when(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function list() { return (state.view && state.view.lists[state.type]) || { live: null, draft: null, changes: [] }; }
    function typeLabel(key) { return (TYPES.find(function (t) { return t.key === key; }) || {}).label || key; }
    function cloneRows(rows) { return (rows || []).map(function (r) { return r.slice(); }); }

    // ── Changed cells: the working copy against LIVE, matched by size + class (same key the
    // quote lookup uses), so an inserted row does not mark everything below it as changed. ──────
    function liveCellsByKey() {
        var live = list().live;
        var out = {};
        if (!live || !window.pipeWeights) return out;
        var keyOf = window.pipeWeights.makeRowKeyer(live.rows[0]);
        live.rows.slice(1).forEach(function (r) { var k = keyOf(r); if (k) out[k] = r; });
        return out;
    }

    function cellChange(liveByKey, header, row, c) {
        var live = list().live;
        if (!live || !window.pipeWeights) return null;
        var key = window.pipeWeights.makeRowKeyer(header)(row);
        var before = key ? liveByKey[key] : null;
        if (!before) return { added: true };
        var lc = live.rows[0].indexOf(header[c]);
        var from = lc >= 0 ? String(before[lc] == null ? '' : before[lc]) : '';
        return from !== String(row[c] == null ? '' : row[c]) ? { from: from } : null;
    }

    // ── Loading ──────────────────────────────────────────────────────────────
    function load() {
        state.loadError = '';
        render();
        return fetch(apiBase() + '/price-lists')
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Load failed'); return j; }); })
            .then(function (view) { takeView(view); })
            .catch(function (e) { state.loadError = e.message || String(e); render(); });
    }

    function takeView(view) {
        state.view = view;
        var l = list();
        state.rows = cloneRows((l.draft || l.live || {}).rows);
        state.dirty = false;
        render();
    }

    // ── Server calls (each locked: a second click while one runs does nothing) ──────────────
    function call(label, method, path, body) {
        if (state.busy) return Promise.resolve(null);
        state.busy = label;
        render();
        var payload = Object.assign({ rev: state.view ? state.view.rev : undefined }, body || {});
        return fetch(apiBase() + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); })
            .then(function (view) { state.busy = ''; takeView(view); return view; })
            .catch(function (e) { state.busy = ''; render(); alert(e.message || String(e)); return null; });
    }

    function saveDraft() {
        if (!state.dirty) return;
        flushFocusedCell();
        call('save', 'PUT', '/price-lists/' + state.type + '/draft', { rows: state.rows });
    }

    function discardDraft() {
        if (!confirm('Throw away all unchecked changes to the ' + typeLabel(state.type) + ' list?')) return;
        call('discard', 'DELETE', '/price-lists/' + state.type + '/draft');
    }

    function undoUnsaved() {
        if (!confirm('Undo the changes you have not saved yet?')) return;
        takeView(state.view);
    }

    function markChecked() {
        var name = ($('plCheckedBy') && $('plCheckedBy').value || '').trim();
        if (!name) { alert('Type the name of the person who checked the printed list.'); return; }
        if (!confirm('Make this ' + typeLabel(state.type) + ' list live? New quotes will be priced from it, and info@dscpipes.com will be told.')) return;
        call('check', 'POST', '/price-lists/' + state.type + '/check', { checkedBy: name }).then(function (res) {
            if (!res) return;
            if (res.emailSent === false) {
                alert('The list is now LIVE, but the email to info@dscpipes.com could not be sent:\n' + (res.emailError || '') + '\n\nPlease tell the office yourself.');
            } else {
                alert(typeLabel(state.type) + ' list is now live. info@dscpipes.com has been told.');
            }
        });
    }

    function readFromPdf() {
        var l = list();
        var warn = l.draft ? ' This REPLACES the current unchecked draft.' : '';
        if (!confirm('Read the ' + typeLabel(state.type) + ' list from its PDF? This is one AI run and can take up to a minute.' + warn +
            '\n\nThe result is only a draft: print it and check EVERY price against your sheet before clicking Checked.')) return;
        call('pdf', 'POST', '/price-lists/' + state.type + '/read-pdf');
    }

    // ── Editing the working copy ─────────────────────────────────────────────
    function flushFocusedCell() {
        var el = document.activeElement;
        if (el && el.classList && el.classList.contains('pl-cell')) onCellInput(el);
    }

    function onCellInput(el) {
        var r = +el.getAttribute('data-r'), c = +el.getAttribute('data-c');
        if (!state.rows[r] || state.rows[r][c] === el.value) return;
        state.rows[r][c] = el.value;
        state.dirty = true;
        renderStatus();
        paintCell(el, r, c);
    }

    function paintCell(el, r, c) {
        var ch = cellChange(liveCellsByKey(), state.rows[0], state.rows[r], c);
        el.style.background = ch ? (ch.added ? '#e3f6e3' : '#fff3b0') : '';
        el.title = ch && !ch.added ? 'Was: ' + ch.from : (ch && ch.added ? 'New row' : '');
    }

    function addRow() {
        if (!state.rows) return;
        state.rows.push(state.rows[0].map(function () { return ''; }));
        state.dirty = true;
        render();
    }

    function deleteRow(r) {
        if (!confirm('Delete row ' + r + '?')) return;
        state.rows.splice(r, 1);
        state.dirty = true;
        render();
    }

    function switchList(key) {
        if (key === state.type) return;
        if (state.dirty && !confirm('You have unsaved changes to the ' + typeLabel(state.type) + ' list. Leave them?')) return;
        state.type = key;
        if (state.view) takeView(state.view); else render();
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    function statusHtml() {
        var l = list();
        var parts = [];
        if (l.live) {
            parts.push('<div class="pl-status pl-live">✅ <b>Live</b> — version ' + l.live.version + ', checked by ' + esc(l.live.checkedBy) +
                ' on ' + esc(when(l.live.checkedAt)) + '. New quotes are priced from this.</div>');
        } else {
            parts.push('<div class="pl-status pl-none">⚠️ <b>No live ' + typeLabel(state.type) + ' list yet.</b> ' + typeLabel(state.type) +
                ' lines on new quotes get no prices until a list is checked.</div>');
        }
        if (l.draft) {
            parts.push('<div class="pl-status pl-draft">✏️ <b>Changes waiting to be checked</b> — saved ' + esc(when(l.draft.editedAt)) +
                (l.draft.editedBy ? ' by ' + esc(l.draft.editedBy) : '') + (l.draft.source && l.draft.source !== 'edit' ? ' (' + esc(l.draft.source) + ')' : '') +
                '. ' + l.changes.length + ' change(s). <b>' + typeLabel(state.type) + ' lines on new quotes get NO prices until this is checked.</b></div>');
        }
        if (state.dirty) parts.push('<div class="pl-status pl-unsaved">● Unsaved changes — click <b>Save changes</b>.</div>');
        return parts.join('');
    }

    function renderStatus() {
        var el = $('plStatus');
        if (el) el.innerHTML = statusHtml();
        var save = $('plSaveBtn');
        if (save) save.disabled = !state.dirty || !!state.busy;
        var undo = $('plUndoBtn');
        if (undo) undo.disabled = !state.dirty || !!state.busy;
        var chk = $('plCheckBtn');
        if (chk) chk.disabled = !list().draft || state.dirty || !!state.busy;
        // Print shows the SAVED draft — printing while edits are unsaved would check the wrong copy.
        var print = $('plPrintBtn');
        if (print) print.disabled = !list().draft || state.dirty || !!state.busy;
    }

    function tableHtml() {
        if (!state.rows || !state.rows.length) {
            return '<p class="pl-empty">This list is empty. Use <b>Read from PDF</b> (one time) or upload its Excel/CSV.</p>';
        }
        var header = state.rows[0];
        var liveByKey = liveCellsByKey();
        var head = '<tr><th>#</th>' + header.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '<th></th></tr>';
        var body = state.rows.slice(1).map(function (row, i) {
            var r = i + 1;
            return '<tr><td class="pl-n">' + r + '</td>' + header.map(function (_, c) {
                var ch = cellChange(liveByKey, header, row, c);
                var bg = ch ? (ch.added ? '#e3f6e3' : '#fff3b0') : '';
                var title = ch && !ch.added ? 'Was: ' + ch.from : (ch && ch.added ? 'New row' : '');
                return '<td><input class="pl-cell" data-r="' + r + '" data-c="' + c + '" value="' + esc(row[c]) + '" style="background:' + bg + '" title="' + esc(title) + '"></td>';
            }).join('') + '<td><button type="button" class="pl-del" data-del="' + r + '" title="Delete row">✕</button></td></tr>';
        }).join('');
        return '<div class="pl-table-wrap"><table class="pl-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }

    function render() {
        var app = $('priceListApp');
        if (!app) return;
        if (state.loadError) {
            app.innerHTML = '<h1>💰 Price List</h1><div class="pl-status pl-none">❌ Could not load the price lists: ' + esc(state.loadError) +
                ' <button type="button" class="upload-btn" style="width:auto;padding:5px 12px;" id="plRetry">Try again</button></div>';
            $('plRetry').onclick = load;
            return;
        }
        if (!state.view) { app.innerHTML = '<h1>💰 Price List</h1><p class="pl-empty">Loading price lists…</p>'; return; }
        var l = list();
        var tabs = TYPES.map(function (t) {
            var pending = state.view.lists[t.key].draft ? ' <span class="pl-dot" title="Changes waiting to be checked">●</span>' : '';
            return '<button type="button" class="pl-tab' + (t.key === state.type ? ' pl-tab-on' : '') + '" data-type="' + t.key + '">' + t.label + pending + '</button>';
        }).join('');
        var busy = state.busy ? ' <span class="pl-busy">Working…</span>' : '';
        app.innerHTML =
            '<h1>💰 Price List</h1>' +
            '<div class="pl-tabs">' + tabs + '</div>' +
            '<div id="plStatus">' + statusHtml() + '</div>' +
            '<div class="pl-actions">' +
                '<button type="button" class="upload-btn" id="plSaveBtn">💾 Save changes</button>' +
                '<button type="button" class="upload-btn pl-secondary" id="plUndoBtn">↶ Undo unsaved</button>' +
                '<button type="button" class="upload-btn pl-secondary" id="plAddBtn">➕ Add row</button>' +
                '<button type="button" class="upload-btn pl-secondary" id="plPrintBtn">🖨️ Print for checking</button>' +
                '<button type="button" class="upload-btn pl-secondary" id="plCsvBtn">⬇️ Download Excel (CSV)</button>' +
                (l.draft ? '<button type="button" class="upload-btn pl-danger" id="plDiscardBtn">🗑️ Discard changes</button>' : '') +
                '<button type="button" class="upload-btn pl-secondary" id="plPdfBtn">📄 Read from PDF</button>' +
                busy +
            '</div>' +
            (l.draft ? '<div class="pl-check">After printing and checking every change: <label>Checked By <input id="plCheckedBy" type="text"></label>' +
                '<button type="button" class="upload-btn" id="plCheckBtn">✅ Checked — make live</button></div>' : '') +
            tableHtml();
        wire(app);
        renderStatus();
        ['plAddBtn', 'plCsvBtn', 'plDiscardBtn', 'plPdfBtn'].forEach(function (id) { if ($(id)) $(id).disabled = !!state.busy; });
    }

    function wire(app) {
        app.querySelectorAll('.pl-tab').forEach(function (b) { b.onclick = function () { switchList(b.getAttribute('data-type')); }; });
        app.querySelectorAll('.pl-cell').forEach(function (el) {
            el.addEventListener('input', function () { onCellInput(el); });
        });
        app.querySelectorAll('.pl-del').forEach(function (b) { b.onclick = function () { deleteRow(+b.getAttribute('data-del')); }; });
        if ($('plSaveBtn')) $('plSaveBtn').onclick = saveDraft;
        if ($('plUndoBtn')) $('plUndoBtn').onclick = undoUnsaved;
        if ($('plAddBtn')) $('plAddBtn').onclick = addRow;
        if ($('plPrintBtn')) $('plPrintBtn').onclick = printDraft;
        if ($('plCsvBtn')) $('plCsvBtn').onclick = downloadCsv;
        if ($('plDiscardBtn')) $('plDiscardBtn').onclick = discardDraft;
        if ($('plPdfBtn')) $('plPdfBtn').onclick = readFromPdf;
        if ($('plCheckBtn')) $('plCheckBtn').onclick = markChecked;
    }

    // ── Print: the SAVED draft, changes marked old → new, with a line to sign ─────────────────
    function printDraft() {
        var l = list();
        if (!l.draft) return;
        var rows = l.draft.rows, header = rows[0];
        var liveByKey = liveCellsByKey();
        var body = rows.slice(1).map(function (row) {
            return '<tr>' + header.map(function (_, c) {
                var ch = cellChange(liveByKey, header, row, c);
                if (ch && ch.added) return '<td class="add">' + esc(row[c]) + '</td>';
                if (ch) return '<td class="chg"><s>' + esc(ch.from) + '</s> → <b>' + esc(row[c]) + '</b></td>';
                return '<td>' + esc(row[c]) + '</td>';
            }).join('') + '</tr>';
        }).join('');
        var removed = l.changes.filter(function (c) { return c.kind === 'removed'; });
        var w = window.open('', '_blank');
        if (!w) { alert('Allow pop-ups for this site to print.'); return; }
        w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + typeLabel(state.type) + ' price list — for checking</title>' +
            '<style>body{font-family:Arial,sans-serif;font-size:11px;margin:16px}table{border-collapse:collapse;width:100%}' +
            'th,td{border:1px solid #999;padding:3px 5px;text-align:left}th{background:#eee}.chg{background:#fff3b0}.add{background:#e3f6e3}' +
            '.sign{margin-top:24px;font-size:13px}</style></head><body>' +
            '<h2>' + typeLabel(state.type) + ' price list — changes for checking</h2>' +
            '<p>Saved ' + esc(when(l.draft.editedAt)) + (l.draft.editedBy ? ' by ' + esc(l.draft.editedBy) : '') + '. ' +
            l.changes.length + ' change(s). Yellow = changed (old → new). Green = new row.</p>' +
            (removed.length ? '<p><b>Rows removed:</b> ' + removed.map(function (c) { return esc(c.label || c.key); }).join(', ') + '</p>' : '') +
            '<table><thead><tr>' + header.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table>' +
            '<p class="sign">Checked by: ______________________ &nbsp; Date: ____________ &nbsp; Signature: ______________________</p>' +
            '</body></html>');
        w.document.close();
        w.focus();
        w.print();
    }

    function downloadCsv() {
        if (!state.rows) return;
        var csv = state.rows.map(function (r) {
            return r.map(function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',');
        }).join('\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = typeLabel(state.type) + ' Price List.csv';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }

    // ── Tool-tab switching (register.js / partner-directory.js pattern) ───────────────────────
    var OTHER_APPS = ['quotationApp', 'weightCalculatorApp', 'enquiryPreparerApp', 'registerApp', 'partnerDirectoryApp'];
    var OTHER_BUTTONS = ['mainToolQuotationButton', 'mainToolWeightButton', 'mainToolEnquiryButton', 'mainToolRegisterButton', 'mainToolDirectoryButton'];
    var OTHER_SWITCHERS = ['switchToQuotationTab', 'switchToWeightTab', 'switchToEnquiryTab', 'switchToRegisterTab', 'switchToDirectoryTab'];

    function hidePriceList() {
        if ($('priceListApp')) $('priceListApp').style.display = 'none';
        if ($('mainToolPriceListButton')) $('mainToolPriceListButton').classList.remove('main-tools-button--active');
    }

    function wrapSwitchers() {
        OTHER_SWITCHERS.forEach(function (name) {
            var original = window[name];
            if (typeof original !== 'function' || original._plWrapped) return;
            var wrapped = function () {
                if (state.dirty && !confirm('You have unsaved price-list changes. Leave them?')) return;
                original.apply(this, arguments);
                hidePriceList();
            };
            wrapped._plWrapped = true;
            window[name] = wrapped;
        });
    }

    function switchToPriceListTab() {
        OTHER_APPS.forEach(function (id) { if ($(id)) $(id).style.display = 'none'; });
        OTHER_BUTTONS.forEach(function (id) { if ($(id)) $(id).classList.remove('main-tools-button--active'); });
        if ($('priceListApp')) $('priceListApp').style.display = '';
        if ($('mainToolPriceListButton')) $('mainToolPriceListButton').classList.add('main-tools-button--active');
        if (!state.dirty) load(); else render();
    }

    // Other tools wrap their switchers on DOMContentLoaded too; wrapping after them (load) means
    // ours sits outermost and every tool's switcher hides this page.
    if (document.readyState === 'complete') wrapSwitchers();
    else window.addEventListener('load', wrapSwitchers);
    window.addEventListener('beforeunload', function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

    var CSS = '.pl-tabs{display:flex;gap:6px;margin:8px 0 12px}' +
        '.pl-tab{padding:7px 18px;border:1px solid #ccc;background:#f7f7f5;border-radius:6px;cursor:pointer;font-weight:600}' +
        '.pl-tab-on{background:#1f3a8a;color:#fff;border-color:#1f3a8a}.pl-dot{color:#e67e22}' +
        '.pl-status{padding:9px 12px;border-radius:6px;margin:6px 0;font-size:14px}' +
        '.pl-live{background:#e8f6ec}.pl-none{background:#fde2e2}.pl-draft{background:#fff3b0}.pl-unsaved{background:#ffe0c2}' +
        '.pl-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.pl-actions .upload-btn{width:auto;padding:7px 14px}' +
        '.pl-secondary{background:#6b7280}.pl-danger{background:#c0392b}.pl-busy{color:#888;font-style:italic}' +
        '.pl-check{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px;border:2px solid #2e7d32;border-radius:6px;margin:8px 0}' +
        '.pl-check .upload-btn{width:auto;padding:7px 14px;background:#2e7d32}.pl-check input{padding:5px;margin-left:6px}' +
        '.pl-table-wrap{overflow:auto;max-height:70vh;border:1px solid #ddd}' +
        '.pl-table{border-collapse:collapse;font-size:13px;width:100%}.pl-table th{position:sticky;top:0;background:#eef0f4;padding:6px;border:1px solid #ddd;white-space:nowrap}' +
        '.pl-table td{border:1px solid #eee;padding:0}.pl-cell{width:100%;min-width:60px;border:none;padding:5px;font-size:13px;box-sizing:border-box}' +
        '.pl-n{padding:0 6px!important;color:#999;text-align:right}.pl-del{border:none;background:none;color:#c0392b;cursor:pointer}' +
        '.pl-empty{color:#888;padding:20px;text-align:center}';
    var styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    window.switchToPriceListTab = switchToPriceListTab;
    window.priceListPage = { load: load, _state: state };
})();
