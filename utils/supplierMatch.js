'use strict';

/**
 * utils/supplierMatch.js — the AI half of "Ask AI — who can I buy this from?".
 *
 * *His words (30 Sep): "all the free things can be free. whatever the free thing cant figure, the
 * AI helps. Same button."* The page ranks every dealer and maker with free rules first. Only the
 * firms those rules could not decide — no pipe family on the card, or no size lines for the family
 * asked — come here, and Claude reads each one's own card to say whether it makes or stocks what
 * the enquiry asks.
 *
 * Claude must quote the card. A "yes" or "no" whose quoted words are not on that card is turned
 * into "maybe": the tag the owner sees is always something the card actually says.
 */

const crypto = require('crypto');

const MAX_CARDS = 25;
const NOTE_CHARS = 600;

const str = (v) => String(v == null ? '' : v).trim();

/** Numbers and addresses are no use to the judgement and are not sent. */
function scrub(text) {
    return str(text)
        .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
        .replace(/(\+?\d[\d\s-]{7,}\d)/g, '[number]');
}

/** The enquiry as written: emails and phone numbers out, but "IS 1239-2004" and "15 20 25 NB" kept. */
function scrubEnquiry(text) {
    return str(text)
        .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
        .replace(/(?:\+?91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, '[number]')
        .replace(/\b0\d{2,4}[\s-]\d{6,8}\b/g, '[number]');
}

function sizeText(s) {
    return ['nb', 'inch', 'od', 'thk'].map((k) => (str(s && s[k]) ? k + ' ' + str(s[k]) : '')).filter(Boolean).join(', ');
}

/**
 * One card as the AI reads it: name, trade, towns, pipe types, every product row with its sizes,
 * then notes (product-looking ones first) up to a cap that says so when it bites.
 */
function cardText(p) {
    const lines = [];
    lines.push('FIRM: ' + str(p.company) + (str(p.role) ? ' (' + str(p.role) + ')' : ''));
    const towns = [str(p.city)].concat((p.branches || []).map((b) => str(b.city) + (str(b.address) ? ' — ' + str(b.address) : ''))).filter(Boolean);
    if (towns.length) lines.push('PLACES: ' + towns.join('; '));
    if ((p.categories || []).length) lines.push('FILED UNDER: ' + p.categories.map(str).join('; '));
    if ((p.types || []).length) lines.push('PIPE TYPES: ' + p.types.map(str).join(', '));
    (p.products || []).forEach((pr) => {
        const bits = [str(pr.p), str(pr.spec), str(pr.make) ? 'make ' + str(pr.make) : ''].filter(Boolean).join(' · ');
        const sizes = (pr.sizes || []).map(sizeText).filter(Boolean);
        lines.push('PRODUCT: ' + bits + (sizes.length ? ' — sizes: ' + sizes.join(' | ') : ''));
    });
    const notes = (p.notes || []).map((n) => str(n && n.t)).filter(Boolean);
    const producty = (t) => /pipe|tube|erw|seamless|\bgi\b|galvan|hsaw|lsaw|sch|nb\b|"|inch|mm|size|stock|make|manufactur/i.test(t);
    const ordered = notes.filter(producty).concat(notes.filter((t) => !producty(t)));
    let used = 0, cut = 0;
    ordered.forEach((t) => {
        if (used + t.length > NOTE_CHARS) { cut++; return; }
        used += t.length;
        lines.push('NOTE: ' + t);
    });
    if (cut) lines.push('(' + cut + ' of ' + notes.length + ' notes left out for length)');
    return scrub(lines.join('\n'));
}

function needText(need) {
    const items = (need.items || []).map((li) => str(li.product) + (li.inches != null ? ' [' + li.inches + ' inch]' : '')).filter(Boolean);
    return 'PIPE TYPE(S): ' + ((need.types || []).join(', ') || 'not stated')
        + (items.length ? '\nLINES: ' + items.join(' ; ') : '')
        + (str(need.text) ? '\nTHE ENQUIRY AS WRITTEN: ' + scrubEnquiry(need.text) : '');
}

const hash = (v) => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['firms'],
    properties: {
        firms: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['n', 'verdict', 'quote', 'why'],
                properties: {
                    n: { type: 'integer' },
                    verdict: { type: 'string', enum: ['yes', 'maybe', 'no', 'not_on_card'] },
                    quote: { type: 'string' },
                    why: { type: 'string' },
                },
            },
        },
    },
};

