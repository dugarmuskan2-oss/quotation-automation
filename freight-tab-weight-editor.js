// Freight tab — weight editor + freight sourcing (Phases 3 & 6)
// Self-contained module: renders the whole Freight tab inside a quote card —
// (1) "Calculate weight": editable weight panel seeded from the quote's line items
//     (edit kg/m, add/soft-delete rows, split into two shipments, print);
// (2) "Send freight enquiry": email transporters for a rate (one email each, so
//     each gets its own Gmail thread), then check/read replies and "Use" a price;
// (3) "Add freight to quote": drives the live freight engine on the Quote tab.
// UI state lives in a module-level map keyed by quote id; transporter threads are
// stored on the quotation itself (q.freightEnquiries) so they survive reloads.

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
    function escTxt(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function fmt(n) { return Math.round(n).toLocaleString('en-IN'); }

    // Quantity is null (not 0) when the quote has none — the row shows blank + red so
    // the user fills it in, instead of a silently assumed number.
    function qtyOrNull(v) {
        return (v === undefined || v === null || String(v).trim() === '') ? null : num(v);
    }
    function seedRows(q) {
        var items = Array.isArray(q.lineItems) ? q.lineItems : [];
        return items.map(function (li) {
            return {
                id: (li.lineItemId ? String(li.lineItemId) : ('w' + (seq++))),
                d: liDesc(li),
                type: String(li.identifiedPipeType || ''),
                qty: qtyOrNull(li.quantity),
                kgm: num(li.kgPerMeter),
                sec: 1
            };
        });
    }
    function getState(q) {
        var id = String(q.id);
        if (!stateById[id]) stateById[id] = { rows: seedRows(q), split: false, weightOpen: false, freight: { amount: '', amtA: '', amtB: '', method: 'line', applied: '' } };
        if (!stateById[id].freight) stateById[id].freight = { amount: '', amtA: '', amtB: '', method: 'line', applied: '' };
        if (!stateById[id].enquiry) stateById[id].enquiry = { open: false, forSec: 0, to: [], pickup: '', drop: '', message: '', messageEdited: false, weightOverride: null, sending: false, sent: '', checking: false, checkResult: '', openReplies: {} };
        return stateById[id];
    }
    function weightOf(r) { return (r.qty || 0) * (r.kgm || 0); }
    function secRows(st, sec) { return st.rows.filter(function (r) { return r.sec === sec; }); }
    function secWeight(st, sec) {
        return secRows(st, sec).filter(function (r) { return !r.removed; }).reduce(function (s, r) { return s + weightOf(r); }, 0);
    }
    // Weight tolerance (7% under) applies to welded pipe (ERW / GI) but NOT to seamless,
    // which is billed at exact weight. Type comes from the line's pipe type, falling back
    // to the description (seamless carries "SCH"/"seamless"; welded carries "-- GI"/"-- ERW").
    function rowIsSeamless(r) {
        var s = (String((r && r.type) || '') + ' ' + String((r && r.d) || '')).toLowerCase();
        if (/seamless|smls/.test(s)) return true;
        if (/--\s*(gi|erw)\b/.test(s)) return false;
        return /\bsch\b|schedule/.test(s);
    }
    // Section weight with the 7% deducted from the welded part only (seamless kept whole).
    function secToleranceWeight(st, sec) {
        return secRows(st, sec).filter(function (r) { return !r.removed; })
            .reduce(function (s, r) { return s + weightOf(r) * (rowIsSeamless(r) ? 1 : 0.93); }, 0);
    }
    // Only show a tolerance line when the section actually has welded (ERW/GI) weight.
    function secHasTolerance(st, sec) {
        return secRows(st, sec).some(function (r) { return !r.removed && !rowIsSeamless(r) && weightOf(r) > 0; });
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
            + '.fwe-subtotal{font-size:12px;color:#6e6c65;padding-top:2px;}'
            + '.fwe-addbtn{width:28px;height:28px;border-radius:6px;border:1px solid #85B7EB;background:#E6F1FB;color:#0C447C;font-size:18px;line-height:1;cursor:pointer;font-weight:600;padding:0;}'
            + '.fwe-addbtn:hover{background:#d5e8fb;}'
            + '.fwe-addfreight{border:1px solid #85B7EB;background:#E6F1FB;border-radius:8px;padding:12px;margin-top:14px;color:#0C447C;font-size:13px;}'
            + '.fwe-famt{height:32px;padding:4px 8px;border:1px solid rgba(0,0,0,.25);border-radius:6px;}'
            + '.fwe-fmethod{font-size:13px;padding:6px 11px;border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fff;color:#20201d;cursor:pointer;}'
            + '.fwe-fmethod.on{background:#185FA5;color:#fff;border-color:#185FA5;}'
            + '.fwe-fapply{font-size:13px;padding:7px 13px;border:none;border-radius:8px;background:#185FA5;color:#fff;cursor:pointer;}'
            + '.fwe-wt{border:1px solid #e0ddd4;border-radius:8px;overflow:hidden;}'
            + '.fwe-wt-toggle{width:100%;display:flex;align-items:center;gap:8px;background:#f6f5f1;border:none;padding:10px 12px;cursor:pointer;font-size:14px;font-weight:600;color:#20201d;}'
            + '.fwe-wt-toggle:hover{background:#efeee9;}'
            + '.fwe-wt-body{padding:12px;}'
            + '.fwe-enq{margin-top:14px;border:1px solid #e0ddd4;border-radius:8px;overflow:hidden;}'
            + '.fwe-enq-toggle{width:100%;display:flex;align-items:center;gap:8px;background:#f6f5f1;border:none;padding:10px 12px;cursor:pointer;font-size:14px;font-weight:600;color:#20201d;}'
            + '.fwe-enq-toggle:hover{background:#efeee9;}'
            + '.fwe-enq-body{padding:12px;}'
            + '.fwe-enq-field{position:relative;border:1px solid rgba(0,0,0,.2);border-radius:8px;padding:5px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#fff;}'
            + '.fwe-enq-input{flex:1;min-width:150px;border:none;outline:none;height:26px;font-size:13px;padding:2px 4px;background:transparent;}'
            + '.fwe-chip{display:inline-flex;align-items:center;gap:5px;background:#E6F1FB;color:#0C447C;border-radius:14px;padding:3px 9px;font-size:12px;}'
            + '.fwe-chip.fwe-chip-bad{background:#FCEBEB;color:#A32D2D;}'
            + '.fwe-chip-x{cursor:pointer;font-weight:700;line-height:1;}'
            + '.fwe-enq-lbl{font-size:12px;color:#6b6862;display:block;margin:10px 0 4px;}'
            + '.fwe-enq-in{width:100%;height:32px;padding:4px 8px;border:1px solid rgba(0,0,0,.2);border-radius:6px;box-sizing:border-box;font-size:13px;}'
            + '.fwe-enq-msg{width:100%;min-height:150px;padding:8px;border:1px solid rgba(0,0,0,.2);border-radius:6px;box-sizing:border-box;font-size:13px;font-family:inherit;resize:vertical;}'
            + '.fwe-enq-wt{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e0ddd4;border-radius:8px;background:#faf9f6;font-size:13px;margin:10px 0;}'
            + '.fwe-enq-send{font-size:13px;padding:8px 15px;border:none;border-radius:8px;background:#185FA5;color:#fff;cursor:pointer;}'
            + '.fwe-enq-send:disabled{background:#b9c7d6;cursor:not-allowed;}'
            + '.fwe-enq-status{margin-top:10px;font-size:13px;}'
            + '.fwe-reqf{font-size:13px;padding:5px 11px;border:none;border-radius:8px;background:#185FA5;color:#fff;cursor:pointer;}'
            + '.fwe-th-row{display:flex;flex-direction:column;align-items:flex-start;gap:0;padding:8px 10px;border:1px solid #ececec;border-radius:8px;}'
            + '.fwe-th-top{display:flex;align-items:center;gap:9px;width:100%;}'
            + '.fwe-pill{font-size:11px;font-weight:600;border-radius:10px;padding:2px 8px;white-space:nowrap;}'
            + '.fwe-pill-wait{background:#FAEEDA;color:#854F0B;}'
            + '.fwe-pill-replied{background:#E1F5EE;color:#085041;}'
            + '.fwe-th-body{width:100%;margin-top:9px;padding:9px;border-radius:8px;background:#f6f5f1;font-size:13px;color:#444;white-space:pre-wrap;}'
            + '.fwe-th-btn{font-size:12px;padding:4px 9px;border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fff;cursor:pointer;}'
            + '.fwe-use-btn{font-size:12px;padding:4px 9px;border:none;border-radius:8px;background:#0F6E56;color:#fff;cursor:pointer;}';
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
        if (r.removed) {
            return '<div class="fwe-row" data-id="' + r.id + '" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #eee;">'
                + '<span style="flex:1;text-decoration:line-through;color:#9b988e;font-size:13px;">' + escTxt(r.d) + ' &middot; ' + (r.qty == null ? '—' : r.qty) + ' &times; ' + (r.kgm || '—') + ' kg/m</span>'
                + '<span style="font-size:11px;color:#9b988e;">removed</span>'
                + '<button class="fwe-restore fwe-link" data-id="' + r.id + '" style="font-size:12px;">Add back</button>'
                + '</div>';
        }
        var qtyMissing = r.qty == null;
        var miss = !r.kgm || qtyMissing;
        var w = qtyMissing ? '<span style="color:#A32D2D;font-size:11px;">no qty</span>'
            : (!r.kgm ? '<span style="color:#A32D2D;font-size:11px;">not counted</span>'
                : (fmt(weightOf(r)) + ' kg'));
        var handle = st.split
            ? '<span class="fwe-handle" draggable="true" data-id="' + r.id + '" title="Drag to the other shipment">&#8942;&#8942;</span>'
            : '<span></span>';
        // Qty stays read-only when it came from the quote; a MISSING qty opens up for
        // sizing (the quote itself is fixed on the Quote tab).
        var qtyInput = qtyMissing
            ? '<input type="number" class="fwe-ed" data-id="' + r.id + '" data-f="qty" value="" placeholder="?" style="text-align:right;" title="No quantity in the quote — enter meters to size the freight">'
            : '<input type="number" class="fwe-ed" data-id="' + r.id + '" data-f="qty" value="' + r.qty + '" style="text-align:right;background:#f6f5f1;" title="Quantity comes from the quote" readonly>';
        return '<div class="fwe-row fwe-grid' + (miss ? ' miss' : '') + '" data-id="' + r.id + '">'
            + handle
            + '<input type="text" class="fwe-ed" data-id="' + r.id + '" data-f="d" value="' + esc(r.d) + '">'
            + qtyInput
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
            + (sec === 2 ? '<button class="fwe-link fwe-merge">Remove &middot; items go back</button>'
                : '<span style="font-size:11px;color:#9b988e;">&#128190; saved with quote</span>') + '</div>';
        var body = rows.length ? rows.map(function (r) { return rowHtml(st, r); }).join('')
            : '<p style="margin:8px 0;font-size:12px;color:#9b988e;text-align:center;">Drag items here to weigh them separately.</p>';
        var secWt = secWeight(st, sec);
        var totalRow = rows.length
            ? '<div class="fwe-grid fwe-total"><div></div><div>Total weight</div><div></div><div></div><div style="text-align:right;">' + fmt(secWt) + ' kg</div><div></div></div>'
              + (secHasTolerance(st, sec)
                  ? '<div class="fwe-grid fwe-subtotal"><div></div><div>With tolerance (7%)</div><div></div><div></div><div style="text-align:right;">' + fmt(secToleranceWeight(st, sec)) + ' kg</div><div></div></div>'
                  : '')
            : '';
        var foot = '<div class="fwe-foot"><button class="fwe-add fwe-addbtn" data-sec="' + sec + '" title="Add item" aria-label="Add item">+</button><span style="margin-left:auto;"></span>'
            + (!st.split ? '<button class="fwe-btn fwe-split">+ Calculate other weight</button>' : '')
            + '<button class="fwe-btn fwe-print" data-sec="' + sec + '">&#128424; Print</button>'
            + '<button class="fwe-reqf" data-sec="' + sec + '">&#128666; Request freight</button></div>';
        return '<div class="fwe-drop" data-sec="' + sec + '">' + header + gridHead() + body + totalRow + foot + '</div>';
    }

    function weightBoxHtml(st) {
        var caret = st.weightOpen ? '▾' : '▸';
        var head = '<button type="button" class="fwe-wt-toggle">'
            + '<i class="ti ti-calculator" style="font-size:16px;" aria-hidden="true"></i> Calculate weight'
            + '<span style="margin-left:auto;">' + caret + '</span></button>';
        if (!st.weightOpen) return '<div class="fwe-wt">' + head + '</div>';
        var note = '<div class="fwe-note">Adjust kg/m to size freight — kg/m changes save with the quote. Splitting and added rows are for sizing only; qty comes from the quote.</div>';
        var body = '<div class="fwe-wt-body">' + note + sectionHtml(st, 1) + (st.split ? sectionHtml(st, 2) : '') + '</div>';
        return '<div class="fwe-wt">' + head + body + '</div>';
    }

    function render(q, mountEl) {
        injectStylesOnce();
        var st = getState(q);
        var html = weightBoxHtml(st) + freightEnquiryBoxHtml(q) + addFreightBoxHtml(q);
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

    // Button label + note say what applying will actually do to a sent quote (create /
    // update a revision) — mirrors what applyAddFreightToQuote already does.
    function addFreightLabels(q) {
        if (!q.sent) return { lbl: 'Add freight', note: 'Not sent yet — this just adds freight to the quote.' };
        return { lbl: 'Add freight', note: 'This quote was already sent — after adding freight, use “Save as Revision” to keep the sent version in History.' };
    }

    function addFreightBoxHtml(q) {
        var st = getState(q);
        var f = st.freight;
        var forOn = f.method === 'for';
        var labels = addFreightLabels(q);
        var amts = st.split
            ? '<span>Shipment 1 Rs</span><input type="number" class="fwe-famt" data-sec="1" value="' + (f.amtA || '') + '" style="width:90px;">'
            + '<span>Shipment 2 Rs</span><input type="number" class="fwe-famt" data-sec="2" value="' + (f.amtB || '') + '" style="width:90px;">'
            : '<span>Total Rs</span><input type="number" class="fwe-famt" value="' + (f.amount || '') + '" style="width:110px;">';
        var splitTotal = st.split
            ? '<div style="margin-top:8px;font-size:13px;font-weight:600;">Total freight: Rs ' + fmt(num(f.amtA) + num(f.amtB)) + '</div>'
            : '';
        var status = f.applied
            ? '<div style="margin-top:8px;color:#0F6E56;font-size:13px;">&#10003; ' + f.applied + '</div>'
            : '<div style="margin-top:8px;font-size:11px;color:#0C447C;">' + labels.note + ' FOR folds it into the rates so it is hidden on the PDF.</div>';
        return '<div class="fwe-addfreight">'
            + '<div style="font-weight:600;margin-bottom:8px;">Add freight to quote</div>'
            + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
            + amts
            + '<span style="font-size:12px;">as</span>'
            + '<button class="fwe-fmethod ' + (forOn ? '' : 'on') + '" data-m="line">Line item</button>'
            + '<button class="fwe-fmethod ' + (forOn ? 'on' : '') + '" data-m="for">FOR &middot; hidden on PDF</button>'
            + '<button class="fwe-fapply" style="margin-left:auto;">' + labels.lbl + '</button>'
            + '</div>' + splitTotal + status + '</div>';
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
        // Reflect the freight in the terms line (line item -> "included", FOR -> "FOR",
        // and drop the "Price basis" line). FOR also syncs via applyFreightForApproval.
        if (typeof syncFreightTermForQuote === 'function') { try { syncFreightTermForQuote(q.id); } catch (e) { } }
        var hist = fc.querySelector('.qtab-content[data-tab="history"]');
        if (hist && typeof buildHistoryTabContent === 'function') hist.innerHTML = buildHistoryTabContent(q);
        return { ok: true };
    }

    // ---------- SEND FREIGHT ENQUIRY (email transporters for a rate) ----------
    // Rows the enquiry covers: everything, or just one shipment when it was opened
    // via that shipment's "Request freight" button while split.
    function enqScopeRows(st) {
        var rows = st.rows.filter(function (r) { return !r.removed; });
        if (st.split && st.enquiry.forSec) rows = rows.filter(function (r) { return r.sec === st.enquiry.forSec; });
        return rows;
    }
    function enqScopeWeight(st) {
        return enqScopeRows(st).reduce(function (s, r) { return s + weightOf(r); }, 0);
    }
    // The weight the enquiry quotes: calculated from the rows, unless the user typed
    // their own number over it (enq.weightOverride).
    function enqEffectiveWeight(st) {
        var o = st.enquiry.weightOverride;
        return (o != null && o > 0) ? o : enqScopeWeight(st);
    }

    // ── Remembered transporters (per route) + pickup/drop (loaded once, saved on send) ──
    var _freightSuggest = null;
    var _freightSuggestLoading = false;
    var EMPTY_SUGGEST = { transporters: [], routes: [], pickups: [], drops: [] };
    function loadFreightSuggestions(onReady) {
        if (_freightSuggest) { onReady(_freightSuggest); return; }
        if (_freightSuggestLoading) return;   // first load's re-render will pick it up
        _freightSuggestLoading = true;
        fetch(apiBase() + '/get-freight-suggestions')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                _freightSuggest = (data && data.suggestions) || EMPTY_SUGGEST;
                onReady(_freightSuggest);
            })
            .catch(function () { _freightSuggest = EMPTY_SUGGEST; });
    }
    function normPlace(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }
    function sortByUsage(list) {
        return (list || []).slice().sort(function (a, b) {
            return (b.count - a.count) || String(b.lastUsed || '').localeCompare(String(a.lastUsed || ''));
        });
    }
    // Suggest transporters for the current route: exact pickup+drop first, then same
    // pickup (any drop), then the global list — deduped, filtered by what's typed.
    function rememberedTransportersForRoute(query, pickup, drop) {
        if (!_freightSuggest) return [];
        var q = String(query || '').trim().toLowerCase();
        var pk = normPlace(pickup), dp = normPlace(drop);
        var routes = _freightSuggest.routes || [];
        var out = [], seen = {};
        function add(list) {
            sortByUsage(list).forEach(function (t) {
                var key = (t.email || '').toLowerCase();
                if (!key || seen[key]) return;
                if (q && key.indexOf(q) === -1) return;
                seen[key] = true;
                out.push({ name: '', email: t.email });
            });
        }
        if (pk) {
            routes.forEach(function (r) { if (normPlace(r.pickup) === pk && normPlace(r.drop) === dp) add(r.transporters); });
            routes.forEach(function (r) { if (normPlace(r.pickup) === pk) add(r.transporters); });
        }
        add(_freightSuggest.transporters);   // global fallback
        return out;
    }
    function recordFreightUsage(recipients, enq) {
        fetch(apiBase() + '/save-freight-suggestions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipients: recipients, pickup: enq.pickup, drop: enq.drop })
        }).then(function (res) { return res.json(); })
            .then(function (data) { if (data && data.suggestions) _freightSuggest = data.suggestions; })
            .catch(function () { /* remembering is best-effort */ });
    }
    // Warm the remembered-suggestions cache so transporter matches are ready when the
    // user focuses the To field. Pickup/drop are NOT auto-filled — they stay manual.
    function warmFreightSuggestions() {
        loadFreightSuggestions(function () { });
    }
    // Prefilled draft the user can edit. Regenerated from pickup/drop/weight until the
    // user types into the message box (then their text is kept — see enq.messageEdited).
    function buildEnquiryDraft(q, st) {
        var enq = st.enquiry;
        var rows = enqScopeRows(st);
        return 'Dear Sir,\n\n'
            + 'Please share your best freight rate for the consignment below:\n\n'
            + '• Pickup: ' + (enq.pickup || '—') + '\n'
            + '• Drop: ' + (enq.drop || '—') + '\n'
            + '• Weight: ' + fmt(enqEffectiveWeight(st)) + ' kg (' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + ')\n'
            + '• Material: MS pipes\n\n'
            + 'Kindly include transit time and whether door delivery is covered.\n\n'
            + 'Regards,\nDSC Pipes';
    }
    function enqTextToHtml(text) {
        var safe = (typeof escapeHtml === 'function') ? escapeHtml(text) : escTxt(text);
        return safe.replace(/\n/g, '<br>');
    }
    function apiBase() {
        return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '/api';
    }
    // Transporter threads live on the quotation (survive reloads via the whole-object save).
    function getEnquiryThreads(q) {
        if (!Array.isArray(q.freightEnquiries)) q.freightEnquiries = [];
        return q.freightEnquiries;
    }
    // Persist enquiry threads right away, like sending a quote does — but never when the
    // user has unsaved edits (that would silently save them; no-autosave rule). In that
    // case the threads ride along with the user's next explicit Save.
    function persistEnquiryThreads(q) {
        if (q.hasUnsavedEdits) return;
        // Only persist a FULLY-LOADED quote. The reply-sweep runs over the list summary, which
        // has no lineItems/tableHTML; saving that object PutCommand-overwrites the stored quote
        // and WIPES its items. Guard against that.
        if (!(q.tableHTML || (Array.isArray(q.lineItems) && q.lineItems.length))) return;
        if (typeof saveQuotationToBackend === 'function') { try { saveQuotationToBackend(q); } catch (e) { } }
    }
    // Pull a rupee amount out of a transporter's reply, e.g. "Rs 18,500", "₹18500/-",
    // "INR 18,500.00" or a bare "18,500/-". Returns 0 if none found.
    function parseFreightAmount(text) {
        var s = String(text || '');
        var m = s.match(/(?:rs\.?|inr|₹|&#8377;)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i)
            || s.match(/([0-9][0-9,]{2,}(?:\.[0-9]+)?)\s*\/-/);
        return m ? (parseFloat(m[1].replace(/,/g, '')) || 0) : 0;
    }
    // Reply bodies persist inside the quotation (whole-object save), so keep them small:
    // drop the quoted chain (our own enquiry below "On ... wrote:") and cap the length.
    var MAX_REPLY_CHARS = 2000;
    function trimReplyForStorage(text) {
        var s = String(text || '');
        var quoteIdx = s.search(/^On .+wrote:\s*$/m);
        if (quoteIdx > 0) s = s.slice(0, quoteIdx).replace(/\s+$/, '');
        return s.length > MAX_REPLY_CHARS ? (s.slice(0, MAX_REPLY_CHARS) + '\n…[truncated]') : s;
    }

    function hasBadRecipient(enq) {
        return enq.to.some(function (a) { return typeof isValidEmailAddress === 'function' && !isValidEmailAddress(a); });
    }

    function enquiryThreadsHtml(q, st) {
        var threads = getEnquiryThreads(q);
        if (!threads.length) return '';
        var enq = st.enquiry;
        var rows = threads.map(function (t, i) {
            var pill = t.replied
                ? '<span class="fwe-pill fwe-pill-replied">Replied</span>'
                : '<span class="fwe-pill fwe-pill-wait">Awaiting reply</span>';
            var readBtn = t.replied
                ? '<button class="fwe-th-btn fwe-th-read" data-i="' + i + '">' + (enq.openReplies[i] ? 'Hide' : 'Read reply') + '</button>'
                : '';
            var secPill = t.forSec
                ? '<span class="fwe-pill" style="background:#E6F1FB;color:#0C447C;">Shipment ' + t.forSec + '</span>'
                : '';
            var top = '<div class="fwe-th-top">'
                + '<i class="ti ti-truck" style="font-size:16px;color:' + (t.replied ? '#0F6E56' : '#9b988e') + ';" aria-hidden="true"></i>'
                + '<span style="flex:1;font-size:13px;">' + escTxt(t.email) + '</span>' + secPill + pill + readBtn + '</div>';
            var body = '';
            if (t.replied && enq.openReplies[i]) {
                var useBtn = t.amount
                    ? '<div style="margin-top:8px;"><button class="fwe-use-btn" data-amt="' + t.amount + '" data-i="' + i + '" data-sec="' + (t.forSec || 0) + '">Use Rs ' + fmt(t.amount) + '</button></div>'
                    : '<div style="margin-top:8px;font-size:11px;color:#9b988e;">No price found in the reply — read it and type the amount in the blue box below.</div>';
                body = '<div class="fwe-th-body">' + escTxt(t.replyText || '(empty reply)') + useBtn + '</div>';
            }
            return '<div class="fwe-th-row">' + top + body + '</div>';
        }).join('');
        var anyWaiting = threads.some(function (t) { return !t.replied; });
        var checkBtn = anyWaiting
            ? '<button class="fwe-th-btn fwe-th-check" style="margin-top:8px;"' + (enq.checking ? ' disabled' : '') + '>'
            + (enq.checking ? 'Checking…' : '&#8635; Check for replies') + '</button>'
            : '';
        var checkStatus = enq.checkResult
            ? '<div style="margin-top:6px;font-size:12px;color:#6b6862;">' + escTxt(enq.checkResult) + '</div>'
            : '';
        return '<p style="margin:14px 0 6px;font-size:12px;color:#9b988e;">Transporter replies — read, then use a price</p>'
            + '<div style="display:flex;flex-direction:column;gap:8px;">' + rows + '</div>' + checkBtn + checkStatus;
    }

    function freightEnquiryBoxHtml(q) {
        var st = getState(q);
        var enq = st.enquiry;
        var caret = enq.open ? '▾' : '▸';
        var head = '<button type="button" class="fwe-enq-toggle">'
            + '<i class="ti ti-truck" style="font-size:16px;" aria-hidden="true"></i> Send freight enquiry'
            + '<span style="margin-left:auto;">' + caret + '</span></button>';
        if (!enq.open) return '<div class="fwe-enq">' + head + '</div>';

        var draft = enq.messageEdited ? enq.message : buildEnquiryDraft(q, st);
        var statusHtml = '';
        if (enq.sending) {
            statusHtml = '<div class="fwe-enq-status" style="color:#6b6862;">Sending…</div>';
        } else if (enq.sent) {
            var isOk = enq.sent.slice(0, 3) === 'ok:';
            var statusText = enq.sent.slice(enq.sent.indexOf(':') + 1);
            statusHtml = '<div class="fwe-enq-status" style="color:' + (isOk ? '#0F6E56' : '#A32D2D') + ';">'
                + (isOk ? '✓ ' : '⚠ ') + escTxt(statusText) + '</div>';
        }
        var body = '<div class="fwe-enq-body">'
            // Route first — filling pickup/drop makes the To box suggest the transporters
            // you've used for that route.
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
            + '<div><label class="fwe-enq-lbl">Pickup point</label><input class="fwe-enq-in fwe-enq-pickup" value="' + esc(enq.pickup) + '" placeholder="e.g. DSC Warehouse, Chennai"></div>'
            + '<div><label class="fwe-enq-lbl">Drop point</label><input class="fwe-enq-in fwe-enq-drop" value="' + esc(enq.drop) + '" placeholder="e.g. Hyderabad"></div>'
            + '</div>'
            + '<label class="fwe-enq-lbl">To — transporters</label>'
            + '<div class="fwe-enq-field"><span class="fwe-enq-chips" style="display:contents;"></span>'
            + '<input class="fwe-enq-input" type="text" placeholder="Type a transporter name or email" autocomplete="off"></div>'
            + '<p style="margin:4px 0 0;font-size:11px;color:#9b988e;">Suggests transporters you’ve used for this route (fill pickup/drop first), plus Gmail matches. Each transporter gets their own email — they can’t see each other.</p>'
            + '<div class="fwe-enq-wt"><i class="ti ti-weight" style="font-size:16px;" aria-hidden="true"></i>'
            + ((st.split && enq.forSec) ? '<span>Shipment ' + enq.forSec + ' ·</span>' : '')
            + '<input type="number" class="fwe-enq-kg" value="' + Math.round(enqEffectiveWeight(st)) + '" style="width:90px;height:28px;padding:2px 6px;text-align:right;border:1px solid rgba(0,0,0,.2);border-radius:6px;" title="Edit to override the calculated weight — clear to go back to calculated">'
            + '<span>kg · ' + enqScopeRows(st).length + ' item' + (enqScopeRows(st).length === 1 ? '' : 's') + '</span>'
            + (enq.weightOverride != null ? '<button type="button" class="fwe-kg-reset fwe-link" style="font-size:11px;">&#8634; use calculated</button>' : '')
            + '</div>'
            + '<label class="fwe-enq-lbl">Message to transporters (editable)</label>'
            + '<textarea class="fwe-enq-msg">' + escTxt(draft) + '</textarea>'
            + '<div style="margin-top:12px;"><button type="button" class="fwe-enq-send"' + (enq.to.length && !enq.sending && !hasBadRecipient(enq) ? '' : ' disabled') + '>'
            + '<i class="ti ti-send" style="font-size:14px;vertical-align:-2px;" aria-hidden="true"></i> Send request</button></div>'
            + statusHtml
            + enquiryThreadsHtml(q, st)
            + '</div>';
        return '<div class="fwe-enq">' + head + body + '</div>';
    }

    // One email per transporter so each reply lands in its own Gmail thread —
    // that's what lets us track who replied (and they can't see each other).
    function sendFreightEnquiry(q, st, mountEl) {
        var enq = st.enquiry;
        if (!enq.to.length || enq.sending || hasBadRecipient(enq)) return;
        var msgEl = mountEl.querySelector('.fwe-enq-msg');
        var bodyText = msgEl ? msgEl.value : enq.message;
        enq.message = bodyText; enq.messageEdited = true;
        // Capture the scope now — enq.forSec can change (another "Request freight" click)
        // before the async sends resolve, and each thread must remember its own shipment.
        var scopeSec = (st.split && enq.forSec) ? enq.forSec : 0;
        var subject = 'Freight enquiry' + (q.quoteNumber ? ' — ' + q.quoteNumber : '')
            + (enq.drop ? ' (to ' + enq.drop + ')' : '')
            + (scopeSec ? ' — Shipment ' + scopeSec : '');
        var recipients = enq.to.slice();
        enq.sending = true; enq.sent = ''; enq.checkResult = '';
        render(q, mountEl);
        Promise.all(recipients.map(function (addr) {
            return fetch(apiBase() + '/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: addr, subject: subject, bodyHtml: enqTextToHtml(bodyText) })
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (d) { return { addr: addr, ok: res.ok && d && d.success, d: d }; });
            }).catch(function (e) {
                return { addr: addr, ok: false, d: { error: e.message } };
            });
        })).then(function (results) {
            enq.sending = false;
            var threads = getEnquiryThreads(q);
            var sentOk = results.filter(function (r) { return r.ok; });
            sentOk.forEach(function (r) {
                threads.push({ email: r.addr, forSec: scopeSec, threadId: (r.d && r.d.threadId) || '', sentAt: new Date().toISOString(), replied: false, replyText: '', amount: 0 });
            });
            var failed = results.filter(function (r) { return !r.ok; });
            if (!failed.length) {
                enq.sent = 'ok:Enquiry sent to ' + sentOk.length + ' transporter' + (sentOk.length > 1 ? 's' : '') + '.';
                enq.to = [];
            } else if (sentOk.length) {
                enq.sent = 'err:Sent to ' + sentOk.length + ', but failed for ' + failed.map(function (r) { return r.addr; }).join(', ') + '.';
                enq.to = failed.map(function (r) { return r.addr; });
            } else {
                enq.sent = 'err:' + ((failed[0].d && failed[0].d.error) || 'Could not send. Check Gmail is set up (send scope).');
            }
            if (sentOk.length) {
                persistEnquiryThreads(q);
                recordFreightUsage(sentOk.map(function (r) { return r.addr; }), enq);
            }
            render(q, mountEl);
        });
    }

    // "Check for replies": read each awaiting thread from Gmail; a reply = any message
    // in it that we didn't send. Needs gmail.readonly (same as the conversation panel).
    function checkFreightReplies(q, st, mountEl) {
        var enq = st.enquiry;
        var threads = getEnquiryThreads(q);
        var waiting = threads.filter(function (t) { return !t.replied && t.threadId; });
        if (!waiting.length || enq.checking) return;
        enq.checking = true;
        render(q, mountEl);
        Promise.all(waiting.map(function (t) {
            return fetch(apiBase() + '/thread-messages?threadId=' + encodeURIComponent(t.threadId))
                .then(function (res) {
                    return res.json().then(function (data) {
                        // The route answers Gmail failures with 500 + {error} JSON — treat
                        // that as "couldn't check", not as an empty thread.
                        if (!res.ok || !data || !Array.isArray(data.messages)) return false;
                        var replies = data.messages.filter(function (m) { return m.direction === 'customer' && !m.auto; });
                        if (replies.length) {
                            var last = replies[replies.length - 1];
                            var fullReply = last.body || last.snippet || '';
                            t.replied = true;
                            t.replyAt = last.date || '';
                            var trimmed = trimReplyForStorage(fullReply);
                            t.amount = parseFreightAmount(trimmed) || parseFreightAmount(fullReply);
                            t.replyText = trimmed;
                        }
                        return true;
                    });
                })
                .catch(function () { return false; /* leave as awaiting; next check retries */ });
        })).then(function (flags) {
            enq.checking = false;
            var failed = flags.filter(function (ok) { return !ok; }).length;
            // Only threads in `waiting` could flip this run — that's what counts as "new".
            var newReplies = waiting.filter(function (t) { return t.replied; }).length;
            var got = threads.filter(function (t) { return t.replied; }).length;
            var total = threads.length;
            if (failed) {
                enq.checkResult = 'Couldn’t check ' + failed + ' of ' + waiting.length + ' — Gmail read failed. If it keeps happening, re-run: node tools/gmail-auth.js';
            } else if (newReplies === 0) {
                enq.checkResult = got ? ('No new replies — ' + got + ' of ' + total + ' replied so far.') : 'No replies yet — checked just now.';
            } else {
                enq.checkResult = newReplies + ' new repl' + (newReplies > 1 ? 'ies' : 'y') + ' — ' + got + ' of ' + total + ' replied.';
            }
            if (newReplies) {
                q.transporterReplyIn = true;   // flags "Needs attention: transporter reply" on the list
                persistEnquiryThreads(q);
            }
            render(q, mountEl);
            // Refresh the list last — it rebuilds the cards, and the module state re-renders
            // this panel (open flags, status message) into the fresh card. Use the edit-safe
            // refresh so it never wipes an open, unsaved quote elsewhere in the list.
            if (newReplies) {
                if (typeof window.refreshApprovalListPreservingEdits === 'function') { try { window.refreshApprovalListPreservingEdits(); } catch (e) { } }
                else if (typeof displayAllApprovedQuotations === 'function') { try { displayAllApprovedQuotations(); } catch (e) { } }
            }
        });
    }

    // Headless variant of checkFreightReplies for the global "Check all replies" sweep:
    // reads a quote's awaiting transporter threads from Gmail and updates the model + the
    // transporterReplyIn flag, with no UI/mountEl. Returns { checked, newReplies }.
    function checkFreightRepliesForQuote(q) {
        var threads = getEnquiryThreads(q);
        var waiting = threads.filter(function (t) { return t && !t.replied && t.threadId; });
        if (!waiting.length) return Promise.resolve({ checked: 0, newReplies: 0 });
        return Promise.all(waiting.map(function (t) {
            return fetch(apiBase() + '/thread-messages?threadId=' + encodeURIComponent(t.threadId))
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (data) {
                    if (!data || !Array.isArray(data.messages)) return false;
                    var replies = data.messages.filter(function (m) { return m.direction === 'customer' && !m.auto; });
                    if (!replies.length) return false;
                    var last = replies[replies.length - 1];
                    var full = last.body || last.snippet || '';
                    var trimmed = trimReplyForStorage(full);
                    t.replied = true;
                    t.replyAt = last.date || '';
                    t.amount = parseFreightAmount(trimmed) || parseFreightAmount(full);
                    t.replyText = trimmed;
                    return true;
                })
                .catch(function () { return false; /* leave awaiting; next sweep retries */ });
        })).then(function (flags) {
            var newReplies = flags.filter(Boolean).length;
            if (newReplies) { q.transporterReplyIn = true; persistEnquiryThreads(q); }
            return { checked: waiting.length, newReplies: newReplies };
        });
    }

    function bindEnquiry(q, st, mountEl) {
        var enq = st.enquiry;
        var toggle = mountEl.querySelector('.fwe-enq-toggle');
        if (toggle) toggle.onclick = function () { enq.open = !enq.open; render(q, mountEl); };
        if (!enq.open) return;

        var field = mountEl.querySelector('.fwe-enq-field');
        var chipsBox = mountEl.querySelector('.fwe-enq-chips');
        var input = mountEl.querySelector('.fwe-enq-input');
        var sendBtn = mountEl.querySelector('.fwe-enq-send');
        function renderChips() {
            chipsBox.innerHTML = enq.to.map(function (addr, i) {
                var bad = (typeof isValidEmailAddress === 'function' && !isValidEmailAddress(addr)) ? ' fwe-chip-bad' : '';
                return '<span class="fwe-chip' + bad + '">' + escTxt(addr) + ' <span class="fwe-chip-x" data-i="' + i + '">×</span></span>';
            }).join('');
            chipsBox.querySelectorAll('.fwe-chip-x').forEach(function (x) {
                x.onclick = function (e) { e.stopPropagation(); enq.to.splice(num(x.getAttribute('data-i')), 1); renderChips(); };
            });
            if (sendBtn) sendBtn.disabled = !enq.to.length || enq.sending || hasBadRecipient(enq);
        }
        function addRecip(raw) {
            var s = String(raw || '');
            // Only split on whitespace for pasted address lists — typed names keep their
            // spaces so "Ravi Transport" stays searchable / one chip.
            var parts = s.indexOf('@') > -1 ? s.split(/[,;\s]+/) : s.split(/[,;\n]+/);
            parts.forEach(function (tok) {
                var v = tok.trim();
                if (v && enq.to.indexOf(v) === -1) enq.to.push(v);
            });
            renderChips();
        }
        renderChips();
        input.addEventListener('keydown', function (e) {
            if (e.key === ',' || e.key === ';' || e.key === 'Enter') {
                e.preventDefault(); addRecip(input.value); input.value = '';
            } else if (e.key === 'Backspace' && input.value === '' && enq.to.length) {
                enq.to.pop(); renderChips();
            }
        });
        input.addEventListener('blur', function () { if (input.value.trim()) { addRecip(input.value); input.value = ''; } });
        // Suggestions are route-aware: they read the CURRENT pickup/drop live, so filling
        // the route first surfaces the transporters used for it. People API merges in.
        if (typeof attachContactAutocomplete === 'function') {
            attachContactAutocomplete(field, input, addRecip, function (query) {
                return rememberedTransportersForRoute(query, enq.pickup, enq.drop);
            });
        }
        warmFreightSuggestions();

        // Keep the draft in sync with pickup/drop while the user hasn't hand-edited it.
        function refreshDraftIfUntouched() {
            if (enq.messageEdited) return;
            var m = mountEl.querySelector('.fwe-enq-msg');
            if (m) m.value = buildEnquiryDraft(q, st);
        }
        var pk = mountEl.querySelector('.fwe-enq-pickup');
        if (pk) pk.oninput = function () { enq.pickup = pk.value; refreshDraftIfUntouched(); };
        var dp = mountEl.querySelector('.fwe-enq-drop');
        if (dp) dp.oninput = function () { enq.drop = dp.value; refreshDraftIfUntouched(); };
        // Editable total weight: type to override, clear (or reset) to go back to calculated.
        var kgIn = mountEl.querySelector('.fwe-enq-kg');
        if (kgIn) kgIn.onchange = function () {
            var v = kgIn.value.trim() === '' ? null : num(kgIn.value);
            enq.weightOverride = (v != null && v > 0 && Math.round(v) !== Math.round(enqScopeWeight(st))) ? v : null;
            refreshDraftIfUntouched();
            render(q, mountEl);
        };
        var kgReset = mountEl.querySelector('.fwe-kg-reset');
        if (kgReset) kgReset.onclick = function () {
            enq.weightOverride = null;
            if (!enq.messageEdited) enq.message = '';
            render(q, mountEl);
        };
        var msg = mountEl.querySelector('.fwe-enq-msg');
        if (msg) msg.oninput = function () { enq.message = msg.value; enq.messageEdited = true; };
        if (sendBtn) sendBtn.onclick = function () { sendFreightEnquiry(q, st, mountEl); };

        // Transporter replies: check, read/hide, use a price
        var checkBtn = mountEl.querySelector('.fwe-th-check');
        if (checkBtn) checkBtn.onclick = function () { checkFreightReplies(q, st, mountEl); };
        mountEl.querySelectorAll('.fwe-th-read').forEach(function (b) {
            b.onclick = function () {
                var i = b.getAttribute('data-i');
                enq.openReplies[i] = !enq.openReplies[i];
                render(q, mountEl);
            };
        });
        mountEl.querySelectorAll('.fwe-use-btn').forEach(function (b) {
            b.onclick = function () {
                var amtVal = num(b.getAttribute('data-amt'));
                // Route by the shipment the enquiry was SENT for (stored on the thread),
                // not by whatever the composer is currently scoped to.
                var useSec = num(b.getAttribute('data-sec'));
                if (st.split && useSec) {
                    if (useSec === 2) st.freight.amtB = amtVal; else st.freight.amtA = amtVal;
                } else if (st.split) {
                    st.freight.amtA = amtVal;
                } else {
                    st.freight.amount = amtVal;
                }
                q.transporterReplyIn = false;   // price picked — clears the needs-attention flag
                persistEnquiryThreads(q);       // persist the clear like the set is persisted
                render(q, mountEl);
                if (typeof displayAllApprovedQuotations === 'function') { try { displayAllApprovedQuotations(); } catch (e) { } }
                // Scroll after the list rebuild, targeting the fresh card's box.
                var fc = document.getElementById('folder-content-' + q.id);
                var box = (fc || mountEl).querySelector('.fwe-addfreight');
                if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };
        });
    }

    function bind(q, mountEl) {
        var st = getState(q);
        var wtToggle = mountEl.querySelector('.fwe-wt-toggle');
        if (wtToggle) wtToggle.onclick = function () { st.weightOpen = !st.weightOpen; render(q, mountEl); };
        mountEl.querySelectorAll('.fwe-ed').forEach(function (inp) {
            inp.onchange = function () {
                var r = findRow(st, inp.getAttribute('data-id'));
                if (!r) return;
                var f = inp.getAttribute('data-f');
                if (f === 'd') r.d = inp.value;
                else if (f === 'qty') r.qty = qtyOrNull(inp.value);   // blank stays blank (red), never 0
                else r[f] = num(inp.value);
                if (f === 'kgm') persistKgm(q, r);
                render(q, mountEl);
            };
        });
        mountEl.querySelectorAll('.fwe-add').forEach(function (b) {
            b.onclick = function () {
                st.rows.push({ id: 'w' + (seq++), d: 'New item', qty: null, kgm: 0, sec: num(b.getAttribute('data-sec')) || 1 });
                render(q, mountEl);
            };
        });
        mountEl.querySelectorAll('.fwe-del').forEach(function (b) {
            b.onclick = function () {
                var r = findRow(st, b.getAttribute('data-id'));
                if (r) r.removed = true;   // soft-delete: keep visible, exclude from total
                render(q, mountEl);
            };
        });
        mountEl.querySelectorAll('.fwe-restore').forEach(function (b) {
            b.onclick = function () {
                var r = findRow(st, b.getAttribute('data-id'));
                if (r) r.removed = false;
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
        // "Request freight" on a weight section opens the enquiry composer, scoped to
        // that shipment when split (weight chip + draft use only its rows).
        mountEl.querySelectorAll('.fwe-reqf').forEach(function (b) {
            b.onclick = function () {
                var enq = st.enquiry;
                var sec = num(b.getAttribute('data-sec')) || 1;
                var newScope = st.split ? sec : 0;
                if (enq.forSec !== newScope) {
                    enq.weightOverride = null;                    // a different shipment = a different weight
                    if (!enq.messageEdited) enq.message = '';     // rescope regenerates the draft
                }
                enq.forSec = newScope;
                enq.open = true;
                render(q, mountEl);
                var boxEl = mountEl.querySelector('.fwe-enq');
                if (boxEl && boxEl.scrollIntoView) boxEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            };
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

        // Add-freight box (single "Total Rs", or per-shipment amounts when split)
        var f = st.freight;
        mountEl.querySelectorAll('.fwe-famt').forEach(function (inp) {
            inp.onchange = function () {
                var sec = inp.getAttribute('data-sec');
                var v = num(inp.value);
                if (sec === '1') f.amtA = v;
                else if (sec === '2') f.amtB = v;
                else f.amount = v;
                // Typing the amount is how a reply with no parseable price gets "used" —
                // treat it as handled, same as the Use button.
                if (v > 0 && q.transporterReplyIn && getEnquiryThreads(q).some(function (t) { return t.replied; })) {
                    q.transporterReplyIn = false;
                    persistEnquiryThreads(q);
                }
                if (st.split) render(q, mountEl);   // refresh the "Total freight" line
            };
        });
        mountEl.querySelectorAll('.fwe-fmethod').forEach(function (b) {
            b.onclick = function () { f.method = b.getAttribute('data-m'); render(q, mountEl); };
        });
        var applyBtn = mountEl.querySelector('.fwe-fapply');
        if (applyBtn) applyBtn.onclick = function () {
            // Read the inputs directly (onchange may not have fired yet)
            mountEl.querySelectorAll('.fwe-famt').forEach(function (inp) {
                var sec = inp.getAttribute('data-sec');
                if (sec === '1') f.amtA = num(inp.value);
                else if (sec === '2') f.amtB = num(inp.value);
                else f.amount = num(inp.value);
            });
            var value = st.split ? (num(f.amtA) + num(f.amtB)) : num(f.amount);
            if (!value || value <= 0) { f.applied = ''; applyBtn.textContent = 'Enter an amount'; return; }
            if (!st.split) f.amount = value;
            var res = applyAddFreightToQuote(q, value, f.method);
            var detail = st.split ? (' (Shipment 1: Rs ' + fmt(num(f.amtA)) + ' + Shipment 2: Rs ' + fmt(num(f.amtB)) + ')') : '';
            f.applied = res.ok
                ? ('Added Rs ' + fmt(value) + detail + ' as ' + (f.method === 'for' ? 'FOR' : 'line item') + ' — see the Quote tab total.')
                : res.msg;
            render(q, mountEl);
        };

        // Send-freight-enquiry composer
        bindEnquiry(q, st, mountEl);
    }

    function printWeights(q, st, sec) {
        var rows = secRows(st, sec).filter(function (r) { return !r.removed; });
        var label = st.split ? ('Shipment ' + sec) : 'Weight';
        var name = [(q.companyName || q.projectName || ''), (q.quoteNumber || '')].filter(Boolean).join(' · ');
        var body = rows.map(function (r) {
            return '<tr><td style="padding:6px 4px;border-bottom:1px solid #eee;">' + escTxt(r.d || '') + '</td>'
                + '<td style="text-align:right;padding:6px 4px;border-bottom:1px solid #eee;">' + (r.qty == null ? '—' : r.qty) + '</td>'
                + '<td style="text-align:right;padding:6px 4px;border-bottom:1px solid #eee;">' + (r.kgm || '—') + '</td>'
                + '<td style="text-align:right;padding:6px 4px;border-bottom:1px solid #eee;">' + ((r.kgm && r.qty != null) ? fmt(weightOf(r)) + ' kg' : '—') + '</td></tr>';
        }).join('');
        var win = window.open('', '_blank', 'width=720,height=820');
        if (!win) return;
        win.document.write('<html><head><title>Weight — ' + escTxt(name) + '</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#20201d;">'
            + '<h2 style="margin:0 0 4px;">Weight summary</h2><p style="margin:0 0 8px;color:#666;font-size:13px;">' + escTxt(name) + '</p>'
            + '<h3 style="font-size:15px;margin:16px 0 6px;">' + escTxt(label) + ' &mdash; ' + fmt(secWeight(st, sec)) + ' kg</h3>'
            + '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>'
            + '<th style="text-align:left;border-bottom:1px solid #999;padding:6px 4px;">Item</th>'
            + '<th style="text-align:right;border-bottom:1px solid #999;padding:6px 4px;">Qty (m)</th>'
            + '<th style="text-align:right;border-bottom:1px solid #999;padding:6px 4px;">kg/m</th>'
            + '<th style="text-align:right;border-bottom:1px solid #999;padding:6px 4px;">Weight</th></tr></thead><tbody>'
            + body + '</tbody></table><p style="margin-top:20px;color:#888;font-size:12px;">DSC Pipes</p></body></html>');
        win.document.close(); win.focus(); win.print();
    }

    if (typeof window !== 'undefined') {
        window.renderFreightWeightEditor = function (quotation, mountEl) {
            if (!quotation || !mountEl) return;
            try { render(quotation, mountEl); }
            catch (e) { mountEl.innerHTML = '<div style="padding:16px;color:#c62828;">Weight editor failed to load.</div>'; console.error('FWE render error', e); }
        };
        // Used by the global "Check all replies" sweep in index.html.
        window.checkFreightRepliesForQuote = checkFreightRepliesForQuote;
    }

    // Pure helpers exposed for unit testing in Node (see tests/freight-tab.test.js).
    // _setSuggest injects the remembered-suggestions cache that
    // rememberedTransportersForRoute reads, so route ranking can be tested in isolation.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports._test = {
            parseFreightAmount: parseFreightAmount,
            trimReplyForStorage: trimReplyForStorage,
            rememberedTransportersForRoute: rememberedTransportersForRoute,
            weightOf: weightOf,
            secWeight: secWeight,
            checkFreightRepliesForQuote: checkFreightRepliesForQuote,
            _setSuggest: function (s) { _freightSuggest = s; }
        };
    }
})();
