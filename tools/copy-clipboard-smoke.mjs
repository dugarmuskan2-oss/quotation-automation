/**
 * Smoke test: trigger enquiry HTML copy (execCommand path).
 * Requires server running on http://127.0.0.1:3000
 */
import { chromium } from 'playwright';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.evaluate(() => window.switchToEnquiryTab());
await page.waitForTimeout(200);

await page.evaluate(() => {
  const tbody = document.getElementById('enquiryTableBody');
  const tr = tbody ? tbody.querySelector('tr') : null;
  if (!tr) return;
  const size = tr.querySelector('input[data-col="size"]');
  const qty = tr.querySelector('input[data-col="qty"]');
  if (size) size.value = '2X40';
  if (qty) qty.value = '6';
});

await page.evaluate(() => window.enquiryPreparer && window.enquiryPreparer.copyEnquiryAsHtml());
await page.waitForTimeout(800);

await browser.close();
console.log('copy-clipboard-smoke: done');

