// Freight tab — weight editor (Phase 3, slice 1)
// Self-contained module: renders an editable weight panel inside a quote card's
// Freight tab, seeded from that quote's line items. Supports edit (qty / kg-m),
// add/delete rows, a Total weight line, Print, and splitting into two shipments
// with a drag handle. This slice is a CALCULATION AID — it does not yet persist
// back to the quote (that, plus the Add-freight box, is slice 2). State is kept in
// a module-level map keyed by quote id (never written to the saved quotation).

(function () {
    'use strict';

    var seq = 1;
    var stateById = {};
    var dragId = null;

    function num(v) {
        var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
        return isFinite(n) ? n : 0;
    }
    function liDesc(li) { return li.originalDescription || li.description || ''; }
    function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
    function fmt(n) { return Math.round(n).toLocaleString('en-IN'); }

    function seedRows(q) {
        var items = Array.isArray(q.lineItems) ? q.lineItems : [];
        return items.map(function (li) {
            return {
                id: (li.lineItemId ? String(li.lineItemId) : ('w' + (seq++))),
                d: liDesc(li),
                qty: num(li.quantity),
                kgm: num(li.kgPerMeter),
                sec: 1
            };
        });
    }
    function getState(q) {
        var id = String(q.id);
        if (!stateById[id]) stateById[id] = { rows: seedRows(q), split: false, freight: { amount: '', method: 'line', applied: '' } };
        if (!stateById[id].freight) stateById[id].freight = { amount: '', method: 'line', applied: '' };
        return stateById[id];
    }
    function weightOf(r) { return r.qty * (r.kgm || 0); }
    function secRows(st, sec) { return st.rows.filter(function (r) { return r.sec === sec; }); }
    function secWeight(st, sec) {
        return secRows(st, sec).reduce(function (s, r) { return s + weightOf(r); }, 0);
    }

    function injectStylesOnce() {
        if (document.getElementById('fwe-styles')) return;
        var css = ''
            + '.fwe-note{font-size:12px;color:#854F0B;background:#FAEEDA;border-radius:8px;padding:7px 10px;margin-bottom:10px;}'
            + '.fwe-grid{display:grid;grid-template-columns:22px 1fr 64px 64px 78px 28px;gap:8px;align-items:center;}'
            + '.fwe-row{padding:5px 0;border-top:1px solid #eee;}'
            + '.fwe-row.miss{background:#FCEBEB;border-radius:6px;}'
            + '.fwe-row input{height:30px;padding:4px 7px;width:100%;box-sizing:border-box;}'
            + '.fwe-handle{cursor:grab;color:#9b988e;display:flex;align-items:center;justify-content:center;font-size:16px;}'
            + '.fwe-handle:active{cursor:grabbing;}'
            + '.fwe-drop{border:1px solid #ececec;border-radius:8px;padding:10px 12px;margin-top:12px;}'
            + '.fwe-drop.over{border-color:#85B7EB;background:#E6F1FB;}'
            + '.fwe-foot{margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}'
            + '.fwe-btn{font-size:13px;padding:6px 11px;border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fff;cursor:pointer;}'
            + '.fwe-btn:hover{background:#f6f5f1;}'
            + '.fwe-link{background:none;border:none;color:#185FA5;text-decoration:underline;cursor:pointer;font-size:13px;padding:0;}'
            + '.fwe-del{background:#FCEBEB;color:#A32D2D;border:1px solid #F09595;border-radius:6px;width:24px;height:24px;padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center;}'
            + '.fwe-total{font-weight:600;font-size:13px;border-top:1px solid rgba(0,0,0,.18);margin-top:3px;padding-top:7px;}'
            + '.fwe-addfreight{border:1px solid #85B7EB;background:#E6F1FB;border-radius:8px;padding:12px;margin-top:14px;color:#0C447C;font-size:13px;}'
            + '.fwe-famt{height:32px;padding:4px 8px;border:1px solid rgba(0,0,0,.25);border-radius:6px;}'
            + '.fwe-fmethod{font-size:13px;padding:6px 11px;border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fff;color:#20201d;cursor:pointer;}'
            + '.fwe-fmethod.on{background:#185FA5;color:#fff;border-color:#185FA5;}'
            + '.fwe-fapply{font-size:13px;padding:7px 13px;border:none;border-radius:8px;background:#185FA5;color:#fff;cursor:pointer;}';
        var st = document.createElement('style');
        st.id = 'fwe-styles';
        st.textContent = css;
        document.head.appendChild(st);
    }

    function gridHead() {
        return '<div class="fwe-grid" style="font-size:12px;color:#9b988e;padding-bottom:2px;">'
            + '<div></div><div>Item</div><div style="text-align:right;">Qty</div>'
            + '<div style="text-align:right;">kg/m</div><div style="text-align:right;">Weight</div><div></div></div>';
    }
    function rowHtml(st, r) {
        var miss = !r.kgm;
        var w = miss ? '<span style="color:#A32D2D;font-size:11px;">not counted</span>'
            : (fmt(weightOf(r)) + ' kg');
        var handle = st.split
            ? '<span class="fwe-handle" draggable="true" data-id="' + r.id + '" title="Drag to the other shipment">&#8942;&#8942;</span>'
            : '<span></span>';
        return '<div class="fwe-row fwe-grid' + (miss ? ' miss' : '') + '" data-id="' + r.id + '">'
            + handle
            + '<input type="text" class="fwe-ed" data-id="' + r.id + '" data-f="d" value="' + esc(r.d) + '">'
            + '<input type="number" class="fwe-ed" data-id="' + r.id + '" data-f="qty" value="' + r.qty + '" style="text-align:right;background:#f6f5f1;" title="Quantity comes from the quote" readonly>'
            + '<input type="number" class="fwe-ed" data-id="' + r.id + '" data-f="kgm" value="' + (r.kgm || '') + '" placeholder="&mdash;" style="text-align:right;">'
            + '<div style="text-align:right;font-size:13px;">' + w + '</div>'
            + '<button class="fwe-del" data-id="' + r.id + '" title="Delete line" aria-label="Delete line">&times;</button>'
            + '</div>';
    }
    function sectionHtml(st, sec) {
        var rows = secRows(st, sec);
        var title = st.split ? ('Shipment ' + sec) : 'Weight';
        var header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
            + '<span style="font-size:13px;font-weight:600;color:#444;">' + title + ' &middot; ' + fmt(secWeight(st, sec)) + ' kg</span>'
            + (sec === 2 ? '<button class="fwe-link fwe-merge">Remove &middot; items go back</button>' : '') + '</div>';
        var body = rows.length ? rows.map(function (r) { return rowHtml(st, r); }).join('')
            : '<p style="margin:8px 0;font-size:12px;color:#9b988e;text-align:center;">Drag items here to weigh them separately.</p>';
        var totalRow = rows.length
            ? '<div class="fwe-grid fwe-total"><div></div><div>Total weight</div><div></div><div></div><div style="text-align:right;">' + fmt(secWeight(st, sec)) + ' kg</div><div></div></div>'
            : '';
        var foot = '<div class="fwe-foot"><button class="fwe-link fwe-add" data-sec="' + sec + '">+ Add item</button><span style="margin-left:auto;"></span>'
            + (!st.split ? '<button class="fwe-btn fwe-split">+ Calculate other weight</button>' : '')
            + '<button class="fwe-btn fwe-print" data-sec="' + sec + '">&#128424; Print</button></div>';
        return '<div class="fwe-drop" data-sec="' + sec + '">' + header + gridHead() + body + totalRow + foot + '</div>';
    }

    function render(q, mountEl) {
        injectStylesOnce();
        var st = getState(q);
        var html = '<div class="fwe-note">Adjust kg/m to size freight — kg/m changes save with the quote. Splitting and added rows are for sizing only; qty comes from the quote.</div>';
        html += sectionHtml(st, 1);
        if (st.split) html += sectionHtml(st, 2);
        html += addFreightBoxHtml(q);
        mountEl.innerHTML = html;
        bind(q, mountEl);
    }

    function findRow(st, id) {
        for (var i = 0; i < st.rows.length; i++) if (st.rows[i].id === id) return st.rows[i];
        return null;
    }

    // Persist an edited kg/m back to the matching quote line item, and mark the quote
    // unsaved via the app's own handler (kgPerMeter survives Save because
    // extractStructuredLineItemsFromTable preserves it from sourceLineItems).
    function persistKgm(q, r) {
        var items = Array.isArray(q.lineItems) ? q.lineItems : [];
        for (var i = 0; i < items.length; i++) {
            if (String(items[i].lineItemId) === String(r.id)) { items[i].kgPerMeter = r.kgm; break; }
        }
        if (typeof updateQuotationFromApprovalSection === 'function') {
            try { updateQuotationFromApprovalSection(q.id, null); } catch (e) { }
        }
    }

    function addFreightBoxHtml(q) {
        var f = getState(q).freight;
        var forOn = f.method === 'for';
        var status = f.applied
            ? '<div style="margin-top:8px;color:#0F6E56;font-size:13px;">&#10003; ' + f.applied + '</div>'
            : '<div style="margin-top:8px;font-size:11px;color:#0C447C;">Adds freight to the quote total (see the Quote tab). FOR folds it into the rates so it is hidden on the PDF.</div>';
        return '<div class="fwe-addfreight">'
            + '<div style="font-weight:600;margin-bottom:8px;">Add freight to quote</div>'
            + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
            + '<span>Total Rs</span><input type="number" class="fwe-famt" value="' + (f.amount || '') + '" style="width:110px;">'
            + '<span style="font-size:12px;">as</span>'
            + '<button class="fwe-fmethod ' + (forOn ? '' : 'on') + '" data-m="line">Line item</button>'
            + '<button class="fwe-fmethod ' + (forOn ? 'on' : '') + '" data-m="for">FOR &middot; hidden on PDF</button>'
            + '<button class="fwe-fapply" style="margin-left:auto;">Add freight</button>'
            + '</div>' + status + '</div>';
    }

    // Drive the live freight engine on the Quote tab from the Freight tab box.
    function applyAddFreightToQuote(q, amount, method) {
        var fc = document.getElementById('folder-content-' + q.id);
        if (!fc) return { ok: false, msg: 'Open the quote card first.' };
        var freightRow = fc.querySelector('.freight-row');
        if (freightRow && freightRow.classList.contains('freight-distributed')) {
            return { ok: false, msg: 'Freight already applied as FOR — undo it on the Quote tab first.' };
        }
        if (!freightRow && typeof addFreightRowApproval === 'function') {
            addFreightRowApproval(q.id);
            freightRow = fc.querySelector('.freight-row');
        }
        if (!freightRow) return { ok: false, msg: 'Could not add a freight row.' };
        var input = freightRow.querySelector('.freight-amount-input[data-field="lineTotal"]');
        if (input) {
            input.value = String(amount);
            input.setAttribute('value', String(amount));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (typeof recalculateApprovalQuotationTotals === 'function') recalculateApprovalQuotationTotals(q.id, false);
        if (method === 'for' && typeof applyFreightForApproval === 'function') applyFreightForApproval(q.id, freightRow.id);
        if (typeof updateQuotationFromApprovalSection === 'function') {
            try { updateQuotationFromApprovalSection(q.id, null); } catch (e) { }
        }
        return { ok: true };
    }

    function bind(q, mountEl) {
        var st = getState(q);
        mountEl.querySelectorAll('.fwe-ed').forEach(function (inp) {
            inp.onchange = function () {
                var r = findRow(st, inp.getAttribute('data-id'));
                if (!r) return;
                var f = inp.getAttribute('data-f');
                if (f === 'd') r.d = inp.value;
                else r[f] = num(inp.value);
                if (f === 'kgm') persistKgm(q, r);
                render(q, mountEl);
            };
        });
        mountEl.querySelectorAll('.fwe-add').forEach(function (b) {
            b.onclick = function () {
                st.rows.push({ id: 'w' + (seq++), d: 'New item', qty: 0, kgm: 0, sec: num(b.getAttribute('data-sec')) || 1 });
                render(q, mountEl);
            };
        });
        mountEl.querySelectorAll('.fwe-del').forEach(function (b) {
            b.onclick = function () {
                var id = b.getAttribute('data-id');
                st.rows = st.rows.filter(function (r) { return r.id !== id; });
                render(q, mountEl);
            };
        });
        var split = mountEl.querySelector('.fwe-split');
        if (split) split.onclick = function () { st.split = true; render(q, mountEl); };
        var merge = mountEl.querySelector('.fwe-merge');
        if (merge) merge.onclick = function () {
            st.rows.forEach(function (r) { r.sec = 1; });
            st.split = false; render(q, mountEl);
        };
        mountEl.querySelectorAll('.fwe-print').forEach(function (b) {
            b.onclick = function () { printWeights(q, st, num(b.getAttribute('data-sec')) || 1); };
        });
        // Drag handles -> drop zones
        mountEl.querySelectorAll('.fwe-handle').forEach(function (h) {
            h.addEventListener('dragstart', function () { dragId = h.getAttribute('data-id'); });
            h.addEventListener('dragend', function () { dragId = null; });
        });
        mountEl.querySelectorAll('.fwe-drop').forEach(function (zone) {
            zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
            zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
            zone.addEventListener('drop', function (e) {
                e.preventDefault(); zone.classList.remove('over');
                if (!dragId) return;
                var r = findRow(st, dragId);
                if (r) r.sec = num(zone.getAttribute('data-sec')) || 1;
                dragId = null;
                render(q, mountEl);
            });
        });

        // Add-freight box
        var f = st.freight;
        var amt = mountEl.querySelector('.fwe-famt');
        if (amt) amt.onchange = function () { f.amount = num(amt.value); };
        mountEl.querySelectorAll('.fwe-fmethod').forEach(function (b) {
            b.onclick = function () { f.method = b.getAttribute('data-m'); render(q, mountEl); };
        });
        var applyBtn = mountEl.querySelector('.fwe-fapply');
        if (applyBtn) applyBtn.onclick = function () {
            var box = mountEl.querySelector('.fwe-famt');
            var value = num(box ? box.value : f.amount);
            if (!value || value <= 0) { f.applied = ''; applyBtn.textContent = 'Enter an amount'; return; }
            f.amount = value;
            var res = applyAddFreightToQuote(q, value, f.method);
            f.applied = res.ok
                ? ('Added Rs ' + fmt(value) + ' as ' + (f.method === 'for' ? 'FOR' : 'line item') + ' — see the Quote tab total.')
                : res.msg;
            render(q, mountEl);
        };
    }

    function printWeights(q, st, sec) {
        var rows = secRows(st, sec);
        var label = st.split ? ('Shipment ' + sec) : 'Weight';
        var name = [(q.companyName || q.projectName || ''), (q.quoteNumber || '')].filter(Boolean).join(' · ');
        var body = rows.map(function (r) {
            return '<tr><td style="padding:6px 4px;border-bottom:1px solid #eee;">' + (r.d || '') + '</td>'
                + '<td style="text-align:right;padding:6px 4px;border-bottom:1px solid #eee;">' + r.qty + '</td>'
                + '<td style="text-align:right;padding:6px 4px;border-bottom:1px solid #eee;">' + (r.kgm || '—') + '</td>'
                + '<td style="text-align:right;padding:6px 4px;border-bottom:1px solid #eee;">' + (r.kgm ? fmt(weightOf(r)) + ' kg' : '—') + '</td></tr>';
        }).join('');
        var win = window.open('', '_blank', 'width=720,height=820');
        if (!win) return;
        win.document.write('<html><head><title>Weight — ' + name + '</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#20201d;">'
            + '<h2 style="margin:0 0 4px;">Weight summary</h2><p style="margin:0 0 8px;color:#666;font-size:13px;">' + name + '</p>'
            + '<h3 style="font-size:15px;margin:16px 0 6px;">' + label + ' &mdash; ' + fmt(secWeight(st, sec)) + ' kg</h3>'
            + '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>'
            + '<th style="text-align:left;border-bottom:1px solid #999;padding:6px 4px;">Item</th>'
            + '<th style="text-align:right;border-bottom:1px solid #999;padding:6px 4px;">Qty (m)</th>'
            + '<th style="text-align:right;border-bottom:1px solid #999;padding:6px 4px;">kg/m</th>'
            + '<th style="text-align:right;border-bottom:1px solid #999;padding:6px 4px;">Weight</th></tr></thead><tbody>'
            + body + '</tbody></table><p style="margin-top:20px;color:#888;font-size:12px;">DSC Pipes</p></body></html>');
        win.document.close(); win.focus(); win.print();
    }

    window.renderFreightWeightEditor = function (quotation, mountEl) {
        if (!quotation || !mountEl) return;
        try { render(quotation, mountEl); }
        catch (e) { mountEl.innerHTML = '<div style="padding:16px;color:#c62828;">Weight editor failed to load.</div>'; console.error('FWE render error', e); }
    };
})();
