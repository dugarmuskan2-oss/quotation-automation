/**
 * @jest-environment node
 *
 * tests/permissions-core.test.js
 *
 * The pure rules behind per-person permissions, the old admin/staff names, the
 * "Forgot password?" link, and the Edit-margins list-rate memory. All four modules
 * are required directly — these are the real functions the server and browser use.
 *
 *   utils/permissions.js   — tick lists, the bootstrap rule (lists OFF until someone
 *                            holds managePeople), the last-manager guard, per-request
 *                            permissions (authOpen = all, no user = nothing), stampName.
 *   utils/peopleRoles.js   — "admin" / "staff" derived from managePeople.
 *   utils/passwordReset.js — signed, expiring, one-use reset tokens; password rules;
 *                            the office email.
 *   utils/calculations.js  — stampAdminMargins: seamless cost mode remembers the list
 *                            rate once (listUnitRate); price mode puts it back.
 */

'use strict';

const P = require('../utils/permissions');
const R = require('../utils/peopleRoles');
const PR = require('../utils/passwordReset');
const { stampAdminMargins } = require('../utils/calculations');

const ALL_KEYS = ['allocateMargins', 'editMargins', 'addNotes', 'deleteNotes', 'addRevisions', 'managePeople'];

// ───────────────────────────────────────────────────────────────────────────────
// utils/permissions.js
// ───────────────────────────────────────────────────────────────────────────────

describe('permissions — the list of ticks', () => {
    test('six permissions, in heading order; ALL mirrors them', () => {
        expect(P.PERMISSIONS.map((p) => p.key)).toEqual(ALL_KEYS);
        expect(P.ALL).toEqual(ALL_KEYS);
        P.PERMISSIONS.forEach((p) => {
            expect(typeof p.group).toBe('string');
            expect(p.label).toBeTruthy();
        });
    });

    test('someone with no ticks and no role may only add revision requests', () => {
        expect(P.STAFF_DEFAULT).toEqual(['addRevisions']);
    });
});

describe('cleanPermissions — only known keys, once each, in list order', () => {
    test('drops unknown keys and duplicates, re-orders to the list order', () => {
        expect(P.cleanPermissions(['managePeople', 'bogus', 'addNotes', 'addNotes', 'allocateMargins']))
            .toEqual(['allocateMargins', 'addNotes', 'managePeople']);
    });

    test('non-array input -> empty list', () => {
        expect(P.cleanPermissions(null)).toEqual([]);
        expect(P.cleanPermissions(undefined)).toEqual([]);
        expect(P.cleanPermissions('managePeople')).toEqual([]);
        expect(P.cleanPermissions({ managePeople: true })).toEqual([]);
    });

    test('a key that only looks like one (wrong case, padded) is not accepted', () => {
        expect(P.cleanPermissions(['ManagePeople', ' addNotes', 'addnotes'])).toEqual([]);
    });
});

describe('permissionsOf — stored ticks, with back-compat for older records', () => {
    test('a stored tick list is used as-is (cleaned)', () => {
        expect(P.permissionsOf({ email: 'a@x', permissions: ['addNotes', 'nope'] })).toEqual(['addNotes']);
    });

    test('the tick list wins over an old role: admin', () => {
        expect(P.permissionsOf({ email: 'a@x', role: 'admin', permissions: ['addNotes'] })).toEqual(['addNotes']);
    });

    test('an explicitly EMPTY tick list means nothing — not the staff default', () => {
        expect(P.permissionsOf({ email: 'a@x', permissions: [] })).toEqual([]);
    });

    test('legacy role: admin with no tick list -> every permission', () => {
        expect(P.permissionsOf({ email: 'a@x', role: 'admin' })).toEqual(ALL_KEYS);
    });

    test('no tick list and no admin role -> staff default', () => {
        expect(P.permissionsOf({ email: 'a@x' })).toEqual(['addRevisions']);
        expect(P.permissionsOf({ email: 'a@x', role: 'staff' })).toEqual(['addRevisions']);
        expect(P.permissionsOf(null)).toEqual(['addRevisions']);
        expect(P.permissionsOf(undefined)).toEqual(['addRevisions']);
    });

    test('returns a copy — changing it cannot change the shared ALL / STAFF_DEFAULT', () => {
        const a = P.permissionsOf(null);
        a.push('managePeople');
        expect(P.STAFF_DEFAULT).toEqual(['addRevisions']);
        const b = P.permissionsOf({ role: 'admin' });
        b.length = 0;
        expect(P.ALL).toEqual(ALL_KEYS);
    });
});

