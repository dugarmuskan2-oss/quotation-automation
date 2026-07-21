/**
 * @jest-environment node
 *
 * tests/staff-list.test.js
 *
 * The editable global staff list (Configuration section): backs the admin
 * desk's "Assign to" dropdown and, later, the Bigin owner. Unit-tests the
 * sanitizer via routes/config.js _test, plus source guards on the routes and
 * the index.html wiring.
 */

const fs = require('fs');
const path = require('path');

const { sanitizeStaffList } = require('../routes/config')._test;

describe('sanitizeStaffList — trimmed, deduped, capped list of names', () => {
    test('trims whitespace and drops empties', () => {
        expect(sanitizeStaffList([' Ramya ', '', '  ', 'Jayanthi'])).toEqual(['Ramya', 'Jayanthi']);
    });

    test('dedupes case-insensitively, keeping the first spelling', () => {
        expect(sanitizeStaffList(['Ramya', 'ramya', 'RAMYA', 'Jayanthi'])).toEqual(['Ramya', 'Jayanthi']);
    });

    test('non-arrays and junk entries become an empty list', () => {
        expect(sanitizeStaffList(null)).toEqual([]);
        expect(sanitizeStaffList('Ramya')).toEqual([]);
        expect(sanitizeStaffList([null, undefined, 42])).toEqual(['42']);
    });

    test('caps the list at 50 names', () => {
        const many = Array.from({ length: 60 }, (_, i) => 'Name' + i);
        expect(sanitizeStaffList(many)).toHaveLength(50);
    });
});

describe('source guard — staff-list routes and frontend wiring', () => {
    const configSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'config.js'), 'utf8');
    const constantsSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'constants.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    test('the save/get routes exist and use the constants key', () => {
        expect(configSrc).toContain("router.post('/save-staff-list'");
        expect(configSrc).toContain("router.get('/get-staff-list'");
        expect(configSrc).toContain('storage.saveText(CONFIG_KEY_STAFF_LIST');
        expect(constantsSrc).toContain("CONFIG_KEY_STAFF_LIST           = 'staff-list.json'");
    });

    test('the Configuration section has the editor and it loads on boot', () => {
        expect(html).toContain('id="staffListChips"');
        expect(html).toContain('function addStaffMember()');
        expect(html).toContain('function removeStaffMember(index)');
        expect(html).toContain('loadStaffList();');
    });

    test('removing a staff member clears their quote assignments in memory', () => {
        expect(html).toContain("if ((q.assignedTo || '') === name) q.assignedTo = '';");
    });
});
