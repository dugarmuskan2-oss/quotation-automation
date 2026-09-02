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

const { readEnquiry, rankFor, matchCity, kmBetween, applyFind, looksLikeFirmName, _state } = global.window.partnerDirectory._test;
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

    test('a pipe enquiry is OFFERED to dealers and manufacturers — nobody else', () => {
        // A fabricator or a lorry firm turning up as a pipe supplier is an email to the
        // wrong company on the owner's letterhead. "Offered" is the unblocked list — the
        // one the owner is being told to send to.
        setContacts(mixed());
        const offered = rankFor('material', readEnquiry(ENQUIRY))
            .filter((r) => !r.blocked).map((r) => r.p.company).sort();
        expect(offered).toEqual(['DealerCo', 'MakerCo']);
    });

    test('a fabricator who stocks the type is still SHOWN, ruled out with the reason', () => {
        // They used to be dropped before scoring, so they appeared nowhere at all — not
        // even under "Not suggested — but shown, so you can overrule it" — and nothing
        // said why. Hiding a firm and giving no reason is the fault; blocking is the rule.
        setContacts(mixed());
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        const fab = rowFor(rows, 'FabCo');
        expect(fab).toBeDefined();
        expect(fab.blocked).toBe(true);
        const line = reasonMatching(fab, /not a pipe supplier/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('bad');
        expect(line[1]).toBe('They are a fabricator, not a pipe supplier');
    });

    test('a lorry firm is never scored as a pipe supplier, whatever its card says', () => {
        // TransCo carries pipe types in the fixture. A transporter must not reach the
        // supplier list at all, blocked or otherwise — that is not an overrule, it is noise.
        setContacts(mixed());
        const names = rankFor('material', readEnquiry(ENQUIRY)).map((r) => r.p.company);
        expect(names).not.toContain('TransCo');
    });

    test('a dealer with a lorry route is shown for transport, ruled out on his role', () => {
        // The other half: a dealer who runs his own lorries used to vanish from freight
        // suggestions entirely.
        setContacts([
            partner({ company: 'TransCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }] }),
            partner({ company: 'DealerCo', role: 'dealer', routes: [{ from: 'Chennai', to: 'Madurai' }] }),
            partner({ company: 'NoLorryCo', role: 'dealer', routes: [] }),
        ]);
        const rows = rankFor('transport', readEnquiry('lorry from Chennai to Madurai, 12 MT'), 'Chennai');
        expect(rows.map((r) => r.p.company).sort()).toEqual(['DealerCo', 'TransCo']);
        expect(rowFor(rows, 'DealerCo').blocked).toBe(true);
        expect(reasonMatching(rowFor(rows, 'DealerCo'), /not a transporter/)).not.toBeNull();
        expect(rowFor(rows, 'TransCo').blocked).toBe(false);
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

describe('source guard — saving a partner by hand', () => {
    test('typing on a card in the directory writes NOTHING — Save is the only write', () => {
        // The rule the owner asked for: save as you type while REVIEWING, an explicit Save in
        // the directory. So the field handler only marks what changed; the write lives behind
        // the button. A savePartner call in here would be saving as you type all over again.
        const saveFn = sliceBetween('var save = function (rerender, fields)', 'each(card,');
        expect(saveFn).toContain('if (inDirectory) markDirty(p, fields);');
        expect(saveFn).toContain('else savePendingPreview(p);');
        expect(saveFn).not.toContain('savePartner(');
    });

    test('and Save still refuses a card with nothing on it', () => {
        // The blank-card rule moved with the write. Without it, pressing Save on an untouched
        // "+ Add partner" card puts the empty row straight back in the list.
        const fn = sliceBetween('function saveOpenCard(id)', 'function savePendingPreview');
        expect(fn).toContain('if (isBlankCard(p))');
        expect(fn).toContain('there is nothing to save yet');
        // ...and it writes only the boxes that were actually touched.
        expect(fn).toContain('var sending = dirtyFields(id);');
        expect(fn).toContain('savePartner(p, sending)');
    });

    test('the button that made blank cards is gone, and nothing still points at it', () => {
        // Asked for directly: "remove add partner". A removal is not finished while the page
        // still tells the owner to press it — that reads as a broken app, not a tidied one.
        expect(src).not.toContain('data-pd-add="1"');
        expect(src).not.toContain("on(app, '[data-pd-add]'");
        expect(src).not.toContain('+ Add partner');
        const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contacts.js'), 'utf8');
        expect(routes).not.toContain('by hand in the Directory tab');
    });

    test('BOTH "nobody fits" buttons send them to the Add tab, not the empty list', () => {
        // That button used to walk to the list the add button sat on. Left as it was, it
        // drops the owner on a list with no way to add anybody — at the exact moment the
        // directory is provably missing someone.
        //
        // There are TWO handlers for the one piece of markup: the Directory's own, and the
        // panel copy the Freight and Enquiry tabs render. The first version of this test
        // sliced only the Directory one, so it passed green while the panel copy was still
        // a dead end. Both are pinned by name now.
        const inDirectory = sliceBetween("each(app, '[data-pd-goto-directory]'", "each(app, '[data-pd-find]'");
        expect(inDirectory).toContain("S.tab = 'add';");

        const inPanel = sliceBetween("each(container, '[data-pd-goto-directory]'", "each(container, '[data-pd-send]'");
        expect(inPanel).toContain("S.tab = 'add';");
        expect(inPanel).toContain('window.switchToDirectoryTab();');   // still shows the tool

        // ...and the fix is NOT inside switchToDirectoryTab, which the sidebar button also
        // calls — that one must go on landing on the Directory list.
        const sw = sliceBetween('function switchToDirectoryTab()', 'window.switchToDirectoryTab = switchToDirectoryTab;');
        expect(sw).not.toContain("S.tab = 'add'");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The blank-card rule, which outlived the button that made blank cards
// ─────────────────────────────────────────────────────────────────────────────

describe('an emptied card is never stored as a blank row', () => {
    const { S } = _state();
    let realGetElementById;
    let app;
    let posts;

    /**
     * Like fakeAppEl, plus the querySelector that on() uses to bind a single button, and
     * empty children on each stub so bindCardFields can walk an open card without blowing up.
     */
    function clickableApp() {
        const base = fakeAppEl();
        const raw = base.querySelectorAll;
        base.querySelectorAll = (sel) => raw(sel).map((stub) => {
            if (!stub.querySelectorAll) {
                stub.querySelectorAll = () => [];
                stub.querySelector = () => null;
            }
            return stub;
        });
        base.querySelector = (sel) => base.querySelectorAll(sel)[0] || null;
        return base;
    }

    beforeEach(() => {
        realGetElementById = global.document.getElementById;
        app = clickableApp();
        global.document.getElementById = (id) => (id === 'partnerDirectoryApp' ? app : null);
        S.tab = 'dir'; S.filter = 'all'; S.openId = null; S.busy = {};
        posts = [];
        FETCH = (url, opts) => {
            if (opts && opts.method === 'POST') {
                posts.push(url);
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ contacts: [], changes: [], pending: [], duplicates: [] }),
            });
        };
    });

    afterEach(() => {
        global.document.getElementById = realGetElementById;
        FETCH = () => Promise.reject(new Error('no network in unit tests'));
        S.tab = 'dir'; S.filter = 'all'; S.openId = null; S.busy = {};
        setContacts([]);
    });

    /** Open a real card, the only way in now that "+ Add partner" has gone. */
    const openReal = async (p) => {
        FETCH = (url, opts) => {
            if (opts && opts.method === 'POST') { posts.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ contacts: [p], changes: [], pending: [], duplicates: [] }) });
        };
        global.window.switchToDirectoryTab();
        await flush();
        S.openId = p.id;
        global.window.switchToDirectoryTab();
        await flush();
    };

    test('a person with no numbers on them shows one phone box and one email box, with + for more', async () => {
        // Asked for directly: typing a number should not start with hunting for a "+ phone"
        // button. One of each is there from the start.
        await openReal(partner({ id: 'p_bare', company: 'Bare Traders',
            people: [{ name: 'Ravi', role: '', phones: [], emails: [] }] }));

        const html = app.innerHTML;
        expect((html.match(/data-pd-ph="0"/g) || []).length).toBeGreaterThan(0);
        expect((html.match(/data-pd-em="0"/g) || []).length).toBeGreaterThan(0);
        expect(html).toContain('data-pd-addph=');     // + phone, for a second one
        expect(html).toContain('data-pd-addem=');     // + email
        // exactly one of each — not two, and not a blank row per label
        expect(html).not.toContain('data-pd-ph="1"');
        expect(html).not.toContain('data-pd-em="1"');
        // and the empty pair is NOT what gets stored
        expect(posts).toEqual([]);
    });

    test('a person who really has two numbers still shows both', async () => {
        // The default must fill a gap, never trim what is there.
        const twoNumbers = partner({
            id: 'p_two', company: 'Sri Logistics',
            people: [{
                name: 'Ravi', role: 'Sales',
                phones: [{ label: 'Mobile', v: '9840000001' }, { label: 'Office', v: '4428000002' }],
                emails: [{ label: 'Work', v: 'ravi@srilogistics.com' }],
            }],
        });
        FETCH = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ contacts: [twoNumbers], changes: [], pending: [], duplicates: [] }),
        });
        global.window.switchToDirectoryTab();
        await flush();
        S.openId = 'p_two';
        global.window.switchToDirectoryTab();
        await flush();

        expect(app.innerHTML).toContain('data-pd-ph="1"');    // the second number survived
        expect(app.innerHTML).toContain('9840000001');
        expect(app.innerHTML).toContain('4428000002');
    });

    test('an emptied card cannot be saved back as a blank row', async () => {
        // + Add partner has gone, but a card can still be emptied by hand: clear the company
        // name and the one contact, press Save, and an empty row would go into the directory.
        // This is the remaining reason isBlankCard exists.
        const { saveOpenCard } = global.window.partnerDirectory._test;
        const emptied = partner({ id: 'p_blank', company: '', people: [{ name: '', role: '', phones: [], emails: [] }] });
        await openReal(emptied);
        S.dirty = { p_blank: { company: true } };

        await saveOpenCard('p_blank');
        await flush();

        expect(posts.filter((u) => String(u).indexOf('/contacts/save') !== -1)).toEqual([]);
        expect(S.saveNote).toContain('nothing to save yet');
    });

    test('a card with a person on it is NOT blank, and saves normally', async () => {
        // The guard must look at every way a card can be worth keeping, or a real partner
        // whose company name is simply not filled in yet could never be saved at all.
        const { saveOpenCard } = global.window.partnerDirectory._test;
        const named = partner({ id: 'p_real', company: '', people: [{ name: 'Ravi', role: '', phones: [], emails: [] }] });
        await openReal(named);
        S.dirty = { p_real: { people: true } };

        await saveOpenCard('p_real');
        await flush();

        expect(posts.filter((u) => String(u).indexOf('/contacts/save') !== -1)).toHaveLength(1);
    });
});

describe('source guard — importing remembered addresses', () => {
    const importHandler = sliceBetween("on(app, '[data-pd-import]'", 'function bindListAndCard(');

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
            /postJson\([^]*?\}\s*,\s*function \(\) \{ S\.importing = false; \}\s*,\s*'Bringing in the addresses'\s*\)/);
        // and NOT inside the success callback, where a failed request never reaches it
        expect(importHandler).not.toMatch(/function \(d\) \{\s*S\.importing = false;/);
    });

    test('and the button visibly disables itself', () => {
        // CLAUDE.md check #3 wants the button visibly disabled, not only guarded in code.
        expect(bodyOf('importButtonHtml')).toContain("(S.importing ? ' disabled' : '')");
    });

    test('the import stays reachable once the directory is no longer empty', () => {
        // It used to live ONLY inside emptyStateHtml, so one enquiry sent from a quote — which
        // queues a firm on its own — hid years of remembered addresses behind an empty state
        // that could never be reached again.
        expect(bodyOf('dirView')).toContain('importButtonHtml()');
        expect(bodyOf('emptyStateHtml')).toContain('importButtonHtml()');
    });
});