describe('managerCount / listsOn — the lists switch on with the first people-manager', () => {
    const staff = { email: 's@x', permissions: ['addRevisions'] };
    const manager = { email: 'm@x', permissions: ['managePeople'] };
    const legacyAdmin = { email: 'l@x', role: 'admin' };

    test('counts people with managePeople, including legacy admins', () => {
        expect(P.managerCount([staff])).toBe(0);
        expect(P.managerCount([staff, manager])).toBe(1);
        expect(P.managerCount([staff, manager, legacyAdmin])).toBe(2);
    });

    test('non-array / null entries are tolerated', () => {
        expect(P.managerCount(null)).toBe(0);
        expect(P.managerCount([null, manager])).toBe(1);
    });

    test('lists are OFF while nobody manages people, ON once someone does', () => {
        expect(P.listsOn([])).toBe(false);
        expect(P.listsOn([staff, { email: 'x@x' }])).toBe(false);
        expect(P.listsOn([staff, manager])).toBe(true);
        expect(P.listsOn([legacyAdmin])).toBe(true);
    });
});

describe('effectivePermissions / can — what the signed-in person may do now', () => {
    const users = [
        { email: 'Boss@DSC.com', permissions: ['managePeople', 'allocateMargins'] },
        { email: 'staff@dsc.com', permissions: ['addNotes'] },
        { email: 'old@dsc.com', role: 'admin' },
        { email: 'plain@dsc.com' },
    ];

    test('bootstrap: with nobody managing people, everyone may do everything', () => {
        const noManagers = [{ email: 'a@x', permissions: ['addNotes'] }, { email: 'b@x' }];
        expect(P.effectivePermissions(noManagers, 'a@x')).toEqual(ALL_KEYS);
        expect(P.effectivePermissions(noManagers, 'b@x')).toEqual(ALL_KEYS);
        expect(P.effectivePermissions([], 'anyone@x')).toEqual(ALL_KEYS);
        expect(P.can(noManagers, 'a@x', 'managePeople')).toBe(true);
    });

    test('bootstrap: someone not on the list also gets everything while lists are off', () => {
        expect(P.effectivePermissions([{ email: 'a@x' }], 'stranger@x')).toEqual(ALL_KEYS);
    });

    test('lists on: each person gets their own ticks', () => {
        expect(P.effectivePermissions(users, 'staff@dsc.com')).toEqual(['addNotes']);
        expect(P.effectivePermissions(users, 'Boss@DSC.com')).toEqual(['allocateMargins', 'managePeople']);
        expect(P.effectivePermissions(users, 'old@dsc.com')).toEqual(ALL_KEYS);
        expect(P.effectivePermissions(users, 'plain@dsc.com')).toEqual(['addRevisions']);
    });

    test('email match ignores case and surrounding spaces', () => {
        expect(P.effectivePermissions(users, '  boss@dsc.COM ')).toEqual(['allocateMargins', 'managePeople']);
        expect(P.sameEmail('A@x.com', ' a@X.COM ')).toBe(true);
    });

    test('lists on: someone not on the list (shared login, domain sign-in) gets the staff default', () => {
        expect(P.effectivePermissions(users, 'stranger@dsc.com')).toEqual(['addRevisions']);
        expect(P.effectivePermissions(users, '')).toEqual(['addRevisions']);
        expect(P.effectivePermissions(users, undefined)).toEqual(['addRevisions']);
    });

    test('can() answers per key', () => {
        expect(P.can(users, 'staff@dsc.com', 'addNotes')).toBe(true);
        expect(P.can(users, 'staff@dsc.com', 'deleteNotes')).toBe(false);
        expect(P.can(users, 'staff@dsc.com', 'managePeople')).toBe(false);
        expect(P.can(users, 'stranger@dsc.com', 'addRevisions')).toBe(true);
        expect(P.can(users, 'stranger@dsc.com', 'allocateMargins')).toBe(false);
    });

    test('sameEmail: blank never matches blank', () => {
        expect(P.sameEmail('', '')).toBe(false);
        expect(P.sameEmail(null, null)).toBe(false);
        expect(P.sameEmail('a@x', '')).toBe(false);
    });
});

