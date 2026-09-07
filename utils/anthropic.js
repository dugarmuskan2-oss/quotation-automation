'use strict';

/**
 * utils/anthropic.js — reading a brochure, a photo or a typed line with Claude.
 *
 * The directory's reads are a handful a day and every one is a judgement call: which firm is
 * this, is "24 inch pipes" a product or a note, did the text actually say what kind of firm
 * they are. On the small cheap model those went wrong often enough to matter — it matched MSL
 * to ARC Limited and offered to rename it, filed a product as a note, and invented a role
 * change from a sentence that said nothing about roles.
 *
 * Only the DIRECTORY reads come through here. Quotation generation stays on its own model —
 * that is high volume and a separate decision.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Claude Opus 5. The reasoning is the whole reason for being here, so this is not the place
// to save a fraction of a penny per read.
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;

let _client = null;

/**
 * null when no key is set, so the caller can fall back rather than crash.
 *
 * An identity-linked key must also say which workspace it is acting in, or every call comes
 * back 400 "anthropic-workspace-id is required". A plain key ignores the header, so sending
 * it whenever it is set is safe either way.
 */
function client() {
    if (_client) return _client;
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const workspace = String(process.env.ANTHROPIC_WORKSPACE_ID || '').trim();
    _client = new Anthropic(workspace
        ? { defaultHeaders: { 'anthropic-workspace-id': workspace } }
        : {});
    return _client;
}

function isAvailable() { return !!client(); }

/**
 * Was the failure the ACCOUNT's, rather than the thing being read?
 *
 * 298 of the 316 phone-book lists came back "Your credit balance is too low", and the reader
 * wrote every one of them off as read so it would not pay to fail twice. That rule is right
 * for a list Claude genuinely cannot make sense of, and exactly wrong here: nothing was
 * charged, nothing was read, and marking them read stranded 298 lists behind a problem that
 * a top-up fixes in a minute.
 *
 * So the two are separated. Out of credit, a bad key, a rate limit, a server having a bad
 * day, a dropped connection — none of those say anything about the list, and all of them are
 * worth trying again. Anything else is the list's own fault and is not retried.
 */
function accountProblem(err) {
    const status = Number((err && err.status) || 0);
    const text = String((err && err.message) || '');
    if (status === 401 || status === 403 || status === 429 || status >= 500) return true;
    if (/credit balance|billing|quota|rate limit|overloaded/i.test(text)) return true;
    if (/anthropic-workspace-id|authentication|api[- ]key/i.test(text)) return true;
    // No status at all is a connection that never arrived, not an answer.
    return !status && /ECONN|ETIMEDOUT|ENOTFOUND|socket|network|fetch failed/i.test(text);
}

/**
 * A PDF or a photo as Claude takes it: base64 inline, no upload step at all.
 * (The OpenAI path had to upload a PDF first and reference it by id.)
 */
function fileBlock(fileBase64, fileName) {
    if (!fileBase64) return null;
    const name = String(fileName || '');
    if (/\.pdf$/i.test(name)) {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } };
    }
    const media = /\.png$/i.test(name) ? 'image/png'
        : /\.webp$/i.test(name) ? 'image/webp'
            : /\.gif$/i.test(name) ? 'image/gif'
                : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: media, data: fileBase64 } };
}

/** The words, ignoring the thinking blocks that come in front of them. */
function textOf(res) {
    return (((res && res.content) || []))
        .filter(b => b && b.type === 'text')
        .map(b => String(b.text || ''))
        .join('\n')
        .trim();
}

/**
 * Ask Claude to read something and return what it said.
 *
 * Throws on anything that is not a clean read — a missing key, a refusal, an empty answer.
 * The caller turns that into a message the owner sees; a half-read must never come back
 * looking like a clean one (CLAUDE.md check #4).
 */
/**
 * A long answer, streamed, with room to finish it.
 *
 * The phone-book lists broke the ordinary call: one with 109 numbers in it came back cut off
 * mid-word — "sales@ashoktubes. — and could not be parsed at all. Two things were wrong.
 * Thinking counts against the same budget as the answer, and on a big extraction adaptive
 * thinking ate most of it before the firms started. And a 30,000-token answer is long enough
 * that a plain request risks timing out while it is written.
 *
 * So this one streams and asks for far more room. The owner wants it thinking HARD: these
 * notes are twenty years of shorthand, and a firm split in two or a number pinned on the
 * wrong man is worse than a slower, dearer read. High effort spends thinking tokens out of
 * the same budget as the answer, which is what cut the first big list off mid-word — so the
 * room is doubled again to leave the answer somewhere to go.
 *
 * A reply that STILL runs out of room is reported as exactly that, never as "could not be
 * read": the two need different answers from the owner, and one of them is not his fault.
 */
async function readLongWithClaude({ prompt, maxTokens, effort }) {
    const c = client();
    if (!c) throw new Error('the Claude key is missing from .env (ANTHROPIC_API_KEY)');

    const stream = await c.messages.stream({
        model: MODEL,
        max_tokens: maxTokens || 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: effort || 'high' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    const res = await stream.finalMessage();

    if (res && res.stop_reason === 'refusal') throw new Error('Claude declined to read that');
    if (res && res.stop_reason === 'max_tokens') {
        const e = new Error('the list is too long to read in one go');
        e.ranOutOfRoom = true;
        throw e;
    }
    return textOf(res);
}

async function readWithClaude({ prompt, fileBase64, fileName }) {
    const c = client();
    if (!c) throw new Error('the Claude key is missing from .env (ANTHROPIC_API_KEY)');

    const file = fileBlock(fileBase64, fileName);
    // The attachment goes FIRST: a document read before the instructions about it is
    // understood better than one read after them.
    const content = file
        ? [file, { type: 'text', text: prompt }]
        : [{ type: 'text', text: prompt }];

    const res = await c.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content }],
    });

    // A refusal comes back as a normal 200, so it has to be checked rather than caught.
    if (res && res.stop_reason === 'refusal') {
        throw new Error('Claude declined to read that file');
    }
    const text = textOf(res);
    if (!text) throw new Error('Claude returned nothing to read');
    return text;
}

module.exports = {
    accountProblem,
    readLongWithClaude,
    readWithClaude,
    isAvailable,
    MODEL,
    _test: { fileBlock, textOf },
};
