import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(() => {
  addRow('__NEW_HEADER__', null, null);
  addRow('__NEW_HEADER__', null, null);
  const tbody = document.getElementById('quotationTableBody');
  const h0 = tbody.querySelectorAll('.pipe-type-header')[0];
  const h1 = tbody.querySelectorAll('.pipe-type-header')[1];
  const handle = h1.querySelector('.pipe-type-drag-handle');

  const dt = new DataTransfer();
  handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

  const dragged = _draggedSectionRows ? _draggedSectionRows.map((r) => r.id || r.className) : null;
  const targetHeader = resolvePipeSectionHeaderRow(h0);
  const targetSection = collectPipeSectionRows(targetHeader);
  const overlap = sectionRowsOverlap(_draggedSectionRows, targetSection);
  const rect = h0.getBoundingClientRect();
  const clientY = rect.top + 2;
  const insertBefore = getSectionBoundaryInsertBefore(targetSection, clientY);
  const beforeIds = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);

  if (insertBefore && _draggedSectionRows && !overlap) {
    insertPipeSectionAt(tbody, _draggedSectionRows, insertBefore);
  }

  const afterIds = Array.from(tbody.querySelectorAll('.pipe-type-header')).map((h) => h.id);
  return {
    dragged,
    targetHeaderId: targetHeader && targetHeader.id,
    insertBeforeId: insertBefore && insertBefore.id,
    overlap,
    beforeIds,
    afterIds
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
