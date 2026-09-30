'use strict';

/**
 * utils/towns.js — the server's half of placing towns on the map (see town-places.js).
 *
 * town-places.json holds { places: { key: place } }, one entry per town he has placed. It is
 * its own small file, never part of contacts.json, so saving a town can never race an approval
 * of a card, and an approval can never undo a town.
 *
 * The map is OpenStreetMap's free Nominatim service. Its rules: at most one request a second,
 * say who is asking, keep what you learn, never look up as someone types. So a lookup happens
 * only when he presses to place a town, one at a time, from the server — and a town once
 * placed is never looked up again.
 */

const { CONFIG_KEY_TOWN_PLACES } = require('./constants');
const townPlaces = require('../town-places');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Who is asking. The website only — no personal address goes to a service like this.
const USER_AGENT = 'DSC Pipes quotation app (https://quotes.dscpipes.com)';
const GAP_MS = 1100;

const str = (v) => String(v == null ? '' : v).trim();

/** Why a lookup failed, told apart — "busy, try in a minute" and "not reachable" ask for different things. */
class MapError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
}

function parsePlaces(content) {
    if (!content) return {};
    const blob = JSON.parse(content);                 // a broken file throws; it is not "no towns"
    return (blob && blob.places && typeof blob.places === 'object') ? blob.places : {};
}

async function loadPlaces(storage) {
    return parsePlaces(await storage.readText(CONFIG_KEY_TOWN_PLACES));
}

/**
 * Add towns to the list. Storage has no "write only if unchanged", so two saves close together
 * can each read the file before the other writes, and the later write drops the earlier town.
 * Each save therefore checks its OWN towns twice after writing: straight away (another write
 * landed between ours and our read-back) and again a moment later (another write that read
 * before ours landed after our read-back). Missing either time, it adds them again on the fresh
 * copy. It narrows the race to a window of seconds between two people placing towns at once; it
 * cannot close it, and the error says so rather than claiming success.
 */
const SETTLE_MS = 1500;

async function writeAndCheck(storage, list) {
    const places = await loadPlaces(storage);
    list.forEach((p) => { places[townPlaces.placeKey(p.name)] = p; });
    await storage.saveText(CONFIG_KEY_TOWN_PLACES, JSON.stringify({ places }));
}
async function allThere(storage, list) {
    const back = await loadPlaces(storage);
    return list.every((p) => JSON.stringify(back[townPlaces.placeKey(p.name)]) === JSON.stringify(p));
}

async function addPlaces(storage, list, settleMs) {
    if (!list.length || !list.every(townPlaces.validPlace)) throw new Error('a place has no position or state on the map');
    const settle = settleMs == null ? SETTLE_MS : settleMs;
    for (let attempt = 0; attempt < 3; attempt++) {
        await writeAndCheck(storage, list);
        if (!(await allThere(storage, list))) continue;
        await wait(settle);
        if (await allThere(storage, list)) return list;
    }
    throw new Error('the town list kept changing while saving — press again');
}

async function addPlace(storage, place, settleMs) {
    return (await addPlaces(storage, [place], settleMs))[0];
}

/** One map result, cut down to what a pick needs to show and keep. */
function toCandidate(r) {
    const a = r.address || {};
    const name = str(a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || r.name);
    return {
        name,
        district: str(a.state_district || a.county || a.district),
        state: str(a.state),
        lat: Number(r.lat), lon: Number(r.lon),
        osm: str(r.osm_type) + ':' + str(r.osm_id),
        label: str(r.display_name),
    };
}

let lastCall = 0;
let queue = Promise.resolve();
const found = new Map();          // name → candidates, for this server copy only; failures are never kept

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Up to five towns in India the map knows by this name. Never saves anything. */
function lookupTown(name, fetchImpl) {
    const key = townPlaces.placeKey(name);
    if (!key) return Promise.resolve([]);
    if (found.has(key)) return Promise.resolve(found.get(key));
    const run = queue.then(async () => {
        const gap = GAP_MS - (Date.now() - lastCall);
        if (gap > 0) await wait(gap);
        lastCall = Date.now();
        const url = NOMINATIM + '?' + new URLSearchParams({
            q: str(name), countrycodes: 'in', featureType: 'settlement',
            addressdetails: '1', format: 'jsonv2', limit: '5',
        }).toString();
        let res;
        try {
            res = await (fetchImpl || fetch)(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        } catch (e) {
            throw new MapError('unreachable', 'the map could not be reached — the town stays on the card, its distance is not measured yet');
        }
        if (res.status === 429) throw new MapError('busy', 'the map is busy — try again in a minute');
        if (!res.ok) throw new MapError('unreachable', 'the map answered with an error (' + res.status + ') — the town stays on the card, its distance is not measured yet');
        const rows = await res.json();
        // The same town comes back several times (the town, its municipality, its ward), and
        // districts and sub-districts come back as though they were towns. One of each town.
        const seen = new Set();
        const list = (Array.isArray(rows) ? rows : []).map(toCandidate)
            .filter((c) => c.name && c.state && townPlaces.inIndia(c.lat, c.lon))
            .filter((c) => !/\b(sub)?district\b|\bmandal\b|\bcorporation\b|\(m\.?\s?corp\.?\)/i.test(c.name))
            .filter((c) => { const k = [c.name, c.district, c.state].join('|').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        found.set(key, list);
        return list;
    });
    queue = run.catch(() => {});      // one failure must not block the next lookup
    return run;
}

/** A pick from the browser, checked before it is kept. The stored place names no person. */
function placeFromPick(name, c) {
    return {
        name: str(name),
        lat: Number(c && c.lat), lon: Number(c && c.lon),
        state: str(c && c.state), district: str(c && c.district),
        label: str(c && c.label).slice(0, 200),
        source: 'openstreetmap', osm: str(c && c.osm),
        at: new Date().toISOString().slice(0, 10),
    };
}

module.exports = { loadPlaces, addPlace, addPlaces, lookupTown, placeFromPick, MapError, USER_AGENT,
    _test: { toCandidate, parsePlaces, reset: () => { found.clear(); lastCall = 0; queue = Promise.resolve(); } } };
