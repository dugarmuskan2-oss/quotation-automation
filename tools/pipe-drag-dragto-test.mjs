import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  document.getElementById('quotationTable').style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
});

const before = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#quotationTableBody .pipe-type-header')).map((h) => h.id)
);

const source = page.locator('#quotationTableBody .pipe-type-header').nth(1).locator('.pipe-type-drag-handle');
const dest = page.locator('#quotationTableBody .pipe-type-header').first();
await source.dragTo(dest, { targetPosition: { x: 10, y: 2 } });
await page.waitForTimeout(500);

const after = await page.evaluate(() => ({
  order: Array.from(document.querySelectorAll('#quotationTableBody .pipe-type-header')).map((h) => h.id),
  stuck: document.querySelectorAll('#quotationTableBody .row-dragging').length
}));

console.log(JSON.stringify({ before, after, reordered: before.join() !== after.order.join() }, null, 2));
await browser.close();
