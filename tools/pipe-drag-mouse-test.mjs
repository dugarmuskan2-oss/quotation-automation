import { chromium } from 'playwright';
import { runTestQuotationCleanup, getTestServerBaseUrl } from './e2e-cleanup-lib.mjs';

const base = getTestServerBaseUrl();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.evaluate(() => {
  document.getElementById('quotationTable').style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
});

const before = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#quotationTableBody .pipe-type-header')).map((h) => h.id)
);

await page.locator('#quotationTableBody .pipe-type-header').nth(1).locator('.pipe-type-drag-handle').dragTo(
  page.locator('#quotationTableBody .pipe-type-header').first(),
  { targetPosition: { x: 10, y: 5 } }
);
await page.waitForTimeout(300);

const after = await page.evaluate((beforeJoin) => {
  const tbody = document.getElementById('quotationTableBody');
  const headers = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);
  const stuck = Array.from(tbody.querySelectorAll('.row-dragging')).map((r) => ({
    id: r.id,
    classes: r.className
  }));
  return { headers, stuck, reordered: headers.join() !== beforeJoin };
}, before.join());

const ok = after.reordered && after.stuck.length === 0;
console.log(JSON.stringify({ before, after, reordered: ok, stuck: after.stuck }, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
process.exit(ok ? 0 : 1);
