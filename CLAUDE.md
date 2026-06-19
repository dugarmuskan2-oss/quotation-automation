# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Standing rules

- **Never update CLAUDE.md or write tests for a feature without explicit user approval first.** When a feature is complete, ask in chat: "This looks done — want me to update CLAUDE.md and add tests?" Then wait for a clear yes before doing either.

## Commands

```bash
npm install        # install dependencies
npm start          # run server on PORT (default 3000)
npm run dev        # nodemon (auto-restart on save)
npm run test:e2e   # Playwright end-to-end smoke tests
npm run migrate:entity  # one-off DynamoDB migration script
```

## Modularity rules

New code must go in the appropriate existing file or a new file in the right folder:

| What you're building | Where it goes |
|---|---|
| Route for rates / file management | `routes/rates.js` |
| Route for quotations | `routes/quotations.js` |
| Route for settings / config | `routes/config.js` |
| Route that doesn't fit above | New file `routes/something.js` |
| Calculation or number helper | `utils/calculations.js` |
| Named constant (DynamoDB keys, config file names, etc.) | `utils/constants.js` |
| Other reusable helper | New file `utils/something.js` |
| File storage logic | `storage/index.js` |
| Gmail ingest sub-logic | `gmail-ingest/` (route.js, ingestLogic.js, htmlBuilder.js, attachmentUtils.js, descriptionFormatter.js) |

`server.js` is for: Express/middleware setup, OpenAI + DynamoDB init, multer config, file-type helpers (`isWordEnquiryFile`, `isExcelEnquiryFile`, `isImageEnquiryFile`, `getImageDataUrl`, `extractTextFromWordFile`, `extractTextFromExcelFile`), and `handleGenerateQuotation` (the core AI function). No other business logic belongs there.

Never use raw string literals for DynamoDB table keys, entity types, or config file names — always import from `utils/constants.js`.

## Function design rules

- A route handler should only orchestrate: call helpers, build the response. No inline logic.
- If a block of code needs a comment to explain what it does, extract it into a named function instead.
- Helper functions go at the top of the file or in `utils/`. They must do one thing only.
- Sub-functions (only used by one parent) can be defined just above the parent function.
- No function should be longer than ~30 lines. If it is, break it up.

## Testing rules

Run only the relevant test file after each change:

```bash
jest tests/calculations.test.js          # utils/calculations.js
jest tests/unit.test.js                  # server.js internal helpers (_test export)
jest tests/api.test.js                   # routes and handleGenerateQuotation
jest tests/rate-file-interleaving.test.js  # OpenAI input array structure
jest tests/description-format.test.js    # formatItemDescriptionByPipeType in index.html
jest tests/enquiry-weight.test.js        # weight calculation helpers
jest tests/print-button.test.js          # print button logic
jest tests/gmail-send.test.js            # POST /api/send-email route + send-button frontend logic
jest tests/approval-edit.test.js         # approval header-field edits (data-field mapping) + send save-gate
jest tests/email-compose.test.js         # MIME builder (CID inline images), email body/placeholders, reply subject
jest --silent                            # quieter output (add to any command)
```

Run the full suite (`npm test`) only when explicitly asked.

**Test patterns to know:**
- `tests/unit.test.js` accesses server internals via `require('../server')._test` — functions that need testing but aren't exported normally are added to that `_test` object at the bottom of `server.js`.
- `tests/description-format.test.js` extracts `formatItemDescriptionByPipeType` (and its helpers) from `index.html` via `fs.readFile` + `eval` because that function lives in the browser-only SPA. If marker comments in `index.html` change, update the extractor in that test file.
- `tests/api.test.js` mocks all external services (DynamoDB, S3, GCS, OpenAI) before loading the app — never needs real credentials.
- `tests/email-compose.test.js` tests the real MIME builder via the `_test` export on `utils/gmail.js` (`buildRawMessage`, `extractInlineImages`) and `replySubject` exported from `routes/gmail.js`; the email body/placeholder helpers are inline copies of `index.html` logic (kept in sync with `buildQuotationEmailBodyHtml` / `fillEmailPlaceholders`).

Open `index.html` directly in a browser — it communicates with the running server via fetch.

## Architecture

### Overview

Full-stack quotation automation tool. Users paste an email or upload a file, AI generates a freight quotation, they approve and save it.

