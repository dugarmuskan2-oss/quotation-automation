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

## Investigate quotation-list loading speed

**Symptom:** the saved-quotations list (Approval section) was reported to feel slower to load, noticed around the 19 Jun merge of `main` into `Testing-other-features`.

**What the code already confirms (read-only investigation, nothing changed):**
- The list load is **lazy** — the first load only fetches lightweight summary cards (no `tableHTML`/terms). The full quotation is fetched per-folder on first open (`/quotations/{id}`, `index.html` ~line 6258). So big payloads are *not* the cause.
- Commit `6aee2bd` ("100 items load first") raised the first-page size from **40 → 100** (`APPROVED_QUOTATIONS_PAGE_SIZE`, `index.html:1631`); it reached this branch via the 19 Jun `c50b4ac` merge. This is 2.5× more *summary* cards, but each is tiny — likely a minor factor unless there are hundreds of quotes.
- The backend list route (`routes/quotations.js`) uses a fast DynamoDB index (`entity-updatedAt-index`) and **falls back to a full-table scan if that index is missing**. Code cannot prove whether the index actually exists in the AWS account — only the runtime can.

**The one fact that settles it (not yet checked):** the route already records, on every load, whether it used the fast path or the slow path — response headers `X-Query-Mode` (`gsi` = fast, `scan` = slow/grows with quote count) and `X-Query-Ms`, plus a matching server console log line. Read that first.
- Browser: F12 → Network → the `quotations` request → Response Headers.
- Or run `tools/measure-api-timing.mjs` against a running local server.

**Likely fixes depending on what's found:**
- If `mode=scan` → create the `entity-updatedAt-index` GSI (the real fix; scan gets slower as quotes accumulate).
- If `mode=gsi` but still slow → consider dialing `APPROVED_QUOTATIONS_PAGE_SIZE` back to 40, or rendering the 100 cards more cheaply.

---

## Freight transporter search works locally but not on deployed `main`

**Symptom:** the freight-enquiry **To — transporters** autocomplete shows suggestions when running locally, but on the deployed site (from `origin/main`) typing (e.g. "ke") shows **nothing** — neither remembered transporters nor Gmail matches.

**Why it's almost certainly environment, not code:** the same code runs in both places, so the difference is the deployed site's config. The local app reads secrets from `.env`; the deploy (Vercel) has its own env-var copies. Notably, the Gmail re-auth (`node tools/gmail-auth.js`) only updated the **local** `.env` — the deploy likely still holds the **old** `GMAIL_REFRESH_TOKEN` (without the `contacts.*` scopes), so the People API call fails → no Gmail suggestions. If remembered ones are also missing, the deploy may also lack AWS/S3 keys or be running stale code.

**Diagnose on the LIVE site (not local):** F12 → Network → type in the To box → inspect the two requests:
- `contact-suggestions` (Gmail matches) and `get-freight-suggestions` (remembered list).
- **404** → deploy is running old code (redeploy). **500 / error** → missing/wrong secrets on the deploy. **200 + empty list** → stale token / People API not returning.

**Likely fixes (by finding):**
- Stale token → copy the new `GMAIL_REFRESH_TOKEN` from local `.env` into Vercel → Settings → Environment Variables, then redeploy. (Also confirm the People API is enabled for that Google Cloud project.)
- Missing S3 keys → set the AWS env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`) on Vercel.
- 404 → trigger a redeploy of `main`.

---

## Ideas to revisit (not yet scoped)

- **Organise the configuration folder/section** — the Configuration area has grown (instructions, default terms, default margins, default email message, default signature). Group/reorder it so it's easier to scan.
- **Separate signatures per employee** — today there's one shared Default Email Signature. Let each user/employee have their own signature, picked automatically based on who's sending (or who prepared the quote).
- **Convert weight to tons** — add an option to show/convert the calculated weight (kg) into tons, in the Weight Calculator and/or the Freight tab.

> **Resolved (no longer on hold):** ~~Explore autosave~~ — decided **against** autosave. Approval-section edits now stay in-memory and only persist on explicit Save/Approve; the Download/Send gate blocks while there are unsaved edits. The debounced backend autosave (`scheduleQuotationBackendSave`) was removed.

---
