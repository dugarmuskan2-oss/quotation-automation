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
    var mountById = {};   // quote id -> the panel element on screen, for background repaints

    function num(v) {
        var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
        return isFinite(n) ? n : 0;
    }
    function liDesc(li) { return li.originalDescription || li.description || ''; }
    function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
    function escTxt(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function fmt(n) { return Math.round(n).toLocaleString('en-IN'); }

    // Transporters quote and argue in tonnes; the sheet works in kilograms. Showing both on every
    // TOTAL (never on a single row) saves doing the division by hand at the moment it matters.
    // 1 T = 1000 kg exactly — the metric tonne, not any shipping variant.
    function fmtTonnes(kg) {
        // 1000 is inlined rather than a named constant so this stays self-contained: the panel
        // tests extract these helpers by name and eval them, and a bare reference to a module
        // constant would not travel with them.
        var t = (Number(kg) || 0) / 1000;
        // Below ~5 kg two decimals collapse to a bare '0', printing '(0 T)' beside a real kg
        // figure. Give small loads the precision they need instead of lying about them.
        if (t > 0 && t < 0.005) return t.toFixed(4).replace(/0+$/, '');
        // Two decimals is 10 kg of resolution — enough to check a transporter's figure, and
        // trailing zeros are dropped so a clean 5000 kg reads "5 T" rather than "5.00 T".
        return String(Number(t.toFixed(2)));
    }
    // "12,345 kg (12.35 T)" — the pair used everywhere a total weight is printed.
    function fmtWeight(kg) { return fmt(kg) + ' kg (' + fmtTonnes(kg) + ' Tonn)'; }

    // Keep a copy of the enquiry we sent, so the shared quote page can show it back rather than
    // only recording that one went out.
    //
    // Stored in q.enquirySentBodies, a top-level map, NOT inside the thread object: the thread
    // arrays are projected into every quotations-list page, and a body is kilobytes. Inline
    // base64 images (a pasted signature logo is routinely 100 kB) are dropped and the whole thing
    // capped — losing a logo from a record costs nothing.
    var MAX_SENT_HTML = 60000;
    var TRUNCATION_NOTE = '<p><i>[This stored copy was shortened. The full enquiry was sent.]</i></p>';
    function trimSentBodyForStorage(html) {
        var s = String(html || '')
            .replace(/\ssrc\s*=\s*"data:[^"]*"/gi, ' src=""')
            .replace(/\ssrc\s*=\s*'data:[^']*'/gi, " src=''");
        if (s.length <= MAX_SENT_HTML) return s;
        // Cut back to the last tag boundary — a blind slice lands mid-attribute and the reader's
        // innerHTML parse then drops the broken tag and auto-closes the table, showing a tidy
        // enquiry that is quietly missing rows.
        var cut = s.slice(0, MAX_SENT_HTML);
        var lastTag = cut.lastIndexOf('<');
        if (lastTag > 0) cut = cut.slice(0, lastTag);
        return cut + TRUNCATION_NOTE;
    }

    // Keyed by the SEND, not the recipient: one enquiry emailed to six transporters is one
    // document, and storing six identical copies burned six of the quote's storage slots. An ISO
    // timestamp sorts lexicographically in chronological order, which is what lets the server
    // evict the oldest reliably rather than trusting object key order to survive DynamoDB.
    function enquiryBodyKey(t) {
        return 'send:' + String((t && t.sentAt) || '');
    }

    function getSentBodies(q) {
        if (!q.enquirySentBodies || typeof q.enquirySentBodies !== 'object') q.enquirySentBodies = {};
        return q.enquirySentBodies;
    }

    // Quantity is null (not 0) when the quote has none — the row shows blank + red so
    // the user fills it in, instead of a silently assumed number.
    function qtyOrNull(v) {
        return (v === undefined || v === null || String(v).trim() === '') ? null : num(v);
    }
    // A stable id per quote line, so the panel can be re-matched to the quote later.
    // (The old 'w'+seq fallback minted a new id on every seed, which made re-matching
    // impossible for quotes whose line items carry no lineItemId.)
    function quoteRowId(li, idx) {
        return li && li.lineItemId ? String(li.lineItemId) : ('q' + idx);
    }
    // Bring the panel's rows back in line with the quote. The rows used to be seeded ONCE and
    // then cached for the life of the page, so editing quantities or adding/removing items on
    // the Quote tab left the freight weight computed from the old figures — with qty locked
    // read-only, there was no way to correct it. Anything the user owns here (added rows,
    // removals, split assignment, a typed sizing qty, an edited description) is preserved.
    function syncRowsWithQuote(q, st) {
        var items = Array.isArray(q.lineItems) ? q.lineItems : [];
        var live = {};
        items.forEach(function (li, idx) {
            var id = quoteRowId(li, idx);
            live[id] = true;
            var r = findRow(st, id);
            if (!r) {
                st.rows.push({
                    id: id, d: liDesc(li), type: String(li.identifiedPipeType || ''),
                    qty: qtyOrNull(li.quantity), kgm: num(li.kgPerMeter), sec: 1, fromQuote: true
                });
                return;
            }
            r.fromQuote = true;
            r.type = String(li.identifiedPipeType || '');
            if (!r.dEdited) r.d = liDesc(li);
            // Only follow the quote where the quote actually has a number: a quantity typed
            // here for sizing (because the quote had none) must survive.
            var qty = qtyOrNull(li.quantity);
            if (qty != null) r.qty = qty;
            if (num(li.kgPerMeter)) r.kgm = num(li.kgPerMeter);
        });
        // A line deleted on the Quote tab must stop adding weight to the freight enquiry.
        // Rows the user added here by hand (no fromQuote) are left alone.
        st.rows = st.rows.filter(function (r) { return !r.fromQuote || live[r.id]; });
    }
    function seedRows(q) {
        var st = { rows: [] };
        syncRowsWithQuote(q, st);
        return st.rows;
    }
    function getState(q) {
        var id = String(q.id);
        if (!stateById[id]) stateById[id] = { rows: seedRows(q), split: false, weightOpen: false, freight: { amount: '', amtA: '', amtB: '', method: 'line', applied: '' } };
        if (!stateById[id].freight) stateById[id].freight = { amount: '', amtA: '', amtB: '', method: 'line', applied: '' };
        // bcc IS the recipient list (one email per transporter); cc is copied on every one.
        if (!stateById[id].enquiry) stateById[id].enquiry = { open: false, forSec: 0, cc: [], bcc: [], pickup: '', drop: '', message: '', messageEdited: false, weightOverride: null, sending: false, sent: '', checking: false, checkResult: '', openReplies: {} };
        // Older in-page state may predate these (or still carry the old `to`) — fill them in
        // rather than letting .slice() throw, and carry any typed recipients across.
        if (!Array.isArray(stateById[id].enquiry.cc)) stateById[id].enquiry.cc = [];
        if (!Array.isArray(stateById[id].enquiry.bcc)) {
            stateById[id].enquiry.bcc = Array.isArray(stateById[id].enquiry.to) ? stateById[id].enquiry.to : [];
        }
        return stateById[id];
    }
    function weightOf(r) { return (r.qty || 0) * (r.kgm || 0); }
    function secRows(st, sec) { return st.rows.filter(function (r) { return r.sec === sec; }); }
    function secWeight(st, sec) {
        return secRows(st, sec).filter(function (r) { return !r.removed; }).reduce(function (s, r) { return s + weightOf(r); }, 0);
    }
    // The section total is only meaningful once every row has a kg/m AND a quantity — a
    // partial total (with "not counted" rows) would mislead, so we hide it until then.
    function secComplete(st, sec) {
        var rows = secRows(st, sec).filter(function (r) { return !r.removed; });
        return rows.length > 0 && rows.every(function (r) { return r.kgm && r.qty != null; });
    }
    // Name what is actually missing. Saying "fill in every kg/m" when every kg/m IS filled and the
    // gap is a quantity sends the user hunting for a value that is already there.
    function missingWeightFieldsLabel(st, sec) {
        var rows = secRows(st, sec).filter(function (r) { return !r.removed; });
        var noKg = rows.filter(function (r) { return !r.kgm; }).length;
        var noQty = rows.filter(function (r) { return r.qty == null; }).length;
        if (!rows.length) return 'Add an item to see the total weight';
        if (noKg && noQty) return 'Fill in the missing kg/m and quantity to see the total weight';
        if (noQty) return 'Fill in the missing quantity to see the total weight';
        return 'Fill in every kg/m to see the total weight';
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
            + '.fwe-grid{display:grid;grid-template-columns:22px 1fr 64px 64px 132px 28px;gap:8px;align-items:center;}'
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
    // The row's Weight cell. Split out of rowHtml so a live edit can repaint just this cell
    // instead of rebuilding the tab (see refreshWeights).
    function rowWeightHtml(r) {
        if (r.qty == null) return '<span style="color:#A32D2D;font-size:11px;">no qty</span>';
        if (!r.kgm) return '<span style="color:#A32D2D;font-size:11px;">not counted</span>';
        return fmt(weightOf(r)) + ' kg';
    }
    function sectionTitleHtml(st, sec) {
        var title = st.split ? ('Shipment ' + sec) : 'Weight';
        return title + (secComplete(st, sec) ? ' &middot; ' + fmtWeight(secWeight(st, sec)) : '');
    }
    // Total (and the 7% tolerance) only once every row has its kg/m + qty. Until then,
    // a prompt instead of a misleading partial total.
    function totalRowHtml(st, sec) {
        if (!secRows(st, sec).length) return '';
        if (!secComplete(st, sec)) {
            return '<div class="fwe-grid fwe-subtotal"><div></div><div style="color:#9b988e;font-size:12px;">'
                + missingWeightFieldsLabel(st, sec) + '</div><div></div><div></div><div></div><div></div></div>';
        }
        return '<div class="fwe-grid fwe-total"><div></div><div>Total weight</div><div></div><div></div><div style="text-align:right;">' + fmtWeight(secWeight(st, sec)) + '</div><div></div></div>'
            + (secHasTolerance(st, sec)
                ? '<div class="fwe-grid fwe-subtotal"><div></div><div>With tolerance (7%)</div><div></div><div></div><div style="text-align:right;">' + fmtWeight(secToleranceWeight(st, sec)) + '</div><div></div></div>'
                : '');
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
        var w = rowWeightHtml(r);
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
            + '<div class="fwe-w" style="text-align:right;font-size:13px;">' + w + '</div>'
            + '<button class="fwe-del" data-id="' + r.id + '" title="Delete line" aria-label="Delete line">&times;</button>'
            + '</div>';
    }
    function sectionHtml(st, sec) {
        var rows = secRows(st, sec);
        var header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
            + '<span class="fwe-sectitle" style="font-size:13px;font-weight:600;color:#444;">' + sectionTitleHtml(st, sec) + '</span>'
            + (sec === 2 ? '<button class="fwe-link fwe-merge">Remove &middot; items go back</button>'
                : '<span style="font-size:11px;color:#9b988e;">&#128190; saved with quote</span>') + '</div>';
        var body = rows.length ? rows.map(function (r) { return rowHtml(st, r); }).join('')
            : '<p style="margin:8px 0;font-size:12px;color:#9b988e;text-align:center;">Drag items here to weigh them separately.</p>';
        var totalRow = '<div class="fwe-totalwrap">' + totalRowHtml(st, sec) + '</div>';
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
        syncRowsWithQuote(q, st);   // pick up Quote-tab edits made since the panel was first built
        var html = weightBoxHtml(st) + freightEnquiryBoxHtml(q) + addFreightBoxHtml(q);
        mountEl.innerHTML = html;
        bind(q, mountEl);
    }

    // Repaint ONLY what a weight edit changes — the row's weight cell and red tint, the
    // section heading/total, and the enquiry box's weight chip. Editing a field used to call
    // render(), which replaced the whole tab on blur: the mousedown landed on the old button,
    // the re-render swapped it out, and the click never fired. So the first click after any
    // edit was silently swallowed. Nothing here removes or replaces an element the user
    // could be clicking.
    function refreshWeights(q, mountEl) {
        var st = getState(q);
        mountEl.querySelectorAll('.fwe-drop').forEach(function (zone) {
            var sec = num(zone.getAttribute('data-sec')) || 1;
            var titleEl = zone.querySelector('.fwe-sectitle');
            if (titleEl) titleEl.innerHTML = sectionTitleHtml(st, sec);
            var totalEl = zone.querySelector('.fwe-totalwrap');
            if (totalEl) totalEl.innerHTML = totalRowHtml(st, sec);
            secRows(st, sec).forEach(function (r) {
                var rowEl = zone.querySelector('.fwe-row[data-id="' + r.id + '"]');
                if (!rowEl || r.removed) return;
                var wEl = rowEl.querySelector('.fwe-w');
                if (wEl) wEl.innerHTML = rowWeightHtml(r);
                if (rowEl.classList) rowEl.classList.toggle('miss', !r.kgm || r.qty == null);
            });
        });
        refreshEnquiryWeight(q, st, mountEl);
    }

    // The enquiry box quotes the same weight, so a panel edit has to reach it. Values are
    // written, never re-created, so an open composer keeps its focus, chips and typed message.
    function refreshEnquiryWeight(q, st, mountEl) {
        var enq = st.enquiry;
        if (!enq.open) return;
        var usable = enqWeightUsable(st);
        var kgIn = mountEl.querySelector('.fwe-enq-kg');
        if (kgIn && document.activeElement !== kgIn && enq.weightOverride == null) {
            kgIn.value = usable ? Math.round(enqEffectiveWeight(st)) : '';
            kgIn.placeholder = usable ? '' : 'enter kg';
            kgIn.style.borderColor = usable ? 'rgba(0,0,0,.2)' : '#C0392B';
        }
        var warn = mountEl.querySelector('.fwe-enq-wt-warn');
        if (warn) {
            warn.innerHTML = enqWeightWarnHtml(st);
            warn.hidden = usable;
        }
        var reset = mountEl.querySelector('.fwe-kg-reset');
        if (reset) reset.hidden = (enq.weightOverride == null);
        var sendBtn = mountEl.querySelector('.fwe-enq-send');
        if (sendBtn) sendBtn.disabled = !(enq.bcc.length || enq.cc.length) || enq.sending || hasBadRecipient(enq) || !usable;
        var msgEl = mountEl.querySelector('.fwe-enq-msg');
        if (msgEl && !enq.messageEdited && document.activeElement !== msgEl) {
            msgEl.value = buildEnquiryDraft(q, st);
        }
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
        var hit = -1;
        for (var i = 0; i < items.length; i++) {
            if (items[i].lineItemId && String(items[i].lineItemId) === String(r.id)) { hit = i; break; }
        }
        // Quotes whose line items carry no lineItemId use the positional 'q<index>' id — without
        // this the edited kg/m was never written back to those quotes at all.
        if (hit < 0 && /^q\d+$/.test(String(r.id))) {
            var idx = parseInt(String(r.id).slice(1), 10);
            if (items[idx]) hit = idx;
        }
        if (hit >= 0) items[hit].kgPerMeter = r.kgm;
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
    // Rows in scope that contribute nothing because they have no kg/m or no quantity.
    // The calculated weight silently omits them, so it is too LOW — and this weight is what
    // transporters are quoted. The on-screen section total already refuses to show a partial
    // figure (secComplete); the enquiry must not be more trusting than the panel itself.
    function enqUncountedRows(st) {
        return enqScopeRows(st).filter(function (r) { return !(r.kgm && r.qty != null); });
    }
    function enqWeightWarnHtml(st) {
        var un = enqUncountedRows(st).length, all = enqScopeRows(st).length;
        return '&#9888; ' + un + ' of ' + all + ' item' + (all === 1 ? '' : 's')
            + ' ha' + (un === 1 ? 's' : 've')
            + ' no kg/m or quantity, so the weight cannot be calculated. Fill those in on the panel above,'
            + ' or type the weight here — the enquiry will not send without it.';
    }
    function enqScopeComplete(st) {
        var rows = enqScopeRows(st);
        return rows.length > 0 && enqUncountedRows(st).length === 0;
    }
    // True when we have a weight we are willing to put in front of a transporter: either every
    // row counted, or the user typed the number themselves.
    function enqWeightUsable(st) {
        var o = st.enquiry.weightOverride;
        if (o != null && o > 0) return true;
        // A complete scope that still totals zero (every row quantity 0) is not a usable weight —
        // "Weight: 0 kg" tells a transporter nothing and cannot be priced.
        return enqScopeComplete(st) && enqScopeWeight(st) > 0;
    }
    // The weight the enquiry quotes: calculated from the rows, unless the user typed
    // their own number over it (enq.weightOverride). Returns 0 when the calculation would be
    // partial and no override was given — callers must check enqWeightUsable first.
    function enqEffectiveWeight(st) {
        var o = st.enquiry.weightOverride;
        if (o != null && o > 0) return o;
        return enqScopeComplete(st) ? enqScopeWeight(st) : 0;
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
            // Placeholder rather than a partial figure when the weight cannot be calculated —
            // the draft is only a draft, and sending is blocked until a real weight exists.
            // The item count joins the SAME bracket as the tonnage. Adding the tonne figure left
            // this line reading "17,945 kg (17.95 T) (2 items)" — two bracketed groups colliding
            // in an email that goes to transporters.
            + '• Weight: ' + (enqWeightUsable(st)
                ? fmt(enqEffectiveWeight(st)) + ' kg (' + fmtTonnes(enqEffectiveWeight(st)) + ' Tonn, '
                  + rows.length + ' item' + (rows.length === 1 ? '' : 's') + ')'
                : '____ kg (' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + ')') + '\n'
            + '• Material: MS pipes\n\n'
            + '[TABLE]\n\n'
            + 'Please include transit time.\n\n'
            + 'Regards,\nDSC Pipes';
    }

    // The consignment broken down by size, so a transporter can see WHAT they are carrying rather
    // than just a total weight. Substituted for [TABLE] at send time, so the user can still move
    // it around (or delete it) in the editable message.
    function freightItemsTableHtml(st) {
        var rows = enqScopeRows(st);
        if (!rows.length) return '';
        var head = ['Item', 'Qty', 'kg/m', 'Weight']
            .map(function (h, i) {
                return '<th style="border:1px solid #000;padding:6px 8px;background:#0b4aa2;color:#fff;'
                    + 'text-align:' + (i === 0 ? 'left' : 'right') + ';">' + escTxt(h) + '</th>';
            }).join('');
        var body = rows.map(function (r, i) {
            var bg = (i % 2 === 0) ? '#ffffff' : '#eef5ff';
            var cell = 'border:1px solid #000;padding:6px 8px;background-color:' + bg + ';';
            var w = (r.qty != null && r.kgm) ? fmt(weightOf(r)) + ' kg' : '—';
            return '<tr>'
                + '<td bgcolor="' + bg + '" style="' + cell + '">' + escTxt(r.d || '') + '</td>'
                + '<td bgcolor="' + bg + '" style="' + cell + 'text-align:right;">' + escTxt(r.qty != null ? r.qty : '') + '</td>'
                + '<td bgcolor="' + bg + '" style="' + cell + 'text-align:right;">' + escTxt(r.kgm || '') + '</td>'
                + '<td bgcolor="' + bg + '" style="' + cell + 'text-align:right;">' + w + '</td>'
                + '</tr>';
        }).join('');
        var total = enqWeightUsable(st)
            ? '<tr><td colspan="3" style="border:1px solid #000;padding:6px 8px;text-align:right;font-weight:700;">Total</td>'
              + '<td style="border:1px solid #000;padding:6px 8px;text-align:right;font-weight:700;">' + fmtWeight(enqEffectiveWeight(st)) + '</td></tr>'
            : '';
        return '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
            + '<thead><tr>' + head + '</tr></thead><tbody>' + body + total + '</tbody></table>';
    }
    // The standard signature (Settings → Default Email Signature) — the same one quotations are
    // sent with. Freight enquiries used to go out unsigned. Cached after the first fetch.
    var _freightSignatureHtml = null;
    function loadFreightSignature(then) {
        if (_freightSignatureHtml !== null) { then && then(); return; }
        fetch(apiBase() + '/get-default-signature')
            .then(function (r) { return r.json(); })
            .then(function (d) { _freightSignatureHtml = (d && d.content) || ''; })
            .catch(function () { _freightSignatureHtml = ''; })
            .then(function () { then && then(); });
    }
    // `st` is optional — when given, [TABLE] in the message is replaced by the item breakdown.
    // The text is escaped FIRST and the table injected after, so a transporter's name or a typed
    // description can never smuggle markup in.
    function enqTextToHtml(text, st) {
        var safe = (typeof escapeHtml === 'function') ? escapeHtml(text) : escTxt(text);
        var body = safe.replace(/\n/g, '<br>');
        if (st) {
            var table = freightItemsTableHtml(st);
            body = body.replace(/\[TABLE\]/g, table ? '<div style="height:6px;"></div>' + table + '<div style="height:6px;"></div>' : '');
        } else {
            body = body.replace(/\[TABLE\]/g, '');
        }
        return _freightSignatureHtml
            ? body + '<div style="height:14px;"></div>' + _freightSignatureHtml
            : body;
    }
    function apiBase() {
        return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '/api';
    }
    // Transporter threads live on the quotation (survive reloads via the whole-object save).
    function getEnquiryThreads(q) {
        if (!Array.isArray(q.freightEnquiries)) q.freightEnquiries = [];
        return q.freightEnquiries;
    }
    // Persist enquiry threads right away, through a field-only route that merges into the STORED
    // payload. It writes freightEnquiries (and the reply flag) and nothing else, so it can neither
    // save the user's in-progress edits (no-autosave rule) nor wipe lineItems/tableHTML when this
    // object is only a list summary — the two cases the old whole-object save had to refuse.
    // Those refusals were silent, so an enquiry that had genuinely been emailed left no record and
    // vanished on reload; the quote then never appeared under the Freight filter.
    // onFail is optional: the send flow passes one so a lost save is SAID on screen. Losing this
    // write silently meant the enquiry really went out but its "Sent to / Awaiting reply" record
    // vanished on reload — the reply sweep never watched those threads and the quote dropped off
    // the Freight filter, inviting a duplicate send.
    function persistEnquiryThreads(q, onFail) {
        if (!q || q.id == null) return Promise.resolve(false);
        var post = function () {
            return fetch(apiBase() + '/quotations/' + encodeURIComponent(q.id) + '/freight-enquiries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ freightEnquiries: getEnquiryThreads(q), transporterReplyIn: !!q.transporterReplyIn, enquirySentBodies: getSentBodies(q) })
            }).then(function (res) { return res.ok; }).catch(function () { return false; });
        };
        return post().then(function (ok) { return ok || post(); }).then(function (ok) {
            if (!ok) {
                console.error('Freight enquiries not saved for quote ' + q.id);
                if (onFail) onFail();
            }
            return ok;
        });
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

    // Cc and Bcc are checked too: a typo there fails the whole send, not just that copy.
    function hasBadRecipient(enq) {
        var all = (enq.bcc || []).concat(enq.cc || []);
        return all.some(function (a) { return typeof isValidEmailAddress === 'function' && !isValidEmailAddress(a); });
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

    // Cc: openly copied on every email this send produces. Bcc above is the recipient list, so
    // cc'ing a colleague on an enquiry to five transporters puts five copies in their inbox —
    // worth saying out loud rather than letting them discover it.
    function ccFieldHtml() {
        return '<div class="fwe-ccbox">'
            + '<label class="fwe-enq-lbl">Cc (optional)</label>'
            + '<div class="fwe-enq-field" data-kind="cc">'
            + '<span class="fwe-enq-chips" data-kind="cc" style="display:contents;"></span>'
            + '<input class="fwe-enq-input" data-kind="cc" type="text" placeholder="Add one or more addresses" autocomplete="off"></div>'
            + '<p style="margin:4px 0 0;font-size:11px;color:#9b988e;">'
            + 'Everyone here can see each other, like a normal Cc. With Bcc filled, these ride along on every'
            + ' hidden email above; with Bcc empty, the enquiry goes as ONE open email to these addresses.</p></div>';
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
            + '<label class="fwe-enq-lbl">Bcc — transporters</label>'
            + '<div class="fwe-enq-field" data-kind="bcc"><span class="fwe-enq-chips" data-kind="bcc" style="display:contents;"></span>'
            + '<input class="fwe-enq-input" data-kind="bcc" type="text" placeholder="Type a transporter name or email" autocomplete="off"></div>'
            + '<p style="margin:4px 0 0;font-size:11px;color:#9b988e;">Suggests transporters you’ve used for this route (fill pickup/drop first), plus Gmail matches. Each transporter gets their own email — they can’t see each other.</p>'
            + ccFieldHtml()
            + '<div class="fwe-enq-wt"><i class="ti ti-weight" style="font-size:16px;" aria-hidden="true"></i>'
            + ((st.split && enq.forSec) ? '<span>Shipment ' + enq.forSec + ' ·</span>' : '')
            // Left EMPTY when the calculation would be partial: prefilling the low number is how a
            // 51%-light weight reached transporters unnoticed. Typing one here is the way forward.
            + '<input type="number" class="fwe-enq-kg" value="' + (enqWeightUsable(st) ? Math.round(enqEffectiveWeight(st)) : '') + '"'
            + (enqWeightUsable(st) ? '' : ' placeholder="enter kg"')
            + ' style="width:90px;height:28px;padding:2px 6px;text-align:right;border:1px solid ' + (enqWeightUsable(st) ? 'rgba(0,0,0,.2)' : '#C0392B') + ';border-radius:6px;" title="Edit to override the calculated weight — clear to go back to calculated">'
            + '<span>kg · ' + enqScopeRows(st).length + ' item' + (enqScopeRows(st).length === 1 ? '' : 's') + '</span>'
            + '<button type="button" class="fwe-kg-reset fwe-link" style="font-size:11px;"'
            + (enq.weightOverride != null ? '' : ' hidden') + '>&#8634; use calculated</button>'
            + '</div>'
            // Always emitted (hidden when the weight is usable) so a live edit can toggle it
            // without rebuilding the composer around the user.
            + '<p class="fwe-enq-wt-warn" style="margin:4px 0 0;font-size:12px;color:#A32D2D;font-weight:600;"'
            + (enqWeightUsable(st) ? ' hidden' : '') + '>' + enqWeightWarnHtml(st) + '</p>'
            + '<label class="fwe-enq-lbl">Message to transporters (editable)</label>'
            + '<textarea class="fwe-enq-msg">' + escTxt(draft) + '</textarea>'
            + '<div style="margin-top:12px;"><button type="button" class="fwe-enq-send"' + ((enq.bcc.length || enq.cc.length) && !enq.sending && !hasBadRecipient(enq) && enqWeightUsable(st) ? '' : ' disabled') + '>'
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
        if (!(enq.bcc.length || enq.cc.length) || enq.sending || hasBadRecipient(enq)) return;
        // Never quote a transporter a weight that silently omits rows — the rate comes back priced
        // on it. The button is already disabled in this state; this is the guard behind it.
        if (!enqWeightUsable(st)) {
            enq.sent = 'err:' + enqUncountedRows(st).length + ' item(s) have no kg/m or quantity, so the weight is incomplete. Fill them in, or type the weight, before sending.';
            render(q, mountEl);
            return;
        }
        var msgEl = mountEl.querySelector('.fwe-enq-msg');
        var bodyText = msgEl ? msgEl.value : enq.message;
        enq.message = bodyText;
        // Only "edited" if it really differs from the generated draft. Setting this
        // unconditionally froze the message at the first send, so a later route, kg/m or
        // shipment change never reached the body — the subject said one thing, the text another.
        enq.messageEdited = (String(bodyText).trim() !== buildEnquiryDraft(q, st).trim());
        // Capture the scope now — enq.forSec can change (another "Request freight" click)
        // before the async sends resolve, and each thread must remember its own shipment.
        var scopeSec = (st.split && enq.forSec) ? enq.forSec : 0;
        var subject = 'Freight enquiry' + (q.quoteNumber ? ' — ' + q.quoteNumber : '')
            + (enq.drop ? ' (to ' + enq.drop + ')' : '')
            + (scopeSec ? ' — Shipment ' + scopeSec : '');
        var recipients = enq.bcc.slice();
        // Captured now, like the recipients: the composer stays editable while the sends run.
        var extra = { cc: (enq.cc || []).join(', ') };
        enq.sending = true; enq.sent = ''; enq.checkResult = '';
        render(q, mountEl);
        loadFreightSignature(function () { freightSendAll(q, st, mountEl, enq, recipients, subject, bodyText, scopeSec, extra); });
    }

    function freightSendAll(q, st, mountEl, enq, recipients, subject, bodyText, scopeSec, extra) {
        extra = extra || { cc: '' };
        // Built once, not once per recipient: every transporter gets the same enquiry, and the
        // stored copy has to be the one they actually received.
        var bodyHtml = enqTextToHtml(bodyText, st);
        var storedBody = trimSentBodyForStorage(bodyHtml);
        // Standard email semantics: Bcc hides recipients from each other (one email per
        // transporter), Cc is open. With Bcc EMPTY, the Cc addresses ARE the send — one
        // email, everyone visible, the way Cc works everywhere else.
        var ccOnly = !recipients.length;
        var sends = ccOnly ? [extra.cc] : recipients;
        Promise.all(sends.map(function (addr) {
            var payload = ccOnly
                ? { to: '', cc: addr, bcc: '', subject: subject, bodyHtml: bodyHtml, label: 'freight' }
                // One email per transporter, that transporter on Bcc so nobody sees anyone else.
                // `to` is left empty — the server addresses it to our own account.
                // label tags the thread Quotation Automation/Freight Enquiry in Gmail.
                : { to: '', cc: extra.cc, bcc: addr, subject: subject, bodyHtml: bodyHtml, label: 'freight' };
            return fetch(apiBase() + '/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (d) { return { addr: addr, ok: res.ok && d && d.success, d: d }; });
            }).catch(function (e) {
                return { addr: addr, ok: false, d: { error: e.message } };
            });
        })).then(function (results) {
            enq.sending = false;
            var threads = getEnquiryThreads(q);
            var sentOk = results.filter(function (r) { return r.ok; });
            // ONE timestamp for the whole send, not one per recipient: it is a single enquiry,
            // and it is what ties every transporter's thread to the one stored copy of the body.
            var sentAt = new Date().toISOString();
            sentOk.forEach(function (r) {
                threads.push({ email: r.addr, forSec: scopeSec, threadId: (r.d && r.d.threadId) || '', sentAt: sentAt, replied: false, replyText: '', amount: 0 });
            });
            if (sentOk.length) getSentBodies(q)[enquiryBodyKey({ sentAt: sentAt })] = storedBody;
            var failed = results.filter(function (r) { return !r.ok; });
            if (!failed.length) {
                var n = ccOnly ? extra.cc.split(', ').length : sentOk.length;
                enq.sent = 'ok:Enquiry sent to ' + n + ' transporter' + (n > 1 ? 's' : '') + (ccOnly ? ' (one open email — all Cc)' : '') + '.';
                // Clear whichever list acted as the RECIPIENTS, so the live Send button
                // cannot fire the same enquiry twice. Copies (cc on a Bcc send) stay.
                if (ccOnly) enq.cc = []; else enq.bcc = [];
            } else if (sentOk.length) {
                enq.sent = 'err:Sent to ' + sentOk.length + ', but failed for ' + failed.map(function (r) { return r.addr; }).join(', ') + '.';
                enq.bcc = failed.map(function (r) { return r.addr; });
            } else {
                enq.sent = 'err:' + ((failed[0].d && failed[0].d.error) || 'Could not send. Check Gmail is set up (send scope).');
            }
            if (sentOk.length) {
                persistEnquiryThreads(q, function () {
                    // The enquiry went out; only its record failed to save. Say so where the
                    // user is already looking, instead of a console line nobody sees.
                    enq.sent = 'err:Enquiry WAS sent, but saving its record failed — reply tracking may be lost. Do not re-send; reload and check the transporter list.';
                    render(q, mountEl);
                });
                // A ccOnly "addr" is the joined list — split it back so each transporter is
                // remembered individually for route suggestions.
                var used = [];
                sentOk.forEach(function (r) { used = used.concat(String(r.addr).split(', ')); });
                recordFreightUsage(used, enq);
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
        if (enq.checking) return;
        // Nothing left to check is a normal state — usually because the background sweep
        // already found the replies. Returning silently made the button look broken.
        if (!waiting.length) {
            var done = threads.filter(function (t) { return t.replied; }).length;
            enq.checkResult = threads.length
                ? ('Nothing left to check — all ' + threads.length + ' transporter'
                   + (threads.length === 1 ? ' has' : 's have') + ' replied'
                   + (done ? '' : '') + '. Their replies are listed above.')
                : 'No enquiries have been sent yet.';
            render(q, mountEl);
            return;
        }
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
            if (newReplies) {
                q.transporterReplyIn = true;
                persistEnquiryThreads(q);
                // The sweep runs in the background, so its find has to reach a Freight tab
                // that is already open — otherwise the panel keeps saying "Awaiting reply"
                // over a reply that is sitting in the model, and the user concludes none came.
                repaintOpenPanel(q);
            }
            return { checked: waiting.length, newReplies: newReplies };
        });
    }

    // Re-render this quote's Freight panel if it is currently on screen. Safe to call from
    // background work: does nothing when the card is closed or the mount has been replaced.
    function repaintOpenPanel(q) {
        var mountEl = mountById[String(q.id)];
        if (!mountEl || !mountEl.isConnected) return;
        try { render(q, mountEl); } catch (e) { /* a repaint must never break the sweep */ }
    }

    function bindEnquiry(q, st, mountEl) {
        var enq = st.enquiry;
        var toggle = mountEl.querySelector('.fwe-enq-toggle');
        if (toggle) toggle.onclick = function () { enq.open = !enq.open; render(q, mountEl); };
        if (!enq.open) return;

        var field = mountEl.querySelector('.fwe-enq-field[data-kind="bcc"]');
        var chipsBox = mountEl.querySelector('.fwe-enq-chips[data-kind="bcc"]');
        var input = mountEl.querySelector('.fwe-enq-input[data-kind="bcc"]');
        var sendBtn = mountEl.querySelector('.fwe-enq-send');
        function syncSendBtn() {
            // The weight gate belongs here too — adding a recipient used to re-enable Send
            // even when the weight was still incomplete, contradicting the box's own warning.
            if (sendBtn) sendBtn.disabled = !(enq.bcc.length || enq.cc.length) || enq.sending || hasBadRecipient(enq) || !enqWeightUsable(st);
        }
        // One binder for both boxes — chips, paste splitting, Backspace, blur-commit and the
        // Gmail dropdown behave the same in each; only the list they write to differs.
        function bindAddressField(fieldEl, chipsEl, inputEl, list) {
            function renderChips() {
                chipsEl.innerHTML = list.map(function (addr, i) {
                    var bad = (typeof isValidEmailAddress === 'function' && !isValidEmailAddress(addr)) ? ' fwe-chip-bad' : '';
                    return '<span class="fwe-chip' + bad + '">' + escTxt(addr) + ' <span class="fwe-chip-x" data-i="' + i + '">×</span></span>';
                }).join('');
                chipsEl.querySelectorAll('.fwe-chip-x').forEach(function (x) {
                    x.onclick = function (e) { e.stopPropagation(); list.splice(num(x.getAttribute('data-i')), 1); renderChips(); };
                });
                syncSendBtn();
            }
            function add(raw) {
                var s = String(raw || '');
                // Only split on whitespace for pasted address lists — typed names keep their
                // spaces so "Ravi Transport" stays searchable / one chip.
                var parts = s.indexOf('@') > -1 ? s.split(/[,;\s]+/) : s.split(/[,;\n]+/);
                parts.forEach(function (tok) {
                    var v = tok.trim();
                    if (v && list.indexOf(v) === -1) list.push(v);
                });
                renderChips();
            }
            renderChips();
            inputEl.addEventListener('keydown', function (e) {
                if (e.key === ',' || e.key === ';' || e.key === 'Enter') {
                    e.preventDefault(); add(inputEl.value); inputEl.value = '';
                } else if (e.key === 'Backspace' && inputEl.value === '' && list.length) {
                    list.pop(); renderChips();
                }
            });
            inputEl.addEventListener('blur', function () { if (inputEl.value.trim()) { add(inputEl.value); inputEl.value = ''; } });
            // Suggestions are route-aware: they read the CURRENT pickup/drop live, so filling
            // the route first surfaces the transporters used for it. People API merges in.
            if (typeof attachContactAutocomplete === 'function') {
                attachContactAutocomplete(fieldEl, inputEl, add, function (query) {
                    return rememberedTransportersForRoute(query, enq.pickup, enq.drop);
                });
            }
            return add;
        }
        bindAddressField(field, chipsBox, input, enq.bcc);
        var ccField = mountEl.querySelector('.fwe-ccbox .fwe-enq-field[data-kind="cc"]');
        if (ccField) {
            bindAddressField(ccField, ccField.querySelector('.fwe-enq-chips'),
                ccField.querySelector('.fwe-enq-input'), enq.cc);
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
            // Typing the same number the panel calculated only counts as "not an override"
            // when that calculation is complete. With rows missing kg/m or qty the typed
            // number is the ONLY weight we have — discarding it silently left Send disabled
            // and the warning on screen, with no way forward.
            var sameAsCalc = (v != null && Math.round(v) === Math.round(enqScopeWeight(st)));
            enq.weightOverride = (v != null && v > 0 && !(sameAsCalc && enqScopeComplete(st))) ? v : null;
            refreshDraftIfUntouched();
            refreshWeights(q, mountEl);   // in place: a render here would eat the click on Send request
        };
        var kgReset = mountEl.querySelector('.fwe-kg-reset');
        if (kgReset) kgReset.onclick = function () {
            enq.weightOverride = null;
            if (!enq.messageEdited) enq.message = '';
            if (kgIn) kgIn.value = enqWeightUsable(st) ? Math.round(enqEffectiveWeight(st)) : '';
            refreshDraftIfUntouched();
            refreshWeights(q, mountEl);
        };
        // "Hand-edited" has to mean the text actually differs from what we'd generate. Marking
        // it on any keystroke (or on send) froze the draft: later route/weight changes never
        // reached it, so a second transporter could be emailed the first shipment's details.
        var msg = mountEl.querySelector('.fwe-enq-msg');
        if (msg) msg.oninput = function () {
            enq.message = msg.value;
            enq.messageEdited = (msg.value.trim() !== buildEnquiryDraft(q, st).trim());
        };
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
                if (f === 'd') { r.d = inp.value; r.dEdited = true; }   // keep it through a quote re-sync
                else if (f === 'qty') r.qty = qtyOrNull(inp.value);   // blank stays blank (red), never 0
                else r[f] = num(inp.value);
                if (f === 'kgm') persistKgm(q, r);
                refreshWeights(q, mountEl);   // patch in place — a full render here eats the next click
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
        // A blocked popup used to make Print look like a dead button — nothing opened and
        // nothing was said, so the user clicked it again and again.
        if (!win) {
            alert('Your browser blocked the print window.\n\nAllow pop-ups for this site, then click Print again.');
            return;
        }
        win.document.write('<html><head><title>Weight — ' + escTxt(name) + '</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#20201d;">'
            + '<h2 style="margin:0 0 4px;">Weight summary</h2><p style="margin:0 0 8px;color:#666;font-size:13px;">' + escTxt(name) + '</p>'
            + '<h3 style="font-size:15px;margin:16px 0 6px;">' + escTxt(label) + ' &mdash; ' + fmtWeight(secWeight(st, sec)) + '</h3>'
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
            mountById[String(quotation.id)] = mountEl;   // so background work can repaint this panel
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
            secComplete: secComplete,
            // The enquiry weight gate — what stops a partial weight reaching transporters.
            enqScopeRows: enqScopeRows,
            enqScopeWeight: enqScopeWeight,
            enqUncountedRows: enqUncountedRows,
            enqScopeComplete: enqScopeComplete,
            enqWeightUsable: enqWeightUsable,
            enqEffectiveWeight: enqEffectiveWeight,
            buildEnquiryDraft: buildEnquiryDraft,
            freightItemsTableHtml: freightItemsTableHtml,
            enqTextToHtml: enqTextToHtml,
            checkFreightRepliesForQuote: checkFreightRepliesForQuote,
            fmtTonnes: fmtTonnes,
            fmtWeight: fmtWeight,
            // Keeping the panel in step with the quote, and the in-place repaint that replaced
            // the full re-render (which used to eat the first click after any edit).
            syncRowsWithQuote: syncRowsWithQuote,
            quoteRowId: quoteRowId,
            rowWeightHtml: rowWeightHtml,
            sectionTitleHtml: sectionTitleHtml,
            totalRowHtml: totalRowHtml,
            hasBadRecipient: hasBadRecipient,
            _setSuggest: function (s) { _freightSuggest = s; }
        };
    }
})();
