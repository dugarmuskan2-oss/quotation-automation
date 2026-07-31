/**
 * @jest-environment node
 *
 * tests/approval-filters.test.js
 *
 * The approval list's month/year + freight filters (index.html):
 *   - approvalMonthOf / quoteMonthClient — one quote -> 'YYYY-MM'. These must cope with
 *     the app's own DD.MM.YY quotation-date format, which new Date() cannot parse; the
 *     fall-through in quoteMonthClient is the regression that made a quote created in
 *     this session (no createdAt yet) invisible while a month was picked.
 *   - quoteHasFreightActivityClient — "a freight enquiry was sent for this quote".
 *     Deliberately matches an entry whose threadId is '' (a genuine send whose response
 *     carried no thread id) but NOT an empty freightEnquiries array.
 *   - approvalFilterLabel / approvalFilteredEmptyHtml — the loading / fetch-failed /
 *     genuinely-empty messages.
 *   - getFilteredApprovedQuotations — freight overrides month, search applies on top.
 *   - initApprovalFilters — the dropdowns open on a blank "All months" option so the app
 *     starts UNFILTERED and picking any real month always fires its onchange.
 *
 * All of the above live inline in the browser-only SPA, so they are extracted by name and
 * eval'd together with their REAL dependencies (escapeHtml, normalizeSearchText,
 * doesMonthMatchQuery, matchesApprovalSearch, APPROVAL_MONTHS/APPROVAL_MNAMES) — no inline
 * reimplementations. The module-level `let`s the filters read (approvedQuotations,
 * approvalMonthFilter, approvalFreightFilter, approvalFilterLoading,
 * approvalFilterFetchFailed) are declared inside the factory from a `state` object, and a
 * state() getter reads back what initApprovalFilters wrote.
 *
 * The rest is too DOM-bound / network-bound to execute, so it gets source guards:
 * the "Load more" visibility rules, the render-time recompute, the append de-duplication,
 * the soft-delete guard in BOTH server merge loops, the stale-request sequence guard, and
 * the unfiltered startup.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

// Pull a top-level function out of source by brace-matching (keeps a leading `async`).
function extractFunction(src, name) {
    let start = src.indexOf('function ' + name);
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

// Pull a single-line top-level `const NAME = ...;` out of source.
function extractConst(src, name) {
    const start = src.indexOf('const ' + name + ' =');
    if (start === -1) throw new Error('const not found: ' + name);
    const end = src.indexOf('\n', start);
    return src.slice(start, end).trim();
}

const FILTER_FNS = [
    'escapeHtml',
    'normalizeSearchText',
    'getMonthIndexFromToken',
    'getMonthIndexFromDateText',
    'doesMonthMatchQuery',
    'matchesApprovalSearch',
    'approvalMonthOf',
    'quoteMonthClient',
    'quoteHasFreightActivityClient',
    'approvalFilterLabel',
    'approvalFilteredEmptyHtml',
    'getFilteredApprovedQuotations',
    'updateApprovalFilterButtons',
    'approvalResetMonthSelect',
    'initApprovalFilters',
    // Revision asks: the filter reads these, and updateApprovalFilterButtons refreshes the count.
    'revisionRequestsOf',
    'openRevisionRequests',
    'quoteNeedsRevisionClient',
    'approvalRevisionCount',
    'updateApprovalRevisionCount',
];

/**
 * Build the real filter functions over a given filter state. `st` seeds the module-level
 * `let`s; `document` is only touched by initApprovalFilters / updateApprovalFilterButtons.
 */