function buildPrompt(need, texts) {
    return 'A steel-pipe trader in Chennai wants to know which of these suppliers can supply an enquiry.\n\n'
        + 'THE ENQUIRY\n' + needText(need) + '\n\n'
        + 'For EACH firm below, read only its own card and decide:\n'
        + '- "yes": the card says it makes or stocks this pipe type (and the size, if a size is asked and the card gives sizes);\n'
        + '- "no": the card says it deals in something else, or its sizes plainly stop short of the size asked;\n'
        + '- "maybe": the card points that way but does not say it outright;\n'
        + '- "not_on_card": the card says nothing about what it supplies.\n'
        + 'For "yes", "no" and "maybe", put in "quote" the exact words from that card (copied character for character, at most 120 characters) that show it. For "not_on_card", leave "quote" empty.\n'
        + 'In "why", one short plain sentence. Never use outside knowledge about a firm; judge only from its card. "n" is the firm\'s number below.\n\n'
        + texts.map((t, i) => '--- FIRM ' + (i + 1) + ' ---\n' + t).join('\n\n');
}

/** Compare as written, ignoring case, spacing and the several ways an inch mark is typed. */
function norm(t) {
    return str(t).toLowerCase().replace(/[”″“]/g, '"').replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}

/** A "yes" or "no" must rest on words that are on the card. */
function groundVerdicts(answer, texts) {
    const out = [];
    ((answer && answer.firms) || []).forEach((f) => {
        const i = Number(f && f.n) - 1;
        if (!(i >= 0 && i < texts.length)) return;
        let verdict = str(f.verdict), quote = str(f.quote).slice(0, 160), why = str(f.why).slice(0, 200);
        if ((verdict === 'yes' || verdict === 'no' || verdict === 'maybe') && (!quote || norm(texts[i]).indexOf(norm(quote)) === -1)) {
            verdict = 'maybe';
            why = 'The AI\'s reason is not on their card — worth a call.';
            quote = '';
        }
        out[i] = { verdict, quote, why };
    });
    return out;
}

const found = new Map();      // needHash|cardHash → verdict, for this server copy
const running = new Map();    // one call per identical ask, even from two tabs

/**
 * cards: [{ id, card }]. Returns { verdicts: { id: {verdict, quote, why} }, checked, capped }.
 * judge: ({prompt, schema}) → { answer } — the Claude call, passed in so tests need no network.
 */
async function matchSuppliers({ need, cards, judge }) {
    const list = (cards || []).slice(0, MAX_CARDS);
    const capped = Math.max(0, (cards || []).length - list.length);
    const needKey = hash(needText(need));
    const verdicts = {};
    const todo = [];
    list.forEach((c) => {
        const text = cardText(c.card);
        const key = needKey + '|' + hash(text);
        if (found.has(key)) verdicts[c.id] = found.get(key);
        else todo.push({ id: c.id, text, key });
    });
    if (todo.length) {
        const askKey = needKey + '|' + todo.map((t) => t.key).join(',');
        if (!running.has(askKey)) {
            running.set(askKey, judge({ prompt: buildPrompt(need, todo.map((t) => t.text)), schema: SCHEMA })
                .finally(() => running.delete(askKey)));
        }
        const res = await running.get(askKey);
        const grounded = groundVerdicts(res && res.answer, todo.map((t) => t.text));
        todo.forEach((t, i) => {
            const v = grounded[i] || { verdict: 'not_on_card', quote: '', why: 'The AI gave no answer for this firm.' };
            found.set(t.key, v);
            verdicts[t.id] = v;
        });
    }
    return { verdicts, checked: list.length, capped };
}

module.exports = { matchSuppliers, cardText, needText, buildPrompt, groundVerdicts, SCHEMA, MAX_CARDS,
    _test: { scrub, norm, reset: () => { found.clear(); running.clear(); } } };
