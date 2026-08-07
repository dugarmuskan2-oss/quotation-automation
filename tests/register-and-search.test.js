/*
    Two server-side rules that decide whether a quote is FINDABLE:

      - the register files a quote under the date it displays, not the date we happened to
        ingest it (an enquiry that arrived late on the 31st belongs to that month);
      - the search box says you can search by month name, so the server has to honour that —
        matching only the loaded page made a partial list look complete.

    Both fail silently when wrong: nothing errors, a quote is simply absent.
*/
process.env.DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'test-table';

const { registerDateOf, registerRowOf, searchMonthIndex, quoteSummaryMatches, quoteMonth } =
    require('../routes/quotations')._test;

// ── Which date the register files a quote under ──────────────────────────────
describe('registerDateOf — the filing date is the date shown, not the ingest date', () => {
    test('the customer\'s own email time wins when we have it', () => {
        expect(registerDateOf({
            enquiryReceivedAt: '2026-07-31T18:40:00.000Z',
            createdAt: '2026-08-01T04:10:00.000Z',
        })).toBe('2026-07-31T18:40:00.000Z');
    });

    test('createdAt is the fallback when the email time was never captured', () => {
        expect(registerDateOf({ createdAt: '2026-08-01T04:10:00.000Z' })).toBe('2026-08-01T04:10:00.000Z');
    });

    test('updatedAt is the last resort', () => {
        expect(registerDateOf({ updatedAt: '2026-08-02T09:00:00.000Z' })).toBe('2026-08-02T09:00:00.000Z');
    });

    test('a quote with no dates at all yields an empty string, not undefined', () => {
        // An undefined here would compare false against BOTH window bounds and drop the row
        // from every month without a word.
        expect(registerDateOf({})).toBe('');
    });

    test('the row DISPLAYS the same date the window filters on', () => {
        // These drifting apart is the whole bug: an enquiry that arrived at 23:40 on 31 July but
        // was ingested on 1 August was filtered into August, then shown there dated 31 July —
        // missing from July's count entirely, and a stray row in August's.
        const q = {
            id: 7, quoteNumber: 'DSC-2265',
            enquiryReceivedAt: '2026-07-31T18:40:00.000Z',
            createdAt: '2026-08-01T04:10:00.000Z',
        };
        expect(registerRowOf(q).enquiryDate).toBe(registerDateOf(q));
    });

    test('a late-on-the-31st enquiry falls inside JULY under this rule', () => {
        const q = { enquiryReceivedAt: '2026-07-31T18:40:00.000Z', createdAt: '2026-08-01T04:10:00.000Z' };
        const julyStart = '2026-07-01T00:00:00.000Z';
        const augustStart = '2026-08-01T00:00:00.000Z';
        const filed = registerDateOf(q);
        expect(filed >= julyStart && filed < augustStart).toBe(true);
        // …and would have fallen into August under the old createdAt rule.
        expect(q.createdAt >= augustStart).toBe(true);
    });
});

// ── Month-name search ────────────────────────────────────────────────────────
describe('searchMonthIndex — the search box promises month names, so the server must know them', () => {
    test('a full month name resolves', () => {
        expect(searchMonthIndex('January')).toBe(0);
        expect(searchMonthIndex('august')).toBe(7);
        expect(searchMonthIndex('DECEMBER')).toBe(11);
    });

    test('a prefix resolves, matching what the client accepts', () => {
        expect(searchMonthIndex('jan')).toBe(0);
        expect(searchMonthIndex('sep')).toBe(8);
    });

    test('a month named among other words is still found', () => {
        expect(searchMonthIndex('august 2026')).toBe(7);
    });

    test('an ordinary search term is not a month', () => {
        expect(searchMonthIndex('tanfac')).toBe(-1);
        expect(searchMonthIndex('DSC-2265')).toBe(-1);
        expect(searchMonthIndex('')).toBe(-1);
    });
});

describe('quoteSummaryMatches — text still matches, and a month name reaches every quote', () => {
    const q = (over) => Object.assign({
        companyName: 'TANFAC Industries Limited',
        projectName: 'Cuddalore plant',
        customerName: 'Gunaseelan',
        quoteNumber: 'DSC-2265',
        quotationDate: '03.08.2026',
    }, over);

    test('a company search still works', () => {
        expect(quoteSummaryMatches(q(), 'tanfac', -1)).toBe(true);
    });

    test('a contact and a quote number still work', () => {
        expect(quoteSummaryMatches(q(), 'gunaseelan', -1)).toBe(true);
        expect(quoteSummaryMatches(q(), 'dsc-2265', -1)).toBe(true);
    });

    test('an unrelated term matches nothing', () => {
        expect(quoteSummaryMatches(q(), 'zzzznotathing', -1)).toBe(false);
    });

    test('"august" matches an August quote by its DATE, not its text', () => {
        expect(quoteMonth(q())).toBe('2026-08');
        expect(quoteSummaryMatches(q(), 'august', searchMonthIndex('august'))).toBe(true);
    });

    test('"august" does NOT match a July quote', () => {
        const july = q({ quotationDate: '15.07.2026' });
        expect(quoteSummaryMatches(july, 'august', searchMonthIndex('august'))).toBe(false);
    });

    test('a month name matches ACROSS years — the client filter does the same', () => {
        const lastYear = q({ quotationDate: '09.08.2025' });
        expect(quoteSummaryMatches(lastYear, 'august', searchMonthIndex('august'))).toBe(true);
    });

    test('a quote with no usable date is simply not a month match', () => {
        const undated = { companyName: 'X Ltd' };
        expect(quoteSummaryMatches(undated, 'august', searchMonthIndex('august'))).toBe(false);
    });

    test('the month branch cannot turn a nonsense query into a match-everything', () => {
        // searchMonthIndex must return -1 here; if it ever resolved, every quote in that month
        // would come back for a search that has nothing to do with dates.
        expect(quoteSummaryMatches(q(), 'zzzznotathing', searchMonthIndex('zzzznotathing'))).toBe(false);
    });
});
