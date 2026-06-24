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
        if (!stateById[id]) stateById[id] = { rows: seedRows(q), split: false };
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
            + '.fwe-addfreight{border:1px solid #85B7EB;background:#E6F1FB;border-radius:8px;padding:12px;margin-top:14px;color:#0C447C;font-size:13px;}';
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
            + '<input type="number" class="fwe-ed" data-id="' + r.id + '" data-f="qty" value="' + r.qty + '" style="text-align:right;">'
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
        var html = '<div class="fwe-note">Calculation aid — adjust qty / kg-m to size freight. Not saved to the quote yet (coming in the next slice).</div>';
        html += sectionHtml(st, 1);
        if (st.split) html += sectionHtml(st, 2);
        html += '<div class="fwe-addfreight"><strong>Add freight to quote</strong> — wiring to the quote total (Line item / FOR) lands in the next slice.</div>';
        mountEl.innerHTML = html;
        bind(q, mountEl);
    }

    function findRow(st, id) {
        for (var i = 0; i < st.rows.length; i++) if (st.rows[i].id === id) return st.rows[i];
        return null;
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