- **Frontend**: `index.html` — single-file SPA, all HTML/CSS/JS in one file. Contains `formatItemDescriptionByPipeType` (pipe size code → human-readable string).
- **Backend**: `server.js` — Express setup, OpenAI + DynamoDB init, file-type helpers, `handleGenerateQuotation` (main AI orchestration function)
- **Routes**: `routes/rates.js`, `routes/config.js`, `routes/quotations.js`
- **Utils**: `utils/calculations.js` (`calculateLineItem`, `parseFlexibleNumber`), `utils/constants.js` (all shared string/number constants)
- **Storage**: `storage/index.js` — unified GCS / S3 / local file layer; `isCloudActive()` controls multer mode
- **Gmail ingest**: `gmail-ingest/` — `route.js` (Express handler), `ingestLogic.js` (orchestration), `htmlBuilder.js`, `attachmentUtils.js`, `descriptionFormatter.js`
- **Vercel entry**: `api/index.js` — thin wrapper that imports `server.js` as a serverless function

### Vercel vs Local

`vercel.json` rewrites all traffic through `api/index.js` (60s max duration). The server detects Vercel via `process.env.VERCEL` and switches to `/tmp` for file writes. Locally, files go to disk.

### Storage (all optional, falls back gracefully)

| Service | Purpose | Key env vars |
|---|---|---|
| AWS S3 | Rate file and enquiry file storage | `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| AWS DynamoDB | Quotation persistence | `DYNAMODB_TABLE` |
| Google Cloud Storage | Alternative to S3 | `GOOGLE_CLOUD_BUCKET_NAME`, `GOOGLE_CLOUD_PROJECT_ID` |
| OpenAI | Quotation generation + chat | `OPENAI_API_KEY` (required) |
| Gmail API | Send quotation emails + enquiry emails | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |

If neither S3 nor GCS is configured, files are stored locally.

### Core API Routes

- `POST /api/generate-quotation` — AI quotation from email/text (JSON body)
- `POST /api/generate-quotation-file` — AI quotation from uploaded file or image (multipart)
- `POST /api/upload-rates` — Upload Excel rate/pricing file; converts to PDF, uploads to OpenAI, caches file ID in rate index
- `POST /api/save-quotation` — Save approved quotation to DynamoDB
- `GET /api/quotations` — List quotations via DynamoDB GSI (`entity-updatedAt-index`), cursor-paginated
- `POST /api/ingest-from-gmail` — Receive emails from Google Apps Script
- `POST /api/ai-chat` — Chat with AI about a quotation
- `POST /api/send-email` — Send email via Gmail API; accepts `{ to, subject, bodyHtml, pdfBase64?, pdfFilename?, replyToMessageId?, threadId?, inReplyTo?, references?, cc?, bcc? }`. `to`/`cc`/`bcc` may each be multiple comma-separated addresses (rendered as `To:`/`Cc:`/`Bcc:` headers). This is the single send route for both quotation PDFs and enquiry tables — the **client** generates the PDF (the same jsPDF used for Download/Print) and posts its base64; there is no server-side PDF rendering. If `replyToMessageId` is provided, the server looks up the original Gmail message to auto-fill `to` (original sender) and `subject` (`Re: {original subject}`, de-duplicated via `replySubject`) and sends as a reply in that thread. Requires `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` in env. Route in `routes/gmail.js`, helpers in `utils/gmail.js`. One-time OAuth setup: `node tools/gmail-auth.js` (scopes: `gmail.send` + `gmail.metadata`).
- `GET /api/resolve-thread?messageId=…` — returns `{ threadId, rfcMessageId, fromEmail, subject }` for an original Gmail message; the client calls this to resolve reply recipient/threading before sending.
- `POST/GET /api/save-default-email-message` · `/api/get-default-email-message` and `/api/save-default-signature` · `/api/get-default-signature` — persist the configurable email body and signature (see Email composition below). Routes in `routes/config.js`.

Quotation generation uses `openai.responses.create` (the Responses API), not `chat.completions.create`.

### Rate File Index

`rates-index.json` (managed via `storage.loadRateIndex()` / `storage.saveRateIndex()`) caches OpenAI file IDs for uploaded rate files. `handleGenerateQuotation` uses this as a fast path — rate files are uploaded to OpenAI once at upload time, not on every generation request. Each rate file is immediately preceded by a labeled `input_text` part in the OpenAI request so GPT can match rates to pipe types (GI / ERW / Seamless).

### Known Issue

`/api/generate-quotation` only passes `emailContent`, `fileContent`, and `instructions` to `handleGenerateQuotation()`, but the function also accepts `enquiryFileId`, `enquiryFileIds`, and `enquiryImageDataUrl`. If those are needed from a JSON body request, add them to the destructure at the point where the route calls `handleGenerateQuotation`. The `/api/generate-quotation-file` route handles these correctly.

### Gmail Integration

`gmail-ingest/route.js` handles `POST /api/ingest-from-gmail`. `apps-script/SendLabeledEmailsToApp.gs` runs in Google Apps Script, polls Gmail labels, and POSTs batches of emails to that endpoint. Secured with `INGEST_SECRET` env var checked against the `X-Ingest-Secret` header.

### Apps Script Report (Google Sheets)

`apps-script/GmailLabelReport.gs` runs inside a Google Sheet (not the Node.js app). It has two buttons the user clicks manually:

- **Run Report** — scans Gmail for all tracked labels (Enquiry Client, Enquiry Market, Quotation, Freight Bill, Price List, Purchase Order, etc.) within the current time window, writes counts + Gmail search hyperlinks to a "Report" sheet tab, then at the end automatically calls `sendLabeledEmailsToApp` to ingest any emails labelled `"Quotation Automation/Create Quotation"` into the app.
- **Create Quotations** — skips the report entirely, just ingests newly-labelled emails immediately.

Also contains `checkEnquiryFollowUps()` — flags any `Enquiry` thread with `"Enquiry - Needs Reply"` label if no reply has been sent within 2 days (`OVERDUE_DAYS = 2`).

The Gmail API auth lives in Apps Script (via `GmailApp`), not in the Node.js backend. The Node.js backend would need its own OAuth credentials with `gmail.send` scope to send emails directly — but the same Google Cloud project (already set up for GCS) can be used.

### "View in Gmail" button

Every saved quotation stores `emailLink` (full Gmail URL to the original thread) and `gmailMessageId`. The approval section shows a **"View in Gmail"** link on each expanded quote card that opens the original email thread directly. This means the Gmail thread ID is already captured at ingest time — Phase 3 (reply capture) can use this existing link rather than building thread tracking from scratch.

---

## UI Overview

`index.html` is a single-page app with three tools switched by a floating left sidebar (three icon buttons). All three are visible containers; only one is shown at a time.

### Quotation tab (default)
Two sections, always both visible on the page:

**Creation section** — paste email text or upload a file → "Generate Quotation" → AI fills in a draft quote table. The draft sits here until approved. Also has "Add Freight" button (adds a freight line item) and "Apply FOR" (see FOR logic below).

**Approval section** — searchable, paginated list of all saved/ingested quotes. Each quote is a collapsible card:
- **Collapsed:** folder icon + `"COMPANY - CONTACT - DSC-####"` title + status badges + "View in Gmail" link + ▶ expand arrow
- **Expanded:** orange border, header fields grid (date, kind attn, phone, bill to, ship to, prepared by, assigned to, checked by), items table, terms, right-side panel (email content + View in Gmail), AI chat ("Talk to AI"), action buttons: ✅ Approve, 💾 Save, 🖨️ Print, ⬇️ Download PDF, ✉️ Send to Customer. **Send gates** (in order): approved at least once (`everApproved`/`saved`) → "Checked By" filled. See "Sending a quotation by email" below.

**Status badges on cards:**
- `ASSIGNED TO - [NAME]` (blue) — set via the Assigned To field
- `APPROVED - [NAME]` (green) — quote has been approved/saved to DynamoDB
- `✓ SENT` (teal) — quote PDF has been emailed to the customer via "Send to Customer"; persisted as `sent: true` on the quotation object
- These are display labels derived from fields; they are not a formal status enum (yet — adding one is Phase 1)

### Weight Calculator tab
Standalone tool. Loads pipe sizes and their kg/m values from a user-uploaded CSV. Can load items by quote number, or AI-extract sizes from pasted text. Rows with missing kg/m values are red-tinted. Prints a weight summary.

### Enquiry Preparer tab
Builds an OUR REQUIREMENT / YOUR OFFER table for sending to transporters or dealers. Can load from quote number. Two send options:
- **📋 Copy as HTML** — copies as Outlook-compatible HTML (uses `ClipboardItem` with `execCommand` fallback)
- **✉️ Send from App** — sends the table directly via Gmail API (`POST /api/send-email`); prompts for recipient and subject

---

## Quotation Data Structure

Key fields on every quotation object (stored in DynamoDB and held in the frontend `approvedQuotations` array):

| Field | What it is |
|---|---|
| `quoteNumber` | `"DSC-108"` — DSC prefix + counter. Counter stored in DynamoDB, starts at 107 so first real quote is DSC-108. |
| `companyName` | Customer company |
| `customerName` | Contact person (Kind Attn) |
| `projectName` | Project name if given |
| `lineItems` | Array of line items. As persisted from the approval table (`extractStructuredLineItemsFromTable` / `syncQuotationLineItemsFromApprovalContent`) each has `lineItemId`, `originalDescription`, `identifiedPipeType`, `quantity`, `unitRate`, `marginPercent`, `finalRate`, `lineTotal`, `kgPerMeter`. ⚠️ Note the field names: it's `originalDescription`/`unitRate`/`lineTotal`, **not** `description`/`baseRate`/`total`. |
| `grandTotal` | Sum of all line item totals |
| `termsText` | Terms and conditions text |
| `emailContent` | Original enquiry email text |
| `emailContentHtml` | HTML version of the email |
| `emailLink` | Gmail URL for the original email |
| `gmailMessageId` | Used for deduplication on ingest |
| `tableHTML` / `headerHTML` | Pre-rendered HTML blobs for PDF generation |
| `saved` | `false` = AI-drafted or has unsaved edits. `true` = currently saved/approved. Editing any field flips this back to `false`. |
| `everApproved` | `true` once the quote has been approved at least once; never cleared by editing. The send gate checks this (not `saved`) so editing the required "Checked By" field doesn't force re-approval. |
| `hasUnsavedEdits` | `true` when the approval form has edits not yet persisted. The send flow flushes these (`captureApprovalEditsIntoQuotation` → backend) before generating the PDF. |
| `sent` | `true` once the quotation PDF has been emailed to the customer via "Send to Customer" |
| `sentAt` | ISO timestamp of when the quote was sent |
| `threadId` | Gmail thread ID returned after sending; stored for future Phase 3 reply capture |
| `freightDistributedIntoMargin` | `true` when FOR has been applied (freight hidden in PDF) |
| `assignedTo` / `checkedBy` | Free-text fields, not a formal workflow |
| `preparedBy` | Who generated the quote |
| `createdAt` / `updatedAt` | Timestamps |

---

## Key Business Logic

### Pipe types
Three types: **GI** (galvanised iron), **ERW** (electric resistance welded), **Seamless**. Each has its own rate file and default margin %. The AI matches rate files to pipe types by the labeled `input_text` parts prepended to each rate file in the OpenAI request.

### formatItemDescriptionByPipeType
Lives in `index.html`. Parses raw AI-generated description strings to extract pipe size (e.g. `2"`, `1-1/2"`) and weight class (heavy/medium/schedule), then reformats as standardised strings like `2" NB X Heavy -- GI` or `2" NB X Sch 40`. Used when rendering the items table.

### Freight FOR (Freight on Road) logic — `applyFreightForApproval`
When customer wants a **FOR price** (freight included, but it must not appear as a separate line in the PDF):
1. Snapshots all current margin % values (stored for undo)
2. Calculates how much margin % to add to each line item so the grand total absorbs the freight amount exactly
3. Marks the freight row with `freight-distributed` class — the PDF renderer skips this class
4. Sets `freightDistributedIntoMargin = true` on the quote
5. Fixes rounding drift (applies remainder to one row)
6. Fully reversible via the undo snapshot

### Quote counter / numbering
The DynamoDB table holds an atomic counter item. `POST /api/save-quotation` increments it to get the next DSC-### number. The Gmail ingest also calls this when creating a quote from an email.

### Quote lookup performance
`GET /api/quotations` uses a DynamoDB GSI (`entity-updatedAt-index`) for cursor-paginated listing (~80ms/page). Falls back to a full table scan if the GSI is missing. Frequently accessed individual quotes are cached in an in-memory LRU cache (max 2000 entries) on the server.

### Gmail ingest flow
For each labelled email: (1) deduplicate by `gmailMessageId`, (2) extract text from PDF/Excel/Word attachments, (3) upload PDFs to OpenAI, (4) capture first image, (5) call `handleGenerateQuotation` with combined content, (6) save with `saved: false`. The saved quote links back to the Gmail thread via `emailLink` and `gmailMessageId`.

### Sending a quotation by email — `sendQuotationToCustomer` (index.html)

1. **Gates:** the quote must have been approved at least once (`everApproved || saved`) and "Checked By" must be filled. Approval is *sticky* — editing a field clears `saved` but not `everApproved`, so filling the required Checked By field doesn't force re-approval.
2. **Save gate:** if the quote has unsaved edits (`hasUnsavedEdits`), sending is blocked with a "please save first" prompt — same as Download. Save the quote (which captures the edits), then send, so the emailed PDF and greeting reflect what's on screen. Sending does **not** silently auto-save.
3. **Recipient/subject:** for a quote ingested from Gmail (`gmailMessageId` present), the client calls `/api/resolve-thread` to auto-fill the recipient and reply in-thread. With no thread (or if lookup fails), a single dialog (`promptForEmailRecipients`) collects To / CC / BCC, each accepting multiple addresses shown as removable pill chips (invalid addresses flagged red). The subject is auto-generated (`Quotation DSC-#### - DSC Pipes`) — no subject prompt. (The Enquiry "Send from App" flow still prompts for recipient and subject.)
4. **PDF:** the client generates the **same jsPDF** used for Download/Print (`downloadQuotationPdf(id, { returnBase64: true })`) and posts the base64 to `/api/send-email`. There is no server-side PDF renderer — a previous pdfkit attempt was removed because it couldn't match the jsPDF layout.
5. **PDF size:** `loadLogoDataUrl` downscales the logo to 240px before embedding. The source `logo.png` is ~1024px; embedding it full-res bloats the PDF past Vercel's 4.5 MB request limit (`FUNCTION_PAYLOAD_TOO_LARGE`). Keep PDF payloads small — large embedded images are the usual culprit.
6. **On success:** sets `sent`/`sentAt`/`threadId`, re-asserts `saved`/`everApproved`, persists, and shows the ✓ SENT badge.

