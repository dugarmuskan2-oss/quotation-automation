import { chromium } from 'playwright';
import { runTestQuotationCleanup, getTestServerBaseUrl } from './e2e-cleanup-lib.mjs';

const base = getTestServerBaseUrl();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000');
const r = await page.evaluate(() => {
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
  const tbody = document.getElementById('quotationTableBody');
  const h0 = tbody.querySelectorAll('.pipe-type-header')[0];
  const h1 = tbody.querySelectorAll('.pipe-type-header')[1];
  const ts = collectPipeSectionRows(h0);
  const b = getPipeSectionBoundingRect(ts);
  const cy = h0.getBoundingClientRect().top + 2;
  const ib = getSectionBoundaryInsertBefore(ts, cy);
  return {
    sectionLen: ts.length,
    sectionIds: ts.map((r) => r.id),
    bounds: b,
    clientY: cy,
    above: cy < b.mid,
    insertBefore: ib && ib.id
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
