import { chromium } from 'playwright';
import { runTestQuotationCleanup } from './e2e-cleanup-lib.mjs';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

const listRes = await fetch(`${base}/api/quotations`);
const listJson = await listRes.json();
const rows = Array.isArray(listJson) ? listJson : listJson.quotations || [];
const stringIdRow = rows.find((r) => r && r.id != null && /[a-z]/i.test(String(r.id)));
if (!stringIdRow) {
  console.log(JSON.stringify({ skip: true, reason: 'no_string_id_quotation_in_api' }, null, 2));
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

const sid = String(stringIdRow.id);
const result = await page.evaluate((id) => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  const folder = document.getElementById('folder-' + id);
  if (typeof toggleQuotationFolder === 'function') {
    toggleQuotationFolder(id);
  }
  const content = document.getElementById('folder-content-' + id);
  return {
    id,
    found: !!folder,
    isOpen: content && content.classList.contains('show'),
    innerLen: content && (content.innerHTML || '').length
  };
}, sid);

console.log(JSON.stringify(result, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
process.exit(result.isOpen ? 0 : 1);
