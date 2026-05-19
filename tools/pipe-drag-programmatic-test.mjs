import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000');

const result = await page.evaluate(() => {
  document.getElementById('quotationTable').style.display = 'table';
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
  const tbody = document.getElementById('quotationTableBody');
  const h0 = tbody.querySelectorAll('.pipe-type-header')[0];
  const h1 = tbody.querySelectorAll('.pipe-type-header')[1];
  const before = [h0.id, h1.id];

  const handle = h1.querySelector('.pipe-type-drag-handle');
  const dt = new DataTransfer();
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  h1._pipeSectionDragFromHandle = true;
  h1.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

  const dragged = _draggedSectionRows ? _draggedSectionRows.map((r) => r.id) : null;
  const targetSection = collectPipeSectionRows(h0);
  const clientY = h0.getBoundingClientRect().top + 2;
  const insertBefore = getSectionBoundaryInsertBefore(targetSection, clientY, h0, _draggedSectionRows);

  if (insertBefore && _draggedSectionRows) {
    insertPipeSectionAt(tbody, _draggedSectionRows, insertBefore);
  }

  const after = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);
  return {
    before,
    after,
    reordered: before.join() !== after.join(),
    dragged,
    insertBefore: insertBefore && insertBefore.id
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
