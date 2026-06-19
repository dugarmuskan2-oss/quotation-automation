# Features on Hold

Features that have been discussed and scoped but are not being built right now.

---

## Non-blocking PDF generation (download / print / email)

**Problem:** jsPDF runs synchronously on the main thread, freezing the UI for a few seconds while the PDF is generated. The user cannot interact with the page during this time.

**Note:** Download, Print and Email all share the one jsPDF renderer in `index.html` (the email send generates the same PDF and posts its base64 to `/api/send-email`). A server-side pdfkit renderer was tried for email but removed — it could never match the jsPDF layout/fonts exactly, which is what's wanted. The quotation PDF (~0.5 MB) is well under Vercel's request limit, so client-side generation is fine.

**Options discussed:**
- **Web Worker** — run jsPDF in a background thread. Requires separating the DOM-sync phase from the rendering phase. Moderate complexity.
- **Server-side generation** — rejected: a second renderer drifts from the jsPDF output (fonts, spacing, totals format).

**Preferred approach when revisited:** Web Worker, so Download/Print/Email keep using the one jsPDF renderer.

---

## Ideas to revisit (not yet scoped)

- **Organise the configuration folder/section** — the Configuration area has grown (instructions, default terms, default margins, default email message, default signature). Group/reorder it so it's easier to scan.
- **Separate signatures per employee** — today there's one shared Default Email Signature. Let each user/employee have their own signature, picked automatically based on who's sending (or who prepared the quote).
- **Explore autosave** — revisit how/when approval-section edits persist (currently a debounced backend save + a "save before send/download" gate). Decide whether edits should silently autosave, and how that interacts with the unsaved-changes prompt.

---
