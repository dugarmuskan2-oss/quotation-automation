/**
 * @jest-environment node
 *
 * tests/revision-popup.test.js
 *
 * The "There is a new revision request, please check" pop-up (revision-popup.js).
 * Behavioural: revisionsDueToday (which asks pop up — open, not done, not already shown today),
 * plainText. Source guards: index.html feeds the startup check, marks the adder's own ask as
 * shown, and loads the script; the server allowlist serves it.
 */

// India time: 00:30 on the 5th is still the 4th in UTC, so a UTC slip shows.
process.env.TZ = 'Asia/Kolkata';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'revision-popup.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('function not found: ' + name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

const { revisionsDueToday, plainText, todayKey } = new Function(
    ['revisionsDueToday', 'plainText', 'todayKey'].map(n => extractFunction(src, n)).join('\n')
    + '\nreturn { revisionsDueToday, plainText, todayKey };'
)();

const TODAY = '2026-10-12';
const ask = (id, extra) => Object.assign({ id, text: 'ask ' + id, done: false, addedAt: '2026-10-12T05:00:00Z' }, extra);

describe('revisionsDueToday', () => {
    test('an open ask not shown today is due', () => {
        const due = revisionsDueToday([{ id: 1, revisionRequests: [ask('a')] }], {}, TODAY);
        expect(due.map(d => d.ask.id)).toEqual(['a']);
    });

    test('an ask already shown today is not due again the same day', () => {
        const due = revisionsDueToday([{ id: 1, revisionRequests: [ask('a')] }], { a: TODAY }, TODAY);
        expect(due).toEqual([]);
    });

    test('an ask shown yesterday and still open is due again today', () => {
        const due = revisionsDueToday([{ id: 1, revisionRequests: [ask('a')] }], { a: '2026-10-11' }, TODAY);
        expect(due.map(d => d.ask.id)).toEqual(['a']);
    });

    test('a new ask pops up even when another ask already popped today', () => {
        const quotes = [{ id: 1, revisionRequests: [ask('a'), ask('b')] }];
        expect(revisionsDueToday(quotes, { a: TODAY }, TODAY).map(d => d.ask.id)).toEqual(['b']);
    });

    test('done asks, deleted quotes and asks without an id never pop up', () => {
        const quotes = [
            { id: 1, revisionRequests: [ask('a', { done: true })] },
            { id: 2, deleted: true, revisionRequests: [ask('b')] },
            { id: 3, revisionRequests: [{ text: 'no id', done: false }] },
            { id: 4 },
        ];
        expect(revisionsDueToday(quotes, {}, TODAY)).toEqual([]);
    });

    test('oldest ask first', () => {
        const quotes = [{ id: 1, revisionRequests: [ask('late', { addedAt: '2026-10-12T09:00:00Z' }), ask('early', { addedAt: '2026-10-12T01:00:00Z' })] }];
        expect(revisionsDueToday(quotes, {}, TODAY).map(d => d.ask.id)).toEqual(['early', 'late']);
    });
});

describe('plainText / todayKey', () => {
    test('rich ask text becomes one plain line', () => {
        expect(plainText('<p>Cost to cost on <b>2&quot; ERW</b></p><br>&nbsp;now')).toBe('Cost to cost on 2&quot; ERW now');
    });
    test('todayKey is the local date, zero-padded', () => {
        expect(todayKey(new Date(2026, 0, 5, 0, 30))).toBe('2026-01-05');
    });
});

describe('wiring (source guards)', () => {
    test('index.html loads revision-popup.js', () => {
        expect(html).toMatch(/<script src="revision-popup\.js\?v=[^"]+"><\/script>/);
    });
    test('the startup revision fetch feeds the pop-up', () => {
        const fn = extractFunction(html, 'loadRevisionQuotesForCount');
        expect(fn).toMatch(/window\.RevisionPopup\.check\(found\)/);
    });
    test('whoever adds an ask is not shown it', () => {
        const fn = extractFunction(html, 'addRevisionRequest');
        expect(fn).toMatch(/window\.RevisionPopup\.markShown\(\[result\.entry\.id\]\)/);
    });
    test('the server serves the file', () => {
        const { PUBLIC_FILES } = require('../utils/auth');
        expect(PUBLIC_FILES.has('/revision-popup.js')).toBe(true);
    });
});
