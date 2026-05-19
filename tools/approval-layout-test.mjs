import { chromium } from 'playwright';
import { cleanupAutomatedTestQuotations } from './e2e-cleanup-lib.mjs';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });

await page.waitForTimeout(2000);
const result = await page.evaluate(async () => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  await new Promise((r) => setTimeout(r, 1500));
  const folders = document.querySelectorAll('.quotation-folder');
  if (!folders.length) return { error: 'no folder', folderCount: 0 };
  const folder = folders[0];
  const lazyEl = folder.querySelector('[data-lazy-id]');
  const qid = lazyEl && lazyEl.dataset.lazyId;
  if (qid && typeof toggleQuotationFolder === 'function') {
    toggleQuotationFolder(qid);
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (document.querySelector('.approval-quotation')) break;
  }
  const content = document.getElementById('folder-content-' + qid) || folder.querySelector('.quotation-folder-content');
  if (!content) return { error: 'folder not open' };
  const quote = content.querySelector('.approval-quotation');
  const table = quote && quote.querySelector('table');
  const side = content.querySelector('.approval-side');
  const emailSection = content.querySelector('.approval-email-section');
  const headerTop = content.querySelector('.quote-header-top');
  const companyH3 = content.querySelector('.company-info h3');
  const quoteRect = quote ? quote.getBoundingClientRect() : null;
  const contentRect = content.getBoundingClientRect();
  return {
    hasQuote: !!quote,
    hasTable: !!table,
    hasSidePanel: !!side,
    hasEmailSection: !!emailSection,
    hasHeaderTop: !!headerTop,
    hasCompanyTitle: companyH3 && /DSC PIPES/i.test(companyH3.textContent || ''),
    quoteUsesFullWidth: quoteRect ? Math.round(quoteRect.width) >= Math.round(contentRect.width * 0.92) : false
  };
});

console.log(JSON.stringify(result, null, 2));
const ok = result.hasQuote && result.hasTable && !result.hasSidePanel && !result.hasEmailSection
  && result.hasHeaderTop && result.hasCompanyTitle && result.quoteUsesFullWidth;
console.log(ok ? 'PASS: full-width approval without email preview' : 'FAIL');
await browser.close();

const cleanup = await cleanupAutomatedTestQuotations(base);
if (cleanup.ok && cleanup.deletedCount > 0) {
    console.log(`Cleaned up ${cleanup.deletedCount} test quotation(s).`);
}

process.exit(ok ? 0 : 1);
