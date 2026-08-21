/**
 * @jest-environment node
 *
 * tests/register.test.js
 *
 * The in-app Enquiry Register (📊 tool) — niche/edge cases.
 *
 * Server side (routes/quotations.js _test): the register window resolver
 * (?from/?to vs ?month vs fallback), status derivation, and row shaping.
 * Client side: pure helpers extracted from register.js by brace-matching
 * (same approach as tests/revision-signature.test.js) — day differences,
 * value/date formatting, month-label parsing and local month bounds.
 */

const fs = require('fs');
const path = require('path');

const { registerRangeOf, registerStatusOf, registerRowOf } = require('../routes/quotations')._test;

const src = fs.readFileSync(path.join(__dirname, '..', 'register.js'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf('function ' + name);
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

function loadFns(names) {
    const body = names.map(n => extractFunction(src, n)).join('\n')
        // parseLabel/monthLabelOf reference the MONTHS constant
        .replace(/^/, "var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];\n");
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn ' + names[names.length - 1] + ';')();
}

const daysBetween = loadFns(['sundayMsBetween', 'daysBetween']);
const fmtValue = loadFns(['fmtValue']);
const fmtDay = loadFns(['fmtDay']);
const parseLabel = loadFns(['parseLabel']);
const monthBoundsOf = loadFns(['parseLabel', 'monthBoundsOf']);
const escFn = loadFns(['esc']);

// ─── Server: window resolution ────────────────────────────────────────────────

describe('registerRangeOf — how the register window is chosen', () => {
    test('exact from/to bounds win (the in-app view sends local month edges)', () => {
        const r = registerRangeOf({ from: '2026-06-30T18:30:00.000Z', to: '2026-07-31T18:30:00.000Z' });
        expect(r).toEqual({ start: '2026-06-30T18:30:00.000Z', end: '2026-07-31T18:30:00.000Z' });
    });
    test('from >= to is rejected (falls through to month / days)', () => {
        expect(registerRangeOf({ from: '2026-07-31', to: '2026-07-01' })).toBeNull();
        expect(registerRangeOf({ from: '2026-07-01', to: '2026-07-01' })).toBeNull();
    });
    test('garbage from/to falls back to ?month', () => {
        const r = registerRangeOf({ from: 'zzz', to: 'zzz', month: '2026-07' });
        expect(r.start).toBe('2026-07-01T00:00:00.000Z');
        expect(r.end).toBe('2026-08-01T00:00:00.000Z');
    });
    test('December rolls into the next year', () => {
        const r = registerRangeOf({ month: '2026-12' });
        expect(r.end).toBe('2027-01-01T00:00:00.000Z');
    });
    test('invalid months are rejected: 13, 00, malformed, absent', () => {
        expect(registerRangeOf({ month: '2026-13' })).toBeNull();
        expect(registerRangeOf({ month: '2026-00' })).toBeNull();
        expect(registerRangeOf({ month: 'garbage' })).toBeNull();
        expect(registerRangeOf({})).toBeNull();
    });
});

describe('registerStatusOf — precedence of the five statuses', () => {
    test('REGRET beats everything', () => {
        expect(registerStatusOf({ adminStatus: 'regretted', sent: true, revised: true })).toBe('REGRET');
    });
    test('sent overrides awaiting margin (a sent quote is Sent, not pending)', () => {
        expect(registerStatusOf({ adminStatus: 'awaiting', sent: true })).toBe('SENT');
        expect(registerStatusOf({ adminStatus: 'awaiting', sent: true, revised: true })).toBe('REVISION SENT');
        expect(registerStatusOf({ adminStatus: 'awaiting', sent: false })).toBe('MARGIN ALLOCATION PENDING');
    });
    test('REVISION SENT needs both revised and sent', () => {
        expect(registerStatusOf({ sent: true, revised: true })).toBe('REVISION SENT');
        expect(registerStatusOf({ revised: true })).toBe('PENDING');   // revised but never sent
        expect(registerStatusOf({ sent: true })).toBe('SENT');
    });
    test('empty quote is PENDING', () => {
        expect(registerStatusOf({})).toBe('PENDING');
    });
});

describe('registerRowOf — row shaping survives sparse quotes', () => {
    test('an entirely empty quote produces safe blanks', () => {
        const r = registerRowOf({});
        expect(r).toMatchObject({ id: '', quoteNumber: '', enquiryDate: '', status: 'PENDING', checkedBy: '', sentDate: '', value: '', registerMeta: {} });
    });
    test('maps checkedBy / sentAt / grandTotal and stringifies numeric ids', () => {
        const r = registerRowOf({ id: 1783593483622, checkedBy: 'PAVI', sentAt: '2026-07-21T12:39:15.100Z', grandTotal: '2268656' });
        expect(r.id).toBe('1783593483622');
        expect(r.checkedBy).toBe('PAVI');
        expect(r.sentDate).toBe('2026-07-21T12:39:15.100Z');
        expect(r.value).toBe('2268656');
    });
    test('non-object registerMeta is normalized to {}', () => {
        expect(registerRowOf({ registerMeta: 'oops' }).registerMeta).toEqual({});
        expect(registerRowOf({ registerMeta: null }).registerMeta).toEqual({});
    });
    test('enquiryDate falls back from createdAt to updatedAt', () => {
        expect(registerRowOf({ updatedAt: '2026-07-01T00:00:00Z' }).enquiryDate).toBe('2026-07-01T00:00:00Z');
        expect(registerRowOf({ createdAt: 'a', updatedAt: 'b' }).enquiryDate).toBe('a');
    });
});

// ─── Client: pure helpers ─────────────────────────────────────────────────────

describe('daysBetween — Recd → Sent difference', () => {
    test('same local calendar day is 0 even across hours', () => {
        expect(daysBetween('2026-07-21T09:00:00', '2026-07-21T18:00:00')).toBe('0');
    });
    // Whole 24-HOUR periods, not calendar days — the user asked for elapsed time, so an enquiry
    // answered overnight is 0 days rather than the 1 a calendar comparison reported.
    test('counts whole 24h blocks, not calendar days', () => {
        // 23:00 to 01:00 next day = 2 hours: a new calendar day, but nowhere near a day elapsed
        expect(daysBetween('2026-07-21T23:00:00', '2026-07-22T01:00:00')).toBe('0');
        // 17:00 Monday to 09:00 Tuesday = 16 hours
        expect(daysBetween('2026-07-27T17:00:00', '2026-07-28T09:00:00')).toBe('0');
        // 25 hours is the first full day
        expect(daysBetween('2026-07-27T09:00:00', '2026-07-28T10:00:00')).toBe('1');
    });

    // Sunday hours are deducted — the office is shut, so a Sunday must not count against the
    // team. SATURDAYS ARE WORKED and still count in full.
    test('a Sunday in the middle is not counted', () => {
        // Friday 09:00 -> Monday 09:00 is 72 elapsed hours, one full day of which is a Sunday.
        expect(daysBetween('2026-07-31T09:00:00', '2026-08-03T09:00:00')).toBe('2');
    });

    test('Saturday still counts in full', () => {
        expect(daysBetween('2026-07-31T09:00:00', '2026-08-01T09:00:00')).toBe('1');   // Fri -> Sat
    });

    test('only the Sunday PART of a span is removed, not the whole day it touches', () => {
        // Sat 09:00 -> Sun 09:00 is 24h, but 9 of those fall on Sunday: 15h left, so 0 days.
        expect(daysBetween('2026-08-01T09:00:00', '2026-08-02T09:00:00')).toBe('0');
        // Sat 09:00 -> Mon 09:00 is 48h minus a whole Sunday = 24h.
        expect(daysBetween('2026-08-01T09:00:00', '2026-08-03T09:00:00')).toBe('1');
    });

    test('a full week loses exactly one day', () => {
        expect(daysBetween('2026-07-27T09:00:00', '2026-08-03T09:00:00')).toBe('6');   // Mon -> Mon
    });

    test('a long span loses one day per Sunday it crosses', () => {
        // Mon 1 Jun -> Mon 29 Jun 2026 is 28 days spanning 4 Sundays.
        expect(daysBetween('2026-06-01T09:00:00', '2026-06-29T09:00:00')).toBe('24');
    });
    test('spans month and year boundaries', () => {
        expect(daysBetween('2026-06-29T10:00:00', '2026-07-02T10:00:00')).toBe('3');
        expect(daysBetween('2025-12-31T10:00:00', '2026-01-02T10:00:00')).toBe('2');
    });
    test('blank until sent, blank on invalid dates', () => {
        expect(daysBetween('2026-07-21T10:00:00Z', '')).toBe('');
        expect(daysBetween('', '2026-07-21T10:00:00Z')).toBe('');
        expect(daysBetween('garbage', '2026-07-21')).toBe('');
    });
    test('a sent-before-received anomaly shows as negative (visible, not hidden)', () => {
        expect(daysBetween('2026-07-21T10:00:00', '2026-07-20T10:00:00')).toBe('-1');
    });
});

describe('fmtValue — Value column formatting', () => {
    test('Indian grouping', () => {
        expect(fmtValue('2268656')).toBe('₹22,68,656');
    });
    test('existing commas are tolerated', () => {
        expect(fmtValue('2,268,656')).toBe('₹22,68,656');
    });
    test('zero, blank, junk → empty cell', () => {
        expect(fmtValue('0')).toBe('');
        expect(fmtValue('')).toBe('');
        expect(fmtValue(null)).toBe('');
        expect(fmtValue('abc')).toBe('');
    });
});

describe('fmtDay — sheet-style d.m.yy', () => {
    test('formats and blanks invalid input', () => {
        expect(fmtDay('2026-07-01T10:00:00')).toBe('1.7.26');
        expect(fmtDay('nonsense')).toBe('');
        expect(fmtDay('')).toBe('');
    });
});

describe('parseLabel / monthBoundsOf — month+year navigation', () => {
    test('round-trips a label', () => {
        expect(parseLabel('JUL 26')).toEqual({ monthIndex: 6, year: 2026 });
        expect(parseLabel('DEC 24')).toEqual({ monthIndex: 11, year: 2024 });
    });
    test('malformed labels are null (no crash)', () => {
        expect(parseLabel('JULY 26')).toBeNull();
        expect(parseLabel('')).toBeNull();
        expect(parseLabel('JUL')).toBeNull();
    });
    test('bounds cover exactly one local month, December rolling the year', () => {
        const b = monthBoundsOf('DEC 26');
        const from = new Date(b.from), to = new Date(b.to);
        expect(from.getFullYear()).toBe(2026);
        expect(from.getMonth()).toBe(11);
        expect(from.getDate()).toBe(1);
        expect(to.getFullYear()).toBe(2027);
        expect(to.getMonth()).toBe(0);
    });
});

describe('esc — register cells are XSS-safe', () => {
    test('escapes markup in company names and typed values', () => {
        expect(escFn('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(escFn('"quoted" & <b>')).toBe('&quot;quoted&quot; &amp; &lt;b&gt;');
    });
});

// ─── Source guards ────────────────────────────────────────────────────────────

describe('source guard — register wiring', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    test('month + year dropdowns exist and call pickMonthYear', () => {
        expect(html).toContain('id="registerMonthSelect"');
        expect(html).toContain('id="registerYearSelect"');
        expect(html).toContain('enquiryRegister.pickMonthYear()');
    });
    test('the fetch sends local month bounds (from/to)', () => {
        expect(src).toContain("'/enquiry-register?from='");
        expect(src).toContain('monthBoundsOf(label)');
    });
    test('merged day cells still render via rowspan', () => {
        expect(src).toContain('rowspan="');
        expect(src).toContain('reg-merged');
    });
});

// ── Reported from the register: a waiting revision was invisible ──────────────────────

describe('registerStatusOf — an outstanding revision ask outranks Sent', () => {
    const ask = (done) => ({ revisionRequests: [{ text: 'cost to cost', done: !!done }] });

    test('a quote with an open ask reads REVISION PENDING, not SENT', () => {
        // It HAS gone to the customer, but the desk has since asked for a change, so the row's
        // live state is that we owe them a new version. Reporting it as Sent hid pending work.
        expect(registerStatusOf(Object.assign({ sent: true }, ask(false)))).toBe('REVISION PENDING');
    });

    test('it beats REVISION SENT and MARGIN ALLOCATION PENDING too', () => {
        expect(registerStatusOf(Object.assign({ sent: true, revised: true }, ask(false)))).toBe('REVISION PENDING');
        expect(registerStatusOf(Object.assign({ adminStatus: 'awaiting' }, ask(false)))).toBe('REVISION PENDING');
    });

    test('REGRET still beats it — a regretted quote is closed', () => {
        expect(registerStatusOf(Object.assign({ adminStatus: 'regretted', sent: true }, ask(false)))).toBe('REGRET');
    });

    test('once the ask is done the row goes back to its normal status', () => {
        expect(registerStatusOf(Object.assign({ sent: true }, ask(true)))).toBe('SENT');
        expect(registerStatusOf(Object.assign({ sent: true, revised: true }, ask(true)))).toBe('REVISION SENT');
    });

    test('no asks at all changes nothing', () => {
        expect(registerStatusOf({ sent: true })).toBe('SENT');
        expect(registerStatusOf({ revisionRequests: [] , sent: true })).toBe('SENT');
        expect(registerStatusOf({ revisionRequests: 'oops', sent: true })).toBe('SENT');
    });
});

describe('source guards — the reported bugs stay fixed', () => {
    const html2 = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const registerSrc = fs.readFileSync(path.join(__dirname, '..', 'register.js'), 'utf8');

    test('the revision box takes MULTIPLE lines — prompt() cannot', () => {
        // window.prompt is single-line by construction: Enter submits it, so a revision ask that
        // is really a list could only be typed as one run-on line.
        const fn = html2.slice(html2.indexOf('async function addRevisionRequest('));
        const body = fn.slice(0, fn.indexOf('\n        }'));
        expect(body).toContain('await promptMultiline(');
        expect(body).not.toMatch(/[^.\w]prompt\(/);
        expect(html2).toContain('function promptMultiline(');
        expect(html2).toContain('<textarea');
    });

    test('a multi-line ask actually renders as multiple lines on the card', () => {
        expect(html2).toMatch(/\.rev-ask-text \{[^}]*white-space: pre-wrap/);
    });

    test('the register colours REVISION PENDING as work owed, not as done', () => {
        expect(registerSrc).toContain("'REVISION PENDING': 'q-awaiting'");
    });

    test('an admin note whose markup got escaped is decoded before printing', () => {
        expect(html2).toContain('function decodeEscapedNoteMarkup(');
        expect(html2).toContain('sanitizeRichNoteHtml(decodeEscapedNoteMarkup(');
    });
});

describe('source guards — the revision box is rich text, and safely rendered', () => {
    const html3 = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

    test('the revision dialog offers a rich editor, not just a textarea', () => {
        expect(html3).toContain("class=\"pm-rich\" contenteditable=\"true\"");
        expect(html3).toContain('.pm-rich {');
        const fn = html3.slice(html3.indexOf('async function addRevisionRequest('));
        expect(fn.slice(0, fn.indexOf('\n        }'))).toContain('rich: true');
    });

    test('what the editor produces is sanitised BEFORE it is stored', () => {
        // Storing already-safe HTML means a renderer that forgets to sanitise still cannot
        // publish a script tag onto the public Copy Link page.
        const fn = html3.slice(html3.indexOf('function promptMultiline('));
        expect(fn.slice(0, 3000)).toContain('sanitizeRichNoteHtml(raw)');
    });

    test('both render sites go through revisionTextHtml, never raw stored markup', () => {
        expect(html3).toContain("'<span class=\"rev-ask-text\">' + revisionTextHtml(entry && entry.text)");
        expect(html3).toContain("'<span class=\"sq-msg-text\">' + revisionTextHtml(entry && entry.text)");
        // No render site may inject the stored text unescaped and unsanitised.
        expect(html3).not.toContain("'<span class=\"sq-msg-text\">' + (entry && entry.text)");
    });

    test('an empty rich editor cannot be saved as a revision', () => {
        expect(html3).toContain('function hasVisibleRichText(');
        const fn = html3.slice(html3.indexOf('async function addRevisionRequest('));
        expect(fn.slice(0, fn.indexOf('\n        }'))).toContain('hasVisibleRichText(text)');
    });

    test('a pasted table survives into the card and the shared page', () => {
        expect(html3).toMatch(/\.rev-ask-text table[^{]*\{[^}]*border-collapse/);
        expect(html3).toMatch(/\.pm-rich table[^{]*\{[^}]*border-collapse/);
    });
});

// ── Reported: a table pasted into the note rendered AS the quotation table ────────────
//
// sanitizeEmailHtmlForPreview keeps class and id — correct for a customer's email, where a
// stranger's class names match nothing of ours. Our own markup is the opposite case: paste a
// copy of the quotation table into a note and our stylesheet re-dresses it as a live table,
// complete with an "Enter Section Name" bar and dead buttons. Duplicated ids are worse than
// ugly, because getElementById can then find the pasted copy instead of the real control.

describe('source guard — pasted notes are stripped of our own UI hooks', () => {
    const html4 = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const fn = html4.slice(html4.indexOf('function sanitizeRichNoteHtml('));
    const body = fn.slice(0, fn.indexOf('\n        }'));

    test('class and id are removed', () => {
        expect(body).toContain("box.querySelectorAll('[class], [id]')");
        expect(body).toContain("el.removeAttribute('class')");
        expect(body).toContain("el.removeAttribute('id')");
    });

    test('buttons are dropped whole, BEFORE the tag sanitiser turns them into stray words', () => {
        // sanitizeEmailHtmlForPreview replaces an unknown tag with its text, which left the
        // copied toolbar behind as the words "+ H+ M+ Delete" inside the note.
        expect(body).toContain("pre.querySelectorAll('button')");
        expect(body.indexOf('.remove(); })')).toBeLessThan(body.indexOf('sanitizeEmailHtmlForPreview(pre.innerHTML'));
    });

    test('but value-carrying controls are CONVERTED, never deleted', () => {
        // On our screens the cell values live inside input/textarea, not as text. Deleting them
        // alongside the buttons took the whole table's data with it — an early cut of this fix
        // did exactly that, leaving a pasted quote table as nothing but its column headings.
        expect(body).toContain("pre.querySelectorAll('input, textarea, select')");
        expect(body).toContain('el.replaceWith(document.createTextNode(value));');
        expect(body).not.toContain("querySelectorAll('button, input, select, option, textarea')");
    });

    test('it does NOT call itself — the first cut accidentally recursed', () => {
        // Now passes { allowImages: true } — a note may hold a pasted screenshot; the email
        // preview must NOT set it, or a sender's remote pixels would load inside the app.
        expect(body).toContain('sanitizeEmailHtmlForPreview(pre.innerHTML, { allowImages: true })');
        expect(body).not.toContain('const clean = sanitizeRichNoteHtml(');
    });

    test('every note and revision path uses it; the EMAIL preview deliberately does not', () => {
        // A customer's email should keep its own styling hooks — only our own screens are the risk.
        expect(html4).toContain('sanitizeRichNoteHtml(decodeEscapedNoteMarkup(');       // admin note render
        expect(html4).toContain('sanitizeRichNoteHtml(raw)');                            // revision render
        expect(html4).toContain('const clean = sanitizeRichNoteHtml(html);');            // note paste
        expect(html4).toContain('sanitizeRichNoteHtml(pasted)');                         // revision-dialog paste
        expect(html4).toContain('sanitizeEmailHtmlForPreview(quotation.emailContentHtml)');
    });
});

// ── Pasting a screenshot into a note or a revision ask ────────────────────────────────
//
// The bytes must never reach the quote record: a screenshot is 100 KB-2 MB, base64 inflates
// it by a third, and DynamoDB caps an ITEM at 400 KB — an inline data: URI would break the
// quote it was pasted into, and a browser's own blob: URL dies on the next page load. So the
// file is uploaded and only a short same-origin URL is stored.
//
// The sanitiser rules are DOM-bound (jsdom is not installed), so they are guarded here and
// were exercised for real in a browser: our stored image survives; remote, data:, javascript:,
// srcset and onerror are all rejected; and the customer-email preview still strips images.

describe('source guard — note images are uploaded, never inlined', () => {
    const fsI = require('fs');
    const pathI = require('path');
    const htmlI = fsI.readFileSync(pathI.join(__dirname, '..', 'index.html'), 'utf8') + '\n' + fsI.readFileSync(pathI.join(__dirname, '..', 'styles.css'), 'utf8');
    const routesI = fsI.readFileSync(pathI.join(__dirname, '..', 'routes', 'quotations.js'), 'utf8');

    test('there is an upload route, and it guards size, type and path traversal', () => {
        expect(routesI).toContain("router.post('/quotations/:id/note-image'");
        expect(routesI).toMatch(/MAX_NOTE_IMAGE_BYTES = 3 \* 1024 \* 1024/);
        expect(routesI).toContain('NOTE_IMAGE_EXT');
        // Same traversal guard the PDF archive uses — nothing under /api is auth-gated.
        expect(routesI).toMatch(/note-images\/' \+ safeStorageSegment\(req\.params\.id\)/);
    });

    test('the key sits under enquiries/ so the existing file route can serve it unchanged', () => {
        expect(routesI).toContain("'enquiries/note-images/'");
        const rates = fsI.readFileSync(pathI.join(__dirname, '..', 'routes', 'rates.js'), 'utf8');
        expect(rates).toContain("!key.includes('enquiries')");   // the check the prefix satisfies
    });

    test('the image is downscaled before upload, under the Vercel request cap', () => {
        expect(htmlI).toContain('NOTE_IMAGE_MAX_DIM');
        expect(htmlI).toContain('function downscaleImageFile(');
        expect(htmlI).toContain("canvas.toDataURL('image/png')");
    });

    test('BOTH paste handlers catch an image before falling through to the HTML path', () => {
        // A screenshot arrives as a FILE. If the HTML path ran first the browser would insert a
        // blob: URL, which dies on the next page load.
        const noteFn = htmlI.slice(htmlI.indexOf('function mdkNotePaste('));
        expect(noteFn.slice(0, 600)).toContain('handleImagePaste(e, id,');
        const dialog = htmlI.slice(htmlI.indexOf('function promptMultiline('));
        expect(dialog.slice(0, 4000)).toContain('handleImagePaste(e, o.quoteId,');
        // …and the revision dialog is told which quote the image belongs to.
        const addRev = htmlI.slice(htmlI.indexOf('async function addRevisionRequest('));
        expect(addRev.slice(0, 1200)).toContain('quoteId: quotationId');
    });

    test('only OUR stored images are allowed to render', () => {
        expect(htmlI).toContain('function isOwnStoredImageSrc(');
        // A same-origin path to our own file route, nothing else: an absolute URL on the public
        // Copy Link page is a tracking pixel that leaks the viewer's IP.
        //
        // Asserted on the whole function body, not just "the rule appears somewhere". Merely
        // checking the regex is present passed happily when an early `return true` was inserted
        // above it — the check was still in the file, just unreachable. The single-return shape
        // is what makes the rule load-bearing.
        const srcFn = htmlI.slice(htmlI.indexOf('function isOwnStoredImageSrc('));
        const srcBody = srcFn.slice(0, srcFn.indexOf('\n        }'));
        expect(srcBody.match(/return\b/g) || []).toHaveLength(1);
        expect(srcBody).toMatch(/return \/\^\\\/api\\\/view-enquiry-file\\\?\/\.test\(s\);/);
        // IMG attributes are whitelisted, not blacklisted — srcset would be a back door.
        expect(htmlI).toContain("if (attr.name.toLowerCase() !== 'src') node.removeAttribute(attr.name);");
    });

    test('images are allowed in NOTES only — never in a customer email preview', () => {
        // Inbound mail is third-party content; allowing its images would load a sender's
        // remote pixels inside the app.
        expect(htmlI).toContain('sanitizeEmailHtmlForPreview(pre.innerHTML, { allowImages: true })');
        expect(htmlI).toContain('sanitizeEmailHtmlForPreview(quotation.emailContentHtml)');
        expect(htmlI).toMatch(/const allowImages = !!\(opts && opts\.allowImages\);/);
        expect(htmlI).toContain("if (allowImages) allowedTags.add('IMG');");
    });

    test('a pasted image cannot blow out the layout wherever it is shown', () => {
        expect(htmlI).toMatch(/\.pm-rich img, \.rev-ask-text img, \.sq-msg-text img[^{]*\{[^}]*max-width: 100%/);
    });
});
