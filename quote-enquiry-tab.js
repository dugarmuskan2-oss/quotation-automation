/*
    ============================================
    ENQUIRY TAB (inside the quote card)
    ============================================
    The buying-side mirror of the Freight tab: ask suppliers/dealers for their best rate on the
    items you are quoting, without leaving the quote.

    Deliberate choices, all from the brief:
      - The rows use the SAME format and build logic as the standalone Enquiry Preparer
        (enquiry-preparer.js). buildEnquiryRowModel is reused verbatim via its _test export where
        available, so the two can never drift into two different "enquiry formats".
      - There is no "responses received at" field. Replies come back to the sending account.
      - Recipients go in BCC. One email per supplier (so each reply lands in its own thread and can
        be tracked), and within that email the supplier is BCC'd rather than in To.
      - Suppliers are remembered per PIPE TYPE (GI / ERW / Seamless). Suggestions show everyone,
        with the types in this quote floated to the top.

    Threads live on the quotation (q.supplierEnquiries) and are persisted through a field-only
    merge route, exactly like freight — never a whole-object save, which a stale tab can clobber.
*/
(function () {
    'use strict';

    var stateById = {};

    function stateFor(quotation) {
        var id = String(quotation.id);
        if (!stateById[id]) {
            stateById[id] = {
                built: false,          // has the user pressed "Create enquiry" yet
                rows: [],
                to: [],
                message: '',
                messageEdited: false,
                sending: false,
                sent: '',
                openReplies: {},
            };
        }
        return stateById[id];
    }

    // ── small helpers ─────────────────────────────────────────────────────────
    function escTxt(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function esc(v) { return escTxt(v); }
    function apiBase() {
        return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '/api';
    }
    function isEmail(v) {
        return typeof isValidEmailAddress === 'function'
            ? isValidEmailAddress(v)
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
    }

    // Bucket a line item to gi / erw / seamless. Mirrors normalizePipeType on the server and
    // rowIsSeamless in the freight module: the explicit type first, else the description.
    function pipeTypeOf(li) {
        var s = (String((li && li.identifiedPipeType) || '') + ' ' +
                 String((li && (li.originalDescription || li.description)) || '')).toLowerCase();
        if (s.indexOf('seamless') >= 0 || /\bsch\b/.test(s)) return 'seamless';
        if (s.indexOf('erw') >= 0) return 'erw';
        if (s.indexOf('gi') >= 0 || s.indexOf('galvan') >= 0) return 'gi';
        return '';
    }
    function quotePipeTypes(quotation) {
        var items = Array.isArray(quotation && quotation.lineItems) ? quotation.lineItems : [];
        var seen = {};
        items.forEach(function (li) {
            var t = pipeTypeOf(li);
            if (t) seen[t] = true;
        });
        return Object.keys(seen);
    }

    // Freight rows are not something a supplier quotes on.
    function isFreightRow(li) {
        return String((li && (li.originalDescription || li.description)) || '').trim().toLowerCase() === 'freight';
    }

    // ── rows: same shape and derivation as the standalone Enquiry Preparer ────
    // Reuse its builder when it is loaded, so the two views cannot drift apart.
    function rowFromLineItem(li) {
        var preparer = (typeof module !== 'undefined' && module.exports)
            ? null
            : (window.enquiryPreparerModel || null);
        var mapped = {
            description: li.originalDescription || li.description || '',
            quantity: li.quantity || '',
            unit: li.unit || li.uom || '',
            size: li.size || '',
            productSpec: li.productSpec || '',
        };
        if (preparer && typeof preparer.buildEnquiryRowModel === 'function') {
            try { return preparer.buildEnquiryRowModel(mapped); } catch (e) { /* fall through */ }
        }
        // Fallback with the same field names, so the emailed table is identical either way.
        return {
            productSpec: mapped.productSpec || mapped.description,
            size: mapped.size || mapped.description,
            qty: mapped.quantity,
            uom: mapped.unit || 'Mtrs',
            lengthReqByUs: '',
            makeRequiredByUs: '',
            rate: '',
            offerUom: '',
            makeOfferedByYou: '',
        };
    }

    function buildRowsFromQuote(quotation) {
        var items = Array.isArray(quotation && quotation.lineItems) ? quotation.lineItems : [];
        return items.filter(function (li) { return li && !isFreightRow(li); }).map(rowFromLineItem);
    }

    // ── the emailed table: OUR REQUIREMENT / YOUR OFFER, as the preparer builds it ────
    var OUR_COLS = ['Product / Spec', 'Size', 'Qty', 'UOM', 'Length req.', 'Make required'];
    var OFFER_COLS = ['Rate', 'UOM', 'Make offered'];

    function enquiryTableHtml(rows) {
        var head = '<tr>'
            + '<th colspan="' + OUR_COLS.length + '" style="background:#1f3864;color:#fff;padding:6px 8px;border:1px solid #999;">OUR REQUIREMENT (ENQUIRY)</th>'
            + '<th colspan="' + OFFER_COLS.length + '" style="background:#375623;color:#fff;padding:6px 8px;border:1px solid #999;">YOUR OFFER</th>'
            + '</tr><tr>'
            + OUR_COLS.concat(OFFER_COLS).map(function (c) {
                return '<th style="background:#f2f2f2;padding:5px 8px;border:1px solid #999;text-align:left;">' + escTxt(c) + '</th>';
            }).join('')
            + '</tr>';
        var body = rows.map(function (r, i) {
            var cells = [r.productSpec, r.size, r.qty, r.uom, r.lengthReqByUs, r.makeRequiredByUs, r.rate, r.offerUom, r.makeOfferedByYou];
            return '<tr>' + cells.map(function (c) {
                return '<td style="padding:5px 8px;border:1px solid #999;">' + escTxt(c) + '</td>';
            }).join('') + '</tr>';
        }).join('');
        return '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
            + head + body + '</table>';
    }

    function buildDraft(quotation) {
        return 'Dear Sir,\n\n'
            + 'Please share your best rate for the requirement below.\n\n'
            + '[TABLE]\n\n'
            + 'Kindly confirm availability and delivery time.\n\n'
            + 'Regards,\nDSC Pipes';
    }

    function messageToHtml(text, rows) {
        var safe = escTxt(text).replace(/\n/g, '<br>');
        return safe.replace('[TABLE]', enquiryTableHtml(rows));
    }

    // ── threads on the quotation ──────────────────────────────────────────────
    function getThreads(q) {
        if (!Array.isArray(q.supplierEnquiries)) q.supplierEnquiries = [];
        return q.supplierEnquiries;
    }
    // Field-only merge, like the freight route — never a whole-object save.
    function persistThreads(q) {
        if (!q || q.id == null) return;
        fetch(apiBase() + '/quotations/' + encodeURIComponent(q.id) + '/supplier-enquiries', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ supplierEnquiries: getThreads(q) })
        }).then(function (res) {
            if (!res.ok) console.error('Supplier enquiries not saved (' + res.status + ') for quote ' + q.id);
        }).catch(function (e) {
            console.error('Supplier enquiries not saved for quote ' + q.id + ':', e.message);
        });
    }

    // ── remembered suppliers, pipe-type ones first ────────────────────────────
    var _supplierSuggest = null;
    var _supplierSuggestLoading = false;
    var EMPTY_SUGGEST = { suppliers: [], byType: { gi: [], erw: [], seamless: [] } };

    function loadSupplierSuggestions(then) {
        if (_supplierSuggest) { then && then(); return; }
        if (_supplierSuggestLoading) return;
        _supplierSuggestLoading = true;
        fetch(apiBase() + '/get-supplier-suggestions')
            .then(function (r) { return r.json(); })
            .then(function (d) { _supplierSuggest = (d && d.suggestions) || EMPTY_SUGGEST; })
            .catch(function () { _supplierSuggest = EMPTY_SUGGEST; })
            .then(function () { _supplierSuggestLoading = false; then && then(); });
    }

    // Everyone we've emailed, with this quote's pipe types floated to the top.
    function suggestedSuppliers(quotation, query) {
        var s = _supplierSuggest || EMPTY_SUGGEST;
        var q = String(query || '').trim().toLowerCase();
        var out = [], seen = {};
        function add(list) {
            (list || []).forEach(function (t) {
                var key = String((t && t.email) || '').toLowerCase();
                if (!key || seen[key]) return;
                if (q && key.indexOf(q) === -1) return;
                seen[key] = true;
                out.push({ email: t.email, count: t.count || 0 });
            });
        }
        quotePipeTypes(quotation).forEach(function (t) { add(s.byType && s.byType[t]); });
        add(s.suppliers);   // then everyone else
        return out.slice(0, 12);
    }

    function recordSupplierUsage(recipients, quotation) {
        fetch(apiBase() + '/save-supplier-suggestions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipients: recipients, pipeTypes: quotePipeTypes(quotation) })
        }).then(function (r) { return r.json(); })
          .then(function (d) { if (d && d.suggestions) _supplierSuggest = d.suggestions; })
          .catch(function () { /* memory is best-effort */ });
    }

    // ── rendering ─────────────────────────────────────────────────────────────
    function threadsHtml(q, st) {
        var threads = getThreads(q);
        if (!threads.length) return '';
        var rows = threads.map(function (t, i) {
            var pill = t.replied
                ? '<span class="fwe-pill fwe-pill-replied">Replied</span>'
                : '<span class="fwe-pill fwe-pill-wait">Awaiting reply</span>';
            var read = t.replied
                ? '<button class="fwe-th-btn qet-read" data-i="' + i + '">' + (st.openReplies[i] ? 'Hide' : 'Read reply') + '</button>'
                : '';
            var body = (t.replied && st.openReplies[i])
                ? '<div class="qet-reply">' + escTxt(t.replyText || '(no text)').replace(/\n/g, '<br>') + '</div>'
                : '';
            return '<div class="qet-thread"><span class="qet-th-email">' + escTxt(t.email) + '</span>'
                + pill + read + '</div>' + body;
        }).join('');
        return '<div class="qet-threads"><div class="qet-h">Sent to</div>' + rows + '</div>';
    }

    function rowsTableHtml(st) {
        var head = '<tr><th>Product / Spec</th><th>Size</th><th>Qty</th><th>UOM</th><th>Length req.</th><th>Make required</th><th></th></tr>';
        var body = st.rows.map(function (r, i) {
            function cell(field, value, width) {
                return '<td><input class="qet-in" data-i="' + i + '" data-f="' + field + '" value="' + esc(value) + '"'
                    + (width ? ' style="width:' + width + ';"' : '') + '></td>';
            }
            return '<tr>'
                + cell('productSpec', r.productSpec)
                + cell('size', r.size, '110px')
                + cell('qty', r.qty, '70px')
                + cell('uom', r.uom, '70px')
                + cell('lengthReqByUs', r.lengthReqByUs, '90px')
                + cell('makeRequiredByUs', r.makeRequiredByUs, '110px')
                + '<td><button class="qet-del" data-i="' + i + '" title="Remove this row">&#128465;</button></td>'
                + '</tr>';
        }).join('');
        return '<table class="qet-tbl">' + head + body + '</table>';
    }

    function chipsHtml(st) {
        return st.to.map(function (a, i) {
            var bad = !isEmail(a);
            return '<span class="qet-chip' + (bad ? ' qet-chip-bad' : '') + '">' + escTxt(a)
                + '<button class="qet-chip-x" data-i="' + i + '" title="Remove">&times;</button></span>';
        }).join('');
    }

    function render(quotation, mountEl) {
        var st = stateFor(quotation);
        var threads = getThreads(quotation);

        if (!st.built && !threads.length) {
            var n = buildRowsFromQuote(quotation).length;
            mountEl.innerHTML = '<div class="qet"><div class="qet-empty">'
                + '<div class="qet-empty-h">No enquiry yet</div>'
                + '<p>Build a supplier enquiry from this quote&rsquo;s ' + n + ' item' + (n === 1 ? '' : 's')
                + ' &mdash; ask dealers for their best rates.</p>'
                + '<button class="qet-btn qet-create">&#128221; Create enquiry</button>'
                + '</div></div>';
            wire(quotation, mountEl);
            return;
        }

        if (!st.built) st.built = true;
        if (!st.rows.length && !threads.length) st.rows = buildRowsFromQuote(quotation);
        if (!st.messageEdited) st.message = buildDraft(quotation);

        var status = '';
        if (st.sending) status = '<div class="qet-status">Sending&hellip;</div>';
        else if (st.sent) {
            var ok = st.sent.slice(0, 3) === 'ok:';
            status = '<div class="qet-status" style="color:' + (ok ? '#0F6E56' : '#A32D2D') + ';">'
                + (ok ? '✓ ' : '⚠ ') + escTxt(st.sent.slice(st.sent.indexOf(':') + 1)) + '</div>';
        }

        var canSend = st.to.length && !st.sending && st.to.every(isEmail) && st.rows.length;
        mountEl.innerHTML = '<div class="qet">'
            + '<div class="qet-h">Enquiry &middot; ' + st.rows.length + ' item' + (st.rows.length === 1 ? '' : 's')
            + ' <span class="qet-sub">built from the quote</span></div>'
            + rowsTableHtml(st)
            + '<div class="qet-rowbtns"><button class="qet-btn qet-add">+ Add item</button></div>'
            + '<label class="qet-lbl">To &mdash; suppliers / dealers <span class="qet-sub">(sent on BCC, one email each)</span></label>'
            + '<div class="qet-field"><span class="qet-chips">' + chipsHtml(st) + '</span>'
            + '<input class="qet-input" type="text" placeholder="Type a supplier name or email" autocomplete="off"></div>'
            + '<div class="qet-suggest"></div>'
            + '<p class="qet-note">Suggests suppliers you&rsquo;ve emailed before &mdash; the ones you use for this quote&rsquo;s pipe types come first. Each supplier gets their own email and is BCC&rsquo;d, so nobody sees anyone else.</p>'
            + '<label class="qet-lbl">Message (editable) &mdash; [TABLE] is replaced by the enquiry table</label>'
            + '<textarea class="qet-msg">' + escTxt(st.message) + '</textarea>'
            + '<div class="qet-sendrow"><button class="qet-btn qet-send"' + (canSend ? '' : ' disabled') + '>&#9993; Send enquiry</button></div>'
            + status
            + threadsHtml(quotation, st)
            + '</div>';
        wire(quotation, mountEl);
    }

    // ── events ────────────────────────────────────────────────────────────────
    function wire(quotation, mountEl) {
        var st = stateFor(quotation);
        var $ = function (s) { return mountEl.querySelector(s); };
        var $$ = function (s) { return Array.prototype.slice.call(mountEl.querySelectorAll(s)); };

        var create = $('.qet-create');
        if (create) create.onclick = function () {
            st.built = true;
            st.rows = buildRowsFromQuote(quotation);
            loadSupplierSuggestions(function () { render(quotation, mountEl); });
            render(quotation, mountEl);
        };

        $$('.qet-in').forEach(function (el) {
            el.oninput = function () {
                var r = st.rows[Number(el.dataset.i)];
                if (r) r[el.dataset.f] = el.value;
            };
        });
        $$('.qet-del').forEach(function (el) {
            el.onclick = function () { st.rows.splice(Number(el.dataset.i), 1); render(quotation, mountEl); };
        });
        var add = $('.qet-add');
        if (add) add.onclick = function () {
            st.rows.push({ productSpec: '', size: '', qty: '', uom: 'Mtrs', lengthReqByUs: '', makeRequiredByUs: '', rate: '', offerUom: '', makeOfferedByYou: '' });
            render(quotation, mountEl);
        };

        $$('.qet-chip-x').forEach(function (el) {
            el.onclick = function () { st.to.splice(Number(el.dataset.i), 1); render(quotation, mountEl); };
        });

        var input = $('.qet-input');
        var suggest = $('.qet-suggest');
        function addRecip(v) {
            var email = String(v || '').trim().replace(/[;,]$/, '');
            if (!email) return;
            if (st.to.indexOf(email) === -1) st.to.push(email);
            render(quotation, mountEl);
        }
        function paintSuggestions() {
            if (!suggest) return;
            var list = suggestedSuppliers(quotation, input ? input.value : '')
                .filter(function (s) { return st.to.indexOf(s.email) === -1; });
            suggest.innerHTML = list.length
                ? list.map(function (s) { return '<button class="qet-sg" data-e="' + esc(s.email) + '">' + escTxt(s.email) + '</button>'; }).join('')
                : '';
            $$('.qet-sg').forEach(function (el) {
                el.onclick = function () { addRecip(el.dataset.e); };
            });
        }
        if (input) {
            input.oninput = paintSuggestions;
            input.onfocus = function () { loadSupplierSuggestions(paintSuggestions); paintSuggestions(); };
            input.onkeydown = function (e) {
                if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); addRecip(input.value); }
            };
            input.onblur = function () { if (input.value.trim()) addRecip(input.value); };
        }
        loadSupplierSuggestions(paintSuggestions);

        var msg = $('.qet-msg');
        if (msg) msg.oninput = function () { st.message = msg.value; st.messageEdited = true; };

        var send = $('.qet-send');
        if (send) send.onclick = function () { sendEnquiry(quotation, mountEl); };

        $$('.qet-read').forEach(function (el) {
            el.onclick = function () {
                var i = Number(el.dataset.i);
                st.openReplies[i] = !st.openReplies[i];
                render(quotation, mountEl);
            };
        });
    }

    // ── sending ───────────────────────────────────────────────────────────────
    // One email per supplier so each reply lands in its own thread (that is what lets us show
    // who replied). Within each email the supplier is BCC'd rather than in To, per the brief.
    function sendEnquiry(quotation, mountEl) {
        var st = stateFor(quotation);
        if (!st.to.length || st.sending || !st.rows.length) return;
        if (!st.to.every(isEmail)) { st.sent = 'err:Check the highlighted email addresses.'; render(quotation, mountEl); return; }

        var subject = 'Enquiry' + (quotation.quoteNumber ? ' — ' + quotation.quoteNumber : '');
        var bodyHtml = messageToHtml(st.message, st.rows);
        var recipients = st.to.slice();
        st.sending = true; st.sent = '';
        render(quotation, mountEl);

        Promise.all(recipients.map(function (addr) {
            return fetch(apiBase() + '/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // bcc carries the supplier; `to` is our own account so the message is well-formed.
                body: JSON.stringify({ to: '', bcc: addr, subject: subject, bodyHtml: bodyHtml })
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (d) {
                    return { addr: addr, ok: res.ok && d && d.success, d: d };
                });
            }).catch(function (e) { return { addr: addr, ok: false, d: { error: e.message } }; });
        })).then(function (results) {
            st.sending = false;
            var threads = getThreads(quotation);
            var sentOk = results.filter(function (r) { return r.ok; });
            sentOk.forEach(function (r) {
                threads.push({
                    email: r.addr,
                    threadId: (r.d && r.d.threadId) || '',
                    sentAt: new Date().toISOString(),
                    replied: false, replyText: '', rate: 0,
                });
            });
            var failed = results.filter(function (r) { return !r.ok; });
            if (!failed.length) {
                st.sent = 'ok:Enquiry sent to ' + sentOk.length + ' supplier' + (sentOk.length > 1 ? 's' : '') + '.';
                st.to = [];
            } else if (sentOk.length) {
                st.sent = 'err:Sent to ' + sentOk.length + ', but failed for ' + failed.map(function (r) { return r.addr; }).join(', ') + '.';
                st.to = failed.map(function (r) { return r.addr; });
            } else {
                st.sent = 'err:' + ((failed[0].d && failed[0].d.error) || 'Could not send. Check Gmail is set up.');
            }
            if (sentOk.length) {
                persistThreads(quotation);
                recordSupplierUsage(sentOk.map(function (r) { return r.addr; }), quotation);
            }
            render(quotation, mountEl);
        });
    }

    // ── public surface ────────────────────────────────────────────────────────
    if (typeof window !== 'undefined') {
        window.renderQuoteEnquiryTab = function (quotation, mountEl) {
            if (!quotation || !mountEl) return;
            render(quotation, mountEl);
        };
        // Quotes with at least one supplier enquiry sent — powers the Enquiry filter button.
        window.quoteHasSupplierEnquiry = function (q) {
            return !!(q && Array.isArray(q.supplierEnquiries) && q.supplierEnquiries.length > 0);
        };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports._test = {
            pipeTypeOf: pipeTypeOf,
            quotePipeTypes: quotePipeTypes,
            isFreightRow: isFreightRow,
            rowFromLineItem: rowFromLineItem,
            buildRowsFromQuote: buildRowsFromQuote,
            enquiryTableHtml: enquiryTableHtml,
            messageToHtml: messageToHtml,
            buildDraft: buildDraft,
            suggestedSuppliers: suggestedSuppliers,
            _setSuggest: function (s) { _supplierSuggest = s; },
        };
    }
})();