function loadFilters(st, fakeDocument) {
    const prelude = [
        'var approvedQuotations = st.approvedQuotations || [];',
        'var approvalMonthFilter = st.approvalMonthFilter || "";',
        'var approvalFreightFilter = !!st.approvalFreightFilter;',
        'var approvalRevisionFilter = !!st.approvalRevisionFilter;',
        // The empty-state message names the search term when one is active, so it must be seeded.
        'var approvalSearchQuery = st.approvalSearchQuery || "";',
        'var approvalFilterLoading = !!st.approvalFilterLoading;',
        'var approvalFilterFetchFailed = !!st.approvalFilterFetchFailed;',
        extractConst(html, 'APPROVAL_MONTHS'),
        extractConst(html, 'APPROVAL_MNAMES'),
    ].join('\n');
    const body = FILTER_FNS.map(function (n) { return extractFunction(html, n); }).join('\n');
    const exported = 'return {'
        + 'approvalMonthOf: approvalMonthOf,'
        + 'quoteMonthClient: quoteMonthClient,'
        + 'quoteHasFreightActivityClient: quoteHasFreightActivityClient,'
        + 'approvalFilterLabel: approvalFilterLabel,'
        + 'approvalFilteredEmptyHtml: approvalFilteredEmptyHtml,'
        + 'getFilteredApprovedQuotations: getFilteredApprovedQuotations,'
        + 'initApprovalFilters: initApprovalFilters,'
        + 'quoteNeedsRevisionClient: quoteNeedsRevisionClient,'
        + 'approvalRevisionCount: approvalRevisionCount,'
        + 'state: function () { return { approvalMonthFilter: approvalMonthFilter, approvalFreightFilter: approvalFreightFilter }; }'
        + '};';
    // eslint-disable-next-line no-new-func
    const factory = new Function('st', 'document', prelude + '\n' + body + '\n' + exported);
    return factory(st || {}, fakeDocument || null);
}

// =============================================================================
// approvalMonthOf — one date value -> 'YYYY-MM'
// =============================================================================
describe('approvalMonthOf — date value to YYYY-MM', () => {
    const approvalMonthOf = loadFilters({}).approvalMonthOf;

    test('ISO timestamp', () => {
        expect(approvalMonthOf('2026-07-14T10:00:00.000Z')).toBe('2026-07');
        expect(approvalMonthOf('2025-12-31T23:00:00.000Z')).toBe('2025-12');
    });

    test("the app's own DD.MM.YY quotation-date format", () => {
        // new Date() cannot parse this at all — the dedicated regex is why it works.
        expect(new Date('31.07.26').getTime()).toBeNaN();
        expect(approvalMonthOf('31.07.26')).toBe('2026-07');
        expect(approvalMonthOf('1.1.26')).toBe('2026-01');
    });

    test('DD.MM.YYYY, and slash / dash separators', () => {
        expect(approvalMonthOf('31.07.2026')).toBe('2026-07');
        expect(approvalMonthOf('14/07/2026')).toBe('2026-07');
        expect(approvalMonthOf('14-07-2026')).toBe('2026-07');
        expect(approvalMonthOf('09/03/25')).toBe('2025-03');
    });

    test('an impossible month (13 or 0) is rejected rather than guessed', () => {
        expect(approvalMonthOf('01.13.26')).toBe('');
        expect(approvalMonthOf('01.00.26')).toBe('');
    });

    test('empty, null and undefined give ""', () => {
        expect(approvalMonthOf('')).toBe('');
        expect(approvalMonthOf(null)).toBe('');
        expect(approvalMonthOf(undefined)).toBe('');
    });

    test('garbage gives "" instead of throwing', () => {
        expect(approvalMonthOf('hello world')).toBe('');
        expect(approvalMonthOf('n/a')).toBe('');
        expect(approvalMonthOf('--')).toBe('');
    });
});

// =============================================================================
// quoteMonthClient — which of a quote's date fields decides its month
// =============================================================================
describe('quoteMonthClient — picking the quote month', () => {
    const quoteMonthClient = loadFilters({}).quoteMonthClient;

    // quotationDate wins so the month a quote is filed under always matches the date printed
    // ON the quote. Bucketing on createdAt's UTC slice filed a quote saved between midnight and
    // 05:30 IST on the 1st under the previous month, while its own date read the new one.
    test('prefers the printed quotationDate over createdAt', () => {
        expect(quoteMonthClient({
            createdAt: '2026-06-10T00:00:00.000Z',
            quotationDate: '31.07.26',
            updatedAt: '2026-05-01T00:00:00.000Z',
        })).toBe('2026-07');
    });

    test('falls back to createdAt when there is no quotation date', () => {
        expect(quoteMonthClient({
            createdAt: '2026-06-10T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
        })).toBe('2026-06');
    });

    test('REGRESSION: falls through to quotationDate when createdAt is absent', () => {
        // A quote created in this session has no createdAt yet — only a DD.MM.YY
        // quotationDate. Stopping at the unparseable createdAt made it invisible
        // the moment a month was picked.
        expect(quoteMonthClient({ quotationDate: '31.07.26' })).toBe('2026-07');
        expect(quoteMonthClient({ createdAt: '', quotationDate: '31.07.26' })).toBe('2026-07');
        expect(quoteMonthClient({ createdAt: 'not a date', quotationDate: '31.07.26' })).toBe('2026-07');
    });

    test('falls through again to updatedAt', () => {
        expect(quoteMonthClient({
            createdAt: '',
            quotationDate: 'n/a',
            updatedAt: '2026-05-01T00:00:00.000Z',
        })).toBe('2026-05');
    });

    test('returns "" when nothing parses, and for a missing quote', () => {
        expect(quoteMonthClient({})).toBe('');
        expect(quoteMonthClient({ createdAt: 'x', quotationDate: 'y', updatedAt: 'z' })).toBe('');
        expect(quoteMonthClient(null)).toBe('');
        expect(quoteMonthClient(undefined)).toBe('');
    });
});

