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
  const headers = Array.from(tbody.querySelectorAll('.pipe-type-header'));
  const h0 = headers[0];
  const h1 = headers[1];
  const before = headers.map((h) => h.id);

  const dt = new DataTransfer();
  h1._pipeDragFromHandle = true;
  h1.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 15));

  const dropEv = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: dt,
    clientY: h0.getBoundingClientRect().top + 2
  });
  Object.defineProperty(dropEv, 'target', { value: h1, configurable: true });
  tbody.dispatchEvent(dropEv);

  const afterDropStuck = tbody.querySelectorAll('.row-dragging').length;
  const draggedNull = _draggedSectionRows === null;

  h1.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const afterEndStuck = tbody.querySelectorAll('.row-dragging').length;
  const after = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);

  return {
    before,
    after,
    reordered: before.join() !== after.join(),
    draggedNull,
    afterDropStuck,
    afterEndStuck
  };
});

console.log(JSON.stringify(result, null, 2));
await page.waitForTimeout(400);
await browser.close();
