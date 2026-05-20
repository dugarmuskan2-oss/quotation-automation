import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);

const result = await page.evaluate(async () => {
  document.getElementById('quotationTable').style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
  const tbody = document.getElementById('quotationTableBody');
  const h1 = tbody.querySelectorAll('.pipe-type-header')[1];
  const h0 = tbody.querySelectorAll('.pipe-type-header')[0];

  const dt = new DataTransfer();
  h1._pipeDragFromHandle = true;
  h1.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

  await new Promise((r) => setTimeout(r, 10));
  const draggingAfterStart = tbody.querySelectorAll('.row-dragging').length;

  const dragOverEv = new DragEvent('dragover', {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientY: h0.getBoundingClientRect().top + 2
  });
  tbody.dispatchEvent(dragOverEv);

  const dropEv = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientY: h0.getBoundingClientRect().top + 2
  });
  Object.defineProperty(dropEv, 'target', { value: h0.querySelector('td') || h0, configurable: true });
  tbody.dispatchEvent(dropEv);

  const draggedNullAfterDrop = _draggedSectionRows === null;
  const stuckAfterDrop = tbody.querySelectorAll('.row-dragging').length;

  h1.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

  const stuckAfterDragEnd = tbody.querySelectorAll('.row-dragging').length;

  return {
    draggingAfterStart,
    draggedNullAfterDrop,
    stuckAfterDrop,
    stuckAfterDragEnd
  };
});

console.log(JSON.stringify(result, null, 2));
await page.waitForTimeout(300);
await browser.close();