// =============================================================================
// quoteHasFreightActivityClient — "a freight enquiry was sent for this quote"
// =============================================================================
describe('quoteHasFreightActivityClient — freight filter membership', () => {
    const quoteHasFreightActivityClient = loadFilters({}).quoteHasFreightActivityClient;

    test('an entry with a threadId counts', () => {
        expect(quoteHasFreightActivityClient({ freightEnquiries: [{ threadId: 'thr_1' }] })).toBe(true);
    });

    test('an entry with an EMPTY threadId still counts', () => {
        // A genuinely sent enquiry stores '' when the send response carried no thread
        // id; requiring threadId used to make those quotes invisible here.
        expect(quoteHasFreightActivityClient({ freightEnquiries: [{ threadId: '' }] })).toBe(true);
        expect(quoteHasFreightActivityClient({ freightEnquiries: [{ to: 'vrl@x.com' }] })).toBe(true);
    });

    test('a replied / finished entry counts too — replied state is not considered', () => {
        expect(quoteHasFreightActivityClient({
            freightEnquiries: [{ threadId: 'thr_2', replied: true, status: 'finished' }],
        })).toBe(true);
    });

    test('transporterReplyIn alone counts, with no freightEnquiries at all', () => {
        expect(quoteHasFreightActivityClient({ transporterReplyIn: 'VRL Logistics' })).toBe(true);
        expect(quoteHasFreightActivityClient({ transporterReplyIn: true, freightEnquiries: [] })).toBe(true);
    });

    test('an EMPTY freightEnquiries array does NOT count (box opened, nothing sent)', () => {
        expect(quoteHasFreightActivityClient({ freightEnquiries: [] })).toBe(false);
    });

    test('a missing field, a non-array and null do not count', () => {
        expect(quoteHasFreightActivityClient({})).toBe(false);
        expect(quoteHasFreightActivityClient({ freightEnquiries: 'yes' })).toBe(false);
        expect(quoteHasFreightActivityClient({ freightEnquiries: { threadId: 'x' } })).toBe(false);
        expect(quoteHasFreightActivityClient(null)).toBe(false);
        expect(quoteHasFreightActivityClient(undefined)).toBe(false);
    });
});

// =============================================================================
// approvalFilterLabel — human name for the active filter
// =============================================================================
describe('approvalFilterLabel', () => {
    test("a month filter reads as 'July 2026'", () => {
        expect(loadFilters({ approvalMonthFilter: '2026-07' }).approvalFilterLabel()).toBe('July 2026');
        expect(loadFilters({ approvalMonthFilter: '2025-01' }).approvalFilterLabel()).toBe('January 2025');
        expect(loadFilters({ approvalMonthFilter: '2026-12' }).approvalFilterLabel()).toBe('December 2026');
    });

    test("the freight filter reads as 'freight' and wins over a month", () => {
        expect(loadFilters({ approvalFreightFilter: true }).approvalFilterLabel()).toBe('freight');
        expect(loadFilters({ approvalFreightFilter: true, approvalMonthFilter: '2026-07' })
            .approvalFilterLabel()).toBe('freight');
    });

    test('no filter gives an empty label', () => {
        expect(loadFilters({}).approvalFilterLabel()).toBe('');
    });
});

