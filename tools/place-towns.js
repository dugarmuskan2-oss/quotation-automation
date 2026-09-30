'use strict';

/**
 * tools/place-towns.js — put the towns already on his cards on the map, once.
 *
 * The in-app "📍 Put on map" places one town at a time as he meets it. This is the one-time
 * pass for the towns already there, run from his computer: about forty lookups at one a second
 * is too long for the live site's 60-second limit.
 *
 *   node tools/place-towns.js                      # look every unplaced town up; save nothing
 *   node tools/place-towns.js --picks picks.json   # save ONLY the picks in that file
 *
 * The first run writes place-towns-found.json: each town with its numbered matches (district
 * and state). He says which one each town is — "Sikandrabad is 2" — and those go in picks.json
 * as { "Sikandrabad": 2 }. A town with no pick is never saved, even with a single match: the
 * map puts the wrong town first often enough that its answer is never taken by itself.
 *
 * Reads the cards and never writes one. Junk in a town box ("CHETNA FACTORY", "2nd Godown"),
 * a state ("Kerala") or a district ("Kutch") is listed for him to fix on the card — never
 * looked up, never tidied here. Writes town-places.json only, in one write, checked after.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const storage = require('../storage');
const towns = require('../utils/towns');
const townPlaces = require('../town-places');
const { CONFIG_KEY_CONTACTS, CONFIG_KEY_CONTACTS_PENDING } = require('../utils/constants');

// The directory's own reading of a town box, so this pass and the app agree on what a town is.
global.window = { location: { origin: 'http://localhost' }, townPlaces };
global.document = { readyState: 'complete', getElementById: () => null, addEventListener: () => {} };
require('../partner-directory.js');
const pd = global.window.partnerDirectory._test;

const FOUND = path.join(process.cwd(), 'place-towns-found.json');
const STATES = /^(andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|orissa|punjab|rajasthan|sikkim|tamil ?nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal)$/i;
const DISTRICTS = /^(kutch)$/i;

const str = (v) => String(v == null ? '' : v).trim();
const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? '' : str(process.argv[i + 1]); };

/** Every town value on every card, sorted into: already measurable, worth a lookup, and not a town. */
async function townsOnCards() {
    const dir = JSON.parse(await storage.readText(CONFIG_KEY_CONTACTS) || '{}');
    const pend = JSON.parse(await storage.readText(CONFIG_KEY_CONTACTS_PENDING) || '{}');
    const cards = (dir.contacts || []).concat((pend.items || []).map((i) => i.preview).filter(Boolean));
    const places = await towns.loadPlaces(storage);
    townPlaces.setSaved(places);
    const out = { placed: new Set(), lookup: new Map(), notATown: new Map() };
    cards.forEach((c) => [c.city].concat((c.branches || []).map((b) => b.city)).map(str).filter(Boolean).forEach((raw) => {
        const at = pd.placeFor(raw);
        if (at && !at.ambiguous) { out.placed.add(at.name); return; }
        if (places[townPlaces.placeKey(raw)]) { out.placed.add(raw); return; }
        const clean = pd.townKey(raw);
        const why = !clean ? 'not a town' : STATES.test(clean) ? 'a state' : DISTRICTS.test(clean) ? 'a district'
            : clean.toLowerCase() !== raw.toLowerCase() && /\b(factory|godown|office|division|plant|works|unit)\b/i.test(raw)
                ? 'extra words in the town box — is it ' + clean + '?' : '';
        if (why || places[townPlaces.placeKey(clean)]) {
            if (why) (out.notATown.get(raw) || out.notATown.set(raw, { why, cards: [] }).get(raw)).cards.push(str(c.company));
            return;
        }
        (out.lookup.get(clean) || out.lookup.set(clean, []).get(clean)).push(str(c.company));
    }));
    return out;
}

async function lookEverythingUp() {
    const t = await townsOnCards();
    console.log('Already measurable: ' + t.placed.size + ' town(s).');
    console.log('\nNot a town — fix these on the card yourself (nothing here changes them):');
    [...t.notATown].forEach(([raw, v]) => console.log('  "' + raw + '" (' + v.why + ') on ' + [...new Set(v.cards)].join(', ')));
    const names = [...t.lookup.keys()].sort();
    console.log('\nLooking up ' + names.length + ' town(s), one a second…');
    const found = {};
    for (const name of names) {
        try {
            found[name] = { cards: [...new Set(t.lookup.get(name))], options: await towns.lookupTown(name) };
        } catch (e) {
            found[name] = { cards: [...new Set(t.lookup.get(name))], options: [], error: e.message };
        }
        const f = found[name];
        console.log('\n' + name + '  (on ' + f.cards.join(', ') + ')');
        if (f.error) console.log('   could not look up: ' + f.error);
        else if (!f.options.length) console.log('   the map knows no town by this name');
        f.options.forEach((o, i) => console.log('   ' + (i + 1) + '. ' + o.name + ' — ' + [o.district, o.state].filter(Boolean).join(', ')));
    }
    fs.writeFileSync(FOUND, JSON.stringify(found, null, 1));
    console.log('\nSaved nothing. The matches are in ' + FOUND + '. Put his picks in a file { "Town": number } and run with --picks.');
}

async function savePicks(file) {
    const found = JSON.parse(fs.readFileSync(FOUND, 'utf8'));
    const picks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = [];
    Object.keys(picks).forEach((name) => {
        const n = Number(picks[name]);
        const opt = found[name] && found[name].options[n - 1];
        if (!opt) { console.log('SKIP ' + name + ': no match number ' + picks[name]); return; }
        const place = towns.placeFromPick(name, opt);
        if (!townPlaces.validPlace(place)) { console.log('SKIP ' + name + ': that match has no position or state'); return; }
        list.push(place);
        console.log('PICK ' + name + ' = ' + opt.name + ', ' + [opt.district, opt.state].filter(Boolean).join(', '));
    });
    if (!list.length) { console.log('\nNothing to save.'); return; }
    await towns.addPlaces(storage, list);
    console.log('\nSaved ' + list.length + ' town(s) to the map list, and read back to check.');
}

(argAfter('--picks') ? savePicks(argAfter('--picks')) : lookEverythingUp())
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
