import { chromium } from 'playwright';
import { writeFileSync, appendFileSync } from 'fs';

const LOG = 'debug-f5e334.log';
const sessionId = 'f5e334';

function log(hypothesisId, location, message, data) {
  const line = JSON.stringify({
    sessionId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
    runId: 'automated'
  });
  appendFileSync(LOG, line + '\n');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('console', (msg) => {
  if (msg.text().includes('pipe-drag')) console.log('PAGE:', msg.text());
});

try {
  await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
  log('H0', 'goto', 'page load failed', { error: String(e) });
  await browser.close();
  process.exit(1);
}

const result = await page.evaluate(async () => {
  const table = document.getElementById('quotationTable');
  if (table) table.style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
  const tbody = document.getElementById('quotationTableBody');
  const headers = Array.from(tbody.querySelectorAll('.pipe-type-header'));
  const h1 = headers[1];
  const h0 = headers[0];
  const handle = h1.querySelector('.pipe-type-drag-handle');
  if (!handle || !h1) return { error: 'no handle' };

  const beforeIds = headers.map((h) => h.id);
  const dragStart = new Promise((resolve) => {
    h1.addEventListener('dragend', () => resolve('dragend'), { once: true });
    setTimeout(() => resolve('timeout-no-dragend'), 3000);
  });

  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  const dt = new DataTransfer();
  const started = h1.dispatchEvent(
    new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })
  );

  await new Promise((r) => setTimeout(r, 50));
  const draggingAfterStart = Array.from(tbody.querySelectorAll('.row-dragging')).map((r) => r.id);

  const targetY = h0.getBoundingClientRect().top + 2;
  const dropEv = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientY: targetY,
    dataTransfer: dt
  });
  tbody.dispatchEvent(dropEv);

  await new Promise((r) => setTimeout(r, 50));
  const draggingAfterDrop = Array.from(tbody.querySelectorAll('.row-dragging')).map((r) => r.id);

  h1.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const draggingAfterDragend = Array.from(tbody.querySelectorAll('.row-dragging')).map((r) => r.id);

  const afterIds = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);
  const dragendResult = await dragStart;

  return {
    started,
    beforeIds,
    afterIds,
    reordered: beforeIds.join() !== afterIds.join(),
    draggingAfterStart,
    draggingAfterDrop,
    draggingAfterDragend,
    dragendResult,
    hasDraggedRows: typeof _draggedSectionRows !== 'undefined' && _draggedSectionRows !== null
  };
});

log('H1', 'automated', 'drag simulation result', result);
console.log(JSON.stringify(result, null, 2));
await browser.close();
