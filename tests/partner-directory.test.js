/**
 * @jest-environment node
 *
 * tests/partner-directory.test.js
 *
 * The 📇 Partner Directory (partner-directory.js) — the "who should I ask" brain the
 * Freight and Enquiry tabs call into. Everything below runs the REAL shipped module:
 * the browser globals are stubbed, the IIFE is required, and the tests reach in through
 * the `_test` object it already publishes on window.partnerDirectory.
 *
 * What is pinned here, and why each one exists:
 *
 *  1. THE RANKING BIAS. scoreDistance used to score an UNKNOWN city 0 and a far one -10,
 *     so a card you had taken the trouble to fill in ranked below every blank one — live,
 *     the only partner with a city came 9th of 9. A blank city is now a PENALTY (-5), and
 *     the gaps between near / unknown / far are asserted, because the *ordering* alone
 *     reads identically under the old broken numbers.
 *
 *  2. THE ENQUIRY READER. Rule five of CLAUDE.md: a number is never guessed. Metres turn
 *     into tonnes only when the size AND the class are both given and the size is in the
 *     kg/m table; anything else leaves the weight unknown rather than assuming one.
 *
 *  3. MINIMUM ORDER. The owner's exact instruction: "show minimum but do not NOT show an
 *     option because it is below its minimum." Under a minimum SINKS a partner; it must
 *     never hide them, or the one firm who would have stretched never gets asked.
 *
 *  4. WHO GETS SCORED AT ALL — the pool filter, the pipe-type match (the only rule that
 *     rules anyone out), and the transporter rules, which decide who receives a real
 *     freight enquiry email.
 *
 *  5. GEOGRAPHY, applyFind, and the history/notes points.
 *
 *  6. THE SUGGESTION PANEL, driven for real through a fake container — no DOM needed,
 *     because the panel only ever assigns innerHTML. This is what pins the unconditional
 *     re-read, the failed-load state, and esc().
 *
 * Every score assertion below is a GAP between two fixtures that differ in exactly one
 * field, so the rule's point value is pinned, not just the ordering it happens to produce.
 *
 * The per-firm Cc/Bcc email rule is NOT retested here — tests/cc-bcc-send.test.js owns it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'partner-directory.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

// ── Load the browser module the way the browser does ──────────────────────────
// The IIFE touches document.readyState at load time and hangs its API off window.
// FETCH is swapped per test so the load path can be driven both ways for real.
let FETCH = () => Promise.reject(new Error('no network in unit tests'));

global.window = { location: { origin: 'http://localhost:3000' } };
global.document = { readyState: 'complete', getElementById: () => null, addEventListener: () => {} };
global.fetch = function () { return FETCH.apply(null, arguments); };

require('../partner-directory.js');

const { readEnquiry, rankFor, matchCity, kmBetween, applyFind, _state } = global.window.partnerDirectory._test;
const { renderSuggestPanel } = global.window.partnerDirectory;
const D = _state().D;

const TODAY = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** Let every queued promise callback run (all microtasks drain before setImmediate). */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * A partner in the shape utils/contacts.js sanitizePartner actually produces — every
 * field present, arrays never undefined. A fixture the server could not emit is a fake
 * test, so this mirrors sanitizePartner field for field.
 */
function partner(over) {
    return Object.assign({
        id: 'p_' + Math.random().toString(36).slice(2, 9),
        role: 'dealer',
        roleOther: '',
        company: 'Unnamed',
        people: [{
            name: 'R Kumar', role: 'Sales',
            phones: [{ label: 'Mobile', v: '9840012345' }],
            emails: [{ label: 'Work', v: 'sales@example.co.in' }],
        }],
        city: '',
        address: '',
        branches: [],
        types: ['ERW'],
        moq: 0,
        products: [],
        rules: [],
        routes: [],
        vehicles: '',
        partLoad: true,
        notes: [],
        images: [],
        fromEnquiry: false,
        fromWeb: false,
        enq: 0,
        rep: 0,
        last: '',
        checked: TODAY,
    }, over || {});
}

function setContacts(list) {
    D.contacts = list;
    D.changes = [];
    D.pending = [];
    D.loaded = true;
    D.loadError = '';
    D.saveError = '';
}

/** The enquiry every ranking test below is scored against: 1.53 T of ERW into Chennai. */
const ENQUIRY = '300 mtr of 2 inch ERW medium, delivery at Chennai';

