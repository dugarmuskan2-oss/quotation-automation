/**
 * tests/freight-suggestions.test.js
 *
 * Route-aware freight-suggestion memory (routes/config.js). Tests the pure helpers
 * exported on createConfigRouter._test: sanitizeFreightSuggestions + mergeFreightUsage.
 * These back GET/POST /api/(get|save)-freight-suggestions — remembering which
 * transporters were emailed for which pickup→drop route.
 */

const { sanitizeFreightSuggestions, mergeFreightUsage, normalizePlace } = require('../routes/config')._test;

// Convenience: apply one "send" to a suggestions state and return the new state.
function send(state, recipients, pickup, drop) {
    return mergeFreightUsage(state, { recipients, pickup, drop });
}
function empty() {
    return sanitizeFreightSuggestions({});
}
function findT(list, email) {
    return (list || []).find(t => t.email === email);
}
function findRoute(state, pickup, drop) {
    const np = normalizePlace(pickup), nd = normalizePlace(drop);
    return state.routes.find(r => normalizePlace(r.pickup) === np && normalizePlace(r.drop) === nd);
}

describe('sanitizeFreightSuggestions', () => {
    test('empty / non-object input yields the empty shape', () => {
        for (const bad of [undefined, null, 'x', 42, {}]) {
            const s = sanitizeFreightSuggestions(bad);
            expect(s).toEqual({ transporters: [], routes: [], pickups: [], drops: [] });
        }
    });

    test('drops transporters without a usable email and coerces count', () => {
        const s = sanitizeFreightSuggestions({
            transporters: [
                { email: 'a@x.com', count: '3' },
                { email: '   ' },           // blank -> dropped
                { count: 5 },               // no email -> dropped
                { email: 'b@x.com' },       // no count -> defaults to 1
            ],
        });
        expect(s.transporters.map(t => t.email)).toEqual(['a@x.com', 'b@x.com']);
        expect(findT(s.transporters, 'a@x.com').count).toBe(3);
        expect(findT(s.transporters, 'b@x.com').count).toBe(1);
    });

    test('drops routes with no pickup or no transporters', () => {
        const s = sanitizeFreightSuggestions({
            routes: [
                { pickup: 'Chennai', drop: 'Hyderabad', transporters: [{ email: 'a@x.com', count: 1 }] },
                { pickup: '', drop: 'X', transporters: [{ email: 'b@x.com' }] },     // no pickup -> dropped
                { pickup: 'Delhi', transporters: [] },                              // no transporters -> dropped
            ],
        });
        expect(s.routes).toHaveLength(1);
        expect(s.routes[0].pickup).toBe('Chennai');
    });

    test('caps pickups/drops at 10', () => {
        const many = Array.from({ length: 25 }, (_, i) => 'place-' + i);
        const s = sanitizeFreightSuggestions({ pickups: many, drops: many });
        expect(s.pickups).toHaveLength(10);
        expect(s.drops).toHaveLength(10);
    });

    test('caps routes at 60', () => {
        const routes = Array.from({ length: 80 }, (_, i) => ({
            pickup: 'p' + i, drop: 'd', transporters: [{ email: 't@x.com', count: 1 }],
        }));
        expect(sanitizeFreightSuggestions({ routes }).routes).toHaveLength(60);
    });
});

