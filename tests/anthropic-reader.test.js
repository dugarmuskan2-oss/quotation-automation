/**
 * @jest-environment node
 *
 * tests/anthropic-reader.test.js
 *
 * utils/anthropic.js — the Claude reader behind the directory's two AI reads (the Add tab,
 * and a brochure arriving on the Gmail label).
 *
 * Why it exists: those reads are all judgement calls — which firm is this, is "24 inch pipes"
 * a product or a note, did the text actually say what kind of firm they are — and the small
 * cheap model got them wrong in ways the owner reported. It matched MSL to ARC Limited and
 * offered to RENAME it, filed a product as a note, and invented a role change from a sentence
 * that said nothing about roles.
 *
 * What is pinned here:
 *   1. A file reaches Claude in the shape Claude takes — and a PDF is a document, not an image.
 *   2. The answer is the words, not the thinking that came before them.
 *   3. A read that did not happen THROWS. A refusal arrives as a normal 200, so it has to be
 *      checked rather than caught, and a half-read must never come back looking clean.
 *   4. With no key set, the reader reports itself unavailable rather than crashing — that is
 *      what lets routes/contacts.js keep working on the old reader until the key is added.
 */
'use strict';

const path = require('path');

const MODULE = path.join(__dirname, '..', 'utils', 'anthropic.js');

