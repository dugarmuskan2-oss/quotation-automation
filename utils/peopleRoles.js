'use strict';

/**
 * utils/peopleRoles.js — admin or staff, and who may change the people list.
 *
 * Each person on users.json may carry `role: 'admin'`. Anything else (or nothing — everyone
 * added before roles existed) is staff. Only an admin may add, remove or change the role of
 * anyone.
 *
 * Two rules keep this from locking the owner out:
 *   - Until SOMEONE is an admin, everyone signed in may manage the list. That is how the first
 *     admin gets made, on a list that predates roles.
 *   - The last admin can never be removed or made staff — the list would then be managed by
 *     nobody, or (by the first rule) silently by everyone again.
 *
 * Pure module: no I/O.
 */

const ROLES = ['admin', 'staff'];

function roleOf(user) {
    return user && user.role === 'admin' ? 'admin' : 'staff';
}

function sameEmail(a, b) {
    return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function adminCount(users) {
    return (Array.isArray(users) ? users : []).filter((u) => roleOf(u) === 'admin').length;
}

/** May the person signed in as `email` add, remove or change roles? */
function canManagePeople(users, email) {
    if (!adminCount(users)) return true;
    const me = (Array.isArray(users) ? users : []).find((u) => sameEmail(u && u.email, email));
    return roleOf(me) === 'admin';
}

/** A change that would take the list from having an admin to having none is refused. */
function leavesNoAdmin(before, after) {
    return adminCount(before) > 0 && adminCount(after) === 0;
}

/** 'admin' | 'staff' from whatever was sent; null when it is neither. */
function parseRole(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    return ROLES.includes(v) ? v : null;
}

module.exports = { ROLES, roleOf, adminCount, canManagePeople, leavesNoAdmin, parseRole, sameEmail };