describe('leavesNoManager — the last people-manager is protected', () => {
    const m1 = { email: 'm1@x', permissions: ['managePeople'] };
    const m2 = { email: 'm2@x', role: 'admin' };
    const s = { email: 's@x', permissions: ['addNotes'] };

    test('taking the only manager off is refused', () => {
        expect(P.leavesNoManager([m1, s], [s])).toBe(true);
        expect(P.leavesNoManager([m1, s], [{ ...m1, permissions: ['addNotes'] }, s])).toBe(true);
    });

    test('removing one of two managers is fine', () => {
        expect(P.leavesNoManager([m1, m2, s], [m2, s])).toBe(false);
    });

    test('before the lists are on (no manager either side), nothing is refused', () => {
        expect(P.leavesNoManager([s], [])).toBe(false);
        expect(P.leavesNoManager([], [])).toBe(false);
    });

    test('adding the first manager is fine', () => {
        expect(P.leavesNoManager([s], [s, m1])).toBe(false);
    });
});

describe('isAdmin — the "Admin" label means every box ticked', () => {
    test('every box ticked -> admin', () => {
        expect(P.isAdmin({ permissions: ALL_KEYS.slice() })).toBe(true);
        expect(P.isAdmin({ role: 'admin' })).toBe(true);
    });

    test('one box short -> not admin', () => {
        expect(P.isAdmin({ permissions: ALL_KEYS.filter((k) => k !== 'deleteNotes') })).toBe(false);
        expect(P.isAdmin({ permissions: ['managePeople'] })).toBe(false);
        expect(P.isAdmin({})).toBe(false);
        expect(P.isAdmin(null)).toBe(false);
    });

    test('junk keys do not pad the count up to admin', () => {
        const five = ALL_KEYS.filter((k) => k !== 'editMargins');
        expect(P.isAdmin({ permissions: five.concat(['bogus']) })).toBe(false);
    });
});

describe('forRequest / allowed — what THIS request may do', () => {
    test('open mode (no logins set up) -> everything, whatever req.user says', () => {
        expect(P.forRequest({ authOpen: true })).toEqual(ALL_KEYS);
        expect(P.forRequest({ authOpen: true, user: { permissions: [] } })).toEqual(ALL_KEYS);
        expect(P.allowed({ authOpen: true }, 'managePeople')).toBe(true);
    });

    test('no req.user (machine call, router without the gate) -> nothing', () => {
        expect(P.forRequest({})).toEqual([]);
        expect(P.forRequest(null)).toEqual([]);
        expect(P.forRequest(undefined)).toEqual([]);
        expect(P.allowed({}, 'addRevisions')).toBe(false);
        expect(P.allowed(null, 'managePeople')).toBe(false);
    });

    test('a user without a permissions array -> nothing (never "allowed" by default)', () => {
        expect(P.forRequest({ user: { email: 'a@x' } })).toEqual([]);
        expect(P.forRequest({ user: { email: 'a@x', permissions: 'managePeople' } })).toEqual([]);
        expect(P.allowed({ user: { email: 'a@x' } }, 'addRevisions')).toBe(false);
    });

    test('a user with a list -> exactly that list, cleaned', () => {
        const req = { user: { email: 'a@x', permissions: ['addNotes', 'hack', 'allocateMargins'] } };
        expect(P.forRequest(req)).toEqual(['allocateMargins', 'addNotes']);
        expect(P.allowed(req, 'addNotes')).toBe(true);
        expect(P.allowed(req, 'deleteNotes')).toBe(false);
        expect(P.allowed(req, 'hack')).toBe(false);
    });

    test('allowed() with several keys means ANY of them', () => {
        const req = { user: { permissions: ['allocateMargins'] } };
        expect(P.allowed(req, 'editMargins', 'allocateMargins')).toBe(true);
        expect(P.allowed(req, 'editMargins', 'deleteNotes')).toBe(false);
        expect(P.allowed(req)).toBe(false);
    });
});