/** Load a fresh copy of the module with a chosen env and a stubbed SDK. */
function load({ key, create }) {
    jest.resetModules();
    const calls = [];
    jest.doMock('@anthropic-ai/sdk', () => {
        return function Anthropic() {
            return {
                messages: {
                    create: (args) => {
                        calls.push(args);
                        return Promise.resolve(create(args));
                    },
                },
            };
        };
    });
    const had = process.env.ANTHROPIC_API_KEY;
    if (key) process.env.ANTHROPIC_API_KEY = key;
    else delete process.env.ANTHROPIC_API_KEY;
    // eslint-disable-next-line global-require
    const mod = require(MODULE);
    return { mod, calls, restore: () => { if (had === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = had; } };
}

const said = (text) => () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

afterEach(() => { jest.resetModules(); jest.dontMock('@anthropic-ai/sdk'); });

describe('utils/anthropic — how a file reaches Claude', () => {
    test('a PDF goes as a document, a photo as an image, and neither is uploaded first', async () => {
        // The old reader had to upload a PDF and reference it by id. Sending a PDF as a fake
        // JPEG — which is what the OpenAI path did for anything not ending .pdf — comes back
        // having read nothing at all.
        const { mod, calls, restore } = load({ key: 'k', create: said('{"mode":"new"}') });
        await mod.readWithClaude({ prompt: 'read this', fileBase64: 'QUJD', fileName: 'rates.pdf' });
        await mod.readWithClaude({ prompt: 'read this', fileBase64: 'QUJD', fileName: 'card.jpg' });
        restore();

        const pdf = calls[0].messages[0].content[0];
        expect(pdf.type).toBe('document');
        expect(pdf.source).toEqual({ type: 'base64', media_type: 'application/pdf', data: 'QUJD' });

        const photo = calls[1].messages[0].content[0];
        expect(photo.type).toBe('image');
        expect(photo.source.media_type).toBe('image/jpeg');
    });

    test('the file comes BEFORE the instructions about it', async () => {
        // A document read after the question about it is understood worse than one read before.
        const { mod, calls, restore } = load({ key: 'k', create: said('{}') });
        await mod.readWithClaude({ prompt: 'what is in this', fileBase64: 'QUJD', fileName: 'b.pdf' });
        restore();
        const content = calls[0].messages[0].content;
        expect(content[0].type).toBe('document');
        expect(content[1]).toEqual({ type: 'text', text: 'what is in this' });
    });

    test('with no file it is just the words, and the reasoning model is asked for', async () => {
        const { mod, calls, restore } = load({ key: 'k', create: said('{}') });
        await mod.readWithClaude({ prompt: 'MSL now has 24 inch pipes also' });
        restore();
        expect(calls[0].messages[0].content).toEqual([{ type: 'text', text: 'MSL now has 24 inch pipes also' }]);
        expect(calls[0].model).toBe('claude-opus-5');
        expect(calls[0].thinking).toEqual({ type: 'adaptive' });
    });

    test('a png is a png — the type is read off the name, not assumed', async () => {
        // Both directions: sending every photo as a jpeg is what the old path did.
        const { mod, calls, restore } = load({ key: 'k', create: said('{}') });
        await mod.readWithClaude({ prompt: 'x', fileBase64: 'QUJD', fileName: 'CARD.PNG' });
        restore();
        expect(calls[0].messages[0].content[0].source.media_type).toBe('image/png');
    });
});

describe('utils/anthropic — what comes back', () => {
    test('the answer is the words, with thinking blocks in front of them', async () => {
        // Adaptive thinking puts thinking blocks before the text. Taking content[0] blindly
        // would hand the caller reasoning instead of the JSON it has to parse.
        //
        // Honest note: the `type === 'text'` filter inside textOf cannot be proved by this
        // test, and I did not pretend otherwise. A thinking block carries `.thinking`, not
        // `.text`, so dropping the filter produces the same string here. The filter stays
        // because it is correct and free, but what is PINNED below is the result, not the
        // mechanism: text after thinking, with no leading blank line.
        const { mod, restore } = load({
            key: 'k',
            create: () => ({
                stop_reason: 'end_turn',
                content: [
                    { type: 'thinking', thinking: 'The firm is MSL, already on file...' },
                    { type: 'text', text: '{"mode":"update"}' },
                ],
            }),
        });
        const out = await mod.readWithClaude({ prompt: 'x' });
        restore();
        expect(out).toBe('{"mode":"update"}');
    });

    test('several text blocks come back joined, in order', async () => {
        // Claude can split an answer across blocks. Reading only the first would truncate the
        // JSON and the caller's parse would fail on a read that actually succeeded.
        const { mod, restore } = load({
            key: 'k',
            create: () => ({
                stop_reason: 'end_turn',
                content: [
                    { type: 'text', text: '{"mode":"update",' },
                    { type: 'text', text: '"company":"MSL"}' },
                ],
            }),
        });
        const out = await mod.readWithClaude({ prompt: 'x' });
        restore();
        expect(out).toBe('{"mode":"update",\n"company":"MSL"}');
    });

    test('a refusal is a failure, even though it arrives as a normal answer', async () => {
        // stop_reason 'refusal' is an HTTP 200 with content. Nothing throws on its own, so an
        // unchecked refusal would read as "found nothing in that email" — which the owner
        // files away as done, and the firm never gets in.
        const { mod, restore } = load({
            key: 'k',
            create: () => ({ stop_reason: 'refusal', content: [{ type: 'text', text: '' }] }),
        });
        await expect(mod.readWithClaude({ prompt: 'x' })).rejects.toThrow(/declined/i);
        restore();
    });

    test('an empty answer is a failure too, not an empty read', async () => {
        const { mod, restore } = load({ key: 'k', create: () => ({ stop_reason: 'end_turn', content: [] }) });
        await expect(mod.readWithClaude({ prompt: 'x' })).rejects.toThrow(/nothing to read/i);
        restore();
    });

    test('a good read does NOT throw — or the guards above would just break everything', async () => {
        const { mod, restore } = load({ key: 'k', create: said('  {"mode":"new"}  ') });
        await expect(mod.readWithClaude({ prompt: 'x' })).resolves.toBe('{"mode":"new"}');
        restore();
    });
});

describe('utils/anthropic — with no key set', () => {
    test('it reports itself unavailable instead of crashing', () => {
        // This is what lets the app keep reading on the old model until the key is added.
        const { mod, restore } = load({ key: '', create: said('{}') });
        expect(mod.isAvailable()).toBe(false);
        restore();
    });

    test('and asking it to read anyway says why, in words the owner can act on', async () => {
        const { mod, restore } = load({ key: '', create: said('{}') });
        await expect(mod.readWithClaude({ prompt: 'x' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
        restore();
    });

    test('with a key it IS available — both directions, or the check means nothing', () => {
        const { mod, restore } = load({ key: 'sk-ant-test', create: said('{}') });
        expect(mod.isAvailable()).toBe(true);
        restore();
    });
});
