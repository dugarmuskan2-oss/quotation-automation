'use strict';

/**
 * tests/google-contacts.test.js — grouping 5,507 Google contacts into firms to approve.
 *
 * The whole value of this file is the GROUPING, and every rule in it was written against a
 * real measurement of the owner's own contacts:
 *
 *  - Only 156 of 5,507 have the company box filled in, so the firm name usually has to come
 *    from the email domain. Never from the person's name — "Ravi Kumar" as a company is a
 *    card he has to notice and fix, and a blank he can fill is more honest.
 *  - vsnl.net put 47 unrelated people onto one card called "Vsnl". The old Indian internet
 *    providers have to count as personal addresses exactly like gmail, or the oldest and
 *    most valuable entries in the book collapse into nonsense firms.
 *  - A firm with 40 people in it is a project company whose whole staff collected in the
 *    address book — a customer, not a supplier. Seven big ones are genuine pipe names; the
 *    owner read the list and picked them out himself.
 */

const {
    readPerson, firmKeyForContact, firmNameFor, firmsFromPeople,
    previewFromFirm, notesFrom, sortFirmsForImport, BIG_BUT_REAL, CROWDED_FIRM, FREE_MAIL,
} = require('../utils/googleContacts');

/** A Google People record, in the shape the API really returns. */
const person = (over) => Object.assign({
    names: [{ displayName: 'Ravi Kumar' }],
    emailAddresses: [{ value: 'ravi@msltubes.com' }],
    phoneNumbers: [{ value: '98400 12345' }],
}, over);

describe('reading one Google contact', () => {
    test('the bits the directory has a home for are pulled out', () => {
        const r = readPerson(person({
            organizations: [{ name: 'MSL Tubes', title: 'Sales' }],
            biographies: [{ value: 'GI only, 5T min' }],
            addresses: [{ formattedValue: '12 Mount Road, Chennai' }],
        }));
        expect(r).toMatchObject({
            name: 'Ravi Kumar', company: 'MSL Tubes', title: 'Sales',
            emails: ['ravi@msltubes.com'], notes: 'GI only, 5T min',
            address: '12 Mount Road, Chennai',
        });
        expect(r.phones).toEqual(['98400 12345']);
    });

    test('addresses come back lower-cased, so one person is not two', () => {
        expect(readPerson(person({ emailAddresses: [{ value: 'RAVI@MSLTubes.com' }] })).emails)
            .toEqual(['ravi@msltubes.com']);
    });

    test('a record with nothing on it does not throw', () => {
        expect(readPerson({}).emails).toEqual([]);
        expect(readPerson(null).name).toBe('');
    });
});

describe('which firm a contact belongs to', () => {
    test('a business address is the firm', () => {
        expect(firmKeyForContact(readPerson(person()))).toBe('d:msltubes.com');
    });

    test('a gmail address is ONE PERSON, never a firm everyone shares', () => {
        const k = firmKeyForContact(readPerson(person({ emailAddresses: [{ value: 'ravi@gmail.com' }] })));
        const j = firmKeyForContact(readPerson(person({ emailAddresses: [{ value: 'suresh@gmail.com' }] })));
        expect(k).not.toBe(j);
    });

    test('the old Indian internet providers count as personal too', () => {
        // vsnl.net alone had put 47 unrelated people on a single card.
        ['vsnl.net', 'vsnl.com', 'eth.net', 'airtelmail.in', 'sify.com', 'bsnl.in'].forEach((d) => {
            expect(FREE_MAIL.test(d)).toBe(true);
        });
        const a = firmKeyForContact(readPerson(person({ emailAddresses: [{ value: 'a@vsnl.net' }] })));
        const b = firmKeyForContact(readPerson(person({ emailAddresses: [{ value: 'b@vsnl.net' }] })));
        expect(a).not.toBe(b);
    });

    test('a real firm is still a real firm', () => {
        expect(FREE_MAIL.test('msltubes.com')).toBe(false);
        expect(FREE_MAIL.test('jindalpipe.com')).toBe(false);
    });

    test('a contact with only a phone has nothing to group on', () => {
        expect(firmKeyForContact(readPerson(person({ emailAddresses: [] })))).toBeNull();
    });
});