describe('stampName — the name on an ask or note comes from the sign-in, not the browser', () => {
    test('no user -> empty', () => {
        expect(P.stampName({})).toBe('');
        expect(P.stampName(null)).toBe('');
    });

    test('shared login is stamped as "Shared login", never as a name it claims', () => {
        expect(P.stampName({ user: { kind: 'shared', who: 'Ramesh', email: 'office@dsc.com' } })).toBe('Shared login');
    });

    test('a person: their name, else their email; trimmed', () => {
        expect(P.stampName({ user: { kind: 'person', who: '  Dhanesh ', email: 'd@dsc.com' } })).toBe('Dhanesh');
        expect(P.stampName({ user: { kind: 'person', email: ' d@dsc.com ' } })).toBe('d@dsc.com');
        expect(P.stampName({ user: { kind: 'google', who: '', email: 'g@dsc.com' } })).toBe('g@dsc.com');
        expect(P.stampName({ user: {} })).toBe('');
    });
});

// ───────────────────────────────────────────────────────────────────────────────
// utils/peopleRoles.js
// ───────────────────────────────────────────────────────────────────────────────

describe('peopleRoles — admin/staff names derived from managePeople', () => {
    test('roleOf: managePeople -> admin, even without the other boxes', () => {
        expect(R.roleOf({ permissions: ['managePeople'] })).toBe('admin');
        expect(R.roleOf({ permissions: ALL_KEYS })).toBe('admin');
        expect(R.roleOf({ role: 'admin' })).toBe('admin');
    });

    test('roleOf: no managePeople -> staff (tick list beats an old role flag)', () => {
        expect(R.roleOf({ permissions: ALL_KEYS.filter((k) => k !== 'managePeople') })).toBe('staff');
        expect(R.roleOf({ role: 'admin', permissions: ['addNotes'] })).toBe('staff');
        expect(R.roleOf({})).toBe('staff');
        expect(R.roleOf(null)).toBe('staff');
    });

    test('adminCount counts people-managers', () => {
        expect(R.adminCount([{ permissions: ['managePeople'] }, { role: 'admin' }, {}])).toBe(2);
        expect(R.adminCount([])).toBe(0);
    });

    test('canManagePeople: bootstrap — anyone, while nobody manages people', () => {
        expect(R.canManagePeople([], 'first@dsc.com')).toBe(true);
        expect(R.canManagePeople([{ email: 'a@x', permissions: ['addNotes'] }], 'a@x')).toBe(true);
        expect(R.canManagePeople([{ email: 'a@x' }], 'stranger@x')).toBe(true);
    });

    test('canManagePeople: once on, only the managers', () => {
        const users = [{ email: 'boss@x', permissions: ['managePeople'] }, { email: 'staff@x', permissions: ALL_KEYS.slice(0, 5) }];
        expect(R.canManagePeople(users, 'BOSS@x')).toBe(true);
        expect(R.canManagePeople(users, 'staff@x')).toBe(false);
        expect(R.canManagePeople(users, 'stranger@x')).toBe(false);
    });

    test('leavesNoAdmin follows the last-manager rule', () => {
        const m = { email: 'm@x', permissions: ['managePeople'] };
        const s = { email: 's@x' };
        expect(R.leavesNoAdmin([m, s], [s])).toBe(true);
        expect(R.leavesNoAdmin([m, s], [m])).toBe(false);
        expect(R.leavesNoAdmin([s], [])).toBe(false);
    });

    test('parseRole: admin / staff, case and spaces ignored; anything else -> null', () => {
        expect(R.parseRole(' Admin ')).toBe('admin');
        expect(R.parseRole('STAFF')).toBe('staff');
        expect(R.parseRole('owner')).toBeNull();
        expect(R.parseRole('')).toBeNull();
        expect(R.parseRole(null)).toBeNull();
        expect(R.parseRole(undefined)).toBeNull();
    });
});

// ───────────────────────────────────────────────────────────────────────────────
// utils/passwordReset.js
// ───────────────────────────────────────────────────────────────────────────────

