/*
 * account-badge.js — the signed-in person's letters in a circle, top right, on every app page
 * (index.html, home.html, appraisal.html, people.html). Click it for their name, email and Log out.
 *
 * Shows only for someone actually signed in (/api/me signedIn). A customer opening a shared quote
 * link, or a site with no sign-in set up, sees nothing. Self-contained: its own styles, no globals
 * except window.AccountBadge (for tests).
 *
 * Unsaved work: before logging out it asks the page's own "leave with unsaved changes?" guards
 * (every page uses a beforeunload listener that calls preventDefault). If any says yes, the first
 * click only warns; a second click goes ahead. Logging out is a form submit — a real page change —
 * so the browser's own "Leave site?" box comes BEFORE the session ends: "Stay" keeps you signed
 * in with your work. (A fetch first and a redirect after would ask too late: signed out, can't save.)
 *
 * Layering: z-index 45 — above ordinary page content, below every pop-up window (People 50,
 * Partner Directory 60+, tool bar 1000, overlays 99999), so a dialog always covers it.
 *
 * Letters: two or more words → first letters of the first and last word ("Dhanesh Dugar" → DD);
 * one word → its first two letters ("Kavitha" → KA). A name that is only an email uses the part
 * before the @. The shared password has no name, so it gets a plain person icon.
 */