function scoresByCompany(rows) {
    const out = {};
    rows.forEach((r) => { out[r.p.company] = r.score; });
    return out;
}
function reasonMatching(row, re) {
    return (row.why || []).filter((w) => re.test(w[1]))[0] || null;
}
function rowFor(rows, company) {
    return rows.filter((r) => r.p.company === company)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The ranking bias — a filled-in card must beat a blank one
// ─────────────────────────────────────────────────────────────────────────────

describe('rankFor — where a partner is beats not knowing where they are', () => {
    // Three partners identical in every single field except the city. Live, the one
    // partner who HAD a city ranked 9th of 9 behind eight blank cards, because an
    // unknown city scored 0 while a far one scored -10. A blank card must cost you.
    const three = () => [
        partner({ id: 'p_far', company: 'FarCo', city: 'Delhi' }),
        partner({ id: 'p_blank', company: 'BlankCo', city: '' }),
        partner({ id: 'p_near', company: 'NearCo', city: 'Chennai' }),
    ];

    test('near city ranks above no city, which ranks above a far city', () => {
        setContacts(three());
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        expect(rows.map((r) => r.p.company)).toEqual(['NearCo', 'BlankCo', 'FarCo']);

        // The ordering alone is NOT enough: it reads the same under the old numbers
        // (unknown 0, far -10). The gaps are what pin the rule. Everything except the
        // distance term is identical across the three, so the other terms cancel.
        const s = scoresByCompany(rows);
        expect(s.BlankCo - s.FarCo).toBe(5);    // blank -5 vs far -10
        expect(s.NearCo - s.BlankCo).toBe(40);  // near +35 vs blank -5
    });

    test('a middle-distance branch is worth less than being on the doorstep', () => {
        // 35 for ≤60 km, 20 for ≤250 km. Without this the whole distance rule collapses
        // into "same city or not", and a Vellore dealer reads the same as a Delhi one.
        setContacts([
            partner({ company: 'NearCo', city: 'Chennai' }),
            partner({ company: 'MidCo', city: 'Vellore' }),   // ~160 km, inside 250
        ]);
        const s = scoresByCompany(rankFor('material', readEnquiry(ENQUIRY)));
        expect(s.NearCo - s.MidCo).toBe(15);
    });

    test('a blank city is scored as a penalty, never as "distance not used"', () => {
        // Same fixture, same city gap — but expressed as the thing the user reads. The
        // old code pushed a NEUTRAL note here, which told nobody their card was costing
        // them a place. It has to read as a warning worth acting on.
        setContacts(three());
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        const line = reasonMatching(rowFor(rows, 'BlankCo'), /No city on their card/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('warn');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reading a typed enquiry — a number is NEVER guessed
// ─────────────────────────────────────────────────────────────────────────────

describe('readEnquiry — what the finder box understands', () => {
    test('metres become tonnes when the size AND the class are both given', () => {
        // 300 m of 2" NB medium at 5.10 kg/m (the module's own KGM table) = 1.53 T.
        const need = readEnquiry(ENQUIRY);
        expect(need.types).toEqual(['ERW']);
        expect(need.site).toBe('Chennai');
        expect(need.siteAssumed).toBe(false);
        expect(need.known).toBe(true);
        expect(need.tons).toBeCloseTo(1.53, 6);
        expect(need.items).toHaveLength(1);
        expect(need.items[0].kg).toBeCloseTo(1530, 6);
        expect(need.items[0].product).toBe('ERW medium');
    });

    test('metres with NO class leave the weight unknown — no default class is assumed', () => {
        // Light / medium / heavy are 4.10 / 5.10 / 6.20 kg/m at 2" — picking one for the
        // user would put a made-up 20% either way into a minimum-order decision.
        const need = readEnquiry('300 mtr of 2 inch ERW, delivery at Chennai');
        expect(need.types).toEqual(['ERW']);
        expect(need.items).toHaveLength(1);
        expect(need.items[0].kg).toBeNull();
        expect(need.known).toBe(false);
        expect(need.tons).toBe(0);
    });

    test('a size the kg/m table does not hold leaves the weight unknown', () => {
        // 10" is not in the heavy table. No nearest-size fudge, no 6 m pipe-length guess.
        const need = readEnquiry('300 mtr of 10 inch ERW heavy, delivery at Chennai');
        expect(need.items).toHaveLength(1);
        expect(need.items[0].inches).toBe(10);
        expect(need.items[0].kg).toBeNull();
        expect(need.known).toBe(false);
        expect(need.tons).toBe(0);
    });

    test('a weight already given in tonnes or kg is taken exactly as written', () => {
        const mt = readEnquiry('5 MT of 2 inch GI heavy to Madurai');
        expect(mt.types).toEqual(['GI']);
        expect(mt.site).toBe('Madurai');
        expect(mt.known).toBe(true);
        expect(mt.tons).toBeCloseTo(5, 6);

        const kg = readEnquiry('2500 kg of 2 inch GI heavy to Madurai');
        expect(kg.known).toBe(true);
        expect(kg.tons).toBeCloseTo(2.5, 6);
    });

    test('an unreadable enquiry is flagged empty, so the UI can search by name instead', () => {
        // "Annai Steel" is a company someone is looking for, not an enquiry. Scoring it
        // as an enquiry would rank the whole directory against nothing at all.
        expect(readEnquiry('Annai Steel Traders').empty).toBe(true);
        expect(readEnquiry('').empty).toBe(true);
        expect(readEnquiry(ENQUIRY).empty).toBe(false);
    });

    test('every kg/m the table holds is the real IS/ASTM figure, not a rounded stand-in', () => {
        // One cell being right proves nothing about the rest — these are the numbers a
        // minimum-order decision and a lorry booking are both made from.
        const cases = [
            ['100 mtr of 1 inch GI light to Chennai', 200],        // l 1"    = 2.00
            ['100 mtr of 4 inch GI medium to Chennai', 1220],      // m 4"    = 12.20
            ['100 mtr of 6 inch GI heavy to Chennai', 2290],       // h 6"    = 22.90
            ['100 mtr of 8 inch seamless sch 40 to Chennai', 4255], // sch40 8" = 42.55
            ['100 mtr of 3 inch seamless sch 80 to Chennai', 1527], // sch80 3" = 15.27
        ];
        cases.forEach(([text, kg]) => {
            expect([text, readEnquiry(text).items[0].kg]).toEqual([text, kg]);
        });
    });

    test('half-inch and quarter-inch sizes are read as fractions, not as whole numbers', () => {
        // '1-1/2 inch' read as 1 would pull 2.44 kg/m instead of 3.61 — a 33% wrong weight
        // that nothing downstream would question.
        const half = readEnquiry('200 mtr of 1-1/2 inch GI medium to Chennai');
        expect(half.items[0].inches).toBe(1.5);
        expect(half.items[0].kg).toBeCloseTo(722, 6);

        const quarter = readEnquiry('400 mtr of 3/4 inch GI light to Chennai');
        expect(quarter.items[0].inches).toBe(0.75);
        expect(quarter.items[0].kg).toBeCloseTo(560, 6);
    });

    test('a schedule number reads as seamless, and prices off the schedule table', () => {
        // Only ERW and GI used to be exercised. 'sch 40' must both pick the pipe type
        // (which decides who is even offered) and pick the sch-40 kg/m column.
        const need = readEnquiry('100 mtr of 2 inch seamless sch 40 to Chennai');
        expect(need.types).toEqual(['Seamless']);
        expect(need.items[0].product).toBe('Seamless sch 40');
        expect(need.items[0].kg).toBeCloseTo(544, 6);   // sch 40 2" = 5.44 kg/m
    });

    test('stainless is recognised, and has no kg/m table — so its weight stays unknown', () => {
        // SS is in PIPE_TYPES but not in KGM. It must still route to SS suppliers, and
        // must NOT quietly borrow the ERW medium figure.
        const need = readEnquiry('100 mtr of 2 inch SS 304 pipe to Chennai');
        expect(need.types).toEqual(['SS']);
        expect(need.items[0].kg).toBeNull();
        expect(need.known).toBe(false);
    });

    test('no place named means Chennai, and it is flagged as an assumption', () => {
        // The site drives the whole distance rule. Falling back to HOME is fine; hiding
        // that it was a fallback is not — the read-back line has to say "assumed".
        const assumed = readEnquiry('300 mtr of 2 inch ERW medium');
        expect(assumed.site).toBe('Chennai');
        expect(assumed.siteAssumed).toBe(true);

        const named = readEnquiry('300 mtr of 2 inch ERW medium, delivery at Madurai');
        expect(named.site).toBe('Madurai');
        expect(named.siteAssumed).toBe(false);
    });

    test('a transport enquiry is flagged for freight; a plain material one is not', () => {
        // need.freight is what decides whether transporters are ranked at all. If it were
        // always false, no lorry would ever be suggested and nobody would see an error.
        const lorry = readEnquiry('lorry from Chennai to Madurai, 12 MT');
        expect(lorry.freight).toBe(true);
        expect(lorry.pickup).toBe('Chennai');
        expect(lorry.site).toBe('Madurai');
        expect(readEnquiry(ENQUIRY).freight).toBe(false);
    });

    test('a transport-only enquiry still gets its weight from the tonnes in the text', () => {
        // Nothing here parses as a pipe line, so the per-item weights are empty and the
        // ONLY thing that gives this enquiry a weight is the whole-text tonnes fallback.
        // Without it need.known is false and part-load vs full-truck is never scored.
        const need = readEnquiry('lorry to Chennai, 12 MT');
        expect(need.items).toHaveLength(0);
        expect(need.known).toBe(true);
        expect(need.tons).toBeCloseTo(12, 6);
    });

    test('a quantity in one clause and the size in the next are folded into one line', () => {
        // "12 MT seamless sch 80, 6 inch" is how a customer actually types it. Unfolded,
        // it reads as two lines — one with a weight and no size, one with a size and no
        // weight — and every per-product minimum is then checked against the wrong row.
        const need = readEnquiry('12 MT seamless sch 80, 6 inch');
        expect(need.items).toHaveLength(1);
        expect(need.items[0].inches).toBe(6);
        expect(need.items[0].kg).toBeCloseTo(12000, 6);
        expect(need.items[0].product).toBe('Seamless sch 80');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Minimum order — show it, do not hide the partner because of it
// ─────────────────────────────────────────────────────────────────────────────

describe('rankFor — a minimum order sinks a partner, it never hides them', () => {
    const underOverall = () => partner({ id: 'p_moq', company: 'BigMinCo', city: 'Chennai', moq: 25 });
    const clears = () => partner({ id: 'p_ok', company: 'NoMinCo', city: 'Chennai', moq: 0 });

    test('a firm-wide minimum above the enquiry weight still comes back in the list', () => {
        setContacts([underOverall(), clears()]);
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        const names = rows.map((r) => r.p.company);
        expect(names).toContain('BigMinCo');
        expect(names).toHaveLength(2);
    });

    test('…flagged with the actual numbers, and not ruled out', () => {
        setContacts([underOverall()]);
        const row = rankFor('material', readEnquiry(ENQUIRY))[0];
        expect(row.blocked).toBe(false);
        const line = reasonMatching(row, /minimum/i);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('warn');
        expect(line[1]).toContain('25 T');
        expect(line[1]).toContain('1.53 T');
    });

    test('…and it costs them their place against an otherwise identical firm', () => {
        // -30 for being under, +10 for clearing it: a 40-point gap. The gap is asserted,
        // not just the ordering, or zeroing the penalty would still "pass".
        setContacts([underOverall(), clears()]);
        const s = scoresByCompany(rankFor('material', readEnquiry(ENQUIRY)));
        expect(s.NoMinCo - s.BigMinCo).toBe(40);
    });

    test('a PRODUCT minimum sinks them by the same 55 points, named, and still offered', () => {
        // The per-product minimum is the one that actually bites: a dealer will happily
        // sell 1 T of GI and refuse 1 T of seamless off the same card. Two cards identical
        // to the last character except this one number, so the gap IS the rule (+25 for
        // clearing it, -30 for missing it).
        const prod = (moq) => ({
            p: 'ERW pipe', spec: 'IS 1239 Medium', moq: moq, rule: 'GST 18% extra',
            sizes: [{ nb: '50', inch: '2"', od: '60.3', thk: '3.6' }],
        });
        setContacts([
            partner({ id: 'p_hi', company: 'ProdMinCo', city: 'Chennai', products: [prod(25)] }),
            partner({ id: 'p_lo', company: 'ProdOkCo', city: 'Chennai', products: [prod(1)] }),
        ]);
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        expect(rows.map((r) => r.p.company)).toEqual(['ProdOkCo', 'ProdMinCo']);
        const s = scoresByCompany(rows);
        expect(s.ProdOkCo - s.ProdMinCo).toBe(55);

        const sunk = rowFor(rows, 'ProdMinCo');
        expect(sunk.blocked).toBe(false);
        const line = reasonMatching(sunk, /minimum/i);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('warn');
        expect(line[1]).toContain('ERW pipe needs 25 T');
    });

    test('with no weight worked out, the minimum is reported as UNCHECKED, not as passed', () => {
        // Saying "no minimum in the way" when we never worked out a weight is a guessed
        // number wearing a sentence.
        setContacts([underOverall()]);
        const row = rankFor('material', readEnquiry('2 inch ERW, delivery at Chennai'))[0];
        const line = reasonMatching(row, /minimum/i);
        expect(line).not.toBeNull();
        expect(line[1]).toContain('not checked');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Who gets scored at all — the pool, the pipe type, the transporter rules
// ─────────────────────────────────────────────────────────────────────────────

describe('rankFor — only the right kind of firm is offered', () => {
    const mixed = () => [
        partner({ company: 'DealerCo', role: 'dealer', city: 'Chennai' }),
        partner({ company: 'MakerCo', role: 'manufacturer', city: 'Chennai' }),
        partner({ company: 'TransCo', role: 'transporter', city: 'Chennai', routes: [{ from: 'Chennai', to: 'Chennai' }] }),
        partner({ company: 'FabCo', role: 'fabricator', city: 'Chennai' }),
        partner({ company: 'OtherCo', role: 'other', city: 'Chennai' }),
    ];

    test('a pipe enquiry goes to dealers and manufacturers — nobody else', () => {
        // A fabricator or a lorry firm turning up as a pipe supplier is an email to the
        // wrong company on the owner's letterhead.
        setContacts(mixed());
        const names = rankFor('material', readEnquiry(ENQUIRY)).map((r) => r.p.company).sort();
        expect(names).toEqual(['DealerCo', 'MakerCo']);
    });

    test('a transport enquiry goes to transporters — nobody else', () => {
        setContacts(mixed());
        const names = rankFor('transport', readEnquiry('lorry from Chennai to Chennai, 12 MT'), 'Chennai')
            .map((r) => r.p.company);
        expect(names).toEqual(['TransCo']);
    });
});

describe('scoreTypes — dealing in the pipe type is the only thing that rules anyone out', () => {
    // One enquiry wanting BOTH types, so full / partial / none are all reachable off one
    // fixture set. Everything but `types` is identical, so each gap is the type rule alone.
    const twoTypes = () => readEnquiry('300 mtr of 2 inch ERW medium and 100 mtr of 2 inch GI heavy, delivery at Chennai');
    const four = () => [
        partner({ company: 'BothCo', city: 'Chennai', types: ['ERW', 'GI'] }),
        partner({ company: 'HalfCo', city: 'Chennai', types: ['ERW'] }),
        partner({ company: 'BlankTypesCo', city: 'Chennai', types: [] }),
        partner({ company: 'WrongCo', city: 'Chennai', types: ['SS'] }),
    ];

    test('both types beats one type beats an empty card, by 20 points each time', () => {
        setContacts(four());
        const s = scoresByCompany(rankFor('material', twoTypes()));
        expect(s.BothCo - s.HalfCo).toBe(20);        // 40 vs 20
        expect(s.HalfCo - s.BlankTypesCo).toBe(20);  // 20 vs 0
    });

    test('a firm that does not stock the type is BLOCKED and sunk below everyone', () => {
        // This is the one and only verdict in the whole ranking. If blocked came back
        // false, a firm that has never sold ERW would be suggested first and the owner
        // would have no way to tell.
        setContacts(four());
        const rows = rankFor('material', twoTypes());
        const wrong = rowFor(rows, 'WrongCo');
        expect(wrong.blocked).toBe(true);
        expect(wrong.score).toBeLessThan(-900);              // -999 puts them last, always
        expect(rows[rows.length - 1].p.company).toBe('WrongCo');
        const line = reasonMatching(wrong, /Does not deal in/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('bad');
    });

    test('being ruled out does not remove them from the list — the owner can overrule it', () => {
        // "Show minimum but do not NOT show an option" applies here too: the ruled-out
        // row is still returned, so the UI can print it under "you can overrule this".
        setContacts([partner({ company: 'WrongCo', city: 'Chennai', types: ['SS'] })]);
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        expect(rows).toHaveLength(1);
        expect(rows[0].blocked).toBe(true);
    });

    test('with no pipe type in the enquiry, the type rule scores nothing at all', () => {
        // Two enquiries into the same city at the same 12 T, differing only in whether a
        // pipe type is named. The gap must be the full 40, i.e. the no-type branch is 0 —
        // handing out points for a match that never happened is a guessed number.
        const one = partner({ company: 'DealerCo', city: 'Chennai', types: ['ERW'] });
        setContacts([one]);
        const typed = rankFor('material', readEnquiry('12 MT of 2 inch ERW heavy to Chennai'))[0];
        setContacts([one]);
        const untyped = rankFor('material', readEnquiry('lorry to Chennai, 12 MT'))[0];

        expect(typed.score - untyped.score).toBe(40);
        expect(reasonMatching(untyped, /No pipe type given/)).not.toBeNull();
    });
});

describe('scoreTransporter — who actually gets the freight enquiry', () => {
    // Chennai → Madurai, 1.53 T (a part load). Five carriers identical except the one
    // field each is meant to prove.
    const need = () => readEnquiry('lorry from Chennai to Madurai, 1.53 MT');
    const carriers = () => [
        partner({ company: 'ExactCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }] }),
        partner({ company: 'FromOnlyCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Salem' }] }),
        partner({ company: 'PanCo', role: 'transporter', routes: [], city: 'Pan India' }),
        partner({ company: 'FullOnlyCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }], partLoad: false }),
        partner({ company: 'ElsewhereCo', role: 'transporter', routes: [{ from: 'Delhi', to: 'Mumbai' }] }),
    ];

    test('running the exact route is worth more than loading from the right city', () => {
        // 45 for the exact route, 22 for the right pickup only, 8 for a national network.
        // The gaps are asserted because the order alone survives flattening all three.
        setContacts(carriers());
        const s = scoresByCompany(rankFor('transport', need(), 'Chennai'));
        expect(s.ExactCo - s.FromOnlyCo).toBe(23);
        expect(s.FromOnlyCo - s.PanCo).toBe(14);
        expect(reasonMatching(rowFor(rankFor('transport', need(), 'Chennai'), 'ExactCo'), /Runs Chennai → Madurai regularly/)).not.toBeNull();
    });

    test('a carrier who does not run the route at all is BLOCKED, not merely last', () => {
        // Blocked is what moves them under "not suggested — but shown". If this went soft,
        // a Delhi–Mumbai fleet would be offered a Chennai–Madurai load as a live option.
        setContacts(carriers());
        const rows = rankFor('transport', need(), 'Chennai');
        const out = rowFor(rows, 'ElsewhereCo');
        expect(out.blocked).toBe(true);
        expect(out.score).toBeLessThan(-900);
        const line = reasonMatching(out, /Does not run Chennai → Madurai/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('bad');
    });

    test('a full-load-only fleet is sunk 55 points on a part load, and told why', () => {
        // Same route, same everything — only partLoad differs. 25 for taking a part load
        // against -30 for not. Sending 1.5 T to a full-load-only fleet wastes a day.
        setContacts(carriers());
        const rows = rankFor('transport', need(), 'Chennai');
        const s = scoresByCompany(rows);
        expect(s.ExactCo - s.FullOnlyCo).toBe(55);
        const line = reasonMatching(rowFor(rows, 'FullOnlyCo'), /Full loads only/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('warn');
    });

    test('a full truck scores as their strength, not as a part load', () => {
        // Same carrier, two weights. 12 T is +15 (a full truck); 1.53 T is +25 (a part
        // load they accept) — so the same firm scores 10 LOWER on the bigger job.
        const one = () => [partner({ company: 'ExactCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }] })];
        setContacts(one());
        const part = rankFor('transport', readEnquiry('lorry from Chennai to Madurai, 1.53 MT'), 'Chennai')[0];
        setContacts(one());
        const full = rankFor('transport', readEnquiry('lorry from Chennai to Madurai, 12 MT'), 'Chennai')[0];

        expect(part.score - full.score).toBe(10);
        expect(reasonMatching(full, /is a full truck/)).not.toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. History, notes and the firm-wide rules that ride along
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreHistoryAndNotes — what dealing with them before is worth', () => {
    const base = (over) => partner(Object.assign({ city: 'Chennai' }, over));

    test('a firm that answers is worth 20 points over one that never does', () => {
        // Reply rate × 20. Both asked 10 times, both dealt with recently — only the
        // replies differ, so the gap is the reply-rate term on its own.
        setContacts([
            base({ company: 'RepliesCo', enq: 10, rep: 10, last: day(5) }),
            base({ company: 'SilentCo', enq: 10, rep: 0, last: day(5) }),
        ]);
        const s = scoresByCompany(rankFor('material', readEnquiry(ENQUIRY)));
        expect(s.RepliesCo - s.SilentCo).toBe(20);
    });

    test('dealing with them inside four months is worth 10 more than a year ago', () => {
        // Identical history, identical reply rate (nil); only `last` differs, across the
        // 120-day line. A firm you have not used since last year may not even trade now.
        setContacts([
            base({ company: 'RecentCo', enq: 10, rep: 0, last: day(5) }),
            base({ company: 'LapsedCo', enq: 10, rep: 0, last: day(400) }),
        ]);
        const s = scoresByCompany(rankFor('material', readEnquiry(ENQUIRY)));
        expect(s.RecentCo - s.LapsedCo).toBe(10);
        expect(reasonMatching(rowFor(rankFor('material', readEnquiry(ENQUIRY)), 'LapsedCo'), /not lately/)).not.toBeNull();
    });

    test('a card nobody has touched in six months says so before you quote off it', () => {
        // A rate or a minimum read off a two-year-old card is how a quote goes out wrong.
        setContacts([base({ company: 'StaleCo', checked: day(400) })]);
        const line = reasonMatching(rankFor('material', readEnquiry(ENQUIRY))[0], /worth confirming/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('warn');
        expect(line[1]).toContain('1 year ago');   // the `ago` wording, not a raw date
    });

    test('firm-wide price rules ride along on every suggestion', () => {
        // "GST 18% extra" lives once on the card and must appear on every enquiry to that
        // firm — a rule the owner has to remember is a rule that gets forgotten in a quote.
        setContacts([base({ company: 'RuleCo', rules: ['GST 18% extra'] })]);
        const line = reasonMatching(rankFor('material', readEnquiry(ENQUIRY))[0], /GST 18% extra/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('note');
        expect(line[1]).toBe('Applies to everything: GST 18% extra');
    });

    test('your latest note is quoted back with how old it is', () => {
        // The age is the point: "lead time 10 days" from last week and from two years ago
        // are different facts, and the sentence has to let you tell them apart.
        setContacts([base({ company: 'NoteCo', notes: [{ d: day(5), t: 'Lead time 10 days', src: '' }] })]);
        const line = reasonMatching(rankFor('material', readEnquiry(ENQUIRY))[0], /Lead time 10 days/);
        expect(line).not.toBeNull();
        expect(line[1]).toBe('Your note (5 days ago): Lead time 10 days');
    });

    test('a firm never asked through the app is stated as such, and scores nothing', () => {
        setContacts([
            base({ company: 'NeverCo' }),
            base({ company: 'SilentCo', enq: 10, rep: 0, last: day(400) }),
        ]);
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        const s = scoresByCompany(rows);
        expect(s.NeverCo - s.SilentCo).toBe(0);
        expect(reasonMatching(rowFor(rows, 'NeverCo'), /Never asked through the app/)).not.toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Geography
// ─────────────────────────────────────────────────────────────────────────────

describe('matchCity — pulling a known city out of a typed address', () => {
    test('a known city is returned in the module\'s own spelling, whatever the case', () => {
        expect(matchCity('DSC Warehouse, Ambattur, chennai 600058')).toBe('Chennai');
        expect(matchCity('CHENNAI')).toBe('Chennai');
    });

    test('the longest city wins when two names are in the same line', () => {
        // "Hosur Road, Bangalore" is a Bangalore address; taking Hosur would move the
        // delivery point 40 km and change which branch counts as nearest.
        expect(matchCity('Hosur Road, Bangalore')).toBe('Bangalore');
    });

    test('a city the module does not know is not invented', () => {
        // Callers use `matchCity(x) || x`, so a blank here means "pass the typed text
        // through unchanged" — never a wrong-but-known city.
        expect(matchCity('Erode')).toBe('');
        expect(matchCity('')).toBe('');
    });
});

describe('kmBetween — road distance between two known cities', () => {
    test('Chennai to Bangalore is a few hundred km, not a straight-line understatement', () => {
        // ~290 km as the crow flies; the module bills road distance at ×1.25.
        const km = kmBetween('Chennai', 'Bangalore');
        expect(km).toBeGreaterThan(300);
        expect(km).toBeLessThan(420);
    });

    test('the same city is zero, and a pan-India carrier is everywhere', () => {
        expect(kmBetween('Chennai', 'Chennai')).toBe(0);
        expect(kmBetween('Pan India', 'Chennai')).toBe(0);
    });

    test('an unknown city is null — never a distance made up from nothing', () => {
        expect(kmBetween('Erode', 'Chennai')).toBeNull();
        expect(kmBetween('Chennai', 'Erode')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. applyFind — a reviewed line off a brochure lands on the right card
// ─────────────────────────────────────────────────────────────────────────────

describe('applyFind — writes what it mentions, keeps what it does not', () => {
    const existing = () => partner({
        id: 'p_ann', company: 'Annai Steel Traders', city: 'Chennai',
        types: ['GI', 'ERW'], moq: 5,
        products: [
            { p: 'GI pipe', spec: 'IS 1239 Heavy', moq: 2, rule: '', sizes: [] },
            { p: 'ERW pipe', spec: 'old spec', moq: 0, rule: '', sizes: [] },
        ],
        routes: [{ from: 'Chennai', to: 'Madurai' }],
        notes: [{ d: '2026-01-04', t: 'Pays on 30 days', src: '' }],
    });

    test('a plain field find updates that one field and nothing else', () => {
        const p = existing();
        const before = JSON.parse(JSON.stringify(p));
        applyFind(p, { kind: 'field', key: 'city', value: 'Coimbatore' }, 'card.jpg');
        expect(p.city).toBe('Coimbatore');
        expect(p.company).toBe(before.company);
        expect(p.types).toEqual(before.types);
        expect(p.products).toEqual(before.products);
        expect(p.notes).toEqual(before.notes);
        expect(p.people).toEqual(before.people);
    });

    test('an email find ADDS addresses — the ones already on the card survive', () => {
        // Overwriting here would silently drop the address enquiries have been going to
        // for months, and nothing on screen would say so.
        const p = existing();
        applyFind(p, { kind: 'field', key: 'email', value: 'accounts@annai.co.in; ap@annai.co.in' }, 'card.jpg');
        const got = p.people[0].emails.map((e) => e.v);
        expect(got).toEqual(['sales@example.co.in', 'accounts@annai.co.in', 'ap@annai.co.in']);
        expect(p.people[0].name).toBe('R Kumar');
        expect(p.people[0].phones).toHaveLength(1);
    });

    test('the same email find twice does not double the address', () => {
        const p = existing();
        applyFind(p, { kind: 'field', key: 'email', value: 'accounts@annai.co.in' }, 'card.jpg');
        applyFind(p, { kind: 'field', key: 'email', value: 'accounts@annai.co.in' }, 'card.jpg');
        expect(p.people[0].emails.map((e) => e.v)).toEqual(['sales@example.co.in', 'accounts@annai.co.in']);
    });

    test('a phone find is added to the main person, labelled, alongside the one there', () => {
        const p = existing();
        applyFind(p, { kind: 'field', key: 'phone', value: '9445566778' }, 'card.jpg');
        expect(p.people[0].phones).toEqual([
            { label: 'Mobile', v: '9840012345' },
            { label: 'Mobile', v: '9445566778' },
        ]);
    });

    test('a person find renames the main contact without touching their numbers', () => {
        const p = existing();
        applyFind(p, { kind: 'field', key: 'person', value: 'S Balaji' }, 'card.jpg');
        expect(p.people[0].name).toBe('S Balaji');
        expect(p.people[0].emails).toHaveLength(1);
        expect(p.people[0].phones).toHaveLength(1);
    });

    test('a types find is split into the list the ranking reads, not stored as one string', () => {
        // scoreTypes matches ['GI','Seamless'] item by item. Left as "GI / Seamless" it
        // matches nothing, and the firm is ruled out of every enquiry they can supply.
        const p = existing();
        applyFind(p, { kind: 'field', key: 'types', value: 'GI / Seamless' }, 'card.jpg');
        expect(p.types).toEqual(['GI', 'Seamless']);
    });

    test('a branches find becomes real branch rows, with the city spelled the module\'s way', () => {
        // The distance rule measures the nearest BRANCH. A branch stored as a bare string
        // is invisible to it, and a mis-spelled city has no coordinates.
        const p = existing();
        applyFind(p, { kind: 'field', key: 'branches', value: 'coimbatore; Erode' }, 'card.jpg');
        expect(p.branches).toEqual([
            { city: 'Coimbatore', area: '', address: '' },
            { city: 'Erode', area: '', address: '' },
        ]);
    });

    test('a minimum-order find is stored as a number, and junk becomes zero not NaN', () => {
        // p.moq feeds the minimum rule directly — "25 T" left as text compares wrong, and
        // NaN would make every comparison silently false.
        const p = existing();
        applyFind(p, { kind: 'field', key: 'moq', value: '25 T' }, 'card.jpg');
        expect(p.moq).toBe(25);
        applyFind(p, { kind: 'field', key: 'moq', value: 'on request' }, 'card.jpg');
        expect(p.moq).toBe(0);
    });

    test('a role find is lower-cased, because the pool filter compares it exactly', () => {
        // rankFor filters on p.role === 'transporter'. Stored as "Transporter" they are
        // never offered a load again.
        const p = existing();
        applyFind(p, { kind: 'field', key: 'role', value: 'Transporter' }, 'card.jpg');
        expect(p.role).toBe('transporter');
    });

    test('a product find replaces the product of that name, and only that one', () => {
        const p = existing();
        applyFind(p, {
            kind: 'product', label: 'Product', value: 'ERW pipe — IS 1239 Medium',
            product: { p: 'ERW pipe', spec: 'IS 1239 Medium', sizes: [], moq: 25, rule: 'GST 18% extra' },
        }, 'brochure.pdf');
        expect(p.products).toHaveLength(2);
        expect(p.products[0]).toEqual({ p: 'GI pipe', spec: 'IS 1239 Heavy', moq: 2, rule: '', sizes: [] });
        expect(p.products[1]).toEqual({ p: 'ERW pipe', spec: 'IS 1239 Medium', sizes: [], moq: 25, rule: 'GST 18% extra' });
    });

    test('a routes find adds only the routes that are new', () => {
        const p = existing();
        applyFind(p, {
            kind: 'routes', label: 'Route', value: 'Chennai → Salem',
            routes: [{ from: 'Chennai', to: 'Madurai' }, { from: 'Chennai', to: 'Salem' }],
        }, 'brochure.pdf');
        expect(p.routes).toEqual([{ from: 'Chennai', to: 'Madurai' }, { from: 'Chennai', to: 'Salem' }]);
    });

    test('a note find goes on top and records which file it came from', () => {
        // Every note is dated and sourced so an old machine-read fact can be told apart
        // from something the owner was told on the phone this week.
        const p = existing();
        applyFind(p, { kind: 'note', value: 'Lead time 10 days, not 5' }, 'brochure.pdf');
        expect(p.notes).toHaveLength(2);
        expect(p.notes[0].t).toBe('Lead time 10 days, not 5');
        expect(p.notes[0].src).toBe('read from brochure.pdf');
        expect(p.notes[0].d).toBe(TODAY);
        expect(p.notes[1]).toEqual({ d: '2026-01-04', t: 'Pays on 30 days', src: '' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The in-quote suggestion panel, driven for real
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The panel never reads the DOM — it only assigns innerHTML and then asks the container
 * for elements to bind. A plain object is therefore a good enough container, and these
 * are real behaviour tests rather than source guards.
 */
function fakeBox() { return { innerHTML: '', querySelectorAll: () => [] }; }
const PANEL_OPTS = { kind: 'material', types: ['ERW'], items: [], kg: 1530, drop: 'Chennai' };

describe('renderSuggestPanel — it re-reads the directory every single time', () => {
    afterEach(() => { FETCH = () => Promise.reject(new Error('no network in unit tests')); });

    test('a cached directory is not good enough — the panel refetches and shows the failure', async () => {
        // The panel is asked for by hand and what comes out of it is a real email to a
        // real firm, so a partner a colleague has changed or deleted must not be offered
        // from memory. Loaded-and-cached is exactly the state a short-circuit would hit:
        // if the fetch is skipped the cached firm is rendered instead of the error.
        setContacts([partner({ company: 'CachedCo', city: 'Chennai' })]);
        FETCH = () => Promise.reject(new Error('offline'));

        const box = fakeBox();
        renderSuggestPanel(box, PANEL_OPTS, () => {});
        await flush();

        expect(box.innerHTML).toContain('pd-error');
        expect(box.innerHTML).not.toContain('CachedCo');
    });

    test('a failed load leaves the directory marked failed, never marked empty', () => {
        // CLAUDE.md check 4. If the catch reset contacts to [] and called that "loaded",
        // the panel would print "Nobody in your directory fits this one" — which reads as
        // *your partners are gone* — and the owner would go and add a duplicate.
        setContacts([partner({ company: 'CachedCo', city: 'Chennai' })]);
        FETCH = () => Promise.reject(new Error('offline'));

        const box = fakeBox();
        renderSuggestPanel(box, PANEL_OPTS, () => {});
        return flush().then(() => {
            expect(D.loaded).toBe(false);
            expect(D.loadError).toMatch(/Could not load the directory/);
            expect(box.innerHTML).not.toContain('Nobody in your directory fits this one');
        });
    });

    test('whatever the server says is escaped before it is put on the page', async () => {
        // Every company name, note, subject line and pending-email "from" address goes
        // into innerHTML through esc(). The error message is the one path a test can
        // drive end to end, and it is the same esc().
        setContacts([]);
        FETCH = () => Promise.reject(new Error('<b>bad</b> & "quoted"'));

        const box = fakeBox();
        renderSuggestPanel(box, PANEL_OPTS, () => {});
        await flush();

        expect(box.innerHTML).toContain('&lt;b&gt;bad&lt;/b&gt; &amp; &quot;quoted&quot;');
        expect(box.innerHTML).not.toContain('<b>bad</b>');
    });

    test('the Regular badge means five enquiries, not one', async () => {
        // "Regular" is the owner's shorthand for a firm they actually deal with. Awarded
        // at the first enquiry it would sit on every card and mean nothing.
        const served = (enq) => [partner({ company: 'FiveCo', city: 'Chennai', enq: enq, rep: enq, last: day(5) })];
        const show = async (enq) => {
            FETCH = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ contacts: served(enq), changes: [], pending: [] }) });
            const box = fakeBox();
            renderSuggestPanel(box, PANEL_OPTS, () => {});
            await flush();
            return box.innerHTML;
        };
        expect(await show(5)).toContain('pd-pill-good">Regular');
        expect(await show(4)).not.toContain('pd-pill-good">Regular');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Source guards — only for the parts that genuinely need a browser
// ─────────────────────────────────────────────────────────────────────────────

/** Brace-match one top-level function out of the module (register.test.js pattern). */
function bodyOf(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

function sliceBetween(from, to) {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + 1);
    if (a === -1 || b === -1) throw new Error('markers not found: ' + from);
    return src.slice(a, b);
}

describe('source guard — adding a partner by hand', () => {
    const addHandler = sliceBetween("on(app, '[data-pd-add]'", 'function bindListAndCard(');

    test('the new id carries a random suffix, not a bare timestamp', () => {
        // Two devices pressing + Add inside the same millisecond would otherwise share an
        // id, and two partners on one id merge into each other — and delete together.
        expect(addHandler).toMatch(/id:\s*'p_'\s*\+\s*Date\.now\(\)\.toString\(36\)\s*\+\s*Math\.random\(\)\.toString\(36\)\.slice\(/);
        expect(addHandler).not.toMatch(/id:\s*'p_'\s*\+\s*Date\.now\(\)\s*[,}]/);
    });

    test('the lock is only released when the save comes back, not on the next line', () => {
        // CLAUDE.md check 3. Clearing S.adding synchronously keeps all three literals a
        // looser guard would look for, while a double click still writes two blank
        // partners — so what is pinned is WHERE the flag is cleared, inside the callback.
        expect(addHandler).toContain('if (S.adding) return;');
        expect(addHandler).toContain('S.adding = true;');
        expect(addHandler.match(/S\.adding = false;/g)).toHaveLength(1);
        expect(addHandler).toMatch(/savePartner\(p\)\s*\.then\(\s*function \(\)\s*\{[^{}]*S\.adding = false;/);
    });
});

describe('source guard — importing remembered addresses', () => {
    const importHandler = sliceBetween("on(app, '[data-pd-import]'", "on(app, '[data-pd-add]'");

    test('the lock is released whether the import succeeds OR fails', () => {
        // A second click re-runs the whole import: every remembered address added twice.
        // But releasing the lock only on success is its own bug — postJson's catch runs
        // INSTEAD of the success callback, so one failed import left the button disabled and
        // reading "Importing…" until the page was reloaded. A failure that looks like a hang.
        // The release therefore belongs in postJson's `always` argument, never in `then`.
        expect(importHandler).toContain('if (S.importing) return;');
        expect(importHandler).toContain('S.importing = true;');
        expect(importHandler.match(/S\.importing = false;/g)).toHaveLength(1);
        expect(importHandler).toMatch(
            /postJson\([^]*?\}\s*,\s*function \(\) \{ S\.importing = false; \}\s*\)/);
        // and NOT inside the success callback, where a failed request never reaches it
        expect(importHandler).not.toMatch(/function \(d\) \{\s*S\.importing = false;/);
    });

    test('and the button visibly disables itself', () => {
        expect(bodyOf('emptyStateHtml')).toContain("(S.importing ? ' disabled' : '')");
    });
});

describe('source guard — the Recent-changes buttons that write to the directory', () => {
    // Approve writes a pending email into the directory; Discard and Undo both write too.
    // Every one of them needs the same double-click no-op as Add and Import.
    const handlers = {
        Approve: sliceBetween("each(app, '[data-pd-approve]'", "each(app, '[data-pd-discard]'"),
        Discard: sliceBetween("each(app, '[data-pd-discard]'", "each(app, '[data-pd-change]'"),
        Undo: sliceBetween("each(app, '[data-pd-undo]'", '// ── The in-quote suggestion panel'),
    };

    Object.keys(handlers).forEach((name) => {
        test(name + ' is a no-op on the second click', () => {
            expect(handlers[name]).toContain('if (S.busy[id]) return;');
            expect(handlers[name]).toContain('S.busy[id] = true;');
        });
    });
});

describe('source guard — a save writes only the fields that were touched', () => {
    test('savePartner still narrows the write with `fields`', () => {
        // CLAUDE.md check 2. Posting the whole partner on every edit is the stale-copy
        // overwrite this argument exists to prevent: a colleague editing the products
        // while you edit the phone number loses their work with no error anywhere.
        expect(bodyOf('savePartner')).toMatch(/function savePartner\(p, fields\)[\s\S]*fields: fields \|\| null/);
    });
});

describe('source guard — reviewing a pending email never writes to the live card', () => {
    test('the preview of a matched firm gets its own id, with the real one kept aside', () => {
        // Without this the preview shares the live record's id, byId() resolves to the
        // live record, and every correction typed while reviewing is written to it — then
        // overwritten by the un-corrected preview when Approve is pressed.
        expect(bodyOf('pendingPreview'))
            .toContain("if (match) { base.matchId = match.id; base.id = 'p_new_' + pi.id; }");
    });
});

describe('source guard — the IS 1239 thickness table', () => {
    test('2" NB still carries its own light / medium / heavy thicknesses', () => {
        // These are the numbers the "Load IS 1239 sizes" button writes onto a product
        // card, and they are quoted to customers off that card. Each NB size has its OWN
        // thickness per class — a copied-down value is a wrong spec in an offer.
        expect(src).toContain("{ nb: '50', inch: '2\"', od: '60.3', light: '2.9', medium: '3.6', heavy: '4.5' },");
        expect(src).toContain("{ nb: '150', inch: '6\"', od: '165.1', light: '', medium: '4.85', heavy: '5.4' },");
    });
});