describe('passwordReset — signed, expiring, one-use reset links', () => {
    const SECRET = 'test-secret-not-real';
    const NOW = Date.UTC(2026, 9, 16, 10, 0, 0);
    const MIN = 60 * 1000;
    const people = () => [
        { email: 'Alice@DSC.com', name: 'Alice', hash: 'hash-alice-1', permissions: ['addNotes'], role: 'staff' },
        { email: 'bob@dsc.com', name: 'Bob', hash: 'hash-bob-1', permissions: ['managePeople'] },
        { email: 'google@dsc.com', name: 'Gita' },   // Google-only: no password hash
    ];
    const bodyFor = (email, x) => Buffer.from(JSON.stringify({ e: email, x }), 'utf8').toString('base64url');

    test('the link lasts 30 minutes; passwords need 8 characters', () => {
        expect(PR.RESET_TTL_MS).toBe(30 * MIN);
        expect(PR.MIN_PASSWORD).toBe(8);
    });

    test('round trip: a token reads back as the same person (email case ignored)', () => {
        const users = people();
        const token = PR.makeResetToken(users, '  alice@dsc.COM ', SECRET, NOW);
        expect(typeof token).toBe('string');
        expect(token.split('.')).toHaveLength(2);
        const who = PR.readResetToken(users, token, SECRET, NOW + MIN);
        expect(who).not.toBeNull();
        expect(who.email).toBe('Alice@DSC.com');
    });

    test('still good one second before 30 minutes; dead at 30 minutes and after', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        expect(PR.readResetToken(users, token, SECRET, NOW + 30 * MIN - 1000)).not.toBeNull();
        expect(PR.readResetToken(users, token, SECRET, NOW + 30 * MIN)).toBeNull();
        expect(PR.readResetToken(users, token, SECRET, NOW + 31 * MIN)).toBeNull();
        expect(PR.readResetToken(users, token, SECRET, NOW + 24 * 60 * MIN)).toBeNull();
    });

    test('forged signature (one character changed) is refused', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        const [body, sig] = token.split('.');
        const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
        expect(flipped).toHaveLength(sig.length);
        expect(PR.readResetToken(users, body + '.' + flipped, SECRET, NOW)).toBeNull();
    });

    test('a token made with a different secret is refused', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', 'some-other-secret', NOW);
        expect(PR.readResetToken(users, token, SECRET, NOW)).toBeNull();
    });

    test('an extended expiry written into the body (signature kept) is refused', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        const sig = token.split('.')[1];
        const longer = bodyFor('alice@dsc.com', NOW + 999 * 60 * MIN) + '.' + sig;
        expect(PR.readResetToken(users, longer, SECRET, NOW + 40 * MIN)).toBeNull();
    });

    test('wrong person: Alice\'s signature on a body naming Bob does not let anyone in', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        const sig = token.split('.')[1];
        const asBob = bodyFor('bob@dsc.com', NOW + 30 * MIN) + '.' + sig;
        expect(PR.readResetToken(users, asBob, SECRET, NOW)).toBeNull();
        // and Alice's own token never reads as Bob
        expect(PR.readResetToken(users, token, SECRET, NOW).email).toBe('Alice@DSC.com');
    });

    test('one use: once the password hash changes, the same token is dead', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        expect(PR.readResetToken(users, token, SECRET, NOW)).not.toBeNull();
        const after = PR.withNewHash(users, 'alice@dsc.com', 'hash-alice-2');
        expect(PR.readResetToken(after, token, SECRET, NOW + MIN)).toBeNull();
        // Bob's token is not affected by Alice's change
        const bobToken = PR.makeResetToken(users, 'bob@dsc.com', SECRET, NOW);
        expect(PR.readResetToken(after, bobToken, SECRET, NOW + MIN).email).toBe('bob@dsc.com');
    });

    test('a person taken off the list: their old token is dead', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        const without = users.filter((u) => u.email !== 'Alice@DSC.com');
        expect(PR.readResetToken(without, token, SECRET, NOW)).toBeNull();
    });

    test('Google-only person (no password) and unknown people get no token', () => {
        const users = people();
        expect(PR.makeResetToken(users, 'google@dsc.com', SECRET, NOW)).toBeNull();
        expect(PR.makeResetToken(users, 'nobody@dsc.com', SECRET, NOW)).toBeNull();
        expect(PR.makeResetToken(users, '', SECRET, NOW)).toBeNull();
        expect(PR.makeResetToken(users, 'alice@dsc.com', '', NOW)).toBeNull();
    });

    test('a hand-made token for a Google-only person is refused', () => {
        const users = people();
        const crypto = require('crypto');
        const body = bodyFor('google@dsc.com', NOW + 30 * MIN);
        const sig = crypto.createHmac('sha256', SECRET).update(body + '|').digest('base64url');
        expect(PR.readResetToken(users, body + '.' + sig, SECRET, NOW)).toBeNull();
    });

    test('garbage, missing parts or no secret -> null, never a throw', () => {
        const users = people();
        const token = PR.makeResetToken(users, 'alice@dsc.com', SECRET, NOW);
        expect(PR.readResetToken(users, token, '', NOW)).toBeNull();
        expect(PR.readResetToken(users, '', SECRET, NOW)).toBeNull();
        expect(PR.readResetToken(users, null, SECRET, NOW)).toBeNull();
        expect(PR.readResetToken(users, token.split('.')[0], SECRET, NOW)).toBeNull();
        expect(PR.readResetToken(users, 'not-json.abc', SECRET, NOW)).toBeNull();
        expect(PR.readResetToken(users, bodyFor('', NOW + MIN) + '.x', SECRET, NOW)).toBeNull();
    });

    test('passwordProblem: 8+ characters and both boxes the same', () => {
        expect(PR.passwordProblem('12345678', '12345678')).toBeNull();
        expect(PR.passwordProblem('1234567', '1234567')).toBe('Use a password of at least 8 characters.');
        expect(PR.passwordProblem('', '')).toMatch(/at least 8/);
        expect(PR.passwordProblem(null, null)).toMatch(/at least 8/);
        expect(PR.passwordProblem('longenough1', 'longenough2')).toBe('Those passwords did not match.');
        expect(PR.passwordProblem('longenough1', undefined)).toBe('Those passwords did not match.');
    });

    test('withNewHash: only that person\'s hash changes; ticks and other fields kept; input untouched', () => {
        const users = people();
        const snapshot = JSON.parse(JSON.stringify(users));
        const after = PR.withNewHash(users, ' ALICE@dsc.com', 'hash-alice-2');
        expect(after).not.toBe(users);
        expect(after[0]).not.toBe(users[0]);
        expect(after[0]).toEqual({ ...snapshot[0], hash: 'hash-alice-2' });
        expect(after[0].permissions).toEqual(['addNotes']);
        expect(after[0].role).toBe('staff');
        expect(after[0].name).toBe('Alice');
        expect(after[1]).toBe(users[1]);   // other people passed through unchanged
        expect(after[2]).toBe(users[2]);
        expect(users).toEqual(snapshot);   // input not mutated
    });

    test('resetEmailHtml: escapes the name, email and link; says once and 30 minutes', () => {
        const html = PR.resetEmailHtml(
            { name: '<script>alert(1)</script>', email: 'a&b@dsc.com' },
            'https://app.example/reset?t=abc"onmouseover="x',
            '16 Oct <10:00>'
        );
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('a&amp;b@dsc.com');
        expect(html).not.toContain('"onmouseover="');
        expect(html).toContain('abc&quot;onmouseover=&quot;x');
        expect(html).toContain('16 Oct &lt;10:00&gt;');
        expect(html).toContain('<b>once</b>');
        expect(html).toContain('<b>30 minutes</b>');
    });

    test('resetEmailHtml: falls back to the email when there is no name; no date when none given', () => {
        const html = PR.resetEmailHtml({ email: 'plain@dsc.com' }, 'https://l', '');
        expect(html).toContain('<b>plain@dsc.com</b>');
        expect(html).not.toContain(' on ');
        expect(html).toContain('<a href="https://l">https://l</a>');
    });
});

