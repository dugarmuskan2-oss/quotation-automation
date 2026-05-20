import { chromium } from 'playwright';
import { runTestQuotationCleanup, getTestServerBaseUrl } from './e2e-cleanup-lib.mjs';

const base = getTestServerBaseUrl();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000');

await page.evaluate(() => {
  document.getElementById('quotationTable').style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
});

const before = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#quotationTableBody .pipe-type-header')).map((h) => h.id)
);

const handle = page.locator('#quotationTableBody .pipe-type-header').nth(1).locator('.pipe-type-drag-handle');
const target = page.locator('#quotationTableBody .pipe-type-header').first();
const hb = await handle.boundingBox();
const tb = await target.boundingBox();

if (hb && tb) {
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.move(tb.x + 10, tb.y + 5, { steps: 15 });
  await page.waitForTimeout(50);
  await page.mouse.up();
}

const after = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#quotationTableBody .pipe-type-header')).map((h) => h.id)
);

console.log(JSON.stringify({ before, after, reordered: before.join() !== after.join() }, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