// =============================================================================
// approvalFilteredEmptyHtml — loading / fetch-failed / genuinely-empty states
// =============================================================================
describe('approvalFilteredEmptyHtml', () => {
    test('the loading state names the month being fetched', () => {
        const h = loadFilters({ approvalMonthFilter: '2026-07', approvalFilterLoading: true })
            .approvalFilteredEmptyHtml();
        expect(h).toContain('Loading July 2026 quotes');
        expect(h).not.toContain('No quotes');
    });

    test('the fetch-failed state does NOT claim the month is empty, and offers Try again', () => {
        const h = loadFilters({ approvalMonthFilter: '2026-07', approvalFilterFetchFailed: true })
            .approvalFilteredEmptyHtml();
        expect(h).toContain('Could not load July 2026 quotes just now.');
        expect(h).not.toContain('No quotes');       // we never got an answer — don't state it as fact
        expect(h).toContain('>Try again</button>');
        expect(h).toContain('onclick="applyApprovalServerFilter()"');
    });

    test('the fetch-failed state beats the plain empty state, but loading beats both', () => {
        const failing = loadFilters({
            approvalMonthFilter: '2026-07',
            approvalFilterLoading: true,
            approvalFilterFetchFailed: true,
        }).approvalFilteredEmptyHtml();
        expect(failing).toContain('Loading July 2026 quotes');
        expect(failing).not.toContain('Try again');
    });

    test('the genuinely-empty month state says "No quotes for {month}."', () => {
        const h = loadFilters({ approvalMonthFilter: '2026-07' }).approvalFilteredEmptyHtml();
        expect(h).toContain('No quotes for July 2026.');
        expect(h).not.toContain('Try again');
    });

    test('the genuinely-empty freight state says "No quotes with a freight enquiry."', () => {
        const h = loadFilters({ approvalFreightFilter: true }).approvalFilteredEmptyHtml();
        expect(h).toContain('No quotes with a freight enquiry.');
    });
});

// =============================================================================
// getFilteredApprovedQuotations — month vs freight vs search
// =============================================================================
describe('getFilteredApprovedQuotations', () => {
    const junFreight = {
        id: 1, companyName: 'Acme Pipes', quoteNumber: 'DSC-108',
        createdAt: '2026-06-10T00:00:00.000Z', freightEnquiries: [{ threadId: 'thr_1' }],
    };
    const julPlain = {
        id: 2, companyName: 'Bharat Tubes', quoteNumber: 'DSC-109',
        createdAt: '2026-07-05T00:00:00.000Z', freightEnquiries: [],
    };
    const julFreight = {
        id: 3, companyName: 'Acme Pipes', quoteNumber: 'DSC-110',
        createdAt: '2026-07-20T00:00:00.000Z', transporterReplyIn: 'VRL Logistics',
    };
    const sessionQuote = {   // no createdAt yet — only the DD.MM.YY date
        id: 4, companyName: 'Fresh Co', quoteNumber: 'DSC-111', quotationDate: '31.07.26',
    };
    const all = [junFreight, julPlain, julFreight, sessionQuote];
    const ids = (list) => list.map((q) => q.id);

    test('no filter returns everything', () => {
        const api = loadFilters({ approvedQuotations: all });
        expect(ids(api.getFilteredApprovedQuotations(''))).toEqual([1, 2, 3, 4]);
    });

    test('the month filter selects by month (including a quote with only quotationDate)', () => {
        const api = loadFilters({ approvedQuotations: all, approvalMonthFilter: '2026-07' });
        expect(ids(api.getFilteredApprovedQuotations(''))).toEqual([2, 3, 4]);

        const june = loadFilters({ approvedQuotations: all, approvalMonthFilter: '2026-06' });
        expect(ids(june.getFilteredApprovedQuotations(''))).toEqual([1]);
    });

    test('the freight filter OVERRIDES an active month filter (freight spans all months)', () => {
        const api = loadFilters({
            approvedQuotations: all,
            approvalMonthFilter: '2026-07',
            approvalFreightFilter: true,
        });
        expect(ids(api.getFilteredApprovedQuotations(''))).toEqual([1, 3]);   // June one included
    });

    test('the search text applies on top of the month filter', () => {
        const api = loadFilters({ approvedQuotations: all, approvalMonthFilter: '2026-07' });
        expect(ids(api.getFilteredApprovedQuotations('acme'))).toEqual([3]);
        expect(ids(api.getFilteredApprovedQuotations('dsc-109'))).toEqual([2]);
        expect(ids(api.getFilteredApprovedQuotations('nothing here'))).toEqual([]);
    });

    test('the search text applies on top of the freight filter', () => {
        const api = loadFilters({ approvedQuotations: all, approvalFreightFilter: true });
        expect(ids(api.getFilteredApprovedQuotations('acme'))).toEqual([1, 3]);
        expect(ids(api.getFilteredApprovedQuotations('bharat'))).toEqual([]);
    });

    test('the source array is not mutated', () => {
        const api = loadFilters({ approvedQuotations: all, approvalMonthFilter: '2026-06' });
        api.getFilteredApprovedQuotations('acme');
        expect(all).toHaveLength(4);
        expect(ids(all)).toEqual([1, 2, 3, 4]);
    });
});