// ───────────────────────────────────────────────────────────────────────────────
// utils/calculations.js — stampAdminMargins list-rate memory (Edit margins)
// ───────────────────────────────────────────────────────────────────────────────

describe('stampAdminMargins — seamless cost mode remembers the list rate', () => {
    const seam = (over) => Object.assign({
        lineItemId: 'li-1', originalDescription: '2" NB X Sch 40', identifiedPipeType: 'Seamless',
        quantity: '10', unitRate: '999', costRate: '200', marginPercent: '', kgPerMeter: '',
    }, over);
    const cost = (pct) => ({ seamless: { mode: 'cost', pct } });
    const price = { seamless: { mode: 'price' } };

    test('cost mode swaps to the cost rate and remembers the list rate', () => {
        const [out] = stampAdminMargins([seam()], cost(10));
        expect(out.listUnitRate).toBe('999');
        expect(out.unitRate).toBe('200.00');
        expect(out.marginPercent).toBe('10');
        expect(out.finalRate).toBe('220');
        expect(out.lineTotal).toBe('2200.00');
        expect(out.costRate).toBe('200');   // kept on the line
    });

    test('cost mode again (Edit margins) keeps the FIRST list rate, not the cost rate', () => {
        const [first] = stampAdminMargins([seam()], cost(10));
        const [second] = stampAdminMargins([first], cost(25));
        expect(second.listUnitRate).toBe('999');
        expect(second.unitRate).toBe('200.00');
        expect(second.finalRate).toBe('250');
    });

    test('price mode puts the list rate back and forgets it', () => {
        const [costed] = stampAdminMargins([seam()], cost(10));
        const [back] = stampAdminMargins([costed], price);
        expect(back.unitRate).toBe('999.00');
        expect(back.marginPercent).toBe('0');
        expect(back.finalRate).toBe('999');
        expect(back.lineTotal).toBe('9990.00');
        expect('listUnitRate' in back).toBe(false);
    });

    test('cost -> price -> cost round trip ends at cost with the list rate remembered again', () => {
        const [a] = stampAdminMargins([seam()], cost(10));
        const [b] = stampAdminMargins([a], price);
        const [c] = stampAdminMargins([b], cost(5));
        expect(c.unitRate).toBe('200.00');
        expect(c.listUnitRate).toBe('999.00');
        expect(c.finalRate).toBe('210');
        const [d] = stampAdminMargins([c], price);
        expect(d.unitRate).toBe('999.00');
        expect(d.finalRate).toBe('999');
    });

    test('no cost rate: cost mode leaves the unit rate and remembers nothing', () => {
        const [out] = stampAdminMargins([seam({ costRate: undefined, unitRate: '150' })], cost(20));
        expect(out.unitRate).toBe('150.00');
        expect(out.finalRate).toBe('180');
        expect('listUnitRate' in out).toBe(false);
    });

    test('a zero or blank cost rate counts as no cost rate (never quotes at 0)', () => {
        const [zero] = stampAdminMargins([seam({ costRate: '0', unitRate: '150' })], cost(20));
        expect(zero.unitRate).toBe('150.00');
        expect(zero.finalRate).toBe('180');
        expect('listUnitRate' in zero).toBe(false);
        const [neg] = stampAdminMargins([seam({ costRate: '-5', unitRate: '150' })], cost(20));
        expect(neg.unitRate).toBe('150.00');
        const [blank] = stampAdminMargins([seam({ costRate: '', unitRate: '150' })], cost(20));
        expect(blank.unitRate).toBe('150.00');
    });

    test('price mode on a line never costed: rate unchanged, nothing remembered', () => {
        const [out] = stampAdminMargins([seam()], price);
        expect(out.unitRate).toBe('999.00');
        expect(out.finalRate).toBe('999');
        expect('listUnitRate' in out).toBe(false);
    });

    test('a line the list could not price goes back to BLANK in price mode, never 0', () => {
        const [costed] = stampAdminMargins([seam({ unitRate: '' })], cost(10));
        expect(costed.listUnitRate).toBe('');
        expect(costed.unitRate).toBe('200.00');
        const [back] = stampAdminMargins([costed], price);
        expect(back.unitRate).toBe('');
        expect(back.finalRate).toBe('');
        expect(back.lineTotal).toBe('');
    });

    test('seamless unticked on the desk: line left exactly as it was', () => {
        const input = seam();
        const [out] = stampAdminMargins([input], { seamless: { mode: 'cost', pct: 10, include: false } });
        expect(out).toEqual(input);
        expect('listUnitRate' in out).toBe(false);
    });

    test('never mutates the input line', () => {
        const input = seam();
        const snap = JSON.stringify(input);
        stampAdminMargins([input], cost(10));
        expect(JSON.stringify(input)).toBe(snap);
        const [costed] = stampAdminMargins([input], cost(10));
        const costedSnap = JSON.stringify(costed);
        stampAdminMargins([costed], price);
        expect(JSON.stringify(costed)).toBe(costedSnap);
    });
});
