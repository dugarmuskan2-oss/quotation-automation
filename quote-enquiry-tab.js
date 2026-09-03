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
    var mountById = {};   // quote id -> the tab element on screen, for background repaints

    function stateFor(quotation) {
        var id = String(quotation.id);
        if (!stateById[id]) {
            stateById[id] = {
                built: false,          // has the user pressed "Create enquiry" yet
                rows: [],
                // bcc IS the recipient list (one email per supplier); cc is copied on every one.
                cc: [],
                bcc: [],
                message: '',
                messageEdited: false,
                sending: false,
                sent: '',
                // True from a fully successful send until the recipients or the message change,
                // so an impatient second press cannot re-send the same enquiry.
                sentLock: false,
                checking: false,      // a "Check for replies" read is in flight
                checkResult: '',      // what that read found, in the owner's words
                openReplies: {},
            };
        }
        // Older in-page state may predate these (or still carry the old `to`) — fill them in
        // rather than letting .concat() throw, and carry any typed recipients across.
        if (!Array.isArray(stateById[id].cc)) stateById[id].cc = [];
        if (!Array.isArray(stateById[id].bcc)) {
            stateById[id].bcc = Array.isArray(stateById[id].to) ? stateById[id].to : [];
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

    function threadsForUsage(sentOk, quote, asked) {
        var out = [];
        (sentOk || []).forEach(function (r) {
            var thread = (r.d && r.d.threadId) || '';
            chipAddrs(r.addr).map(bareAddress).filter(Boolean).forEach(function (email) {
                out.push({ email: email, thread: thread, quote: quote || '', asked: asked || '' });
            });
        });
        return out;
    }

    // The thread each REPLY came back on, so the right enquiry is the one marked answered —
    // the same supplier can be asked twice in a day.
    function repliedThreadsForUsage(threads) {
        return (threads || [])
            .filter(function (t) { return t && t.replied && t.email && t.threadId; })
            .reduce(function (acc, t) {
                return acc.concat(String(t.email).split(/[,;]+/).map(function (e) {
                    return { email: e.trim(), thread: t.threadId };
                }));
            }, [])
            .filter(function (x) { return x.email; });
    }

    // Tell the Partner Directory a supplier answered — the reply is detected here and
    // nowhere else, so without this the directory's "replied %" never moves off 0.
    function tellDirectoryReplied(threads) {
        if (typeof window === 'undefined' || !window.partnerDirectory) return;
        var emails = (threads || []).filter(function (t) { return t && t.replied && t.email; })
            .reduce(function (acc, t) { return acc.concat(String(t.email).split(/[,;]+/)); }, [])
            .map(function (s) { return s.trim(); }).filter(Boolean);
        if (!emails.length) return;
        window.partnerDirectory.recordUsage({
            emails: emails, kind: 'reply', role: 'dealer',
            threads: repliedThreadsForUsage(threads),
        });
    }

    // One chip can hold several addresses from the SAME firm. They ride on one email and are
    // Cc'd, so colleagues see each other; different chips are different firms and are always
    // separate emails, so no supplier ever learns who else was asked.
    function chipAddrs(chip) {
        return String(chip || '').split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    }

    /**
     * ONE chip can hold several addresses — that is the whole point of it. Everyone at one
     * firm rides on one email, Cc'd together, so picking a supplier with two contacts puts
     * both in a single chip.
     *
     * Send was checking the chip as if it were one address, so a two-contact firm greyed the
     * button out with nothing on screen saying why. The only way out was to delete the chip
     * and type the addresses separately — which then sent two emails and lost the point.
     * The Freight tab always read chips this way; this tab did not.
     */
    function chipIsSendable(chip) {
        var parts = chipAddrs(chip);
        return parts.length > 0 && parts.every(isEmail);
    }

    // Which chip in this list already holds this address? -1 when nobody does.
    function chipHolding(list, addr) {
        var want = String(addr || '').trim().toLowerCase();
        for (var i = 0; i < list.length; i++) {
            var hit = chipAddrs(list[i]).some(function (a) { return a.toLowerCase() === want; });
            if (hit) return i;
        }
        return -1;
    }

    /**
     * Put a chip in the list WITHOUT ever splitting one firm across two chips.
     *
     * Each chip becomes its own email. Matching on the chip STRING meant picking a firm twice —
     * once with one contact ticked, once with two — left "a@x.com" and "a@x.com, b@x.com" side by
     * side, so that firm got the same enquiry twice and its own colleagues were split across the
     * two mails. So match on the ADDRESSES: anyone already present merges into the chip that
     * holds them, and only genuinely new people start a new chip.
     * Returns true when the list changed.
     */
    function addChip(list, chip) {
        var parts = chipAddrs(chip);
        if (!parts.length) return false;

        // EVERY chip already holding any of these people, not just the first one found.
        // Taking only the first was the bug: with two colleagues sitting on separate chips —
        // which is what happens when they are added one at a time — merging into the first
        // left the second where it was, so that person got the same enquiry twice, in two
        // emails, from two threads.
        var hits = [];
        parts.forEach(function (a) {
            var at = chipHolding(list, a);
            if (at !== -1 && hits.indexOf(at) === -1) hits.push(at);
        });
        if (!hits.length) { list.push(parts.join(', ')); return true; }

        hits.sort(function (x, y) { return x - y; });
        var keep = hits[0];
        var merged = chipAddrs(list[keep]);
        var seen = {};
        merged.forEach(function (a) { seen[a.toLowerCase()] = true; });
        var grew = false;

        var add = function (a) {
            if (seen[a.toLowerCase()]) return;
            seen[a.toLowerCase()] = true; merged.push(a); grew = true;
        };
        // Fold the other chips for this firm in, then drop them — highest index first, so the
        // earlier positions are still valid as we go.
        hits.slice(1).reverse().forEach(function (at) {
            chipAddrs(list[at]).forEach(add);
            list.splice(at, 1);
            grew = true;
        });
        parts.forEach(add);

        if (grew) list[keep] = merged.join(', ');
        return grew;
    }

    // A list copied out of Outlook or Gmail arrives looking like:
    //     BOMBAY HARDWARE <a@b.com>, "Jindal PIPE INDUSTRIES (ALL DETAILS)" <c@d.com>
    // Splitting that on whitespace makes recipients out of "BOMBAY" and "HARDWARE"; splitting on
    // every comma cuts the quoted firm name in half. So walk the string and treat a comma,
    // semicolon or newline as a separator ONLY outside quotes and angle brackets.
    function splitAddressList(raw) {
        var out = [], cur = '', inQuote = false, inAngle = false;
        var s = String(raw || '');
        for (var i = 0; i < s.length; i++) {
            var ch = s[i];
            if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
            if (ch === '<' && !inQuote) { inAngle = true; cur += ch; continue; }
            if (ch === '>' && !inQuote) { inAngle = false; cur += ch; continue; }
            if ((ch === ',' || ch === ';' || ch === '\n') && !inQuote && !inAngle) { out.push(cur); cur = ''; continue; }
            cur += ch;
        }
        out.push(cur);
        return out.map(function (t) { return t.trim(); }).filter(Boolean);
    }

    // 'BOMBAY HARDWARE <a@b.com>' -> 'a@b.com'. A token with no angle-bracket address comes back
    // unchanged (minus wrapping quotes), so a bare name typed to search the contact dropdown
    // still reaches the caller intact.
    function bareAddress(token) {
        var t = String(token || '').trim();
        var m = /<([^<>]*@[^<>]*)>/.exec(t);
        if (m) return m[1].trim();
        return t.replace(/^["']+|["']+$/g, '').trim();
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

    // ── what the Partner Directory's "Ask AI" reads off this quote ────────────
    // One entry per pipe line, with its weight when kg/m AND quantity are both known.
    function enquiryNeedItems(quotation) {
        var items = Array.isArray(quotation && quotation.lineItems) ? quotation.lineItems : [];
        return items.filter(function (li) { return !isFreightRow(li); }).map(function (li) {
            var kgm = parseFloat(li && li.kgPerMeter), qty = parseFloat(li && li.quantity);
            return {
                product: String((li && (li.originalDescription || li.description)) || ''),
                kg: (isFinite(kgm) && kgm > 0 && isFinite(qty) && qty > 0) ? kgm * qty : null,
            };
        });
    }

    // Total kg ONLY when every line is computable — a partial sum quoted to a supplier is
    // how a wrong weight travels, so incomplete stays 0 and minimums go unchecked instead.
    function enquiryNeedKg(quotation) {
        var items = enquiryNeedItems(quotation);
        if (!items.length || items.some(function (i) { return i.kg === null; })) return 0;
        return Math.round(items.reduce(function (s, i) { return s + i.kg; }, 0));
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
                    // A read that FAILED is not a thread with no reply in it. Both used to come
                    // back false, so Gmail being down read as "nobody has answered".
                    if (!data || !Array.isArray(data.messages)) return 'failed';
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
                .catch(function () { return 'failed'; /* leave awaiting; the next sweep retries */ });
        })).then(function (flags) {
            // Only `true` is a reply. 'failed' is truthy too, so counting truthiness here would
            // report an unreachable Gmail as a fresh reply from every supplier.
            var newReplies = flags.filter(function (x) { return x === true; }).length;
            var failed = flags.filter(function (x) { return x === 'failed'; }).length;
            if (newReplies) {
                // Only tell the directory once the "answered" flag has actually saved. If the
                // save is lost, the next sweep finds the same reply again — counting it now
                // would push that firm's replied % past 100 with nothing to explain it.
                persistThreads(q).then(function (ok) { if (ok) tellDirectoryReplied(waiting); });
                // The sweep is background work, so its find has to reach an Enquiry tab that is
                // already open — otherwise the tab keeps saying "Awaiting reply" over a reply
                // that has already arrived, and the user concludes nobody answered.
                repaintOpenTab(q);
            }
            return { checked: waiting.length, newReplies: newReplies, failed: failed };
        });
    }

    // What the check found, in words the owner can act on. A read that failed must never be
    // reported as "no new replies" — that reads as "nobody answered you".
    function checkResultText(r) {
        var found = (r && r.newReplies) || 0;
        var failed = (r && r.failed) || 0;
        var got = found ? (found === 1 ? '1 new reply came in.' : found + ' new replies came in.') : '';
        if (failed) {
            var s = failed === 1 ? '1 supplier' : failed + ' suppliers';
            return (got ? got + ' ' : '') + 'Could not read Gmail for ' + s + ' — try again in a minute.';
        }
        return got || 'No new replies yet.';
    }

    // The button on this tab. The Freight tab has had one all along; here the only way to pull a
    // reply was to reload the whole app or find the global "Check all replies" far up the page.
    function checkSupplierReplies(q, st, mountEl) {
        if (st.checking) return;
        var threads = getThreads(q);
        var waiting = threads.filter(function (t) { return t && !t.replied && t.threadId; });
        if (!waiting.length) {
            st.checkResult = threads.length
                ? 'Nothing left to check — every supplier has replied.'
                : 'No enquiry has been sent yet.';
            render(q, mountEl);
            return;
        }
        st.checking = true; st.checkResult = '';
        render(q, mountEl);
        var done = function (text) { st.checking = false; st.checkResult = text; render(q, mountEl); };
        checkSupplierRepliesForQuote(q)
            .then(function (r) { done(checkResultText(r)); })
            .catch(function () { done('Could not check Gmail — try again in a minute.'); });
    }

    // Re-render this quote's Enquiry tab if it is on screen. No-op when the card is closed.
    function repaintOpenTab(q) {
        var mountEl = mountById[String(q.id)];
        if (!mountEl || !mountEl.isConnected) return;
        try { render(q, mountEl); } catch (e) { /* a repaint must never break the sweep */ }
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
        var anyWaiting = threads.some(function (t) { return t && !t.replied; });
        var checkBtn = anyWaiting
            ? '<button class="fwe-th-btn qet-check" style="margin-top:8px;"' + (st.checking ? ' disabled' : '') + '>'
              + (st.checking ? 'Checking&hellip;' : '&#8635; Check for replies') + '</button>'
            : '';
        var checkStatus = st.checkResult
            ? '<div class="qet-check-status" style="margin-top:6px;font-size:12px;color:#6b6862;">'
              + escTxt(st.checkResult) + '</div>'
            : '';
        return '<div class="qet-threads"><div class="qet-h">Sent to</div>' + rows
            + checkBtn + checkStatus + '</div>';
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

    function chipsHtml(st, kind) {
        var list = listFor(st, kind);
        return list.map(function (a, i) {
            var parts = chipAddrs(a);
            var bad = !parts.length || parts.some(function (one) { return !isEmail(one); });
            return '<span class="qet-chip' + (bad ? ' qet-chip-bad' : '') + '">' + escTxt(a)
                + '<button class="qet-chip-x" data-kind="' + (kind || 'bcc') + '" data-i="' + i + '" title="Remove">&times;</button></span>';
        }).join('');
    }
    function listFor(st, kind) {
        return kind === 'cc' ? st.cc : st.bcc;
    }

    /**
     * Only a change to the SUPPLIER list starts a new send.
     *
     * Sending empties the supplier list and locks Send. Clearing that lock on any chip change
     * meant typing a colleague into Cc afterwards lit Send up again with no suppliers left —
     * and pressing it emailed the whole supplier enquiry to that colleague alone, logged them
     * in the quote as a supplier awaiting a reply, and recorded them in the Partner Directory
     * as a dealer who had been asked. Cc is for copying someone in, never for a send of its own.
     */
    function recipientsChanged(st, kind) {
        if (kind !== 'cc') st.sentLock = false;
    }
    // Cc: openly copied on every email this send produces. Bcc above is the recipient list, so
    // cc'ing a colleague on an enquiry to eight suppliers puts eight copies in their inbox —
    // worth saying out loud rather than letting them discover it.
    function ccFieldHtml(st) {
        return '<div class="qet-ccbox">'
            + '<label class="qet-lbl">Cc <span class="qet-sub">(optional)</span></label>'
            + '<div class="qet-field" data-kind="cc"><span class="qet-chips" data-kind="cc">'
            + chipsHtml(st, 'cc') + '</span>'
            + '<input class="qet-input" data-kind="cc" type="text" placeholder="Add one or more addresses" autocomplete="off"></div>'
            + '<p class="qet-note">Everyone here can see each other, like a normal Cc. With Bcc filled, these ride'
            + ' along on every hidden email above; with Bcc empty, the enquiry goes as ONE open email to these addresses.</p></div>';
    }

    // Either box is enough to send — Bcc for hidden one-each sends, Cc for one open email — like
    // ordinary mail, which needs a recipient SOMEWHERE, not in one particular line. Every address
    // is validated; a typo anywhere blocks the send. sentLock keeps it off after a send that
    // worked: a Bcc send empties Bcc but leaves the Cc'd colleague, and the button stayed blue
    // right under the green tick, so a second press mailed the colleague alone.
    function canSendNow(st) {
        return !!((st.bcc.length || st.cc.length) && !st.sending && !st.sentLock && st.rows.length
            && st.bcc.concat(st.cc).every(chipIsSendable));
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
        // Seed whenever there are no rows. The old "&& !threads.length" meant that after a
        // reload — when the in-page state is empty but the sent-enquiry threads came back from
        // the server — the table stayed empty, Send stayed disabled (it needs a row) and the
        // "Create enquiry" button was gone, so sending to one more supplier meant retyping
        // every line by hand. Rows edited in this session are non-empty, so they survive.
        if (!st.rows.length) st.rows = buildRowsFromQuote(quotation);
        if (!st.messageEdited) st.message = buildDraft(quotation);

        var status = '';
        if (st.sending) status = '<div class="qet-status">Sending&hellip;</div>';
        else if (st.sent) {
            var ok = st.sent.slice(0, 3) === 'ok:';
            status = '<div class="qet-status" style="color:' + (ok ? '#0F6E56' : '#A32D2D') + ';">'
                + (ok ? '✓ ' : '⚠ ') + escTxt(st.sent.slice(st.sent.indexOf(':') + 1)) + '</div>';
        }

        var canSend = canSendNow(st);
        mountEl.innerHTML = '<div class="qet">'
            + '<div class="qet-h">Enquiry &middot; ' + st.rows.length + ' item' + (st.rows.length === 1 ? '' : 's')
            + ' <span class="qet-sub">built from the quote</span></div>'
            + rowsTableHtml(st)
            + '<div class="qet-rowbtns"><button class="qet-btn qet-add">+ Add item</button></div>'
            + '<label class="qet-lbl">Bcc &mdash; suppliers / dealers <span class="qet-sub">(one email each)</span></label>'
            + '<div class="qet-field" data-kind="bcc"><span class="qet-chips" data-kind="bcc">' + chipsHtml(st, 'bcc') + '</span>'
            + '<input class="qet-input" data-kind="bcc" type="text" placeholder="Type a supplier name or email" autocomplete="off"></div>'
            + '<div class="qet-suggest"></div>'
            + '<p class="qet-note">Suggests suppliers you&rsquo;ve emailed before &mdash; the ones you use for this quote&rsquo;s pipe types come first. Each supplier gets their own email and is BCC&rsquo;d, so nobody sees anyone else.</p>'
            // Partner Directory: shown only when asked for; reads this quote's pipe types.
            + '<div style="margin-top:8px;"><button type="button" class="qet-dir-ask">✨ Ask AI — who can I buy this from?</button></div>'
            + '<div class="qet-dir-panel"></div>'
            + ccFieldHtml(st)
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

        // Repaint ONLY the recipient chips, the way the Freight tab does. render() rebuilds the
        // whole tab — including an EMPTY "Ask AI" panel — so every pick wiped the ranked list of
        // suppliers, and adding a second one meant asking again and re-reading it from the top.
        function syncSendBtn() {
            var btn = mountEl.querySelector('.qet-send');
            if (btn) btn.disabled = !canSendNow(st);
        }
        function bindChipX() {
            $$('.qet-chip-x').forEach(function (el) {
                el.onclick = function () {
                    listFor(st, el.dataset.kind).splice(Number(el.dataset.i), 1);
                    recipientsChanged(st, el.dataset.kind);   // only suppliers start a new send
                    paintChips(el.dataset.kind);
                };
            });
        }
        function paintChips(kind) {
            var k = kind || 'bcc';
            var box = mountEl.querySelector('.qet-chips[data-kind="' + k + '"]');
            if (!box) { render(quotation, mountEl); return; }
            box.innerHTML = chipsHtml(st, k);
            bindChipX();
            syncSendBtn();
            paintSuggestions();
        }
        function clearInput(kind) {
            var again = mountEl.querySelector('.qet-input[data-kind="' + kind + '"]');
            if (again) { again.value = ''; again.focus(); }
        }
        bindChipX();

        var input = mountEl.querySelector('.qet-input[data-kind="bcc"]');
        var suggest = $('.qet-suggest');
        // Adding to any of the three lists. `kind` decides which one; the cursor goes back into
        // the SAME box afterwards, because render() rebuilds the tab and would otherwise drop it.
        function addTo(kind, v, keepTogether) {
            // A firm picked from the directory arrives pre-joined and must stay ONE chip, or
            // its people end up on separate emails and never see each other.
            var email = keepTogether
                ? chipAddrs(v).map(bareAddress).filter(Boolean).join(', ')
                : bareAddress(String(v || '').replace(/[;,]$/, ''));
            if (!email) return;
            if (addChip(listFor(st, kind), email)) recipientsChanged(st, kind);
            paintChips(kind);
            clearInput(kind);
        }
        // A pasted list becomes ONE CHIP PER FIRM. It used to become a single chip holding the
        // whole list, which put every one of those suppliers on the SAME email with each other
        // visible in Cc — the one thing this tab exists to prevent.
        function addTypedList(kind, raw) {
            var parts = splitAddressList(raw);
            if (!parts.length) return;
            var list = listFor(st, kind);
            parts.forEach(function (tok) {
                var email = bareAddress(tok);
                if (email && addChip(list, email)) recipientsChanged(st, kind);
            });
            paintChips(kind);
            clearInput(kind);
        }
        function addRecip(v) { addTo('bcc', v); }

        // "Ask AI" → the Partner Directory ranks suppliers for this quote's pipe types and
        // weight (summed only when every line has kg/m and qty — never guessed). Picked
        // addresses land as ordinary Bcc chips, exactly as if typed.
        var dirAsk = mountEl.querySelector('.qet-dir-ask');
        var dirPanel = mountEl.querySelector('.qet-dir-panel');
        if (dirAsk && dirPanel && window.partnerDirectory) {
            dirAsk.onclick = function () {
                window.partnerDirectory.renderSuggestPanel(dirPanel, {
                    kind: 'material',
                    types: quotePipeTypes(quotation),
                    items: enquiryNeedItems(quotation),
                    kg: enquiryNeedKg(quotation),
                    site: String(quotation.shipTo || ''),
                }, function (chip) { addTo('bcc', chip, true); });
            };
        } else if (dirAsk) { dirAsk.style.display = 'none'; }

        // Cc: same keys and same blur-commit as the Bcc box, so it takes any number of
        // addresses. A pasted list splits on comma / semicolon / whitespace.
        mountEl.querySelectorAll('.qet-ccbox .qet-input').forEach(function (el) {
            var kind = el.dataset.kind;
            function commit(raw) { addTypedList(kind, raw); }
            el.onkeydown = function (e) {
                if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commit(el.value); }
            };
            el.onblur = function () { if (el.value.trim()) commit(el.value); };
            el.onpaste = function (e) {
                var cb = e.clipboardData || window.clipboardData;
                var text = cb && cb.getData ? cb.getData('text') : '';
                if (!text || !/[,;\n<]/.test(text)) return;   // a single plain address: let it paste normally
                e.preventDefault();
                commit(text);
            };
            // Same Gmail-contact dropdown as the To box — these are usually colleagues, and
            // typing a name beats remembering an address.
            if (typeof attachContactAutocomplete === 'function') {
                attachContactAutocomplete(el.parentElement || el, el, function (v) { addTo(kind, v); });
            }
        });
        // The Gmail-contact dropdown already MERGES these remembered suppliers in and draws them
        // at the top of its own list. Painting this older inline row as well put two lists over
        // each other on screen, showing the same addresses twice. So it now only runs as a
        // fallback, when the shared autocomplete isn't available.
        var hasContactDropdown = (typeof attachContactAutocomplete === 'function');
        function paintSuggestions() {
            if (!suggest || hasContactDropdown) return;
            var list = suggestedSuppliers(quotation, input ? input.value : '')
                .filter(function (s) { return st.bcc.indexOf(s.email) === -1; });
            suggest.innerHTML = list.length
                ? list.map(function (s) { return '<button class="qet-sg" data-e="' + esc(s.email) + '">' + escTxt(s.email) + '</button>'; }).join('')
                : '';
            $$('.qet-sg').forEach(function (el) {
                el.onclick = function () { addRecip(el.dataset.e); };
            });
        }
        if (input) {
            input.oninput = paintSuggestions;
            // Warm the remembered list either way — the dropdown's own local source reads it.
            input.onfocus = function () { loadSupplierSuggestions(paintSuggestions); paintSuggestions(); };
            input.onkeydown = function (e) {
                if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); addTypedList('bcc', input.value); }
            };
            input.onblur = function () { if (input.value.trim()) addTypedList('bcc', input.value); };
            input.onpaste = function (e) {
                var cb = e.clipboardData || window.clipboardData;
                var text = cb && cb.getData ? cb.getData('text') : '';
                if (!text || !/[,;\n<]/.test(text)) return;   // a single plain address: let it paste normally
                e.preventDefault();
                addTypedList('bcc', text);
            };
            // The same Gmail-style dropdown the Freight tab uses: it searches your Gmail
            // contacts (People API) and merges in the suppliers we remember, ranked by the
            // pipe types on THIS quote. Without this the tab only ever offered the remembered
            // list, as a row of small chips — so an address never emailed before could not be
            // completed at all, and it looked like the field simply had no suggestions.
            if (typeof attachContactAutocomplete === 'function') {
                attachContactAutocomplete(input.parentElement || input, input, addRecip, function (query) {
                    return suggestedSuppliers(quotation, query)
                        .filter(function (s) { return st.bcc.indexOf(s.email) === -1; })
                        .map(function (s) { return { name: '', email: s.email }; });
                });
            }
        }
        loadSupplierSuggestions(paintSuggestions);

        var msg = $('.qet-msg');
        if (msg) msg.oninput = function () {
            st.message = msg.value; st.messageEdited = true;
            // NOT a re-arm. The same fault was found on the Freight tab: a send clears the
            // recipients but leaves anyone copied in, so re-arming Send on a keystroke armed
            // it to email that colleague ALONE. Editing the message changes what the next
            // enquiry SAYS; it does not create anybody new to say it to. Only adding a
            // recipient does that, and addChip only reports a genuine addition.
            syncSendBtn();
        };

        var send = $('.qet-send');
        if (send) send.onclick = function () { sendEnquiry(quotation, mountEl); };

        var checkBtn = $('.qet-check');
        if (checkBtn) checkBtn.onclick = function () { checkSupplierReplies(quotation, st, mountEl); };

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
    // With Bcc empty the Cc list IS the send — ONE open email where every firm sees the others.
    // That is the one thing this tab exists to prevent, so say it plainly first, naming them.
    // Returns true when it is fine to go ahead.
    function confirmOpenCcSend(st) {
        if (st.bcc.length || st.cc.length < 2) return true;
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
        return window.confirm('Bcc is empty, so this goes as ONE open email.\n\n'
            + st.cc.join('\n') + '\n\nEvery one of them will see the others. Send it anyway?');
    }

    function sendEnquiry(quotation, mountEl) {
        var st = stateFor(quotation);
        if ((!st.bcc.length && !st.cc.length) || st.sending || st.sentLock || !st.rows.length) return;
        if (!st.bcc.concat(st.cc).every(chipIsSendable)) {
            st.sent = 'err:Check the highlighted email addresses.'; render(quotation, mountEl); return;
        }
        if (!confirmOpenCcSend(st)) return;

        var subject = 'Enquiry' + (quotation.quoteNumber ? ' — ' + quotation.quoteNumber : '');
        var recipients = st.bcc.slice();
        // Captured now, like the recipients: the composer stays editable while the sends run.
        var extra = { cc: st.cc.join(', ') };
        st.sending = true; st.sent = '';
        render(quotation, mountEl);
        // Make sure the standard signature is in hand before building the body, so the enquiry
        // is signed the same way a quotation is.
        loadSignature(function () { doSend(quotation, mountEl, st, subject, recipients, extra); });
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

    function doSend(quotation, mountEl, st, subject, recipients, extra) {
        extra = extra || { cc: '' };
        var bodyHtml = messageToHtml(st.message, st.rows);
        var storedBody = trimSentBodyForStorage(bodyHtml);

        // Standard email semantics: Bcc hides recipients from each other (one email per
        // supplier), Cc is open. With Bcc EMPTY, the Cc addresses ARE the send — one email,
        // everyone visible to everyone, the way Cc works everywhere else.
        var ccOnly = !recipients.length;
        var sends = ccOnly ? [extra.cc] : recipients;

        Promise.all(sends.map(function (addr) {
            var firm = chipAddrs(addr);
            var payload = ccOnly
                // One open email: the Cc list rides in the Cc header; server puts our own
                // address in To so the message is well-formed.
                ? { to: '', cc: addr, bcc: '', subject: subject, bodyHtml: bodyHtml, label: 'supplier' }
                // One email per supplier, that supplier alone on Bcc so nobody sees anyone else.
                // `to` is left empty — the server addresses it to our own account.
                // label tags the thread Quotation Automation/Enquiry Sent by us in Gmail.
                // Several people at ONE firm: a single email with all of them on Cc, so they
                // can see each other — which is the whole point of grouping them.
                : firm.length > 1
                ? { to: '', cc: [firm.join(', '), extra.cc].filter(Boolean).join(', '), bcc: '', subject: subject, bodyHtml: bodyHtml, label: 'supplier' }
                : { to: '', cc: extra.cc, bcc: addr, subject: subject, bodyHtml: bodyHtml, label: 'supplier' };
            return fetch(apiBase() + '/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
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
                var n = ccOnly ? extra.cc.split(', ').length : sentOk.length;
                st.sent = 'ok:Enquiry sent to ' + n + ' supplier' + (n > 1 ? 's' : '') + (ccOnly ? ' (one open email — all Cc)' : '') + '.';
                // Clear whichever list acted as the RECIPIENTS, so the live Send button
                // cannot fire the same enquiry twice. Copies (cc on a Bcc send) stay — and
                // the lock is what stops a second press mailing that colleague on their own.
                if (ccOnly) st.cc = []; else st.bcc = [];
                st.sentLock = true;
            } else if (sentOk.length) {
                st.sent = 'err:Sent to ' + sentOk.length + ', but failed for ' + failed.map(function (r) { return r.addr; }).join(', ') + '.';
                st.bcc = failed.map(function (r) { return r.addr; });
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
                // A ccOnly "addr" is the joined list — split it back so each supplier is
                // remembered individually, not as one unusable comma-glued entry.
                var used = [];
                sentOk.forEach(function (r) { used = used.concat(String(r.addr).split(', ')); });
                recordSupplierUsage(used, quotation);
                if (typeof window !== 'undefined' && window.partnerDirectory) {
                    window.partnerDirectory.recordUsage({
                        emails: used, kind: 'sent', role: 'dealer',
                        pipeTypes: quotePipeTypes(quotation),
                        // ...and WHICH enquiry, so the count on the card can be opened
                        threads: threadsForUsage(sentOk, (quotation && quotation.quoteNumber) || '',
                            quotePipeTypes(quotation).join(' · ')),
                    });
                }
            }
            render(quotation, mountEl);
        });
    }

    // ── public surface ────────────────────────────────────────────────────────
    if (typeof window !== 'undefined') {
        window.renderQuoteEnquiryTab = function (quotation, mountEl) {
            if (!quotation || !mountEl) return;
            mountById[String(quotation.id)] = mountEl;   // so background work can repaint this tab
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
            // Pasted-address parsing — one chip per firm, display names stripped.
            splitAddressList: splitAddressList,
            bareAddress: bareAddress,
            chipAddrs: chipAddrs,
            addChip: addChip,
            canSendNow: canSendNow,
            checkResultText: checkResultText,
            _setSuggest: function (s) { _supplierSuggest = s; },
        };
    }
})();
