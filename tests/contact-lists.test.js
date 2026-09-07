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

describe('one firm gathered from several lists', () => {
    /**
     * The owner's actual complaint: "maharashtra seamless has details of branches, whatsapp
     * groups, transporters — none of this is reflected". It appears in the coating list with
     * one man, in the purchase list with its branches, and elsewhere with the transporters
     * it uses. Read list by list that is three thin cards; merged it is the card he wanted.
     */
    const { tidyName, dialKey, mergeListFirms } = require('../utils/contactLists');
    const entry = (source, firm) => ({ source, firm: Object.assign({
        company: '', trade: '', city: '', people: [], phones: [], emails: [], notes: [] }, firm) });

    test('the same firm written three ways is tidied to one name', () => {
        expect(tidyName('M/S MAHARASHTRA SEAMLESS LTD.')).toBe('maharashtra seamless');
        expect(tidyName('Maharashtra Seamless Limited')).toBe('maharashtra seamless');
        expect(tidyName('  maharashtra   seamless  ')).toBe('maharashtra seamless');
    });

    test('BUT two genuinely different firms stay apart', () => {
        // Both are real pipe names in his book. Welding them together is the one mistake he
        // could never spot, which is why the whole name must match, not part of it.
        expect(tidyName('Jindal Pipe')).not.toBe(tidyName('Jindal Saw'));
        const r = mergeListFirms([
            entry('list A', { company: 'Jindal Pipe' }),
            entry('list B', { company: 'Jindal Saw' }),
        ]);
        expect(r).toHaveLength(2);
    });

    test('and a longer name is not swallowed by a shorter one', () => {
        const r = mergeListFirms([
            entry('A', { company: 'Sri Steel' }),
            entry('B', { company: 'Sri Steel Traders' }),
        ]);
        expect(r).toHaveLength(2);
    });

    test('a shared phone number merges them however the name is written', () => {
        const r = mergeListFirms([
            entry('coating', { company: 'MAHA SEAMLESS', phones: ['+91 98400 11111'] }),
            entry('purchase', { company: 'Something Else Entirely', phones: ['09840011111'] }),
        ]);
        expect(r).toHaveLength(1);
        expect(r[0].sources.sort()).toEqual(['coating', 'purchase']);
    });

    test('a number is the same number whatever the country code and spacing', () => {
        expect(dialKey('+91 98400 11111')).toBe(dialKey('09840011111'));
        expect(dialKey('98400-11111')).toBe('9840011111');
        expect(dialKey('12345')).toBe('');            // too short to be a phone
    });

    test('the firm ends up with everything every list knew', () => {
        const r = mergeListFirms([
            entry('coating', { company: 'MAHARASHTRA SEAMLESS LTD',
                people: [{ name: 'RAJESH KURANA', role: '', phones: ['98400 11111'], emails: [] }],
                notes: ['does coating job work'] }),
            entry('purchase', { company: 'Maharashtra Seamless Limited', city: 'Mumbai',
                people: [{ name: 'Sunil', role: 'Sales', phones: ['98400 22222'], emails: ['sunil@mahaseam.com'] }],
                notes: ['branch at Chennai'] }),
            entry('transporters', { company: 'M/S MAHARASHTRA SEAMLESS',
                notes: ['uses ABC Roadlines for Chennai'] }),
        ]);

        expect(r).toHaveLength(1);
        const f = r[0];
        expect(f.company).toBe('Maharashtra Seamless Limited');   // the fullest spelling
        expect(f.city).toBe('Mumbai');
        expect(f.people.map((p) => p.name).sort()).toEqual(['RAJESH KURANA', 'Sunil']);
        expect(f.notes).toContain('does coating job work');
        expect(f.notes).toContain('branch at Chennai');
        expect(f.notes).toContain('uses ABC Roadlines for Chennai');
        expect(f.sources.sort()).toEqual(['coating', 'purchase', 'transporters']);
    });

    test('joining is contagious — A to B by number, B to C by name, all one firm', () => {
        const r = mergeListFirms([
            entry('A', { company: 'Alpha', phones: ['98400 11111'] }),
            entry('B', { company: 'Maharashtra Seamless', phones: ['98400 11111'] }),
            entry('C', { company: 'M/S MAHARASHTRA SEAMLESS LTD' }),
        ]);
        expect(r).toHaveLength(1);
        expect(r[0].sources.sort()).toEqual(['A', 'B', 'C']);
    });

    test('a firm that BRIDGES two groups folds them together', () => {
        // The contagious case that matters: two firms form separate groups first, and a
        // third entry sharing a number with each proves they were one firm all along. My
        // first version of this test could not fail — the keys happened to chain anyway.
        const r = mergeListFirms([
            entry('A', { company: 'Alpha Traders', phones: ['98400 11111'] }),
            entry('B', { company: 'Beta Steels', phones: ['98400 22222'] }),
            entry('C', { company: 'Gamma', phones: ['98400 11111', '98400 22222'] }),
        ]);
        expect(r).toHaveLength(1);
        expect(r[0].sources.sort()).toEqual(['A', 'B', 'C']);
    });

    test('the fullest name wins even when it comes FIRST', () => {
        // Keeping whichever name arrived last would quietly shorten "Ravi Kumar" to "Ravi"
        // depending only on which list was read first.
        const r = mergeListFirms([
            entry('A', { company: 'X', people: [{ name: 'Ravi Kumar', role: 'Owner', phones: ['98400 11111'], emails: [] }] }),
            entry('B', { company: 'X', people: [{ name: 'Ravi', role: '', phones: ['98400 11111'], emails: [] }] }),
        ]);
        expect(r[0].people).toHaveLength(1);
        expect(r[0].people[0].name).toBe('Ravi Kumar');
        expect(r[0].people[0].role).toBe('Owner');
    });

    test('the same man in two lists is one person, matched on his mobile', () => {
        const r = mergeListFirms([
            entry('A', { company: 'X', people: [{ name: 'Ravi', role: '', phones: ['+91 98400 11111'], emails: [] }] }),
            entry('B', { company: 'X', people: [{ name: 'Ravi Kumar', role: 'Owner', phones: ['09840011111'], emails: ['r@x.com'] }] }),
        ]);
        expect(r[0].people).toHaveLength(1);
        expect(r[0].people[0].name).toBe('Ravi Kumar');       // the fuller name
        expect(r[0].people[0].role).toBe('Owner');            // the role that was recorded
        expect(r[0].people[0].emails).toEqual(['r@x.com']);
    });

    test('two different men at one firm stay two', () => {
        const r = mergeListFirms([
            entry('A', { company: 'X', people: [{ name: 'Ravi', phones: ['98400 11111'], emails: [] }] }),
            entry('A', { company: 'X', people: [{ name: 'Kumar', phones: ['98400 22222'], emails: [] }] }),
        ]);
        expect(r[0].people).toHaveLength(2);
    });

    test('the same number typed twice is stored once', () => {
        const r = mergeListFirms([
            entry('A', { company: 'X', phones: ['+91 98400 11111', '098400 11111', '98400 11111'] }),
        ]);
        expect(r[0].phones).toHaveLength(1);
    });

    test('a firm in only one list comes through untouched', () => {
        const r = mergeListFirms([entry('A', { company: 'Solo Traders', notes: ['a note'] })]);
        expect(r).toHaveLength(1);
        expect(r[0].company).toBe('Solo Traders');
        expect(r[0].sources).toEqual(['A']);
    });

    test('nothing at all does not throw', () => {
        expect(mergeListFirms([])).toEqual([]);
        expect(mergeListFirms(null)).toEqual([]);
    });
});

