'use strict';

/**
 * utils/peopleRoles.js — "admin" or "staff", now worked out from the tick list.
 *
 * The per-person permissions (utils/permissions.js) replaced the single admin flag on
 * 16 Oct 2026. This file keeps the old names working for the code that still asks "is this
 * person an admin?" — the appraisal (routes/appraisal.js, appraisal-page.js) and the People
 * routes' older paths. An admin is someone who may manage people.
 *
 * users.json still carries role: 'admin' for every manager (routes/auth.js keeps it in step),
 * so older code reading the file directly sees the same admins.
 *
 * Pure module: no I/O.
 */

const P = require('./permissions');

const ROLES = ['admin', 'staff'];

function roleOf(user) {
    return P.permissionsOf(user).includes('managePeople') ? 'admin' : 'staff';
}

const sameEmail = P.sameEmail;

function adminCount(users) {
    return P.managerCount(users);
}

/** May the person signed in as `email` add, remove or change people? */
function canManagePeople(users, email) {
    return P.can(users, email, 'managePeople');
}

/** A change that would leave nobody able to manage people is refused. */
function leavesNoAdmin(before, after) {
    return P.leavesNoManager(before, after);
}

/** 'admin' | 'staff' from whatever was sent; null when it is neither. */
function parseRole(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    return ROLES.includes(v) ? v : null;
}

module.exports = { ROLES, roleOf, adminCount, canManagePeople, leavesNoAdmin, parseRole, sameEmail };
