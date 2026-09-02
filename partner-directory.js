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
        // FLOOR, not round. A date is parsed at midnight UTC while "now" is the local clock,
        // so rounding made a note written five days ago say "5 days ago" in the morning and
        // "6 days ago" after midday — the same note, aging a day at lunchtime.
        return isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
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
    // Capped: a reply flag that fails to save lets the same reply be counted twice, and
    // "replied 140%" on a card is nonsense in the one place the owner needs plain numbers.
    function replyRate(p) { return p.enq ? Math.min(100, Math.round((p.rep || 0) / p.enq * 100)) : 0; }

    /**
     * "replied 0%" reads as a measurement of a firm that never writes back. Replies have only
     * been counted since reply-tracking was built, and imported cards carry their old enquiry
     * count with no replies at all — so the owner's best suppliers all read as people who
     * ignore him. Nothing counted is "not recorded", not nought per cent.
     */
    function repliesLine(p) {
        return (p.rep || 0) ? 'replied ' + replyRate(p) + '%' : 'no replies recorded';
    }

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
        // `raw` as well as `t`: spotting a town the table does not hold leans on the capital
        // letter the customer typed, and `t` has already been lowercased.
        var place = readPlaces(t, raw);
        return {
            items: merged, types: types,
            site: place.site || HOME, siteAssumed: !place.site, pickup: place.pickup,
            // A place was named that the distance table has never heard of. Saying "no place
            // named" there was the harm: it gave a reason NOT to check, and then handed a
            // Chennai dealer "right by the site" for a delivery 400 km away.
            siteUnknown: place.unknown,
            tons: kgTotal / 1000, known: kgTotal > 0,
            freight: /transport|freight|lorry|truck|part load|full load/.test(t) || !!place.pickup,
            empty: looksLikeNothing(t, types, place.pickup),
        };
    }

    // Words that mean "this is where it goes", so the town beside one of them wins over the
    // town in the customer's letterhead. Chennai used to win almost every enquiry simply by
    // being first in the table.
    var DELIVERY_WORDS = /(deliver(y|ed)?|despatch|dispatch|ship(ped|ment)?|site|destination|unload|to)\b[^a-z0-9]{0,12}$/i;
    var PICKUP_WORDS = /\b(from|ex|pick\s*up|loading)\b[^a-z0-9]{0,12}$/i;

    /**
     * Where it is going, and where it is coming from.
     *
     * Every known town is found, each tagged by the words just before it, and a town that
     * FOLLOWS a delivery word wins — the last one, because an enquiry that corrects itself
     * ("delivery Hosur, not Salem") means the later word. Only if nothing is tagged does it
     * fall back to the first town mentioned, which is what it always used to do.
     */
    function readPlaces(text, raw) {
        var t = ' ' + lower(text) + ' ';
        var hits = [];
        Object.keys(COORD).forEach(function (c) {
            var needle = ' ' + lower(c), from = 0, i;
            while ((i = t.indexOf(needle, from)) !== -1) {
                hits.push({ city: c, at: i, lead: t.slice(Math.max(0, i - 24), i + 1) });
                from = i + needle.length;
            }
        });
        hits.sort(function (a, b) { return a.at - b.at; });
        var delivery = hits.filter(function (h) { return DELIVERY_WORDS.test(h.lead); });
        var pickups = hits.filter(function (h) { return PICKUP_WORDS.test(h.lead); });
        var site = delivery.length ? delivery[delivery.length - 1].city
            : (hits.filter(function (h) { return !PICKUP_WORDS.test(h.lead); })[0] || {}).city || '';
        return {
            site: site,
            pickup: pickups.length ? pickups[0].city : '',
            unknown: site ? '' : unknownPlaceNamed(raw || text),
        };
    }

    /**
     * A place-shaped word sitting right after "delivery at …" that the table does not hold.
     * Only 24 towns are in it, so this is the common case, not the rare one.
     */
    function unknownPlaceNamed(text) {
        var m = /(?:deliver(?:y|ed)?|despatch|dispatch|ship(?:ment)?)\s*(?:at|to|in)?\s*[:\-]?\s*([A-Z][a-zA-Z]{2,})/
            .exec(String(text || ''));
        return m ? m[1] : '';
    }

    /**
     * Is there really no enquiry here — or just no pipe family spelled out?
     *
     * "kindly quote for 20 MT pipes, delivery at Erode" names no family, and the whole email
     * was being used as a search term against company names. Anything long, or carrying
     * numbers, is an enquiry worth ranking even when the family is unstated.
     */
    /**
     * A firm's own name carries trade words — "Sri Balaji Transports", "GI Tubes & Co" — and
     * the finder read those as an enquiry, ranked a Chennai → Chennai lorry route, and never
     * ran the search. Short, no quantity, and it IS the name of a firm already on file: that
     * is somebody looking a partner up, whatever words are in it.
     */
    function looksLikeFirmName(text) {
        var t = str(text);
        // Four characters at least, so "GI" and "ERW" stay pipe families rather than matching
        // the first firm with those two letters in its name.
        if (t.length < 4 || t.length > 60) return false;
        var needle = lower(t);
        return D.contacts.some(function (p) { return lower(p.company).indexOf(needle) !== -1; });
    }

    function looksLikeNothing(t, types, pickup) {
        if (types.length || pickup || /transport|freight|lorry|truck/.test(t)) return false;
        return t.length < 80 && !/\d/.test(t);
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

    // The quote side hands its pipe types over in lower case ('gi', 'erw', 'seamless'). Print
    // them the way the trade writes them, not the way the code happens to store them.
    function typeNames(types, sep) {
        return (types || []).map(function (t) {
            return PIPE_TYPES.filter(function (k) { return lower(k) === lower(t); })[0] || str(t);
        }).join(sep || ' + ');
    }

    function scoreTypes(p, need, why) {
        var have = (p.types || []).map(lower);
        var wanted = (need.types || []).map(lower);
        if (!wanted.length) { why.push(['neutral', 'No pipe type given — cannot match on product']); return { pts: 0, blocked: false }; }
        var hits = wanted.filter(function (t) { return have.indexOf(t) !== -1; });
        if (!hits.length && have.length) { why.push(['bad', 'Does not deal in ' + typeNames(need.types, ' / ')]); return { pts: 0, blocked: true }; }
        if (!have.length) { why.push(['neutral', 'No pipe types on their card yet']); return { pts: 0, blocked: false }; }
        if (hits.length === wanted.length) { why.push(['ok', 'Deals in ' + typeNames(need.types)]); return { pts: 40, blocked: false }; }
        why.push(['warn', 'Only does ' + typeNames(hits, ', ') + ' of ' + typeNames(need.types, ' / ')]);
        return { pts: 20, blocked: false };
    }

    /**
     * A card the app made for itself has nothing typed on it, so its blank minimum is
     * "not recorded", not "no minimum". Green-ticking "No minimum in the way" off a blank
     * is the fifth check — a fact nobody entered, stated as one. A card the owner has
     * opened and checked is taken at its word.
     */
    function unconfirmedCard(p) { return !!(p && p.fromEnquiry); }

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
            if (!p.moq && unconfirmedCard(p)) { why.push(['neutral', 'Minimum not recorded — worth asking']); return 0; }
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
        // Three different reasons a distance cannot be worked out, and they all used to read
        // as "No city on their card — add one". A dealer whose card plainly said Erode was
        // told to add a city he had already added, and lost 5 points for it.
        //
        // 1. The DELIVERY town is one we cannot place. Nobody's fault, nobody scored — and it
        //    must not hand every Chennai dealer "right by the site" either.
        var unplaceableSite = need.siteUnknown || (site && !COORD[site] && !/pan india/i.test(site) ? site : '');
        if (unplaceableSite) {
            why.push(['warn', unplaceableSite + ' is not a town I can measure — distance not scored']);
            return 0;
        }
        var towns = branchNames(p).filter(Boolean);
        // 2. Their card really is blank. That costs them, and saying so is the point.
        if (!towns.length) { why.push(['warn', 'No city on their card — add one and this ranks properly']); return -5; }
        var nb = nearestBranch(p, site);
        // 3. Their town is filled in, just not one of the 24 the distance table holds.
        if (!nb) { why.push(['neutral', 'Their city (' + towns[0] + ') is not in my distance list — distance not scored']); return 0; }
        if (nb.km <= 60) { why.push(['ok', 'In ' + nb.name + ' — right by the site']); return 35; }
        if (nb.km <= 250) { why.push(['ok', nb.name + ' branch, ' + nb.km + ' km from site']); return 20; }
        why.push(['warn', nb.name + ' — ' + nb.km + ' km away, freight will hurt']); return -10;
    }

    /**
     * `daysSince` returns 0 for a firm emailed this morning, and 0 is falsy — so `|| 999`
     * turned today into "not lately". A firm emailed hours ago was described as one you had
     * not dealt with, lost 10 points for it, and wore the green Regular badge on the same
     * card. isRegular already had the explicit check; this is the same one.
     */
    function dealtWithRecently(p) { var n = daysSince(p.last); return n !== null && n <= 120; }

    /**
     * Replies were only counted from the day reply-tracking was built, so "replied 0%" on a
     * firm asked 12 times is not a measurement — nothing was ever measured. Say what is
     * actually known, and do not paint it orange as though they had ignored you.
     */
    function historyLine(p) {
        var replies = (p.rep || 0)
            ? 'Replied to ' + p.rep + ' of ' + p.enq + ' enquiries'
            : 'Asked ' + p.enq + ' time' + (p.enq === 1 ? '' : 's') + ', no reply recorded';
        return replies + (dealtWithRecently(p) ? ', dealt with recently' : ', but not lately');
    }

    function scoreHistoryAndNotes(p, why) {
        var pts = 0;
        if (p.enq) {
            pts += Math.round((p.rep || 0) / p.enq * 20) + (dealtWithRecently(p) ? 10 : 0);
            why.push([(p.rep ? 'ok' : 'neutral'), historyLine(p)]);
        } else why.push(['neutral', 'Never asked through the app']);
        (p.rules || []).forEach(function (r) { if (str(r)) why.push(['note', 'Applies to everything: ' + r]); });
        var n = (p.notes || [])[0];
        if (n) why.push(['note', 'Your note (' + ago(n.d) + '): ' + n.t]);
        if ((daysSince(p.checked) || 0) > 180) why.push(['warn', 'Last edited ' + ago(p.checked) + ' — worth confirming before you quote']);
        return pts;
    }

    function scoreSupplier(p, need) {
        var why = [], wrongRole = roleBlock(p, 'material', why), types = scoreTypes(p, need, why);
        var score = types.pts + (types.blocked ? 0 : scoreMinimums(p, need, why))
            + scoreDistance(p, need, why) + scoreHistoryAndNotes(p, why);
        var blocked = types.blocked || wrongRole;
        return { p: p, score: blocked ? -999 + score : score, why: why, blocked: blocked };
    }

    /**
     * Route scoring needs both ends. With the pickup and delivery boxes still empty, both
     * used to fall back to Chennai, so the panel announced "Chennai → Chennai", warned that
     * most carriers did not go there, and ruled the rest out — which reads as a broken
     * directory. No towns means no route rule, for everyone alike.
     */
    function scoreRoute(p, from, to, why) {
        if (!from || !to) { why.push(['neutral', 'Fill in the pickup and delivery towns and I can rank on route']); return { pts: 0, blocked: false }; }
        var norm = function (v) { return lower(matchCity(v) || v); };
        var exact = (p.routes || []).filter(function (r) { return norm(r.from) === lower(from) && norm(r.to) === lower(to); })[0];
        if (exact) { why.push(['ok', 'Runs ' + from + ' → ' + to + ' regularly']); return { pts: 45, blocked: false }; }
        if ((p.routes || []).some(function (r) { return norm(r.from) === lower(from); })) { why.push(['warn', 'Loads from ' + from + ', but not to ' + to]); return { pts: 22, blocked: false }; }
        if (/pan india/i.test(branchNames(p).join(' '))) { why.push(['warn', 'No regular ' + from + ' → ' + to + ', but runs a national network']); return { pts: 8, blocked: false }; }
        why.push(['bad', 'Does not run ' + from + ' → ' + to]);
        return { pts: 0, blocked: true };
    }

    function scoreLoadSize(p, need, why) {
        if (!need.known) { why.push(['neutral', 'No weight given — part load vs full truck not checked']); return 0; }
        if (need.tons >= 9) { why.push(['ok', need.tons.toFixed(1) + ' T is a full truck — their strength']); return 15; }
        if (!p.partLoad) { why.push(['warn', 'Full loads only — this is ' + need.tons.toFixed(1) + ' T, a part load']); return -30; }
        // Nobody said they take part loads — the app made the card and the box defaulted to
        // yes. A green tick worth 25 points, off a blank, is how a full-truck-only lorry man
        // gets a 2 T enquiry and says so on the phone.
        if (unconfirmedCard(p)) { why.push(['neutral', 'Part load not recorded — worth a call before you send it']); return 0; }
        why.push(['ok', 'Takes part load — you only have ' + need.tons.toFixed(1) + ' T']);
        return 25;
    }

    function scoreTransporter(p, need, from) {
        var why = [], score = 0;
        var wrongRole = roleBlock(p, 'transport', why);
        var route = scoreRoute(p, matchCity(from) || from, matchCity(need.site) || need.site, why);
        score += route.pts + scoreLoadSize(p, need, why);
        if (p.vehicles) why.push(['neutral', 'Keeps ' + p.vehicles]);
        score += scoreHistoryAndNotes(p, why);
        var blocked = route.blocked || wrongRole;
        return { p: p, score: blocked ? -999 + score : score, why: why, blocked: blocked };
    }

    /**
     * A fabricator who also stocks GI, or a dealer who runs his own lorries, used to be
     * dropped before scoring — they never appeared at all, not even under "you can overrule
     * it", and nothing said why. They are ruled out on their role now, and shown with the
     * reason, so the owner decides.
     */
    function roleBlock(p, kind, why) {
        var right = kind === 'transport' ? p.role === 'transporter'
            : (p.role === 'dealer' || p.role === 'manufacturer');
        if (right) return false;
        why.push(['bad', 'They are a ' + roleLabel(p).toLowerCase() + ', not a '
            + (kind === 'transport' ? 'transporter' : 'pipe supplier')]);
        return true;
    }

    /**
     * Who is worth scoring. The right role always; the wrong role only when the card itself
     * says they could still help — pipe types that match, or a lorry route on file. Scoring
     * every card of every role would bury the list under firms with nothing to offer.
     */
    function worthScoring(p, kind, need) {
        var right = kind === 'transport' ? p.role === 'transporter'
            : (p.role === 'dealer' || p.role === 'manufacturer');
        if (right) return true;
        if (kind === 'transport') return (p.routes || []).length > 0;
        // A lorry firm is never a pipe supplier, whatever is ticked on its card.
        if (p.role === 'transporter') return false;
        var have = (p.types || []).map(lower);
        return (need.types || []).some(function (t) { return have.indexOf(lower(t)) !== -1; });
    }

    /** Rank the loaded directory for one need. kind: 'material' | 'transport'. */
    function rankFor(kind, need, from) {
        var pool = D.contacts.filter(function (p) { return worthScoring(p, kind, need); });
        return pool.map(function (p) {
            return kind === 'transport' ? scoreTransporter(p, need, from) : scoreSupplier(p, need);
        }).sort(function (a, b) { return b.score - a.score; });
    }

    // ── Data layer ────────────────────────────────────────────────────────────
    var D = { contacts: [], changes: [], pending: [], duplicates: [], loaded: false,
              loadError: '', saveError: '', saveWhat: [], failedAction: '', usageError: '' };

    var FIELD_LABEL = {
        company: 'The company name', role: 'What they are', roleOther: 'What they are',
        people: 'The contacts', city: 'The city', address: 'The address',
        branches: 'The branches', types: 'The pipe types', products: 'The product range',
        rules: 'The price rules', routes: 'The routes', moq: 'The minimum order',
        vehicles: 'The vehicles', notes: 'The notes', fromEnquiry: 'The check-me flag',
        partLoad: 'Part load',
    };
    function saveFailedWhat() {
        var named = (D.saveWhat || []).map(function (k) { return FIELD_LABEL[k]; }).filter(Boolean);
        return named.length ? named.join(' and ') : 'Your last edit';
    }

    function loadDirectory(then) {
        fetch(apiBase() + '/contacts')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                D.contacts = keepOpenEdits(D.contacts, d.contacts || []); D.changes = d.changes || [];
                D.pending = keepOpenReview(D.pending, d.pending || []);
                D.duplicates = d.duplicates || [];
                D.loaded = true; D.loadError = '';
            })
            .catch(function (e) {
                // A failed load must look like a failure — never like an empty directory.
                D.loaded = false; D.loadError = 'Could not load the directory (' + e.message + ').';
            })
            .then(function () { paintWaitingBadge(); then && then(); });
    }

    /**
     * `then` runs on success only. `always` runs either way, and is where an in-flight lock
     * must be released: a lock cleared only inside `then` stays set forever the moment a
     * request fails, which left the Import button disabled and reading "Importing…" until
     * the page was reloaded — a failure that looked like a hang.
     */
    /**
     * A correction is saved when the field is left, and a tab click leaves the field and
     * reloads in the same breath — so the reload can beat its own save home. The card being
     * reviewed right now keeps what is on screen; everything else takes the stored copy.
     */
    /**
     * A re-read must not throw away what is being typed. ONLY the boxes actually changed are
     * carried across onto the fresh server copy — everything else comes from the server, so a
     * colleague's edit to another box on the same card still lands. Carrying the whole old
     * object across is how a stale copy overwrites a fresh one.
     */
    function keepOpenEdits(old, fresh) {
        var id = S.openId;
        if (!id || !isDirty(id)) return fresh;
        var mine = (old || []).filter(function (x) { return x.id === id; })[0];
        if (!mine) return fresh;
        var fields = dirtyFields(id);
        return (fresh || []).map(function (x) {
            if (x.id !== id) return x;
            var merged = Object.assign({}, x);
            fields.forEach(function (f) { merged[f] = mine[f]; });
            return merged;
        });
    }

    function keepOpenReview(old, fresh) {
        if (!S.openPending) return fresh;
        var mine = (old || []).filter(function (x) { return x.id === S.openPending; })[0];
        if (!mine || !mine.preview) return fresh;
        return (fresh || []).map(function (x) {
            return x.id === S.openPending ? Object.assign({}, x, { preview: mine.preview }) : x;
        });
    }

    /**
     * `what` is the field list THIS request is writing, and it is only ever read on the
     * failure of THIS request. It used to be one shared box set by savePartner and printed
     * on every failure there was — so discarding a queued firm, or an approve that fell
     * over, announced "The company name was NOT saved" about a company name that had gone
     * in perfectly well an hour earlier.
     */
    function postJson(path, body, then, always, what) {
        var failed = false;
        return fetch(apiBase() + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
                return d;
            });
        }).then(function (d) { D.saveError = ''; D.saveWhat = []; D.failedAction = ''; then && then(d); return d; })
            .catch(function (e) {
                D.saveError = e.message;
                // `what` is a LIST of boxes for a field edit, or the NAME of an action for
                // everything else. One banner served both, and told the owner "the box still
                // shows what you typed" after a failed delete, import, approve or discard.
                D.saveWhat = Array.isArray(what) ? what : [];
                D.failedAction = typeof what === 'string' ? what : '';
                failed = true;
            })
            .then(function (d) { if (always) always(); if (always || failed) render(); return d; });
    }

    // `fields` narrows the write to what was actually touched, so a second tab editing a
    // different part of the same firm is not overwritten by this tab's older copy.
    function savePartner(p, fields) {
        // Passed as `what` too, so a failure can name what did not go in — and only this
        // request's failure can name it.
        return postJson('/contacts/save', { partner: p, fields: fields || null }, null, null, fields || []);
    }

    /**
     * Save, and an honest answer about whether anything is stored.
     *
     * Nothing on a directory card is written until this is pressed, so the screen has to say
     * plainly when it is holding something the directory does not have. Silence there is how
     * an edit gets closed and lost.
     */
    function saveBarHtml(p) {
        var busy = S.busy['save' + p.id];
        if (!isDirty(p.id)) {
            return S.saveNote === 'Saved.'
                ? '<span class="pd-tiny" style="color:#2E7D32;">Saved.</span>'
                : '<span class="pd-tiny">No unsaved changes.</span>';
        }
        return '<button class="pd-prim" data-pd-save="' + esc(p.id) + '"' + (busy ? ' disabled' : '') + '>'
            + (busy ? 'Saving…' : 'Save') + '</button>'
            + '<span class="pd-tiny" style="color:#8C2F2F;margin-left:8px;">'
            + dirtyFields(p.id).length + ' change' + (dirtyFields(p.id).length === 1 ? '' : 's')
            + ' not saved yet</span>'
            + (S.saveNote && S.saveNote !== 'Saved.' ? '<span class="pd-tiny" style="margin-left:8px;">' + esc(S.saveNote) + '</span>' : '');
    }

    /**
     * Remember that a directory card has been edited, and which boxes were touched, so Save
     * writes only those — a whole-object write is how a second tab's work gets replaced.
     */
    function markDirty(p, fields) {
        var d = S.dirty[p.id] || (S.dirty[p.id] = {});
        (fields || []).forEach(function (f) { d[f] = true; });
        render();
    }

    /**
     * True when it is safe to leave the open card. With unsaved boxes on it, ask first —
     * silently dropping what somebody typed is the fault this whole screen exists to avoid.
     *
     * The question is asked ON THE PAGE, never with window.confirm. A browser confirm() is
     * answered "no" without showing anything in some views — and the card then simply refused
     * to close, with nothing on screen saying why. Reported live: once opened, a card would
     * not close. Same rule the Delete question already follows.
     */
    function leaveCardOk(then) {
        if (!S.openId || !isDirty(S.openId)) return true;
        S.confirmLeave = S.openId;      // the popup does the asking, and owns the answer
        S.leaveThen = then || null;     // ...and finishes what they were trying to do
        render();
        return false;
    }

    /**
     * Plain names for the boxes, so the question names what is actually at stake.
     * FIELD_LABEL is shared with the save-failure banner, where the name STARTS the sentence
     * ("The city was NOT saved"). Here it sits mid-sentence, so the first letter comes down.
     */
    function changedBoxes(id) {
        return dirtyFields(id).map(function (f) {
            var name = FIELD_LABEL[f] || f;
            return name.charAt(0).toLowerCase() + name.slice(1);
        });
    }

    /**
     * The card exactly as the directory has it, taken the moment it is opened and before a
     * single key is pressed. "Close without saving" has to have something to put back: the
     * edits are written straight onto the card object, so forgetting the dirty flags alone
     * left every discarded character still sitting there.
     */
    function holdCleanCopy(p) {
        if (!p || S.clean[p.id]) return;
        S.clean[p.id] = JSON.parse(JSON.stringify(p));
    }

    /** Put the card back the way it was, throwing the typing away for real. */
    function restoreCleanCopy(id) {
        var was = S.clean[id];
        if (!was) return;
        var at = -1;
        D.contacts.forEach(function (c, i) { if (c.id === id) at = i; });
        if (at !== -1) D.contacts[at] = was;
        delete S.clean[id];
    }

    /**
     * Close a card, whichever way the question was answered — and then do whatever they were
     * trying to do when the question interrupted them (switch tab, open another card). Being
     * dropped back on a blank directory having forgotten the click is its own small fault.
     */
    function closeCardNow(discard) {
        var id = S.confirmLeave;
        if (discard) restoreCleanCopy(id);      // "Close without saving" means it
        delete S.dirty[id];
        delete S.clean[id];
        S.confirmLeave = ''; S.openId = null; S.saveNote = '';
        var then = S.leaveThen; S.leaveThen = null;
        if (then) then();
        render();
    }

    // Three answers, because "leave without saving?" has two right ones and the owner should
    // not have to close, reopen and retype to pick the other. Save-and-close is the default.
    function leavePopupHtml() {
        var p = S.confirmLeave ? byId(S.confirmLeave) : null;
        if (!p) return '';
        var boxes = changedBoxes(S.confirmLeave);
        var busy = S.busy['save' + p.id];
        return '<div class="pd-modal" data-pd-leavecancel="backdrop">'
            + '<div class="pd-modal-box" role="dialog" aria-modal="true">'
            + '<div class="pd-sec" style="margin-top:0;">' + boxes.length + ' change'
            + (boxes.length === 1 ? '' : 's') + ' not saved</div>'
            + '<p class="pd-muted">You changed ' + esc(boxes.join(', ')) + ' on <b>'
            + esc(str(p.company) || allEmails(p)[0] || 'this card') + '</b> and have not pressed Save.</p>'
            + (S.saveNote && S.saveNote !== 'Saved.'
                ? '<p class="pd-tiny" style="color:#8C2F2F;margin-top:7px;">' + esc(S.saveNote) + '</p>' : '')
            + (D.saveError ? '<p class="pd-tiny" style="color:#8C2F2F;margin-top:7px;">It did not save: '
                + esc(D.saveError) + ' — the card stays open, so nothing is lost.</p>' : '')
            + '<div class="pd-row" style="margin-top:12px;"><span class="pd-sp"></span>'
            + '<button data-pd-leavecancel="1"' + (busy ? ' disabled' : '') + '>Keep editing</button>'
            + '<button class="pd-danger" data-pd-leavedrop="1"' + (busy ? ' disabled' : '') + '>Close without saving</button>'
            + '<button class="pd-prim" data-pd-leavesave="1"' + (busy ? ' disabled' : '') + '>'
            + (busy ? 'Saving…' : 'Save and close') + '</button></div></div></div>';
    }

    function dirtyFields(id) { return Object.keys(S.dirty[id] || {}); }
    function isDirty(id) { return dirtyFields(id).length > 0; }

    /** The one write path for a card you own. Nothing reaches the directory without it. */
    function saveOpenCard(id) {
        var p = byId(id);
        if (!p || !isDirty(id) || S.busy['save' + id]) return Promise.resolve(false);
        // A card with nothing on it is not worth a row. Reachable by emptying a real card:
        // clear the company name and the contact, and what is left is not worth storing.
        if (isBlankCard(p)) { S.saveNote = 'Type a name, a person or a number first — there is nothing to save yet.'; render(); return Promise.resolve(false); }
        S.busy['save' + id] = true; S.saveNote = ''; render();
        // What this request is actually carrying, and the value of each box as it goes. A
        // save takes a moment, and anything typed DURING it was being marked saved without
        // ever being sent — with the bar then reading "Saved." Only boxes that still hold
        // what was sent are cleared.
        var sending = dirtyFields(id);
        var sent = {};
        sending.forEach(function (f) { sent[f] = JSON.stringify(p[f]); });
        // Resolves TRUE only when the directory really has it. "Save and close" must not
        // close on a save that failed — that is how the typing would vanish for good.
        return savePartner(p, sending).then(function () {
            delete S.busy['save' + id];
            var ok = !D.saveError;
            if (ok) {
                var still = S.dirty[id] || {};
                sending.forEach(function (f) {
                    if (JSON.stringify(p[f]) === sent[f]) delete still[f];
                });
                if (!isDirty(id)) {
                    delete S.dirty[id];
                    delete S.clean[id];          // what is on the card IS the directory now
                    S.saveNote = 'Saved.';
                } else {
                    S.saveNote = 'Saved — but you have changed more since. Press Save again.';
                }
            }
            render();
            return ok;
        });
    }

    /** Keep a reviewed card's corrections on its queue item, so a reload cannot lose them. */
    function savePendingPreview(p) {
        var item = D.pending.filter(function (x) { return x.preview && x.preview.id === p.id; })[0];
        if (!item) return;
        return postJson('/contacts/pending/preview', { id: item.id, preview: p },
                        null, null, 'Saving your corrections');
    }

    // ── State for the tool page ───────────────────────────────────────────────
    var S = { tab: 'dir', filter: 'all', openId: null, openPending: null, openChange: null,
              find: { text: '', state: 'idle', need: null, note: '' }, busy: {}, add: freshAdd(),
              confirmDelete: '',     // the card whose "are you sure?" is on screen
              dirty: {}, clean: {}, saveNote: '', confirmLeave: '', leaveThen: null, ask: null };   // directory cards edited but not yet saved

    function byId(id) {
        var p = D.contacts.filter(function (x) { return x.id === id; })[0];
        if (p) return p;
        var pi = D.pending.filter(function (x) { return x.preview && x.preview.id === id; })[0];
        return pi ? pi.preview : null;
    }

    // ── Rendering: the tool page ──────────────────────────────────────────────

    /**
     * Keep the cursor where the person put it across a redraw.
     *
     * Leaving the Company box saves and redraws the card, and by then Tab has already moved
     * focus to the NEXT box — which the redraw then threw away, so the words typed next went
     * nowhere and it felt like the keyboard had stopped. Whatever holds focus when the redraw
     * starts gets it back afterwards, caret and all.
     */
    /**
     * The key is built from EVERY data-pd-… attribute the element carries, not a hand-written
     * list of the nine the boxes happen to use. The list left every button — Approve, Discard,
     * Delete, Open card, the tabs, the chips — keying to the same empty string, so a redraw
     * that changed how many buttons there are handed focus to whichever button now sat in the
     * old one's place. Pressing Space on a card then hit Discard.
     */
    function focusKey(el) {
        var out = [el.tagName || '', el.getAttribute('id') || ''];
        var attrs = el.attributes || [];
        var pd = [];
        for (var i = 0; i < attrs.length; i++) {
            if (String(attrs[i].name).indexOf('data-pd-') === 0) pd.push(attrs[i].name + '=' + attrs[i].value);
        }
        return out.concat(pd.sort()).join('|');
    }

    var FOCUSABLE = 'input,select,textarea,button,a';

    function focusKeeper(app) {
        var el = document.activeElement;
        if (!el || !el.getAttribute || !app.contains || !app.contains(el)) return function () {};
        var before = [].slice.call(app.querySelectorAll(FOCUSABLE));
        var key = focusKey(el), at = before.indexOf(el);
        var start = el.selectionStart, end = el.selectionEnd;
        return function () {
            var after = [].slice.call(app.querySelectorAll(FOCUSABLE));
            var same = after.filter(function (x) { return focusKey(x) === key; });
            // The key alone is ambiguous for plain buttons, so the old position breaks the tie.
            var target = same.length === 1 ? same[0]
                : (after[at] && focusKey(after[at]) === key ? after[at] : same[0]);
            if (!target) return;
            target.focus();
            try { if (start != null) target.setSelectionRange(start, end); } catch (e) { /* not a text box */ }
        };
    }

    function render() {
        var app = $('partnerDirectoryApp');
        if (!app) return;
        var restoreFocus = focusKeeper(app);
        var waiting = D.pending.length;
        app.innerHTML = '<h1>📇 Partner Directory</h1>'
            + '<div class="pd-tabs">'
            + '<button class="pd-tab' + (S.tab === 'dir' ? ' on' : '') + '" data-pd-tab="dir">Directory</button>'
            + '<button class="pd-tab' + (S.tab === 'add' ? ' on' : '') + '" data-pd-tab="add">Add</button>'
            + '<button class="pd-tab' + (S.tab === 'changes' ? ' on' : '') + '" data-pd-tab="changes">Recent changes'
            + (waiting ? ' <span class="pd-pill pd-pill-warn">' + waiting + '</span>' : '') + '</button></div>'
            // Named and pinned to the top of the page. A bare "your last edit is NOT stored"
            // halfway up a long card said nothing about WHICH edit, and scrolled off screen.
            + (!D.saveError ? ''
                : D.failedAction
                    ? '<div class="pd-error pd-error-save"><b>' + esc(D.failedAction) + ' did not work.</b> '
                        + esc(D.saveError) + ' — nothing on your screen has been lost. Check the list before '
                        + 'trying again, in case it went through after all.</div>'
                    : '<div class="pd-error pd-error-save"><b>' + esc(saveFailedWhat()) + ' was NOT saved.</b> '
                        + esc(D.saveError) + ' — the box still shows what you typed, but the directory does not have it. '
                        + 'Change the same box again to try once more.</div>')
            + (D.usageError ? '<div class="pd-error">Some of the "who was asked" records did not reach the app ('
                + esc(D.usageError) + '). Nothing you typed is lost — but the enquiry counts on a few cards may be low.</div>' : '')
            + (D.loadError ? '<div class="pd-error">' + esc(D.loadError) + ' <button data-pd-reload="1">Try again</button></div>'
                : !D.loaded ? '<p class="pd-muted" style="padding:20px;text-align:center;">Loading…</p>'
                    : S.tab === 'dir' ? dirView() : S.tab === 'add' ? addView() : changesView())
            + deletePopupHtml() + leavePopupHtml() + askPopupHtml();
        bind(app);
        restoreFocus();
    }

    /**
     * "Are you sure?" for deleting a partner, on the page rather than in a browser dialog.
     *
     * It used to be window.confirm. A browser set to block dialogs swallows that silently, so
     * pressing Delete did nothing whatever and the button looked broken — which is exactly
     * what was reported. This one cannot be suppressed, and it says what is actually at stake
     * instead of asking a bare question.
     */
    /**
     * Ask on the page. Never window.confirm.
     *
     * A browser confirm() returns FALSE in this app in 5ms without ever appearing, so every
     * button guarded by one did nothing at all and said nothing about it. That is how Delete
     * "stopped working" and how an open card refused to close — both reported live by the
     * owner. Three more were guarded the same way: Undo, Discard, and the IS 1239 size-table
     * button. This is the one way a question gets asked from here on.
     */
    function askOnPage(q) {
        S.ask = { title: q.title, lines: q.lines || [], okLabel: q.okLabel || 'Yes',
                  danger: q.danger !== false, run: q.run, busy: false,
                  ask: q.ask || '', placeholder: q.placeholder || '' };
        render();
    }

    function askPopupHtml() {
        var a = S.ask;
        if (!a) return '';
        return '<div class="pd-modal" data-pd-askcancel="backdrop">'
            + '<div class="pd-modal-box" role="dialog" aria-modal="true">'
            + '<div class="pd-sec" style="margin-top:0;">' + esc(a.title) + '</div>'
            + a.lines.map(function (t) { return '<p class="pd-muted" style="margin-top:6px;">' + esc(t) + '</p>'; }).join('')
            + (a.ask
                ? '<div class="pd-fld" style="margin-top:9px;"><label>' + esc(a.ask) + '</label>'
                    + '<input id="pdAskIn" placeholder="' + esc(a.placeholder) + '" autofocus></div>'
                : '')
            + '<div class="pd-row" style="margin-top:12px;"><span class="pd-sp"></span>'
            + '<button data-pd-askcancel="1"' + (a.busy ? ' disabled' : '') + '>Cancel</button>'
            + '<button class="' + (a.danger ? 'pd-danger' : 'pd-prim') + '" data-pd-askok="1"'
            + (a.busy ? ' disabled' : '') + '>' + esc(a.busy ? 'Working…' : a.okLabel) + '</button>'
            + '</div></div></div>';
    }

    function deletePopupHtml() {
        var p = S.confirmDelete ? byId(S.confirmDelete) : null;
        if (!p) return '';
        var name = str(p.company) || allEmails(p)[0] || 'this partner';
        return '<div class="pd-modal" data-pd-delcancel="backdrop">'
            + '<div class="pd-modal-box" role="dialog" aria-modal="true">'
            + '<div class="pd-sec" style="margin-top:0;">Delete ' + esc(name) + '?</div>'
            + '<p class="pd-muted">' + esc(deleteLoses(p)) + '</p>'
            + '<p class="pd-tiny" style="margin-top:7px;">It goes into <b>Recent changes</b>, so you can put it '
            + 'back with Undo if this was a mistake.</p>'
            + '<div class="pd-row" style="margin-top:12px;"><span class="pd-sp"></span>'
            + '<button data-pd-delcancel="1"' + (S.busy[S.confirmDelete] ? ' disabled' : '') + '>Cancel</button>'
            + '<button class="pd-danger" data-pd-delok="1"' + (S.busy[S.confirmDelete] ? ' disabled' : '') + '>'
            + (S.busy[S.confirmDelete] ? 'Deleting…' : 'Delete') + '</button></div></div></div>';
    }

    /** What the card is carrying, so the question is about something real. */
    function deleteLoses(p) {
        var bits = [];
        var named = people(p).filter(function (c) { return str(c.name) || (c.emails || []).length; });
        if (named.length) bits.push(named.length + ' contact' + (named.length === 1 ? '' : 's'));
        if ((p.products || []).length) bits.push((p.products || []).length + ' product' + ((p.products || []).length === 1 ? '' : 's'));
        if ((p.routes || []).length) bits.push((p.routes || []).length + ' route' + ((p.routes || []).length === 1 ? '' : 's'));
        if ((p.notes || []).length) bits.push((p.notes || []).length + ' note' + ((p.notes || []).length === 1 ? '' : 's'));
        var asked = Number(p.enq) || 0;
        if (asked) bits.push('asked ' + asked + ' time' + (asked === 1 ? '' : 's'));
        return bits.length
            ? 'This card holds ' + bits.join(', ') + '. Deleting takes all of it out of the directory.'
            : 'There is nothing on this card yet.';
    }


    function dirView() {
        var counts = { all: D.contacts.length };
        D.contacts.forEach(function (p) { counts[p.role] = (counts[p.role] || 0) + 1; });
        // A chip for the guessed cards, so there is a count and a way to work through them.
        // 22 landed at once with no count, no filter and no way to say "done".
        var chips = [['all', 'All']].concat(ROLE_ORDER.map(function (r) { return [r, ROLE_LABEL[r] + 's']; }))
            .map(function (c) {
                return '<button class="pd-chip' + (S.filter === c[0] ? ' on' : '') + '" data-pd-filter="' + c[0] + '">'
                    + esc(c[1]) + ' ' + (counts[c[0]] || 0) + '</button>';
            }).join('');
        return duplicateWarningHtml()
            + finderBlock()
            + '<div class="pd-filters">' + chips + '<span class="pd-sp"></span>'
            + (D.contacts.length ? importButtonHtml() : '') + '</div>'
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
            // The card you are working in never disappears from under you. Ticking off the
            // last "check me" card while it was open used to close the whole list instead.
            if (S.openId === p.id) return true;
            else if (S.filter !== 'all' && p.role !== S.filter) return false;
            if (!S.find.text || S.find.state !== 'name') return true;
            var hay = lower(p.company + ' ' + p.city + ' ' + branchNames(p).join(' ') + ' ' + (p.types || []).join(' ')
                + ' ' + people(p).map(function (x) { return x.name; }).join(' ') + ' ' + allEmails(p).join(' ')
                + ' ' + (p.roleOther || '') + ' ' + (p.products || []).map(function (x) { return x.p + ' ' + x.spec; }).join(' ')
                + ' ' + (p.notes || []).map(function (n) { return n.t; }).join(' '));
            return hay.indexOf(lower(S.find.text)) !== -1;
        });
        // An empty directory is not a failed search, and the answer is never "nobody fits".
        // Pasting an enquiry into the finder is the natural first thing to do on a fresh
        // directory, and it used to answer "Nobody in your directory fits this one" AND take
        // the Import button off the page with it.
        if (!D.contacts.length) return emptyStateHtml();
        if (S.find.state === 'done' && S.find.need && !S.find.need.empty) return finderResults();
        // "Nobody matches that" on a directory that is simply empty reads like a failed
        // search. Say which it is, and give the way out.
        if (!list.length) return '<p class="pd-muted pd-empty">Nobody matches that.</p>';
        return list.map(function (p) { return S.openId === p.id ? editCard(p) : rowCard(p); }).join('');
    }

    function emptyStateHtml() {
        if (S.imported && !S.imported.queued) {
            return '<div class="pd-empty"><p class="pd-muted">'
                + (S.imported.alreadyQueued
                    ? 'Those are already waiting for you under <b>Recent changes</b>.'
                    : 'Nothing to bring in — the app has no remembered addresses yet.') + '</p>'
                + '<p class="pd-tiny" style="margin-top:6px;">Type one in on the <b>Add</b> tab, or tag a supplier’s email in Gmail with the Add-to-Directory label.</p></div>';
        }
        return '<div class="pd-empty"><p class="pd-muted"><b>Your directory is empty.</b></p>'
            + '<p class="pd-tiny" style="margin:6px 0 10px;">The app has been quietly remembering every address you have sent an enquiry to. '
            + 'Bring those in and they wait under <b>Recent changes</b> for you to approve, one firm at a time — '
            + 'nothing is added until you say so.</p>'
            + importButtonHtml()
            + '<p class="pd-tiny" style="margin-top:8px;">Or type one in on the <b>Add</b> tab — a name, a number, whatever you have.</p></div>';
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
            // Nobody typed this on a card the app made itself — printing "Takes part load"
            // off a default is a fact stated that nobody ever gave.
            bits.push(unconfirmedCard(p) && p.partLoad ? 'Part load not recorded'
                : (p.partLoad ? 'Takes part load' : 'Full load only'));
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
            + '<p class="pd-tiny' + (stale ? ' pd-stale' : '') + '">Asked ' + (p.enq || 0) + ' times · ' + repliesLine(p) + ' · last dealt ' + ago(p.last)
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
        if (f.note) h += '<p class="pd-muted" style="margin-top:9px;">' + esc(f.note) + '</p>';
        if (f.state === 'name') {
            h += '<p class="pd-muted" style="margin-top:9px;">Looking for <b>' + esc(f.text) + '</b> by name — the list below is what matches.</p>';
        }
        return h + '</div>';
    }

    function finderResults() {
        var need = S.find.need;
        var h = '<div class="pd-read">' + readBack(need) + '</div>';
        if (need.types.length) {
            var sup = rankFor('material', need);
            h += '<div class="pd-sec">Send it to</div>'
                + rankListHtml(sup.filter(function (r) { return !r.blocked; }), need, { kind: 'material' })
                + ruledOutHtml(sup.filter(function (r) { return r.blocked; }));
        }
        if (need.freight && need.site) {
            var from = need.pickup || HOME;
            var tra = rankFor('transport', need, from);
            h += '<div class="pd-sec">For the transport — ' + esc(from) + ' → ' + esc(need.site) + '</div>'
                + rankListHtml(tra.filter(function (r) { return !r.blocked; }), need, { kind: 'transport' })
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
        // Three different things, and they used to read as one. "No place named" told the
        // owner not to bother checking, over an enquiry that named Tirupur plainly.
        tags += need.siteUnknown
            ? '<span class="pd-tag">Deliver to: <b>' + esc(need.siteUnknown) + '</b>'
                + ' — not a town I can measure, so distance was left out of the scoring</span>'
            : '<span class="pd-tag">Deliver to: <b>' + esc(need.site) + '</b>'
                + (need.siteAssumed ? ' — <b>assumed</b>, no place named' : '') + '</span>';
        return '<p class="pd-tiny" style="margin-bottom:6px;">What was understood — correct the text and ask again if this is wrong:</p>' + tags;
    }

    // The in-quote panel has always offered two ways out of "nobody fits" — search the web,
    // or add the firm. The Directory's own finder used to end on a bare sentence.
    function rankListHtml(rows, need, opts) {
        if (!rows.length) return deadEndHtml(need, opts);
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
            + (p.fromEnquiry ? '<span class="pd-pill pd-pill-warn">From an enquiry — check me</span>' : '')
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
                ? '<div class="pd-row" style="margin-top:12px;">' + saveBarHtml(p) + '<span class="pd-sp"></span>'
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
        // Typed OR picked. It used to be a fixed dropdown of 24 towns, so a godown in Erode,
        // Tirupur or Pondicherry simply could not be recorded.
        var cityList = '<datalist id="pdKnownCities">'
            + known.map(function (c) { return '<option value="' + esc(c) + '"></option>'; }).join('') + '</datalist>';
        return '<div class="pd-sec">Where they are<span class="pd-sp"></span>'
            + '<button class="pd-addline" data-pd-addbranch="1">+ Add a branch</button></div>'
            + cityList
            + '<div class="pd-grid2">' + fld(p, 'City (head office)', 'city', p.city)
            + fld(p, 'Head office address', 'address', p.address, 'Street, area, pin') + '</div>'
            + (p.branches || []).map(function (b, i) {
                return '<div class="pd-branch"><div class="pd-branch-top">'
                    + '<input data-pd-br="' + i + '" data-pd-k="city" list="pdKnownCities" value="' + esc(b.city || '') + '" placeholder="City — pick one or type it">'
                    + '<input data-pd-br="' + i + '" data-pd-k="area" value="' + esc(b.area || '') + '" placeholder="Town or area — e.g. Ambattur">'
                    + '<button class="pd-del" data-pd-delbranch="' + i + '">✕</button></div>'
                    + '<input data-pd-br="' + i + '" data-pd-k="address" value="' + esc(b.address || '') + '" placeholder="Full address (optional)" style="margin-top:6px;"></div>';
            }).join('')
            + '<p class="pd-tiny">The nearest branch to a delivery point is what the ranking measures — the town and address are for you and the lorry. '
            + 'Any town can be typed; distance is only worked out for the ' + known.length + ' the app knows, and a town outside them simply is not scored.</p>';
    }

    /**
     * The six standard families plus anything the owner has typed in on any card. A custom
     * type used to be pushed onto a list that lives only in this page's memory, so it was
     * gone from the dropdown after a reload and had to be typed again for the next firm.
     */
    function offerableTypes() {
        var out = PIPE_TYPES.slice();
        D.contacts.forEach(function (c) {
            (c.types || []).forEach(function (t) {
                if (str(t) && !out.some(function (k) { return lower(k) === lower(t); })) out.push(str(t));
            });
        });
        return out;
    }

    function supplierBlock(p) {
        var have = (p.types || []).map(lower);
        var canAdd = offerableTypes().filter(function (t) { return have.indexOf(lower(t)) === -1; });
        return '<div class="pd-sec">What they supply</div>'
            + '<div class="pd-grid2"><div class="pd-fld"><label>Pipe types</label>'
            + '<div style="display:flex;gap:6px;"><select id="pdTypePick" style="flex:1;"><option value="">Pick a type…</option>'
            + canAdd.map(function (t) { return '<option>' + t + '</option>'; }).join('')
            + '<option value="__other">＋ Add another…</option></select>'
            + '<button data-pd-addtype="1">Add</button></div></div>'
            + fld(p, 'Overall MOQ (tonnes)', 'moq', p.moq) + '</div>'
            + ((p.types || []).length ? '<div style="margin-bottom:8px;">' + (p.types || []).map(function (t, i) {
                return '<span class="pd-tag">' + esc(t) + ' <span class="pd-x" data-pd-deltype="' + i + '">✕</span></span>';
            }).join('') + '</div>'
                // They ARE still suggested, just without the 40 points a matching type is
                // worth — saying otherwise sent the owner hunting for a card that was fine.
                : '<p class="pd-tiny" style="margin-bottom:8px;">No types set — they are still suggested, but they cannot win the points a matching pipe type is worth.</p>')
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
            // The ranking matches on the product name and specification only — it has never
            // read these rows. Saying they decided the match had the owner filling size
            // tables across every firm for nothing.
            }).join('') : '<p class="pd-tiny" style="padding:4px 0;">No sizes yet. These are for your reference — the ranking matches on the product and specification, not on this table.</p>')
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
            + ro('Replies', (p.rep || 0) ? replyRate(p) + '%' : 'none recorded')
            + ro('Last dealt with', ago(p.last)) + ro('Last edited', ago(p.checked)) + '</div>'
            + '<p class="pd-tiny">You never type these. "Regular" means asked 5+ times and dealt with in the last 4 months. '
            + 'Replies have only been counted since the app started watching for them, so "none recorded" is not the same as "they never answer". '
            + '"Last edited" moves on its own.</p>';
    }
    function ro(label, v) { return '<div class="pd-fld"><label>' + esc(label) + '</label><div class="pd-ro">' + esc(v) + '</div></div>'; }

    // ── The Add tab: one box in, a popup you must approve, then it is stored ──
    // Everything here is for partners found OUTSIDE the Gmail label — a brochure handed
    // over at a shop, a rate list, a visiting card, or just what someone said on the phone.
    // The server reads it and proposes; nothing reaches the directory without the popup.

    var MAX_ADD_FILE = 3 * 1024 * 1024;   // beyond this the request is refused server-side

    function freshAdd() {
        return { text: '', fileName: '', fileB64: '', reading: false, applying: false,
                 error: '', applyError: '', notice: '', draft: null,
                 pickedId: '', dropped: [], newName: '', answers: {} };  // dropped = unticked
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
            + addAsNewHtml(d)
            + '<p class="pd-tiny" style="margin-top:9px;">Or answer in the box above and press <b>Read it</b> again.</p></div>';
    }

    /**
     * The other honest answer to "which firm is this?": none of them, it is new.
     *
     * The reading is already worked out — the draft carries what a brand-new card would look
     * like — so this needs no second read, only the name. Without this the question was a
     * dead end whenever the firm genuinely was not in the directory yet.
     */
    function addAsNewHtml(d) {
        if (!(d.changes || []).length) return '';
        return '<p class="pd-tiny" style="margin:11px 0 5px;">Or it is a firm you have not added yet:</p>'
            + '<div class="pd-row"><input id="pdAddNewName" placeholder="Their name — e.g. MSL Tubes" '
            + 'value="' + esc(S.add.newName || str(d.after && d.after.company)) + '" style="max-width:260px;">'
            + '<button class="pd-prim" data-pd-addasnew="1">Add as a new firm</button></div>';
    }

    // Naming the firm turns a guess into a settled question — the next read is answering it.
    function addCandidatesHtml(list) {
        if (!(list || []).length) return '';
        return '<p class="pd-tiny" style="margin:9px 0 5px;">If it is one of these, press it and it is read again for that firm:</p>'
            + list.map(function (c) {
                return '<button data-pd-addpick="' + esc(c.id) + '" style="margin:0 5px 5px 0;">'
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
            + addChangePickerHtml(d)
            + (S.add.applyError ? '<div class="pd-error">' + esc(S.add.applyError) + '</div>' : '')
            + '<div class="pd-row" style="margin-top:12px;"><span class="pd-sp"></span>'
            + '<button data-pd-addcancel="1"' + (S.add.applying ? ' disabled' : '') + '>Cancel</button>'
            + '<button class="pd-prim" data-pd-addapply="1"'
            + (S.add.applying || !keptAddSteps().length ? ' disabled' : '') + '>'
            + addApplyLabel(d) + '</button></div></div></div>';
    }

    /**
     * One tick-box per change, all ticked to begin with. A reading often carries several
     * things at once and only some of them are right — taking the lot or none of it means
     * cancelling the whole read to be rid of one wrong line.
     */
    function addChangePickerHtml(d) {
        var changes = d.changes || [];
        if (!changes.length) return diffHtml({ lines: d.lines });
        // One change needs no tick-box — but it may still need its question answered.
        if (changes.length === 1) return diffHtml({ lines: changes[0].lines }) + askHtml(changes[0]);
        return '<p class="pd-tiny" style="margin:8px 0 5px;">Untick anything you do not want:</p>'
            + changes.map(function (c) {
                var on = S.add.dropped.indexOf(c.id) === -1;
                return '<label class="pd-pickrow"><input type="checkbox"' + (on ? ' checked' : '')
                    + ' data-pd-addkeep="' + esc(c.id) + '"><span>' + diffHtml({ lines: c.lines })
                    + askHtml(c) + '</span></label>';
            }).join('');
    }

    // "24 inch" tells you nothing about a firm that deals in GI, ERW and Seamless. Ask here,
    // where the change is, rather than storing a size nobody can act on.
    function askHtml(c) {
        if (!c.ask) return '';
        var chosen = S.add.answers[c.id];
        if (chosen) {
            return '<p class="pd-tiny" style="margin-top:4px;">in <b>' + esc(chosen) + '</b> '
                + '<button class="pd-linkish" data-pd-addunask="' + esc(c.id) + '">change</button></p>';
        }
        return '<p class="pd-tiny" style="margin-top:4px;">' + esc(c.ask.question) + ' '
            + c.ask.options.map(function (o) {
                return '<button data-pd-addask="' + esc(c.id) + '|' + esc(o) + '" '
                    + 'style="margin:0 4px 4px 0;">' + esc(o) + '</button>';
            }).join('') + '</p>';
    }

    function keptAddSteps() {
        var d = S.add.draft;
        if (!d || !(d.changes || []).length) return d && d.after ? [{}] : [];
        return d.changes.filter(function (c) { return S.add.dropped.indexOf(c.id) === -1; })
            .map(function (c) {
                var answer = S.add.answers[c.id];
                if (!answer || !c.ask) return c.step;
                // Answered questions ride on the step itself, so what is written is what the
                // owner settled — not the blank the model left.
                var step = JSON.parse(JSON.stringify(c.step));
                step.product[c.ask.key] = answer;
                return step;
            });
    }

    function addApplyLabel(d) {
        var kept = keptAddSteps().length, all = (d.changes || []).length;
        if (S.add.applying) return 'Adding…';
        if (!kept) return 'Nothing ticked';
        return (all > 1 && kept < all) ? 'Apply ' + kept + ' of ' + all : 'Apply';
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
        a.dropped = []; a.newName = ''; a.answers = {};  // a new reading, all ticked again
        render();
        var body = { text: str(a.text) };
        if (a.fileB64) { body.fileBase64 = a.fileB64; body.fileName = a.fileName; }
        if (a.pickedId) body.matchId = a.pickedId;
        postJson('/contacts/add-draft', body, function (d) { S.add.draft = d; }, function () {
            S.add.reading = false;
            S.add.pickedId = '';        // answered; a later read starts from the question again
            // This tab's failures belong beside its own box — the directory's banner says
            // "your last edit is NOT stored", and nothing was being edited here.
            S.add.error = D.saveError; D.saveError = '';
        });
    }

    function applyAdd() {
        var d = S.add.draft;
        if (S.add.applying || !d) return;   // one Apply is one write, however many times it is pressed
        var steps = keptAddSteps();
        if (!steps.length) return;          // nothing ticked is nothing to do
        S.add.applying = true; S.add.applyError = ''; render();
        // The ticked steps, not the whole card: the server rebuilds them onto the card as it
        // stands now, so an untick really means "do not write that".
        postJson('/contacts/add-apply', {
            after: d.after, matchId: d.matchId || '',
            steps: (d.changes || []).length ? steps : undefined, source: d.source || '',
        }, addApplied, function () {
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
        var newName = app.querySelector('#pdAddNewName');
        if (newName) newName.oninput = function () { S.add.newName = this.value; };
        on(app, '[data-pd-addasnew]', function () {
            var d = S.add.draft;
            var name = str(S.add.newName) || str(d && d.after && d.after.company);
            if (!name) { S.add.error = 'Type their name first, so the card has one.'; render(); return; }
            // The reading already stands as a NEW card — the question was only which firm it
            // belonged to. Answer "a new one", give it a name, and the popup opens on that.
            S.add.draft = {
                mode: 'new', matchId: '', before: null, after: d.after, source: d.source,
                read: 'Adding ' + name + ' as a new firm.',
                changes: [{ id: 'name', lines: [{ label: 'Company', from: '', to: name }],
                    step: { id: 'name', kind: 'field', key: 'company', value: name } }]
                    .concat(d.changes || []),
            };
            S.add.dropped = []; S.add.error = '';
            render();
        });
        each(app, '[data-pd-addask]', function (el) {
            el.onclick = function (e) {
                e.preventDefault(); e.stopPropagation();   // the row is a label; do not toggle its tick
                var a = el.getAttribute('data-pd-addask').split('|');
                S.add.answers[a[0]] = a[1];
                render();
            };
        });
        each(app, '[data-pd-addunask]', function (el) {
            el.onclick = function (e) {
                e.preventDefault(); e.stopPropagation();
                delete S.add.answers[el.getAttribute('data-pd-addunask')];
                render();
            };
        });
        each(app, '[data-pd-addkeep]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-addkeep');
                var at = S.add.dropped.indexOf(id);
                if (at === -1) S.add.dropped.push(id); else S.add.dropped.splice(at, 1);
                render();
            };
        });
        each(app, '[data-pd-addpick]', function (el) {
            el.onclick = function () {
                // Send the firm's ID and leave what was typed exactly as it is. Appending
                // "This is about X." and re-asking put the answer INTO the question: the model
                // read the added sentence as the whole message and came back having found
                // nothing, so pressing the firm's own name lost the enquiry.
                S.add.pickedId = el.getAttribute('data-pd-addpick');
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
            + '<b>Quotation Automation/Add to Directory</b> (a brochure, rate list or card photo) — '
            + 'those arrive the next time the Gmail Report runs. '
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
            // A name you corrected is the name the strip should show, or the list still calls the
            // firm by the guess you have just finished replacing.
            + '<b>' + esc(str(pi.preview && pi.preview.company)
                || (match ? match.company : (imported ? pi.subject : (companyGuess(pi) || pi.from)))) + '</b>'
            + (match ? '<span class="pd-pill">Updates someone you have</span>' : '<span class="pd-pill pd-pill-warn">New</span>')
            + '<span class="pd-sp"></span><span class="pd-tiny">' + ago(pi.receivedAt) + '</span></div>'
            + '<p class="pd-tiny" style="margin-left:20px;">' + (imported ? importedStripLine(pi)
                : 'From <b>' + esc(pi.from) + '</b> · “' + esc(pi.subject) + '”'
                    + (pi.file ? ' · 📎 ' + esc(pi.file) : '')
                    // "Read into 0 fields" meant both "there was nothing in it" and "the
                    // reading failed", and they need opposite actions from the owner.
                    + ' · ' + (pi.readFailed ? '<b>the reading failed — nothing was taken from it</b>'
                        : 'read into ' + pi.finds.length + ' field' + (pi.finds.length === 1 ? '' : 's'))) + '</p>'
            + '</div>'
            + (open ? sourceEmailHtml(pi) + editCard(pendingPreview(pi, match)) : '')
            + clashNoteHtml(pi, match) + sameFirmNoteHtml(pi, match)
            + approveRowHtml(pi, match, busy);
    }

    /**
     * What you are being asked to approve. Sender, subject and "read into 6 fields" told you
     * nothing about whether the reading was right — checking meant hunting the mail down in
     * Gmail by hand. Worse, when an attachment was too big to forward, the script wrote that
     * into the email text, a field the screen never showed: "📎 rates.pdf · read into 3
     * fields" was approved off the covering note alone.
     */
    function sourceEmailHtml(pi) {
        var text = str(pi.text);
        if (!text) return '';
        var tooBig = /too large to send for reading/i.test(text);
        return '<div class="pd-read pd-source">'
            + (tooBig ? '<p class="pd-error" style="margin:0 0 7px;">The attachment was too big to send for reading — '
                + 'everything below was read from the covering note only. Open the mail in Gmail before you approve.</p>' : '')
            + '<p class="pd-tiny" style="margin-bottom:5px;">The email this was read from:</p>'
            + '<pre class="pd-src-text">' + esc(text) + '</pre></div>';
    }

    function approveRowHtml(pi, match, busy) {
        // A card with no firm name goes in as "New partner — needs a name" and is logged as
        // the sentence "Added " with nothing after it. Ask for the name here instead.
        var nameless = !str((pi.preview && pi.preview.company) || (match && match.company) || companyGuess(pi));
        var stop = busy || clashingCard(pi, match) || nameless;
        return (nameless ? '<p class="pd-tiny pd-need-name">No firm name was found in this one. '
            + 'Open it above and type their name, and it can be approved.</p>' : '')
            + '<div class="pd-row" style="margin:0 0 14px;">'
            + '<button class="pd-prim" data-pd-approve="' + esc(pi.id) + '"' + (stop ? ' disabled' : '') + '>'
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

    // Free mail is one person, not one firm — every gmail.com card would otherwise look like
    // the same company as every other.
    var SHARED_MAIL = /^(gmail|googlemail|yahoo|yahoo\.co|ymail|rediffmail|hotmail|outlook|live|msn|aol|icloud|protonmail|zoho)\./i;

    function emailDomain(v) {
        var at = lower(v).split('@')[1] || '';
        return SHARED_MAIL.test(at) ? '' : at;
    }

    /**
     * A second address at a firm you already have.
     *
     * Matching was on the whole address only, so sales@kalpataru arriving after rakesh@
     * kalpataru read as "New", and approving made a SECOND card for one firm. Two cards
     * become two chips, and separate chips are deliberately separate emails — so the same
     * firm gets the enquiry twice and the two people there never see each other. There is no
     * merge in the tool, so say it before Approve rather than after.
     */
    function sameFirmNoteHtml(pi, match) {
        if (match || !pi.from) return '';
        var domain = emailDomain(pi.from);
        if (!domain) return '';
        var kin = D.contacts.filter(function (c) {
            return allEmails(c).some(function (e) { return emailDomain(e) === domain; });
        })[0];
        if (!kin) return '';
        return '<div class="pd-read" style="margin:0 0 8px;"><p class="pd-tiny">'
            + '<b>' + esc(pi.from) + '</b> is at the same place as '
            + '<button data-pd-open="' + esc(kin.id) + '" class="pd-linkish">'
            + esc(kin.company || '(no name)') + '</button>, who you already have. '
            + 'If it is the same firm, add this person to that card instead — two cards for one firm '
            + 'means they get the same enquiry twice, on two separate emails.</p></div>';
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
        else if (x.key === 'branches') {
            // MERGED, never replaced. A rate card that happens to mention only Chennai used to
            // wipe the other four branches — with the areas and addresses typed into them —
            // and the nearest branch is what distance is measured from, so the firm quietly
            // stopped being suggested for deliveries it used to win.
            p.branches = p.branches || [];
            String(x.value).split(/[,;]+/).map(str).filter(Boolean).forEach(function (c) {
                var city = matchCity(c) || c;
                if (!p.branches.some(function (b) { return lower(b.city) === lower(city); })) {
                    p.branches.push({ city: city, area: '', address: '' });
                }
            });
        }
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
            + undoRowHtml(ch)
            + '</div>'
            + (open && p ? editCard(p) : '');
    }

    /**
     * No partner id means there is no single card to put back — the import logs one entry for
     * the whole batch. Undo used to stamp it "Undone", hide its own button, and remove
     * nothing at all, so the owner believed 22 cards had been rolled back.
     */
    function undoRowHtml(ch) {
        if (ch.undone) return '';
        if (!str(ch.partnerId)) {
            return '<p class="pd-tiny" style="margin:8px 0 0 20px;">This one covers several cards at once, '
                + 'so it cannot be undone in one go — delete any you do not want from the directory.</p>';
        }
        return '<div style="margin:8px 0 0 20px;"><button data-pd-undo="' + esc(ch.id) + '"'
            + (S.busy[ch.id] ? ' disabled' : '') + '>Undo this</button></div>';
    }

    /**
     * Undo restores the whole card as it was, so months of later work goes with it. The server
     * refuses the first time and says what else would go; this is where the owner sees that
     * list and decides. There is no undo-the-undo, which is exactly why it asks.
     */
    function undoWithWarning(id, confirmed) {
        if (S.busy[id]) return;
        S.busy[id] = true; render();
        fetch(apiBase() + '/contacts/change-undo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, confirmed: confirmed === true }),
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; });
        }).then(function (res) {
            delete S.busy[id];
            if (res.r.ok) { loadDirectory(render); return; }
            if (res.d.needsConfirming) {
                askOnPage({
                    title: 'Undo this change?',
                    lines: undoWarningText(res.d.alsoLost || []).split('\n\n'),
                    okLabel: 'Undo it',
                    run: function () { undoWithWarning(id, true); },
                });
                return;
            }
            D.saveError = res.d.error || ('HTTP ' + res.r.status);
            render();
        }).catch(function (e) {
            delete S.busy[id]; D.saveError = e.message; render();
        });
    }

    function undoWarningText(lost) {
        return 'Undoing this puts the card back as it was, so these would go too:\n\n'
            + lost.map(function (l) { return '  • ' + l.label + (l.to ? ': ' + l.to : ''); }).join('\n')
            + '\n\nThere is no way back from this. Undo anyway?';
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
                // Leaving for another tab drops the open card just as surely as closing it.
                if (!leaveCardOk(function () { el.onclick(); })) return;
                S.tab = el.getAttribute('data-pd-tab');
                render();
                loadDirectory(render);   // refetch — a labelled email may have arrived meanwhile
            };
        });
        on(app, '[data-pd-reload]', function () { loadDirectory(render); });
        each(app, '[data-pd-filter]', function (el) {
            // A chip sits directly above the open card, and closing it that way skipped the
            // question entirely — the typing then went at the next refresh, silently.
            el.onclick = function () {
                if (!leaveCardOk(function () { el.onclick(); })) return;
                S.filter = el.getAttribute('data-pd-filter'); S.openId = null; render();
            };
        });
        bindFinder(app); bindAdd(app); bindListAndCard(app); bindChanges(app);
    }

    function bindFinder(app) {
        var box = $('pdFindIn');
        if (box) box.oninput = function () { S.find.text = this.value; };
        each(app, '[data-pd-goto-directory]', function (el) {
            // Straight to the Add tab: that is where a firm is typed in, and dropping the
            // owner on the list instead is a dead end now that the add button has gone.
            el.onclick = function () {
                S.find = { text: '', state: 'idle', need: null, note: '' };
                S.filter = 'all'; S.tab = 'add'; render();
            };
        });
        each(app, '[data-pd-find]', function (el) {
            el.onclick = function () {
                if (el.getAttribute('data-pd-find') === 'clear') { S.find = { text: '', state: 'idle', need: null, note: '' }; render(); return; }
                var text = str(S.find.text);
                // Pressing it on an empty box did nothing whatever — no message, no redraw.
                if (!text) { S.find.note = 'Put the enquiry in the box first, or type a name to look someone up.'; render(); return; }
                var need = readEnquiry(text);
                S.find.note = '';
                if (need.empty || looksLikeFirmName(text)) { S.find.state = 'name'; S.find.need = null; }
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
            }, function () { S.importing = false; }, 'Bringing in the addresses');
        });
    }

    /**
     * Opening a card used to snap the list back to "All". Working through the 22 cards under
     * "Need checking" meant the chip reset on every single one, so after each card the owner
     * had to find the chip and press it again to see what was left. The filter is only widened
     * when it would hide the card being opened — which is the case the reset existed for
     * (a clash note on the Recent-changes tab points at a card the current chip filters out).
     */
    function widenFilterToShow(p) {
        if (S.filter === 'all') return;
        if (!p) { S.filter = 'all'; return; }
        var hidden = p.role !== S.filter;
        if (hidden) S.filter = 'all';
    }

    function openCard(id) {
        S.openId = id;
        widenFilterToShow(byId(id));
        S.find = { text: '', state: 'idle', need: null, note: '' };
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
                // Opening someone else closes this one — same question, same three answers.
                if (el.getAttribute('data-pd-open') !== S.openId && !leaveCardOk(go)) return;
                S.openId = el.getAttribute('data-pd-open');
                S.find.state = S.find.state === 'done' ? 'idle' : S.find.state;
                // Reachable from a clash note on the Recent-changes tab, where the card it
                // opens is not rendered — go to where it lives, or the click does nothing.
                S.tab = 'dir';
                widenFilterToShow(byId(S.openId));
                render();
            };
            el.onclick = go;
            el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
        });
        each(app, '[data-pd-close]', function (el) {
            // Closing a card with edits in it would drop them without a word — the one thing
            // the whole save-on-blur behaviour used to prevent. Ask, and keep it open if not.
            el.onclick = function () { if (leaveCardOk()) { S.openId = null; render(); } };
        });
        each(app, '[data-pd-askcancel]', function (el) {
            el.onclick = function (e) {
                if (el.getAttribute('data-pd-askcancel') === 'backdrop' && e.target !== el) return;
                if (S.ask && S.ask.busy) return;
                S.ask = null; render();
            };
        });
        on(app, '[data-pd-askok]', function () {
            var a = S.ask;
            if (!a || a.busy) return;        // one press is one go
            var typed = '';
            if (a.ask) {
                var box = app.querySelector('#pdAskIn');
                typed = str(box && box.value);
                // Nothing typed is not an answer. Hold the question open rather than
                // closing it and quietly doing nothing, which is what prompt() did.
                if (!typed) { if (box) box.focus(); return; }
            }
            a.busy = true; render();
            var run = a.run;
            S.ask = null;
            run(typed);
        });
        // Enter in the box is the same as pressing the button.
        each(app, '#pdAskIn', function (el) {
            el.onkeydown = function (e) {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                var ok = app.querySelector('[data-pd-askok]');
                if (ok && ok.onclick) ok.onclick();
            };
        });
        each(app, '[data-pd-leavecancel]', function (el) {
            el.onclick = function (e) {
                // The dark backdrop closes the question; a click INSIDE the box must not,
                // or reading it dismisses it.
                if (el.getAttribute('data-pd-leavecancel') === 'backdrop' && e.target !== el) return;
                if (S.busy['save' + S.confirmLeave]) return;
                S.confirmLeave = ''; S.leaveThen = null; render();   // stay put, edits intact
            };
        });
        on(app, '[data-pd-leavedrop]', function () {
            if (S.busy['save' + S.confirmLeave]) return;
            closeCardNow(true);                         // they were told, and chose this
        });
        on(app, '[data-pd-leavesave]', function () {
            var id = S.confirmLeave;
            if (!id || S.busy['save' + id]) return;      // one press is one save
            saveOpenCard(id).then(function (ok) { if (ok) closeCardNow(false); });
        });
        on(app, '[data-pd-save]', function () {
            saveOpenCard(app.querySelector('[data-pd-save]').getAttribute('data-pd-save'));
        });
        each(app, '[data-pd-delete]', function (el) {
            // Only opens the question. The write lives behind the popup's own button.
            el.onclick = function () {
                S.confirmDelete = el.getAttribute('data-pd-delete');
                render();
            };
        });
        each(app, '[data-pd-delcancel]', function (el) {
            el.onclick = function (e) {
                if (S.busy[S.confirmDelete]) return;
                // A click on the dark backdrop closes it; a click INSIDE the box must not.
                if (el.getAttribute('data-pd-delcancel') === 'backdrop' && e.target !== el) return;
                S.confirmDelete = ''; render();
            };
        });
        on(app, '[data-pd-delok]', function () {
            var id = S.confirmDelete;
            if (!id || S.busy[id]) return;      // one press is one deletion
            S.busy[id] = true; render();
            postJson('/contacts/delete', { id: id }, function () {
                S.confirmDelete = ''; S.openId = null;
                loadDirectory(render);
            }, function () { delete S.busy[id]; }, 'Deleting that partner');
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
        holdCleanCopy(p);      // before the first keystroke, so there is something to put back
        var save = function (rerender, fields) {
            p.checked = new Date().toISOString().slice(0, 10);
            // A pending-queue PREVIEW is never saved here — approval is its only write path.
            // (Otherwise editing one before approving stores a stray copy = a duplicate firm.)
            var inDirectory = isInDirectory(p);
            // A brand-new card is only written once it says something. Typing the firm name
            // (or a person, or a number) is what creates it; until then there is nothing to
            // store, and storing it anyway is what left blank rows behind.
            // TWO RULES, because the two screens are used differently.
            //
            // A card in the DIRECTORY waits for Save. You are correcting a record you own, often
            // several boxes at a time, and writing on every blur stored half-finished edits — and
            // a failed write left the screen and the directory quietly disagreeing.
            //
            // A card WAITING FOR APPROVAL saves as you type, onto the queue item and never into
            // the directory. Nothing is being stored as fact there; the corrections only have to
            // survive a tab switch, which they did not before.
            if (inDirectory) markDirty(p, fields);
            else savePendingPreview(p);
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

    /**
     * An address the server cannot store must not disappear in silence.
     *
     * Anything that is not an address was dropped on save while the box went on showing it —
     * and if it was the only thing on an unnamed row, the whole person went with it. You found
     * out weeks later, from a suggestion saying "no email on card" for a firm you were certain
     * you had filled in. Filling in the imported cards is the day-one job, so this bit hard.
     *
     * Two addresses pasted into one box are split into two rows rather than refused: pasting a
     * pair off an email signature is a normal thing to do, not a mistake.
     */
    function acceptEmail(el, person, idx, key) {
        if (key !== 'v') { person.emails[idx][key] = el.value; return true; }
        var parts = String(el.value).split(/[,;]+/).map(str).filter(Boolean);
        var bad = parts.filter(function (v) { return !isEmail(v); });
        if (bad.length) {
            el.classList.add('pd-bad');
            el.title = bad[0] + ' is not an email address, so it cannot be saved.';
            return false;
        }
        el.classList.remove('pd-bad'); el.title = '';
        person.emails[idx].v = parts[0];
        parts.slice(1).forEach(function (v) {
            if (!person.emails.some(function (e) { return lower(e.v) === lower(v); })) {
                person.emails.push({ label: 'Work', v: v });
            }
        });
        if (parts.length > 1) render();
        return true;
    }

    function bindPeople(card, p, save) {
        each(card, '[data-pd-pc]', function (el) {
            el.onchange = function () {
                var c = p.people[Number(el.getAttribute('data-pd-pc'))], k = el.getAttribute('data-pd-k');
                if (el.hasAttribute('data-pd-ph')) c.phones[Number(el.getAttribute('data-pd-ph'))][k] = el.value;
                else if (el.hasAttribute('data-pd-em')) {
                    if (!acceptEmail(el, c, Number(el.getAttribute('data-pd-em')), k)) return;
                } else c[k] = el.value;
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

    // Each write names ONLY what was touched. Sending branches, routes, city and address
    // together meant adding a branch wrote back this tab's hours-old copy of the routes,
    // silently wiping a lorry route a colleague had added on the other machine.
    function bindPlaces(card, p, save) {
        on(card, '[data-pd-addbranch]', function () { (p.branches = p.branches || []).push({ city: '', area: '', address: '' }); save(true, ['branches']); });
        each(card, '[data-pd-br]', function (el) {
            el.onchange = function () { p.branches[Number(el.getAttribute('data-pd-br'))][el.getAttribute('data-pd-k')] = el.value; save(false, ['branches']); };
        });
        each(card, '[data-pd-delbranch]', function (el) { el.onclick = function () { p.branches.splice(Number(el.getAttribute('data-pd-delbranch')), 1); save(true, ['branches']); }; });
        on(card, '[data-pd-addroute]', function () { (p.routes = p.routes || []).push({ from: '', to: '' }); save(true, ['routes']); });
        each(card, '[data-pd-rt]', function (el) {
            el.onchange = function () { p.routes[Number(el.getAttribute('data-pd-rt'))][el.getAttribute('data-pd-k')] = el.value; save(false, ['routes']); };
        });
        each(card, '[data-pd-delroute]', function (el) { el.onclick = function () { p.routes.splice(Number(el.getAttribute('data-pd-delroute')), 1); save(true, ['routes']); }; });
    }

    function bindSupply(card, p, save) {
        var pick = $('pdTypePick');
        on(card, '[data-pd-addtype]', function () {
            // Compared without case: an import writes SEAMLESS, the dropdown offers Seamless,
            // and the same type went onto the card twice.
            var addType = function (v) {
                v = str(v);
                if (!v) return;
                var has = (p.types = p.types || []).some(function (t) { return lower(t) === lower(v); });
                if (!has) p.types.push(v);
                save(true, ['types']);
            };
            var v = pick ? pick.value : '';
            if (v !== '__other') { addType(v); return; }
            // window.prompt THROWS here rather than returning nothing, so the handler died
            // half-way and "＋ Add another…" did nothing at all.
            askOnPage({
                title: 'What else do they deal in?',
                ask: 'Type it in', placeholder: 'e.g. Ductile iron',
                okLabel: 'Add it', danger: false,
                run: addType,
            });
        });
        each(card, '[data-pd-deltype]', function (el) { el.onclick = function () { p.types.splice(Number(el.getAttribute('data-pd-deltype')), 1); save(true, ['types']); }; });
        on(card, '[data-pd-addproduct]', function () { (p.products = p.products || []).push({ p: '', spec: '', sizes: [], moq: 0, rule: '' }); save(true, ['products']); });
        each(card, '[data-pd-delproduct]', function (el) { el.onclick = function () { p.products.splice(Number(el.getAttribute('data-pd-delproduct')), 1); save(true, ['products']); }; });
        each(card, '[data-pd-pr]', function (el) {
            el.onchange = function () {
                var i = Number(el.getAttribute('data-pd-pr')), k = el.getAttribute('data-pd-k');
                if (el.hasAttribute('data-pd-sz')) p.products[i].sizes[Number(el.getAttribute('data-pd-sz'))][k] = el.value;
                else p.products[i][k] = (k === 'moq') ? (parseFloat(el.value) || 0) : el.value;
                save(k === 'spec', ['products']);
            };
        });
        each(card, '[data-pd-addsz]', function (el) { el.onclick = function () { var pr = p.products[Number(el.getAttribute('data-pd-addsz'))]; (pr.sizes = pr.sizes || []).push({ nb: '', inch: '', od: '', thk: '' }); save(true, ['products']); }; });
        each(card, '[data-pd-delsz]', function (el) { el.onclick = function () { var a = el.getAttribute('data-pd-delsz').split(':'); p.products[+a[0]].sizes.splice(+a[1], 1); save(true, ['products']); }; });
        each(card, '[data-pd-loadis]', function (el) {
            el.onclick = function () {
                var pr = p.products[Number(el.getAttribute('data-pd-loadis'))], cls = specClass(pr.spec);
                if (!cls) return;
                // It REPLACES the table outright, and a supplier's own thicknesses typed in by
                // hand were being wiped by a button pressed to see what it did. Undo does not
                // cover hand-typed rows.
                var fill = function () {
                    pr.sizes = IS1239.filter(function (r) { return r[cls]; }).map(function (r) { return { nb: r.nb, inch: r.inch, od: r.od, thk: r[cls] }; });
                    save(true, ['products']);
                };
                if (!(pr.sizes || []).length) { fill(); return; }
                askOnPage({
                    title: 'Replace ' + pr.sizes.length + ' size row' + (pr.sizes.length === 1 ? '' : 's') + '?',
                    lines: ['This puts the standard IS 1239 ' + cls + ' table on '
                            + (str(pr.p) || 'this product') + ', in place of what is there now.',
                            'Anything you typed in by hand is lost, and Undo does not cover it.'],
                    okLabel: 'Replace them',
                    run: fill,
                });
            };
        });
        on(card, '[data-pd-addorule]', function () { (p.rules = p.rules || []).push(''); save(true, ['rules']); });
        each(card, '[data-pd-orule]', function (el) { el.onchange = function () { p.rules[Number(el.getAttribute('data-pd-orule'))] = el.value; save(false, ['rules']); }; });
        each(card, '[data-pd-delorule]', function (el) { el.onclick = function () { p.rules.splice(Number(el.getAttribute('data-pd-delorule')), 1); save(true, ['rules']); }; });
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

    /**
     * Where the queued item CAME from decides what discarding it actually means, and the one
     * sentence used for both was false for half of them. An imported firm came from the
     * remembered-addresses list, not from an email — there is no Gmail message to re-label,
     * and it comes back the next time the addresses are brought in.
     */
    function discardWarningText(id) {
        var pi = D.pending.filter(function (x) { return x.id === id; })[0] || {};
        var who = str(pi.preview && pi.preview.company) || str(pi.subject) || str(pi.from) || 'this one';
        if (pi.origin === 'import') {
            return 'Discard ' + who + '?\n\n'
                + 'It comes off this list now. There is no Undo.\n'
                + 'It came from an address you have emailed before, not from a labelled email — '
                + 'so it will show up here again the next time you press '
                + '"Bring in the addresses I have already used".';
        }
        return 'Discard ' + who + '?\n\n'
            + 'It is thrown away for good — there is no Undo, and it will not arrive again.\n'
            + 'To get it back you would have to find the email in Gmail and put the '
            + 'Add-to-Directory label on it once more.';
    }

    function bindChanges(app) {
        each(app, '[data-pd-pending]', function (el) {
            var go = function () {
                var id = el.getAttribute('data-pd-pending');
                // Only ONE card is ever open. Two of them showed a full edit card each, but
                // only the first on the page was wired up — typing into the lower one and
                // tabbing away did nothing at all, with no error and no red banner.
                S.openChange = null;
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
                }, function () { delete S.busy[id]; }, 'Approving that firm');
            };
        });
        each(app, '[data-pd-discard]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-discard');
                if (S.busy[id]) return;
                // Discard sits beside Approve, deletes outright, and writes nothing to the
                // applied log — so there is no Undo. What happens NEXT depends on where the
                // item came from, which is why the wording is built per item.
                var warn = discardWarningText(id).split('\n\n');
                askOnPage({
                    title: warn[0],
                    lines: warn.slice(1),
                    okLabel: 'Discard it',
                    run: function () {
                        S.busy[id] = true; render();
                        postJson('/contacts/pending/discard', { id: id }, function () { loadDirectory(render); },
                            function () { delete S.busy[id]; }, 'Discarding that one');
                    },
                });
            };
        });
        each(app, '[data-pd-change]', function (el) {
            el.onclick = function () {
                var id = el.getAttribute('data-pd-change');
                S.openPending = null;   // one open card at a time — see the pending handler
                S.openChange = S.openChange === id ? null : id;
                var ch = D.changes.filter(function (x) { return x.id === id; })[0];
                S.openId = (S.openChange && ch) ? ch.partnerId : null;
                render();
            };
        });
        each(app, '[data-pd-undo]', function (el) {
            el.onclick = function () { undoWithWarning(el.getAttribute('data-pd-undo'), false); };
        });
    }

    // ── The in-quote suggestion panel (Freight / Enquiry tabs call this) ──────
    // opts: { kind:'transport'|'material', pickup, drop, kg, types:[], items:[], site }
    // onAddChip(chipText): ONE chip = ONE email — several addresses in a chip are CC'd
    // together (same firm); separate chips are separate emails (firms never meet).
    function renderSuggestPanel(container, opts, onAddChip) {
        if (!container) return;
        var go = function () {
            var town = function (v) { return str(v) ? (matchCity(v) || str(v)) : ''; };
            var drop = town(opts.drop) || town(opts.site);
            // A freight box opens with both towns empty. Falling back to Chennai there made
            // the panel announce "Chennai → Chennai" and rule out most of his lorry firms;
            // for a material enquiry the home city is still the sensible default.
            var isFreight = opts.kind === 'transport';
            var need = {
                types: opts.types || [], items: opts.items || [],
                site: drop || (isFreight ? '' : HOME),
                tons: (opts.kg || 0) / 1000, known: (opts.kg || 0) > 0,
            };
            var from = town(opts.pickup) || (isFreight ? '' : HOME);
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

    function panelHead(opts, need, from) {
        var weight = '<b>' + (need.known ? need.tons.toFixed(2) + ' T' : 'no weight') + '</b>';
        if (opts.kind === 'transport') {
            if (!from || !need.site) {
                return 'Read from this box: ' + weight
                    + ' · <b>no route yet</b> — fill in the pickup and delivery towns and I can rank on route.';
            }
            return 'Read from this box: <b>' + esc(from) + '</b> → <b>' + esc(need.site) + '</b> · ' + weight;
        }
        return 'Read from the enquiry: <b>' + esc(typeNames(need.types) || 'no pipe type') + '</b> · '
            + weight + ' · to <b>' + esc(need.site) + '</b>';
    }

    function panelHtml(rows, opts, need, from) {
        var head = panelHead(opts, need, from);
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
            : (typeNames(need.types, ' ') + ' pipe suppliers ' + (need.site ? 'near ' + need.site : '')).trim();
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
            // It sends nothing — it opens the list of who at the firm to put on the enquiry.
            // Labelled "Send Email" it read as the button that fires the mail.
            + (emails.length ? '<button class="pd-prim" data-pd-send="' + idx + '">✉ Choose who to email</button>'
                : '<span class="pd-tiny">No email on their card</span>')
            + '</div><div class="pd-picker" data-pd-picker="' + idx + '" hidden></div></div>';
    }

    function bindPanel(container, rows, onAddChip) {
        each(container, '[data-pd-goto-directory]', function (el) {
            el.onclick = function () {
                S.tab = 'add';                            // the Add tab, not the bare list
                if (typeof window.switchToDirectoryTab === 'function') window.switchToDirectoryTab();
            };
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
            + '<div class="pd-row" style="margin-top:7px;"><button class="pd-prim" data-pd-pickadd="1">Add to recipients</button>'
            + '<span class="pd-tiny pd-picknone" data-pd-picknone="1"></span></div>';
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
            // Unticking everyone and pressing Add used to close the list and do nothing at
            // all — it looked exactly like a successful add.
            if (!picked.length) {
                var say = slot.querySelector('[data-pd-picknone]');
                if (say) say.textContent = 'Tick at least one person, or close this and pick another firm.';
                return;
            }
            if (typeof onAddChip === 'function') onAddChip(picked.join(', '));
            slot.hidden = true;
        });
    }

    /**
     * Fire-and-record: the send flows call this after a successful send / detected reply.
     *
     * It must NOT go through postJson. That sets the shared save banner — "your last edit is
     * NOT stored" — over an edit nobody made, and renders it into the directory page, which
     * is hidden while the owner is on the Quotation tab. Days later the banner surfaces and
     * accuses him of losing work. Its own quiet note, in its own words, on its own page.
     */
    function recordUsage(usage) {
        return fetch(apiBase() + '/contacts/usage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(usage || {}),
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            D.loaded = false; D.usageError = '';
        }).catch(function (e) {
            D.usageError = e.message;
        });
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

    /**
     * A count on the 📇 button, so a waiting brochure is visible from any tool.
     *
     * The number lived only inside the directory, and the directory was only ever fetched
     * when the button was pressed — so labelled emails could sit unreviewed for weeks with
     * nothing anywhere to say so. Failure is silent on purpose: this is a hint, not a page.
     */
    function paintWaitingBadge() { paintBadgeCount(D.pending.length); }

    function paintBadgeCount(n) {
        var btn = $('mainToolDirectoryButton');
        if (!btn) return;
        var dot = btn.querySelector('.pd-waiting-dot');
        if (!n) { if (dot) dot.remove(); return; }
        if (!dot) {
            dot = document.createElement('span');
            dot.className = 'pd-waiting-dot';
            btn.appendChild(dot);
        }
        dot.textContent = n > 9 ? '9+' : String(n);
        dot.title = n + ' waiting for you in the Partner Directory';
    }

    /**
     * Keep the count honest without touching the page.
     *
     * The number was read once when the app opened and then only when the directory itself
     * was re-read — so a brochure tagged in Gmail at ten o'clock showed nothing all day on a
     * tab left open, which is exactly how this app is used. This re-reads the count only: it
     * writes the badge and nothing else, so a card being typed into, an unsaved new partner
     * and an open review are all safe from it. Failure is silent — it is a hint, not a page.
     */
    var BADGE_EVERY_MS = 3 * 60 * 1000;

    function refreshWaitingBadge() {
        if (document.hidden) return;              // no point polling a tab nobody is looking at
        fetch(apiBase() + '/contacts')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) { paintBadgeCount((d.pending || []).length); })
            .catch(function () { /* leave the last known count alone */ });
    }

    function startBadgeWatch() {
        var t = setInterval(refreshWaitingBadge, BADGE_EVERY_MS);
        if (t && t.unref) t.unref();              // never hold a test runner open
        if (document.addEventListener) {
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden) refreshWaitingBadge();
            });
        }
    }

    function checkWhatIsWaiting() { loadDirectory(); startBadgeWatch(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkWhatIsWaiting);
    else checkWhatIsWaiting();

    window.switchToDirectoryTab = switchToDirectoryTab;
    window.partnerDirectory = {
        renderSuggestPanel: renderSuggestPanel,
        recordUsage: recordUsage,
        _test: { readEnquiry: readEnquiry, rankFor: rankFor, matchCity: matchCity, kmBetween: kmBetween,
                 applyFind: applyFind, looksLikeFirmName: looksLikeFirmName,
                 focusKey: focusKey, saveFailedWhat: saveFailedWhat,
                 refreshWaitingBadge: refreshWaitingBadge,
                 markDirty: markDirty, dirtyFields: dirtyFields, isDirty: isDirty,
                 saveBarHtml: saveBarHtml, leaveCardOk: leaveCardOk, saveOpenCard: saveOpenCard,
                 leavePopupHtml: leavePopupHtml, closeCardNow: closeCardNow,
                 holdCleanCopy: holdCleanCopy, restoreCleanCopy: restoreCleanCopy,
                 keepOpenEdits: keepOpenEdits,
                 _state: function () { return { S: S, D: D }; } },
    };
})();
