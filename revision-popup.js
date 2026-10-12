/**
 * revision-popup.js — "There is a new revision request, please check" pop-up.
 *
 * The red count on the Revision button is easy to miss, so an open revision ask also pops up.
 * Shown to everyone (no roles yet), at most ONCE A DAY per ask on each computer: an ask still
 * open tomorrow pops up again, a brand-new ask pops up as soon as it is seen even if another
 * already popped today. The person who adds an ask is not shown their own.
 *
 * Checked when the app opens (fed by loadRevisionQuotesForCount in index.html) and every
 * 5 minutes while the tab is visible. "Check now" opens the Revision list; "Later" closes it.
 */
(function () {
    'use strict';

    var STORE_KEY = 'revisionPopupShown';   // { askId: 'YYYY-MM-DD' last shown }
    var CHECK_EVERY_MS = 5 * 60 * 1000;
    var memoryShown = {};                   // used when browser storage is blocked
    var open = false;

    function todayKey(now) {
        var d = now || new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // Asks are typed in a rich box; the pop-up shows them as one plain line.
    function plainText(html) {
        return String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ').trim();
    }

    // Open asks not yet shown today, one row per ask, oldest first.
    function revisionsDueToday(quotes, shown, today) {
        var due = [];
        (quotes || []).forEach(function (q) {
            if (!q || q.deleted || !Array.isArray(q.revisionRequests)) return;
            q.revisionRequests.forEach(function (r) {
                if (!r || r.done || !r.id) return;
                if (shown[r.id] === today) return;
                due.push({ quote: q, ask: r });
            });
        });
        due.sort(function (a, b) { return String(a.ask.addedAt || '').localeCompare(String(b.ask.addedAt || '')); });
        return due;
    }

    function readShown() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            var parsed = raw ? JSON.parse(raw) : {};
            return Object.assign({}, parsed && typeof parsed === 'object' ? parsed : {}, memoryShown);
        } catch (e) { return Object.assign({}, memoryShown); }
    }
    // Only today's marks are kept — older ones are due again anyway, so the store never grows.
    function markShown(ids) {
        var today = todayKey();
        var shown = readShown();
        var kept = {};
        Object.keys(shown).forEach(function (k) { if (shown[k] === today) kept[k] = today; });
        ids.forEach(function (id) { kept[id] = today; memoryShown[id] = today; });
        try { window.localStorage.setItem(STORE_KEY, JSON.stringify(kept)); } catch (e) { /* memory copy still holds */ }
    }

    function rowHtml(item) {
        var q = item.quote;
        var name = [q.quoteNumber, q.companyName || q.projectName].filter(Boolean).join(' — ') || 'Quotation';
        var text = plainText(item.ask.text);
        if (text.length > 140) text = text.slice(0, 137) + '…';
        return '<li style="margin:0 0 8px;"><b>' + esc(name) + '</b>'
            + (text ? '<br><span style="color:#555;">' + esc(text) + '</span>' : '') + '</li>';
    }

    function checkNow() {
        if (typeof window.switchToQuotationTab === 'function') window.switchToQuotationTab();
        // approvalRevisionFilter / approvalToggleRevision live in index.html's script.
        var listOn = false;
        try { listOn = !!approvalRevisionFilter; } catch (e) { /* not loaded */ }
        if (!listOn && typeof window.approvalToggleRevision === 'function') window.approvalToggleRevision();
        var btn = document.getElementById('approvalRevisionBtn');
        if (btn && btn.scrollIntoView) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function showPopup(due) {
        open = true;
        markShown(due.map(function (d) { return d.ask.id; }));
        var overlay = document.createElement('div');
        overlay.className = 'email-modal-overlay';
        overlay.id = 'revisionPopup';
        overlay.innerHTML = '<div class="email-modal" style="width:480px;max-width:94vw;max-height:80vh;overflow:auto;">'
            + '<h3 class="email-modal-title">There is a new revision request, please check</h3>'
            + '<ul style="padding-left:18px;margin:8px 0 12px;">' + due.slice(0, 8).map(rowHtml).join('') + '</ul>'
            + (due.length > 8 ? '<p style="color:#888;margin:0 0 8px;">…and ' + (due.length - 8) + ' more</p>' : '')
            + '<div class="email-modal-actions">'
            + '<button type="button" class="email-modal-cancel">Later</button>'
            + '<button type="button" class="email-modal-send">Check now</button></div></div>';
        document.body.appendChild(overlay);
        function close() { overlay.remove(); open = false; }
        overlay.querySelector('.email-modal-cancel').onclick = close;
        overlay.querySelector('.email-modal-send').onclick = function () { close(); checkNow(); };
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    function check(quotes) {
        if (open) return;
        var due = revisionsDueToday(quotes, readShown(), todayKey());
        if (due.length) showPopup(due);
    }

    function apiBase() {
        var origin = window.location.origin;
        return (origin && origin !== 'null' && origin.indexOf('http') === 0) ? origin + '/api' : 'http://localhost:3001/api';
    }
    // A failed check stays silent: the pop-up is a reminder, and the red count is still there.
    async function poll() {
        if (open || document.hidden) return;
        try {
            var res = await fetch(apiBase() + '/quotations-filter?revision=1');
            if (!res.ok) return;
            var data = await res.json();
            check(Array.isArray(data.quotations) ? data.quotations : []);
        } catch (e) { /* try again next round */ }
    }

    window.RevisionPopup = { check: check, markShown: markShown };
    window.RevisionPopup._test = { revisionsDueToday: revisionsDueToday, todayKey: todayKey, plainText: plainText };
    setInterval(poll, CHECK_EVERY_MS);
})();
