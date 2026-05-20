import { chromium } from 'playwright';
import { runTestQuotationCleanup, getTestServerBaseUrl } from './e2e-cleanup-lib.mjs';

const base = getTestServerBaseUrl();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });

const result = await page.evaluate(async () => {
  document.getElementById('quotationTable').style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  const tbody = document.getElementById('quotationTableBody');
  const h1 = tbody.querySelector('.pipe-type-header');
  const rows = collectPipeSectionRows(h1);
  rows.forEach((r) => r.classList.add('row-dragging'));
  _draggedSectionRows = rows;
  _pipeDragVisualRows = rows.slice();
  _draggedSectionRows = null;
  var stuck = rows.filter((r) => r.classList.contains('row-dragging')).length;
  if (_draggedSectionRows) {
    _draggedSectionRows.forEach((r) => r.classList.remove('row-dragging'));
  }
  var stuckAfterFailedCleanup = rows.filter((r) => r.classList.contains('row-dragging')).length;
  rows.forEach((r) => r.classList.remove('row-dragging'));
  return { stuck, stuckAfterFailedCleanup };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
