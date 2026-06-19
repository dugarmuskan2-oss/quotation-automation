# Features on Hold

Features that have been discussed and scoped but are not being built right now.

---

## Non-blocking PDF generation when sending quotations

**Problem:** jsPDF runs synchronously on the main thread, freezing the UI for a few seconds while the PDF is generated. The user cannot interact with the page (open other quotes, etc.) during this time.

**Options discussed:**
- **Web Worker** — run jsPDF in a background thread. Requires separating the DOM-sync phase from the rendering phase. Moderate complexity.
- **Server-side PDF generation** — send quotation data to the server, generate PDF there (PDFKit or Puppeteer), return base64. Cleaner long-term, opens door to auto-attaching PDFs at ingest time.

**Preferred approach when revisited:** Server-side generation (Option 2) — better long-term architecture.

---
