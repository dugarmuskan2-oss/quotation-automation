/**
 * partner-directory.js — the 📇 Partner Directory tool (and the "who should I ask"
 * brain the Freight / Enquiry tabs call into).
 *
 * The tool page has two sub-tabs:
 *   Directory      — the list: filters, a paste-an-enquiry finder, and the full edit card.
 *   Recent changes — emails from the Add-to-Directory Gmail label waiting for approval,
 *                    plus the log of every automatic change, each with Undo.
 *
 * Data lives server-side (routes/contacts.js). Every edit saves THAT partner only.
 * Ranking runs here in the browser: rules with a sentence attached to every point, so a
 * suggestion can always say why. Being under a minimum SINKS a partner, it never hides
 * them — only "doesn't deal in it at all" rules anyone out, and even they stay visible.
 *
 * Public API (used by freight-tab-weight-editor.js and quote-enquiry-tab.js):
 *   window.partnerDirectory.renderSuggestPanel(container, opts, onAddChip)
 *   window.partnerDirectory.recordUsage({emails, kind, role, pipeTypes, pickup, drop})
 */
(function () {
    'use strict';

    var HOME = 'Chennai';   // fallback delivery point when an enquiry names no place

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function str(v) { return String(v == null ? '' : v).trim(); }
    function lower(v) { return str(v).toLowerCase(); }
    function isEmail(v) { return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(str(v)); }

    function apiBase() {
        var origin = window.location.origin;
        return (origin && origin !== 'null' && origin.indexOf('http') === 0) ? origin + '/api' : 'http://localhost:3001/api';
    }

    function daysSince(d) {
        var t = Date.parse(d || '');
        return isFinite(t) ? Math.round((Date.now() - t) / 86400000) : null;
    }
    function ago(d) {
        var n = daysSince(d);
        if (n === null) return 'never';
        if (n < 1) return 'today';
        if (n < 31) return n + ' day' + (n === 1 ? '' : 's') + ' ago';
        if (n < 365) { var m = Math.round(n / 30); return m + ' month' + (m === 1 ? '' : 's') + ' ago'; }
        var y = Math.round(n / 365); return y + ' year' + (y === 1 ? '' : 's') + ' ago';
    }

    // ── Geography: rough coordinates + great-circle ×1.25 ≈ road distance ─────
    var COORD = {
        'Chennai': [13.08, 80.27], 'Coimbatore': [11.02, 76.96], 'Madurai': [9.93, 78.12],
        'Trichy': [10.79, 78.70], 'Salem': [11.66, 78.15], 'Vellore': [12.92, 79.13],
        'Bangalore': [12.97, 77.59], 'Hosur': [12.74, 77.83], 'Hyderabad': [17.38, 78.49],
        'Kochi': [9.93, 76.27], 'Pune': [18.52, 73.86], 'Mumbai': [19.08, 72.88],
        'Nashik': [20.00, 73.78], 'Ahmedabad': [23.02, 72.57], 'Bhavnagar': [21.76, 72.15],
        'Rajkot': [22.30, 70.80], 'Surat': [21.17, 72.83], 'Vadodara': [22.31, 73.18],
        'Delhi': [28.61, 77.21], 'Kolkata': [22.57, 88.36], 'Nagpur': [21.15, 79.09],
        'Raipur': [21.25, 81.63], 'Hubli': [15.36, 75.12], 'Goa': [15.30, 74.12],
    };
    function haversineKm(a, b) {
        var rad = Math.PI / 180;
        var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
        var x = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
    }
    function kmBetween(from, to) {
        if (/pan india/i.test(from || '')) return 0;
        if (!COORD[from] || !COORD[to]) return null;
        return Math.round(haversineKm(COORD[from], COORD[to]) * 1.25 / 10) * 10;
    }
    /** Pick a known city out of a longer address ("DSC Warehouse, Chennai" → Chennai). */
    function matchCity(text) {
        var t = lower(text);
        var hit = '';
        Object.keys(COORD).forEach(function (city) {
            if (t.indexOf(city.toLowerCase()) !== -1 && city.length > hit.length) hit = city;
        });
        return hit;
    }
    function branchNames(p) {
        var out = (p.branches || []).map(function (b) { return b.city; }).filter(Boolean);
        if (p.city && out.indexOf(p.city) === -1) out.push(p.city);
        return out;
    }
    function nearestBranch(p, site) {
        var best = null;
        branchNames(p).forEach(function (name) {
            var km = kmBetween(matchCity(name) || name, site);
            if (km !== null && (!best || km < best.km)) best = { name: name, km: km };
        });
        return best;
    }

    // ── IS 1239 Part 1 — each NB size carries its OWN thickness per class ─────
    var IS1239 = [
        { nb: '15', inch: '1/2"', od: '21.3', light: '2.0', medium: '2.6', heavy: '3.2' },
        { nb: '20', inch: '3/4"', od: '26.9', light: '2.3', medium: '2.6', heavy: '3.2' },
        { nb: '25', inch: '1"', od: '33.7', light: '2.6', medium: '3.2', heavy: '4.0' },
        { nb: '32', inch: '1-1/4"', od: '42.4', light: '2.6', medium: '3.2', heavy: '4.0' },
        { nb: '40', inch: '1-1/2"', od: '48.3', light: '2.9', medium: '3.2', heavy: '4.0' },
        { nb: '50', inch: '2"', od: '60.3', light: '2.9', medium: '3.6', heavy: '4.5' },
        { nb: '65', inch: '2-1/2"', od: '76.1', light: '3.2', medium: '3.6', heavy: '4.5' },
        { nb: '80', inch: '3"', od: '88.9', light: '3.2', medium: '4.0', heavy: '4.85' },
        { nb: '100', inch: '4"', od: '114.3', light: '3.6', medium: '4.5', heavy: '5.4' },
        { nb: '125', inch: '5"', od: '139.7', light: '', medium: '4.85', heavy: '5.4' },
        { nb: '150', inch: '6"', od: '165.1', light: '', medium: '4.85', heavy: '5.4' },
    ];
    function specClass(spec) {
        var s = lower(spec);
        if (/heavy/.test(s)) return 'heavy';
        if (/medium/.test(s)) return 'medium';
        if (/light/.test(s)) return 'light';
        return '';
    }

    var ROLE_LABEL = { dealer: 'Dealer', manufacturer: 'Manufacturer', transporter: 'Transporter', fabricator: 'Fabricator', other: 'Other' };
    var ROLE_ORDER = ['dealer', 'manufacturer', 'transporter', 'fabricator', 'other'];
    var PIPE_TYPES = ['GI', 'ERW', 'Seamless', 'SS', 'MS', 'Alloy'];
    function roleLabel(p) {
        if (p && p.role === 'other') return str(p.roleOther) || 'Other';
        return ROLE_LABEL[p && p.role] || 'Other';
    }
    function isRegular(p) { var n = daysSince(p.last); return (p.enq || 0) >= 5 && n !== null && n <= 120; }
    function replyRate(p) { return p.enq ? Math.round((p.rep || 0) / p.enq * 100) : 0; }

    function people(p) { return (p && p.people) || []; }
    function allEmails(p) {
        var out = [];
        people(p).forEach(function (c) { (c.emails || []).forEach(function (e) { if (e.v) out.push(e.v); }); });
        return out;
    }
    function mainName(p) { return (people(p)[0] || {}).name || ''; }
    function mainEmail(p) { return allEmails(p)[0] || ''; }
    function mainPhone(p) { var ph = (people(p)[0] || {}).phones || []; return ph.length ? ph[0].v : ''; }
    function knownEmail(email) {
        var e = lower(email);
        return D.contacts.filter(function (p) {
            return allEmails(p).some(function (x) { return lower(x) === e; });
        })[0] || null;
    }

    // ── Reading a typed enquiry (the Directory's finder box) ──────────────────
    // Metres become tonnes only when size AND class are both given — never guessed.
    var KGM = {
        l: { '0.5': 1.10, '0.75': 1.40, '1': 2.00, '1.25': 2.60, '1.5': 3.00, '2': 4.10, '2.5': 5.40, '3': 6.70, '4': 10.20 },
        m: { '0.5': 1.22, '0.75': 1.58, '1': 2.44, '1.25': 3.14, '1.5': 3.61, '2': 5.10, '2.5': 6.42, '3': 8.36, '4': 12.20, '5': 15.60, '6': 18.60 },
        h: { '0.5': 1.47, '0.75': 1.90, '1': 2.90, '1.25': 3.90, '1.5': 4.50, '2': 6.20, '2.5': 8.00, '3': 10.20, '4': 14.50, '5': 19.20, '6': 22.90 },
        '40': { '0.5': 1.27, '0.75': 1.69, '1': 2.50, '1.25': 3.39, '1.5': 4.05, '2': 5.44, '2.5': 8.63, '3': 11.29, '4': 16.07, '6': 28.26, '8': 42.55 },
        '80': { '1': 3.24, '1.5': 5.41, '2': 7.48, '2.5': 11.41, '3': 15.27, '4': 22.32, '6': 42.56, '8': 64.64 },
    };
    var CLASS_KEY = { heavy: 'h', medium: 'm', light: 'l' };

    function sizeToInches(raw) {
        var s = str(raw);
        var m = s.match(/^(\d+)[-\s](\d+)\/(\d+)$/);
        if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
        m = s.match(/^(\d+)\/(\d+)$/);
        if (m) return Number(m[1]) / Number(m[2]);
        m = s.match(/^(\d+(?:\.\d+)?)$/);
        return m ? Number(m[1]) : null;
    }

    function readTypesAndClass(t) {
        var type = '';
        if (/\bss\b|stainless|\b304\b|\b316\b|a312/.test(t)) type = 'SS';
        else if (/\bgi\b|galvani/.test(t)) type = 'GI';
        else if (/\berw\b/.test(t)) type = 'ERW';
        else if (/seamless|a106|\bp11\b|\bp22\b|sch\s*\d/.test(t)) type = 'Seamless';
        var cls = '';
        var sch = t.match(/sch(?:edule)?\.?\s*(\d{2,3})/);
        if (sch) cls = 'sch ' + sch[1];
        else if (/heavy/.test(t)) cls = 'heavy';
        else if (/medium/.test(t)) cls = 'medium';
        else if (/light/.test(t)) cls = 'light';
        return { type: type, cls: cls };
    }

    // Tonnes and kg are checked before metres so "mtr" can never be read as "mt".
    function readQty(t) {
        var mT = t.match(/(\d+(?:\.\d+)?)\s*(?:m\.?t\.?(?![a-z])|tonnes?|tons?|t(?![a-z]))/);
        if (mT) return { kind: 'T', val: parseFloat(mT[1]) };
        var mK = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:kgs?(?![a-z])|kilo)/);
        if (mK) return { kind: 'kg', val: parseFloat(mK[1].replace(/,/g, '')) };
        var mM = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:mtrs?|met(?:er|re)s?|rmt|m(?![a-z]))/);
        if (mM) return { kind: 'm', val: parseFloat(mM[1].replace(/,/g, '')) };
        return { kind: '', val: 0 };
    }

    function readLine(frag, ctx) {
        var t = ' ' + frag.toLowerCase() + ' ';
        var tc = readTypesAndClass(t);
        var type = tc.type || ctx.type;
        if (!type) return null;
        var sm = t.match(/(\d+[-\s]\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(?:"|”|inch(?:es)?|nb\b)/);
        var q = readQty(t);
        return { type: type, cls: tc.cls || ctx.cls, inches: sm ? sizeToInches(sm[1].trim()) : null, kind: q.kind, val: q.val };
    }

    function resolveLine(li) {
        var kg = null;
        if (li.kind === 'T') kg = li.val * 1000;
        else if (li.kind === 'kg') kg = li.val;
        else if (li.kind === 'm') {
            var schM = li.cls ? li.cls.match(/sch\s*(\d+)/) : null;
            var table = KGM[li.cls ? (CLASS_KEY[li.cls] || (schM ? schM[1] : '')) : ''];
            var perM = (table && li.inches !== null) ? table[String(li.inches)] : null;
            if (perM) kg = li.val * perM;
        }
        var name = (li.type + ' ' + (li.cls || '')).trim();
        return { product: name, type: li.type, cls: li.cls, inches: li.inches, kg: kg };
    }

    // "12 MT seamless sch 80, 6 inch" arrives as two clauses — fold quantity into the sized one.
    function mergeClauses(lines) {
        var sized = lines.filter(function (l) { return l.inches !== null; });
        var out = [];
        lines.forEach(function (l) {
            if (l.inches === null && l.kind) {
                var host = sized.filter(function (s) { return s.type === l.type && !s.kind; })[0];
                if (host) { host.kind = l.kind; host.val = l.val; if (!host.cls) host.cls = l.cls; return; }
            }
            out.push(l);
        });
        return out;
    }

    function readEnquiry(text) {
        var raw = String(text || ''), t = ' ' + raw.toLowerCase() + ' ';
        var ctx = readTypesAndClass(t);
        var items = raw.split(/,|;|\n|\+|\band\b/i).map(str).filter(Boolean)
            .map(function (f) { return readLine(f, ctx); })
            .filter(function (li) { return li && (li.kind || li.inches !== null); });
        var merged = mergeClauses(items).map(resolveLine);
        var types = [];
        merged.forEach(function (li) { if (types.indexOf(li.type) === -1) types.push(li.type); });
        if (!types.length && ctx.type) types.push(ctx.type);
        var kgTotal = merged.reduce(function (s, li) { return s + (li.kg || 0); }, 0);
        if (!kgTotal) { var q = readQty(t); if (q.kind === 'T') kgTotal = q.val * 1000; else if (q.kind === 'kg') kgTotal = q.val; }
        var pickup = '', site = '';
        Object.keys(COORD).forEach(function (c) {
            var i = t.indexOf(' ' + c.toLowerCase());
            if (i === -1) return;
            if (/(from|ex)[\s-]*$/.test(t.slice(0, i + 1))) pickup = pickup || c; else site = site || c;
        });
        var siteAssumed = !site;
        return {
            items: merged, types: types, site: site || HOME, siteAssumed: siteAssumed, pickup: pickup,
            tons: kgTotal / 1000, known: kgTotal > 0,
            freight: /transport|freight|lorry|truck|part load|full load/.test(t) || !!pickup,
            empty: !types.length && !pickup && !/transport|freight|lorry|truck/.test(t),
        };
    }

    // ── Ranking: rules with a sentence per point ──────────────────────────────

    function matchProduct(p, needName) {
        var nw = lower(needName).split(/\s+/).filter(function (w) { return w.length > 1; });
        var best = null, top = 0;
        (p.products || []).forEach(function (pr) {
            var pw = lower(pr.p + ' ' + pr.spec);
            var hits = nw.filter(function (w) { return pw.indexOf(w) !== -1; }).length;
            if (hits > top) { top = hits; best = pr; }
        });
        return top ? best : null;
    }

    function scoreTypes(p, need, why) {
        var have = (p.types || []).map(lower);
        var wanted = (need.types || []).map(lower);
        if (!wanted.length) { why.push(['neutral', 'No pipe type given — cannot match on product']); return { pts: 0, blocked: false }; }
        var hits = wanted.filter(function (t) { return have.indexOf(t) !== -1; });
        if (!hits.length && have.length) { why.push(['bad', 'Does not deal in ' + need.types.join(' / ')]); return { pts: 0, blocked: true }; }
        if (!have.length) { why.push(['neutral', 'No pipe types on their card yet']); return { pts: 0, blocked: false }; }
        if (hits.length === wanted.length) { why.push(['ok', 'Deals in ' + need.types.join(' + ')]); return { pts: 40, blocked: false }; }
        why.push(['warn', 'Only does ' + hits.join(', ').toUpperCase() + ' of ' + need.types.join(' / ')]);
        return { pts: 20, blocked: false };
    }

    // A minimum is a fact, not a verdict: being under it sinks a partner, never hides them.
    function scoreMinimums(p, need, why) {
        if (!need.known) {
            if (p.moq) why.push(['neutral', 'No quantity given — their ' + p.moq + ' T minimum not checked']);
            return 0;
        }
        var rows = [];
        (need.items || []).forEach(function (it) {
            var pr = matchProduct(p, it.product);
            if (!pr) return;
            var e = rows.filter(function (x) { return x.row === pr; })[0];
            if (!e) { e = { row: pr, tons: 0 }; rows.push(e); }
            e.tons += (it.kg || 0) / 1000;
        });
        if (!rows.length) {
            if (p.moq > need.tons) { why.push(['warn', 'Under their minimum — they ask for ' + p.moq + ' T, this is ' + need.tons.toFixed(2) + ' T']); return -30; }
            why.push(['ok', 'No minimum in the way']); return 10;
        }
        var pts = 0;
        var can = rows.filter(function (e) { return e.tons >= (e.row.moq || 0); });
        var cant = rows.filter(function (e) { return e.tons < (e.row.moq || 0); });
        if (can.length) { pts += cant.length ? 12 : 25; why.push(['ok', 'Stocks ' + can.map(function (e) { return e.row.p; }).join(', ') + ' — you clear the minimum']); }
        cant.forEach(function (e) { pts -= 30; why.push(['warn', 'Under their minimum — ' + e.row.p + ' needs ' + e.row.moq + ' T, you have ' + e.tons.toFixed(2) + ' T']); });
        can.forEach(function (e) { if (e.row.rule) why.push(['note', e.row.p + ': ' + e.row.rule]); });
        return pts;
    }

    // Not knowing where someone is must never score BETTER than knowing they are far —
    // otherwise an untouched card outranks one you took the trouble to fill in, and the
    // directory quietly rewards leaving it blank. Unknown sits between near and far.
    function scoreDistance(p, need, why) {
        var site = matchCity(need.site) || need.site;
        var nb = nearestBranch(p, site);
        if (!nb) { why.push(['warn', 'No city on their card — add one and this ranks properly']); return -5; }
        if (nb.km <= 60) { why.push(['ok', 'In ' + nb.name + ' — right by the site']); return 35; }
        if (nb.km <= 250) { why.push(['ok', nb.name + ' branch, ' + nb.km + ' km from site']); return 20; }
        why.push(['warn', nb.name + ' — ' + nb.km + ' km away, freight will hurt']); return -10;
    }

    function scoreHistoryAndNotes(p, why) {
        var pts = 0;
        if (p.enq) {
            pts += Math.round((p.rep || 0) / p.enq * 20) + ((daysSince(p.last) || 999) <= 120 ? 10 : 0);
            why.push([(p.rep ? 'ok' : 'warn'), 'Replied to ' + (p.rep || 0) + ' of ' + p.enq + ' enquiries' + ((daysSince(p.last) || 999) <= 120 ? ', dealt with recently' : ', but not lately')]);
        } else why.push(['neutral', 'Never asked through the app']);
        (p.rules || []).forEach(function (r) { if (str(r)) why.push(['note', 'Applies to everything: ' + r]); });
        var n = (p.notes || [])[0];
        if (n) why.push(['note', 'Your note (' + ago(n.d) + '): ' + n.t]);
        if ((daysSince(p.checked) || 0) > 180) why.push(['warn', 'Last edited ' + ago(p.checked) + ' — worth confirming before you quote']);
        return pts;
    }

    function scoreSupplier(p, need) {
        var why = [], types = scoreTypes(p, need, why);
        var score = types.pts + (types.blocked ? 0 : scoreMinimums(p, need, why))
            + scoreDistance(p, need, why) + scoreHistoryAndNotes(p, why);
        return { p: p, score: types.blocked ? -999 + score : score, why: why, blocked: types.blocked };
    }

    function scoreTransporter(p, need, from) {
        var why = [], score = 0, blocked = false;
        var to = matchCity(need.site) || need.site;
        var fromCity = matchCity(from) || from;
        var norm = function (v) { return lower(matchCity(v) || v); };
        var exact = (p.routes || []).filter(function (r) { return norm(r.from) === lower(fromCity) && norm(r.to) === lower(to); })[0];
        if (exact) { score += 45; why.push(['ok', 'Runs ' + fromCity + ' → ' + to + ' regularly']); }
        else if ((p.routes || []).some(function (r) { return norm(r.from) === lower(fromCity); })) { score += 22; why.push(['warn', 'Loads from ' + fromCity + ', but not to ' + to]); }
        else if (/pan india/i.test(branchNames(p).join(' '))) { score += 8; why.push(['warn', 'No regular ' + fromCity + ' → ' + to + ', but runs a national network']); }
        else { blocked = true; why.push(['bad', 'Does not run ' + fromCity + ' → ' + to]); }
        if (!need.known) why.push(['neutral', 'No weight given — part load vs full truck not checked']);
        else if (need.tons < 9 && !p.partLoad) { score -= 30; why.push(['warn', 'Full loads only — this is ' + need.tons.toFixed(1) + ' T, a part load']); }
        else if (need.tons < 9) { score += 25; why.push(['ok', 'Takes part load — you only have ' + need.tons.toFixed(1) + ' T']); }
        else { score += 15; why.push(['ok', need.tons.toFixed(1) + ' T is a full truck — their strength']); }
        if (p.vehicles) why.push(['neutral', 'Keeps ' + p.vehicles]);
        score += scoreHistoryAndNotes(p, why);
        return { p: p, score: blocked ? -999 + score : score, why: why, blocked: blocked };
    }

    /** Rank the loaded directory for one need. kind: 'material' | 'transport'. */
    function rankFor(kind, need, from) {
        var pool = D.contacts.filter(function (p) {
            return kind === 'transport' ? p.role === 'transporter'
                : (p.role === 'dealer' || p.role === 'manufacturer');
        });
        return pool.map(function (p) {
            return kind === 'transport' ? scoreTransporter(p, need, from) : scoreSupplier(p, need);
        }).sort(function (a, b) { return b.score - a.score; });
    }

    // ── Data layer ────────────────────────────────────────────────────────────
    var D = { contacts: [], changes: [], pending: [], duplicates: [], loaded: false, loadError: '', saveError: '' };

    function loadDirectory(then) {
        fetch(apiBase() + '/contacts')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                D.contacts = d.contacts || []; D.changes = d.changes || []; D.pending = d.pending || [];
                D.duplicates = d.duplicates || [];
                D.loaded = true; D.loadError = '';
            })
            .catch(function (e) {
                // A failed load must look like a failure — never like an empty directory.
                D.loaded = false; D.loadError = 'Could not load the directory (' + e.message + ').';
            })
            .then(function () { then && then(); });
    }

    /**
     * `then` runs on success only. `always` runs either way, and is where an in-flight lock
     * must be released: a lock cleared only inside `then` stays set forever the moment a
     * request fails, which left the Import button disabled and reading "Importing…" until
     * the page was reloaded — a failure that looked like a hang.
     */
    function postJson(path, body, then, always) {
        var failed = false;
        return fetch(apiBase() + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
                return d;
            });
        }).then(function (d) { D.saveError = ''; then && then(d); return d; })
            .catch(function (e) { D.saveError = e.message; failed = true; })
            .then(function (d) { if (always) always(); if (always || failed) render(); return d; });
    }

    // `fields` narrows the write to what was actually touched, so a second tab editing a
    // different part of the same firm is not overwritten by this tab's older copy.
    function savePartner(p, fields) {
        return postJson('/contacts/save', { partner: p, fields: fields || null });
    }

    // ── State for the tool page ───────────────────────────────────────────────
    var S = { tab: 'dir', filter: 'all', openId: null, openPending: null, openChange: null,
              find: { text: '', state: 'idle', need: null }, busy: {}, add: freshAdd() };

    function byId(id) {
        var p = D.contacts.filter(function (x) { return x.id === id; })[0];
        if (p) return p;
        var pi = D.pending.filter(function (x) { return x.preview && x.preview.id === id; })[0];
        return pi ? pi.preview : null;
    }

    // ── Rendering: the tool page ──────────────────────────────────────────────
    function render() {
        var app = $('partnerDirectoryApp');
        if (!app) return;
        var waiting = D.pending.length;
        app.innerHTML = '<h1>📇 Partner Directory</h1>'
            + '<div class="pd-tabs">'
            + '<button class="pd-tab' + (S.tab === 'dir' ? ' on' : '') + '" data-pd-tab="dir">Directory</button>'
            + '<button class="pd-tab' + (S.tab === 'add' ? ' on' : '') + '" data-pd-tab="add">Add</button>'
            + '<button class="pd-tab' + (S.tab === 'changes' ? ' on' : '') + '" data-pd-tab="changes">Recent changes'
            + (waiting ? ' <span class="pd-pill pd-pill-warn">' + waiting + '</span>' : '') + '</button></div>'
            + (D.saveError ? '<div class="pd-error">Save failed: ' + esc(D.saveError) + ' — your last edit is NOT stored. Edit the field again to retry.</div>' : '')
            + (D.loadError ? '<div class="pd-error">' + esc(D.loadError) + ' <button data-pd-reload="1">Try again</button></div>'
                : !D.loaded ? '<p class="pd-muted" style="padding:20px;text-align:center;">Loading…</p>'
                    : S.tab === 'dir' ? dirView() : S.tab === 'add' ? addView() : changesView());
        bind(app);
    }

    function dirView() {
        var counts = { all: D.contacts.length };
        D.contacts.forEach(function (p) { counts[p.role] = (counts[p.role] || 0) + 1; });
        var chips = [['all', 'All']].concat(ROLE_ORDER.map(function (r) { return [r, ROLE_LABEL[r] + 's']; }))
            .map(function (c) {
                return '<button class="pd-chip' + (S.filter === c[0] ? ' on' : '') + '" data-pd-filter="' + c[0] + '">'
                    + esc(c[1]) + ' ' + (counts[c[0]] || 0) + '</button>';
            }).join('');
        return duplicateWarningHtml()
            + finderBlock()
            + '<div class="pd-filters">' + chips + '<span class="pd-sp"></span>'
            + (D.contacts.length ? importButtonHtml() : '')
            + '<button class="pd-prim" data-pd-add="1">+ Add partner</button></div>'
            + listHtml();
    }

    // An address on two cards splits one firm's history in two and gets them asked twice.
    // New ones are refused on save; anything older is shown here with a way straight to it.
    function duplicateWarningHtml() {
        if (!D.duplicates.length) return '';
        return '<div class="pd-error"><b>The same address is on more than one card.</b>'
            + ' One address belongs to one company — open each and remove it from the wrong one.'
            + D.duplicates.slice(0, 10).map(function (d) {
                return '<p class="pd-tiny" style="margin-top:6px;"><b>' + esc(d.email) + '</b> — '
                    + d.cards.map(function (c) {
                        return '<button data-pd-open="' + esc(c.id) + '" class="pd-linkish">'
                            + esc(c.company || '(no name)') + '</button>';
                    }).join(' · ') + '</p>';
            }).join('') + '</div>';
    }

    function listHtml() {
        var list = D.contacts.filter(function (p) {
            if (S.filter !== 'all' && p.role !== S.filter) return false;
            if (!S.find.text || S.find.state !== 'name') return true;
            var hay = lower(p.company + ' ' + p.city + ' ' + branchNames(p).join(' ') + ' ' + (p.types || []).join(' ')
                + ' ' + people(p).map(function (x) { return x.name; }).join(' ') + ' ' + allEmails(p).join(' ')
                + ' ' + (p.roleOther || '') + ' ' + (p.products || []).map(function (x) { return x.p + ' ' + x.spec; }).join(' ')
                + ' ' + (p.notes || []).map(function (n) { return n.t; }).join(' '));
            return hay.indexOf(lower(S.find.text)) !== -1;
        });
        if (S.find.state === 'done' && S.find.need && !S.find.need.empty) return finderResults();
        // "Nobody matches that" on a directory that is simply empty reads like a failed
        // search. Say which it is, and give the way out.
        if (!list.length) return D.contacts.length ? '<p class="pd-muted pd-empty">Nobody matches that.</p>' : emptyStateHtml();
        return list.map(function (p) { return S.openId === p.id ? editCard(p) : rowCard(p); }).join('');
    }

    function emptyStateHtml() {
        if (S.imported && !S.imported.queued) {
            return '<div class="pd-empty"><p class="pd-muted">'
                + (S.imported.alreadyQueued
                    ? 'Those are already waiting for you under <b>Recent changes</b>.'
                    : 'Nothing to bring in — the app has no remembered addresses yet.') + '</p>'
                + '<p class="pd-tiny" style="margin-top:6px;">Press <b>+ Add partner</b> to type one in, or tag a supplier’s email in Gmail with the Add-to-Directory label.</p></div>';
        }
        return '<div class="pd-empty"><p class="pd-muted"><b>Your directory is empty.</b></p>'
            + '<p class="pd-tiny" style="margin:6px 0 10px;">The app has been quietly remembering every address you have sent an enquiry to. '
            + 'Bring those in and they wait under <b>Recent changes</b> for you to approve, one firm at a time — '
            + 'nothing is added until you say so.</p>'
            + importButtonHtml()
            + '<p class="pd-tiny" style="margin-top:8px;">Or press <b>+ Add partner</b> to type one in.</p></div>';
    }

    // Kept reachable at all times, not only while the directory is empty: one enquiry sent
    // from the quote side queues a firm, and the button used to vanish for good the moment
    // anything existed — taking years of remembered addresses with it.
    function importButtonHtml() {
        return '<button class="pd-prim" data-pd-import="1"' + (S.importing ? ' disabled' : '') + '>'
            + (S.importing ? 'Reading…' : '↓ Bring in the addresses I have already used') + '</button>';
    }

    function rowCard(p) {
        var bits = [];
        if (p.role === 'transporter') {
            bits.push((p.routes || []).length + ' route' + ((p.routes || []).length === 1 ? '' : 's'));
            if (p.vehicles) bits.push(p.vehicles);
            bits.push(p.partLoad ? 'Takes part load' : 'Full load only');
        } else {
            if ((p.types || []).length) bits.push(p.types.join(' · '));
            bits.push((p.products || []).length + ' product' + ((p.products || []).length === 1 ? '' : 's'));
            if (p.role !== 'fabricator' && p.role !== 'other') bits.push('MOQ ' + (p.moq ? p.moq + ' T' : 'none'));
        }
        var latest = (p.notes || [])[0];
        var stale = (daysSince(p.checked) || 0) > 180;
        return '<div class="pd-card pd-click" data-pd-open="' + esc(p.id) + '" tabindex="0" role="button">'
            + '<div class="pd-row"><b>' + esc(p.company || 'New partner — needs a name') + '</b>'
            + '<span class="pd-pill">' + esc(roleLabel(p)) + '</span>'
            + (isRegular(p) ? '<span class="pd-pill pd-pill-good">Regular</span>' : '')
            + (p.fromEnquiry ? '<span class="pd-pill pd-pill-warn">From an enquiry — check me</span>' : '')
            + '<span class="pd-sp"></span><span class="pd-tiny">›</span></div>'
            + '<p class="pd-muted">' + esc([p.city].concat(bits).filter(Boolean).join(' · ')) + '</p>'
            + (latest ? '<p class="pd-muted pd-note-line">“' + esc(latest.t) + '” <span class="pd-tiny">— ' + ago(latest.d) + '</span></p>' : '')
            + '<p class="pd-tiny' + (stale ? ' pd-stale' : '') + '">Asked ' + (p.enq || 0) + ' times · replied ' + replyRate(p) + '% · last dealt ' + ago(p.last)
            + ' · last edited ' + ago(p.checked) + (stale ? ' — worth a call' : '') + '</p></div>';
    }

    // ── The finder: paste an enquiry, get told who to send it to ──────────────
    function finderBlock() {
        var f = S.find;
        var h = '<div class="pd-finder"><div class="pd-row"><b>Who should I send this enquiry to?</b>'
            + '<span class="pd-tiny pd-sp" style="text-align:right;">Or type a name to just find someone</span></div>'
            + '<textarea id="pdFindIn" placeholder="Paste the customer\'s enquiry — e.g. 300 mtr of 2&quot; GI heavy, delivery at Chennai. Or type a company, city or product to search.">' + esc(f.text) + '</textarea>'
            + '<div class="pd-row" style="margin-top:8px;">'
            + '<button class="pd-prim" data-pd-find="go">Suggest who to ask</button>'
            + (f.state !== 'idle' ? '<button data-pd-find="clear">Clear</button>' : '') + '</div>';
        if (f.state === 'name') {
            h += '<p class="pd-muted" style="margin-top:9px;">No enquiry in that, so the list below is filtered by <b>' + esc(f.text) + '</b>.</p>';
        }
        return h + '</div>';
    }

    function finderResults() {
        var need = S.find.need;
        var h = '<div class="pd-read">' + readBack(need) + '</div>';
        if (need.types.length) {
            var sup = rankFor('material', need);
            h += '<div class="pd-sec">Send it to</div>' + rankListHtml(sup.filter(function (r) { return !r.blocked; }), 'material')
                + ruledOutHtml(sup.filter(function (r) { return r.blocked; }));
        }
        if (need.freight && need.site) {
            var from = need.pickup || HOME;
            var tra = rankFor('transport', need, from);
            h += '<div class="pd-sec">For the transport — ' + esc(from) + ' → ' + esc(need.site) + '</div>'
                + rankListHtml(tra.filter(function (r) { return !r.blocked; }), 'transport')
                + ruledOutHtml(tra.filter(function (r) { return r.blocked; }));
        }
        return h;
    }

    function readBack(need) {
        var tags = need.items.map(function (li) {
            return '<span class="pd-tag">' + esc(li.product)
                + (li.kg !== null ? ' = <b>' + (li.kg / 1000).toFixed(2) + ' T</b>' : ' — <b>weight unknown</b>') + '</span>';
        }).join('');
        tags += '<span class="pd-tag">' + (need.known ? 'Total: <b>' + need.tons.toFixed(2) + ' T</b>' : '<b>No weight worked out</b> — minimums not checked') + '</span>';
        if (need.pickup) tags += '<span class="pd-tag">From: <b>' + esc(need.pickup) + '</b></span>';
        tags += '<span class="pd-tag">Deliver to: <b>' + esc(need.site) + '</b>' + (need.siteAssumed ? ' — assumed, no place named' : '') + '</span>';
        return '<p class="pd-tiny" style="margin-bottom:6px;">What was understood — correct the text and ask again if this is wrong:</p>' + tags;
    }

    function rankListHtml(rows, kind) {
        if (!rows.length) return '<p class="pd-muted pd-empty">Nobody in your directory fits this one.</p>';
        return rows.map(function (r, i) {
            return '<div class="pd-card"><div class="pd-rank"><span class="pd-rank-n">' + (i + 1) + '</span>'
                + '<div style="flex:1;min-width:0;"><div class="pd-row"><b>' + esc(r.p.company) + '</b>'
                + '<span class="pd-pill">' + esc(roleLabel(r.p)) + '</span>'
                + (isRegular(r.p) ? '<span class="pd-pill pd-pill-good">Regular</span>' : '') + '</div>'
                + '<p class="pd-tiny">' + esc([mainName(r.p), mainEmail(r.p), mainPhone(r.p)].filter(Boolean).join(' · ')) + '</p>'
                + '<div>' + r.why.map(function (w) { return '<span class="pd-why pd-why-' + w[0] + '">' + esc(w[1]) + '</span>'; }).join('') + '</div></div>'
                + '<button data-pd-open="' + esc(r.p.id) + '">Open card</button></div></div>';
        }).join('');
    }

    function ruledOutHtml(rows) {
        if (!rows.length) return '';
        return '<p class="pd-tiny" style="margin:10px 0 6px;">Not suggested — but shown, so you can overrule it:</p>'
            + rows.map(function (r) {
                var bad = r.why.filter(function (w) { return w[0] === 'bad'; });
                return '<div class="pd-card pd-out"><div class="pd-row"><b>' + esc(r.p.company) + '</b>'
                    + '<span class="pd-pill">' + esc(roleLabel(r.p)) + '</span>'
                    + '<span class="pd-sp"></span><button data-pd-open="' + esc(r.p.id) + '">Open card</button></div>'
                    + '<div>' + bad.map(function (w) { return '<span class="pd-why pd-why-bad">' + esc(w[1]) + '</span>'; }).join('') + '</div></div>';
            }).join('');
    }

    // ── The edit card (identical wherever a partner opens) ────────────────────
    function editCard(p) {
        var roles = ROLE_ORDER.map(function (r) {
            return '<option value="' + r + '"' + (p.role === r ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>';
        }).join('');
        return '<div class="pd-card pd-open-card" data-pd-card="' + esc(p.id) + '">'
            + '<div class="pd-row pd-close-head" data-pd-close="1" tabindex="0" role="button">'
            + '<b>' + esc(p.company || 'New partner') + '</b>'
            + '<span class="pd-pill">' + esc(roleLabel(p)) + '</span>'
            + '<span class="pd-sp"></span><span class="pd-tiny">click to close</span></div>'
            + '<div class="pd-grid2">' + fld(p, 'Company', 'company', p.company, 'e.g. Annai Steel Traders')
            + '<div class="pd-fld"><label>They are a…</label><select data-pd-k="role">' + roles + '</select></div></div>'
            + (p.role === 'other' ? fld(p, 'What are they?', 'roleOther', p.roleOther, 'e.g. galvaniser, testing lab') : '')
            + peopleBlock(p) + placesBlock(p)
            + (p.role === 'transporter' ? transporterBlock(p) : supplierBlock(p))
            + notesBlock(p) + autoBlock(p)
            // Only a card that really is IN the directory can be deleted from it. A card
            // waiting for approval has a 'p_new_…' id the directory has never seen, so the
            // button deleted nothing and threw away the corrections being typed on the way
            // out. Discard is the action for those, and it is already on the strip below.
            + (isInDirectory(p)
                ? '<div class="pd-row" style="margin-top:12px;"><span class="pd-sp"></span>'
                    + '<button class="pd-danger" data-pd-delete="' + esc(p.id) + '">Delete this partner</button></div>'
                : '')
            + '</div>';
    }

    function fld(p, label, key, value, ph) {
        return '<div class="pd-fld"><label>' + esc(label) + '</label>'
            + '<input data-pd-k="' + key + '" value="' + esc(value == null ? '' : value) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></div>';
    }

    var PHONE_LABELS = ['Mobile', 'WhatsApp', 'Office', 'Direct', 'Home'];
    var EMAIL_LABELS = ['Work', 'Sales', 'Accounts', 'Personal'];

    function peopleBlock(p) {
        return '<div class="pd-sec">Contacts<span class="pd-sp"></span><span class="pd-tiny">'
            + people(p).length + ' ' + (people(p).length === 1 ? 'person' : 'people') + '</span></div>'
            + people(p).map(function (c, i) { return personCard(c, i); }).join('')
            + '<button class="pd-addline" data-pd-addperson="1">+ Add another person</button>'
            + '<p class="pd-tiny" style="margin-top:6px;">The first address on the first person is where enquiries go — but <b>every</b> address is matched against incoming email.</p>';
    }

    /**
     * Every person shows one phone box and one email box straight away, with + for more.
     * Typing a number should not start with hunting for a button. Blank rows are dropped on
     * save (sanitizeLines), so an untouched pair is never stored — which is also what keeps
     * "a card with nothing on it" still counting as blank.
     */
    function withOneOfEach(c) {
        if (!(c.phones || []).length) c.phones = [{ label: 'Mobile', v: '' }];
        if (!(c.emails || []).length) c.emails = [{ label: 'Work', v: '' }];
        return c;
    }

    function personCard(person, i) {
        var c = withOneOfEach(person);
        var lineRows = function (kind, labels, arr) {
            return (arr || []).map(function (x, j) {
                return '<div class="pd-cline">'
                    + '<select data-pd-pc="' + i + '" data-pd-' + kind + '="' + j + '" data-pd-k="label">'
                    + labels.map(function (l) { return '<option' + (x.label === l ? ' selected' : '') + '>' + l + '</option>'; }).join('')
                    + '</select>'
                    + '<input data-pd-pc="' + i + '" data-pd-' + kind + '="' + j + '" data-pd-k="v" value="' + esc(x.v) + '">'
                    + '<button class="pd-del" data-pd-del' + kind + '="' + i + ':' + j + '">✕</button></div>';
            }).join('') + '<button class="pd-addline" data-pd-add' + kind + '="' + i + '">+ ' + (kind === 'ph' ? 'phone' : 'email') + '</button>';
        };
        return '<div class="pd-person"><div class="pd-person-top">'
            + '<input data-pd-pc="' + i + '" data-pd-k="name" value="' + esc(c.name) + '" placeholder="Name">'
            + '<input data-pd-pc="' + i + '" data-pd-k="role" value="' + esc(c.role || '') + '" placeholder="Their job — e.g. Owner, Sales">'
            + (i === 0 ? '<span class="pd-pill">Main</span>' : '<button class="pd-del" data-pd-delperson="' + i + '">✕</button>') + '</div>'
            + '<div class="pd-person-cols"><div>' + lineRows('ph', PHONE_LABELS, c.phones) + '</div>'
            + '<div>' + lineRows('em', EMAIL_LABELS, c.emails) + '</div></div></div>';
    }

    function placesBlock(p) {
        var known = Object.keys(COORD).sort();
        return '<div class="pd-sec">Where they are<span class="pd-sp"></span>'
            + '<button class="pd-addline" data-pd-addbranch="1">+ Add a branch</button></div>'
            + '<div class="pd-grid2">' + fld(p, 'City (head office)', 'city', p.city)
            + fld(p, 'Head office address', 'address', p.address, 'Street, area, pin') + '</div>'
            + (p.branches || []).map(function (b, i) {
                return '<div class="pd-branch"><div class="pd-branch-top">'
                    + '<select data-pd-br="' + i + '" data-pd-k="city"><option value="">City…</option>'
                    + known.map(function (c) { return '<option' + (b.city === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>'
                    + '<input data-pd-br="' + i + '" data-pd-k="area" value="' + esc(b.area || '') + '" placeholder="Town or area — e.g. Ambattur">'
                    + '<button class="pd-del" data-pd-delbranch="' + i + '">✕</button></div>'
                    + '<input data-pd-br="' + i + '" data-pd-k="address" value="' + esc(b.address || '') + '" placeholder="Full address (optional)" style="margin-top:6px;"></div>';
            }).join('')
            + '<p class="pd-tiny">The nearest branch to a delivery point is what the ranking measures — the town and address are for you and the lorry.</p>';
    }

    function supplierBlock(p) {
        var have = p.types || [];
        var canAdd = PIPE_TYPES.filter(function (t) { return have.indexOf(t) === -1; });
        return '<div class="pd-sec">What they supply</div>'
            + '<div class="pd-grid2"><div class="pd-fld"><label>Pipe types</label>'
            + '<div style="display:flex;gap:6px;"><select id="pdTypePick" style="flex:1;"><option value="">Pick a type…</option>'
            + canAdd.map(function (t) { return '<option>' + t + '</option>'; }).join('')
            + '<option value="__other">＋ Add another…</option></select>'
            + '<button data-pd-addtype="1">Add</button></div></div>'
            + fld(p, 'Overall MOQ (tonnes)', 'moq', p.moq) + '</div>'
            + (have.length ? '<div style="margin-bottom:8px;">' + have.map(function (t, i) {
                return '<span class="pd-tag">' + esc(t) + ' <span class="pd-x" data-pd-deltype="' + i + '">✕</span></span>';
            }).join('') + '</div>' : '<p class="pd-tiny" style="margin-bottom:8px;">No types set — they will not be suggested until one is added.</p>')
            + '<div class="pd-tiny pd-head-line">Product range</div>'
            + (p.products || []).map(function (pr, i) { return productRow(pr, i); }).join('')
            + '<button class="pd-addline" data-pd-addproduct="1">+ Add product</button>'
            + otherRulesBlock(p);
    }

    function productRow(pr, i) {
        var f = function (k, ph, v) { return '<input data-pd-pr="' + i + '" data-pd-k="' + k + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph) + '">'; };
        var cls = specClass(pr.spec);
        return '<div class="pd-pcard"><div class="pd-pcard-r1">'
            + f('p', 'Product — e.g. GI pipe', pr.p) + f('spec', 'Specification — e.g. IS 1239 Heavy', pr.spec)
            + '<button class="pd-del" data-pd-delproduct="' + i + '">✕</button></div>'
            + '<div class="pd-row" style="margin-top:6px;"><span class="pd-tiny">Minimum order</span>'
            + '<span style="width:80px;">' + f('moq', 'T', pr.moq) + '</span><span class="pd-tiny">tonnes</span><span class="pd-sp"></span>'
            + (cls ? '<button class="pd-addline" data-pd-loadis="' + i + '">Load IS 1239 ' + cls + ' sizes</button>' : '') + '</div>'
            + '<div style="margin-top:6px;">' + f('rule', 'Price rule — e.g. ASTM + Rs 45/kg', pr.rule) + '</div>'
            + '<div class="pd-sizes"><div class="pd-szrow pd-szhead"><span>NB</span><span>Size</span><span>OD mm</span><span>Thk mm</span><span></span></div>'
            + ((pr.sizes || []).length ? pr.sizes.map(function (s, j) {
                var g = function (k, ph) { return '<input data-pd-pr="' + i + '" data-pd-sz="' + j + '" data-pd-k="' + k + '" value="' + esc(s[k] == null ? '' : s[k]) + '" placeholder="' + ph + '">'; };
                return '<div class="pd-szrow">' + g('nb', '15') + g('inch', '1/2&quot;') + g('od', '21.3') + g('thk', '3.2')
                    + '<button class="pd-del" data-pd-delsz="' + i + ':' + j + '">✕</button></div>';
            }).join('') : '<p class="pd-tiny" style="padding:4px 0;">No sizes — until one is added this product is not matched to an enquiry size.</p>')
            + '<button class="pd-addline" data-pd-addsz="' + i + '">+ size</button></div></div>';
    }

    function otherRulesBlock(p) {
        return '<div class="pd-tiny pd-head-line" style="margin-top:12px;">Other price rules</div>'
            + ((p.rules || []).length ? p.rules.map(function (r, i) {
                return '<div class="pd-orule"><input data-pd-orule="' + i + '" value="' + esc(r) + '" placeholder="e.g. GST 18% extra on all rates">'
                    + '<button class="pd-del" data-pd-delorule="' + i + '">✕</button></div>';
            }).join('') : '<p class="pd-tiny" style="margin-bottom:5px;">None yet.</p>')
            + '<button class="pd-addline" data-pd-addorule="1">+ Add rule</button>'
            + '<p class="pd-tiny" style="margin-top:6px;">Anything that applies to <b>everything they quote</b> — GST, freight terms, payment discounts. These ride along on every suggestion.</p>';
    }

    function transporterBlock(p) {
        return '<div class="pd-sec">Vehicles &amp; routes</div>'
            + '<div class="pd-grid2">' + fld(p, 'Vehicles they keep', 'vehicles', p.vehicles)
            + '<div class="pd-fld"><label>Part load</label><select data-pd-k="partLoad">'
            + '<option value="yes"' + (p.partLoad ? ' selected' : '') + '>Accepts part load</option>'
            + '<option value="no"' + (p.partLoad ? '' : ' selected') + '>Full load only</option></select></div></div>'
            + '<div class="pd-tiny pd-head-line">Regular routes</div>'
            + (p.routes || []).map(function (r, i) {
                return '<div class="pd-cline" style="grid-template-columns:1fr 1fr 26px;">'
                    + '<input data-pd-rt="' + i + '" data-pd-k="from" value="' + esc(r.from) + '" placeholder="From">'
                    + '<input data-pd-rt="' + i + '" data-pd-k="to" value="' + esc(r.to) + '" placeholder="To">'
                    + '<button class="pd-del" data-pd-delroute="' + i + '">✕</button></div>';
            }).join('')
            + '<button class="pd-addline" data-pd-addroute="1">+ Add route</button>'
            + otherRulesBlock(p);
    }

    function notesBlock(p) {
        return '<div class="pd-sec">Notes</div>'
            + '<div class="pd-row" style="margin-bottom:9px;">'
            + '<input id="pdNoteIn" placeholder="What did they tell you? e.g. lead time is 10 days, not 5" style="flex:1;">'
            + '<button class="pd-prim" data-pd-addnote="1">Add note</button></div>'
            + ((p.notes || []).length ? p.notes.map(function (n, i) {
                return '<div class="pd-note"><p>' + esc(n.t) + '</p><span class="pd-tiny">' + ago(n.d)
                    + (n.src ? ' · ' + esc(n.src) : '') + ' · <span class="pd-x" data-pd-delnote="' + i + '">remove</span></span></div>';
            }).join('') : '<p class="pd-tiny">No notes yet. Every note is dated, so you can see when one has gone old.</p>')
            + ((p.images || []).length ? '<div class="pd-tiny pd-head-line" style="margin-top:10px;">Files read into this card</div>'
                + p.images.map(function (im) { return '<p class="pd-tiny">📎 ' + esc(im.n) + (im.count ? ' — ' + im.count + ' details taken' : '') + ' · ' + ago(im.d) + '</p>'; }).join('') : '');
    }

    function autoBlock(p) {
        return '<div class="pd-sec">What the app works out on its own</div>'
            + '<div class="pd-grid3">' + ro('Regular?', isRegular(p) ? 'Yes' : 'No') + ro('Enquiries sent', String(p.enq || 0))
            + ro('Reply rate', replyRate(p) + '%') + ro('Last dealt with', ago(p.last)) + ro('Last edited', ago(p.checked)) + '</div>'
            + '<p class="pd-tiny">You never type these. "Regular" means asked 5+ times and dealt with in the last 4 months. "Last edited" moves on its own.</p>';
    }
    function ro(label, v) { return '<div class="pd-fld"><label>' + esc(label) + '</label><div class="pd-ro">' + esc(v) + '</div></div>'; }

    // ── The Add tab: one box in, a popup you must approve, then it is stored ──
    // Everything here is for partners found OUTSIDE the Gmail label — a brochure handed
    // over at a shop, a rate list, a visiting card, or just what someone said on the phone.
    // The server reads it and proposes; nothing reaches the directory without the popup.

    var MAX_ADD_FILE = 3 * 1024 * 1024;   // beyond this the request is refused server-side

    function freshAdd() {
        return { text: '', fileName: '', fileB64: '', reading: false, applying: false,
                 error: '', applyError: '', notice: '', draft: null };
    }

    function addView() {
        return '<div class="pd-read"><p class="pd-tiny">Anything you picked up away from your inbox — a brochure, '
            + 'a rate list, a photo of a visiting card, or just what someone told you on the phone. '
            + 'Put it in below and press <b>Read it</b>. You will be shown exactly what would be added or '
            + 'changed, and <b>nothing is stored until you press Apply</b>. If it cannot tell, it will ask.</p></div>'
            + addBoxHtml()
            + (S.add.error ? '<div class="pd-error">' + esc(S.add.error) + '</div>' : '')
            + (S.add.notice ? '<div class="pd-read"><p class="pd-muted">' + esc(S.add.notice) + '</p></div>' : '')
            + addNothingHtml() + addQuestionsHtml() + addPopupHtml();
    }

    function addBoxHtml() {
        var a = S.add;
        return '<div class="pd-addbox">'
            + '<textarea id="pdAddIn" placeholder="Type it or paste it — e.g. MSL now has 24 inch pipes also. '
            + 'Or: Sri Balaji Steels, Coimbatore, Ravi 98400 12345, deals in GI and ERW.">' + esc(a.text) + '</textarea>'
            + '<div class="pd-row" style="margin-top:9px;">'
            + '<label class="pd-addline pd-file">📎 Choose a file<input type="file" id="pdAddFile" hidden></label>'
            + (a.fileName
                ? '<span class="pd-tag">' + esc(a.fileName) + ' <span class="pd-x" data-pd-addfileclear="1">✕</span></span>'
                : '<span class="pd-tiny">A PDF or a photo, up to 3 MB.</span>')
            + '<span class="pd-sp"></span>'
            + '<button class="pd-prim" data-pd-addread="1"' + (a.reading ? ' disabled' : '') + '>'
            + (a.reading ? 'Reading…' : 'Read it') + '</button></div></div>';
    }

    // Nothing was understood. Say it plainly, and offer nothing to approve — an empty change
    // list under an Apply button is the worst of both.
    function addNothingHtml() {
        var d = S.add.draft;
        if (!d || d.mode !== 'nothing') return '';
        return '<div class="pd-read"><p class="pd-muted">' + esc(d.read) + '</p>'
            + '<p class="pd-tiny" style="margin-top:6px;">Nothing was added.</p></div>';
    }

    function addQuestionsHtml() {
        var d = S.add.draft;
        if (!d || d.mode !== 'unsure') return '';
        return '<div class="pd-read">'
            + (d.read ? '<p class="pd-muted" style="margin-bottom:7px;">' + esc(d.read) + '</p>' : '')
            + '<p class="pd-tiny">Nothing was added — this has to be settled first:</p>'
            + (d.questions || []).map(function (q) { return '<p class="pd-q">• ' + esc(q) + '</p>'; }).join('')
            + addCandidatesHtml(d.candidates)
            + '<p class="pd-tiny" style="margin-top:9px;">Or answer in the box above and press <b>Read it</b> again.</p></div>';
    }

    // Naming the firm turns a guess into a settled question — the next read is answering it.
    function addCandidatesHtml(list) {
        if (!(list || []).length) return '';
        return '<p class="pd-tiny" style="margin:9px 0 5px;">If it is one of these, press it and it is read again for that firm:</p>'
            + list.map(function (c) {
                return '<button data-pd-addpick="' + esc(c.company) + '" style="margin:0 5px 5px 0;">'
                    + esc(c.company || '(no name)') + '</button>';
            }).join('');
    }

    // The approval step. Nothing may reach the directory except through this.
    function addPopupHtml() {
        var d = S.add.draft;
        if (!d || (d.mode !== 'new' && d.mode !== 'update')) return '';
        return '<div class="pd-modal" data-pd-addcancel="backdrop">'
            + '<div class="pd-modal-box" role="dialog" aria-modal="true">'
            + '<div class="pd-sec" style="margin-top:0;">Check this before it goes in</div>'
            + (d.read ? '<p class="pd-muted">' + esc(d.read) + '</p>' : '')
            + '<p class="pd-modal-what">' + addPopupHeadHtml(d) + '</p>'
            + diffHtml({ lines: d.lines })
            + (S.add.applyError ? '<div class="pd-error">' + esc(S.add.applyError) + '</div>' : '')
            + '<div class="pd-row" style="margin-top:12px;"><span class="pd-sp"></span>'
            + '<button data-pd-addcancel="1"' + (S.add.applying ? ' disabled' : '') + '>Cancel</button>'
            + '<button class="pd-prim" data-pd-addapply="1"' + (S.add.applying ? ' disabled' : '') + '>'
            + (S.add.applying ? 'Adding…' : 'Apply') + '</button></div></div></div>';
    }

    function addPopupHeadHtml(d) {
        var after = str(d.after && d.after.company) || '(no name given)';
        if (d.mode === 'new') return 'This <b>adds a new firm</b> — ' + esc(after) + '.';
        return 'This <b>updates ' + esc(str(d.before && d.before.company) || after) + '</b>, a firm you already have.';
    }

    // ── The Add tab: reading and applying ─────────────────────────────────────

    function chooseAddFile(f) {
        if (!f) return;
        if (f.size > MAX_ADD_FILE) {
            S.add.fileName = ''; S.add.fileB64 = '';
            S.add.error = 'That file is ' + (f.size / 1048576).toFixed(1) + ' MB. Only 3 MB can be read at once — '
                + 'take the photo smaller, or use just the page that matters.';
            render(); return;
        }
        var r = new FileReader();
        r.onload = function () {
            S.add.fileName = f.name;
            S.add.fileB64 = String(r.result || '').split(',')[1] || '';
            S.add.error = ''; render();
        };
        r.onerror = function () { S.add.error = 'That file could not be opened. Try another one.'; render(); };
        r.readAsDataURL(f);
    }

    function readAdd() {
        var a = S.add;
        if (a.reading) return;   // a second click must never buy a second paid AI run
        if (!str(a.text) && !a.fileB64) { a.error = 'Type something, or choose a file, first.'; render(); return; }
        a.reading = true; a.error = ''; a.notice = ''; a.applyError = ''; a.draft = null;
        render();
        var body = { text: str(a.text) };
        if (a.fileB64) { body.fileBase64 = a.fileB64; body.fileName = a.fileName; }
        postJson('/contacts/add-draft', body, function (d) { S.add.draft = d; }, function () {
            S.add.reading = false;
            // This tab's failures belong beside its own box — the directory's banner says
            // "your last edit is NOT stored", and nothing was being edited here.
            S.add.error = D.saveError; D.saveError = '';
        });
    }

    function applyAdd() {
        var d = S.add.draft;
        if (S.add.applying || !d) return;   // one Apply is one write, however many times it is pressed
        S.add.applying = true; S.add.applyError = ''; render();
        postJson('/contacts/add-apply', { after: d.after, matchId: d.matchId || '' }, addApplied, function () {
            S.add.applying = false;
            S.add.applyError = D.saveError; D.saveError = '';
        });
    }

    function addApplied(r) {
        if (r && r.skipped) {
            S.add.draft = null;
            S.add.notice = 'There was not enough there to make a card, so nothing was added. '
                + 'Give it a firm name or someone to contact and read it again.';
            return;
        }
        var id = r && r.partner && r.partner.id;
        S.add = freshAdd();                 // the box is emptied, so the same file cannot go in twice
        S.tab = 'dir';
        loadDirectory(function () { if (id) openCard(id); else render(); });
    }

    function bindAdd(app) {
        var box = $('pdAddIn');
        if (box) box.oninput = function () { S.add.text = this.value; };
        var file = $('pdAddFile');
        // Cleared the moment it is read: a picker left holding yesterday's brochure is how
        // one firm's details end up on another firm's card.
        if (file) file.onchange = function () { var f = this.files && this.files[0]; this.value = ''; chooseAddFile(f); };
        on(app, '[data-pd-addfileclear]', function () { S.add.fileName = ''; S.add.fileB64 = ''; render(); });
        on(app, '[data-pd-addread]', readAdd);
        on(app, '[data-pd-addapply]', applyAdd);
        each(app, '[data-pd-addpick]', function (el) {
            el.onclick = function () {
                var name = el.getAttribute('data-pd-addpick');
                S.add.text = (str(S.add.text) + '\nThis is about ' + name + '.').trim();
                readAdd();
            };
        });
        bindAddCancel(app);
    }

    function bindAddCancel(app) {
        each(app, '[data-pd-addcancel]', function (el) {
            el.onclick = function (e) {
                if (S.add.applying) return;
                if (el.getAttribute('data-pd-addcancel') === 'backdrop' && e.target !== el) return;
                S.add.draft = null; S.add.applyError = ''; render();
            };
        });
    }

    // ── Recent changes: the pending queue + the applied log ───────────────────
    function changesView() {
        return '<div class="pd-sec">Waiting for you'
            + (D.pending.length ? ' <span class="pd-pill pd-pill-warn">' + D.pending.length + '</span>' : '') + '</div>'
            + '<div class="pd-read" style="margin-bottom:10px;"><p class="pd-tiny">Everything the app has found waits here — '
            + 'addresses you have already sent enquiries to, and anything tagged in Gmail with '
            + '<b>Quotation Automation/Add to Directory</b> (a brochure, rate list or card photo). '
            + 'One card per firm, so everyone at the same firm stays together. '
            + '<b>Nothing is added to your directory until you approve it.</b></p></div>'
            + (D.pending.length ? D.pending.map(pendingStrip).join('')
                : '<p class="pd-muted pd-empty">Nothing waiting.</p>')
            + '<div class="pd-sec" style="margin-top:18px;">Already applied</div>'
            + (D.changes.length
                ? '<p class="pd-muted" style="margin-bottom:8px;">Everything the app changed on its own. Click one to see what moved; undo anything wrong.</p>'
                    + D.changes.map(changeCard).join('')
                : '<p class="pd-muted pd-empty">Nothing applied yet.</p>');
    }

    function pendingStrip(pi) {
        var imported = pi.origin === 'import';
        var match = imported ? matchedPartner(pi) : (pi.from ? knownEmail(pi.from) : null);
        var open = S.openPending === pi.id;
        var busy = S.busy[pi.id];
        return '<div class="pd-src-strip' + (open ? ' on' : '') + '" data-pd-pending="' + esc(pi.id) + '" tabindex="0" role="button">'
            + '<div class="pd-row"><span class="pd-tiny">' + (open ? '▾' : '▸') + '</span>'
            + '<b>' + esc(match ? match.company : (imported ? pi.subject : (companyGuess(pi) || pi.from))) + '</b>'
            + (match ? '<span class="pd-pill">Updates someone you have</span>' : '<span class="pd-pill pd-pill-warn">New</span>')
            + '<span class="pd-sp"></span><span class="pd-tiny">' + ago(pi.receivedAt) + '</span></div>'
            + '<p class="pd-tiny" style="margin-left:20px;">' + (imported ? importedStripLine(pi)
                : 'From <b>' + esc(pi.from) + '</b> · “' + esc(pi.subject) + '”'
                    + (pi.file ? ' · 📎 ' + esc(pi.file) : '')
                    + ' · read into ' + pi.finds.length + ' field' + (pi.finds.length === 1 ? '' : 's')) + '</p>'
            + '</div>'
            + (open ? editCard(pendingPreview(pi, match)) : '')
            + clashNoteHtml(pi, match)
            + '<div class="pd-row" style="margin:0 0 14px;">'
            + '<button class="pd-prim" data-pd-approve="' + esc(pi.id) + '"'
            + (busy || clashingCard(pi, match) ? ' disabled' : '') + '>'
            + (busy ? 'Saving…' : 'Approve — ' + (match ? 'update ' + esc(match.company) : 'add them')) + '</button>'
            + '<button data-pd-discard="' + esc(pi.id) + '"' + (busy ? ' disabled' : '') + '>Discard</button></div>';
    }

    // One address belongs to one company, so say so BEFORE the button is pressed — pressing
    // Approve only to be refused is a worse way to learn it. The other card is one click away.
    function clashingCard(pi, match) {
        // Compared lowercased on BOTH sides, the way the server does. allEmails keeps the
        // address as typed because the chips and the picker show it — so comparing raw let
        // MANISH@Mill.com slip past a stored manish@mill.com, and the owner pressed Approve
        // only to meet the refusal this warning exists to spare them.
        var mine = (pi.preview ? allEmails(pi.preview) : (pi.from ? [pi.from] : [])).map(lower);
        var keepId = (pi.preview && pi.preview.matchId) || (match && match.id) || '';
        for (var i = 0; i < D.contacts.length; i++) {
            var c = D.contacts[i];
            if (!c || c.id === keepId) continue;
            var theirs = allEmails(c).map(lower);
            for (var j = 0; j < mine.length; j++) {
                if (theirs.indexOf(mine[j]) !== -1) return { card: c, email: mine[j] };
            }
        }
        return null;
    }

    function clashNoteHtml(pi, match) {
        var clash = clashingCard(pi, match);
        if (!clash) return '';
        return '<div class="pd-error" style="margin:0 0 8px;"><b>' + esc(clash.email) + '</b> is already on '
            + '<button data-pd-open="' + esc(clash.card.id) + '" class="pd-linkish">'
            + esc(clash.card.company || '(no name)') + '</button>. '
            + 'One address belongs to one company — remove it there first, or discard this one.</div>';
    }

    // An imported firm has no email to quote — it has the addresses themselves, and the
    // count is the point: "3 people at this firm" is what stops three separate enquiries.
    function importedStripLine(pi) {
        var mails = pi.preview ? allEmails(pi.preview) : [pi.from];
        var head = mails.length + ' address' + (mails.length === 1 ? '' : 'es') + ' you have used before';
        return head + ' · ' + mails.map(esc).join(', ')
            + (pi.preview && pi.preview.enq ? ' · asked ' + pi.preview.enq + ' time' + (pi.preview.enq === 1 ? '' : 's') : '');
    }

    function matchedPartner(pi) {
        var id = pi.preview && pi.preview.matchId;
        return id ? (D.contacts.filter(function (x) { return x.id === id; })[0] || null) : null;
    }

    function companyGuess(pi) {
        var f = pi.finds.filter(function (x) { return x.kind === 'field' && x.key === 'company'; })[0];
        return f ? f.value : '';
    }

    // The card as this email WOULD create/update it — built once, kept on the item, so
    // corrections made while reviewing are exactly what approval saves.
    function pendingPreview(pi, match) {
        if (!pi.preview) {
            var base = match ? JSON.parse(JSON.stringify(match))
                : { id: 'p_new_' + pi.id, role: 'dealer', company: companyGuess(pi), people: [{ name: '', role: 'Main contact', phones: [], emails: pi.from ? [{ label: 'Work', v: pi.from }] : [] }], branches: [], types: [], products: [], rules: [], routes: [], notes: [], images: [], fromEnquiry: true };
            // The preview must NOT share the live record's id, or byId() resolves to the live
            // record and every correction typed here is written to it and then overwritten by
            // the un-corrected preview on approve. Keep the real id aside for the save.
            if (match) { base.matchId = match.id; base.id = 'p_new_' + pi.id; }
            pi.finds.forEach(function (x) { applyFind(base, x, pi.file); });
            if (pi.file && !(base.images || []).some(function (im) { return im.n === pi.file; })) {
                (base.images = base.images || []).unshift({ n: pi.file, kind: pi.kind, d: new Date().toISOString().slice(0, 10), count: pi.finds.length });
            }
            pi.preview = base;
        }
        return pi.preview;
    }

    function applyFind(p, x, fileName) {
        if (x.kind === 'field') applyFieldFind(p, x);
        else if (x.kind === 'product') {
            var i = (p.products = p.products || []).findIndex(function (pr) { return lower(pr.p) === lower(x.product.p); });
            if (i === -1) p.products.push(JSON.parse(JSON.stringify(x.product)));
            else p.products[i] = JSON.parse(JSON.stringify(x.product));
        } else if (x.kind === 'routes') {
            (x.routes || []).forEach(function (r) {
                if (!(p.routes = p.routes || []).some(function (e) { return e.from === r.from && e.to === r.to; })) p.routes.push({ from: r.from, to: r.to });
            });
        } else if (x.kind === 'note') {
            (p.notes = p.notes || []).unshift({ d: new Date().toISOString().slice(0, 10), t: x.value, src: 'read from ' + fileName });
        }
    }

    function applyFieldFind(p, x) {
        if (x.key === 'person' || x.key === 'phone' || x.key === 'email') {
            var c = (p.people = p.people && p.people.length ? p.people : [{ name: '', role: 'Main contact', phones: [], emails: [] }])[0];
            if (x.key === 'person') { c.name = x.value; return; }
            var list = x.key === 'phone' ? (c.phones = c.phones || []) : (c.emails = c.emails || []);
            String(x.value).split(/[,;]+/).map(str).filter(Boolean).forEach(function (v) {
                if (!list.some(function (e) { return e.v === v; })) list.push({ label: x.key === 'phone' ? 'Mobile' : 'Work', v: v });
            });
        }
        else if (x.key === 'types') p.types = String(x.value).split(/[,/]+/).map(str).filter(Boolean);
        else if (x.key === 'branches') p.branches = String(x.value).split(/[,;]+/).map(str).filter(Boolean).map(function (c) { return { city: matchCity(c) || c, area: '', address: '' }; });
        else if (x.key === 'moq') p.moq = parseFloat(x.value) || 0;
        else if (x.key === 'role') p.role = lower(x.value);
        else p[x.key] = x.value;
    }

    function changeCard(ch) {
        var open = S.openChange === ch.id;
        var p = ch.partnerId ? D.contacts.filter(function (x) { return x.id === ch.partnerId; })[0] : null;
        return '<div class="pd-card' + (ch.undone ? ' pd-out' : '') + '">'
            + '<div class="pd-row pd-click" data-pd-change="' + esc(ch.id) + '" tabindex="0" role="button">'
            + '<span class="pd-tiny">' + (open ? '▾' : '▸') + '</span><b>' + esc(ch.title) + '</b>'
            + '<span class="pd-pill">' + esc(ch.source) + '</span>'
            + (ch.undone ? '<span class="pd-pill pd-pill-bad">Undone</span>' : '')
            + '<span class="pd-sp"></span><span class="pd-tiny">' + ago(ch.at) + '</span></div>'
            + '<p class="pd-muted" style="margin-left:20px;">' + esc(ch.detail) + '</p>'
            + (open ? diffHtml(ch) : '')
            + (ch.undone ? '' : '<div style="margin:8px 0 0 20px;"><button data-pd-undo="' + esc(ch.id) + '"' + (S.busy[ch.id] ? ' disabled' : '') + '>Undo this</button></div>')
            + '</div>'
            + (open && p ? editCard(p) : '');
    }

    function diffHtml(ch) {
        if (!(ch.lines || []).length) return '<div class="pd-read" style="margin:8px 0 0 20px;"><p class="pd-tiny">Nothing measurable changed on the record.</p></div>';
        return '<div class="pd-read" style="margin:8px 0 0 20px;">'
            + ch.lines.map(function (l) {
                return '<div class="pd-diff"><span class="pd-diff-k">' + esc(l.label) + '</span>'
                    + (l.from ? '<span class="pd-diff-was">' + esc(l.from) + '</span><span class="pd-tiny">→</span>' : '<span class="pd-tiny">added</span>')
                    + '<span class="pd-diff-now">' + esc(l.to) + '</span></div>';
            }).join('') + '</div>';
    }

    // ── Events ────────────────────────────────────────────────────────────────
    function each(root, sel, fn) { root.querySelectorAll(sel).forEach(fn); }
    function on(root, sel, fn) { var el = root.querySelector(sel); if (el) el.onclick = fn; }

    function bind(app) {
        each(app, '[data-pd-tab]', function (el) {
            el.onclick = function () {
                S.tab = el.getAttribute('data-pd-tab');
                render();
                loadDirectory(render);   // refetch — a labelled email may have arrived meanwhile
            };
        });
        on(app, '[data-pd-reload]', function () { loadDirectory(render); });
        each(app, '[data-pd-filter]', function (el) { el.onclick = function () { S.filter = el.getAttribute('data-pd-filter'); S.openId = null; render(); }; });
        bindFinder(app); bindAdd(app); bindListAndCard(app); bindChanges(app);
    }

    function bindFinder(app) {
        var box = $('pdFindIn');
        if (box) box.oninput = function () { S.find.text = this.value; };
        each(app, '[data-pd-find]', function (el) {
            el.onclick = function () {
                if (el.getAttribute('data-pd-find') === 'clear') { S.find = { text: '', state: 'idle', need: null }; render(); return; }
                var text = str(S.find.text);
                if (!text) return;
                var need = readEnquiry(text);
                if (need.empty) { S.find.state = 'name'; S.find.need = null; }
                else { S.find.state = 'done'; S.find.need = need; }
                S.openId = null; render();
            };
        });
        on(app, '[data-pd-import]', function () {
            if (S.importing) return;                      // in-flight lock: no double import
            S.importing = true; render();
            postJson('/contacts/import-remembered', {}, function (d) {
                S.imported = d;
                // They go to the queue, not the directory — so land the owner where the work is.
                if (d && d.queued) S.tab = 'changes';
                loadDirectory(render);
            }, function () { S.importing = false; });      // released even if the import fails
        });
        on(app, '[data-pd-add]', function () {
            // Nothing is written until something is typed. Saving a blank card on the click
            // was the bug: an in-flight lock only covers the request, so a second press once
            // it returned left a second empty row in the directory for good.
            var blank = D.contacts.filter(isBlankCard)[0];
            if (blank) { openCard(blank.id); return; }    // one empty card is enough
            // A real partner gets a real id at once ('p_…'); 'p_new_' is reserved for
            // pending-queue previews, which are never saved directly.
            // Random suffix, not a bare timestamp: two devices adding in the same
            // millisecond would otherwise share an id and merge into one record.
            var p = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), role: 'dealer', company: '', people: [{ name: '', role: 'Main contact', phones: [], emails: [] }], branches: [], types: [], products: [], rules: [], routes: [], notes: [], images: [], partLoad: true };
            D.contacts.unshift(p);
            openCard(p.id);
        });
    }

    function openCard(id) {
        S.openId = id; S.filter = 'all'; S.find = { text: '', state: 'idle', need: null };
        render();
    }

    /**
     * A card with nothing on it: no firm name, and nobody you could reach. Worth no row in
     * the directory — and an abandoned one disappears by itself on the next load, because it
     * was never written.
     */
    /** True only for a card the directory actually holds — not a queue preview. */
    function isInDirectory(p) {
        return !!p && D.contacts.some(function (x) { return x.id === p.id; });
    }

    function isBlankCard(p) {
        if (!p || str(p.company)) return false;
        return !people(p).some(function (c) {
            return str(c.name) || (c.phones || []).some(function (x) { return str(x.v); })
                || (c.emails || []).some(function (x) { return str(x.v); });
        });
    }

    function bindListAndCard(app) {
        each(app, '[data-pd-open]', function (el) {
            var go = function () {
                S.openId = el.getAttribute('data-pd-open');
                S.find.state = S.find.state === 'done' ? 'idle' : S.find.state;
                // Reachable from a clash note on the Recent-changes tab, where the card it
                // opens is not rendered — go to where it lives, or the click does nothing.
                S.tab = 'dir'; S.filter = 'all';
                render();
            };
            el.onclick = go;
            el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
        });
        each(app, '[data-pd-close]', function (el) { el.onclick = function () { S.openId = null; render(); }; });
        each(app, '[data-pd-delete]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-delete');
                var p = byId(id);
                if (!window.confirm('Delete ' + (p && p.company ? p.company : 'this partner') + ' from the directory?')) return;
                postJson('/contacts/delete', { id: id }, function () { loadDirectory(render); });
            };
        });
        bindCardFields(app);
    }

    // Every edit mutates the open partner and saves THAT partner. `touched` stamps
    // last-edited; the save is per-field onchange (fires on blur), so nothing batches up
    // to be lost — and a failed save shows a red banner, not silence.
    function bindCardFields(app) {
        var card = app.querySelector('[data-pd-card]');
        if (!card) return;
        var p = byId(card.getAttribute('data-pd-card'));
        if (!p) return;
        var save = function (rerender, fields) {
            p.checked = new Date().toISOString().slice(0, 10);
            // A pending-queue PREVIEW is never saved here — approval is its only write path.
            // (Otherwise editing one before approving stores a stray copy = a duplicate firm.)
            var inDirectory = isInDirectory(p);
            // A brand-new card is only written once it says something. Typing the firm name
            // (or a person, or a number) is what creates it; until then there is nothing to
            // store, and storing it anyway is what left blank rows behind.
            if (inDirectory && !isBlankCard(p)) savePartner(p, fields);
            if (rerender) render();
        };
        each(card, '[data-pd-k]', function (el) {
            if (el.hasAttribute('data-pd-pc') || el.hasAttribute('data-pd-br') || el.hasAttribute('data-pd-pr') || el.hasAttribute('data-pd-rt')) return;
            el.onchange = function () {
                var k = el.getAttribute('data-pd-k'), v = el.value;
                if (k === 'moq') p.moq = parseFloat(v) || 0;
                else if (k === 'partLoad') p.partLoad = v === 'yes';
                else p[k] = v;
                save(k === 'role' || k === 'company', [k]);
            };
        });
        bindPeople(card, p, save); bindPlaces(card, p, save); bindSupply(card, p, save); bindNotes(card, p, save);
    }

    function bindPeople(card, p, save) {
        each(card, '[data-pd-pc]', function (el) {
            el.onchange = function () {
                var c = p.people[Number(el.getAttribute('data-pd-pc'))], k = el.getAttribute('data-pd-k');
                if (el.hasAttribute('data-pd-ph')) c.phones[Number(el.getAttribute('data-pd-ph'))][k] = el.value;
                else if (el.hasAttribute('data-pd-em')) c.emails[Number(el.getAttribute('data-pd-em'))][k] = el.value;
                else c[k] = el.value;
                save(false, ['people']);
            };
        });
        on(card, '[data-pd-addperson]', function () { p.people.push({ name: '', role: '', phones: [{ label: 'Mobile', v: '' }], emails: [{ label: 'Work', v: '' }] }); save(true, ['people']); });
        each(card, '[data-pd-delperson]', function (el) { el.onclick = function () { p.people.splice(Number(el.getAttribute('data-pd-delperson')), 1); save(true, ['people']); }; });
        each(card, '[data-pd-addph]', function (el) { el.onclick = function () { var c = p.people[Number(el.getAttribute('data-pd-addph'))]; (c.phones = c.phones || []).push({ label: 'Mobile', v: '' }); save(true, ['people']); }; });
        each(card, '[data-pd-addem]', function (el) { el.onclick = function () { var c = p.people[Number(el.getAttribute('data-pd-addem'))]; (c.emails = c.emails || []).push({ label: 'Work', v: '' }); save(true, ['people']); }; });
        each(card, '[data-pd-delph]', function (el) { el.onclick = function () { var a = el.getAttribute('data-pd-delph').split(':'); p.people[+a[0]].phones.splice(+a[1], 1); save(true, ['people']); }; });
        each(card, '[data-pd-delem]', function (el) { el.onclick = function () { var a = el.getAttribute('data-pd-delem').split(':'); p.people[+a[0]].emails.splice(+a[1], 1); save(true, ['people']); }; });
    }

    function bindPlaces(card, p, save) {
        on(card, '[data-pd-addbranch]', function () { (p.branches = p.branches || []).push({ city: '', area: '', address: '' }); save(true, ['branches', 'routes', 'city', 'address']); });
        each(card, '[data-pd-br]', function (el) {
            el.onchange = function () { p.branches[Number(el.getAttribute('data-pd-br'))][el.getAttribute('data-pd-k')] = el.value; save(false, ['branches', 'routes', 'city', 'address']); };
        });
        each(card, '[data-pd-delbranch]', function (el) { el.onclick = function () { p.branches.splice(Number(el.getAttribute('data-pd-delbranch')), 1); save(true, ['branches', 'routes', 'city', 'address']); }; });
        on(card, '[data-pd-addroute]', function () { (p.routes = p.routes || []).push({ from: '', to: '' }); save(true, ['branches', 'routes', 'city', 'address']); });
        each(card, '[data-pd-rt]', function (el) {
            el.onchange = function () { p.routes[Number(el.getAttribute('data-pd-rt'))][el.getAttribute('data-pd-k')] = el.value; save(false, ['branches', 'routes', 'city', 'address']); };
        });
        each(card, '[data-pd-delroute]', function (el) { el.onclick = function () { p.routes.splice(Number(el.getAttribute('data-pd-delroute')), 1); save(true, ['branches', 'routes', 'city', 'address']); }; });
    }

    function bindSupply(card, p, save) {
        var pick = $('pdTypePick');
        on(card, '[data-pd-addtype]', function () {
            var v = pick ? pick.value : '';
            if (v === '__other') v = window.prompt('What do they deal in? e.g. Ductile iron') || '';
            v = str(v);
            if (!v) return;
            if ((p.types = p.types || []).indexOf(v) === -1) p.types.push(v);
            if (PIPE_TYPES.indexOf(v) === -1) PIPE_TYPES.push(v);
            save(true, ['types', 'products', 'rules', 'moq']);
        });
        each(card, '[data-pd-deltype]', function (el) { el.onclick = function () { p.types.splice(Number(el.getAttribute('data-pd-deltype')), 1); save(true, ['types', 'products', 'rules', 'moq']); }; });
        on(card, '[data-pd-addproduct]', function () { (p.products = p.products || []).push({ p: '', spec: '', sizes: [], moq: 0, rule: '' }); save(true, ['types', 'products', 'rules', 'moq']); });
        each(card, '[data-pd-delproduct]', function (el) { el.onclick = function () { p.products.splice(Number(el.getAttribute('data-pd-delproduct')), 1); save(true, ['types', 'products', 'rules', 'moq']); }; });
        each(card, '[data-pd-pr]', function (el) {
            el.onchange = function () {
                var i = Number(el.getAttribute('data-pd-pr')), k = el.getAttribute('data-pd-k');
                if (el.hasAttribute('data-pd-sz')) p.products[i].sizes[Number(el.getAttribute('data-pd-sz'))][k] = el.value;
                else p.products[i][k] = (k === 'moq') ? (parseFloat(el.value) || 0) : el.value;
                save(k === 'spec', ['types', 'products', 'rules', 'moq']);
            };
        });
        each(card, '[data-pd-addsz]', function (el) { el.onclick = function () { var pr = p.products[Number(el.getAttribute('data-pd-addsz'))]; (pr.sizes = pr.sizes || []).push({ nb: '', inch: '', od: '', thk: '' }); save(true, ['types', 'products', 'rules', 'moq']); }; });
        each(card, '[data-pd-delsz]', function (el) { el.onclick = function () { var a = el.getAttribute('data-pd-delsz').split(':'); p.products[+a[0]].sizes.splice(+a[1], 1); save(true, ['types', 'products', 'rules', 'moq']); }; });
        each(card, '[data-pd-loadis]', function (el) {
            el.onclick = function () {
                var pr = p.products[Number(el.getAttribute('data-pd-loadis'))], cls = specClass(pr.spec);
                if (!cls) return;
                pr.sizes = IS1239.filter(function (r) { return r[cls]; }).map(function (r) { return { nb: r.nb, inch: r.inch, od: r.od, thk: r[cls] }; });
                save(true, ['types', 'products', 'rules', 'moq']);
            };
        });
        on(card, '[data-pd-addorule]', function () { (p.rules = p.rules || []).push(''); save(true, ['types', 'products', 'rules', 'moq']); });
        each(card, '[data-pd-orule]', function (el) { el.onchange = function () { p.rules[Number(el.getAttribute('data-pd-orule'))] = el.value; save(false, ['types', 'products', 'rules', 'moq']); }; });
        each(card, '[data-pd-delorule]', function (el) { el.onclick = function () { p.rules.splice(Number(el.getAttribute('data-pd-delorule')), 1); save(true, ['types', 'products', 'rules', 'moq']); }; });
    }

    function bindNotes(card, p, save) {
        var input = $('pdNoteIn');
        var add = function () {
            var t = input ? str(input.value) : '';
            if (!t) return;
            (p.notes = p.notes || []).unshift({ d: new Date().toISOString().slice(0, 10), t: t, src: '' });
            save(true, ['notes']);
        };
        on(card, '[data-pd-addnote]', add);
        if (input) input.onkeydown = function (e) { if (e.key === 'Enter') add(); };
        each(card, '[data-pd-delnote]', function (el) { el.onclick = function () { p.notes.splice(Number(el.getAttribute('data-pd-delnote')), 1); save(true, ['notes']); }; });
    }

    function bindChanges(app) {
        each(app, '[data-pd-pending]', function (el) {
            var go = function () {
                var id = el.getAttribute('data-pd-pending');
                if (S.openPending === id) { S.openPending = null; S.openId = null; }
                else {
                    S.openPending = id;
                    var pi = D.pending.filter(function (x) { return x.id === id; })[0];
                    var match = pi && pi.from ? knownEmail(pi.from) : null;
                    S.openId = pi ? pendingPreview(pi, match).id : null;
                }
                render();
            };
            el.onclick = go;
            el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
        });
        each(app, '[data-pd-approve]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-approve');
                if (S.busy[id]) return;               // double-click is a no-op, not a second save
                var pi = D.pending.filter(function (x) { return x.id === id; })[0];
                if (!pi) return;
                var partner = pendingPreview(pi, pi.from ? knownEmail(pi.from) : null);
                // Put the real id back for an update; leave it blank for a brand-new firm so
                // the server assigns one. Either way what is saved is what was just reviewed.
                partner = JSON.parse(JSON.stringify(partner));
                partner.id = partner.matchId || '';
                delete partner.matchId;
                S.busy[id] = true; render();
                postJson('/contacts/pending/approve', { id: id, partner: partner }, function () {
                    S.openPending = null; S.openId = null;
                    loadDirectory(render);
                }, function () { delete S.busy[id]; });
            };
        });
        each(app, '[data-pd-discard]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-discard');
                if (S.busy[id]) return;
                S.busy[id] = true; render();
                postJson('/contacts/pending/discard', { id: id }, function () { loadDirectory(render); },
                    function () { delete S.busy[id]; });
            };
        });
        each(app, '[data-pd-change]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-change');
                S.openChange = S.openChange === id ? null : id;
                var ch = D.changes.filter(function (x) { return x.id === id; })[0];
                S.openId = (S.openChange && ch) ? ch.partnerId : null;
                render();
            };
        });
        each(app, '[data-pd-undo]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-undo');
                if (S.busy[id]) return;
                S.busy[id] = true; render();
                postJson('/contacts/change-undo', { id: id }, function () { loadDirectory(render); },
                    function () { delete S.busy[id]; });
            };
        });
    }

    // ── The in-quote suggestion panel (Freight / Enquiry tabs call this) ──────
    // opts: { kind:'transport'|'material', pickup, drop, kg, types:[], items:[], site }
    // onAddChip(chipText): ONE chip = ONE email — several addresses in a chip are CC'd
    // together (same firm); separate chips are separate emails (firms never meet).
    function renderSuggestPanel(container, opts, onAddChip) {
        if (!container) return;
        var go = function () {
            var need = {
                types: opts.types || [], items: opts.items || [],
                site: str(opts.drop) ? (matchCity(opts.drop) || opts.drop) : (str(opts.site) ? (matchCity(opts.site) || opts.site) : HOME),
                tons: (opts.kg || 0) / 1000, known: (opts.kg || 0) > 0,
            };
            var from = str(opts.pickup) ? (matchCity(opts.pickup) || opts.pickup) : HOME;
            var rows = rankFor(opts.kind === 'transport' ? 'transport' : 'material', need, from);
            if (D.loadError) { container.innerHTML = '<div class="pd-panel"><p class="pd-error">' + esc(D.loadError) + ' Nothing is missing — try again.</p></div>'; return; }
            container.innerHTML = panelHtml(rows, opts, need, from);
            bindPanel(container, rows, onAddChip);
        };
        // Always re-read before suggesting. This panel is asked for by hand, once in a
        // while — a cached copy risks suggesting a partner a colleague has since changed
        // or removed, or missing one they added, and that goes out as a real email.
        container.innerHTML = '<div class="pd-panel"><p class="pd-tiny">Reading your directory…</p></div>';
        loadDirectory(go);
    }

    function panelHtml(rows, opts, need, from) {
        var head = opts.kind === 'transport'
            ? 'Read from this box: <b>' + esc(from) + '</b> → <b>' + esc(need.site) + '</b> · <b>' + (need.known ? need.tons.toFixed(2) + ' T' : 'no weight') + '</b>'
            : 'Read from the enquiry: <b>' + esc((need.types || []).join(' + ') || 'no pipe type') + '</b> · <b>' + (need.known ? need.tons.toFixed(2) + ' T' : 'no weight') + '</b> · to <b>' + esc(need.site) + '</b>';
        var good = rows.filter(function (r) { return !r.blocked; });
        var out = rows.filter(function (r) { return r.blocked; });
        return '<div class="pd-panel"><p class="pd-tiny" style="margin-bottom:8px;">' + head + '</p>'
            + (good.length ? good.map(function (r, i) { return panelCard(r, i); }).join('')
                : deadEndHtml(need, opts))
            + (out.length ? '<p class="pd-tiny" style="margin:8px 0 5px;">Not suggested — but shown, so you can overrule it:</p>'
                + out.map(function (r, i) { return panelCard(r, good.length + i); }).join('') : '')
            + '<p class="pd-tiny" style="margin-top:8px;">People at one firm go on <b>one</b> email, Cc\'d together. Different firms are <b>separate</b> emails — they never see each other.</p></div>';
    }

    // "Nobody fits" must never be the end of the road. Offer the two ways out that exist:
    // look outside the directory on the web, or add the firm you already have in mind.
    function deadEndHtml(need, opts) {
        var what = opts.kind === 'transport'
            ? 'transporters ' + (need.site ? 'to ' + need.site : 'for this route')
            : ((need.types || []).join(' ') + ' pipe suppliers ' + (need.site ? 'near ' + need.site : '')).trim();
        var query = encodeURIComponent(what + ' India supplier contact');
        return '<div class="pd-empty"><p class="pd-muted"><b>Nobody in your directory fits this one.</b></p>'
            + '<p class="pd-tiny" style="margin:6px 0 9px;">Either you have not added them yet, or this is outside what you normally buy.</p>'
            + '<div class="pd-row">'
            + '<a class="pd-prim" style="text-decoration:none;" target="_blank" rel="noopener noreferrer" '
            + 'href="https://www.google.com/search?q=' + query + '">🌐 Search the web for ' + esc(what) + '</a>'
            + '<button data-pd-goto-directory="1">Add them to the directory</button></div>'
            + '<p class="pd-tiny" style="margin-top:7px;">Anything you find on the web is unvetted — ask for a written offer before you quote from it.</p></div>';
    }

    function panelCard(r, idx) {
        var emails = allEmails(r.p);
        return '<div class="pd-card' + (r.blocked ? ' pd-out' : '') + '"><div class="pd-rank">'
            + '<span class="pd-rank-n">' + (r.blocked ? '–' : idx + 1) + '</span>'
            + '<div style="flex:1;min-width:0;"><div class="pd-row"><b>' + esc(r.p.company) + '</b>'
            + '<span class="pd-pill">' + esc(roleLabel(r.p)) + '</span>'
            + (isRegular(r.p) ? '<span class="pd-pill pd-pill-good">Regular</span>' : '') + '</div>'
            + '<p class="pd-tiny">' + esc([mainName(r.p), mainEmail(r.p), mainPhone(r.p)].filter(Boolean).join(' · ')) + '</p>'
            + '<div>' + r.why.map(function (w) { return '<span class="pd-why pd-why-' + w[0] + '">' + esc(w[1]) + '</span>'; }).join('') + '</div></div>'
            + (emails.length ? '<button class="pd-prim" data-pd-send="' + idx + '">✉ Send Email</button>'
                : '<span class="pd-tiny">no email on card</span>')
            + '</div><div class="pd-picker" data-pd-picker="' + idx + '" hidden></div></div>';
    }

    function bindPanel(container, rows, onAddChip) {
        each(container, '[data-pd-goto-directory]', function (el) {
            el.onclick = function () { if (typeof window.switchToDirectoryTab === 'function') window.switchToDirectoryTab(); };
        });
        each(container, '[data-pd-send]', function (el) {
            el.onclick = function () {
                var idx = Number(el.getAttribute('data-pd-send'));
                var slot = container.querySelector('[data-pd-picker="' + idx + '"]');
                if (!slot.hidden) { slot.hidden = true; return; }
                slot.innerHTML = pickerHtml(rows[idx].p);
                slot.hidden = false;
                bindPicker(slot, rows[idx].p, onAddChip);
            };
        });
    }

    function pickerHtml(p) {
        var rowsHtml = '';
        people(p).forEach(function (c, ci) {
            (c.emails || []).forEach(function (e, ei) {
                if (!e.v) return;
                rowsHtml += '<label class="pd-pickrow"><input type="checkbox" checked data-pd-pick="' + ci + ':' + ei + '">'
                    + '<span>' + esc(e.v) + '<br><span class="pd-tiny">' + esc(c.name || '(no name)') + (c.role ? ' · ' + esc(c.role) : '') + ' · ' + esc(e.label) + '</span></span></label>';
            });
        });
        return '<p class="pd-tiny" style="margin-bottom:5px;">Pick who at ' + esc(p.company) + ' gets the enquiry — ticked people ride on one email, Cc\'d together:</p>'
            + rowsHtml
            + '<div class="pd-row" style="margin-top:7px;"><button class="pd-prim" data-pd-pickadd="1">Add to recipients</button></div>';
    }

    function bindPicker(slot, p, onAddChip) {
        on(slot, '[data-pd-pickadd]', function () {
            var picked = [];
            each(slot, '[data-pd-pick]', function (cb) {
                if (!cb.checked) return;
                var a = cb.getAttribute('data-pd-pick').split(':');
                var e = ((people(p)[+a[0]] || {}).emails || [])[+a[1]];
                if (e && e.v) picked.push(e.v);
            });
            if (picked.length && typeof onAddChip === 'function') onAddChip(picked.join(', '));
            slot.hidden = true;
        });
    }

    /** Fire-and-record: the send flows call this after a successful send / detected reply. */
    function recordUsage(usage) {
        postJson('/contacts/usage', usage || {}, function () { D.loaded = false; });
    }

    // ── Tool-tab switching (register.js pattern) ──────────────────────────────
    function hideDirectory() {
        var app = $('partnerDirectoryApp');
        var btn = $('mainToolDirectoryButton');
        if (app) app.style.display = 'none';
        if (btn) btn.classList.remove('main-tools-button--active');
    }

    function wrapSwitchers() {
        ['switchToQuotationTab', 'switchToWeightTab', 'switchToEnquiryTab', 'switchToRegisterTab'].forEach(function (name) {
            var original = window[name];
            if (typeof original !== 'function' || original._pdWrapped) return;
            var wrapped = function () { original.apply(this, arguments); hideDirectory(); };
            wrapped._pdWrapped = true;
            window[name] = wrapped;
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrapSwitchers);
    else wrapSwitchers();

    function switchToDirectoryTab() {
        ['quotationApp', 'weightCalculatorApp', 'enquiryPreparerApp', 'registerApp'].forEach(function (id) {
            var el = $(id); if (el) el.style.display = 'none';
        });
        ['mainToolQuotationButton', 'mainToolWeightButton', 'mainToolEnquiryButton', 'mainToolRegisterButton'].forEach(function (id) {
            var el = $(id); if (el) el.classList.remove('main-tools-button--active');
        });
        var app = $('partnerDirectoryApp');
        var btn = $('mainToolDirectoryButton');
        if (app) app.style.display = '';
        if (btn) btn.classList.add('main-tools-button--active');
        render();
        loadDirectory(render);
    }

    window.switchToDirectoryTab = switchToDirectoryTab;
    window.partnerDirectory = {
        renderSuggestPanel: renderSuggestPanel,
        recordUsage: recordUsage,
        _test: { readEnquiry: readEnquiry, rankFor: rankFor, matchCity: matchCity, kmBetween: kmBetween, applyFind: applyFind, _state: function () { return { S: S, D: D }; } },
    };
})();
