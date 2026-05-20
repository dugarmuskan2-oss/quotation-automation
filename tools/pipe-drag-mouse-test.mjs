import { chromium } from 'playwright';
import { appendFileSync } from 'fs';
import { runTestQuotationCleanup, getTestServerBaseUrl } from './e2e-cleanup-lib.mjs';

const base = getTestServerBaseUrl();

const LOG = 'debug-f5e334.log';
const sessionId = 'f5e334';

function log(hypothesisId, location, message, data) {
  appendFileSync(
    LOG,
    JSON.stringify({ sessionId, hypothesisId, location, message, data, timestamp: Date.now(), runId: 'mouse' }) + '\n'
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });

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
  await page.waitForTimeout(100);
  await page.mouse.move(tb.x + 10, tb.y + 5, { steps: 20 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}

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

log('H1', 'mouse-test', 'after real mouse drag', {
  before,
  after: after.headers,
  reordered: before.join() !== after.headers.join(),
  stuckDragging: after.stuck,
  stuckCount: after.stuck.length
});

console.log(JSON.stringify({ before, after, stuck: after.stuck }, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
