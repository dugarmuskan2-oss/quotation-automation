/*
 * appraisal-page.js — the browser side of appraisal.html (the staff appraisal).
 *
 * Own page, own state: nothing here touches index.html or its globals. Talks only to
 * /api/appraisal/* (routes/appraisal.js). Admins (from the People page) get the manager view;
 * everyone else gets their own quarterly form.
 *
 * Saving rules, from CLAUDE.md's five checks:
 *  - nothing auto-saves; only the Save / Submit buttons write
 *  - every write sends the version it started from, and the server refuses a stale one
 *  - one write at a time: buttons lock while a save is in flight
 *  - a failed load says it failed; it never shows an empty list instead
 */
(function () {
    'use strict';

    var GROUPS = [['work', 'Work results'], ['behaviour', 'Behaviour']];
    var S = {
        loaded: false, loadError: null, you: null, hasAdmin: true, setup: null, isStarter: false,
        people: [], mine: null, tab: null, q: null, h: null, busy: false, dirty: false,
        open: null, draft: null, openMeet: null, meetDraft: null, myDraft: null, myDraftKey: null,
        editPerson: null, setupDraft: null, leaveArmed: false, newStaff: { name: '', email: '' }, removeArmed: null
    };
    var $ = function (s) { return document.querySelector(s); };
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function newId(p) { return p + Math.random().toString(36).slice(2, 8); }

    // ── Periods: Indian financial year, April to March ─────────────────────
    var QM = [['Apr', 'Jun'], ['Jul', 'Sep'], ['Oct', 'Dec'], ['Jan', 'Mar']];
    function yy(n) { return String(n % 100).padStart(2, '0'); }
    function qInfo(fy, q) { var m = QM[q - 1], yr = q === 4 ? fy + 1 : fy; return { key: fy + '-' + yy(fy + 1) + '-Q' + q, fy: fy, q: q, label: 'Q' + q + ' · ' + m[0] + '–' + m[1] + ' ' + yr }; }
    function parseQ(k) { var m = /^(\d{4})-\d{2}-Q(\d)$/.exec(k); return qInfo(+m[1], +m[2]); }
    function nowQ() { var d = new Date(), m = d.getMonth() + 1, y = d.getFullYear(); return { fy: m >= 4 ? y : y - 1, q: m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4 }; }
    function shiftQ(x, n) { var i = x.fy * 4 + (x.q - 1) + n; return { fy: Math.floor(i / 4), q: (i % 4) + 1 }; }
    function quarterList(count) { var c = nowQ(), out = []; for (var n = 0; n > -count; n--) { var x = shiftQ(c, n); out.push(qInfo(x.fy, x.q)); } return out; }
    function hInfo(fy, h) { return { key: fy + '-' + yy(fy + 1) + '-H' + h, fy: fy, h: h, label: h === 1 ? 'Apr–Sep ' + fy : 'Oct ' + fy + ' – Mar ' + (fy + 1), quarters: h === 1 ? [qInfo(fy, 1), qInfo(fy, 2)] : [qInfo(fy, 3), qInfo(fy, 4)] }; }
    function parseH(k) { var m = /^(\d{4})-\d{2}-H(\d)$/.exec(k); return hInfo(+m[1], +m[2]); }
    function halfOf(qi) { return hInfo(qi.fy, qi.q <= 2 ? 1 : 2); }
    function halfList() { var c = halfOf(qInfo(nowQ().fy, nowQ().q)), base = c.fy * 2 + (c.h - 1), out = []; for (var n = 0; n >= -3; n--) { var i = base + n; out.push(hInfo(Math.floor(i / 2), (i % 2) + 1)); } return out; }
    (function () { var p = shiftQ(nowQ(), -1), qi = qInfo(p.fy, p.q); S.q = qi.key; S.h = halfOf(qi).key; })();

    // ── Scoring (mirrors utils/appraisal.js, which the server uses) ────────
    function scaleOf(n) { return ((S.setup && S.setup.scale) || []).filter(function (x) { return x.n === n; })[0] || { n: n, label: '', desc: '' }; }
    var GAP = 3;    // their score and yours this far apart gets flagged to talk about
    var MAX = 10;   // scores run 1 to 10 (utils/appraisal.js SCORE_MAX)
    function clampScore(v) { return Math.min(MAX, Math.max(1, Math.round(v))); }
    /** Five colours for ten scores: 1–2 red … 9–10 green. */
    function colourOf(v) { return 's' + Math.ceil(clampScore(v) / 2); }
    function band(t) { return t == null ? '' : scaleOf(clampScore(t)).label; }
    function raiseFor(t) { if (t == null) return null; var rs = ((S.setup && S.setup.raises) || []).slice().sort(function (a, b) { return b.min - a.min; }); return rs.filter(function (r) { return t >= r.min; })[0] || null; }
    function fmt(v) { return v == null ? '–' : (Number.isInteger(v) ? String(v) : v.toFixed(2)); }
    function scoreChip(v) { if (v == null) return '<span class="score">–</span>'; return '<span class="score ' + colourOf(v) + '">' + fmt(v) + '</span>'; }
    /** Mirrors utils/appraisal.js groupsFor. `prof` is { roles, extras, hidden }: job items and
     *  Behaviour, minus shared items removed for this person, plus their own extra items. */
    function groupsFor(prof) {
        var p = prof || {}, hidden = p.hidden || [], keep = function (c) { return hidden.indexOf(c.id) < 0; };
        var work = [], seen = {}, mine = p.roles || [], behaviour = (S.setup.behaviour || []).filter(keep);
        (S.setup.roles || []).forEach(function (r) {
            if (mine.indexOf(r.id) < 0) return;
            (r.criteria || []).forEach(function (c) { if (!seen[c.id] && keep(c)) { seen[c.id] = 1; work.push(Object.assign({ role: r.name }, c)); } });
        });
        (p.extras || []).forEach(function (x) {
            if (x.section === 'behaviour') behaviour.push(Object.assign({ extra: true }, x));
            else work.push(Object.assign({ extra: true, role: roleName(x.section) || 'Extra items' }, x));
        });
        return [{ id: 'work', name: 'Work results', items: work }, { id: 'behaviour', name: 'Behaviour', items: behaviour }];
    }
    function roleName(id) { var r = (S.setup.roles || []).filter(function (x) { return x.id === id; })[0]; return r ? r.name : ''; }
    /** The little tag that marks an item set for one person only. */
    function extraTag(c, who) { return c.extra ? ' <span class="chip info">Only for ' + who + '</span>' : ''; }
    /** What the form shows: one heading per job (Sales, Administration…), then Behaviour.
     *  Display only — the jobs' items still count together as Work results in the total. */
    function sections(groups) {
        var out = [], work = groups.filter(function (g) { return g.id === 'work'; })[0], w = S.setup.weights || {};
        var names = [];
        work.items.forEach(function (c) { if (names.indexOf(c.role) < 0) names.push(c.role); });
        names.forEach(function (n) {
            out.push({ name: n, items: work.items.filter(function (c) { return c.role === n; }), weightText: 'Part of work results · ' + (w.work || 0) + '% together' });
        });
        groups.forEach(function (g) { if (g.id !== 'work') out.push({ name: g.name, items: g.items, weightText: (w[g.id] || 0) + '% of total' }); });
        return out.filter(function (x) { return x.items.length; });
    }
    function total(groups, scores) {
        var used = 0, sum = 0;
        groups.forEach(function (g) {
            var vals = g.items.map(function (c) { return scores && scores[c.id]; }).filter(function (v) { return v >= 1; });
            if (!vals.length) return;
            var w = Number((S.setup.weights || {})[g.id] || 0);
            used += w; sum += w * vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        });
        return used ? sum / used : null;
    }
    function unscored(groups, scores) { return groups.reduce(function (n, g) { return n + g.items.filter(function (c) { return !(scores && scores[c.id] >= 1); }).length; }, 0); }

    // ── Talking to the server ───────────────────────────────────────────────
    function api(method, url, body) {
        return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (d) {
                    if (r.status === 401) { location.href = '/login.html?next=' + encodeURIComponent('/appraisal.html'); throw new Error('Signed out'); }
                    if (!r.ok) throw new Error(d.error || 'Something went wrong. Try again.');
                    return d;
                });
            }, function () { throw new Error('Could not reach the server. Check your connection and try again.'); });
    }
    /** One write at a time. While it runs every button on the page is disabled. */
    function save(method, url, body, done) { run(function () { return api(method, url, body); }, done); }
    /** Like save, for a write made of more than one request (`work` returns a promise). */
    function run(work, done) {
        if (S.busy) return;
        S.busy = true; lockButtons(true);
        work().then(function (d) { S.busy = false; return done(d); })
            .catch(function (e) { S.busy = false; lockButtons(false); toast(e.message); });
    }
    function lockButtons(on) { document.querySelectorAll('#main button').forEach(function (b) { b.disabled = on; }); }
    function load() {
        return api('GET', '/api/appraisal/me').then(function (me) {
            S.you = me.you; S.hasAdmin = me.hasAdmin; S.testSite = me.testSite; S.setup = me.setup; S.isStarter = me.isStarter; S.mine = me.mine;
            if (!me.you.isAdmin) return;
            return api('GET', '/api/appraisal/overview').then(function (o) { S.setup = o.setup; S.isStarter = o.isStarter; S.people = o.people; S.removed = o.removed || []; });
        }).then(function () { S.loaded = true; S.loadError = null; }, function (e) { S.loadError = e.message; });
    }
    var toastTimer;
    function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3600); }

    // ── Lookups (admin view) ────────────────────────────────────────────────
    // Everyone in S.people is on the appraisal staff list (the server sends no one else).
    function staffPeople() { return S.people; }
    function person(id) { return S.people.filter(function (p) { return p.id === id; })[0]; }
    function rolesOf(p) { return (p.mgr && p.mgr.roles) || []; }
    function extrasOf(p) { return (p && p.mgr && p.mgr.extras) || []; }
    function hiddenOf(p) { return (p && p.mgr && p.mgr.hidden) || []; }
    function profileOf(p) { return { roles: rolesOf(p), extras: extrasOf(p), hidden: hiddenOf(p) }; }
    function roleNames(ids) { return (S.setup.roles || []).filter(function (r) { return ids.indexOf(r.id) >= 0; }).map(function (r) { return r.name; }); }
    function mgrReview(p, q) { return (p.mgr && p.mgr.reviews && p.mgr.reviews[q]) || null; }
    function selfReview(p, q) {
        var own = p.self && p.self.reviews && p.self.reviews[q];
        if (own && own.submittedAt) return Object.assign({ source: 'staff' }, own);
        var typed = mgrReview(p, q) && mgrReview(p, q).selfByMgr;
        return typed && Object.keys(typed.scores || {}).length ? Object.assign({ source: 'manager' }, typed) : null;
    }

    // ── Render ──────────────────────────────────────────────────────────────
    function render() {
        var main = $('#main'), tabs = $('#tabs');
        if (S.loadError) { tabs.innerHTML = ''; main.innerHTML = '<div class="error">Could not load the appraisal: ' + esc(S.loadError) + '</div><p style="margin-top:12px"><button class="btn" data-act="reload">Try again</button></p>'; return; }
        if (!S.loaded) return;
        $('#sub').textContent = (S.you.isAdmin ? 'Manager view · ' : '') + 'Signed in as ' + S.you.name;
        var T = S.you.isAdmin ? [['reviews', 'Quarterly reviews'], ['meetings', '6-month meetings'], ['staff', 'Staff'], ['setup', 'Setup']] : [['mine', 'My review'], ['guide', 'How scoring works']];
        if (!S.tab) S.tab = T[0][0];
        tabs.innerHTML = T.map(function (t) { return '<button type="button" role="tab" aria-selected="' + (S.tab === t[0]) + '" data-act="tab" data-v="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var views = { reviews: S.open ? viewReview : viewReviews, meetings: S.openMeet ? viewMeeting : viewMeetings, staff: viewStaff, setup: viewSetup, mine: viewMine, guide: viewGuide };
        main.innerHTML = testSiteNotice() + starterNotice() + views[S.tab]();
    }
    function testSiteNotice() {
        return S.testSite ? '<div class="notice" style="margin-bottom:14px">Testing site: you are in as a test manager. Nothing saved here reaches the live appraisal.</div>' : '';
    }
    function starterNotice() {
        if (!S.you.isAdmin || !S.isStarter || S.tab === 'setup') return '';
        return '<div class="notice" style="margin-bottom:14px">You are using the starter setup. Check the roles, items and raise table in <button class="btn link" data-act="tab" data-v="setup">Setup</button> and save it.</div>';
    }
    function qSelect(id, val, count) { return '<select id="' + id + '" data-change="' + id + '">' + quarterList(count).map(function (q) { return '<option value="' + q.key + '"' + (q.key === val ? ' selected' : '') + '>' + esc(q.label) + '</option>'; }).join('') + '</select>'; }
    function hSelect(id, val) { return '<select id="' + id + '" data-change="' + id + '">' + halfList().map(function (h) { return '<option value="' + h.key + '"' + (h.key === val ? ' selected' : '') + '>' + esc(h.label) + '</option>'; }).join('') + '</select>'; }
    function seg(who, cid, val, readOnly) {
        var h = '<div class="seg" role="group" aria-label="Score 1 to 10">';
        for (var n = 1; n <= MAX; n++) {
            var lab = scaleOf(n).label;
            h += '<button type="button" class="' + (val === n ? 'on' : '') + '"' + (readOnly ? ' disabled' : '') + ' data-act="score" data-who="' + who + '" data-c="' + esc(cid) + '" data-v="' + n + '" aria-pressed="' + (val === n) + '" title="' + esc(n + (lab ? ' – ' + lab : '')) + '">' + n + '</button>';
        }
        return h + '</div>';
    }
    function emptyBox(title, text, btn) { return '<div class="empty"><h3>' + esc(title) + '</h3>' + (text ? '<p class="muted">' + text + '</p>' : '') + (btn || '') + '</div>'; }

    // Admin: quarterly list
    function viewReviews() {
        var qi = parseQ(S.q), list = staffPeople();
        var h = '<div class="stack"><div class="row between"><div class="row"><label class="lbl" for="q-pick" style="margin:0">Quarter</label>' + qSelect('q-pick', S.q, 6) + '</div><p class="small muted">Staff fill their form at the end of each quarter. You score them after.</p></div>';
        if (!list.length) return h + emptyBox('No staff yet', 'Add the people you appraise on the Staff tab.', '<button class="btn primary" data-act="tab" data-v="staff">Add staff</button>') + '</div>';
        var forms = 0, done = 0;
        var rows = list.map(function (p) {
            var g = groupsFor(profileOf(p)), self = selfReview(p, qi.key), mr = mgrReview(p, qi.key);
            if (self) forms++; if (mr && mr.done) done++;
            var form = self ? (self.source === 'staff' ? '<span class="chip ok">Submitted</span>' : '<span class="chip info">Typed in by you</span>') : '<span class="chip wait">Waiting</span>';
            var rev = mr && mr.done ? '<span class="chip ok">Done</span>' : (mr && Object.keys(mr.scores || {}).length ? '<span class="chip wait">Started</span>' : '<span class="chip">Not started</span>');
            var noRole = rolesOf(p).length ? '' : ' <span class="chip wait">No role</span>';
            return '<tr><td class="name">' + esc(p.name) + '</td><td class="small muted">' + esc(roleNames(rolesOf(p)).join(', ')) + noRole + '</td><td>' + form + '</td><td>' + scoreChip(self ? total(g, self.scores) : null) + '</td><td>' + rev + '</td><td>' + scoreChip(mr ? total(g, mr.scores) : null) + '</td><td><button class="btn sm" data-act="open-review" data-v="' + esc(p.id) + '">' + (mr && mr.done ? 'View' : 'Score') + '</button></td></tr>';
        }).join('');
        return h + '<p class="small"><strong>' + forms + ' of ' + list.length + '</strong> forms in · <strong>' + done + ' of ' + list.length + '</strong> reviewed for ' + esc(qi.label) + '</p><div class="tablewrap"><table><thead><tr><th>Name</th><th>Roles</th><th>Their form</th><th>Their score</th><th>Your review</th><th>Your score</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }

    // Admin: score one person
    function critRow(grp, c, self, d, typingSelf) {
        var sv = self && self.scores ? self.scores[c.id] : null, mv = d.scores[c.id];
        var gap = sv && mv && Math.abs(sv - mv) >= GAP;
        var theirs = typingSelf ? '<div class="row"><span class="who">Their score</span>' + seg('selfm', c.id, sv) + '</div>' : '<div class="row"><span class="who">They said</span>' + scoreChip(sv || null) + '</div>';
        var theirNote = typingSelf ? '<input type="text" id="sn-' + c.id + '" placeholder="Their comment (optional)" value="' + esc((d.selfByMgr.notes || {})[c.id] || '') + '" data-d="selfm:notes.' + c.id + '">'
            : (self && self.notes && self.notes[c.id] ? '<div class="selfnote"><span class="who">Their comment</span><br>' + esc(self.notes[c.id]) + '</div>' : '<div></div>');
        return '<div class="crit"><div><div class="cname">' + esc(c.name) + extraTag(c, 'them') + '</div><div class="hint">' + esc(c.hint || '') + '</div>' + (gap ? '<div class="flag">Big gap between their score and yours. Talk about this.</div>' : '') + '</div>'
            + '<div class="side">' + theirs + '<div class="row"><span class="who">Your score</span>' + seg('mgr', c.id, mv) + '</div></div>'
            + '<div class="notes">' + theirNote + '<input type="text" id="mn-' + c.id + '" placeholder="Your comment (optional)" value="' + esc((d.notes || {})[c.id] || '') + '" data-d="mgr:notes.' + c.id + '"></div></div>';
    }
    function viewReview() {
        var p = person(S.open); if (!p) { S.open = null; return viewReviews(); }
        var qi = parseQ(S.q), g = groupsFor(profileOf(p)), d = S.draft;
        var own = p.self && p.self.reviews && p.self.reviews[qi.key] && p.self.reviews[qi.key].submittedAt ? p.self.reviews[qi.key] : null;
        var typingSelf = !own && d.typeSelf, self = own || (typingSelf ? d.selfByMgr : null);
        var h = '<div class="stack"><div><button class="btn link" data-act="close-review">← All staff</button></div>'
            + '<div class="row between"><div><div class="eyebrow">' + esc(qi.label) + '</div><h2>' + esc(p.name) + '</h2><p class="small muted">' + esc(roleNames(rolesOf(p)).join(' · ') || 'No role picked yet. Pick roles in the Staff tab.') + '</p></div>' + (d.done ? '<span class="chip ok">Marked done</span>' : '') + '</div>';
        if (p.mgr && p.mgr.targets) h += '<div class="card"><div class="who">Their current targets</div><p class="pre">' + esc(p.mgr.targets) + '</p></div>';
        if (!own) h += '<div class="card row between"><p class="small">They have not submitted their form for this quarter. You can type in their answers from a paper form.</p><label class="check"><input type="checkbox" id="type-self" data-act="type-self"' + (typingSelf ? ' checked' : '') + '> Type in their self-review</label></div>';
        sections(g).forEach(function (grp) {
            h += '<section class="card"><div class="ghead"><h3>' + esc(grp.name) + '</h3><span class="weight">' + esc(grp.weightText) + '</span></div>' + grp.items.map(function (c) { return critRow(grp, c, self, d, typingSelf); }).join('') + '</section>';
        });
        if (own && (own.wins || own.help)) h += '<div class="grid2"><div class="card"><div class="who">Their biggest wins</div><p class="pre">' + esc(own.wins || '–') + '</p></div><div class="card"><div class="who">Where they want help</div><p class="pre">' + esc(own.help || '–') + '</p></div></div>';
        h += '<div class="card"><label class="lbl" for="mgr-comment">Your overall comment for this quarter</label><textarea id="mgr-comment" data-d="mgr:comment" placeholder="What went well, what to work on next quarter">' + esc(d.comment || '') + '</textarea></div>';
        var tm = total(g, d.scores);
        return h + '<div class="totals"><div class="row" style="gap:22px"><div class="tot"><span class="who">Their total</span><span class="big">' + fmt(self ? total(g, self.scores) : null) + '</span></div><div class="tot"><span class="who">Your total</span><span class="big">' + fmt(tm) + '</span></div><div class="tot"><span class="who">Rating</span><span>' + esc(band(tm) || '–') + '</span></div></div>'
            + '<div class="row"><span class="small muted" id="dirty">' + (S.dirty ? 'Unsaved changes' : '') + '</span>' + (d.done ? '<button class="btn primary" data-act="done-review">Save</button>' : '<button class="btn" data-act="save-review">Save</button><button class="btn primary" data-act="done-review">Save & mark done</button>') + '</div></div></div>';
    }

    // Admin: 6-month meetings
    function halfData(p, hi) {
        var g = groupsFor(profileOf(p));
        var qs = hi.quarters.map(function (qi) { var self = selfReview(p, qi.key), mr = mgrReview(p, qi.key); return { qi: qi, self: self, mr: mr, tSelf: self ? total(g, self.scores) : null, tMgr: mr ? total(g, mr.scores) : null }; });
        var m = qs.map(function (x) { return x.tMgr; }).filter(function (v) { return v != null; });
        var rating = m.length ? m.reduce(function (a, b) { return a + b; }, 0) / m.length : null;
        return { g: g, qs: qs, rating: rating, raise: raiseFor(rating), partial: m.length === 1 };
    }
    function meetingOf(p, hk) { return (p.mgr && p.mgr.meetings && p.mgr.meetings[hk]) || null; }
    function viewMeetings() {
        var hi = parseH(S.h), list = staffPeople();
        var h = '<div class="stack"><div class="row between"><div class="row"><label class="lbl" for="h-pick" style="margin:0">Half-year</label>' + hSelect('h-pick', S.h) + '</div><p class="small muted">The 6-month rating is the average of your two quarterly scores.</p></div>';
        if (!list.length) return h + emptyBox('No staff yet', 'Add the people you appraise on the Staff tab.', '<button class="btn primary" data-act="tab" data-v="staff">Add staff</button>') + '</div>';
        var rows = list.map(function (p) {
            var hd = halfData(p, hi), mt = meetingOf(p, hi.key);
            return '<tr><td class="name">' + esc(p.name) + '</td>' + hd.qs.map(function (x) { return '<td>' + scoreChip(x.tMgr) + '</td>'; }).join('')
                + '<td>' + scoreChip(hd.rating) + ' <span class="small muted">' + esc(band(hd.rating)) + (hd.partial ? ' (1 quarter only)' : '') + '</span></td><td>' + (hd.raise ? esc(hd.raise.pct + '%') : '–') + '</td>'
                + '<td>' + (mt && mt.done ? '<span class="chip ok">Held' + (mt.raisePct != null ? ' · ' + esc(mt.raisePct) + '% agreed' : '') + '</span>' : '<span class="chip">Not held</span>') + '</td><td><button class="btn sm" data-act="open-meet" data-v="' + esc(p.id) + '">Open</button></td></tr>';
        }).join('');
        return h + '<div class="tablewrap"><table><thead><tr><th>Name</th>' + hi.quarters.map(function (q) { return '<th>Q' + q.q + ' score</th>'; }).join('') + '<th>6-month rating</th><th>Suggested raise</th><th>Meeting</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }
    function gapsFor(hd) {
        var out = [];
        hd.qs.forEach(function (x) {
            if (!x.self || !x.mr) return;
            hd.g.forEach(function (grp) { grp.items.forEach(function (c) { var a = (x.self.scores || {})[c.id], b = (x.mr.scores || {})[c.id]; if (a && b && Math.abs(a - b) >= GAP) out.push('Q' + x.qi.q + ' · ' + c.name + ': they said ' + a + ', you said ' + b); }); });
        });
        return out;
    }
    function quarterCard(x) {
        return '<div class="card stack" style="gap:7px"><div class="who">' + esc(x.qi.label) + '</div><div class="kv"><span class="small muted">Their score</span><span>' + scoreChip(x.tSelf) + '</span><span class="small muted">Your score</span><span>' + scoreChip(x.tMgr) + (x.mr && !x.mr.done ? ' <span class="small muted">not marked done</span>' : '') + '</span></div>'
            + (x.mr && x.mr.comment ? '<p class="small pre">' + esc(x.mr.comment) + '</p>' : '') + (x.self && x.self.wins ? '<p class="small"><strong>Their wins:</strong> ' + esc(x.self.wins) + '</p>' : '') + (x.self && x.self.help ? '<p class="small"><strong>Wants help with:</strong> ' + esc(x.self.help) + '</p>' : '') + '</div>';
    }
    function viewMeeting() {
        var p = person(S.openMeet); if (!p) { S.openMeet = null; return viewMeetings(); }
        var hi = parseH(S.h), hd = halfData(p, hi), d = S.meetDraft, gaps = gapsFor(hd);
        var h = '<div class="stack"><div><button class="btn link" data-act="close-meet">← All staff</button></div><div><div class="eyebrow">6-month meeting · ' + esc(hi.label) + '</div><h2>' + esc(p.name) + '</h2></div>'
            + '<div class="grid2">' + hd.qs.map(quarterCard).join('') + '<div class="card stack" style="gap:7px"><div class="who">6-month result</div><div class="big">' + fmt(hd.rating) + '</div><p>' + esc(band(hd.rating) || 'Score both quarters first') + (hd.partial ? ' <span class="small muted">(only 1 quarter scored)</span>' : '') + '</p>'
            + '<p class="small">Suggested raise: <strong>' + (hd.raise ? esc(hd.raise.pct + '%') : '–') + '</strong>' + (hd.raise && hd.raise.note ? ' <span class="muted">· ' + esc(hd.raise.note) + '</span>' : '') + '</p></div></div>';
        if (gaps.length) h += '<div class="card"><div class="who">Talk about these (big gaps)</div><ul class="small" style="margin:6px 0 0">' + gaps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
        h += '<div class="card stack"><div><label class="lbl" for="m-well">What went well</label><textarea id="m-well" data-d="meet:wentWell">' + esc(d.wentWell || '') + '</textarea></div>'
            + '<div><label class="lbl" for="m-improve">What to improve</label><textarea id="m-improve" data-d="meet:improve">' + esc(d.improve || '') + '</textarea></div>'
            + '<div><label class="lbl" for="m-targets">Targets for the next 6 months</label><textarea id="m-targets" data-d="meet:newTargets">' + esc(d.newTargets || '') + '</textarea><label class="check small" style="margin-top:7px"><input type="checkbox" id="m-settargets" data-act="meet-settargets"' + (d.setTargets ? ' checked' : '') + '> Show these as their targets on their form</label></div>'
            + '<div class="grid2"><div><label class="lbl" for="m-raise">Raise agreed (%)</label><input type="number" id="m-raise" min="0" max="100" step="0.5" data-d="meet:raisePct" data-num="1" value="' + (d.raisePct == null ? '' : d.raisePct) + '"></div><div><label class="lbl" for="m-date">Meeting date</label><input type="date" id="m-date" data-d="meet:date" value="' + esc(d.date || '') + '"></div></div></div>';
        return h + '<div class="totals"><span class="small muted" id="dirty">' + (S.dirty ? 'Unsaved changes' : '') + '</span><div class="row"><button class="btn" data-act="save-meet">Save</button><button class="btn primary" data-act="done-meet">Save & mark held</button></div></div></div>';
    }

    // Admin: the staff list, and each person's jobs, targets and full item list
    /** What one person's form shows, as editor sections: each ticked job (plus any heading one of
     *  their own items sits under), then Behaviour. A heading whose job was removed in Setup shows
     *  as such, so its items can be moved or removed rather than silently dropped on save. */
    function editorSections(e) {
        var jobs = S.setup.roles || [], ids = e.roles.slice();
        e.extras.forEach(function (x) { if (x.section !== 'behaviour' && ids.indexOf(x.section) < 0) ids.push(x.section); });
        var order = jobs.map(function (j) { return j.id; });
        ids.sort(function (a, b) { var i = order.indexOf(a), k = order.indexOf(b); return (i < 0 ? 1e9 : i) - (k < 0 ? 1e9 : k); });
        var out = ids.map(function (id) {
            var r = jobs.filter(function (j) { return j.id === id; })[0];
            return r ? { id: id, name: r.name, shared: e.roles.indexOf(id) >= 0 ? (r.criteria || []) : [] } : { id: id, name: 'Job removed in Setup', shared: [], orphan: true };
        });
        out.push({ id: 'behaviour', name: 'Behaviour', shared: S.setup.behaviour || [] });
        return out;
    }
    function sharedItemRow(c, e) {
        var off = e.hidden.indexOf(c.id) >= 0;
        return '<div class="itemrow' + (off ? ' off' : '') + '"><div><div class="cname">' + esc(c.name) + (off ? ' <span class="chip">Removed for them</span>' : '') + '</div><div class="hint">' + esc(c.hint || '') + '</div></div>'
            + (off ? '<button class="btn sm" data-act="p-unhide" data-v="' + esc(c.id) + '">Put back</button>' : '<button class="btn sm danger" data-act="p-hide" data-v="' + esc(c.id) + '">Remove</button>') + '</div>';
    }
    function ownItemRow(x, i, orphan) {
        var opts = (S.setup.roles || []).map(function (r) { return [r.id, r.name]; }).concat([['behaviour', 'Behaviour']]);
        var move = orphan ? '<select id="px-' + i + '-s" aria-label="Move under" data-d="person:extras.' + i + '.section"><option value="' + esc(x.section) + '" selected>Move under…</option>' + opts.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('') + '</select>' : '';
        return '<div class="itemrow own"><div class="editrow" style="padding:0"><input type="text" id="px-' + i + '-n" aria-label="Item name" placeholder="What is judged" value="' + esc(x.name) + '" data-d="person:extras.' + i + '.name">'
            + '<input type="text" id="px-' + i + '-h" aria-label="What good looks like" placeholder="What good looks like" value="' + esc(x.hint || '') + '" data-d="person:extras.' + i + '.hint">' + move + '</div>'
            + '<div class="row" style="gap:6px"><span class="chip info">Only for them</span><button class="btn sm danger" data-act="p-del-extra" data-i="' + i + '">Remove</button></div></div>';
    }
    /** One person's whole list, section by section: shared items (remove / put back for them only)
     *  and their own items (edit / remove), with an add button under every heading. */
    function itemsEditor(e, name) {
        var count = groupsFor(e).reduce(function (n, g) { return n + g.items.length; }, 0);
        return '<div class="stack" style="gap:10px"><div><span class="lbl" style="margin:0">Everything ' + esc(name) + ' is scored on · ' + count + ' items</span><p class="small muted">Removing a shared item here removes it for ' + esc(name) + ' only. To change it for everyone, use Setup.</p></div>'
            + editorSections(e).map(function (sec) {
                var own = e.extras.map(function (x, i) { return x.section === sec.id ? ownItemRow(x, i, sec.orphan) : ''; }).join('');
                return '<div class="itemsec"><h4>' + esc(sec.name) + '</h4>' + sec.shared.map(function (c) { return sharedItemRow(c, e); }).join('') + own
                    + (sec.orphan ? '' : '<div><button class="btn sm link" data-act="p-add-extra" data-v="' + esc(sec.id) + '">+ Add an item under ' + esc(sec.name) + '</button></div>') + '</div>';
            }).join('') + '</div>';
    }
    function personEditor(e) {
        var p = person(e.id), name = p ? p.name : '';
        return '<div class="card stack"><h3>' + esc(name) + '</h3>'
            + '<div class="grid2"><div><label class="lbl" for="p-name">Name</label><input type="text" id="p-name" data-d="person:name" value="' + esc(e.name) + '"></div>'
            + '<div><label class="lbl" for="p-email">Email they sign in with (optional)</label><input type="email" id="p-email" data-d="person:email" value="' + esc(e.email) + '"></div></div>'
            + '<div><span class="lbl">Jobs they do (pick all that apply)</span><div class="row">'
            + (S.setup.roles || []).map(function (r) { return '<label class="check"><input type="checkbox" id="pr-' + r.id + '" data-act="p-role" data-v="' + r.id + '"' + (e.roles.indexOf(r.id) >= 0 ? ' checked' : '') + '> ' + esc(r.name) + '</label>'; }).join('')
            + '</div></div><div><label class="lbl" for="p-targets">Current targets</label><textarea id="p-targets" data-d="person:targets" placeholder="For example: ₹40 lakh in orders this quarter, 5 new customers, no invoice over 60 days">' + esc(e.targets || '') + '</textarea></div>'
            + itemsEditor(e, name)
            + '<div class="row"><button class="btn primary" data-act="p-save">Save</button><button class="btn" data-act="p-cancel">Cancel</button></div></div>';
    }
    function addStaffCard() {
        var n = S.newStaff;
        return '<div class="card stack"><h3>Add a staff member</h3><div class="grid2"><div><label class="lbl" for="ns-name">Name</label><input type="text" id="ns-name" data-d="newstaff:name" value="' + esc(n.name) + '"></div>'
            + '<div><label class="lbl" for="ns-email">Email they sign in with (optional)</label><input type="email" id="ns-email" data-d="newstaff:email" value="' + esc(n.email) + '" placeholder="Leave blank if they won\'t fill their own form"></div></div>'
            + '<div><button class="btn primary" data-act="staff-add">Add</button></div></div>';
    }
    function staffRow(p) {
        var t = (p.mgr && p.mgr.targets) || '', items = groupsFor(profileOf(p)).reduce(function (n, g) { return n + g.items.length; }, 0);
        var armed = S.removeArmed === p.id;
        return '<tr><td class="name">' + esc(p.name) + '</td><td class="small muted">' + esc(p.email || '–') + '</td><td>' + (roleNames(rolesOf(p)).map(function (n) { return '<span class="chip">' + esc(n) + '</span>'; }).join(' ') || '<span class="chip wait">None</span>') + '</td>'
            + '<td class="small">' + items + '</td><td class="small muted">' + esc(t.slice(0, 50)) + (t.length > 50 ? '…' : '') + '</td>'
            + '<td style="white-space:nowrap"><button class="btn sm" data-act="p-edit" data-v="' + esc(p.id) + '">Edit</button> <button class="btn sm danger" data-act="staff-remove" data-v="' + esc(p.id) + '">' + (armed ? 'Click again to remove' : 'Remove') + '</button></td></tr>';
    }
    function viewStaff() {
        var e = S.editPerson, list = staffPeople();
        var h = '<div class="stack"><p class="small muted">Everyone on this list is appraised. Click Edit to set their jobs and see or change everything they are scored on. To let someone fill their own form, add the email they sign in with (they also need to be on the <a href="/people.html">People page</a>).</p>';
        h += e ? personEditor(e) : addStaffCard();
        if (!list.length) return h + emptyBox('No staff yet', 'Add your first staff member above.') + removedStaff() + '</div>';
        return h + '<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Jobs</th><th>Items</th><th>Targets</th><th></th></tr></thead><tbody>' + list.map(staffRow).join('') + '</tbody></table></div>' + removedStaff() + '</div>';
    }
    /** People taken off the list. Their scores were kept, so Bring back restores everything. */
    function removedStaff() {
        var r = S.removed || [];
        if (!r.length) return '';
        return '<details class="card"><summary style="cursor:pointer;font-weight:600">Removed staff (' + r.length + ')</summary><div class="stack" style="gap:6px;margin-top:10px">'
            + r.map(function (p) { return '<div class="row between"><span>' + esc(p.name) + (p.email ? ' <span class="small muted">' + esc(p.email) + '</span>' : '') + ' <span class="small muted">· removed ' + esc(new Date(p.removedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) + '</span></span><button class="btn sm" data-act="staff-restore" data-v="' + esc(p.id) + '">Bring back</button></div>'; }).join('')
            + '</div></details>';
    }

    // Admin: setup
    function critList(path, list) {
        return (list || []).map(function (c, i) {
            return '<div class="editrow"><input type="text" id="' + path + '-' + i + '-n" aria-label="Item name" value="' + esc(c.name) + '" data-d="setup:' + path + '.' + i + '.name" placeholder="What is judged"><input type="text" id="' + path + '-' + i + '-h" aria-label="What good looks like" value="' + esc(c.hint || '') + '" data-d="setup:' + path + '.' + i + '.hint" placeholder="What good looks like"><button class="btn sm danger" data-act="del-item" data-list="' + path + '" data-i="' + i + '">Remove</button></div>';
        }).join('') + '<div><button class="btn sm link" data-act="add-item" data-list="' + path + '">+ Add item</button></div>';
    }
    /** The server drops a role or item with no name, so it would vanish silently on save. */
    function blankNames(d) {
        var unnamed = function (x) { return !String((x && x.name) || '').trim(); };
        return d.roles.some(function (r) { return unnamed(r) || (r.criteria || []).some(unnamed); }) || d.behaviour.some(unnamed);
    }
    function weightSum(d) { return GROUPS.reduce(function (a, g) { return a + Number((d.weights || {})[g[0]] || 0); }, 0); }
    function viewSetup() {
        if (!S.setupDraft) S.setupDraft = clone(S.setup);
        var d = S.setupDraft, sum = weightSum(d);
        var h = '<div class="stack">' + (S.isStarter ? '<div class="notice">This is the starter setup. Nothing is saved until you press Save setup.</div>' : '')
            + '<section class="card stack"><div><h3>Scoring scale</h3><p class="small muted">Everyone scores 1 to 10 using these meanings.</p></div>' + d.scale.map(function (s, i) { return '<div class="scalerow"><span class="score ' + colourOf(s.n) + '">' + s.n + '</span><input type="text" id="sc-' + i + '-l" aria-label="Name for ' + s.n + '" value="' + esc(s.label) + '" data-d="setup:scale.' + i + '.label"><input type="text" id="sc-' + i + '-d" aria-label="Meaning of ' + s.n + '" value="' + esc(s.desc) + '" data-d="setup:scale.' + i + '.desc"></div>'; }).join('') + '</section>'
            + '<section class="card stack"><div><h3>How much each part counts</h3><p class="small muted">Must add up to 100%.</p></div><div class="grid2">' + GROUPS.map(function (g) { return '<div><label class="lbl" for="w-' + g[0] + '">' + g[1] + ' (%)</label><input type="number" id="w-' + g[0] + '" min="0" max="100" value="' + ((d.weights || {})[g[0]] || 0) + '" data-d="setup:weights.' + g[0] + '" data-num="1"></div>'; }).join('') + '</div><p class="small" id="wsum" style="color:' + (sum === 100 ? 'var(--good)' : 'var(--bad)') + '">Total: ' + sum + '%</p></section>'
            + '<section class="card stack"><div><h3>Roles and what they are judged on</h3><p class="small muted">These make up Work results. A person with two roles is scored on both lists.</p></div>'
            + d.roles.map(function (r, ri) { return '<div class="stack" style="gap:5px;border-top:1px solid var(--line);padding-top:12px"><div class="row between"><input type="text" id="role-' + ri + '" aria-label="Role name" style="max-width:260px;font-weight:600" value="' + esc(r.name) + '" data-d="setup:roles.' + ri + '.name"><button class="btn sm danger" data-act="del-role" data-i="' + ri + '">Remove role</button></div>' + critList('roles.' + ri + '.criteria', r.criteria) + '</div>'; }).join('')
            + '<div><button class="btn" data-act="add-role">+ Add role</button></div></section>'
            + '<section class="card stack"><div><h3>Behaviour</h3><p class="small muted">Everyone is scored on these.</p></div>' + critList('behaviour', d.behaviour) + '</section>'
            + '<section class="card stack"><div><h3>Raise table</h3><p class="small muted">The 6-month rating picks the highest row it reaches. Change the numbers to fit your budget.</p></div>'
            + d.raises.map(function (r, i) { return '<div class="raiserow"><div><label class="lbl" for="r-' + i + '-m">Rating from</label><input type="number" id="r-' + i + '-m" step="0.1" min="0" max="10" value="' + r.min + '" data-d="setup:raises.' + i + '.min" data-num="1"></div><div><label class="lbl" for="r-' + i + '-p">Raise %</label><input type="number" id="r-' + i + '-p" step="0.5" min="0" max="100" value="' + r.pct + '" data-d="setup:raises.' + i + '.pct" data-num="1"></div><div><label class="lbl" for="r-' + i + '-n">Note</label><input type="text" id="r-' + i + '-n" value="' + esc(r.note || '') + '" data-d="setup:raises.' + i + '.note"></div><button class="btn sm danger" data-act="del-raise" data-i="' + i + '">Remove</button></div>'; }).join('')
            + '<div><button class="btn sm link" data-act="add-raise">+ Add row</button></div></section>';
        return h + '<div class="totals"><span class="small muted" id="dirty">' + (S.dirty ? 'Unsaved changes' : '') + '</span><div class="row"><button class="btn" data-act="setup-discard">Discard changes</button><button class="btn primary" data-act="setup-save">Save setup</button></div></div></div>';
    }

    // Staff: my review
    function viewMine() {
        if (!S.hasAdmin) return emptyBox('Not set up yet', 'Nobody is an admin on the People page yet, so there is no manager to review forms.');
        if (!S.mine) return emptyBox('You are not on the staff list yet', 'Ask your manager to add you on the Staff tab, with the email you sign in with.');
        var quarters = quarterList(4);
        if (!quarters.some(function (q) { return q.key === S.q; })) S.q = quarters[1].key;
        var saved = S.mine.reviews[S.q] || null, locked = S.mine.lockedQuarters.indexOf(S.q) >= 0;
        if (S.myDraftKey !== S.q) { S.myDraft = clone(saved) || { scores: {}, notes: {}, wins: '', help: '' }; S.myDraftKey = S.q; S.dirty = false; }
        var d = S.myDraft, g = groupsFor(S.mine), qi = parseQ(S.q), left = unscored(g, d.scores);
        var chip = locked ? '<span class="chip info">Reviewed by your manager</span>' : saved ? '<span class="chip ok">Submitted ' + esc(new Date(saved.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })) + '</span>' : '<span class="chip wait">Not submitted</span>';
        var h = '<div class="stack"><div class="row between"><div class="row"><label class="lbl" for="my-q" style="margin:0">Quarter</label>' + qSelect('my-q', S.q, 4) + '</div>' + chip + '</div>'
            + '<p class="small muted">Score yourself honestly for ' + esc(qi.label) + '. Your manager will score you too, and you will go over both at the 6-month meeting.</p>';
        if (!S.mine.roles.length) h += '<div class="notice">Your manager has not picked your roles yet, so the Work results part is missing. You can still fill the rest.</div>';
        if (S.mine.targets) h += '<div class="card"><div class="who">Your targets</div><p class="pre">' + esc(S.mine.targets) + '</p></div>';
        h += '<details class="card"><summary style="cursor:pointer;font-weight:600">What the scores mean</summary><div class="legend" style="margin-top:10px">' + [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(function (n) { return scoreChip(n) + '<div><strong>' + esc(scaleOf(n).label) + '</strong> <span class="small muted">' + esc(scaleOf(n).desc) + '</span></div>'; }).join('') + '</div></details>';
        sections(g).forEach(function (grp) {
            h += '<section class="card"><div class="ghead"><h3>' + esc(grp.name) + '</h3><span class="weight">' + esc(grp.weightText) + '</span></div>' + grp.items.map(function (c) {
                return '<div class="crit"><div><div class="cname">' + esc(c.name) + extraTag(c, 'you') + '</div><div class="hint">' + esc(c.hint || '') + '</div></div><div class="side">' + seg('self', c.id, d.scores[c.id], locked) + '</div><div class="notes"><input type="text" id="my-n-' + c.id + '" placeholder="Example or comment (optional)" value="' + esc((d.notes || {})[c.id] || '') + '" data-d="self:notes.' + c.id + '"' + (locked ? ' disabled' : '') + '></div></div>';
            }).join('') + '</section>';
        });
        h += '<div class="grid2"><div class="card"><label class="lbl" for="my-wins">Your biggest wins this quarter</label><textarea id="my-wins" data-d="self:wins"' + (locked ? ' disabled' : '') + '>' + esc(d.wins || '') + '</textarea></div><div class="card"><label class="lbl" for="my-help">Where you want help</label><textarea id="my-help" data-d="self:help"' + (locked ? ' disabled' : '') + '>' + esc(d.help || '') + '</textarea></div></div>';
        return h + '<div class="totals"><div class="tot"><span class="who">Your total</span><span class="big">' + fmt(total(g, d.scores)) + '</span></div><div class="row"><span class="small muted" id="dirty">' + (S.dirty ? 'Unsaved changes' : (left && !locked ? left + ' still to score' : '')) + '</span>'
            + (locked ? '' : '<button class="btn primary" data-act="submit-self">' + (saved ? 'Update my form' : 'Submit my form') + '</button>') + '</div></div></div>';
    }
    function viewGuide() {
        var w = S.setup.weights || {};
        return '<div class="stack"><section class="card stack"><h3>How it works</h3><ol class="small" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px"><li>At the end of each quarter (June, September, December, March), fill your form on the My review tab.</li><li>Your manager scores you on the same items.</li><li>Every 6 months you meet one-on-one to go over both scores and agree new targets.</li><li>Your 6-month rating decides your raise.</li></ol></section>'
            + '<section class="card stack"><h3>What the scores mean</h3><div class="legend">' + [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(function (n) { return scoreChip(n) + '<div><strong>' + esc(scaleOf(n).label) + '</strong><br><span class="small muted">' + esc(scaleOf(n).desc) + '</span></div>'; }).join('') + '</div></section>'
            + '<section class="card stack"><h3>How your total is worked out</h3><div class="kv">' + GROUPS.map(function (g) { return '<span>' + g[1] + '</span><span class="weight">' + (w[g[0]] || 0) + '%</span>'; }).join('') + '</div><p class="small muted">Each part is the average of its items. Work results items depend on the roles you play.</p></section></div>';
    }

    // ── Editing drafts ──────────────────────────────────────────────────────
    function setPath(obj, path, val) { var ks = path.split('.'), o = obj; for (var i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = val; }
    function draftFor(who) {
        if (who === 'selfm') { if (!S.draft) return null; S.draft.selfByMgr = S.draft.selfByMgr || { scores: {}, notes: {} }; return S.draft.selfByMgr; }
        return { mgr: S.draft, self: S.myDraft, meet: S.meetDraft, person: S.editPerson, setup: S.setupDraft, newstaff: S.newStaff }[who];
    }
    function markDirty() { S.dirty = true; var el = $('#dirty'); if (el) el.textContent = 'Unsaved changes'; }
    /** Arm one Remove button for 4 seconds by changing only its own label. */
    function armRemove(id) {
        var label = function (on) {
            var btn = Array.prototype.filter.call(document.querySelectorAll('[data-act="staff-remove"]'), function (x) { return x.dataset.v === id; })[0];
            if (btn) btn.textContent = on ? 'Click again to remove' : 'Remove';
        };
        if (S.removeArmed) { var old = S.removeArmed; S.removeArmed = null; Array.prototype.forEach.call(document.querySelectorAll('[data-act="staff-remove"]'), function (x) { if (x.dataset.v === old) x.textContent = 'Remove'; }); }
        S.removeArmed = id; S.removeArmedAt = Date.now(); label(true);
        setTimeout(function () { if (S.removeArmed === id) { S.removeArmed = null; label(false); } }, 4000);
    }
    /** Leaving with unsaved changes needs a second click. */
    function okToLeave() {
        if (!S.dirty) return true;
        if (S.leaveArmed) { S.leaveArmed = false; return true; }
        S.leaveArmed = true; toast('You have unsaved changes. Click again to leave without saving.');
        setTimeout(function () { S.leaveArmed = false; }, 4000);
        return false;
    }
    function afterSave(msg) { S.dirty = false; return load().then(function () { toast(msg); render(); }); }

    document.addEventListener('input', function (ev) {
        var el = ev.target; if (!el.dataset.d) return;
        var parts = el.dataset.d.split(/:(.*)/), tgt = draftFor(parts[0]); if (!tgt) return;
        var v = el.value; if (el.dataset.num) v = v === '' ? null : Number(v);
        setPath(tgt, parts[1], v); markDirty();
        if (parts[0] === 'setup' && parts[1].indexOf('weights.') === 0) { var s = weightSum(S.setupDraft), w = $('#wsum'); w.textContent = 'Total: ' + s + '%'; w.style.color = s === 100 ? 'var(--good)' : 'var(--bad)'; }
    });
    document.addEventListener('change', function (ev) {
        var el = ev.target, k = el.dataset.change; if (!k) return;
        if (!okToLeave()) { el.value = k === 'h-pick' ? S.h : S.q; return; }
        S.dirty = false;
        if (k === 'h-pick') S.h = el.value; else S.q = el.value;
        render();
    });
    window.addEventListener('beforeunload', function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

    // ── Clicks ──────────────────────────────────────────────────────────────
    function listAt(path) { return path.split('.').reduce(function (o, k) { return o[k]; }, S.setupDraft); }
    function saveReview(markDone) {
        var d = clone(S.draft), base = d.base, typeSelf = d.typeSelf;
        delete d.base; delete d.typeSelf;
        if (!typeSelf) delete d.selfByMgr;
        if (markDone) {
            var left = unscored(groupsFor(profileOf(person(S.open))), d.scores);
            if (left) { toast('Score every item first. ' + left + ' still to score.'); return; }
            d.done = true;
        }
        save('PUT', '/api/appraisal/review/' + encodeURIComponent(S.open) + '/' + S.q, { review: d, baseSavedAt: base }, function (r) {
            if (markDone) S.open = null; else { S.draft.base = r.review.savedAt; S.draft.done = r.review.done; }
            return afterSave(markDone ? 'Review saved and marked done' : 'Saved');
        });
    }
    function saveMeeting(markDone) {
        var warn = null;   // a targets failure must outlast the "Meeting saved" message
        var d = clone(S.meetDraft), base = d.base, setTargets = d.setTargets, id = S.openMeet, p = person(id);
        delete d.base; delete d.setTargets;
        if (markDone) d.done = true;
        save('PUT', '/api/appraisal/meeting/' + encodeURIComponent(id) + '/' + S.h, { meeting: d, baseSavedAt: base }, function (r) {
            var t = (d.newTargets || '').trim();
            var next = setTargets && t && t !== ((p.mgr && p.mgr.targets) || '')
                ? api('PUT', '/api/appraisal/profile/' + encodeURIComponent(id), { roles: rolesOf(p), targets: t, baseSavedAt: (p.mgr && p.mgr.profileSavedAt) || null })
                    .catch(function (e) { warn = 'Meeting saved, but the new targets were not: ' + e.message; })
                : Promise.resolve();
            return next.then(function () {
                if (markDone) S.openMeet = null; else { S.meetDraft.base = r.meeting.savedAt; }
                return afterSave(warn || (markDone ? 'Meeting saved' : 'Saved'));
            });
        });
    }
    var actions = {
        reload: function () { S.loadError = null; render(); load().then(render); },
        tab: function (b) { if (!okToLeave()) return; S.tab = b.dataset.v; S.open = S.openMeet = S.editPerson = S.setupDraft = S.removeArmed = null; S.newStaff = { name: '', email: '' }; S.myDraftKey = null; S.dirty = false; window.scrollTo(0, 0); render(); },
        score: function (b) { var d = draftFor(b.dataset.who); if (!d) return; d.scores = d.scores || {}; d.scores[b.dataset.c] = Number(b.dataset.v); markDirty(); render(); },
        'open-review': function (b) {
            var p = person(b.dataset.v), cur = mgrReview(p, S.q);
            S.open = p.id; S.draft = clone(cur) || { scores: {}, notes: {}, comment: '', done: false };
            S.draft.scores = S.draft.scores || {}; S.draft.notes = S.draft.notes || {};
            S.draft.typeSelf = !!(S.draft.selfByMgr && Object.keys(S.draft.selfByMgr.scores || {}).length);
            S.draft.base = cur ? cur.savedAt : null; S.dirty = false; window.scrollTo(0, 0); render();
        },
        'close-review': function () { if (!okToLeave()) return; S.open = null; S.dirty = false; render(); },
        'type-self': function (b) { S.draft.typeSelf = b.checked; S.draft.selfByMgr = S.draft.selfByMgr || { scores: {}, notes: {} }; markDirty(); render(); },
        'save-review': function () { saveReview(false); },
        'done-review': function () { saveReview(true); },
        'open-meet': function (b) {
            var p = person(b.dataset.v), hd = halfData(p, parseH(S.h)), cur = meetingOf(p, S.h);
            S.openMeet = p.id; S.meetDraft = clone(cur) || { wentWell: '', improve: '', newTargets: '', raisePct: hd.raise ? hd.raise.pct : null, date: '', done: false };
            S.meetDraft.base = cur ? cur.savedAt : null; S.meetDraft.setTargets = true; S.dirty = false; window.scrollTo(0, 0); render();
        },
        'close-meet': function () { if (!okToLeave()) return; S.openMeet = null; S.dirty = false; render(); },
        'meet-settargets': function (b) { S.meetDraft.setTargets = b.checked; markDirty(); },
        'save-meet': function () { saveMeeting(false); },
        'done-meet': function () { saveMeeting(true); },
        'p-edit': function (b) {
            if (!okToLeave()) return;
            var p = person(b.dataset.v);
            S.editPerson = { id: p.id, name: p.name, email: p.email || '', roles: rolesOf(p).slice(), targets: (p.mgr && p.mgr.targets) || '', extras: clone(extrasOf(p)), hidden: hiddenOf(p).slice(), base: (p.mgr && p.mgr.profileSavedAt) || null };
            S.dirty = false; window.scrollTo(0, 0); render();
        },
        'p-add-extra': function (b) {
            var e = S.editPerson; if (!e) return;
            e.extras.push({ id: newId('x_'), name: '', hint: '', section: b.dataset.v }); markDirty(); render();
            var el = document.getElementById('px-' + (e.extras.length - 1) + '-n'); if (el) el.focus();
        },
        'p-del-extra': function (b) { if (!S.editPerson) return; S.editPerson.extras.splice(+b.dataset.i, 1); markDirty(); render(); },
        'p-hide': function (b) { if (!S.editPerson) return; var h = S.editPerson.hidden; if (h.indexOf(b.dataset.v) < 0) h.push(b.dataset.v); markDirty(); render(); },
        'p-unhide': function (b) { if (!S.editPerson) return; var h = S.editPerson.hidden, i = h.indexOf(b.dataset.v); if (i >= 0) h.splice(i, 1); markDirty(); render(); },
        'p-cancel': function () { if (!okToLeave()) return; S.editPerson = null; S.dirty = false; render(); },
        'p-role': function (b) { if (!S.editPerson) return; var r = S.editPerson.roles, i = r.indexOf(b.dataset.v); if (b.checked && i < 0) r.push(b.dataset.v); if (!b.checked && i >= 0) r.splice(i, 1); markDirty(); render(); },
        /** Name/email first (the likelier one to be refused, e.g. an email already in use), then the
         *  jobs, targets and items. If the second fails the panel stays open with the edits in it. */
        'p-save': function () {
            var e = S.editPerson, p = person(e.id), jobs = (S.setup.roles || []).map(function (r) { return r.id; }).concat(['behaviour']);
            if (!String(e.name || '').trim()) { toast('Type their name.'); return; }
            if (e.extras.some(function (x) { return !String(x.name || '').trim(); })) { toast('One of their own items has no name. Type a name or remove it.'); return; }
            if (e.extras.some(function (x) { return jobs.indexOf(x.section) < 0; })) { toast('Move or remove the items under "Job removed in Setup" first.'); return; }
            var details = e.name.trim() !== p.name || e.email.trim().toLowerCase() !== (p.email || '');
            run(function () {
                var first = details ? api('PUT', '/api/appraisal/staff/' + encodeURIComponent(e.id), { name: e.name, email: e.email }) : Promise.resolve();
                return first.then(function () { return api('PUT', '/api/appraisal/profile/' + encodeURIComponent(e.id), { roles: e.roles, targets: e.targets, extras: e.extras, hidden: e.hidden, baseSavedAt: e.base }); });
            }, function () { S.editPerson = null; return afterSave('Saved'); });
        },
        'staff-add': function () {
            var n = S.newStaff;
            if (!String(n.name || '').trim()) { toast('Type a name first.'); return; }
            save('POST', '/api/appraisal/staff', { name: n.name, email: n.email }, function (r) {
                S.newStaff = { name: '', email: '' };
                return afterSave(r.staff && r.staff.name ? r.staff.name + ' added' : 'Added');
            });
        },
        /** Removing needs a second, separate click within 4 seconds (a double-click doesn't count).
         *  Not while someone's Edit panel is open: saving the removal would clear its unsaved-changes guard. */
        'staff-remove': function (b) {
            var id = b.dataset.v, p = person(id);
            if (S.editPerson) { toast('Save or cancel the open Edit panel first.'); return; }
            if (S.removeArmed !== id) { armRemove(id); return; }
            if (Date.now() - S.removeArmedAt < 400) return;
            S.removeArmed = null;
            save('DELETE', '/api/appraisal/staff/' + encodeURIComponent(id), null, function () {
                return afterSave((p ? p.name : 'They') + ' removed. Their past scores are kept under Removed staff.');
            });
        },
        'staff-restore': function (b) {
            if (S.editPerson) { toast('Save or cancel the open Edit panel first.'); return; }
            save('POST', '/api/appraisal/staff/' + encodeURIComponent(b.dataset.v) + '/restore', null, function (r) {
                return afterSave((r.staff && r.staff.name ? r.staff.name : 'They') + ' is back, with everything they had.');
            });
        },
        'add-item': function (b) { listAt(b.dataset.list).push({ id: newId('c'), name: '', hint: '' }); markDirty(); render(); },
        'del-item': function (b) { listAt(b.dataset.list).splice(+b.dataset.i, 1); markDirty(); render(); },
        'add-role': function () { S.setupDraft.roles.push({ id: newId('r'), name: 'New role', criteria: [] }); markDirty(); render(); },
        'del-role': function (b) { S.setupDraft.roles.splice(+b.dataset.i, 1); markDirty(); render(); },
        'add-raise': function () { S.setupDraft.raises.push({ min: 0, pct: 0, note: '' }); markDirty(); render(); },
        'del-raise': function (b) { S.setupDraft.raises.splice(+b.dataset.i, 1); markDirty(); render(); },
        'setup-discard': function () { S.setupDraft = null; S.dirty = false; render(); },
        'setup-save': function () {
            var d = S.setupDraft, sum = weightSum(d);
            if (sum !== 100) { toast('The two parts add up to ' + sum + '%. Make them 100%.'); return; }
            if (blankNames(d)) { toast('Some roles or items have no name. Type a name or remove them.'); return; }
            save('PUT', '/api/appraisal/setup', { setup: d, baseSavedAt: S.isStarter ? null : S.setup.savedAt }, function () { S.setupDraft = null; return afterSave('Setup saved'); });
        },
        'submit-self': function () {
            var g = groupsFor(S.mine), left = unscored(g, S.myDraft.scores);
            if (left) { toast('Score every item first. ' + left + ' still to score.'); return; }
            var saved = S.mine.reviews[S.q];
            save('PUT', '/api/appraisal/self/' + S.q, { review: S.myDraft, baseSavedAt: saved ? saved.savedAt : null }, function () { S.myDraftKey = null; return afterSave('Your form is submitted'); });
        }
    };
    document.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-act]'); if (!b) return;
        if (S.busy && b.dataset.act !== 'tab') { ev.preventDefault(); return; }
        var fn = actions[b.dataset.act]; if (fn) fn(b);
    });

    load().then(render);
})();