describe('mergeFreightUsage — global + route memory', () => {
    test('first send records the transporters globally and under the route', () => {
        const s = send(empty(), ['ravi@sri.in', 'gopal@hyd.in'], 'DSC Warehouse, Chennai', 'Hyderabad');
        expect(s.transporters.map(t => t.email).sort()).toEqual(['gopal@hyd.in', 'ravi@sri.in']);
        const route = findRoute(s, 'DSC Warehouse, Chennai', 'Hyderabad');
        expect(route).toBeTruthy();
        expect(route.transporters.map(t => t.email).sort()).toEqual(['gopal@hyd.in', 'ravi@sri.in']);
    });

    test('re-sending to the same transporter on the same route bumps both counts', () => {
        let s = send(empty(), ['ravi@sri.in'], 'Chennai', 'Hyderabad');
        s = send(s, ['ravi@sri.in'], 'Chennai', 'Hyderabad');
        expect(findT(s.transporters, 'ravi@sri.in').count).toBe(2);
        expect(findT(findRoute(s, 'Chennai', 'Hyderabad').transporters, 'ravi@sri.in').count).toBe(2);
    });

    test('same transporter on two routes = two buckets, global count aggregates', () => {
        let s = send(empty(), ['ravi@sri.in'], 'Chennai', 'Hyderabad');
        s = send(s, ['ravi@sri.in'], 'Chennai', 'Mumbai');
        expect(s.routes).toHaveLength(2);
        expect(findRoute(s, 'Chennai', 'Hyderabad').transporters).toHaveLength(1);
        expect(findRoute(s, 'Chennai', 'Mumbai').transporters).toHaveLength(1);
        expect(findT(s.transporters, 'ravi@sri.in').count).toBe(2); // once per route
    });

    test('a different drop is a different route bucket', () => {
        let s = send(empty(), ['ravi@sri.in'], 'Chennai', 'Hyderabad');
        s = send(s, ['vrl@mum.in'], 'Chennai', 'Mumbai');
        const hyd = findRoute(s, 'Chennai', 'Hyderabad');
        const mum = findRoute(s, 'Chennai', 'Mumbai');
        expect(hyd.transporters.map(t => t.email)).toEqual(['ravi@sri.in']);
        expect(mum.transporters.map(t => t.email)).toEqual(['vrl@mum.in']);
    });

    test('route key ignores case and extra whitespace in pickup/drop', () => {
        let s = send(empty(), ['ravi@sri.in'], 'DSC Warehouse, Chennai', 'Hyderabad');
        s = send(s, ['ravi@sri.in'], '  dsc   warehouse, chennai ', 'HYDERABAD');
        expect(s.routes).toHaveLength(1);
        expect(findT(s.routes[0].transporters, 'ravi@sri.in').count).toBe(2);
    });

    test('no pickup: still records globally but creates no route', () => {
        const s = send(empty(), ['ravi@sri.in'], '', '');
        expect(findT(s.transporters, 'ravi@sri.in').count).toBe(1);
        expect(s.routes).toHaveLength(0);
    });

    test('empty recipients: no route, global untouched', () => {
        let s = send(empty(), ['ravi@sri.in'], 'Chennai', 'Hyderabad');
        const before = s.transporters.length;
        s = send(s, [], 'Chennai', 'Hyderabad');
        expect(s.transporters).toHaveLength(before);
        expect(findRoute(s, 'Chennai', 'Hyderabad').transporters).toHaveLength(1);
    });

    test('most-used transporter sorts first within global and route', () => {
        let s = send(empty(), ['ravi@sri.in', 'gopal@hyd.in'], 'Chennai', 'Hyderabad');
        s = send(s, ['gopal@hyd.in'], 'Chennai', 'Hyderabad'); // gopal now used twice
        expect(s.transporters[0].email).toBe('gopal@hyd.in');
        expect(findRoute(s, 'Chennai', 'Hyderabad').transporters[0].email).toBe('gopal@hyd.in');
    });

    test('pickups/drops are MRU: most recent first, deduped case-insensitively', () => {
        let s = send(empty(), ['a@x.com'], 'Chennai', 'Hyderabad');
        s = send(s, ['a@x.com'], 'Mumbai', 'Delhi');
        s = send(s, ['a@x.com'], 'chennai', 'delhi'); // re-use, different case
        expect(s.pickups[0]).toBe('chennai');          // most recent, only once
        expect(s.pickups.filter(p => p.toLowerCase() === 'chennai')).toHaveLength(1);
        expect(s.drops[0]).toBe('delhi');
    });

    test('caps a route bucket and the global list at 50 transporters', () => {
        let s = empty();
        for (let i = 0; i < 55; i++) s = send(s, ['t' + i + '@x.com'], 'Chennai', 'Hyderabad');
        expect(s.transporters).toHaveLength(50);
        expect(findRoute(s, 'Chennai', 'Hyderabad').transporters).toHaveLength(50);
    });
});
