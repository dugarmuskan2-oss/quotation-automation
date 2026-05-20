import { chromium } from 'playwright';
import { runTestQuotationCleanup } from './e2e-cleanup-lib.mjs';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const result = await page.evaluate(async () => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  await new Promise((r) => setTimeout(r, 2500));
  const q = approvedQuotations.find((x) => String(x.quoteNumber || '').includes('E2E/SMALL'));
  if (!q) {
    return {
      error: 'not_in_memory',
      e2eQuotes: approvedQuotations
        .filter((x) => /e2e/i.test(String(x.id)) || /E2E/i.test(String(x.quoteNumber)))
        .map((x) => ({ id: x.id, quoteNumber: x.quoteNumber }))
    };
  }
  const id = q.id;
  const fcBefore = document.getElementById('folder-content-' + id);
  const folderBefore = document.getElementById('folder-' + id);
  if (typeof toggleQuotationFolder === 'function') toggleQuotationFolder(id);
  await new Promise((r) => setTimeout(r, 2000));
  const fc = document.getElementById('folder-content-' + id);
  return {
    id,
    quoteNumber: q.quoteNumber,
    hadFolderContentEl: !!fcBefore,
    hadFolderEl: !!folderBefore,
    hasTableHTMLInMemory: !!q.tableHTML,
    show: fc ? fc.classList.contains('show') : false,
    innerSnippet: fc ? fc.innerHTML.slice(0, 280) : null,
    hasTable: !!(fc && fc.querySelector('table')),
    hasApprovalQuote: !!(fc && fc.querySelector('.approval-quotation'))
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();

await runTestQuotationCleanup(base);

if (result.error === 'not_in_memory') {
  console.log('SKIP: no E2E/SMALL quotation in client memory (inject via e2e-smoke or save a test quote).');
  process.exit(0);
}

process.exit(result.hasTable || result.hasApprovalQuote ? 0 : 1);
