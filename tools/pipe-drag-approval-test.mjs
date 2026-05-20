import { chromium } from 'playwright';
import { appendFileSync } from 'fs';
import { runTestQuotationCleanup } from './e2e-cleanup-lib.mjs';

const LOG = 'debug-f5e334.log';
const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

function log(hypothesisId, location, message, data) {
  appendFileSync(
    LOG,
    JSON.stringify({
      sessionId: 'f5e334',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
      runId: 'approval-e2e'
    }) + '\n'
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

const diag = await page.evaluate(async () => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  await new Promise((r) => setTimeout(r, 1500));
  const folders = document.querySelectorAll('#approvedQuotationsContainer .quotation-folder');
  if (!folders.length) return { error: 'no_folders' };
  const folder = folders[0];
  const lazyEl = folder.querySelector('[data-lazy-id]');
  const qid = lazyEl && lazyEl.dataset.lazyId;
  if (qid && typeof toggleQuotationFolder === 'function') toggleQuotationFolder(qid);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const t = folder.querySelector('.approval-quotation table tbody');
    if (t && t.querySelector('.pipe-type-header')) break;
  }
  const qidForAdd = qid;
  if (qidForAdd && typeof addApprovalRow === 'function') {
    const tbody0 = folder.querySelector('.approval-quotation table tbody');
    const firstHeader = tbody0 && tbody0.querySelector('.pipe-type-header');
    if (tbody0 && tbody0.querySelectorAll('.pipe-type-header').length < 2 && firstHeader) {
      addApprovalRow(qidForAdd, '__NEW_HEADER__', firstHeader.id);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const tbody = folder.querySelector('.approval-quotation table tbody');
  const headers = tbody ? Array.from(tbody.querySelectorAll('.pipe-type-header')) : [];
  return {
    qid,
    headerCount: headers.length,
    tbodySetup: tbody ? !!tbody._pipeSectionDragSetup : false,
    handleCount: tbody ? tbody.querySelectorAll('.pipe-type-drag-handle').length : 0,
    headerIds: headers.map((h) => h.id),
    draggable: headers.map((h) => h.getAttribute('draggable')),
    setupFlags: headers.map((h) => !!h._pipeSectionDragSetup)
  };
});

log('H7', 'approval-open', 'folder diagnostics', diag);

if (diag.error || diag.headerCount < 2) {
  console.log('SKIP/FAIL:', diag);
  await browser.close();
  await runTestQuotationCleanup(base);
  process.exit(diag.error ? 1 : 1);
}

const before = diag.headerIds;
const h1 = page.locator('.approval-quotation .pipe-type-header').nth(1);
const h0 = page.locator('.approval-quotation .pipe-type-header').first();
await h1.locator('.pipe-type-drag-handle').dragTo(h0, { targetPosition: { x: 10, y: 5 } });
await page.waitForTimeout(300);

const after = await page.evaluate(() => {
  const tbody = document.querySelector('.approval-quotation table tbody');
  const ids = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);
  const stuck = tbody.querySelectorAll('.row-dragging').length;
  return { ids, stuck };
});

const result = {
  before,
  after: after.ids,
  reordered: before.join() !== after.ids.join(),
  stuck: after.stuck
};
log('H2', 'approval-drag', 'drag result', result);
console.log(JSON.stringify(result, null, 2));
await browser.close();
await runTestQuotationCleanup(base);
process.exit(result.reordered && result.stuck === 0 ? 0 : 1);
