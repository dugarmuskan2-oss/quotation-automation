import { chromium } from 'playwright';
import { runTestQuotationCleanup } from './e2e-cleanup-lib.mjs';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

const diag = await page.evaluate(() => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  const folders = Array.from(document.querySelectorAll('#approvedQuotationsContainer .quotation-folder'));
  return folders.slice(0, 8).map((f) => {
    const header = f.querySelector('.quotation-folder-header');
    const content = f.querySelector('.quotation-folder-content');
    return {
      folderId: f.id,
      title: (header && header.querySelector('span') && header.querySelector('span').textContent || '').trim().slice(0, 60),
      contentId: content && content.id,
      lazyId: content && content.dataset.lazyId,
      hasToggleIcon: !!f.querySelector('.folder-toggle-icon'),
      isShown: content && content.classList.contains('show')
    };
  });
});

if (diag.length) {
  const quotationId = diag[0].folderId.replace(/^folder-/, '');
  await page.evaluate((id) => {
    if (typeof toggleQuotationFolder === 'function') {
      toggleQuotationFolder(id);
    }
  }, quotationId);

  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => {
    const content = document.querySelector('#approvedQuotationsContainer .quotation-folder-content.show');
    return {
      openCount: document.querySelectorAll('#approvedQuotationsContainer .quotation-folder-content.show').length,
      hasApprovalTable: !!(content && content.querySelector('.approval-quotation table')),
      hasError: content && /Failed to load|Could not find/i.test(content.textContent || ''),
      toggleErr: null
    };
  });
  console.log(JSON.stringify({ diag: diag.slice(0, 3), after }, null, 2));
  if (after.openCount < 1) {
    console.error('FAIL: folder did not open');
    await browser.close();
    await runTestQuotationCleanup(base);
    process.exit(1);
  }
  console.log('PASS: approval folder toggles open');
} else {
  console.error('FAIL: no approval folders');
  await browser.close();
  await runTestQuotationCleanup(base);
  process.exit(1);
}

await browser.close();
await runTestQuotationCleanup(base);
