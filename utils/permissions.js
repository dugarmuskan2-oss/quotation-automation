'use strict';

/**
 * utils/permissions.js — what each person is allowed to do.
 *
 * The owner's design (16 Oct 2026): a tick list under each person, grouped under headings; the
 * ticked ones are what they may do. "Admin" is simply every box ticked. Stored on users.json as
 * `permissions: [...]` per person.
 *
 * Older records:
 *   role: 'admin'          → every permission
 *   no permissions, no role → STAFF_DEFAULT
 *
 * Two rules keep the owner from being locked out, and keep today's site working on day one:
 *   - Until SOMEONE has managePeople, everyone signed in may do everything (the site as it is
 *     today). The first person given managePeople switches the lists on for everyone.
 *   - The last person with managePeople can never lose it or be removed.
 *
 * Someone who is not on the list (a shared-password sign-in, or a Google account let in by its
 * domain) gets STAFF_DEFAULT once the lists are on.
 *
 * Shared by the server and the browser (people.html / permissions-client.js read PERMISSIONS for
 * the headings). Pure: no I/O.
 */

const PERMISSIONS = [
    { key: 'allocateMargins', group: 'Margins', label: 'Allocate margins', help: 'Use the "Margins to allocate" box' },
    { key: 'editMargins', group: 'Margins', label: 'Edit margins', help: 'Go back into the Margins box and change margins on a quote already sent to approval' },
    { key: 'addNotes', group: 'Notes', label: 'Add notes', help: 'Write "From the admin" notes and "Add another note"' },
    { key: 'deleteNotes', group: 'Notes', label: 'Delete notes', help: 'Remove a note from a quote' },
    { key: 'addRevisions', group: 'Revisions', label: 'Add revision requests', help: 'Use "Add revision" on a quote' },
    { key: 'managePeople', group: 'People', label: 'Manage people', help: 'Add or remove people, set passwords and these ticks' },
];
const ALL = PERMISSIONS.map((p) => p.key);
const STAFF_DEFAULT = ['addRevisions'];

function sameEmail(a, b) {
    return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** Only known keys, each once, in the list's own order. */
function cleanPermissions(list) {
    const want = new Set((Array.isArray(list) ? list : []).map(String));
    return ALL.filter((k) => want.has(k));
}

/** The permissions stored for one person (before the bootstrap rule). */
function permissionsOf(user) {
    if (!user) return STAFF_DEFAULT.slice();
    if (Array.isArray(user.permissions)) return cleanPermissions(user.permissions);
    if (user.role === 'admin') return ALL.slice();
    return STAFF_DEFAULT.slice();
}

function managerCount(users) {
    return (Array.isArray(users) ? users : []).filter((u) => permissionsOf(u).includes('managePeople')).length;
}

/** Are the tick lists switched on? Off until someone holds managePeople. */
function listsOn(users) {
    return managerCount(users) > 0;
}

/** What the person signed in as `email` may do right now. */
function effectivePermissions(users, email) {
    if (!listsOn(users)) return ALL.slice();
    const me = (Array.isArray(users) ? users : []).find((u) => sameEmail(u && u.email, email));
    return permissionsOf(me);
}

function can(users, email, permission) {
    return effectivePermissions(users, email).includes(permission);
}

/** A change that takes the list from having a people-manager to having none is refused. */
function leavesNoManager(before, after) {
    return managerCount(before) > 0 && managerCount(after) === 0;
}

// ── For routes: what THIS request may do ───────────────────────────────────────────────────
// The auth gate puts the person's permissions on req.user.permissions (worked out from the
// people list on every request, never kept in the cookie). A site with no logins set up at all is
// open to everyone, as it always was, and the gate marks that with req.authOpen. Anything else with
// no req.user — a machine call carrying the ingest secret, or a router mounted without the gate —
// is allowed NOTHING: a missing identity must never read as "allowed".
function forRequest(req) {
    if (req && req.authOpen) return ALL.slice();
    const list = req && req.user && req.user.permissions;
    return Array.isArray(list) ? cleanPermissions(list) : [];
}
function allowed(req, ...keys) {
    const have = forRequest(req);
    return keys.some((k) => have.includes(k));
}

/** The name stamped on an ask or a note: the signed-in person, never what the browser claims. */
function stampName(req) {
    const u = req && req.user;
    if (!u) return '';
    if (u.kind === 'shared') return 'Shared login';
    return String(u.who || u.email || '').trim();
}

/** "Admin" when every box is ticked — only a label for the People page. */
function isAdmin(user) {
    return permissionsOf(user).length === ALL.length;
}

const api = { PERMISSIONS, ALL, STAFF_DEFAULT, cleanPermissions, permissionsOf, managerCount, listsOn,
    effectivePermissions, can, leavesNoManager, isAdmin, sameEmail, forRequest, allowed, stampName };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.dscPermissions = api;
