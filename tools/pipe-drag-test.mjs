/**
 * Quick check: does native dragstart fire on span vs tr handles?
 * Run: node tools/pipe-drag-test.mjs
 */
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:3000';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });

const result = await page.evaluate(() => {
  const tbody = document.getElementById('quotationTableBody');
  if (!tbody) return { error: 'no quotationTableBody' };

  if (typeof addRow === 'function') {
    addRow('__NEW_HEADER__', null, null);
    addRow('__NEW_HEADER__', null, null);
  }

  const headers = tbody.querySelectorAll('.pipe-type-header');
  if (headers.length < 2) return { error: 'need 2 headers', count: headers.length };

  const spanHandle = headers[0].querySelector('.pipe-type-drag-handle, .drag-handle');
  const tr = headers[0];

  function fireDragStart(el) {
    let fired = false;
    const onStart = () => { fired = true; };
    el.addEventListener('dragstart', onStart);
    const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    el.dispatchEvent(ev);
    el.removeEventListener('dragstart', onStart);
    return { fired, defaultPrevented: ev.defaultPrevented };
  }

  return {
    headerCount: headers.length,
    spanDraggable: spanHandle ? spanHandle.getAttribute('draggable') : null,
    trDraggable: tr.getAttribute('draggable'),
    spanDragStart: spanHandle ? fireDragStart(spanHandle) : null,
    trDragStart: fireDragStart(tr),
    hasBindPipeSection: typeof bindPipeSectionDragHandle === 'function',
    handleBound: spanHandle ? !!spanHandle._pipeSectionHandleBound : false
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
