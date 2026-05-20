import { chromium } from 'playwright';
import { appendFileSync } from 'fs';
import { runTestQuotationCleanup } from './e2e-cleanup-lib.mjs';

const LOG = 'debug-f5e334.log';
const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

function log(hypothesisId, location, message, data) {
  appendFileSync(
    LOG,
    JSON.stringify({ sessionId: 'f5e334', hypothesisId, location, message, data, timestamp: Date.now(), runId: 'string-id' }) + '\n'
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

const result = await page.evaluate(() => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  const folder = document.getElementById('folder-test-save-20260518131450');
  const header = folder && folder.querySelector('.quotation-folder-header');
  const onclick = header && header.getAttribute('onclick');
  if (typeof toggleQuotationFolder === 'function') {
    toggleQuotationFolder('test-save-20260518131450');
  }
  const content = document.getElementById('folder-content-test-save-20260518131450');
  return {
    found: !!folder,
    onclick,
    isOpen: content && content.classList.contains('show'),
    innerLen: content && (content.innerHTML || '').length
  };
});

log('H1', 'string-id-open', 'test-save folder', result);
console.log(JSON.stringify(result, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
process.exit(result.isOpen ? 0 : 1);
