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

/** null when no key is set, so the caller can fall back rather than crash. */
function client() {
    if (_client) return _client;
    if (!process.env.ANTHROPIC_API_KEY) return null;
    _client = new Anthropic();
    return _client;
}

function isAvailable() { return !!client(); }

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
    readWithClaude,
    isAvailable,
    MODEL,
    _test: { fileBlock, textOf },
};