(function () {
    'use strict';

    var PERSON_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5z"/></svg>';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }

    /** The letters to show for a name ('' when there is nothing usable). */
    function initialsOf(name) {
        var n = String(name == null ? '' : name).trim();
        if (n.indexOf('@') > 0 && n.indexOf(' ') < 0) n = n.split('@')[0].replace(/[._-]+/g, ' ');
        var words = n.split(/\s+/).map(function (w) { return w.replace(/[^\p{L}\p{N}]/gu, ''); }).filter(Boolean);
        if (!words.length) return '';
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
    }

    /** What /api/me tells us, reduced to what the badge needs; null = show nothing. */
    function accountFrom(me) {
        if (!me || !me.signedIn) return null;
        var shared = !me.email && me.who === 'shared';
        return { shared: shared, name: shared ? 'Shared login' : (me.who || me.email || ''), email: me.email || '' };
    }

    var CSS = '.acct-wrap{position:fixed;top:12px;right:16px;z-index:45;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}'
        + '.acct-btn{box-sizing:border-box;width:38px;height:38px;min-width:0;min-height:0;max-width:none;margin:0;padding:0;border-radius:50%;border:0;background:#3f51b5;color:#fff;font-family:inherit;font-weight:600;font-size:14px;line-height:1;letter-spacing:.02em;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}'
        + '.acct-btn.shared{background:#6f6c66}'
        + '.acct-btn:focus-visible{outline:2px solid #3f51b5;outline-offset:2px}'
        + '.acct-menu{position:absolute;top:46px;right:0;min-width:220px;max-width:min(300px,calc(100vw - 32px));background:#fff;color:#2b2b2b;border:1px solid #e7e5e0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.16);padding:12px}'
        + '.acct-menu[hidden],.acct-warn[hidden]{display:none}'
        + '.acct-name{font-weight:600;overflow-wrap:anywhere}'
        + '.acct-email{font-size:12.5px;color:#6f6c66;overflow-wrap:anywhere;margin-top:2px}'
        + '.acct-warn{margin-top:10px;font-size:12.5px;color:#A32D2D}'
        + '.acct-out{box-sizing:border-box;margin-top:12px;width:100%;min-height:0;padding:8px 12px;border-radius:6px;border:1px solid #d8d5ce;background:#fff;color:#A32D2D;font-family:inherit;font-weight:600;font-size:13px;line-height:1.3;cursor:pointer}'
        + '.acct-out:hover{border-color:#A32D2D}'
        + '.acct-out[disabled]{opacity:.55;cursor:default}'
        + '@media print{.acct-wrap{display:none}}';

    function addStyles(doc) {
        if (doc.getElementById('acct-style')) return;
        var st = doc.createElement('style');
        st.id = 'acct-style';
        st.textContent = CSS;
        doc.head.appendChild(st);
    }

    function badgeHtml(acct) {
        var face = acct.shared ? PERSON_ICON : esc(initialsOf(acct.name) || '?');
        return '<button type="button" class="acct-btn' + (acct.shared ? ' shared' : '') + '" aria-haspopup="dialog" aria-expanded="false" aria-label="Account: ' + esc(acct.name) + '" title="' + esc(acct.name) + '">' + face + '</button>'
            + '<div class="acct-menu" role="dialog" aria-label="Account" hidden><div class="acct-name">' + esc(acct.name) + '</div>'
            + (acct.email ? '<div class="acct-email">' + esc(acct.email) + '</div>' : '')
            + '<div class="acct-warn" role="alert" hidden>You have unsaved changes on this page. Save them first, or click again to log out and lose them.</div>'
            + '<button type="button" class="acct-out">Log out</button></div>';
    }

    /** Ask the page's own leave-guards whether anything is unsaved (they all call preventDefault). */
    function pageHasUnsavedWork(win) {
        var ev;
        try { ev = new win.Event('beforeunload', { cancelable: true }); } catch (e) { return false; }
        win.dispatchEvent(ev);
        return ev.defaultPrevented;
    }

    function createLogout(wrap, doc, win) {
        var btn = wrap.querySelector('.acct-out'), warn = wrap.querySelector('.acct-warn');
        var state = { warned: false };

        /** Submit a hidden form to POST /api/logout?go=login. If the person stays at the browser's
         *  "Leave site?" box nothing has happened — still signed in — so the button comes back. */
        function go() {
            btn.disabled = true;
            btn.textContent = 'Logging out…';
            var form = doc.createElement('form');
            form.method = 'POST';
            form.action = '/api/logout?go=login';
            form.style.display = 'none';
            doc.body.appendChild(form);
            form.submit();
            win.setTimeout(function () { btn.disabled = false; btn.textContent = state.warned ? 'Log out anyway' : 'Log out'; form.remove(); }, 2500);
        }
        /** First click with unsaved work only warns; the next click logs out anyway. One request at a time. */
        function click() {
            if (btn.disabled) return;
            if (!state.warned && pageHasUnsavedWork(win)) {
                state.warned = true;
                warn.hidden = false;
                btn.textContent = 'Log out anyway';
                return;
            }
            go();
        }
        function reset() {
            if (btn.disabled) return;
            state.warned = false;
            warn.hidden = true;
            btn.textContent = 'Log out';
        }
        return { click: click, reset: reset };
    }

    function mount(acct, doc, win) {
        if (!acct || doc.getElementById('acct-badge')) return null;
        addStyles(doc);
        var wrap = doc.createElement('div');
        wrap.className = 'acct-wrap';
        wrap.id = 'acct-badge';
        wrap.innerHTML = badgeHtml(acct);
        doc.body.appendChild(wrap);
        var btn = wrap.querySelector('.acct-btn'), menu = wrap.querySelector('.acct-menu'), logout = createLogout(wrap, doc, win);
        function setOpen(open) { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (!open) logout.reset(); }
        btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(menu.hidden); });
        wrap.querySelector('.acct-out').addEventListener('click', logout.click);
        doc.addEventListener('click', function (e) { if (!menu.hidden && !wrap.contains(e.target)) setOpen(false); });
        doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); } });
        return wrap;
    }

    function start(doc, win) {
        return win.fetch('/api/me', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (me) { return mount(accountFrom(me), doc, win); })
            .catch(function () { return null; });   // no badge is better than a broken page
    }

    window.AccountBadge = { initialsOf: initialsOf, accountFrom: accountFrom, badgeHtml: badgeHtml, pageHasUnsavedWork: pageHasUnsavedWork, start: start };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { start(document, window); });
    else start(document, window);
})();