// =============================================================================
// initApprovalFilters — the app opens UNFILTERED
// =============================================================================
describe('initApprovalFilters — dropdowns open on a blank "All months"', () => {
    function fakeDoc() {
        const els = {
            approvalMonthSelect: { dataset: {}, innerHTML: '', value: 'stale', style: {} },
            approvalYearSelect: { dataset: {}, innerHTML: '', value: '', style: {} },
            approvalFreightBtn: { style: {} },
        };
        return { els: els, getElementById: function (id) { return els[id] || null; } };
    }

    test('builds the month list with a blank "All months" option first', () => {
        const doc = fakeDoc();
        loadFilters({}, doc).initApprovalFilters();
        const m = doc.els.approvalMonthSelect;
        expect(m.innerHTML.indexOf('<option value="">All months</option>')).toBe(0);
        expect(m.innerHTML).toContain('<option value="01">January</option>');
        expect(m.innerHTML).toContain('<option value="07">July</option>');
        expect(m.innerHTML).toContain('<option value="12">December</option>');
    });

    test('leaves no month selected, so picking any real month always fires onchange', () => {
        const doc = fakeDoc();
        loadFilters({}, doc).initApprovalFilters();
        expect(doc.els.approvalMonthSelect.value).toBe('');
        expect(doc.els.approvalYearSelect.value).toBe(String(new Date().getFullYear()));
        expect(doc.els.approvalMonthSelect.dataset.built).toBe('true');
    });

    test('clears both filters so the list opens on the latest quotes', () => {
        const doc = fakeDoc();
        const api = loadFilters({ approvalMonthFilter: '2026-01', approvalFreightFilter: true }, doc);
        api.initApprovalFilters();
        expect(api.state()).toEqual({ approvalMonthFilter: '', approvalFreightFilter: false });
    });

    test('is idempotent — a second call does not rebuild the dropdowns', () => {
        const doc = fakeDoc();
        const api = loadFilters({}, doc);
        api.initApprovalFilters();
        doc.els.approvalMonthSelect.value = '07';   // user picked July
        api.initApprovalFilters();
        expect(doc.els.approvalMonthSelect.value).toBe('07');   // not stomped back to ''
    });
});