describe('a firm named inside another firm gets its own card', () => {
    /**
     * The owner's correction, and he was right: "transporters under it must have its own
     * card with a note saying they are for MSL, same with coating".
     *
     * "Maharashtra Seamless sends material through ABC Roadlines" is TWO firms. Kept as a
     * line on the mill's card, ABC Roadlines has no card of its own — so it is never
     * ranked, never suggested, and never sent a freight enquiry. A transporter with no card
     * does not exist as far as this app is concerned.
     */
    const { mergeListFirms, linkFirms, listPrompt } = require('../utils/contactLists');
    const firm = (over) => Object.assign({
        company: '', trade: '', city: '', people: [], phones: [], emails: [], notes: [], relations: [],
    }, over);

    test('the instructions say so, in as many words', () => {
        const p = listPrompt('t', 'x');
        expect(p).toContain('STILL A FIRM');
        expect(p).toContain('never gets a card');
        expect(p).toContain('ABC Roadlines');
    });

    test('the transporter\'s own card says who it hauls for', () => {
        const out = linkFirms([
            firm({ company: 'Maharashtra Seamless Limited' }),
            firm({ company: 'ABC Roadlines', trade: 'transporter',
                   relations: [{ firm: 'Maharashtra Seamless Limited', how: 'transporter for them' }] }),
        ]);
        const abc = out.filter((f) => f.company === 'ABC Roadlines')[0];
        expect(abc.notes.join(' ')).toContain('Transporter for them');
        expect(abc.notes.join(' ')).toContain('Maharashtra Seamless Limited');
    });

    test('and the mill\'s card says who hauls for it', () => {
        const out = linkFirms([
            firm({ company: 'Maharashtra Seamless Limited' }),
            firm({ company: 'ABC Roadlines',
                   relations: [{ firm: 'Maharashtra Seamless Limited', how: 'transporter for them' }] }),
        ]);
        const msl = out.filter((f) => f.company === 'Maharashtra Seamless Limited')[0];
        expect(msl.notes.join(' ')).toContain('ABC Roadlines');
        expect(msl.notes.join(' ')).toContain('transporter for them');
    });

    test('coating is the same story', () => {
        const out = linkFirms([
            firm({ company: 'Maharashtra Seamless' }),
            firm({ company: 'JAI SAI FABRICATORS', trade: 'coating',
                   relations: [{ firm: 'Maharashtra Seamless', how: 'coating is done by them' }] }),
        ]);
        expect(out.filter((f) => f.company === 'JAI SAI FABRICATORS')[0].notes.join(' '))
            .toContain('Maharashtra Seamless');
        expect(out.filter((f) => f.company === 'Maharashtra Seamless')[0].notes.join(' '))
            .toContain('JAI SAI FABRICATORS');
    });

    test('one transporter hauling for two mills says both', () => {
        const out = linkFirms([
            firm({ company: 'Maharashtra Seamless' }),
            firm({ company: 'ISMT Limited' }),
            firm({ company: 'ABC Roadlines', relations: [
                { firm: 'Maharashtra Seamless', how: 'transporter for them' },
                { firm: 'ISMT Limited', how: 'transporter for them' },
            ] }),
        ]);
        const abc = out.filter((f) => f.company === 'ABC Roadlines')[0];
        expect(abc.notes.join(' ')).toContain('Maharashtra Seamless');
        expect(abc.notes.join(' ')).toContain('ISMT Limited');
    });

    test('the named firm not being in the lists loses nothing', () => {
        // Plenty are mentioned only in passing. Half a connection is still worth keeping.
        const out = linkFirms([
            firm({ company: 'ABC Roadlines',
                   relations: [{ firm: 'Some Mill Not In The Book', how: 'transporter for them' }] }),
        ]);
        expect(out[0].notes.join(' ')).toContain('Some Mill Not In The Book');
    });

    test('the name is matched the same tidy way, so LTD does not break the link', () => {
        const out = linkFirms([
            firm({ company: 'M/S MAHARASHTRA SEAMLESS LTD.' }),
            firm({ company: 'ABC Roadlines',
                   relations: [{ firm: 'Maharashtra Seamless Limited', how: 'transporter' }] }),
        ]);
        expect(out[0].notes.join(' ')).toContain('ABC Roadlines');
    });

    test('the same relation twice is written once', () => {
        const out = linkFirms([
            firm({ company: 'MSL' }),
            firm({ company: 'ABC', relations: [
                { firm: 'MSL', how: 'transporter' }, { firm: 'MSL', how: 'transporter' },
            ] }),
        ]);
        expect(out.filter((f) => f.company === 'ABC')[0].notes).toHaveLength(1);
    });

    test('a relation survives the merging, so it is not lost on the way', () => {
        const merged = mergeListFirms([
            { source: 'A', firm: firm({ company: 'ABC Roadlines',
                relations: [{ firm: 'MSL', how: 'transporter for them' }] }) },
            { source: 'B', firm: firm({ company: 'ABC Roadlines',
                relations: [{ firm: 'ISMT', how: 'transporter for them' }] }) },
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].relations.map((r) => r.firm).sort()).toEqual(['ISMT', 'MSL']);
    });

    test('a firm with no relations is left exactly as it was', () => {
        const out = linkFirms([firm({ company: 'Solo', notes: ['a note'] })]);
        expect(out[0].notes).toEqual(['a note']);
    });

    test('nothing at all does not throw', () => {
        expect(linkFirms([])).toEqual([]);
        expect(linkFirms(null)).toEqual([]);
    });
});

