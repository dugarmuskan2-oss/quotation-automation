# Features on Hold

Features that have been discussed and scoped but are not being built right now.

---

## Non-blocking PDF generation (download / print)

**Problem:** jsPDF runs synchronously on the main thread, freezing the UI for a few seconds while the PDF is generated for download/print. The user cannot interact with the page during this time.

**Note:** The email send flow now uses server-side PDF generation (pdfkit via `utils/pdf-generator.js`) so Vercel's 4.5MB request limit is no longer an issue for sending. This hold is specifically about the download/print flow remaining on jsPDF.

**Options discussed:**
- **Web Worker** — run jsPDF in a background thread. Requires separating the DOM-sync phase from the rendering phase. Moderate complexity.
- **Unify on server-side generation** — use the same pdfkit generator for download/print too (return the PDF buffer as a file download from `/api/get-quotation-pdf/:id`). Cleaner long-term.

**Preferred approach when revisited:** Unify on server-side generation — already have pdfkit set up.

---
