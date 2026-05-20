/**
 * Quick test: Approval list "Load more" pagination.
 * Usage: TEST_URL=http://127.0.0.1:3002 node tools/load-more-test.mjs
 */
import { chromium } from 'playwright';

const base = process.env.TEST_URL || 'http://127.0.0.1:3002';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(base, { waitUntil: 'networkidle', timeout: 120000 });

// Wait for initial load
await page.waitForFunction(() => typeof window.approvedQuotations !== 'undefined', { timeout: 60000 });
await page.waitForTimeout(2000);

const before = await page.evaluate(() => ({
    count: window.approvedQuotations?.length ?? 0,
    hasMore: typeof approvedQuotationsHasMore !== 'undefined' ? approvedQuotationsHasMore : null,
    offset: typeof approvedQuotationsOffset !== 'undefined' ? approvedQuotationsOffset : null,
    btnVisible: (() => {
        const b = document.getElementById('loadMoreApprovedBtn');
        return b && b.style.display !== 'none' && !b.disabled;
    })(),
    folderCount: document.querySelectorAll('#approvedQuotationsContainer .quotation-folder').length,
}));

console.log('BEFORE load more:', before);

const btn = page.locator('#loadMoreApprovedBtn');
if (!(await btn.isVisible())) {
    console.error('Load more button not visible — cannot test click');
    await browser.close();
    process.exit(1);
}

await btn.click();
await page.waitForTimeout(5000);

const after = await page.evaluate(() => ({
    count: window.approvedQuotations?.length ?? 0,
    hasMore: approvedQuotationsHasMore,
    offset: approvedQuotationsOffset,
    folderCount: document.querySelectorAll('#approvedQuotationsContainer .quotation-folder').length,
}));

console.log('AFTER load more:', after);

const ok = after.count > before.count && after.folderCount > before.folderCount;
console.log(ok ? 'PASS: loaded more quotations' : 'FAIL: count did not increase');

// Search active: button hidden, list empty, load more blocked
await page.fill('#approvalSearchInput', 'zzznomatch');
await page.waitForTimeout(300);
const searchState = await page.evaluate(() => ({
    btnDisplay: document.getElementById('loadMoreApprovedBtn').style.display,
    folders: document.querySelectorAll('#approvedQuotationsContainer .quotation-folder').length,
    msg: document.getElementById('noApprovedSearchMatches')?.textContent?.trim() || '',
}));
console.log('search state', searchState);
const searchOk = searchState.btnDisplay === 'none' && searchState.folders === 0 && searchState.msg.includes('No quotations match');
console.log(searchOk ? 'PASS: search hides load more' : 'FAIL: search UX');

await browser.close();
process.exit(ok && searchOk ? 0 : 1);
