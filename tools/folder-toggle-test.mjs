import { chromium } from 'playwright';
import { appendFileSync } from 'fs';

const LOG = 'debug-f5e334.log';
const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

function log(hypothesisId, location, message, data) {
  appendFileSync(
    LOG,
    JSON.stringify({ sessionId: 'f5e334', hypothesisId, location, message, data, timestamp: Date.now(), runId: 'folder-toggle' }) + '\n'
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('pageerror', (err) => log('H4', 'pageerror', err.message, {}));

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

const diag = await page.evaluate(() => {
  if (typeof switchToQuotationTab === 'function') switchToQuotationTab();
  const folders = Array.from(document.querySelectorAll('#approvedQuotationsContainer .quotation-folder'));
  return folders.slice(0, 8).map((f) => {
    const header = f.querySelector('.quotation-folder-header');
    const content = f.querySelector('.quotation-folder-content');
    const onclick = header && header.getAttribute('onclick');
    return {
      folderId: f.id,
      title: (header && header.querySelector('span') && header.querySelector('span').textContent || '').trim().slice(0, 60),
      onclick,
      contentId: content && content.id,
      lazyId: content && content.dataset.lazyId,
      hasToggleIcon: !!f.querySelector('.folder-toggle-icon'),
      isShown: content && content.classList.contains('show')
    };
  });
});

log('H1', 'folder-list', 'approval folders', { count: diag.length, folders: diag });

if (diag.length) {
  const first = diag[0];
  await page.evaluate((onclick) => {
    if (typeof toggleQuotationFolder === 'function' && onclick) {
      const m = onclick.match(/toggleQuotationFolder\((.+)\)/);
      if (m) {
        try {
          const id = JSON.parse(m[1]);
          toggleQuotationFolder(id);
        } catch (e) {
          window.__folderToggleErr = String(e);
        }
      }
    }
  }, first.onclick);

  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => {
    const content = document.querySelector('#approvedQuotationsContainer .quotation-folder-content.show');
    return {
      openCount: document.querySelectorAll('#approvedQuotationsContainer .quotation-folder-content.show').length,
      hasApprovalTable: !!(content && content.querySelector('.approval-quotation table')),
      hasError: content && /Failed to load|Could not find/i.test(content.textContent || ''),
      toggleErr: window.__folderToggleErr || null
    };
  });
  log('H2', 'folder-open', 'after toggle', after);
  console.log(JSON.stringify({ diag: diag.slice(0, 3), after }, null, 2));
}

await browser.close();