describe('relations survive the whole journey, and do not fold back on themselves', () => {
    const { parseFirms, linkFirms } = require('../utils/contactLists');

    test('a relation read from Claude reaches the firm — cleaning must not drop it', () => {
        // Every linking test above builds its firms by hand, so all of them passed while
        // cleanFirm quietly threw relations away. This is the step in between.
        const r = parseFirms(JSON.stringify({ firms: [{
            company: 'ABC Roadlines',
            relations: [{ firm: 'Maharashtra Seamless', how: 'transporter for them' }],
        }] }));
        expect(r.firms[0].relations).toHaveLength(1);
        expect(r.firms[0].relations[0].firm).toBe('Maharashtra Seamless');
        expect(r.firms[0].relations[0].how).toBe('transporter for them');
    });

    test('a relation with no firm named is dropped', () => {
        const r = parseFirms(JSON.stringify({ firms: [{
            company: 'X', relations: [{ firm: '', how: 'something' }, { firm: 'Y', how: '' }],
        }] }));
        expect(r.firms[0].relations).toHaveLength(1);
        expect(r.firms[0].relations[0].firm).toBe('Y');
    });

    test('rubbish in relations does not crash the read', () => {
        expect(parseFirms(JSON.stringify({ firms: [{ company: 'X', relations: 'nonsense' }] }))
            .firms[0].relations).toEqual([]);
    });

    test('a firm naming ITSELF does not write a note about itself', () => {
        // The lists repeat a firm's own name constantly. Linking it to itself would fill the
        // card with "Maharashtra Seamless — supplies them", which says nothing.
        const out = linkFirms([{
            company: 'Maharashtra Seamless Limited', notes: [],
            relations: [{ firm: 'M/S MAHARASHTRA SEAMLESS LTD', how: 'supplies them' }],
        }]);
        // The one note is the outgoing line; there must not be a second, reversed onto itself.
        expect(out[0].notes).toHaveLength(1);
        expect(out[0].notes[0]).toContain('Supplies them');
    });
});
