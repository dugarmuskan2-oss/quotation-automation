/**
 * town-places.js — where each town is on the map, so every supplier can be measured.
 *
 * *His words (30 Sep): "if I want to supply in chennai then it can show me manufacturers
 * closest to chennai that produce the pipes Im looking for" — "Same logic for dealers also."*
 *
 * The directory's distance list held 24 towns. Of his 7 approved manufacturers only 4 had a
 * town it could measure; Kosi Kalan, Murbad, Nagothane and the rest scored nothing. This file
 * holds the towns he has placed since — each looked up ONCE on OpenStreetMap, and picked by
 * him when the map offers more than one (it answers "Sikandrabad" with Secunderabad first, and
 * both are on his cards). A town nobody has placed stays unmeasured and says so; no distance
 * is ever guessed.
 *
 * Used in two places, so it is written for both:
 *   the browser — window.townPlaces, read by partner-directory.js;
 *   the server  — require('./town-places'), so a saved town is keyed the same way on both sides.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.townPlaces = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function str(v) { return String(v == null ? '' : v).trim(); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** One town however it is typed: "Kosi  Kalan", "kosi kalan" and "KOSI-KALAN" are one key. */
    function placeKey(name) {
        return str(name).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    }

    // India only, and a little either side of it. A pick outside this box is a wrong pick.
    function inIndia(lat, lon) {
        return typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)
            && lat >= 6 && lat <= 37.5 && lon >= 68 && lon <= 97.5;
    }

    /**
     * A place is only kept with a position, a state and where it came from. The state is what
     * makes a wrong pick visible later ("Tarapur, Maharashtra — 1,370 km"), so a place without
     * one is refused rather than stored half-known.
     */
    function validPlace(p) {
        return !!p && !!placeKey(p.name) && !!str(p.state) && !!str(p.source)
            && inIndia(Number(p.lat), Number(p.lon));
    }

    // ── What the browser knows (set from GET /contacts on every directory read) ──────
    var saved = {};
    var savedError = '';

    function setSaved(places, error) {
        saved = (places && typeof places === 'object') ? places : {};
        savedError = str(error);
    }
    function savedPlace(name) {
        var p = saved[placeKey(name)];
        return validPlace(p) ? p : null;
    }
    function savedNames() {
        return Object.keys(saved).map(function (k) { return saved[k]; }).filter(validPlace)
            .map(function (p) { return p.name; });
    }

    // Words that turn a town into something else: "Salem Road, Namakkal" is not in Salem.
    var ROAD_AFTER = /^[\s.,]*(main\s+road|road|rd\b|highway|high\s+road|street|salai|bypass)/i;

    /**
     * The one town a piece of text names, matched as WHOLE words — never inside another word,
     * never "Salem" out of "Salem Road", and never a pick when two different towns are named.
     *
     *   builtIn: { Name: [lat, lon] } — the 24 towns the directory has always known.
     *   Returns { name, lat, lon, state, looked } | { ambiguous: [names] } | null
     */
    function placeText(text, builtIn) {
        var t = ' ' + str(text) + ' ';
        if (!str(text)) return null;
        var pool = [];
        Object.keys(builtIn || {}).forEach(function (n) {
            pool.push({ name: n, lat: builtIn[n][0], lon: builtIn[n][1], state: '', looked: false });
        });
        savedNames().forEach(function (n) {
            if (pool.some(function (x) { return placeKey(x.name) === placeKey(n); })) return;
            var p = savedPlace(n);
            pool.push({ name: p.name, lat: Number(p.lat), lon: Number(p.lon), state: str(p.state), looked: true });
        });
        var hits = [];
        pool.forEach(function (c) {
            if (!placeKey(c.name)) return;      // a name with no letters would match everywhere, for ever
            var words = placeKey(c.name).split(' ').map(function (w) {
                return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('[^a-z]+');
            var re = new RegExp('(^|[^a-z])(' + words + ')(?![a-z])', 'gi'), m;
            while ((m = re.exec(t)) !== null) {
                if (!m[2]) { re.lastIndex++; continue; }
                var start = m.index + m[1].length, end = start + m[2].length;
                if (ROAD_AFTER.test(t.slice(end))) continue;
                hits.push({ c: c, start: start, end: end });
            }
        });
        // "Navi Mumbai" names one town, not Navi Mumbai AND Mumbai: a hit inside a longer hit goes.
        hits = hits.filter(function (h) {
            return !hits.some(function (o) {
                return o !== h && o.start <= h.start && o.end >= h.end && (o.end - o.start) > (h.end - h.start);
            });
        });
        var names = [];
        hits.forEach(function (h) { if (names.indexOf(h.c.name) === -1) names.push(h.c.name); });
        if (!names.length) return null;
        if (names.length > 1) return { ambiguous: names };
        var c = hits[0].c;
        return { name: c.name, lat: c.lat, lon: c.lon, state: c.state, looked: c.looked };
    }

    /** Road distance, roughly: straight line × 1.25, to the nearest 10 km — the directory's own rule. */
    function kmApart(a, b) {
        if (!a || !b) return null;
        var rad = Math.PI / 180;
        var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
        var x = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
        return Math.round(km * 1.25 / 10) * 10;
    }

    // ── Placing a town from a card (browser only) ────────────────────────────────────
    //
    // Kept HERE, not in the card's HTML: every save on the card redraws it, and a list of
    // choices or a "Looking…" lock held in the page would vanish with the redraw — the second
    // press would then ask the map again. The card draws stripHtml() and calls bindStrip().
    var pick = null;   // { name, status: 'looking'|'choose'|'saving'|'error'|'done', options, msg }
    var busy = false;

    function apiBase() {
        var o = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
        return (o && o !== 'null' && o.indexOf('http') === 0) ? o + '/api' : 'http://localhost:3001/api';
    }

    function post(path, body) {
        return fetch(apiBase() + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
                return d;
            });
        });
    }

    /**
     * Ask the map where a town is. The town is already on the card before this starts, and this
     * never touches the card — a map that is down or slow must never cost him the town he typed.
     */
    function startPick(name, redraw, spelling, owner) {
        name = str(name);
        spelling = str(spelling) || name;
        if (!name || busy) return;
        owner = str(owner);
        var have = savedPlace(name);
        if (have) {
            pick = { name: name, owner: owner, status: 'done', options: [], msg: name + ' is on the map as ' + have.name
                + (have.district ? ', ' + have.district : '') + ', ' + have.state + '.' };
            redraw();
            return;
        }
        busy = true;
        pick = { name: name, owner: owner, status: 'looking', options: [], msg: '' };
        redraw();
        // Another spelling is only for FINDING it ("Tiruppur" for his "Tirupur"); what is kept
        // is still the name on his card, so the card and the map agree.
        post('/contacts/town-lookup', { name: spelling }).then(function (d) {
            if (d.saved && placeKey(d.saved.name) !== placeKey(name)) {
                // Found under the OTHER spelling, already placed. That is not yet his card's
                // town: offered as the one choice, so pressing it saves it under his name too.
                saved[placeKey(d.saved.name)] = d.saved;
                pick = { name: name, owner: owner, status: 'choose', msg: '', options: [{
                    name: d.saved.name, district: d.saved.district, state: d.saved.state,
                    lat: d.saved.lat, lon: d.saved.lon, osm: d.saved.osm, label: d.saved.label }] };
            } else if (d.saved) {
                saved[placeKey(d.saved.name)] = d.saved;
                pick = { name: name, owner: owner, status: 'done', options: [], msg: name + ' is on the map as ' + d.saved.name + ', ' + d.saved.state + '.' };
            } else if (!(d.candidates || []).length) {
                pick = { name: name, owner: owner, status: 'none', options: [], msg: 'The map knows no town called "' + spelling
                    + '". The town stays on the card; its distance is not measured.' };
            } else {
                pick = { name: name, owner: owner, status: 'choose', options: d.candidates, msg: '' };
            }
        }).catch(function (e) {
            pick = { name: name, owner: owner, status: 'error', options: [], msg: e.message };
        }).then(function () { busy = false; redraw(); });
    }

    function choose(i, redraw) {
        if (busy || !pick || pick.status !== 'choose') return;
        var c = pick.options[i];
        if (!c) return;
        busy = true;
        pick.status = 'saving';
        redraw();
        post('/contacts/town-place', { name: pick.name, candidate: c }).then(function (d) {
            if (d.place) saved[placeKey(d.place.name)] = d.place;
            pick = { name: pick.name, owner: pick.owner, status: 'done', options: [], msg: pick.name + ' is on the map now: '
                + [c.district, c.state].filter(Boolean).join(', ') + '. Its distance is measured from here on.' };
        }).catch(function (e) {
            // The choices stay up: the pick failed, not the lookup, so he can press again.
            pick.status = 'choose';
            pick.msg = 'Not saved — ' + e.message;
        }).then(function () { busy = false; redraw(); });
    }

    function leave(redraw) {
        if (busy) return;
        pick = null;
        redraw();
    }

    /** Drawn only on the card the town belongs to — not on whichever card is opened next. */
    function stripHtml(owner) {
        if (!pick || (pick.owner && str(owner) !== pick.owner)) return '';
        var head = '<b>📍 ' + esc(pick.name) + '</b> — ';
        var body;
        if (pick.status === 'looking') body = 'looking it up on the map…';
        else if (pick.status === 'saving') body = 'saving your pick…';
        else if (pick.status === 'choose') {
            body = 'which one is it?'
                + (pick.msg ? ' <span class="pd-error">' + esc(pick.msg) + '</span>' : '')
                + '<span class="pd-tp-opts">' + pick.options.map(function (c, i) {
                    return '<button type="button" data-tp-pick="' + i + '">' + esc(c.name)
                        + ' — ' + esc([c.district, c.state].filter(Boolean).join(', ')) + '</button>';
                }).join('') + '<button type="button" class="pd-linkish" data-tp-leave="1">None of these — leave it unmeasured</button></span>'
                + '<span class="pd-tp-opts"><input data-tp-alt="1" placeholder="Not listed? Try another name nearby — e.g. Boisar">'
                + '<button type="button" data-tp-altgo="1">Look up</button></span>';
        } else if (pick.status === 'none') {
            body = esc(pick.msg) + ' <span class="pd-tp-opts"><input data-tp-alt="1" placeholder="Try another spelling — e.g. Tiruppur">'
                + '<button type="button" data-tp-altgo="1">Look up</button></span>';
        } else body = esc(pick.msg);
        return '<div class="pd-tp-strip' + (pick.status === 'error' || pick.status === 'none' ? ' pd-tp-bad' : '') + '">' + head + body
            + (pick.status === 'done' || pick.status === 'error' || pick.status === 'none'
                ? ' <button type="button" class="pd-linkish" data-tp-leave="1">' + (pick.status === 'none' ? 'Leave it' : 'OK') + '</button>' : '')
            + '<span class="pd-tiny pd-tp-credit">Map: © OpenStreetMap contributors</span></div>';
    }

    function bindStrip(root, redraw) {
        if (!root || !root.querySelectorAll) return;
        Array.prototype.forEach.call(root.querySelectorAll('[data-tp-pick]'), function (el) {
            el.disabled = busy;
            el.onclick = function () { choose(Number(el.getAttribute('data-tp-pick')), redraw); };
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-tp-altgo]'), function (el) {
            el.onclick = function () {
                var box = root.querySelector('[data-tp-alt]');
                if (pick && box && str(box.value)) { var n = pick.name, o = pick.owner; pick = null; startPick(n, redraw, box.value, o); }
            };
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-tp-leave]'), function (el) {
            el.onclick = function () { leave(redraw); };
        });
    }

    function isBusy() { return busy; }

    return {
        placeKey: placeKey, validPlace: validPlace, inIndia: inIndia,
        setSaved: setSaved, savedPlace: savedPlace, savedNames: savedNames,
        savedError: function () { return savedError; },
        placeText: placeText, kmApart: kmApart,
        startPick: startPick, stripHtml: stripHtml, bindStrip: bindStrip, isBusy: isBusy,
        _test: { choose: choose, leave: leave, state: function () { return pick; },
                 reset: function () { pick = null; busy = false; saved = {}; savedError = ''; } },
    };
}));
