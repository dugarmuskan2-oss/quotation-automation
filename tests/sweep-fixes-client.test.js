/**
 * @jest-environment node
 *
 * tests/sweep-fixes-client.test.js
 *
 * A sweep of client-side defects that shipped, hurt, and were fixed. Each block pins the
 * FIXED behaviour so it cannot quietly regress:
 *
 *  1. FREIGHT ENQUIRY WEIGHT GATE (freight-tab-weight-editor.js).
 *     The enquiry emailed transporters a weight that silently dropped every row with no
 *     kg/m (or no quantity) — 11,085 kg quoted for a load that actually weighed 22,485 kg,
 *     51% light. Freight is priced per kg, so that is a real bill the business eats. The
 *     gate (enqScopeComplete / enqWeightUsable / enqEffectiveWeight) now refuses to produce
 *     a partial number at all: the draft prints "____ kg" and sending is blocked until
 *     every row counts or the user types the weight themselves.
 *
 *  2. SHARED ENQUIRY SECTION (buildSharedEnquiryHtml in index.html) — the "Enquiry" card on
 *     the Copy-Link page. It must keep the customer's own table markup while dropping
 *     <script> and on* handlers, must only ever link an http(s) emailLink (a stored
 *     "javascript:" value must not become a clickable href on a page showing internal
 *     margin data), and must not throw on a NUMBER in emailContent — `.trim is not a
 *     function` used to blank the whole section.
 *
 *  3. MONTH-NAME SEARCH (getMonthIndexFromDateText in index.html). It read the app's own
 *     DD.MM.YY dates with new Date(), which V8 parses as MM.DD.YY: searching "March"
 *     returned MAY's quotes, and anything dated after the 12th was Invalid Date and matched
 *     no month at all. It now reads dates through approvalMonthOf, the same reader the
 *     Month dropdown uses.
 *
 *  4. SEARCH NORMALISER PARITY (normalizeSearchText / matchesApprovalSearch in index.html
 *     vs normalizeSearchQuery / quoteSummaryMatches in routes/quotations.js). The client
 *     did not collapse whitespace and did not drop empty fields, so a quote the SERVER
 *     matched and merged in was hidden again by the client — a blank panel, no message, and
 *     the user concluding the quote had never been made.
 *
 *  5. SOURCE GUARDS for the DOM-bound fixes: Approve only claims success once the write
 *     landed (and rolls the approval back when it did not), a failed "Save as Revision"
 *     restores the revision state instead of stacking a second revision, an unknown
 *     baseline is no longer labelled "Sent version", the Revision button pulses only while
 *     asks are pending and the Revision filter is off (and never under reduced motion),
 *     adding an ask always gives visible feedback, and sending clears the asks through the
 *     dedicated server route.
 *
 * Everything executable here runs the REAL shipped code: the freight helpers come off the
 * module's `_test` export, and the index.html functions are extracted by brace-matching and
 * eval'd with their real dependencies. sanitizeEmailHtmlForPreview is genuinely DOM-bound
 * (document.createElement + innerHTML + querySelectorAll) and jsdom is not installed, so it
 * runs against a minimal HTML document shim defined below — the shim is test scaffolding;
 * the sanitizer under test is the real one, byte for byte.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const QUOTATIONS_ROUTE_PATH = path.join(__dirname, '..', 'routes', 'quotations.js');
const html = fs.readFileSync(INDEX_PATH, 'utf8');
const routeSrc = fs.readFileSync(QUOTATIONS_ROUTE_PATH, 'utf8');

// Pull a top-level `function name(...) { ... }` out of source by brace-matching.
// Keeps a leading `async ` — dropping it turns an inner `await` into a SyntaxError.
// The `(` matters: without it `saveQuotation` matches `saveQuotationToBackend` first.
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('function not found: ' + name);
    if (src.slice(start - 6, start) === 'async ') start -= 6;
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces extracting: ' + name);
}

// Concatenate the named functions (declarations hoist, so order is irrelevant) and return
// the LAST one, optionally with a `document` in scope. No dependency is ever stubbed.
function loadFns(src, names, fakeDocument) {
    const body = names.map(function (n) { return extractFunction(src, n); }).join('\n');
    // eslint-disable-next-line no-new-func
    const factory = new Function('document', body + '\nreturn ' + names[names.length - 1] + ';');
    return factory(fakeDocument || null);
}

// =============================================================================
// 1. FREIGHT ENQUIRY WEIGHT GATE — freight-tab-weight-editor.js (_test export)
// =============================================================================
const {
    enqScopeRows,
    enqScopeWeight,
    enqUncountedRows,
    enqScopeComplete,
    enqWeightUsable,
    enqEffectiveWeight,
    buildEnquiryDraft,
    secComplete,
} = require('../freight-tab-weight-editor')._test;

// The exact load from the incident: two rows carry kg/m, the third does not.
//   500 x 7.39  =  3,695
//  1000 x 7.39  =  7,390   -> 11,085 kg is what the transporter was quoted
//   800 x 14.25 = 11,400   -> the row that was silently dropped
//                             22,485 kg is what actually went on the lorry
const FULL_WEIGHT = 22485;
const PARTIAL_WEIGHT = 11085;

function makeState(overrides) {
    const st = {
        rows: [
            { id: 'r1', sec: 1, d: '2" NB X Heavy -- ERW', qty: 500, kgm: 7.39, removed: false },
            { id: 'r2', sec: 1, d: '2" NB X Heavy -- GI', qty: 1000, kgm: 7.39, removed: false },
            { id: 'r3', sec: 1, d: '4" NB X Sch 40', qty: 800, kgm: 14.25, removed: false },
        ],
        split: false,
        enquiry: { forSec: 0, weightOverride: null },
    };
    return Object.assign(st, overrides || {});
}

// The same load with the third row's kg/m never filled in — the shipped defect.
function makeIncompleteState() {
    const st = makeState();
    st.rows[2].kgm = 0;
    return st;
}

const QUOTE = { id: 'q1', quoteNumber: 'DSC-142' };
const inr = function (n) { return n.toLocaleString('en-IN'); };

describe('freight enquiry weight gate — a partial weight must never reach a transporter', () => {
    test('REGRESSION: a row with no kg/m makes the whole weight unusable, not merely smaller', () => {
        const st = makeIncompleteState();

        // This is the misleading number the enquiry used to send: the raw sum still adds up
        // to the 51%-light figure, which is precisely why nothing may consume it directly.
        expect(enqScopeWeight(st)).toBe(PARTIAL_WEIGHT);

        expect(enqUncountedRows(st)).toHaveLength(1);
        expect(enqUncountedRows(st)[0].id).toBe('r3');
        expect(enqScopeComplete(st)).toBe(false);
        expect(enqWeightUsable(st)).toBe(false);
        // Zero, not 11,085 — callers check enqWeightUsable first, and a partial number that
        // leaks past them must be obviously wrong rather than plausibly wrong.
        expect(enqEffectiveWeight(st)).toBe(0);
    });

    test('REGRESSION: the draft prints a blank "____ kg" placeholder, never the partial figure', () => {
        const draft = buildEnquiryDraft(QUOTE, makeIncompleteState());
        expect(draft).toContain('• Weight: ____ kg');
        expect(draft).not.toContain(inr(PARTIAL_WEIGHT));
        expect(draft).not.toMatch(/Weight: [\d,]+ kg/);
        // The item count is still honest about how many rows the enquiry covers.
        expect(draft).toContain('(3 items)');
    });

    test('every row complete -> usable, and the draft prints the real total', () => {
        const st = makeState();
        expect(enqUncountedRows(st)).toHaveLength(0);
        expect(enqScopeComplete(st)).toBe(true);
        expect(enqWeightUsable(st)).toBe(true);
        expect(enqEffectiveWeight(st)).toBe(FULL_WEIGHT);

        const draft = buildEnquiryDraft(QUOTE, st);
        expect(draft).toContain('• Weight: ' + inr(FULL_WEIGHT) + ' kg');
        expect(draft).not.toContain('____');
    });

    test('a typed weightOverride makes an incomplete scope usable (the user vouched for it)', () => {
        const st = makeIncompleteState();
        st.enquiry.weightOverride = 23000;

        expect(enqScopeComplete(st)).toBe(false);   // still incomplete...
        expect(enqWeightUsable(st)).toBe(true);     // ...but the user typed a number
        expect(enqEffectiveWeight(st)).toBe(23000);
        expect(buildEnquiryDraft(QUOTE, st)).toContain('• Weight: ' + inr(23000) + ' kg');
    });

    test('an override of 0 or a negative number is not a vouch — the gate stays shut', () => {
        const st = makeIncompleteState();
        st.enquiry.weightOverride = 0;
        expect(enqWeightUsable(st)).toBe(false);
        st.enquiry.weightOverride = -5;
        expect(enqWeightUsable(st)).toBe(false);
        expect(enqEffectiveWeight(st)).toBe(0);
    });

    test('the override also wins over a complete scope, so a corrected weight is honoured', () => {
        const st = makeState();
        st.enquiry.weightOverride = 24000;
        expect(enqEffectiveWeight(st)).toBe(24000);
        expect(buildEnquiryDraft(QUOTE, st)).toContain(inr(24000) + ' kg');
    });
});

describe('freight enquiry weight gate — edge cases the gate has to survive', () => {
    test('no rows at all: not complete, not usable, zero weight, and a "0 items" draft', () => {
        const st = makeState({ rows: [] });
        expect(enqScopeRows(st)).toHaveLength(0);
        expect(enqUncountedRows(st)).toHaveLength(0);   // nothing missing — but nothing there either
        expect(enqScopeComplete(st)).toBe(false);
        expect(enqWeightUsable(st)).toBe(false);
        expect(enqEffectiveWeight(st)).toBe(0);
        const draft = buildEnquiryDraft(QUOTE, st);
        expect(draft).toContain('• Weight: ____ kg');
        expect(draft).toContain('(0 items)');
    });

    test('qty null (the quote carried no quantity) blocks the weight just like a missing kg/m', () => {
        const st = makeState();
        st.rows[1].qty = null;
        expect(enqUncountedRows(st)).toHaveLength(1);
        expect(enqUncountedRows(st)[0].id).toBe('r2');
        expect(enqScopeComplete(st)).toBe(false);
        expect(enqWeightUsable(st)).toBe(false);
    });

    test('qty 0 is a real, deliberate value — it counts and does NOT block the enquiry', () => {
        const st = makeState({
            rows: [
                { id: 'z', sec: 1, d: 'spare', qty: 0, kgm: 7.39, removed: false },
                { id: 'r1', sec: 1, d: '2" NB X Heavy -- ERW', qty: 500, kgm: 7.39, removed: false },
            ],
        });
        expect(enqUncountedRows(st)).toHaveLength(0);
        expect(enqScopeComplete(st)).toBe(true);
        expect(enqWeightUsable(st)).toBe(true);
        expect(enqEffectiveWeight(st)).toBe(3695);
    });

    test('a soft-deleted (removed) row is out of scope entirely — it cannot block or count', () => {
        const st = makeIncompleteState();
        st.rows[2].removed = true;

        expect(enqScopeRows(st)).toHaveLength(2);
        expect(enqUncountedRows(st)).toHaveLength(0);
        expect(enqScopeComplete(st)).toBe(true);
        expect(enqWeightUsable(st)).toBe(true);
        expect(enqEffectiveWeight(st)).toBe(PARTIAL_WEIGHT);   // the remaining two rows only
        expect(buildEnquiryDraft(QUOTE, st)).toContain('2 items)');
    });

    test('the enquiry is never more trusting than the on-screen panel (secComplete parity)', () => {
        const incomplete = makeIncompleteState();
        expect(secComplete(incomplete, 1)).toBe(false);
        expect(enqScopeComplete(incomplete)).toBe(false);

        const complete = makeState();
        expect(secComplete(complete, 1)).toBe(true);
        expect(enqScopeComplete(complete)).toBe(true);
    });
});

describe('freight enquiry weight gate — split-shipment scoping', () => {
    function makeSplitState() {
        return {
            rows: [
                { id: 'a1', sec: 1, d: '2" NB X Heavy -- ERW', qty: 500, kgm: 0, removed: false },
                { id: 'b1', sec: 2, d: '2" NB X Heavy -- GI', qty: 1000, kgm: 7.39, removed: false },
                { id: 'b2', sec: 2, d: '4" NB X Sch 40', qty: 800, kgm: 14.25, removed: false },
            ],
            split: true,
            enquiry: { forSec: 2, weightOverride: null },
        };
    }

    test('"Request freight" on shipment 2 scopes to shipment 2 only', () => {
        const st = makeSplitState();
        expect(enqScopeRows(st).map(function (r) { return r.id; })).toEqual(['b1', 'b2']);
        expect(enqScopeWeight(st)).toBe(18790);            // 7,390 + 11,400
        expect(enqScopeWeight(st)).toBe(FULL_WEIGHT - 3695);   // the whole load, less shipment 1
    });

    test("shipment 1's missing kg/m does not block a complete shipment 2", () => {
        const st = makeSplitState();
        expect(enqScopeComplete(st)).toBe(true);
        expect(enqWeightUsable(st)).toBe(true);
        expect(enqEffectiveWeight(st)).toBe(18790);
        expect(buildEnquiryDraft(QUOTE, st)).toContain('• Weight: ' + inr(18790) + ' kg (18.79 T, 2 items)');
    });

    test('scoping to the incomplete shipment 1 shuts the gate again', () => {
        const st = makeSplitState();
        st.enquiry.forSec = 1;
        expect(enqScopeRows(st).map(function (r) { return r.id; })).toEqual(['a1']);
        expect(enqUncountedRows(st)).toHaveLength(1);
        expect(enqWeightUsable(st)).toBe(false);
        expect(buildEnquiryDraft(QUOTE, st)).toContain('• Weight: ____ kg (1 item)');
    });

    test('forSec is ignored when the panel is not split — the enquiry covers everything', () => {
        const st = makeSplitState();
        st.split = false;
        expect(enqScopeRows(st).map(function (r) { return r.id; })).toEqual(['a1', 'b1', 'b2']);
        expect(enqWeightUsable(st)).toBe(false);   // a1 has no kg/m, and it is back in scope
    });

    test('forSec 0 (the whole-load enquiry) covers both shipments even while split', () => {
        const st = makeSplitState();
        st.enquiry.forSec = 0;
        expect(enqScopeRows(st)).toHaveLength(3);
        expect(enqScopeComplete(st)).toBe(false);
    });
});

// =============================================================================
// Minimal HTML document shim — test scaffolding only.
// jsdom is not installed, and sanitizeEmailHtmlForPreview needs a real document
// (createElement + innerHTML + querySelectorAll + replaceWith). This is just enough
// DOM for the REAL sanitizer to run unmodified over the fixtures below.
// =============================================================================
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

function escSerText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escSerAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function decodeEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function FakeText(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
}
FakeText.prototype.toHtml = function () { return escSerText(this.data); };
FakeText.prototype.remove = function () { detachNode(this); };
Object.defineProperty(FakeText.prototype, 'textContent', { get: function () { return this.data; } });

function FakeElement(tag) {
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = [];
    this.childNodes = [];
    this.parentNode = null;
}
function detachNode(node) {
    const p = node.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(node);
    if (i >= 0) p.childNodes.splice(i, 1);
    node.parentNode = null;
}
FakeElement.prototype.remove = function () { detachNode(this); };
FakeElement.prototype.replaceWith = function (node) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i < 0) return;
    node.parentNode = p;
    p.childNodes.splice(i, 1, node);
    this.parentNode = null;
};
FakeElement.prototype.removeAttribute = function (name) {
    const lower = String(name).toLowerCase();
    this.attributes = this.attributes.filter(function (a) { return a.name.toLowerCase() !== lower; });
};
FakeElement.prototype.getAttribute = function (name) {
    const lower = String(name).toLowerCase();
    const hit = this.attributes.filter(function (a) { return a.name.toLowerCase() === lower; })[0];
    return hit ? hit.value : null;
};
FakeElement.prototype.appendChild = function (node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
};
FakeElement.prototype.querySelectorAll = function (selector) {
    const wanted = String(selector).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    const all = [];
    (function walk(n) {
        n.childNodes.forEach(function (c) {
            if (c.nodeType !== 1) return;
            all.push(c);
            walk(c);
        });
    })(this);
    if (wanted.indexOf('*') >= 0) return all;   // static, document-order list, like the real one
    return all.filter(function (el) { return wanted.indexOf(el.localName) >= 0; });
};
FakeElement.prototype.toHtml = function () {
    const attrs = this.attributes.map(function (a) { return ' ' + a.name + '="' + escSerAttr(a.value) + '"'; }).join('');
    if (VOID_TAGS.has(this.localName)) return '<' + this.localName + attrs + '>';
    return '<' + this.localName + attrs + '>'
        + this.childNodes.map(function (c) { return c.toHtml(); }).join('')
        + '</' + this.localName + '>';
};
Object.defineProperty(FakeElement.prototype, 'textContent', {
    get: function () {
        return this.childNodes.map(function (c) { return c.textContent; }).join('');
    },
});
Object.defineProperty(FakeElement.prototype, 'innerHTML', {
    get: function () { return this.childNodes.map(function (c) { return c.toHtml(); }).join(''); },
    set: function (value) { parseHtmlInto(this, String(value == null ? '' : value)); },
});

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
function parseAttributes(el, text) {
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(text))) {
        let value = m[2] == null ? '' : m[2];
        if (/^["']/.test(value)) value = value.slice(1, -1);
        el.attributes.push({ name: m[1], value: decodeEntities(value) });
    }
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
function parseHtmlInto(root, source) {
    root.childNodes = [];
    const stack = [root];
    const top = function () { return stack[stack.length - 1]; };
    const addText = function (text) { if (text) top().appendChild(new FakeText(decodeEntities(text))); };
    let last = 0;
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(source))) {
        if (m.index > last) addText(source.slice(last, m.index));
        last = TAG_RE.lastIndex;
        const name = m[2].toLowerCase();
        const raw = m[3] || '';
        if (m[1] === '/') {
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].localName === name) { stack.length = i; break; }
            }
            continue;
        }
        const el = new FakeElement(name);
        parseAttributes(el, raw);
        top().appendChild(el);
        if (RAW_TEXT_TAGS.has(name)) {
            // <script>/<style> hold raw text, not markup — consume to the closing tag.
            const rest = source.slice(last);
            const close = rest.match(new RegExp('</' + name + '\\s*>', 'i'));
            const body = close ? rest.slice(0, close.index) : rest;
            if (body) el.appendChild(new FakeText(body));
            last += body.length + (close ? close[0].length : 0);
            TAG_RE.lastIndex = last;
            continue;
        }
        if (!VOID_TAGS.has(name) && !/\/\s*$/.test(raw)) stack.push(el);
    }
    if (last < source.length) addText(source.slice(last));
}

const fakeDocument = {
    createElement: function (tag) { return new FakeElement(tag); },
    createTextNode: function (text) { return new FakeText(text); },
};

// Sanity-check the scaffolding itself before trusting anything it reports.
describe('DOM shim sanity (test scaffolding, not shipped code)', () => {
    test('round-trips markup, finds nodes and swaps them', () => {
        const d = fakeDocument.createElement('div');
        d.innerHTML = '<p class="a">Hi <b>there</b></p><br>';
        expect(d.innerHTML).toBe('<p class="a">Hi <b>there</b></p><br>');
        expect(d.textContent).toBe('Hi there');
        expect(d.querySelectorAll('*').map(function (n) { return n.tagName; })).toEqual(['P', 'B', 'BR']);
        d.querySelectorAll('b').forEach(function (n) { n.replaceWith(fakeDocument.createTextNode('THERE')); });
        expect(d.innerHTML).toBe('<p class="a">Hi THERE</p><br>');
    });

    test('script bodies are raw text and are removable', () => {
        const d = fakeDocument.createElement('div');
        d.innerHTML = '<div>keep</div><script>if (1 < 2) alert("x")</script>';
        d.querySelectorAll('script, style, link, meta').forEach(function (n) { n.remove(); });
        expect(d.innerHTML).toBe('<div>keep</div>');
    });
});

// =============================================================================
// 2. SHARED ENQUIRY SECTION — buildSharedEnquiryHtml (index.html)
// =============================================================================
const buildSharedEnquiryHtml = loadFns(
    html,
    ['escapeHtml', 'sanitizeEmailHtmlForPreview', 'buildSharedEnquiryHtml'],
    fakeDocument
);

describe('buildSharedEnquiryHtml — the customer enquiry on the shared quote page', () => {
    const ENQUIRY_HTML = '<div><h2>Enquiry</h2><p>Please quote for the below.</p>'
        + '<table><tr><th>Size</th><th>Qty</th></tr>'
        + '<tr><td onclick="steal()">2" NB Heavy</td><td>500 mtr</td></tr></table>'
        + '<script>alert(1)</script></div>';

    test('an HTML enquiry keeps its table', () => {
        const out = buildSharedEnquiryHtml({ emailContentHtml: ENQUIRY_HTML });
        expect(out).toContain('class="sq-enq"');
        expect(out).toContain('<table>');
        expect(out).toContain('<td>2" NB Heavy</td>');
        expect(out).toContain('500 mtr');
        expect(out).toContain('Please quote for the below.');
        // Rendered as markup, not escaped into visible angle brackets.
        expect(out).not.toContain('&lt;table');
    });

    test('...but loses <script> and on* handlers', () => {
        const out = buildSharedEnquiryHtml({ emailContentHtml: ENQUIRY_HTML });
        expect(out).not.toContain('<script');
        expect(out).not.toContain('alert(1)');
        expect(out).not.toContain('onclick');
        expect(out).not.toContain('steal()');
    });

    test('a disallowed tag is flattened to its text, never dropped silently', () => {
        const out = buildSharedEnquiryHtml({ emailContentHtml: ENQUIRY_HTML });
        expect(out).not.toContain('<h2');
        expect(out).toContain('Enquiry');   // the heading's words survive as text
    });

    test('an <a href="javascript:"> inside the enquiry body cannot survive as a link', () => {
        const out = buildSharedEnquiryHtml({
            emailContentHtml: '<p>See <a href="javascript:alert(1)">this</a></p>',
        });
        expect(out).not.toContain('<a ');
        expect(out).not.toContain('javascript:');
        expect(out).toContain('See this');
    });

    test('a plain-text enquiry is escaped and shown with white-space:pre-wrap', () => {
        const out = buildSharedEnquiryHtml({
            emailContent: 'Need 500 m of 2" pipe\nRate please\n<b>urgent</b>',
        });
        expect(out).toContain('white-space:pre-wrap');
        expect(out).toContain('&lt;b&gt;urgent&lt;/b&gt;');
        expect(out).toContain('&quot;');
        expect(out).not.toContain('<b>urgent</b>');
        expect(out).toContain('Rate please');
    });

    test('the HTML version wins over the plain text when both are stored', () => {
        const out = buildSharedEnquiryHtml({
            emailContentHtml: '<p>rich version</p>',
            emailContent: 'plain version',
        });
        expect(out).toContain('rich version');
        expect(out).not.toContain('plain version');
    });

    test('"View in Gmail" appears for an http(s) emailLink', () => {
        const link = 'https://mail.google.com/mail/u/0/#inbox/FMfcgz123';
        const out = buildSharedEnquiryHtml({ emailContent: 'hello', emailLink: link });
        expect(out).toContain('&#128231; View in Gmail');
        expect(out).toContain('href="' + link + '"');
        expect(out).toContain('rel="noopener noreferrer"');

        const plainHttp = buildSharedEnquiryHtml({ emailContent: 'hello', emailLink: 'http://mail.example.com/t/1' });
        expect(plainHttp).toContain('View in Gmail');
    });

    test('REGRESSION: a "javascript:" emailLink is NOT rendered as a link', () => {
        const out = buildSharedEnquiryHtml({
            emailContent: 'hello',
            emailLink: 'javascript:alert(document.cookie)',
        });
        expect(out).not.toContain('<a ');
        expect(out).not.toContain('View in Gmail');
        expect(out).not.toContain('javascript:');
        expect(out).toContain('hello');   // the enquiry itself still renders
    });

    test('a non-URL emailLink is ignored rather than linked', () => {
        const out = buildSharedEnquiryHtml({ emailContent: 'hello', emailLink: 'see my inbox' });
        expect(out).not.toContain('<a ');
        expect(out).not.toContain('View in Gmail');
    });

    test('a quote with no enquiry at all gets the empty state, not a blank card', () => {
        expect(buildSharedEnquiryHtml({})).toContain('No enquiry email stored for this quote.');
        expect(buildSharedEnquiryHtml(null)).toContain('No enquiry email stored for this quote.');
        expect(buildSharedEnquiryHtml({ emailContent: '   ', emailContentHtml: '' }))
            .toContain('No enquiry email stored for this quote.');
    });

    test('the empty state still shows "View in Gmail" when there is a link', () => {
        const out = buildSharedEnquiryHtml({ emailLink: 'https://mail.google.com/mail/u/0/#inbox/x' });
        expect(out).toContain('View in Gmail');
        expect(out).toContain('No enquiry email stored for this quote.');
    });

    test('REGRESSION: a NUMBER in emailContent does not throw (".trim is not a function")', () => {
        let out;
        expect(function () { out = buildSharedEnquiryHtml({ emailContent: 12345 }); }).not.toThrow();
        expect(out).toContain('12345');
        expect(out).toContain('white-space:pre-wrap');
    });

    test('a number in emailContentHtml / emailLink is survivable too', () => {
        expect(function () { buildSharedEnquiryHtml({ emailContentHtml: 42 }); }).not.toThrow();
        expect(function () { buildSharedEnquiryHtml({ emailLink: 99, emailContent: 'x' }); }).not.toThrow();
        expect(buildSharedEnquiryHtml({ emailLink: 99, emailContent: 'x' })).not.toContain('<a ');
    });
});

// =============================================================================
// 3. MONTH-NAME SEARCH — getMonthIndexFromDateText (index.html)
// =============================================================================
const getMonthIndexFromDateText = loadFns(html, [
    'normalizeSearchText',
    'approvalMonthOf',
    'getMonthIndexFromDateText',
]);

describe('getMonthIndexFromDateText — reading the month off a quote date', () => {
    // Pin the platform behaviour that caused the bug, so the reason for the fix stays visible.
    test('the defect it fixes: new Date() reads DD.MM.YY as MM.DD.YY (or not at all)', () => {
        expect(new Date('05.03.26').getMonth()).toBe(4);      // May, not March
        expect(new Date('15.03.26').getTime()).toBeNaN();     // Invalid Date
    });

    test('REGRESSION: every March date resolves to March (index 2), whatever the day', () => {
        expect(getMonthIndexFromDateText('05.03.26')).toBe(2);
        expect(getMonthIndexFromDateText('15.03.26')).toBe(2);
        expect(getMonthIndexFromDateText('01.03.26')).toBe(2);
        expect(getMonthIndexFromDateText('31.03.26')).toBe(2);
    });

    test('other months, including days past the 12th that used to match nothing', () => {
        expect(getMonthIndexFromDateText('12.11.25')).toBe(10);   // November
        expect(getMonthIndexFromDateText('31.07.26')).toBe(6);    // July
        expect(getMonthIndexFromDateText('01.08.26')).toBe(7);    // August
        expect(getMonthIndexFromDateText('09.01.26')).toBe(0);    // January
        expect(getMonthIndexFromDateText('25.12.25')).toBe(11);   // December
    });

    test('slash and dash separators, and four-digit years, read the same way', () => {
        expect(getMonthIndexFromDateText('15/03/2026')).toBe(2);
        expect(getMonthIndexFromDateText('15-03-2026')).toBe(2);
        expect(getMonthIndexFromDateText('31.07.2026')).toBe(6);
    });

    test('an ISO timestamp still works', () => {
        expect(getMonthIndexFromDateText('2026-07-14T10:00:00.000Z')).toBe(6);
        expect(getMonthIndexFromDateText('2025-11-02T00:00:00.000Z')).toBe(10);
    });

    test('a written month name still works, and still wins', () => {
        expect(getMonthIndexFromDateText('March 2026')).toBe(2);
        expect(getMonthIndexFromDateText('14 August 2026')).toBe(7);
        expect(getMonthIndexFromDateText('  DECEMBER  ')).toBe(11);
    });

    test('garbage returns -1 rather than a wrong month', () => {
        expect(getMonthIndexFromDateText('hello world')).toBe(-1);
        expect(getMonthIndexFromDateText('n/a')).toBe(-1);
        expect(getMonthIndexFromDateText('')).toBe(-1);
        expect(getMonthIndexFromDateText(null)).toBe(-1);
        expect(getMonthIndexFromDateText(undefined)).toBe(-1);
        expect(getMonthIndexFromDateText('01.13.26')).toBe(-1);   // impossible month, not guessed
    });
});

// =============================================================================
// 4. SEARCH NORMALISER PARITY — client vs routes/quotations.js
// =============================================================================
const normalizeSearchText = loadFns(html, ['normalizeSearchText']);
const matchesApprovalSearch = loadFns(html, [
    'normalizeSearchText',
    'approvalMonthOf',
    'getMonthIndexFromToken',
    'getMonthIndexFromDateText',
    'doesMonthMatchQuery',
    'matchesApprovalSearch',
]);
// The real server-side rule, extracted from the shipped route file — not a copy of it.
const normalizeSearchQuery = loadFns(routeSrc, ['normalizeSearchQuery']);
const quoteSummaryMatches = loadFns(routeSrc, ['normalizeSearchQuery', 'quoteSummaryMatches']);

describe('normalizeSearchText — must match the server rule exactly', () => {
    const CASES = [
        'Acme  Pipes',
        'Acme\tPipes',
        'Acme\nPipes',
        '   Acme   Pipes   Ltd   ',
        'ACME PIPES',
        '',
        null,
        undefined,
        12345,
        '  ',
        'a\r\n b',
    ];

    test.each(CASES.map(function (v) { return [JSON.stringify(v) || String(v), v]; }))(
        'client and server agree on %s',
        (_label, value) => {
            expect(normalizeSearchText(value)).toBe(normalizeSearchQuery(value));
        }
    );

    test('the specific rules: lowercase, collapse whitespace runs, trim the ends', () => {
        expect(normalizeSearchText('  Acme   Pipes  ')).toBe('acme pipes');
        expect(normalizeSearchText('Acme\t\nPipes')).toBe('acme pipes');
        expect(normalizeSearchText(null)).toBe('');
        expect(normalizeSearchText(undefined)).toBe('');
        expect(normalizeSearchText('')).toBe('');
        expect(normalizeSearchText(12345)).toBe('12345');
    });
});

describe('matchesApprovalSearch — the client must not hide what the server found', () => {
    // Bill-to is EMPTY. Joining the fields without dropping the blank left a DOUBLE space
    // between company and contact on the client, so a query spanning the two matched the
    // server's haystack and missed here — the merged-in quote vanished, leaving a blank panel.
    const QUOTE_NO_BILLTO = {
        companyName: 'Acme Pipes',
        projectName: '',
        customerName: 'Ravi Kumar',
        quoteNumber: 'DSC-142',
        quotationDate: '15.03.26',
    };

    test('REGRESSION: a query spanning company + contact matches with an empty bill-to', () => {
        const query = 'acme pipes ravi';
        expect(matchesApprovalSearch(QUOTE_NO_BILLTO, query)).toBe(true);
        // And the server agrees — that agreement is the whole point.
        expect(quoteSummaryMatches(QUOTE_NO_BILLTO, normalizeSearchQuery(query))).toBe(true);
    });

    test('the same query with untidy spacing matches on both sides', () => {
        const query = '  Acme   Pipes   Ravi  ';
        expect(matchesApprovalSearch(QUOTE_NO_BILLTO, query)).toBe(true);
        expect(quoteSummaryMatches(QUOTE_NO_BILLTO, normalizeSearchQuery(query))).toBe(true);
    });

    test('client and server give the same verdict across a spread of queries', () => {
        const quotes = [
            QUOTE_NO_BILLTO,
            { companyName: 'Bharat Steel', projectName: 'Metro Line', customerName: 'Asha', quoteNumber: 'DSC-201' },
            { companyName: 'Bharat Steel', projectName: '', customerName: '', quoteNumber: 'DSC-202' },
            { companyName: '', projectName: '', customerName: '', quoteNumber: 'DSC-203' },
        ];
        const queries = ['acme', 'acme pipes ravi', 'bharat steel metro', 'bharat steel asha',
            'dsc-202', 'bharat steel dsc-202', 'nothing here'];
        quotes.forEach(function (q) {
            queries.forEach(function (query) {
                expect(matchesApprovalSearch(q, query))
                    .toBe(quoteSummaryMatches(q, normalizeSearchQuery(query)));
            });
        });
    });

    test('an empty query matches everything (the unfiltered list)', () => {
        expect(matchesApprovalSearch(QUOTE_NO_BILLTO, '')).toBe(true);
        expect(matchesApprovalSearch(QUOTE_NO_BILLTO, '   ')).toBe(true);
    });

    test('a month-name query still falls through to the quote date', () => {
        expect(matchesApprovalSearch(QUOTE_NO_BILLTO, 'march')).toBe(true);
        expect(matchesApprovalSearch(QUOTE_NO_BILLTO, 'may')).toBe(false);
    });
});

// =============================================================================
// 5. SOURCE GUARDS — fixes too DOM-bound / network-bound to execute
// =============================================================================
describe('source guard: Approve only claims success once the write landed', () => {
    const fn = extractFunction(html, 'saveQuotation');

    test('it awaits the backend result', () => {
        expect(fn).toContain('const ok = await saveQuotationToBackend(quotation);');
    });

    test('it remembers the prior flags so a failure can be rolled back', () => {
        expect(fn).toContain('const priorEverApproved = quotation.everApproved;');
        expect(fn).toContain('const priorBaseline = quotation.revisionBaseline;');
        expect(fn).toContain('if (priorEverApproved === undefined) delete quotation.everApproved;');
        expect(fn).toContain('else quotation.everApproved = priorEverApproved;');
    });

    test('a failed write un-approves the quote so the badge and send gate tell the truth', () => {
        const fail = fn.slice(fn.indexOf('if (!ok) {'));
        expect(fail).toContain('quotation.saved = false;');
        expect(fail).toContain('quotation.hasUnsavedEdits = true;');
        expect(fail).toMatch(/alert\('Could not approve/);
    });

    test('REGRESSION: the success alert sits AFTER the await, inside the same function', () => {
        const awaitAt = fn.indexOf('const ok = await saveQuotationToBackend(quotation);');
        const alertAt = fn.indexOf("alert('Quotation saved as file: '");
        expect(awaitAt).toBeGreaterThan(-1);
        expect(alertAt).toBeGreaterThan(-1);
        expect(alertAt).toBeGreaterThan(awaitAt);
        // ...and it is guarded by the early return on failure, so it cannot fire alongside
        // the "Failed to save" box the way it used to.
        const failReturn = fn.indexOf('return;', fn.indexOf('if (!ok) {'));
        expect(failReturn).toBeGreaterThan(-1);
        expect(alertAt).toBeGreaterThan(failReturn);
    });
});

describe('source guard: a failed "Save as Revision" restores the revision state', () => {
    const fn = extractFunction(html, 'saveQuotationChanges');

    test('the revision state is snapshotted before the revision is committed', () => {
        expect(fn).toContain('var revisionUndo = askedForRevision ? {');
        ['revisions', 'revisionCount', 'revised', 'revisionBaseline', 'lastSentSnapshot'].forEach(function (k) {
            expect(fn).toContain(k + ':');
        });
        const undoAt = fn.indexOf('var revisionUndo =');
        const commitAt = fn.indexOf('createRevisionFromBaseline(quotation)');
        expect(undoAt).toBeGreaterThan(-1);
        expect(commitAt).toBeGreaterThan(undoAt);
    });

    test('it is restored on a failed save, so retrying makes ONE revision, not a second', () => {
        const fail = fn.slice(fn.indexOf('if (!ok) {'));
        expect(fail).toContain('if (revisionUndo) {');
        expect(fail).toContain('else quotation.revisions = revisionUndo.revisions;');
        expect(fail).toContain('else quotation.revisionCount = revisionUndo.revisionCount;');
        expect(fail).toContain('else quotation.revisionBaseline = revisionUndo.revisionBaseline;');
        expect(fail).toContain('quotation.hasUnsavedEdits = true;');
        expect(fail).toMatch(/alert\('The revision was NOT saved/);
    });

    test('the restore runs after the awaited backend call', () => {
        const awaitAt = fn.indexOf('const ok = await saveQuotationToBackend(quotation);');
        const restoreAt = fn.indexOf('if (revisionUndo) {');
        expect(awaitAt).toBeGreaterThan(-1);
        expect(restoreAt).toBeGreaterThan(awaitAt);
    });
});

describe('source guard: an unknown baseline is no longer called the "Sent version"', () => {
    const fn = extractFunction(html, 'createRevisionFromBaseline');

    test('it marks the baseline unverified and labels it honestly', () => {
        expect(fn).toContain('unverifiedBaseline');
        expect(fn).toContain("'Version before this revision'");
        expect(fn).toContain('var unverified = !baseline;');
    });

    test('REGRESSION: it never snapshots the current state as the "Sent version"', () => {
        expect(fn).not.toContain("buildRevisionSnapshotData(quotation, 'Sent version')");
    });

    test('the History caveat explains that the sent figures were not recorded', () => {
        expect(fn).toContain('the exact figures the customer received were not recorded');
    });
});

describe('source guard: the Revision button pulses only when it should', () => {
    const fn = extractFunction(html, 'updateApprovalRevisionCount');

    test('pulse on = pending asks AND the Revision filter is off', () => {
        expect(fn).toContain("classList.toggle('rev-nudge', n > 0 && !approvalRevisionFilter)");
    });

    test('the animation exists in the stylesheet', () => {
        expect(html).toContain('@keyframes revNudge');
        expect(html).toMatch(/\.rev-nudge\s*\{\s*animation:\s*revNudge/);
    });

    test('and is switched off for anyone who prefers reduced motion', () => {
        expect(html).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]{0,120}\.rev-nudge\s*\{\s*animation:\s*none;/);
    });

    test('the count badge itself is hidden at zero (a "0" badge reads as a nag)', () => {
        expect(fn).toContain("el.style.display = n > 0 ? 'inline-block' : 'none';");
    });
});

describe('source guard: adding a revision ask always gives visible feedback', () => {
    const fn = extractFunction(html, 'addRevisionRequest');

    test('the count is updated directly, not left to the suppressed list re-render', () => {
        expect(fn).toContain('updateApprovalRevisionCount();');
    });

    test('REGRESSION: it falls back to rerenderRevisionStrip when the re-render is suppressed', () => {
        expect(fn).toContain('if (!refreshApprovalListPreservingEdits()) rerenderRevisionStrip(');
        const countAt = fn.indexOf('updateApprovalRevisionCount();');
        const fallbackAt = fn.indexOf('if (!refreshApprovalListPreservingEdits()) rerenderRevisionStrip(');
        expect(countAt).toBeGreaterThan(-1);
        expect(fallbackAt).toBeGreaterThan(countAt);
    });

    test('a revision ask and a plain note go to different places', () => {
        expect(fn).toContain('quotation.extraNotes.push(result.entry);');
        expect(fn).toContain('quotation.revisionRequests.push(result.entry);');
    });
});

describe('source guard: sending clears the asks through the dedicated route', () => {
    const clearFn = extractFunction(html, 'clearRevisionRequestsOnServer');
    const sendFn = extractFunction(html, 'sendQuotationToCustomer');

    test('the clear goes to /revision-requests-done, not the whole-object save', () => {
        expect(clearFn).toContain('/revision-requests-done');
        expect(clearFn).toContain("method: 'POST'");
    });

    test('it is called from the send-success path', () => {
        expect(sendFn).toContain('clearRevisionRequestsOnServer(quotation.id);');
        const sentAt = sendFn.indexOf('quotation.sent = true;');
        const clearAt = sendFn.indexOf('clearRevisionRequestsOnServer(quotation.id);');
        expect(sentAt).toBeGreaterThan(-1);
        expect(clearAt).toBeGreaterThan(sentAt);
    });

    test('the on-screen asks are marked done too, and the card is re-rendered', () => {
        expect(sendFn).toContain('const revisionsCleared = markRevisionRequestsDone(quotation);');
        expect(sendFn).toContain('if (revisionsCleared) refreshApprovalListPreservingEdits();');
    });
});