### Email composition + MIME (`buildQuotationEmailBodyHtml`, `utils/gmail.js`)

- **Body** = auto greeting (`Dear {customerName},` or `Dear Sir/Madam,`) + the configured **Default Email Message** + the configured **Default Email Signature**. A leading `Dear …,` typed into the default message is stripped to avoid a duplicate greeting. Placeholders `[Name]`, `[Company]`, `[Quote Number]` are filled (`fillEmailPlaceholders`).
- **Default Email Message** is plain text (config storage key `default-email-message.txt`). **Default Email Signature** is rich HTML from a `contenteditable` box (key `default-signature.txt`) so a pasted Gmail signature keeps its formatting and logo; it's injected unescaped (trusted user content).
- **MIME** (`buildRawMessage`): the HTML body is base64-encoded (so `=`/UTF-8/long lines survive). Embedded `data:` images (e.g. a signature logo) are rewritten to `cid:` and attached as inline parts (`extractInlineImages`), because Gmail blocks `data:` images in received mail. Structure nests as needed: `multipart/related` (HTML + inline images) inside `multipart/mixed` (body + PDF). Remote `http(s)` image URLs are left as-is.

### Editing header fields in the Approval section — `data-field`, not `id`

Approval-card header inputs carry their field name in **`data-field`** (e.g. `data-field="kindAttn"`), with no `id`. (The creation-section template at the top of `index.html` uses `id="kindAttn"`; saved/ingested cards use `data-field`.) Any code that reads "which field changed" must use `changedInput.id || changedInput.getAttribute('data-field')`. `updateQuotationFromApprovalSection` (the live autosave handler) maps the changed field to its quotation property — `kindAttn` → `customerName`, `billTo` → `projectName`, `shipTo` → `shipTo`, etc. — and sets `hasUnsavedEdits`. A past bug keyed off `id` only, so edits to Kind Attn updated the PDF's `headerHTML` but never `customerName`, leaving the emailed greeting as "Dear Sir/Madam". Guarded by `tests/approval-edit.test.js`.