// =============================================================================
// Source guards — logic that is too DOM-bound / network-bound to execute here
// =============================================================================
describe('index.html source guards — filter-aware "Load more" and merges', () => {
    const loadMoreFn = extractFunction(html, 'updateLoadMoreApprovedButton');
    const displayFn = extractFunction(html, 'displayAllApprovedQuotations');
    const loadFeedFn = extractFunction(html, 'loadQuotationsFromBackend');
    const serverFilterFn = extractFunction(html, 'applyApprovalServerFilter');
    const serverSearchFn = extractFunction(html, 'serverSearchApprovedQuotations');
    const initQuotationsFn = extractFunction(html, 'initQuotations');
    const initFiltersFn = extractFunction(html, 'initApprovalFilters');

    test('updateLoadMoreApprovedButton hides the feed button while a filter is active', () => {
        expect(loadMoreFn).toContain('!!(approvalMonthFilter || approvalFreightFilter || approvalRevisionFilter)');
        expect(loadMoreFn).toContain('if (filterActive && !approvalFilterFetchFailed)');
        const hideIdx = loadMoreFn.indexOf("loadMoreBtn.style.display = 'none';");
        const feedIdx = loadMoreFn.indexOf('approvedQuotationsHasMore ?');
        expect(hideIdx).toBeGreaterThan(-1);
        expect(feedIdx).toBeGreaterThan(hideIdx);   // the early return comes first
    });

    test('…but falls back to showing it when the filter fetch failed', () => {
        // approvalFilterFetchFailed short-circuits the hide, so feed paging keeps older
        // quotes reachable when the server filter could not answer.
        expect(loadMoreFn).toContain('!approvalFilterFetchFailed');
        expect(loadMoreFn).toContain("loadMoreBtn.style.display = approvedQuotationsHasMore ? 'inline-block' : 'none';");
    });

    test('displayAllApprovedQuotations recomputes the button on EVERY render', () => {
        const callIdx = displayFn.indexOf('updateLoadMoreApprovedButton();');
        expect(callIdx).toBeGreaterThan(-1);
        // Must run before every early return, or a filter change leaves a stale button.
        expect(callIdx).toBeLessThan(displayFn.indexOf('if (approvedQuotations.length === 0)'));
        expect(callIdx).toBeLessThan(displayFn.indexOf('approvalFilteredEmptyHtml()'));
    });

    test('loadQuotationsFromBackend de-duplicates on append', () => {
        // A filter/search can merge older quotes straight into the array; paging the feed
        // down to those same quotes must not append a second copy.
        expect(loadFeedFn).toContain('const alreadyHave = new Set(approvedQuotations.map(');
        expect(loadFeedFn).toContain('!alreadyHave.has(String(q.id))');
        const appendIdx = loadFeedFn.indexOf('if (append)');
        expect(appendIdx).toBeGreaterThan(-1);
        expect(loadFeedFn.indexOf('alreadyHave')).toBeGreaterThan(appendIdx);
    });

    test('BOTH server merge loops skip soft-deleted quotes', () => {
        expect(serverFilterFn).toContain('!f.deleted');
        expect(serverSearchFn).toContain('!f.deleted');
        // …and the feed loader drops them as well.
        expect(loadFeedFn).toContain('!q.deleted');
    });

    test('applyApprovalServerFilter guards against a superseded request', () => {
        expect(serverFilterFn).toContain('const mySeq = ++_approvalFilterSeq;');
        const catchIdx = serverFilterFn.indexOf('} catch (e) {');
        const finallyIdx = serverFilterFn.indexOf('} finally {');
        expect(catchIdx).toBeGreaterThan(-1);
        expect(finallyIdx).toBeGreaterThan(catchIdx);
        const tryPart = serverFilterFn.slice(0, catchIdx);
        const catchPart = serverFilterFn.slice(catchIdx, finallyIdx);
        const finallyPart = serverFilterFn.slice(finallyIdx);
        expect(tryPart).toContain('if (mySeq !== _approvalFilterSeq) return;');      // after the fetch
        expect(catchPart).toContain('if (mySeq !== _approvalFilterSeq) return;');    // in catch
        expect(finallyPart).toContain('if (mySeq === _approvalFilterSeq)');          // in finally
    });

    test('the module-level filter state the guards read still exists', () => {
        expect(html).toContain("let approvalMonthFilter = '';");
        expect(html).toContain('let approvalFreightFilter = false;');
        expect(html).toContain('let approvalFilterLoading = false;');
        expect(html).toContain('let approvalFilterFetchFailed = false;');
        expect(html).toContain('let _approvalFilterSeq = 0;');
    });

    test('the app starts unfiltered: initQuotations never calls applyApprovalServerFilter', () => {
        expect(initQuotationsFn).toContain('initApprovalFilters();');
        expect(initQuotationsFn).toContain('loadQuotationsFromBackend(false)');
        expect(initQuotationsFn).not.toContain('applyApprovalServerFilter');
        // …and the builder itself picks no month.
        expect(initFiltersFn).toContain('<option value="">All months</option>');
        expect(initFiltersFn).toContain("m.value = ''");
        expect(initFiltersFn).toContain("approvalMonthFilter = '';");
        expect(initFiltersFn).toContain('approvalFreightFilter = false;');
    });

    test('the filter controls are still wired to their handlers', () => {
        expect(html).toContain('onchange="approvalPickMonthYear()"');
        expect(html).toContain('onclick="approvalShowAllMonths()"');
        expect(html).toContain('onclick="approvalToggleFreight()"');
        // Freight clears the month pick (dropdown included); All-months clears everything.
        const toggle = extractFunction(html, 'approvalToggleFreight');
        expect(toggle).toContain("approvalMonthFilter = ''");
        expect(toggle).toContain('approvalResetMonthSelect();');
        expect(toggle).toContain('applyApprovalServerFilter();');
        const showAll = extractFunction(html, 'approvalShowAllMonths');
        expect(showAll).toContain('displayAllApprovedQuotations();');
        expect(showAll).not.toContain('applyApprovalServerFilter');   // no server call needed
    });
});