describe('what the firm gets called', () => {
    test('the company box wins, because somebody typed it on purpose', () => {
        expect(firmNameFor([
            readPerson(person({ organizations: [{ name: 'MSL Tubes Pvt Ltd' }] })),
            readPerson(person()),
        ])).toBe('MSL Tubes Pvt Ltd');
    });

    test('failing that, the domain read as a name', () => {
        expect(firmNameFor([readPerson(person())])).toBeTruthy();
        // companyFromEmail spaces it out into something readable — 'msl tubes', not 'msltubes'
        expect(firmNameFor([readPerson(person())]).toLowerCase().replace(/ /g, '')).toContain('msltubes');
    });

    test('NEVER the person\'s name — a wrong firm name is worse than a blank', () => {
        const nameOnly = readPerson(person({ emailAddresses: [{ value: 'ravi@gmail.com' }] }));
        expect(firmNameFor([nameOnly])).toBe('');
        expect(firmNameFor([nameOnly])).not.toContain('Ravi');
    });
});

describe('grouping the whole book into firms', () => {
    test('three colleagues at one mill become ONE firm with three people', () => {
        const { firms } = firmsFromPeople([
            person({ emailAddresses: [{ value: 'ravi@msltubes.com' }] }),
            person({ emailAddresses: [{ value: 'suresh@msltubes.com' }] }),
            person({ emailAddresses: [{ value: 'kumar@msltubes.com' }] }),
        ], []);
        expect(firms).toHaveLength(1);
        expect(firms[0].people).toHaveLength(3);
        expect(firms[0].emails).toHaveLength(3);
    });

    test('"Contacted" means you have actually emailed them', () => {
        const { firms } = firmsFromPeople([person()], ['msltubes.com']);
        expect(firms[0].contacted).toBe(true);

        const { firms: cold } = firmsFromPeople([person()], ['someoneelse.com']);
        expect(cold[0].contacted).toBe(false);
    });

    test('phone-only contacts are held apart, not dropped and not guessed at', () => {
        const { firms, phoneOnly } = firmsFromPeople([
            person({ emailAddresses: [] }),
            person(),
        ], []);
        expect(firms).toHaveLength(1);
        expect(phoneOnly).toHaveLength(1);
        expect(phoneOnly[0].phones).toEqual(['98400 12345']);
    });

    test('a name with no email and no phone is nothing at all', () => {
        const { firms, phoneOnly } = firmsFromPeople(
            [{ names: [{ displayName: 'Someone' }] }], []);
        expect(firms).toEqual([]);
        expect(phoneOnly).toEqual([]);
    });

    test('an empty book does not throw', () => {
        expect(firmsFromPeople(null, null).firms).toEqual([]);
    });
});

