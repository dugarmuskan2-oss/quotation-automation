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

    // ── rows: built by the Enquiry Preparer's OWN code, not a lookalike ───────
    // The whole chain is the preparer's: normalizeQuotation maps the quote's line items to its
    // intermediate shape, then buildEnquiryRowModel derives each column — size via
    // extractSizeFromDescription, product/spec via inferProductSpecFromText, UOM from the item.
    // Re-implementing any of that is how the two drifted before (the Size column ended up holding
    // the whole description, and the UOM defaulted differently).
    function preparerModel() {
        return (typeof window !== 'undefined' && window.enquiryPreparerModel) ? window.enquiryPreparerModel : null;
    }

    // The quantity heading the quote table ships with. Anything else means the user retyped it —
    // usually to bill by weight ("WEIGHT (KGS)") — and we must not then claim metres.
    var DEFAULT_QTY_HEADING = 'QTY (MTRS)';
    var DEFAULT_UOM = 'Meters';

    // Read the quantity column heading off the quote's own stored table.
    // getPdfColLabelsFromTable (index.html) already resolves that heading, including the case
    // where the user renamed it, so this defers to it rather than re-deriving the rule.
    function qtyHeadingOf(quotation) {
        var html = quotation && quotation.tableHTML;
        if (!html || typeof document === 'undefined') return '';
        if (typeof window === 'undefined' || typeof window.getPdfColLabelsFromTable !== 'function') return '';
        try {
            var holder = document.createElement('div');
            holder.innerHTML = html;
            var table = holder.querySelector('table');
            if (!table) return '';
            var labels = window.getPdfColLabelsFromTable(table);
            return (labels && labels[2]) ? String(labels[2]).trim() : '';
        } catch (e) {
            return '';
        }
    }

    // 'Meters' only while the quote still says it is quoting metres. If the heading was retyped,
    // or we cannot read it at all, leave the column blank rather than guess a unit onto an
    // enquiry that goes out to a supplier.
    function defaultUomFor(quotation) {
        var heading = qtyHeadingOf(quotation);
        if (!heading) return '';
        return heading.toUpperCase() === DEFAULT_QTY_HEADING ? DEFAULT_UOM : '';
    }

    function buildRowsFromQuote(quotation) {
        var items = Array.isArray(quotation && quotation.lineItems) ? quotation.lineItems : [];
        var live = items.filter(function (li) { return li && !isFreightRow(li); });
        var fallbackUom = defaultUomFor(quotation);
        var applyUom = function (row) {
            if (row && !row.uom) row.uom = fallbackUom;
            return row;
        };
        var model = preparerModel();
        if (model && model.normalizeQuotation && model.buildEnquiryRowModel) {
            var normalized = model.normalizeQuotation({ lineItems: live });
            return (normalized ? normalized.lineItems : []).map(model.buildEnquiryRowModel).map(applyUom);
        }
        // enquiry-preparer.js not loaded (it initialises on DOMContentLoaded). Same field names so
        // the table still renders; the tab re-renders once the model is available.
        return live.map(function (li) {
            var desc = li.originalDescription || li.description || '';
            return {
                productSpec: String(li.productSpec || li.identifiedPipeType || '').trim() || desc,
                size: String(li.size || '').trim(),
                qty: String(li.quantity || li.qty || '').trim(),
                uom: String(li.unit || li.uom || '').trim(),
                lengthReqByUs: '', makeRequiredByUs: '', rate: '', offerUom: '', makeOfferedByYou: '',
            };
        });
    }

    // ── the emailed table: byte-for-byte the Enquiry Preparer's layout ────────
    // Colours, borders, zebra striping, column names and the S.NO column all match
    // buildEnquiryHtmlForCopy in enquiry-preparer.js — a supplier must not be able to tell
    // which screen the enquiry was sent from.
    var BORDER = 'border:1px solid #000;';
    function th(text, bg, color) {
        return '<th style="background:' + bg + ';color:' + color + ';' + BORDER + 'padding:8px;text-align:center;">' + escTxt(text) + '</th>';
    }
    function thGroup(text, colspan, bg, color) {
        return '<th colspan="' + colspan + '" style="background:' + bg + ';color:' + color + ';' + BORDER + 'padding:8px;text-align:center;font-weight:700;">' + escTxt(text) + '</th>';
    }

    function enquiryTableHtml(rows) {
        var reqA = { bg: '#ffffff', color: '#0b4aa2' };
        var reqB = { bg: '#0b4aa2', color: '#ffffff' };
        var offA = { bg: '#2e7d32', color: '#ffffff' };
        var offB = { bg: '#ffffff', color: '#2e7d32' };
        var colHeaderRow = [
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

        var tableRows = rows.map(function (r, idx) {
            var bg = (idx % 2 === 0) ? '#ffffff' : '#eef5ff';
            var cellBase = BORDER + 'padding:8px;background-color:' + bg + ';';
            function td(v, align) {
                return '<td bgcolor="' + bg + '" style="' + cellBase + (align ? 'text-align:' + align + ';' : '') + '">' + escTxt(v) + '</td>';
            }
            return '<tr>'
                + td(idx + 1, 'center')
                + td(r.productSpec)
                + td(r.size)
                + td(r.qty, 'right')
                + td(r.uom, 'center')
                + td(r.lengthReqByUs, 'center')
                + td(r.makeRequiredByUs, 'center')
                + td(r.rate, 'center')
                + td(r.offerUom, 'center')
                + td(r.makeOfferedByYou, 'center')
                + '</tr>';
        }).join('');

        return '<table cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt;">'
            + '<thead><tr>'
            + thGroup('OUR REQUIREMENT (ENQUIRY)', 7, '#0b4aa2', '#fff')
            + thGroup('YOUR OFFER', 3, '#2e7d32', '#fff')
            + '</tr><tr>' + colHeaderRow + '</tr></thead>'
            + '<tbody>' + tableRows + '</tbody></table>';
    }

    // The Enquiry Preparer's default message — taken from IT, not copied, so editing the wording
    // there changes it here too.
    function buildDraft(quotation) {
        var model = preparerModel();
        var header = (model && model.defaultHeaderText)
            ? model.defaultHeaderText()
            : "Dear Sir/Ma'am,\n\nKINDLY QUOTE YOUR BEST RATE WITH MINIMUM DELIVERY PERIOD.\n\nNOTE: PLEASE MENTION UOM (MTR /KG /MT - METRIC TON) CLEARLY.";
        return header + '\n\n[TABLE]';
    }

    // Header lines are rendered the way the preparer renders them: each line its own div, and
    // the greeting bolder than the rest.
    function headerLinesHtml(text) {
        return String(text || '').split(/\r?\n/).map(function (l) {
            var weight = l.trim().toUpperCase() === 'DEAR SIR' || /^dear sir\/ma'am,?$/i.test(l.trim()) ? '700' : '600';
            return '<div style="font-weight:' + weight + '; margin:2px 0;">' + escTxt(l) + '</div>';
        }).join('');
    }

    // The signature the app already sends with quotations (Settings → Default Email Signature).
    // Cached after the first fetch; empty string when none is configured.
    var _signatureHtml = null;
    function loadSignature(then) {
        if (_signatureHtml !== null) { then && then(); return; }
        fetch(apiBase() + '/get-default-signature')
            .then(function (r) { return r.json(); })
            .then(function (d) { _signatureHtml = (d && d.content) || ''; })
            .catch(function () { _signatureHtml = ''; })
            .then(function () { then && then(); });
    }

    function messageToHtml(text, rows) {
        var parts = String(text || '').split('[TABLE]');
        var before = headerLinesHtml(parts[0].replace(/\n+$/, ''));
        var after = parts.length > 1 ? headerLinesHtml(parts[1].replace(/^\n+/, '')) : '';
        var sig = _signatureHtml ? '<div style="height:14px;"></div>' + _signatureHtml : '';
        return '<div style="font-family: Arial, sans-serif; color:#111; font-size:13px;">'
            + before
            + '<div style="height:10px;"></div>'
            + enquiryTableHtml(rows)
            + (after ? '<div style="height:10px;"></div>' + after : '')
            + sig
            + '</div>';
    }

    // ── threads on the quotation ──────────────────────────────────────────────
    function getThreads(q) {
        if (!Array.isArray(q.supplierEnquiries)) q.supplierEnquiries = [];
        return q.supplierEnquiries;
    }
    // Field-only merge, like the freight route — never a whole-object save.
    // onFail is optional: the send flow passes one so a lost save is SAID on screen. Losing this
    // write silently meant the emails really went out but the "Sent to / Awaiting reply" tracking
    // vanished on reload — the reply sweep never watched those threads, the quote dropped off the
    // Enquiry filter, and the natural next step was re-sending the same enquiry to everyone.
    function persistThreads(q, onFail) {
        if (!q || q.id == null) return Promise.resolve(false);
        var post = function () {
            return fetch(apiBase() + '/quotations/' + encodeURIComponent(q.id) + '/supplier-enquiries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ supplierEnquiries: getThreads(q), enquirySentBodies: getSentBodies(q) })
            }).then(function (res) { return res.ok; }).catch(function () { return false; });
        };
        return post().then(function (ok) { return ok || post(); }).then(function (ok) {
            if (!ok) {
                console.error('Supplier enquiries not saved for quote ' + q.id);
                if (onFail) onFail();
            }
            return ok;
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

    // ── pulling supplier replies ──────────────────────────────────────────────
    // Mirrors checkFreightRepliesForQuote in freight-tab-weight-editor.js, with one deliberate
    // difference: NO rate parsing. A transporter quotes a single freight figure worth extracting;
    // a supplier's reply is a price list against many sizes, so guessing one number from it would
    // be worse than useless. We store the reply and let a human read it.
    var MAX_REPLY_CHARS = 2000;
    function trimReplyForStorage(text) {
        // Drop the quoted chain (our own enquiry below "On … wrote:") and cap what is left:
        // these bodies ride inside the quotation record.
        var s = String(text || '');
        var quoteIdx = s.search(/^On .+wrote:\s*$/m);
        if (quoteIdx > 0) s = s.slice(0, quoteIdx).replace(/\s+$/, '');
        return s.length > MAX_REPLY_CHARS ? (s.slice(0, MAX_REPLY_CHARS) + '\n…[truncated]') : s;
    }

    // Headless — no UI, safe to run across many quotes at once. Returns { checked, newReplies }.
    function checkSupplierRepliesForQuote(q) {
        var threads = getThreads(q);
        var waiting = threads.filter(function (t) { return t && !t.replied && t.threadId; });
        if (!waiting.length) return Promise.resolve({ checked: 0, newReplies: 0 });
        return Promise.all(waiting.map(function (t) {
            return fetch(apiBase() + '/thread-messages?threadId=' + encodeURIComponent(t.threadId))
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (data) {
                    if (!data || !Array.isArray(data.messages)) return false;
                    // direction 'you' is anything Gmail marked SENT — including our own enquiry,
                    // which carries both SENT and INBOX because a Bcc-only send is addressed to
                    // us. `auto` drops out-of-office and mailer-daemon noise.
                    var replies = data.messages.filter(function (m) { return m.direction === 'customer' && !m.auto; });
                    if (!replies.length) return false;
                    var last = replies[replies.length - 1];
                    t.replied = true;
                    t.replyAt = last.date || '';
                    t.replyText = trimReplyForStorage(last.body || last.snippet || '');
                    return true;
                })
                .catch(function () { return false; /* leave awaiting; the next sweep retries */ });
        })).then(function (flags) {
            var newReplies = flags.filter(Boolean).length;
            if (newReplies) persistThreads(q);
            return { checked: waiting.length, newReplies: newReplies };
        });
    }

    // Does this quote have a supplier enquiry still waiting? Keeps the sweep's working set small.
    function quoteAwaitsSupplierReply(q) {
        return (Array.isArray(q && q.supplierEnquiries) ? q.supplierEnquiries : [])
            .some(function (t) { return t && !t.replied && t.threadId; });
    }

    // ── rendering ─────────────────────────────────────────────────────────────
    function threadsHtml(q, st) {
        var threads = getThreads(q);
        if (!threads.length) return '';
        // Newest send first. The index is carried alongside rather than recomputed: it keys
        // st.openReplies and the "Read reply" button's data-i, so sorting the array itself would
        // open a different supplier's reply than the one clicked. sentAt is an ISO stamp, so a
        // plain string compare is chronological.
        var rows = threads
            .map(function (t, i) { return { t: t, i: i }; })
            .sort(function (a, b) {
                return String(b.t.sentAt || '').localeCompare(String(a.t.sentAt || ''));
            })
            .map(function (entry) {
            var t = entry.t, i = entry.i;
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

    // The on-screen editor, matching the standalone Enquiry Preparer's table exactly: the same two
    // header rows (blue OUR REQUIREMENT / green YOUR OFFER), the same eleven columns in the same
    // order with the same alternating header colours, per-row add/delete buttons, and a bordered
    // input in every cell so it is obvious what can be typed in.
    // An empty row in the same shape the Preparer produces.
    function blankRow() {
        return { productSpec: '', size: '', qty: '', uom: '', lengthReqByUs: '', makeRequiredByUs: '', rate: '', offerUom: '', makeOfferedByYou: '' };
    }

    function rowsTableHtml(st) {
        var head = '<thead>'
            + '<tr>'
            + '<th class="qet-group" colspan="2"></th>'
            + '<th class="qet-group" colspan="6">OUR REQUIREMENT (ENQUIRY)</th>'
            + '<th class="qet-group-offer" colspan="3">YOUR OFFER</th>'
            + '</tr><tr>'
            + '<th class="qet-req-a" style="width:72px;">ACTIONS</th>'
            + '<th class="qet-req-b" style="width:64px;">S. NO</th>'
            + '<th class="qet-req-a">PRODUCT &amp; SPECIFICATION</th>'
            + '<th class="qet-req-b" style="width:140px;">SIZE</th>'
            + '<th class="qet-req-a" style="width:90px;">QTY</th>'
            + '<th class="qet-req-b" style="width:90px;">UOM</th>'
            + '<th class="qet-req-a" style="width:150px;">LENGTH REQ BY US</th>'
            + '<th class="qet-req-b" style="width:150px;">MAKE REQUIRED BY US</th>'
            + '<th class="qet-offer-a" style="width:110px;">RATE</th>'
            + '<th class="qet-offer-b" style="width:90px;">UOM</th>'
            + '<th class="qet-offer-a" style="width:150px;">MAKE OFFERED BY YOU</th>'
            + '</tr></thead>';

        var body = st.rows.map(function (r, i) {
            function cell(field, value) {
                // textarea, not input: an input clips a long value ('8" NB X 6.0mm thk' was cut
                // mid-word). rows=1 plus autosize keeps it one line until it genuinely needs two.
                return '<td><textarea class="qet-in" rows="1" data-i="' + i + '" data-f="' + field + '">' + esc(value) + '</textarea></td>';
            }
            return '<tr>'
                + '<td><div class="qet-actions-cell">'
                + '<button class="qet-add-row qet-act qet-act-add" data-i="' + i + '" title="Add a row below" aria-label="Add a row below">+</button>'
                + '<button class="qet-del qet-act qet-act-del" data-i="' + i + '" title="Remove this row" aria-label="Remove this row">&minus;</button>'
                + '</div></td>'
                + '<td class="qet-sno">' + (i + 1) + '</td>'
                + cell('productSpec', r.productSpec)
                + cell('size', r.size)
                + cell('qty', r.qty)
                + cell('uom', r.uom)
                + cell('lengthReqByUs', r.lengthReqByUs)
                + cell('makeRequiredByUs', r.makeRequiredByUs)
                + cell('rate', r.rate)
                + cell('offerUom', r.offerUom)
                + cell('makeOfferedByYou', r.makeOfferedByYou)
                + '</tr>';
        }).join('');

        // Wrapped so a wide table scrolls sideways inside the card rather than stretching it.
        return '<div class="qet-tbl-wrap"><table class="qet-tbl">' + head + '<tbody>' + body + '</tbody></table></div>';
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
            + '<label class="qet-lbl">Message (editable) &mdash; [TABLE] is replaced by the enquiry table, and your standard signature is added below it</label>'
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

        // Grow each cell to fit its content, so nothing is clipped and long values wrap.
        function autosize(el) {
            el.style.height = 'auto';
            el.style.height = Math.max(el.scrollHeight, 20) + 'px';
        }
        $$('.qet-in').forEach(function (el) {
            autosize(el);
            el.oninput = function () {
                var r = st.rows[Number(el.dataset.i)];
                if (r) r[el.dataset.f] = el.value;
                autosize(el);
            };
        });
        $$('.qet-del').forEach(function (el) {
            el.onclick = function () { st.rows.splice(Number(el.dataset.i), 1); render(quotation, mountEl); };
        });
        $$('.qet-add-row').forEach(function (el) {
            el.onclick = function () {
                st.rows.splice(Number(el.dataset.i) + 1, 0, blankRow());
                render(quotation, mountEl);
            };
        });
        var add = $('.qet-add');
        if (add) add.onclick = function () {
            st.rows.push(blankRow());
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
            // The same Gmail-style dropdown the Freight tab uses: it searches your Gmail
            // contacts (People API) and merges in the suppliers we remember, ranked by the
            // pipe types on THIS quote. Without this the tab only ever offered the remembered
            // list, as a row of small chips — so an address never emailed before could not be
            // completed at all, and it looked like the field simply had no suggestions.
            if (typeof attachContactAutocomplete === 'function') {
                attachContactAutocomplete(input.parentElement || input, input, addRecip, function (query) {
                    return suggestedSuppliers(quotation, query)
                        .filter(function (s) { return st.to.indexOf(s.email) === -1; })
                        .map(function (s) { return { name: '', email: s.email }; });
                });
            }
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
        var recipients = st.to.slice();
        st.sending = true; st.sent = '';
        render(quotation, mountEl);
        // Make sure the standard signature is in hand before building the body, so the enquiry
        // is signed the same way a quotation is.
        loadSignature(function () { doSend(quotation, mountEl, st, subject, recipients); });
    }

    // Keep a copy of what actually went out, so the shared quote page can show the enquiry back
    // instead of only recording that one was sent.
    //
    // It is stored in q.enquirySentBodies, a top-level map, NOT inside the thread object: the
    // thread arrays are projected into every quotations-list page, and a body is kilobytes.
    // Inline base64 images (a pasted signature logo is routinely 100 kB) are dropped and the
    // whole thing capped — losing a logo from a record costs nothing.
    // The cap has to clear a REAL enquiry. Each row of the table carries its inline styling, so a
    // line item costs a bit over 1 kB — 12 kB (the first attempt) cut a 15-item enquiry off after
    // eight rows. 60 kB clears roughly fifty items, and the server bounds the total per quote.
    var MAX_SENT_HTML = 60000;
    var TRUNCATION_NOTE = '<p><i>[This stored copy was shortened. The full enquiry was sent.]</i></p>';
    function trimSentBodyForStorage(html) {
        var s = String(html || '')
            .replace(/\ssrc\s*=\s*"data:[^"]*"/gi, ' src=""')
            .replace(/\ssrc\s*=\s*'data:[^']*'/gi, " src=''");
        if (s.length <= MAX_SENT_HTML) return s;
        // Cut back to the last tag boundary. A blind slice lands mid-attribute, and the reader's
        // innerHTML parse then quietly drops the broken tag and auto-closes the table — producing
        // a tidy, complete-LOOKING enquiry that is missing rows. Say so instead.
        var cut = s.slice(0, MAX_SENT_HTML);
        var lastTag = cut.lastIndexOf('<');
        if (lastTag > 0) cut = cut.slice(0, lastTag);
        return cut + TRUNCATION_NOTE;
    }

    // Keyed by the SEND, not the recipient: one enquiry emailed to eight suppliers is one document,
    // and storing eight identical copies burned eight of the quote's storage slots.
    // An ISO timestamp sorts lexicographically in chronological order, which is what lets the
    // server evict the oldest reliably — it cannot depend on object key order surviving DynamoDB.
    function enquiryBodyKey(t) {
        return 'send:' + String((t && t.sentAt) || '');
    }

    function getSentBodies(quotation) {
        if (!quotation.enquirySentBodies || typeof quotation.enquirySentBodies !== 'object') {
            quotation.enquirySentBodies = {};
        }
        return quotation.enquirySentBodies;
    }

    function doSend(quotation, mountEl, st, subject, recipients) {
        var bodyHtml = messageToHtml(st.message, st.rows);
        var storedBody = trimSentBodyForStorage(bodyHtml);

        Promise.all(recipients.map(function (addr) {
            return fetch(apiBase() + '/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // bcc carries the supplier; `to` is our own account so the message is well-formed.
                // label tags the thread Quotation Automation/Enquiry Sent by us in Gmail.
                body: JSON.stringify({ to: '', bcc: addr, subject: subject, bodyHtml: bodyHtml, label: 'supplier' })
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (d) {
                    return { addr: addr, ok: res.ok && d && d.success, d: d };
                });
            }).catch(function (e) { return { addr: addr, ok: false, d: { error: e.message } }; });
        })).then(function (results) {
            st.sending = false;
            var threads = getThreads(quotation);
            var sentOk = results.filter(function (r) { return r.ok; });
            var bodies = getSentBodies(quotation);
            // ONE timestamp for the whole send, not one per recipient: it is a single enquiry,
            // and it is what ties every recipient's thread to the one stored copy of the body.
            var sentAt = new Date().toISOString();
            sentOk.forEach(function (r) {
                threads.push({
                    email: r.addr,
                    threadId: (r.d && r.d.threadId) || '',
                    sentAt: sentAt,
                    replied: false, replyText: '', rate: 0,
                });
            });
            if (sentOk.length) bodies[enquiryBodyKey({ sentAt: sentAt })] = storedBody;
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
                persistThreads(quotation, function () {
                    // The emails went out; only the record of them failed to save. Say so where
                    // the user is already looking, instead of a console line nobody sees.
                    st.sent = 'err:Enquiry WAS sent, but saving its record failed — reply tracking may be lost. Do not re-send; reload and check the Sent to list.';
                    render(quotation, mountEl);
                });
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
        // Used by the global "Check all replies" sweep in index.html, which also runs on open.
        window.checkSupplierRepliesForQuote = checkSupplierRepliesForQuote;
        window.quoteAwaitsSupplierReply = quoteAwaitsSupplierReply;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports._test = {
            pipeTypeOf: pipeTypeOf,
            quotePipeTypes: quotePipeTypes,
            isFreightRow: isFreightRow,
            buildRowsFromQuote: buildRowsFromQuote,
            enquiryTableHtml: enquiryTableHtml,
            messageToHtml: messageToHtml,
            buildDraft: buildDraft,
            suggestedSuppliers: suggestedSuppliers,
            _setSuggest: function (s) { _supplierSuggest = s; },
        };
    }
})();