describe('source guard — the Recent-changes buttons that write to the directory', () => {
    // Approve writes a pending email into the directory; Discard and Undo both write too.
    // Every one of them needs the same double-click no-op as Add and Import.
    const handlers = {
        Approve: sliceBetween("each(app, '[data-pd-approve]'", "each(app, '[data-pd-discard]'"),
        Discard: sliceBetween("each(app, '[data-pd-discard]'", "each(app, '[data-pd-change]'"),
        // Undo's lock lives in undoWithWarning: the click now has to survive a round trip
        // that may come back asking "this also removes 3 things — sure?", so the flag is held
        // across the question rather than inside the click handler.
        Undo: sliceBetween('function undoWithWarning(', 'function undoWarningText('),
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

// ─────────────────────────────────────────────────────────────────────────────
// 10. One address belongs to one company — driven through a real render
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The server refuses a clashing address with a 409. That is the backstop, not the
 * experience: pressing Approve only to be told no is a worse way to learn it than being
 * told before you press. So the page has to say it up front and disable the button.
 *
 * These are behaviour tests, not source guards. The page is rendered for real through
 * window.switchToDirectoryTab() — the same entry point the sidebar button uses — with a
 * stand-in for #partnerDirectoryApp that records the HTML and hands back clickable stubs
 * for the [data-pd-…] buttons the module binds.
 */
function fakeAppEl() {
    // One stub per attribute+value, reused across renders — the element the module bound a
    // click to must be the same object the test then clicks, or nothing is being tested.
    const stubs = {};
    const app = {
        innerHTML: '', style: {},
        querySelector: () => null,
        // The module only ever asks for whole-attribute selectors, so scanning the HTML it
        // just wrote is a faithful enough stand-in for the DOM it would have got.
        querySelectorAll: (sel) => {
            const m = /^\[(data-pd-[a-z]+)\]$/.exec(sel);
            if (!m) return [];
            const attr = m[1];
            const re = new RegExp(attr + '="([^"]*)"', 'g');
            const out = [];
            let hit;
            while ((hit = re.exec(app.innerHTML)) !== null) {
                const key = attr + '|' + hit[1];
                if (!stubs[key]) {
                    const value = hit[1];
                    stubs[key] = {
                        getAttribute: (k) => (k === attr ? value : null),
                        hasAttribute: () => false,
                    };
                }
                out.push(stubs[key]);
            }
            return out;
        },
    };
    return app;
}

describe('the partner directory refuses a duplicate address before Approve is pressed', () => {
    const { S } = _state();
    let realGetElementById;
    let app;

    beforeEach(() => {
        realGetElementById = global.document.getElementById;
        app = fakeAppEl();
        global.document.getElementById = (id) => (id === 'partnerDirectoryApp' ? app : null);
        S.tab = 'dir'; S.filter = 'all'; S.openId = null; S.openPending = null; S.busy = {};
    });

    afterEach(() => {
        global.document.getElementById = realGetElementById;
        FETCH = () => Promise.reject(new Error('no network in unit tests'));
        S.tab = 'dir'; S.filter = 'all'; S.openId = null; S.openPending = null; S.busy = {};
        setContacts([]);
    });

    /** Serve one directory payload and open the tool the way the sidebar button does. */
    async function open(payload, tab) {
        S.tab = tab || 'dir';
        FETCH = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve(Object.assign(
                { contacts: [], changes: [], pending: [], duplicates: [] }, payload)),
        });
        global.window.switchToDirectoryTab();
        await flush();
        return app.innerHTML;
    }

    const KALP = partner({
        id: 'p_kalp', company: 'Kalpataru Steel', city: 'Nashik', role: 'manufacturer',
        people: [{ name: 'Manish', role: 'Sales', phones: [], emails: [{ label: 'Work', v: 'manish@kalpatarusteel.com' }] }],
    });
    const SRI = partner({
        id: 'p_sri', company: 'Sri Logistics', city: 'Chennai', role: 'transporter',
        people: [{ name: 'Ravi', role: 'Sales', phones: [], emails: [{ label: 'Work', v: 'ravi@srilogistics.com' }] }],
    });

    /** A queued draft, exactly as routes/contacts.js stores an imported one. */
    function queued(previewOver) {
        return {
            id: 'pd_1', origin: 'import', from: 'manish@kalpatarusteel.com',
            subject: 'Kalpataru Steel', file: '', kind: 'photo', text: '',
            finds: [{ kind: 'field', key: 'email', label: 'Address you have used', value: 'manish@kalpatarusteel.com' }],
            receivedAt: new Date().toISOString(),
            preview: partner(Object.assign({ id: 'p_new_pd_1' }, previewOver)),
        };
    }

    function approveButton(html) {
        const m = html.match(/<button class="pd-prim" data-pd-approve="pd_1"[^>]*>/);
        if (!m) throw new Error('no Approve button rendered:\n' + html);
        return m[0];
    }

    test('a card waiting for approval offers Discard, never a dead "Delete this partner"', async () => {
        // Reported by the owner as "delete this partner isn't working". It was wired to the
        // preview's 'p_new_…' id, which the directory has never seen: the button deleted
        // nothing, and the reload it triggered threw away the corrections being typed. Discard
        // is the action for a waiting card, and it was already sitting right below.
        S.openPending = 'pd_1';                       // the owner has opened it to review
        const queuedHtml = await open({
            contacts: [KALP],
            pending: [queued({ company: 'Balaji Tubes', people: [{ name: '', role: '', phones: [], emails: [{ label: 'Work', v: 'sales@balajitubes.com' }] }] })],
        }, 'changes');
        expect(queuedHtml).toContain('data-pd-card="p_new_pd_1"');   // the review really opened
        expect(queuedHtml).not.toContain('data-pd-delete');
        expect(queuedHtml).toContain('data-pd-discard="pd_1"');

        // ...while a card the directory really holds keeps Delete, or there is no way to
        // remove a partner at all.
        const realHtml = await open({ contacts: [KALP] }, 'dir');
        expect(realHtml).toContain('data-pd-open="p_kalp"');
        S.openId = 'p_kalp';
        global.window.switchToDirectoryTab();
        await flush();
        expect(app.innerHTML).toContain('data-pd-delete="p_kalp"');
    });

    test('a draft that UPDATES the card already holding the address is not a clash', () => {
        // The one case a naive "is this address in the directory" check gets wrong — and it
        // is the common case: a second colleague at a mill we already deal with. Flagging it
        // would disable Approve on every genuine update the import proposes.
        return open({
            contacts: [KALP],
            pending: [queued({
                company: 'Kalpataru Steel', matchId: 'p_kalp',
                people: [
                    { name: 'Manish', role: '', phones: [], emails: [{ label: 'Work', v: 'manish@kalpatarusteel.com' }] },
                    { name: '', role: '', phones: [], emails: [{ label: 'Work', v: 'cp@kalpatarusteel.com' }] },
                ],
            })],
        }, 'changes').then((html) => {
            expect(html).toContain('data-pd-approve="pd_1"');   // the strip really rendered
            expect(html).not.toContain('is already on');
            expect(approveButton(html)).not.toContain('disabled');
        });
    });

    test('a draft colliding with a DIFFERENT card is flagged, and Approve is disabled', async () => {
        // Updating Sri Logistics, but carrying Kalpataru's address across with it.
        const html = await open({
            contacts: [KALP, SRI],
            pending: [queued({
                company: 'Sri Logistics', matchId: 'p_sri',
                people: [
                    { name: 'Ravi', role: '', phones: [], emails: [{ label: 'Work', v: 'ravi@srilogistics.com' }] },
                    { name: 'M', role: '', phones: [], emails: [{ label: 'Work', v: 'manish@kalpatarusteel.com' }] },
                ],
            })],
        }, 'changes');

        expect(html).toContain('<b>manish@kalpatarusteel.com</b> is already on');
        expect(html).toContain('One address belongs to one company');
        // The other card is one click away — a refusal with nowhere to go is a dead end.
        expect(html).toContain('data-pd-open="p_kalp"');
        expect(html).toContain('>Kalpataru Steel</button>');
        expect(approveButton(html)).toContain(' disabled');
    });

    test('the same address in different capitals is still the same address', async () => {
        // allEmails keeps an address exactly as typed, because the chips and the picker show
        // it — so comparing raw let MANISH@KalpataruSteel.com slip past a stored
        // manish@kalpatarusteel.com. The data stayed safe (the server refuses either way),
        // but the owner pressed Approve only to meet the refusal this warning exists to spare
        // them. Both sides are lowercased before comparing, exactly as the server does.
        const html = await open({
            contacts: [KALP],
            pending: [queued({
                company: 'Manish Trading Co',
                people: [{ name: 'Manish', role: 'Main contact', phones: [], emails: [{ label: 'Work', v: 'MANISH@KalpataruSteel.com' }] }],
            })],
        }, 'changes');

        expect(html).toContain('is already on');
        expect(html).toContain('data-pd-open="p_kalp"');
        expect(approveButton(html)).toContain(' disabled');
    });

    test('a brand-new firm draft carrying someone else\'s address is flagged too', async () => {
        // No matchId at all: nothing to keep, so every card in the directory is a candidate
        // for the clash. A guard that only ran on updates would wave this one straight in.
        const html = await open({
            contacts: [KALP],
            pending: [queued({
                company: 'Manish Trading Co',
                people: [{ name: 'Manish', role: 'Main contact', phones: [], emails: [{ label: 'Work', v: 'manish@kalpatarusteel.com' }] }],
            })],
        }, 'changes');

        expect(html).toContain('<b>manish@kalpatarusteel.com</b> is already on');
        expect(approveButton(html)).toContain(' disabled');
    });

    test('the card named in the clash note can actually be opened from the changes tab', async () => {
        // The button sits on Recent changes, where the card it points at is not rendered at
        // all. Without switching tab and clearing the role filter the click does nothing —
        // which reads as a broken button on the one screen that needed to be helpful.
        await open({
            contacts: [KALP, SRI],
            pending: [queued({
                company: 'Sri Logistics', matchId: 'p_sri',
                people: [{ name: 'M', role: '', phones: [], emails: [{ label: 'Work', v: 'manish@kalpatarusteel.com' }] }],
            })],
        }, 'changes');
        S.filter = 'transporter';   // as it would be if they had filtered the list earlier

        const link = app.querySelectorAll('[data-pd-open]')
            .filter((el) => el.getAttribute('data-pd-open') === 'p_kalp')[0];
        expect(link).toBeTruthy();
        link.onclick();

        expect(S.openId).toBe('p_kalp');
        expect(S.tab).toBe('dir');
        expect(S.filter).toBe('all');
        expect(app.innerHTML).toContain('data-pd-card="p_kalp"');   // the card is on screen
    });

    test('duplicates that pre-date the rule are shown at the top of the directory', async () => {
        // Enforcing the rule on write stops NEW ones. Anything written before it would sit
        // there for ever, splitting one firm's history across two cards, unless the page says so.
        const html = await open({
            contacts: [KALP, SRI],
            duplicates: [{
                email: 'manish@kalpatarusteel.com',
                cards: [{ id: 'p_kalp', company: 'Kalpataru Steel' }, { id: 'p_sri', company: 'Sri Logistics' }],
            }],
        }, 'dir');

        expect(html).toContain('The same address is on more than one card.');
        expect(html).toContain('<b>manish@kalpatarusteel.com</b>');
        expect(html).toContain('data-pd-open="p_kalp"');
        expect(html).toContain('data-pd-open="p_sri"');
    });

    test('a clean directory shows no duplicate banner at all', async () => {
        // The negative that stops the banner becoming wallpaper nobody reads.
        const html = await open({ contacts: [KALP, SRI], duplicates: [] }, 'dir');
        expect(html).toContain('data-pd-filter="all"');              // the page really rendered
        expect(html).not.toContain('The same address is on more than one card.');
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

// ─────────────────────────────────────────────────────────────────────────────
// The working area must sit BESIDE the tool icons, never underneath them
// ─────────────────────────────────────────────────────────────────────────────

describe('layout — the floating tool switcher must not cover the page', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    // The switcher is position:fixed at left:10px and 44px wide, so it floats over whatever
    // is at that spot. The four original tools reserved 70px for it by NAME; the Partner
    // Directory was added as a fifth and nobody remembered to add it to the list, so it
    // rendered underneath the icons. Reserving the space on the shared class instead means a
    // sixth tool cannot repeat it — which is the only thing worth pinning here.
    test('the space is reserved on the shared .container class, not a list of ids', () => {
        expect(css).toMatch(/\.container\s*\{\s*padding-left:\s*70px;\s*\}/);
        expect(css).not.toMatch(/#quotationApp,\s*\n?\s*#weightCalculatorApp[\s\S]{0,120}padding-left:\s*70px/);
    });

    test('every tool page actually carries that class', () => {
        const ids = ['quotationApp', 'weightCalculatorApp', 'enquiryPreparerApp',
            'partnerDirectoryApp', 'registerApp'];
        ids.forEach((id) => {
            // class first, then id — the order index.html uses on all five.
            expect(html).toContain('class="container" id="' + id + '"');
        });
    });

    test('on a phone the bar moves to the bottom and every page clears it', () => {
        // Reserving 70px on a 375px screen left the quote about 200px to live in, so the bar
        // moves to the bottom instead — which means the reserved space has to move too, or
        // the last button on the page sits under it.
        const mobile = css.slice(css.indexOf('.main-tools-bar {', css.indexOf('@media')));
        expect(mobile).toMatch(/\.container\s*\{[^}]*padding-bottom:\s*calc\(80px/);
        expect(mobile).not.toMatch(/#quotationApp,\s*#weightCalculatorApp[^{]*\{[^}]*padding-bottom/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Where the pipes are actually going
// ─────────────────────────────────────────────────────────────────────────────

describe('readEnquiry — the delivery town, and enquiries that name no pipe family', () => {
    test('the town after "Delivery:" beats the town in the customer\'s letterhead', () => {
        // It used to take whichever known town came first in a fixed internal list, and
        // Chennai is first — so the sender's own address won almost every enquiry, and every
        // Chennai dealer got "right by the site" (+35) for a delivery to Hosur.
        // The letterhead is FIRST here, the way a real email arrives — which is what pins the
        // rule. With Chennai appearing later, "whichever comes first in the text" would give
        // the right answer by accident and prove nothing.
        const need = readEnquiry(
            'SK Constructions, Ambattur, Chennai 600053\n\n'
            + 'Please send your best rates:\n2" NB medium GI 1200 mtrs, 3" NB heavy GI 800 mtrs.\n'
            + 'Delivery: Hosur.\nRegards, Balaji');
        expect(need.site).toBe('Hosur');
        expect(need.siteAssumed).toBe(false);
    });

    test('when an enquiry corrects itself, the LAST delivery line is the one that counts', () => {
        // A customer writing "delivery Salem — sorry, deliver to Hosur" means Hosur. Taking
        // the first delivery mention would quote freight to the wrong town, and the read-back
        // would look perfectly correct while doing it.
        const need = readEnquiry(
            '2" NB medium GI 1200 mtrs.\nDelivery: Salem.\n'
            + 'Correction — please deliver to Hosur instead.');
        expect(need.site).toBe('Hosur');
    });

    test('a town it cannot measure is NAMED, not silently replaced by Chennai', () => {
        // The wording was the harm: "Chennai — assumed, no place named" over an enquiry that
        // said Tirupur plainly gave the owner a reason not to double-check.
        const need = readEnquiry('Please quote 500 mtrs of 4" GI heavy pipes to be delivered at Tirupur site');
        expect(need.siteUnknown).toBe('Tirupur');
    });

    test('and nobody is scored as being near a town we cannot place', () => {
        // Otherwise a Chennai dealer is handed "right by the site" for a delivery 400 km away.
        setContacts([
            partner({ company: 'ChennaiCo', city: 'Chennai', types: ['GI'] }),
            partner({ company: 'FarCo', city: 'Delhi', types: ['GI'] }),
        ]);
        const rows = rankFor('material', readEnquiry('500 mtrs of 4" GI heavy delivered at Tirupur site'));
        expect(rows[0].score).toBe(rows[1].score);
        expect(reasonMatching(rowFor(rows, 'ChennaiCo'), /right by the site/)).toBeNull();
        expect(reasonMatching(rowFor(rows, 'ChennaiCo'), /not a town I can measure/)).not.toBeNull();
    });

    test('a plainly named town still reads normally, and from/to still work', () => {
        // Both directions: a guard that just stopped reading places would pass the tests above.
        expect(readEnquiry('300 mtr of 2 inch ERW medium, delivery at Chennai').site).toBe('Chennai');
        const freight = readEnquiry('lorry from Chennai to Madurai, 12 MT');
        expect(freight.pickup).toBe('Chennai');
        expect(freight.site).toBe('Madurai');
    });

    test('an enquiry that never spells out GI or ERW is still an enquiry', () => {
        // It used to fall out of the finder entirely and become a literal text search, with
        // the whole pasted email printed back as the search term.
        expect(readEnquiry('Dear Sir, kindly quote for 20 MT pipes, delivery at Erode').empty).toBe(false);
        expect(readEnquiry('Kindly send your best offer for IS 1239 heavy class pipes, 2 inch, 300 metres').empty).toBe(false);
    });

    test('but a short name typed to look someone up still searches by name', () => {
        // The other half. Without this the name-search box would never work again.
        expect(readEnquiry('Annai Steel Traders').empty).toBe(true);
        expect(readEnquiry('').empty).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. The flow review — the medium faults, and what each one now has to do
// ─────────────────────────────────────────────────────────────────────────────

describe('a firm emailed this morning has been dealt with recently', () => {
    // `daysSince` returns 0 for today, and 0 is falsy, so `|| 999` turned today into
    // "not lately": the firms the owner is actively working with were described as
    // neglected, lost 10 points for it, and wore the green Regular badge on the same card.
    const both = () => [
        partner({ company: 'TodayCo', city: 'Chennai', enq: 10, rep: 0, last: TODAY }),
        partner({ company: 'LapsedCo', city: 'Chennai', enq: 10, rep: 0, last: day(400) }),
    ];

    test('the sentence says recently, not "but not lately"', () => {
        setContacts(both());
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        expect(reasonMatching(rowFor(rows, 'TodayCo'), /dealt with recently/)).not.toBeNull();
        expect(reasonMatching(rowFor(rows, 'TodayCo'), /but not lately/)).toBeNull();
    });

    test('and it keeps the 10 points, so it does not sink below one used months ago', () => {
        setContacts(both());
        const s = scoresByCompany(rankFor('material', readEnquiry(ENQUIRY)));
        expect(s.TodayCo - s.LapsedCo).toBe(10);
    });

    test('the badge and the sentence agree — both read "recent" off the same rule', () => {
        // They disagreed on ONE card: Regular (green) beside "but not lately" (orange).
        setContacts([partner({ company: 'TodayCo', city: 'Chennai', enq: 10, rep: 0, last: TODAY })]);
        const row = rankFor('material', readEnquiry(ENQUIRY))[0];
        expect((row.p.enq || 0) >= 5).toBe(true);   // what isRegular needs beyond the date
        expect(reasonMatching(row, /dealt with recently/)).not.toBeNull();
    });
});

describe('"No city on their card" is only ever said to a card with no city', () => {
    test('a town outside the distance table is named, not blamed on a blank card', () => {
        // Erode, Tirupur, Ambattur — the head-office box is free text and those get typed
        // all the time. The card plainly said Erode and the app asked him to add a city.
        setContacts([partner({ company: 'ErodeCo', city: 'Erode' })]);
        const row = rankFor('material', readEnquiry(ENQUIRY))[0];
        expect(reasonMatching(row, /No city on their card/)).toBeNull();
        const line = reasonMatching(row, /not in my distance list/);
        expect(line).not.toBeNull();
        expect(line[1]).toContain('Erode');
    });

    test('and it costs nothing, where a genuinely blank card still costs 5', () => {
        setContacts([
            partner({ company: 'ErodeCo', city: 'Erode' }),
            partner({ company: 'BlankCo', city: '' }),
        ]);
        const s = scoresByCompany(rankFor('material', readEnquiry(ENQUIRY)));
        expect(s.ErodeCo - s.BlankCo).toBe(5);
    });

    test('a delivery town we cannot place is not blamed on anyone at all', () => {
        // The everyone-at-once version: a quote shipping to Tirupur made EVERY card read
        // "No city on their card", because nearestBranch fails on either end.
        setContacts([partner({ company: 'ChennaiCo', city: 'Chennai' })]);
        const row = rankFor('material', { types: ['ERW'], items: [], site: 'Tirupur', tons: 1.5, known: true })[0];
        expect(reasonMatching(row, /No city on their card/)).toBeNull();
        expect(reasonMatching(row, /not a town I can measure/)).not.toBeNull();
    });
});

describe('a card the app made itself does not state facts nobody gave it', () => {
    // sanitizePartner defaults partLoad to true and moq to 0, so a stub the app invented
    // after a send was born "Accepts part load" and "No minimum in the way" — green, and
    // worth 25 and 10 points. CLAUDE.md check five: no number, and no fact, is guessed.
    const freight = () => readEnquiry('lorry from Chennai to Madurai, 2.4 MT');

    test('part load is "not recorded", and worth nothing, until someone confirms the card', () => {
        setContacts([
            partner({ company: 'GuessedCo', role: 'transporter', fromEnquiry: true, routes: [{ from: 'Chennai', to: 'Madurai' }] }),
            partner({ company: 'ConfirmedCo', role: 'transporter', fromEnquiry: false, routes: [{ from: 'Chennai', to: 'Madurai' }] }),
        ]);
        const rows = rankFor('transport', freight(), 'Chennai');
        const guessed = rowFor(rows, 'GuessedCo');
        expect(reasonMatching(guessed, /Takes part load/)).toBeNull();
        const line = reasonMatching(guessed, /Part load not recorded/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('neutral');
        const s = scoresByCompany(rows);
        expect(s.ConfirmedCo - s.GuessedCo).toBe(25);
    });

    test('a confirmed full-load-only card is still sunk — the rule itself is untouched', () => {
        setContacts([
            partner({ company: 'FullOnlyCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }], partLoad: false }),
            partner({ company: 'PartCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }] }),
        ]);
        const s = scoresByCompany(rankFor('transport', freight(), 'Chennai'));
        expect(s.PartCo - s.FullOnlyCo).toBe(55);
    });

    test('a blank minimum on a guessed card is "not recorded", not "no minimum in the way"', () => {
        setContacts([
            partner({ company: 'GuessedCo', city: 'Chennai', fromEnquiry: true, moq: 0 }),
            partner({ company: 'ConfirmedCo', city: 'Chennai', fromEnquiry: false, moq: 0 }),
        ]);
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        expect(reasonMatching(rowFor(rows, 'GuessedCo'), /Minimum not recorded/)).not.toBeNull();
        expect(reasonMatching(rowFor(rows, 'GuessedCo'), /No minimum in the way/)).toBeNull();
        const s = scoresByCompany(rows);
        expect(s.ConfirmedCo - s.GuessedCo).toBe(10);
    });
});

describe('with the route boxes empty, nobody is judged against Chennai to Chennai', () => {
    // enq.pickup and enq.drop start as empty strings, so this is the state the freight box
    // opens in. Both ends fell back to Chennai: the panel announced "Chennai → Chennai",
    // warned that most carriers did not go there, and ruled the rest out.
    const carriers = () => [
        partner({ company: 'MaduraiCo', role: 'transporter', routes: [{ from: 'Chennai', to: 'Madurai' }] }),
        partner({ company: 'DelhiCo', role: 'transporter', routes: [{ from: 'Delhi', to: 'Mumbai' }] }),
    ];
    const noRoute = { types: [], items: [], site: '', tons: 2.4, known: true };

    test('nobody is ruled out, and nobody is told they do not run the route', () => {
        setContacts(carriers());
        const rows = rankFor('transport', noRoute, '');
        expect(rows.filter((r) => r.blocked)).toHaveLength(0);
        expect(reasonMatching(rowFor(rows, 'DelhiCo'), /Does not run/)).toBeNull();
    });

    test('the route rule scores nothing for anyone, and asks for the two towns', () => {
        setContacts(carriers());
        const rows = rankFor('transport', noRoute, '');
        const s = scoresByCompany(rows);
        expect(s.MaduraiCo - s.DelhiCo).toBe(0);
        const line = reasonMatching(rowFor(rows, 'MaduraiCo'), /Fill in the pickup and delivery towns/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('neutral');
    });

    test('with both towns given the route rule bites exactly as before', () => {
        // The other half: a guard that simply stopped scoring routes would pass both above.
        setContacts(carriers());
        const rows = rankFor('transport', readEnquiry('lorry from Chennai to Madurai, 2.4 MT'), 'Chennai');
        expect(rowFor(rows, 'DelhiCo').blocked).toBe(true);
        const s = scoresByCompany(rows);
        expect(s.MaduraiCo - s.DelhiCo).toBeGreaterThan(900);
    });

    const panelWith = async (opts) => {
        setContacts([]);
        FETCH = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ contacts: carriers(), changes: [], pending: [] }) });
        const box = fakeBox();
        renderSuggestPanel(box, Object.assign({ kind: 'transport', kg: 2400 }, opts), () => {});
        await flush();
        FETCH = () => Promise.reject(new Error('no network in unit tests'));
        return box.innerHTML;
    };

    test('the panel says so in words instead of printing an invented route', async () => {
        const html = await panelWith({ pickup: '', drop: '' });
        expect(html).not.toContain('Chennai</b> → <b>Chennai');
        expect(html).toContain('no route yet');
    });

    test('a pickup with no delivery town does not invent Chennai as the destination', () => {
        // Both ends fell back to Chennai independently, so filling in only the pickup still
        // produced a route — "Chennai → Chennai" — that nobody had typed.
        return panelWith({ pickup: 'Chennai', drop: '' }).then((html) => {
            expect(html).not.toContain('Chennai</b> → <b>Chennai');
            expect(html).toContain('no route yet');
        });
    });

    test('and a delivery town with no pickup does not invent Chennai as the origin', () => {
        return panelWith({ pickup: '', drop: 'Madurai' }).then((html) => {
            expect(html).not.toContain('Chennai</b> → <b>Madurai');
            expect(html).toContain('no route yet');
        });
    });

    test('with both towns given the panel prints the real route', () => {
        return panelWith({ pickup: 'Chennai', drop: 'Madurai' }).then((html) => {
            expect(html).toContain('Chennai</b> → <b>Madurai');
            expect(html).not.toContain('no route yet');
        });
    });
});

describe('typing a firm name into the finder is a search, not an enquiry', () => {
    // "Sri Balaji Transports" contains "transport", so readEnquiry flagged it freight,
    // ranked a Chennai-to-Chennai lorry list, and the firm was nowhere on the page.
    beforeEach(() => {
        setContacts([
            partner({ company: 'Sri Balaji Transports', role: 'transporter' }),
            partner({ company: 'GI Tubes and Company' }),
        ]);
    });

    test('a firm on file whose name carries a trade word is looked up by name', () => {
        expect(readEnquiry('Sri Balaji Transports').empty).toBe(false);   // the old reading
        expect(looksLikeFirmName('Sri Balaji Transports')).toBe(true);
        expect(looksLikeFirmName('GI Tubes')).toBe(true);
    });

    test('a pasted enquiry is never mistaken for a name, however short', () => {
        // Only text that IS part of a firm's name on file counts as a search, so a real
        // enquiry cannot be swallowed by it — including one that names a firm and then
        // goes on to ask for something.
        expect(looksLikeFirmName('Sri Balaji Transports 20 MT to Madurai')).toBe(false);
        expect(looksLikeFirmName('300 mtr of 2 inch ERW medium')).toBe(false);
    });

    test('a pipe family typed on its own is not mistaken for a company name', () => {
        // "GI" would otherwise match "GI Tubes and Company" and stop ranking GI suppliers.
        expect(looksLikeFirmName('GI')).toBe(false);
        expect(looksLikeFirmName('ERW')).toBe(false);
    });

    test('a name nobody has on file is not treated as a search', () => {
        expect(looksLikeFirmName('Kalpataru Steel')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Source guards for the review fixes that would need a real browser to drive
// ─────────────────────────────────────────────────────────────────────────────

describe('source guard — nothing irreversible happens on one click', () => {
    test('the Discard warning says the email must be re-labelled in Gmail', () => {
        // The SENSE of the confirm — that Cancel keeps the item — is pinned by a real click
        // in "pressing Cancel on Discard keeps the firm" further down. This one only pins
        // the words, which a click cannot read.
        expect(bodyOf('discardWarningText')).toMatch(/Add-to-Directory label/);
        expect(bodyOf('discardWarningText')).toMatch(/no Undo/);
    });

    test('Load IS 1239 sizes asks — on the page — before replacing rows already typed in', () => {
        // It used to ask with window.confirm, which returns false in 5ms without appearing.
        // The button therefore did nothing at all whenever there was something to lose, which
        // is precisely when the question mattered.
        const handler = sliceBetween("[data-pd-loadis]", "[data-pd-addorule]");
        expect(handler).not.toContain('window.confirm');
        expect(handler).toMatch(/if \(!\(pr\.sizes \|\| \[\]\)\.length\) \{ fill\(\); return; \}/);
        expect(handler).toContain('askOnPage({');
        expect(handler).toContain('run: fill,');
        // …and it must still be a plain replace when there is nothing there to lose.
        expect(handler).toMatch(/pr\.sizes = IS1239\.filter/);
    });

    test('an entry covering many cards offers no Undo button it cannot honour', () => {
        // partnerId '' made Undo stamp "Undone", hide itself, and remove nothing at all.
        const body = bodyOf('undoRowHtml');
        expect(body).toMatch(/if \(!str\(ch\.partnerId\)\)/);
        expect(body).toMatch(/cannot be undone in one go/);
    });
});

describe('source guard — one open card, and a save that names only what was touched', () => {
    test('opening a pending item closes any open change, and the other way round', () => {
        // Two open cards showed two full edit forms; only the first was ever wired up.
        const changes = sliceBetween('function bindChanges(', 'The in-quote suggestion panel');
        expect(changes).toMatch(/S\.openChange = null;/);
        expect(changes).toMatch(/S\.openPending = null;\s*\/\/ one open card at a time/);
    });

    test('a branch edit writes branches only — never routes, city and address with it', () => {
        const body = bodyOf('bindPlaces');
        expect(body).not.toMatch(/\['branches', 'routes', 'city', 'address'\]/);
        expect(body).toMatch(/save\(false, \['branches'\]\)/);
        expect(body).toMatch(/save\(false, \['routes'\]\)/);
    });

    test('a product edit writes products only', () => {
        const body = bodyOf('bindSupply');
        expect(body).not.toMatch(/\['types', 'products', 'rules', 'moq'\]/);
        expect(body).toMatch(/save\(k === 'spec', \['products'\]\)/);
        expect(body).toMatch(/save\(true, \['types'\]\)/);
    });
});

describe('source guard — you can see what you are being asked to approve', () => {
    test('the email the card was read from is put on the screen', () => {
        const body = bodyOf('sourceEmailHtml');
        expect(body).toMatch(/esc\(text\)/);
        expect(body).toMatch(/too large to send for reading/);
    });

    test('Approve is held back while the firm has no name', () => {
        const body = bodyOf('approveRowHtml');
        expect(body).toMatch(/var nameless =/);
        expect(body).toMatch(/var stop = busy \|\| clashingCard\(pi, match\) \|\| nameless/);
    });

    test('a failed reading is not reported as an email with nothing in it', () => {
        expect(src).toMatch(/pi\.readFailed \? '<b>the reading failed/);
    });

    // The "check me" banner, its "I have checked this card" button and the "Need checking"
    // filter chip were removed at the owner's request — a lecture on every guessed card was
    // not worth the room it took. The row still carries its quiet "from an enquiry" pill, and
    // the ranking still treats a blank box as unknown rather than as a fact.

    test('a second address at a firm you already have is flagged before Approve', () => {
        const body = bodyOf('sameFirmNoteHtml');
        expect(body).toMatch(/emailDomain\(pi\.from\)/);
        expect(body).toMatch(/add this person to that card instead/);
        // Free mail is one person, not one firm — every gmail card must not look related.
        expect(src).toMatch(/SHARED_MAIL = \/\^\(gmail/);
    });
});

describe('an empty directory is never answered with "nobody fits"', () => {
    test('the finder falls back to the empty-directory panel, Import button and all', () => {
        // finderResults() returned BEFORE the empty check, so pasting an enquiry into a
        // fresh directory answered "Nobody in your directory fits this one" and took the
        // Import button off the page with it.
        const body = bodyOf('listHtml');
        const emptyAt = body.indexOf('if (!D.contacts.length) return emptyStateHtml();');
        const finderAt = body.indexOf('return finderResults();');
        expect(emptyAt).toBeGreaterThan(-1);
        expect(finderAt).toBeGreaterThan(-1);
        expect(emptyAt).toBeLessThan(finderAt);
    });

    test('a genuine "nobody fits" offers the two ways out, not a bare sentence', () => {
        expect(bodyOf('rankListHtml')).toMatch(/if \(!rows\.length\) return deadEndHtml\(need, opts\)/);
    });
});

describe('replies that were never counted are not reported as nought per cent', () => {
    test('an imported card is not accused of ignoring twelve enquiries', () => {
        // Reply tracking was built long after those enquiries went out, so the count is
        // nothing measured. It read 'Replied to 0 of 12 enquiries' in orange, and the
        // owner's most responsive suppliers all looked like people who never write back.
        setContacts([partner({ company: 'ImportedCo', city: 'Chennai', enq: 12, rep: 0, last: day(60) })]);
        const row = rankFor('material', readEnquiry(ENQUIRY))[0];
        expect(reasonMatching(row, /Replied to 0 of 12/)).toBeNull();
        const line = reasonMatching(row, /no reply recorded/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('neutral');
        expect(line[1]).toContain('Asked 12 times');
    });

    test('a firm that HAS replied still says so, and still earns the points', () => {
        setContacts([
            partner({ company: 'RepliesCo', city: 'Chennai', enq: 10, rep: 10, last: day(5) }),
            partner({ company: 'SilentCo', city: 'Chennai', enq: 10, rep: 0, last: day(5) }),
        ]);
        const rows = rankFor('material', readEnquiry(ENQUIRY));
        const line = reasonMatching(rowFor(rows, 'RepliesCo'), /Replied to 10 of 10/);
        expect(line).not.toBeNull();
        expect(line[0]).toBe('ok');
        expect(scoresByCompany(rows).RepliesCo - scoresByCompany(rows).SilentCo).toBe(20);
    });
});

describe('source guard — the cursor survives a redraw', () => {
    test('render captures focus before it replaces the page, and puts it back after', () => {
        // Tab out of Company and the card redraws; focus had already moved to the NEXT box,
        // and the redraw threw it away, so the next words typed went nowhere.
        const body = bodyOf('render');
        const grab = body.indexOf('focusKeeper(app)');
        const wipe = body.indexOf('app.innerHTML =');
        const back = body.indexOf('restoreFocus()');
        expect(grab).toBeGreaterThan(-1);
        expect(grab).toBeLessThan(wipe);
        expect(back).toBeGreaterThan(wipe);
        expect(bodyOf('focusKeeper')).toMatch(/setSelectionRange\(start, end\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. The repairs of the last review, driven for real
//
// Every test in this block was failed on purpose first, with the fix taken back out.
// The guards it replaces did not manage that: three whole fixes could be unplugged from
// the page with the suite still green, and inverting the Discard confirm — so pressing
// Cancel destroyed the item for good — changed nothing at all.
// ─────────────────────────────────────────────────────────────────────────────

const { focusKey, refreshWaitingBadge } = global.window.partnerDirectory._test;

/**
 * fakeAppEl, plus the querySelector the module uses to bind a lone button, and empty
 * children on each stub so bindCardFields can walk an open card without blowing up.
 */
function clickApp() {
    const base = fakeAppEl();
    const raw = base.querySelectorAll;
    base.querySelectorAll = (sel) => raw(sel).map((stub) => {
        if (!stub.querySelectorAll) {
            stub.querySelectorAll = () => [];
            stub.querySelector = () => null;
        }
        return stub;
    });
    base.querySelector = (sel) => base.querySelectorAll(sel)[0] || null;
    return base;
}

describe('the review fixes are actually on the screen, not merely in the file', () => {
    const { S } = _state();
    let realGetElementById;
    let app;
    let posts;

    beforeEach(() => {
        realGetElementById = global.document.getElementById;
        app = clickApp();
        global.document.getElementById = (id) => (id === 'partnerDirectoryApp' ? app : null);
        S.tab = 'dir'; S.filter = 'all'; S.openId = null; S.openPending = null;
        S.openChange = null; S.busy = {};
        S.find = { text: '', state: 'idle', need: null, note: '' };
        posts = [];
        D.saveError = ''; D.saveWhat = [];
    });

    afterEach(() => {
        global.document.getElementById = realGetElementById;
        delete global.window.confirm;
        FETCH = () => Promise.reject(new Error('no network in unit tests'));
        S.tab = 'dir'; S.filter = 'all'; S.openId = null; S.openPending = null;
        S.openChange = null; S.busy = {};
        D.saveError = ''; D.saveWhat = [];
        setContacts([]);
    });

    /** Serve one payload, open the tool the way the sidebar button does, return the HTML. */
    async function open(payload, tab, opts) {
        S.tab = tab || 'dir';
        const body = Object.assign({ contacts: [], changes: [], pending: [], duplicates: [] }, payload);
        FETCH = (url, o) => {
            if (o && o.method === 'POST') {
                posts.push({ url, body: JSON.parse(o.body) });
                return (opts && opts.postFails)
                    ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'the server said no' }) })
                    : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        };
        global.window.switchToDirectoryTab();
        await flush();
        return app.innerHTML;
    }

    const click = (attr, value) =>
        app.querySelectorAll('[' + attr + ']')
            .filter((el) => el.getAttribute(attr) === value)[0].onclick();

    const KALP = partner({
        id: 'p_kalp', company: 'Kalpataru Steel', city: 'Nashik', role: 'manufacturer',
        people: [{ name: 'Manish', role: 'Sales', phones: [], emails: [{ label: 'Work', v: 'manish@kalpatarusteel.com' }] }],
    });

    /** A queued email exactly as routes/contacts.js stores one that came in from Gmail. */
    function mailed(over) {
        return Object.assign({
            id: 'pd_1', origin: 'gmail', from: 'sales@kalpatarusteel.com',
            subject: 'Our rate list', file: 'rates.pdf', kind: 'pdf', text: '',
            finds: [], readFailed: false, receivedAt: new Date().toISOString(), preview: null,
        }, over || {});
    }

    // ── The three fixes that could be unplugged with the suite still green ────

    test('the email a queued card was read from is put on the screen when it is opened', async () => {
        // Mutation proved: deleting "sourceEmailHtml(pi) + " from pendingStrip fails this.
        S.openPending = 'pd_1';
        const html = await open({
            contacts: [],
            pending: [mailed({ text: 'Dear sir, our rates for 2 inch ERW are attached. Regards, Manish' })],
        }, 'changes');
        expect(html).toContain('pd-src-text');
        expect(html).toContain('our rates for 2 inch ERW are attached');
        expect(html).toContain('The email this was read from');
    });

    test('a card the app guessed carries no banner and nothing to tick off', async () => {
        // Removed at the owner's request. What stays is the quiet pill on the row and the
        // ranking's own caution about blank boxes — not a paragraph on every card.
        const guessed = partner({ id: 'p_ck', company: 'Guessed Traders', fromEnquiry: true });
        S.openId = 'p_ck';
        const html = await open({ contacts: [guessed] }, 'dir');
        expect(html).toContain('data-pd-card="p_ck"');      // the card really opened
        expect(html).not.toContain('data-pd-checked');
        expect(html).not.toContain('I have checked this card');
    });

    test('a second address at a firm you already have is flagged on the strip itself', async () => {
        // Mutation proved: deleting "+ sameFirmNoteHtml(pi, match)" from pendingStrip fails this.
        const html = await open({
            contacts: [KALP],
            pending: [mailed({ from: 'accounts@kalpatarusteel.com' })],
        }, 'changes');
        expect(html).toContain('add this person to that card instead');
        expect(html).toContain('data-pd-open="p_kalp"');
        expect(html).toContain('Kalpataru Steel');
    });

    test('and it is not said about a free-mail address, which is one person not one firm', async () => {
        const gmailCard = partner({
            id: 'p_gm', company: 'Ravi Traders',
            people: [{ name: 'Ravi', role: '', phones: [], emails: [{ label: 'Work', v: 'ravi.traders@gmail.com' }] }],
        });
        const html = await open({
            contacts: [gmailCard],
            pending: [mailed({ from: 'suresh.pipes@gmail.com' })],
        }, 'changes');
        expect(html).not.toContain('add this person to that card instead');
    });

    // ── Discard: the SENSE of the confirm, not its presence ───────────────────

    test('pressing Discard only ASKS — nothing is thrown away on that click', async () => {
        // The guard this replaces only checked that window.confirm was called at all.
        // Inverting the sense — so Cancel is what destroys it — left the suite green.
        // A browser dialog is refused outright now: it returns false without appearing, so
        // Discard did nothing whatever, silently.
        global.window.confirm = () => { throw new Error('a browser dialog must never be used here'); };
        await open({ contacts: [], pending: [mailed()] }, 'changes');
        click('data-pd-discard', 'pd_1');
        await flush();

        expect(app.innerHTML).toContain('data-pd-askok');   // the question is on the page
        expect(posts).toEqual([]);                          // and nothing has happened yet
        expect(S.busy.pd_1).toBeUndefined();
        expect(D.pending).toHaveLength(1);
    });

    test('pressing Cancel keeps the firm — nothing is sent, nothing is lost', async () => {
        await open({ contacts: [], pending: [mailed()] }, 'changes');
        click('data-pd-discard', 'pd_1');
        await flush();
        click('data-pd-askcancel', '1');
        await flush();

        expect(posts).toEqual([]);
        expect(D.pending).toHaveLength(1);
        expect(app.innerHTML).not.toContain('data-pd-askok');   // the question is gone
    });

    test('pressing Discard it is what throws it away — and only once', async () => {
        await open({ contacts: [], pending: [mailed()] }, 'changes');
        click('data-pd-discard', 'pd_1');
        await flush();
        click('data-pd-askok', '1');
        await flush();

        const discards = posts.filter((p) => String(p.url).indexOf('/contacts/pending/discard') !== -1);
        expect(discards).toHaveLength(1);
        expect(discards[0].body).toEqual({ id: 'pd_1' });
    });

    test('the warning names the firm being discarded, not "this one"', async () => {
        await open({ contacts: [], pending: [mailed({ subject: 'Balaji Tubes rate list' })] }, 'changes');
        click('data-pd-discard', 'pd_1');
        await flush();

        expect(app.innerHTML).toContain('Balaji Tubes rate list');
        expect(app.innerHTML).toContain('no Undo');
    });

    test('discarding an IMPORTED firm is not promised to be final — because it is not', async () => {
        // The one sentence was used for both kinds and was false for half of them. An
        // imported firm has no labelled email to go back to, and it returns the next time
        // the remembered addresses are brought in.
        await open({ contacts: [], pending: [mailed({ origin: 'import', subject: 'Sri Balaji Steels' })] }, 'changes');
        click('data-pd-discard', 'pd_1');
        await flush();

        const html = app.innerHTML;
        expect(html).toContain('will show up here again');
        expect(html).not.toContain('it will not arrive again');
        expect(html).not.toContain('Add-to-Directory label');   // there is no such email
    });

    // ── A failure names ITS OWN field, not whatever was saved last ────────────

    test('an unrelated failure does not accuse a field that was saved perfectly well', async () => {
        // D.saveWhat was one shared box, set only by savePartner and printed on EVERY
        // failure — so a discard that fell over announced "The check-me flag was NOT saved"
        // about a flag that had gone in an hour before.
        // 1. A real save that really fails, so the banner really names its own field. The
        //    trigger used to be the check-me button; it is a plain field edit now, which is
        //    the everyday case anyway.
        const card = partner({ id: 'p_ck', company: 'Guessed Traders', role: 'transporter' });
        S.openId = 'p_ck';
        await open({ contacts: [card], pending: [mailed()] }, 'dir', { postFails: true });
        D.saveWhat = ['city'];
        D.saveError = 'the server said no';
        global.window.switchToDirectoryTab();
        await flush();
        expect(app.innerHTML).toContain('The city was NOT saved');

        // 2. Now something else fails. It must speak for itself rather than borrow the
        //    last save's field name.
        click('data-pd-tab', 'changes');
        await flush();
        expect(app.innerHTML).toContain('data-pd-discard="pd_1"');
        click('data-pd-discard', 'pd_1');
        await flush();
        click('data-pd-askok', '1');
        await flush();

        // It names the ACTION that failed. "Your last edit was NOT saved — the box still
        // shows what you typed" was shown for seven different actions, none of which
        // involved typing in a box.
        expect(app.innerHTML).toContain('Discarding that one did not work');
        expect(app.innerHTML).not.toContain('The city was NOT saved');
        expect(app.innerHTML).not.toContain('the box still shows what you typed');
    });
    // The "check me" banner, its tick-off button and the "Need checking" chip were removed
    // at the owner's request. The tests that drove them went with the feature.
});

describe('focusKey — the buttons are told apart, so focus lands where it was', () => {
    const el = (tag, attrs) => ({
        tagName: tag,
        attributes: Object.keys(attrs).map((n) => ({ name: n, value: attrs[n] })),
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
    });

    test('Approve and Discard are not the same key', () => {
        // Every action button used to key to the same empty string, because the key was built
        // from a hand-written list of the nine attributes the TEXT BOXES use. A redraw that
        // changed how many buttons there are then handed focus to whichever button had taken
        // the old one's place — press Space and you hit Discard.
        const approve = el('BUTTON', { 'data-pd-approve': 'pd_1' });
        const discard = el('BUTTON', { 'data-pd-discard': 'pd_1' });
        expect(focusKey(approve)).not.toBe(focusKey(discard));
    });

    test('two Discard buttons on two different firms are not the same key either', () => {
        expect(focusKey(el('BUTTON', { 'data-pd-discard': 'pd_1' })))
            .not.toBe(focusKey(el('BUTTON', { 'data-pd-discard': 'pd_2' })));
    });

    test('the same button before and after a redraw IS the same key', () => {
        expect(focusKey(el('BUTTON', { 'data-pd-approve': 'p_a' })))
            .toBe(focusKey(el('BUTTON', { 'data-pd-approve': 'p_a' })));
    });

    test('the text boxes it always handled still work', () => {
        expect(focusKey(el('INPUT', { 'data-pd-k': 'company' })))
            .not.toBe(focusKey(el('INPUT', { 'data-pd-k': 'city' })));
        expect(focusKey(el('INPUT', { id: 'pdFindIn' })))
            .not.toBe(focusKey(el('INPUT', { 'data-pd-k': 'company' })));
    });
});

describe('the waiting count keeps itself honest on a tab left open all day', () => {
    let realGetElementById;
    let realCreateElement;
    let btn;
    let dot;

    beforeEach(() => {
        realGetElementById = global.document.getElementById;
        realCreateElement = global.document.createElement;
        dot = null;
        btn = {
            querySelector: () => dot,
            appendChild: (c) => { dot = c; c.remove = () => { dot = null; }; },
            classList: { add: () => {}, remove: () => {} },
        };
        global.document.getElementById = (id) => (id === 'mainToolDirectoryButton' ? btn : null);
        global.document.createElement = () => ({ className: '', textContent: '', title: '' });
    });

    afterEach(() => {
        global.document.getElementById = realGetElementById;
        global.document.createElement = realCreateElement;
        FETCH = () => Promise.reject(new Error('no network in unit tests'));
        setContacts([]);
    });

    const serve = (pending, contacts) => {
        FETCH = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ contacts: contacts || [], changes: [], pending, duplicates: [] }),
        });
    };

    test('a brochure tagged in Gmail at ten in the morning shows up without a reload', async () => {
        // The number was read once at load and then only when the directory itself was
        // re-read — so on the tab the owner leaves open all day it never changed.
        serve([]);
        refreshWaitingBadge(); await flush();
        expect(dot).toBeNull();

        serve([{ id: 'pd_1' }, { id: 'pd_2' }, { id: 'pd_3' }]);
        refreshWaitingBadge(); await flush();
        expect(dot.textContent).toBe('3');
        expect(dot.title).toContain('3 waiting');
    });

    test('and it goes away again once they have all been dealt with', async () => {
        serve([{ id: 'pd_1' }]);
        refreshWaitingBadge(); await flush();
        expect(dot.textContent).toBe('1');
        serve([]);
        refreshWaitingBadge(); await flush();
        expect(dot).toBeNull();
    });

    test('the check writes the badge and NOTHING else — no card is overwritten by it', async () => {
        // It must not be loadDirectory in disguise: that replaces D.contacts wholesale, and
        // a partner just added by hand, or a card being typed into, would go with it.
        const mine = [partner({ id: 'p_mine', company: 'Half-typed Traders' })];
        setContacts(mine);
        serve([{ id: 'pd_1' }], [partner({ id: 'p_server', company: 'Server Copy' })]);
        refreshWaitingBadge(); await flush();
        expect(D.contacts).toBe(mine);
        expect(D.contacts[0].company).toBe('Half-typed Traders');
        expect(D.pending).toEqual([]);
        expect(dot.textContent).toBe('1');
    });

    test('a failed check leaves the last known number alone rather than clearing it', async () => {
        serve([{ id: 'pd_1' }, { id: 'pd_2' }]);
        refreshWaitingBadge(); await flush();
        expect(dot.textContent).toBe('2');
        FETCH = () => Promise.reject(new Error('offline'));
        refreshWaitingBadge(); await flush();
        expect(dot).not.toBeNull();
        expect(dot.textContent).toBe('2');
    });

    test('a hidden tab is not asked at all', async () => {
        let calls = 0;
        FETCH = () => { calls += 1; return Promise.reject(new Error('should not be called')); };
        global.document.hidden = true;
        refreshWaitingBadge(); await flush();
        delete global.document.hidden;
        expect(calls).toBe(0);
    });

    test('source guard — something actually starts the repeat', () => {
        const body = bodyOf('startBadgeWatch');
        expect(body).toMatch(/setInterval\(refreshWaitingBadge, BADGE_EVERY_MS\)/);
        expect(body).toMatch(/visibilitychange/);
        expect(bodyOf('checkWhatIsWaiting')).toContain('startBadgeWatch()');
    });
});

describe('a failed save stays on the screen on a phone', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

    test('the sticky banner is replaced by a pinned one under 700px', () => {
        // html, body { overflow-x: hidden } on phones stops position:sticky sticking to
        // anything, so the warning scrolled away with the page while the box in front of you
        // still showed the value that was never stored.
        expect(css).toMatch(/\.pd-error-save\s*\{[^}]*position:\s*sticky/);
        const from = css.indexOf('.pd-error-save { position: sticky');
        const at = css.indexOf('@media (max-width: 700px)', from);
        expect(at).toBeGreaterThan(-1);
        const block = css.slice(at, at + 360);
        expect(block).toContain('.pd-error-save');
        expect(block).toMatch(/position:\s*fixed/);
        expect(block).toMatch(/top:\s*8px/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Are you sure?" before a partner is deleted
// ─────────────────────────────────────────────────────────────────────────────

describe('deleting a partner asks first, on the page', () => {
    // Reported twice as "delete this partner not working". The confirmation was a browser
    // window.confirm, and a browser set to suppress dialogs swallows that silently — so the
    // button did nothing at all and looked broken. It is now a popup the page draws itself,
    // which cannot be suppressed, and it says what the card is carrying rather than asking a
    // bare question.
    const src = require('fs').readFileSync(SRC_PATH, 'utf8');

    test('the delete button no longer relies on a browser dialog', () => {
        const at = src.indexOf("each(app, '[data-pd-delete]'");
        expect(at).toBeGreaterThan(-1);
        const handler = src.slice(at, src.indexOf('});', at));
        expect(handler).not.toContain('window.confirm');
        expect(handler).toContain('S.confirmDelete =');
    });

    test('nothing is deleted until the popup is answered', () => {
        // The click only sets a flag and redraws — the write lives behind the popup's own
        // button. A delete fired from the card itself would be a click away from gone.
        const at = src.indexOf("each(app, '[data-pd-delete]'");
        const handler = src.slice(at, src.indexOf('});', at));
        expect(handler).not.toContain('/contacts/delete');
        expect(src).toContain("on(app, '[data-pd-delok]'");
    });

    test('the popup says what the card is carrying, not just "are you sure"', () => {
        expect(src).toContain('function deleteLoses(p)');
        expect(src).toContain('Deleting takes all of it out of the directory.');
        // ...and that it can be undone, which is true — the route logs a removal entry.
        expect(src).toContain('It goes into <b>Recent changes</b>, so you can put it ');
    });

    test('a second press cannot delete twice', () => {
        // CLAUDE.md check 3. Without the lock the second call 404s and paints a red error over
        // a deletion that actually worked, which reads as "it failed" for something that did not.
        const at = src.indexOf("on(app, '[data-pd-delok]'");
        const handler = src.slice(at, src.indexOf('});', at));
        expect(handler).toContain('if (!id || S.busy[id]) return;');
        expect(handler).toContain('S.busy[id] = true;');
    });

    test('clicking inside the box does not count as cancelling', () => {
        // The backdrop closes it; the box must not. Otherwise reading the warning dismisses it.
        expect(src).toContain("if (el.getAttribute('data-pd-delcancel') === 'backdrop' && e.target !== el) return;");
    });
});

describe('a directory card holds your typing until you press Save', () => {
    /**
     * The owner's rule, in their words: "have save as you type in the review section and
     * save button in the database". So the two screens behave differently ON PURPOSE, and
     * the difference is what these tests pin:
     *
     *   REVIEW (an emailed card being checked)  — every keystroke is written to the queue
     *      item, because a reload there must not throw away corrections nobody re-typed.
     *   DIRECTORY (the real address book)       — nothing is written until Save is pressed.
     *
     * The danger with a Save button is the silent half: an edit sitting on screen that
     * looks stored and is not. So the count of unsaved boxes, and the ask before leaving,
     * are pinned as hard as the write itself.
     */
    const { markDirty, dirtyFields, isDirty, saveBarHtml, leaveCardOk, saveOpenCard,
            leavePopupHtml, closeCardNow } = global.window.partnerDirectory._test;
    const { S } = _state();
    let POSTS;

    beforeEach(() => {
        POSTS = [];
        S.dirty = {}; S.saveNote = ''; S.busy = {}; S.openId = null; S.confirmLeave = '';
        D.contacts = []; D.saveError = '';
        FETCH = (url, opt) => {
            POSTS.push({ url: String(url), body: JSON.parse((opt && opt.body) || '{}') });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, contacts: D.contacts }) });
        };
    });

    test('the bar counts the boxes you changed and offers Save', () => {
        const p = partner({ id: 'x1', company: 'Sri Steel' });
        expect(saveBarHtml(p)).toContain('No unsaved changes');

        markDirty(p, ['city']);
        expect(saveBarHtml(p)).toContain('1 change not saved yet');
        expect(saveBarHtml(p)).toContain('data-pd-save="x1"');

        markDirty(p, ['moq']);
        expect(saveBarHtml(p)).toContain('2 changes not saved yet');

        // Touching the same box twice is still one unsaved box, not two.
        markDirty(p, ['city']);
        expect(dirtyFields('x1').sort()).toEqual(['city', 'moq']);
    });

    test('Save writes only the boxes that were touched, and only once', async () => {
        const p = partner({ id: 'x2', company: 'Sri Steel', city: 'Hosur' });
        D.contacts = [p];
        markDirty(p, ['city']);

        saveOpenCard('x2');
        saveOpenCard('x2');          // an impatient second click must be a no-op
        await flush(); await flush();

        const saves = POSTS.filter((r) => r.url.indexOf('/contacts/save') !== -1);
        expect(saves).toHaveLength(1);
        expect(saves[0].body.fields).toEqual(['city']);   // NOT the whole object
        expect(saves[0].body.partner.city).toBe('Hosur');
        expect(isDirty('x2')).toBe(false);
        expect(saveBarHtml(p)).toContain('Saved.');
    });

    test('Save refuses a card with nothing on it, and says why', async () => {
        const blank = partner({ id: 'x3', company: '', people: [] });
        D.contacts = [blank];
        markDirty(blank, ['role']);          // picking a role leaves it still blank

        saveOpenCard('x3');
        await flush();

        expect(POSTS.filter((r) => r.url.indexOf('/contacts/save') !== -1)).toHaveLength(0);
        expect(S.saveNote).toContain('nothing to save yet');
        expect(isDirty('x3')).toBe(true);    // the edit is kept, not thrown away
    });

    test('a failed save keeps the card dirty — it must not read as stored', async () => {
        const p = partner({ id: 'x4', company: 'Sri Steel' });
        D.contacts = [p];
        markDirty(p, ['city']);
        FETCH = () => Promise.reject(new Error('offline'));

        saveOpenCard('x4');
        await flush(); await flush(); await flush();

        expect(isDirty('x4')).toBe(true);
        expect(saveBarHtml(p)).toContain('not saved yet');
        expect(saveBarHtml(p)).not.toContain('Saved.');
    });

    test('closing a card with unsaved boxes asks ON THE PAGE, not with a browser box', () => {
        // Reported live: "once opened, a card isn't closing". window.confirm was being
        // answered "no" without ever appearing, so the card silently refused to close and
        // nothing on screen said why. The question is now a popup, like Delete's.
        const p = partner({ id: 'x5', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'x5';

        window.confirm = () => { throw new Error('a browser dialog must never be used here'); };
        expect(leaveCardOk()).toBe(true);             // clean card — closes with no question
        expect(S.confirmLeave).toBeFalsy();

        markDirty(p, ['city']);
        expect(leaveCardOk()).toBe(false);            // dirty — held open, popup raised
        expect(S.confirmLeave).toBe('x5');

        const html = leavePopupHtml();
        expect(html).toContain('1 change not saved');
        expect(html).toContain('the city');           // names the box, not "field: city"
        expect(html).toContain('Sri Steel');
        expect(html).toContain('data-pd-leavesave');   // Save and close
        expect(html).toContain('data-pd-leavedrop');   // Close without saving
        expect(html).toContain('data-pd-leavecancel'); // Keep editing
    });

    test('the popup names every box that was changed', () => {
        const p = partner({ id: 'x6', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'x6';
        markDirty(p, ['city', 'people', 'moq']);
        leaveCardOk();

        const html = leavePopupHtml();
        expect(html).toContain('3 changes not saved');
        expect(html).toContain('the city');
        expect(html).toContain('the contacts');   // the app's own word for them
        expect(html).toContain('the minimum order');
    });

    test('"Save and close" does NOT close when the save fails', async () => {
        // The whole point of asking. Closing on a failed save loses the typing for good,
        // and the card would have looked saved on the way out.
        const p = partner({ id: 'x7', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'x7';
        markDirty(p, ['city']);
        leaveCardOk();
        FETCH = () => Promise.reject(new Error('offline'));

        const closed = await saveOpenCard('x7');
        await flush(); await flush();

        expect(closed).toBe(false);                   // so the handler does not close
        expect(isDirty('x7')).toBe(true);
        expect(leavePopupHtml()).toContain('It did not save');
    });

    test('"Save and close" closes once the directory really has it', async () => {
        const p = partner({ id: 'x8', company: 'Sri Steel', city: 'Hosur' });
        D.contacts = [p];
        S.openId = 'x8';
        markDirty(p, ['city']);
        leaveCardOk();

        const ok = await saveOpenCard('x8');
        await flush();
        expect(ok).toBe(true);
        closeCardNow();

        expect(S.openId).toBeNull();
        expect(S.confirmLeave).toBe('');
        expect(isDirty('x8')).toBe(false);
        expect(leavePopupHtml()).toBe('');            // and the question is gone with it
    });

    test('"Close without saving" throws the edit away — but only when asked to', () => {
        const p = partner({ id: 'x9', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'x9';
        markDirty(p, ['city']);
        leaveCardOk();
        expect(S.openId).toBe('x9');                  // still open while the question stands

        closeCardNow();
        expect(S.openId).toBeNull();
        expect(isDirty('x9')).toBe(false);
        expect(POSTS.filter((r) => r.url.indexOf('/contacts/save') !== -1)).toHaveLength(0);
    });
});

describe('every way out of a card asks the same question', () => {
    /**
     * Closing the card was only ONE way to walk away from unsaved typing. Found by driving
     * the real page: switching tab left the card dirty and went anyway, and a re-read of the
     * directory replaced the whole list — so the box went empty while the bar still said
     * "1 change not saved yet". Both of those lose work silently, which is the exact fault
     * the Save button was added to prevent.
     */
    const { markDirty, isDirty, leaveCardOk, closeCardNow, keepOpenEdits, leavePopupHtml } =
        global.window.partnerDirectory._test;
    const { S } = _state();

    beforeEach(() => {
        S.dirty = {}; S.saveNote = ''; S.busy = {}; S.openId = null;
        S.confirmLeave = ''; S.leaveThen = null; S.tab = 'dir';
        D.contacts = []; D.saveError = '';
    });

    test('a re-read keeps the box being typed in, and takes the rest from the server', () => {
        const mine = partner({ id: 'm1', company: 'Sri Steel', city: 'Hosur', moq: 0 });
        D.contacts = [mine];
        S.openId = 'm1';
        markDirty(mine, ['city']);                     // only the city was touched

        // What the server sends back: someone else filled in the minimum order meanwhile.
        const fromServer = [partner({ id: 'm1', company: 'Sri Steel', city: '', moq: 25 })];
        const merged = keepOpenEdits(D.contacts, fromServer);

        expect(merged[0].city).toBe('Hosur');          // the typing survived
        expect(merged[0].moq).toBe(25);                // the colleague's edit still landed
    });

    test('a re-read leaves a card alone once it is saved', () => {
        const mine = partner({ id: 'm2', company: 'Sri Steel', city: 'Hosur' });
        D.contacts = [mine];
        S.openId = 'm2';                                // open, but nothing unsaved on it
        const fromServer = [partner({ id: 'm2', company: 'Sri Steel', city: 'Chennai' })];
        expect(keepOpenEdits(D.contacts, fromServer)[0].city).toBe('Chennai');
    });

    test('a re-read never touches a card that is not the one open', () => {
        const a = partner({ id: 'm3', company: 'A', city: 'Hosur' });
        const b = partner({ id: 'm4', company: 'B', city: 'Salem' });
        D.contacts = [a, b];
        S.openId = 'm3';
        markDirty(a, ['city']);
        const fromServer = [partner({ id: 'm3', company: 'A', city: '' }),
                            partner({ id: 'm4', company: 'B', city: 'Trichy' })];
        const merged = keepOpenEdits(D.contacts, fromServer);
        expect(merged[0].city).toBe('Hosur');
        expect(merged[1].city).toBe('Trichy');         // the other card is the server's
    });

    test('switching tab with unsaved typing asks, and then finishes the switch', () => {
        const p = partner({ id: 'm5', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'm5';
        markDirty(p, ['city']);

        let switched = false;
        expect(leaveCardOk(() => { switched = true; })).toBe(false);   // held
        expect(S.confirmLeave).toBe('m5');
        expect(switched).toBe(false);                  // and it did NOT go anyway

        closeCardNow();                                // "Close without saving"
        expect(switched).toBe(true);                   // the click they made still happens
        expect(S.openId).toBeNull();
        expect(isDirty('m5')).toBe(false);
    });

    test('"Keep editing" forgets where they were going, so the next answer cannot run it', () => {
        const p = partner({ id: 'm6', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'm6';
        markDirty(p, ['city']);

        let ran = 0;
        leaveCardOk(() => { ran += 1; });
        S.confirmLeave = ''; S.leaveThen = null;       // what "Keep editing" does
        expect(leavePopupHtml()).toBe('');

        // They carry on, then close properly this time. The old errand must not fire.
        leaveCardOk();
        closeCardNow();
        expect(ran).toBe(0);
    });

    test('a clean card lets every way out through without a word', () => {
        const p = partner({ id: 'm7', company: 'Sri Steel' });
        D.contacts = [p];
        S.openId = 'm7';
        let went = false;
        expect(leaveCardOk(() => { went = true; })).toBe(true);
        expect(S.confirmLeave).toBeFalsy();
        expect(went).toBe(false);   // the caller runs its own errand when it gets true
    });
});

describe('source guard — the WIRING of the unsaved-work question', () => {
    /**
     * The behavioural tests above call keepOpenEdits, saveOpenCard and leaveCardOk directly.
     * Every one of them passed with the wiring ripped out — five mutations escaped clean:
     * the merge not called from loadDirectory, the tab and open-card handlers not asking,
     * "Save and close" closing on a failed save, "Keep editing" leaving the errand armed.
     *
     * A helper that nothing calls is not a feature. These pin the call sites.
     */

    test('loadDirectory really runs the merge — a plain overwrite is the original bug', () => {
        const fn = sliceBetween('function loadDirectory(then)', 'function keepOpenEdits');
        expect(fn).toContain('D.contacts = keepOpenEdits(D.contacts, d.contacts || []);');
        expect(fn).not.toMatch(/D\.contacts = d\.contacts \|\| \[\];/);
    });

    test('the tab buttons ask before walking off an unsaved card', () => {
        const fn = sliceBetween("each(app, '[data-pd-tab]'", "each(app, '[data-pd-filter]'");
        expect(fn).toContain('if (!leaveCardOk(');
        // and the switch happens AFTER the question, not before it
        expect(fn.indexOf('leaveCardOk')).toBeLessThan(fn.indexOf("S.tab = el.getAttribute('data-pd-tab')"));
    });

    test('opening another card asks before abandoning the one being typed in', () => {
        const fn = sliceBetween("each(app, '[data-pd-open]'", "each(app, '[data-pd-close]'");
        expect(fn).toContain("!== S.openId && !leaveCardOk(go)) return;");
        // Re-clicking the card you are ALREADY in must not raise the question about itself.
        expect(fn).toContain("el.getAttribute('data-pd-open') !== S.openId");
    });

    test('"Save and close" closes only on the promise resolving TRUE', () => {
        const fn = sliceBetween("on(app, '[data-pd-leavesave]'", "on(app, '[data-pd-save]'");
        expect(fn).toContain('saveOpenCard(id).then(function (ok) { if (ok) closeCardNow(false); });');
        expect(fn).toContain("if (!id || S.busy['save' + id]) return;");   // one press, one save
    });

    test('"Keep editing" clears the errand as well as the question', () => {
        const fn = sliceBetween("each(app, '[data-pd-leavecancel]'", "on(app, '[data-pd-leavedrop]'");
        expect(fn).toContain("S.confirmLeave = ''; S.leaveThen = null;");
        // the backdrop closes it; a click inside the box must not
        expect(fn).toContain("=== 'backdrop' && e.target !== el) return;");
    });

    test('"Close without saving" is the only answer that throws typing away', () => {
        const fn = sliceBetween("on(app, '[data-pd-leavedrop]'", "on(app, '[data-pd-leavesave]'");
        // TRUE means "put the card back". It used to clear the dirty flags only, leaving
        // every discarded character sitting on the card.
        expect(fn).toContain('closeCardNow(true);');
        expect(fn).not.toContain('savePartner');
    });
});

describe('no button in the Partner Directory hides behind a browser dialog', () => {
    /**
     * window.confirm returns FALSE in this app in about 5 milliseconds, without ever
     * appearing. Every button guarded by one therefore did nothing whatever, and said
     * nothing about it. Reported live twice — "delete this partner not working" and
     * "once opened, a card isn't closing" — and three more were sitting there unreported:
     *
     *   Undo a change            never undid anything
     *   Discard a queued firm    never discarded anything
     *   Load IS 1239 sizes       did nothing whenever there were rows to replace,
     *                            which is exactly when the question mattered
     *
     * They all ask on the page now. This is the guard that stops the next one appearing.
     */
    const src = require('fs').readFileSync(SRC_PATH, 'utf8');

    test('there is not a single window.confirm left in partner-directory.js', () => {
        const uses = src.split('\n')
            .map((line, i) => ({ line: line.trim(), n: i + 1 }))
            .filter((r) => /window\.confirm\s*\(/.test(r.line) && !/^\s*[*/]/.test(r.line));
        expect(uses.map((r) => r.n + ': ' + r.line)).toEqual([]);
    });

    test('nor a prompt or an alert, which fail the same way', () => {
        expect(src).not.toMatch(/[^.\w]window\.(prompt|alert)\s*\(/);
    });

    test('the on-page question cannot be double-pressed into two writes', () => {
        // Its OK button runs an action that writes. A second press before the first returns
        // would be a second discard, a second undo, a second replace.
        const at = src.indexOf("on(app, '[data-pd-askok]'");
        expect(at).toBeGreaterThan(-1);
        const handler = src.slice(at, src.indexOf("each(app, '#pdAskIn'", at));
        expect(handler).toContain('if (!a || a.busy) return;');
        expect(handler).toContain('a.busy = true;');
        // and it is cleared BEFORE running, so the popup cannot be answered twice
        expect(handler.indexOf('S.ask = null;')).toBeLessThan(handler.indexOf('run(typed);'));
    });

    test('a click inside the question box does not count as cancelling it', () => {
        const at = src.indexOf("each(app, '[data-pd-askcancel]'");
        const handler = src.slice(at, src.indexOf('});', at));
        expect(handler).toContain("=== 'backdrop' && e.target !== el) return;");
    });
});

describe('"＋ Add another…" pipe type asks on the page too', () => {
    /**
     * This one used window.prompt, which is worse than confirm here: in the owner's browser
     * it THROWS rather than returning nothing, so the click handler died half way and
     * picking "＋ Add another…" did nothing whatever — no box, no message, no type added.
     */
    const src = require('fs').readFileSync(SRC_PATH, 'utf8');
    const handler = (() => {
        const at = src.indexOf("on(card, '[data-pd-addtype]'");
        return src.slice(at, src.indexOf('each(card,', at));
    })();

    test('it does not call window.prompt', () => {
        expect(handler).not.toMatch(/window\.prompt\s*\(/);   // a CALL, not the word in a comment
        expect(handler).toContain('askOnPage({');
        expect(handler).toContain("ask: 'Type it in'");
    });

    test('a normal pick still adds straight away, with no question', () => {
        expect(handler).toContain("if (v !== '__other') { addType(v); return; }");
    });

    test('the same type cannot go on twice under a different case', () => {
        // An import writes SEAMLESS, the dropdown offers Seamless. The rule survived the
        // rewrite — it now lives inside addType, which BOTH paths go through.
        expect(handler).toMatch(/lower\(t\) === lower\(v\)/);
        expect(handler).toContain('var addType = function (v)');
    });

    test('an empty answer holds the question open instead of quietly doing nothing', () => {
        // Exactly what prompt() did on Cancel: closed, added nothing, said nothing.
        const ok = src.slice(src.indexOf("on(app, '[data-pd-askok]'"));
        expect(ok).toContain('if (!typed) { if (box) box.focus(); return; }');
    });
});

describe('the three ways the Save button could still lose your typing', () => {
    /**
     * All three were found by hunting the code AFTER the Save button shipped, not by the
     * suite — which was green through every one of them.
     *
     *  1. "Close without saving" cleared the dirty FLAGS and nothing else. The edits are
     *     written straight onto the card object, so the discarded text stayed on the row,
     *     stayed in the boxes under "No unsaved changes.", and went into the directory for
     *     real on the next save of that same group.
     *  2. Anything typed WHILE a save was in flight was marked saved without ever being
     *     sent, and the bar then read "Saved."
     *  3. The role chips sit directly above the open card and closed it with no question.
     */
    const { markDirty, isDirty, dirtyFields, saveOpenCard, leaveCardOk, closeCardNow,
            holdCleanCopy, restoreCleanCopy, saveBarHtml } = global.window.partnerDirectory._test;
    const { S } = _state();
    let POSTS;

    beforeEach(() => {
        POSTS = [];
        S.dirty = {}; S.clean = {}; S.saveNote = ''; S.busy = {}; S.openId = null;
        S.confirmLeave = ''; S.leaveThen = null; S.filter = 'all';
        D.contacts = []; D.saveError = '';
        FETCH = (url, opt) => {
            POSTS.push({ url: String(url), body: JSON.parse((opt && opt.body) || '{}') });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
        };
    });

    test('"Close without saving" really puts the card back', async () => {
        const p = partner({ id: 'r1', company: 'MSL Tubes', city: 'Chennai' });
        D.contacts = [p];
        S.openId = 'r1';
        holdCleanCopy(p);                      // as bindCardFields does, before any keystroke

        p.company = 'MSL Tubes Pvt Ltd';       // as the field handler does
        p.city = 'Hosur';
        markDirty(p, ['company', 'city']);

        leaveCardOk();
        closeCardNow(true);

        const back = D.contacts.filter((c) => c.id === 'r1')[0];
        expect(back.company).toBe('MSL Tubes');   // not the discarded text
        expect(back.city).toBe('Chennai');
        expect(isDirty('r1')).toBe(false);
        expect(S.clean.r1).toBeUndefined();
    });

    test('the clean copy is taken ONCE, not refreshed on every redraw', async () => {
        // bindCardFields runs on EVERY render of the open card, and a render happens on every
        // keystroke that marks the card dirty. Without the "already held" guard the copy would
        // be retaken carrying the typing, and "Close without saving" would restore the very
        // text it was asked to throw away — looking fixed while doing nothing.
        const p = partner({ id: 'r1b', company: 'MSL Tubes' });
        D.contacts = [p];
        S.openId = 'r1b';
        holdCleanCopy(p);                  // first render, nothing typed yet

        p.company = 'Typed after opening';
        markDirty(p, ['company']);         // markDirty renders, so bindCardFields runs again
        holdCleanCopy(p);                  // ...and this is that second call
        holdCleanCopy(p);                  // and a third, for good measure

        expect(S.clean['r1b'].company).toBe('MSL Tubes');

        leaveCardOk();
        closeCardNow(true);
        expect(D.contacts.filter((c) => c.id === 'r1b')[0].company).toBe('MSL Tubes');
    });

    test('a discarded edit cannot ride along on the NEXT save of that card', async () => {
        // The nastiest half: savePartner sends p[field] as it stands. With the discarded
        // text still on the card, saving anything in that same group wrote it for real.
        const p = partner({ id: 'r2', company: 'MSL Tubes' });
        D.contacts = [p];
        S.openId = 'r2';
        holdCleanCopy(p);

        p.company = 'Typed by mistake';
        markDirty(p, ['company']);
        leaveCardOk();
        closeCardNow(true);

        // Reopen and save something else entirely.
        S.openId = 'r2';
        const again = D.contacts.filter((c) => c.id === 'r2')[0];
        holdCleanCopy(again);
        again.city = 'Salem';
        markDirty(again, ['city']);
        await saveOpenCard('r2');
        await flush();

        const sent = POSTS.filter((r) => r.url.indexOf('/contacts/save') !== -1)[0];
        expect(sent.body.partner.company).toBe('MSL Tubes');
        expect(sent.body.fields).toEqual(['city']);
    });

    test('"Save and close" keeps the edit — it does not put the card back', async () => {
        const p = partner({ id: 'r3', company: 'MSL Tubes' });
        D.contacts = [p];
        S.openId = 'r3';
        holdCleanCopy(p);
        p.company = 'MSL Tubes Pvt Ltd';
        markDirty(p, ['company']);

        const ok = await saveOpenCard('r3');
        await flush();
        expect(ok).toBe(true);
        closeCardNow(false);

        expect(D.contacts.filter((c) => c.id === 'r3')[0].company).toBe('MSL Tubes Pvt Ltd');
    });

    test('typing WHILE it saves is not marked saved, and the bar says so', async () => {
        const p = partner({ id: 'r4', company: 'MSL Tubes', city: '' });
        D.contacts = [p];
        S.openId = 'r4';
        markDirty(p, ['city']);

        let release;
        FETCH = (url, opt) => {
            POSTS.push({ url: String(url), body: JSON.parse((opt && opt.body) || '{}') });
            return new Promise((r) => { release = () => r({ ok: true, json: () => Promise.resolve({ ok: true }) }); });
        };
        const saving = saveOpenCard('r4');

        // ...and while it is in the air, the owner types somewhere else.
        p.vehicles = '3 lorries';
        markDirty(p, ['vehicles']);

        release();
        await saving;
        await flush();

        expect(dirtyFields('r4')).toEqual(['vehicles']);        // still waiting, not "saved"
        expect(saveBarHtml(p)).toContain('1 change not saved yet');
        expect(S.saveNote).toContain('changed more since');
        expect(POSTS[0].body.fields).toEqual(['city']);          // only what was actually sent
    });

    test('re-typing the SAME box mid-save leaves it waiting, not falsely saved', async () => {
        const p = partner({ id: 'r5', company: 'MSL Tubes', city: 'Hosur' });
        D.contacts = [p];
        S.openId = 'r5';
        markDirty(p, ['city']);

        let release;
        FETCH = (url, opt) => {
            POSTS.push({ url: String(url), body: JSON.parse((opt && opt.body) || '{}') });
            return new Promise((r) => { release = () => r({ ok: true, json: () => Promise.resolve({ ok: true }) }); });
        };
        const saving = saveOpenCard('r5');
        p.city = 'Salem';                       // changed again before the reply came back
        release();
        await saving;
        await flush();

        expect(POSTS[0].body.partner.city).toBe('Hosur');   // what actually went
        expect(dirtyFields('r5')).toEqual(['city']);        // the newer value still needs saving
    });

    test('a role chip asks before closing a card being typed in', () => {
        const p = partner({ id: 'r6', company: 'MSL Tubes' });
        D.contacts = [p];
        S.openId = 'r6';
        markDirty(p, ['city']);

        let switched = false;
        expect(leaveCardOk(() => { switched = true; })).toBe(false);
        expect(S.confirmLeave).toBe('r6');
        expect(switched).toBe(false);
    });
});

describe('source guard — the chips and the finder do not sneak past the question', () => {
    test('the role chips ask', () => {
        const fn = sliceBetween("each(app, '[data-pd-filter]'", 'bindFinder(app);');
        expect(fn).toContain('if (!leaveCardOk(');
        expect(fn.indexOf('leaveCardOk')).toBeLessThan(fn.indexOf('S.openId = null'));
    });

    test('the clean copy is taken before the first keystroke, not after', () => {
        const fn = sliceBetween('function bindCardFields(app)', 'function bindPeople');
        expect(fn).toContain('holdCleanCopy(p);');
        // it must be taken at BIND time, before any field handler can write to the card
        expect(fn.indexOf('holdCleanCopy(p);')).toBeLessThan(fn.indexOf('p[k] = v'));
    });

    test('the clean copy is a real copy, not a second name for the same card', () => {
        // Object.assign or a bare reference would mutate along with the card and restore
        // nothing at all — the bug would look fixed and not be.
        const fn = sliceBetween('function holdCleanCopy(p)', 'function restoreCleanCopy');
        expect(fn).toContain('JSON.parse(JSON.stringify(p))');
    });
});