describe('keeping customers out of the supplier directory', () => {
    const firm = (over) => Object.assign({
        key: 'd:msltubes.com', company: 'MSL Tubes', contacted: true,
        emails: ['ravi@msltubes.com'], people: [{ name: 'Ravi' }],
    }, over);
    const crowd = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));

    test('a firm you have QUOTED to is a customer, and is held back', () => {
        const r = sortFirmsForImport([firm()], { customerDomains: ['msltubes.com'] });
        expect(r.quotedTo).toHaveLength(1);
        expect(r.toImport).toEqual([]);
    });

    test('forty people at one firm is a project company, not a lorry man', () => {
        const r = sortFirmsForImport([firm({ people: crowd(40) })], {});
        expect(r.crowded).toHaveLength(1);
        expect(r.toImport).toEqual([]);
    });

    test('...but the seven big pipe names the owner picked out come through', () => {
        BIG_BUT_REAL.forEach((d) => {
            const r = sortFirmsForImport(
                [firm({ key: 'd:' + d, emails: ['x@' + d], people: crowd(30) })], {});
            expect(r.toImport).toHaveLength(1);
            expect(r.crowded).toEqual([]);
        });
    });

    test('a normal small supplier sails through', () => {
        const r = sortFirmsForImport([firm({ people: crowd(3) })], {});
        expect(r.toImport).toHaveLength(1);
        expect(r.quotedTo).toEqual([]);
        expect(r.crowded).toEqual([]);
    });

    test('being a customer beats being on the keep list — a quote is the harder fact', () => {
        const r = sortFirmsForImport(
            [firm({ key: 'd:jindalpipe.com', emails: ['x@jindalpipe.com'], people: crowd(30) })],
            { customerDomains: ['jindalpipe.com'] });
        expect(r.quotedTo).toHaveLength(1);
        expect(r.toImport).toEqual([]);
    });

    test('nothing is thrown away — both held-back lists come back to be reported', () => {
        // A firm silently missing from an import cannot be told apart from one that was
        // never in the contacts at all.
        const r = sortFirmsForImport([
            firm({ key: 'a', emails: ['x@a.com'] }),
            firm({ key: 'b', emails: ['x@b.com'], people: crowd(40) }),
            firm({ key: 'c', emails: ['x@c.com'] }),
        ], { customerDomains: ['c.com'] });
        expect(r.toImport.length + r.quotedTo.length + r.crowded.length).toBe(3);
    });

    test('the crowd line is 10, and it is the same number everywhere', () => {
        expect(CROWDED_FIRM).toBe(10);
        expect(sortFirmsForImport([firm({ people: crowd(9) })], {}).toImport).toHaveLength(1);
        expect(sortFirmsForImport([firm({ people: crowd(10) })], {}).crowded).toHaveLength(1);
    });
});

describe('the card the owner is asked to approve', () => {
    const firm = {
        key: 'd:msltubes.com', company: 'MSL Tubes', contacted: true,
        emails: ['ravi@msltubes.com'],
        people: [
            { name: 'Ravi', title: 'Sales', phones: ['98400 12345'], emails: ['ravi@msltubes.com'],
              notes: 'GI only', address: '12 Mount Road' },
            { name: 'Suresh', title: '', phones: [], emails: ['suresh@msltubes.com'], notes: '', address: '' },
        ],
    };

    test('everyone at the firm is on the one card', () => {
        const p = previewFromFirm(firm);
        expect(p.company).toBe('MSL Tubes');
        expect(p.people).toHaveLength(2);
        expect(p.people[0].emails[0].v).toBe('ravi@msltubes.com');
        expect(p.people[0].phones[0].v).toBe('98400 12345');
    });

    test('the ROLE is left empty — a guessed role decides who gets a freight enquiry', () => {
        expect(previewFromFirm(firm).role).toBe('');
    });

    test('part load is "not recorded", never assumed', () => {
        expect(previewFromFirm(firm).partLoad).toBeNull();
    });

    test('no minimum order is invented', () => {
        expect(previewFromFirm(firm).moq).toBe(0);
    });

    test('the "Contacted" mark rides on the card', () => {
        expect(previewFromFirm(firm).contacted).toBe(true);
        expect(previewFromFirm(Object.assign({}, firm, { contacted: false })).contacted).toBe(false);
    });

    test('the job title becomes the person\'s role where there is one', () => {
        const p = previewFromFirm(firm);
        expect(p.people[0].role).toBe('Sales');
        expect(p.people[1].role).toBe('');        // nothing invented for the second
    });

    test('and the CARD really carries them — testing notesFrom alone proved nothing', () => {
        // This escaped a mutation: previewFromFirm could return notes: [] and every notes
        // test still passed, because they all called notesFrom directly.
        expect(previewFromFirm(firm).notes).toEqual(notesFrom(firm));
        expect(previewFromFirm(firm).notes[0].t).toBe('GI only');
    });

    test('notes are copied across word for word, dated, never read', () => {
        // Pretending to understand a note puts guessed facts in real boxes.
        const n = notesFrom(firm);
        expect(n).toHaveLength(1);
        expect(n[0].t).toBe('GI only');
        expect(n[0].d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('the same note on two colleagues is kept once', () => {
        const twice = Object.assign({}, firm, {
            people: [{ notes: 'Same note', phones: [], emails: [] },
                     { notes: 'Same note', phones: [], emails: [] }],
        });
        expect(notesFrom(twice)).toHaveLength(1);
    });
});
