'use strict';

/**
 * tests/contact-lists.test.js — reading a phone-book entry that holds many firms.
 *
 * 167 of the owner's contacts are lists, not people: a heading naming the trade, then ten to
 * seventy firms typed into the notes over years. Grouping cannot touch them — there is
 * nothing to group on — so they are read by Claude, and this pins what happens to what it
 * sends back.
 *
 * The fixtures are the real shapes, taken from his own book with the digits changed:
 * numbering that restarts and repeats, roles in brackets, board lines with nobody's name on
 * them, cross-references to other lists, and remarks that are the whole reason he keeps
 * these ("they do not keep Rourkela material").
 */

const { listPrompt, parseFirms, previewFromListFirm, cleanFirm } = require('../utils/contactLists');

describe('the instructions sent to Claude', () => {
    const p = listPrompt('P (15) PURCHASE DEP - COATING & OTHER JOB WORK', '1. JAI SAI FABRICATORS');

    test('the heading goes in — it is the only place the trade is written down', () => {
        expect(p).toContain('P (15) PURCHASE DEP - COATING & OTHER JOB WORK');
        expect(p).toContain('TITLE:');
    });

    test('it forbids inventing anything', () => {
        expect(p).toContain('NEVER invent');
        expect(p).toContain('A guessed phone');
    });

    test('it says not to reformat a number', () => {
        // A country code added or dropped is a number that no longer dials.
        expect(p).toContain('digit for digit');
    });

    test('it says remarks are the point, and must not be summarised', () => {
        expect(p).toContain('Do not summarise');
        expect(p).toContain('Rourkela');
    });

    test('it says a number with no owner belongs to the firm, not the first person', () => {
        expect(p).toContain('belong to the FIRM');
    });

    test('it says the numbering cannot be counted on', () => {
        expect(p).toContain('restart');
    });

    test('a huge list is cut to a length that can be sent', () => {
        const huge = 'x'.repeat(50000);
        expect(listPrompt('T', huge).length).toBeLessThan(30000);
    });
});

describe('what comes back', () => {
    const good = JSON.stringify({ firms: [{
        company: 'JAI SAI FABRICATORS', trade: 'coating', city: 'Chennai',
        people: [{ name: 'S. MURALI', role: 'Owner', phones: ['98400 11111'], emails: [] }],
        phones: ['044 2222'], emails: ['saimurali@gmail.com'],
        notes: ['HIS SHOP IS IN SATANGADU'],
    }] });

    test('plain JSON is read', () => {
        const r = parseFirms(good);
        expect(r.failed).toBe(false);
        expect(r.firms).toHaveLength(1);
        expect(r.firms[0].company).toBe('JAI SAI FABRICATORS');
        expect(r.firms[0].people[0].phones).toEqual(['98400 11111']);
    });

    test('JSON with a sentence around it is still read', () => {
        // Cheap to survive, expensive to crash on — this is his whole phone book.
        expect(parseFirms('Here you go:\n' + good + '\nHope that helps.').firms).toHaveLength(1);
    });

    test('something that is not JSON at all fails honestly', () => {
        const r = parseFirms('I could not read that.');
        expect(r.failed).toBe(true);
        expect(r.firms).toEqual([]);
    });

    test('a firm with no name and nobody in it is dropped', () => {
        expect(parseFirms(JSON.stringify({ firms: [{ company: '', people: [] }] })).firms).toEqual([]);
    });

    test('a firm with no name but a person is KEPT — one-man outfits are real here', () => {
        const r = parseFirms(JSON.stringify({ firms: [{ company: '', people: [{ name: 'ANKUR', phones: ['9'] }] }] }));
        expect(r.firms).toHaveLength(1);
    });

    test('rubbish in a field does not crash the read', () => {
        const r = parseFirms(JSON.stringify({ firms: [{ company: 'X', people: 'not a list', notes: 42, phones: null }] }));
        expect(r.firms[0].people).toEqual([]);
        expect(r.firms[0].notes).toEqual([]);
        expect(r.firms[0].phones).toEqual([]);
    });

    test('an address that is not an address is dropped', () => {
        expect(cleanFirm({ company: 'X', emails: ['not-an-email', 'real@firm.com'] }).emails)
            .toEqual(['real@firm.com']);
    });

    test('a very long remark is cut, not dropped', () => {
        const long = 'y'.repeat(900);
        expect(cleanFirm({ company: 'X', notes: [long] }).notes[0].length).toBe(400);
    });
});

describe('the card each firm becomes', () => {
    const firm = {
        company: 'JAI SAI FABRICATORS', trade: 'coating & job work', city: 'Chennai',
        people: [{ name: 'S. MURALI', role: 'Owner', phones: ['98400 11111'], emails: [] }],
        phones: ['044 2222'], emails: ['office@jaisai.com'],
        notes: ['HIS SHOP IS IN SATANGADU', 'HE HAS ALSO DONE WORK IN CPCL'],
    };

    test('the people come across with their numbers and roles', () => {
        const p = previewFromListFirm(firm, 'PURCHASE DEP - COATING');
        expect(p.company).toBe('JAI SAI FABRICATORS');
        expect(p.people[0].name).toBe('S. MURALI');
        expect(p.people[0].role).toBe('Owner');
        expect(p.people[0].phones[0].v).toBe('98400 11111');
    });

    test('a board line nobody was named for still reaches the card', () => {
        // Dropping it would lose the only number for half these firms.
        const p = previewFromListFirm(firm, 'x');
        const office = p.people.filter((c) => !c.name)[0];
        expect(office).toBeTruthy();
        expect(office.phones[0].v).toBe('044 2222');
        expect(office.emails[0].v).toBe('office@jaisai.com');
    });

    test('every remark survives, word for word', () => {
        const p = previewFromListFirm(firm, 'x');
        const texts = p.notes.map((n) => n.t);
        expect(texts).toContain('HIS SHOP IS IN SATANGADU');
        expect(texts).toContain('HE HAS ALSO DONE WORK IN CPCL');
    });

    test('the card says which list it came out of', () => {
        // Months later, "where did this come from?" has an answer on the card itself.
        const p = previewFromListFirm(firm, 'PURCHASE DEP - COATING');
        expect(p.notes.map((n) => n.t).join(' ')).toContain('PURCHASE DEP - COATING');
    });

    test('the trade is written down but the ROLE is left blank', () => {
        // "Coating & job work" is not dealer, transporter, manufacturer or fabricator.
        // Forcing it into one would be putting words in his mouth, and the role decides
        // who gets sent an enquiry.
        const p = previewFromListFirm(firm, 'x');
        expect(p.roleOther).toBe('coating & job work');
        expect(p.role).toBe('');
    });

    test('nothing else is invented', () => {
        const p = previewFromListFirm(firm, 'x');
        expect(p.partLoad).toBeNull();
        expect(p.moq).toBe(0);
        expect(p.types).toEqual([]);
        expect(p.products).toEqual([]);
    });

    test('a town is only set when one was actually named', () => {
        expect(previewFromListFirm(firm, 'x').city).toBe('Chennai');
        expect(previewFromListFirm(Object.assign({}, firm, { city: '' }), 'x').city).toBe('');
    });

    test('a firm with no office numbers gets no empty extra contact', () => {
        const lean = Object.assign({}, firm, { phones: [], emails: [] });
        expect(previewFromListFirm(lean, 'x').people).toHaveLength(1);
    });
});
