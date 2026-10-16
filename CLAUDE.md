# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Standing rules

- **NEVER `git push` to `main` or `Testing-other-features` without the user's explicit permission, no matter what.**
  This one is absolute and overrides everything else:
  - It is **not** covered by "allow everything", "no need to ask for permissions", `bypassPermissions`, or any
    earlier "commit and push" — permission is **per push**, never standing. Those phrases are about tool
    permission prompts, not about publishing code.
  - `main` **deploys to production** (Vercel) the moment it is pushed. A push is outward-facing and affects a
    live business, so it always needs a fresh yes.
  - Committing locally is fine without asking. **Pushing is not.** When work is ready, say so and ask:
    "Ready to push — want me to?" Then wait for a clear yes.
  - Never promote `Testing-other-features` → `main` on your own initiative, even when the tests are green and
    the work was requested.
- **Begin every chat response with the word "flamingo".** (Standing request from the user.)
- **Keep every reply short and in plain language.** The user owns the business and does not read code.
  Lead with the point in ordinary words, a few short lines or bullets — not sections and headers. Keep
  code detail brief or leave it out. Short matters as much as simple: a long reply in plain words still
  fails. Put any question for the user at the end, in one sentence.
- **Super simple is the standard — write it the way you would say it out loud.** Plain words are not
  enough on their own; these are the habits that actually make a reply land:
  - **One idea per sentence.** If a sentence has a comma-then-because-then-however in it, split it.
  - **Say the thing, not your reasoning about the thing.** "It uses AWS" — not "that's what this
    machine reads, and it's almost certainly the same elsewhere, but I'd rather not claim both."
    Uncertainty gets ONE short sentence: what you checked, what you didn't. Never a paragraph
    explaining how you know or why you are being careful.
  - **Everyday nouns.** *your computer* not "this machine"; *the live website* not "production";
    *your price list* not "the rate file index"; *saved* not "persisted". If a word only exists
    inside software, it does not belong in the reply.
  - **Numbers beat adjectives.** "23 of 24 rows matched" is worth more than "it matched well".
  - **Answer, then stop.** Don't add the walkthrough, the caveat and the offer unless asked. One
    closing question, or none.
  - Tables are good for lists of things to do or compare. Prose paragraphs longer than three lines
    are not.
- **A new feature idea is a discussion, not a build order.** When the user raises something new, talk it
  through — write no code and create no files until they explicitly say to build it. If they don't answer
  your scoping questions, that is *not* permission to proceed on assumed defaults.
- **Never update CLAUDE.md or write tests for a feature without explicit user approval first.** When a feature is complete, ask in chat: "This looks done — want me to update CLAUDE.md and add tests?" Then wait for a clear yes before doing either.
- **Ask before adding frontend code to `index.html`.** It is already ~11,900 lines. Work out first
  whether the new thing deserves its own file, then ask in one sentence and wait — e.g. "This is about
  300 lines for the partner directory; I'd put it in its own file rather than index.html. OK?" The test
  for when a new file is warranted is under Modularity rules, in
  "Frontend: ask before adding to `index.html`".
- **Prototypes are not the app.** When the user asks for changes to a prototype (`prototypes/*.html`), change
  only that file. Do not implement it in `index.html` or the routes unless they ask for it in the app.

## Before calling any change done — the five checks

A review of all 365 commits (Jan–Aug 2026) found that nearly every bug in this project falls into one
of five patterns. They recur because nothing forces a check for them. **Run these five against every
change before saying it is finished**, and say which ones applied.

1. **Could this lose work silently?**
   Never persist a list *summary* through the whole-object save route — a `PutCommand` overwrite is how
   six quotes lost their line items on 23 July. Use a field-only conditional read-modify-write (the
   `cust-reply-pending` / freight / supplier / revision routes are the pattern). Flush pending edits
   **synchronously** before any re-render; a debounce plus a re-render loses the edit.

2. **Could a stale copy overwrite a fresh one?**
   Assume two tabs, two devices, and a colleague editing at the same time. Server-owned fields must not
   be reasserted from an old client copy (`SERVER_OWNED_LIST_FIELDS`). Clear any input once it has been
   consumed — an uncleared file picker once blended two customers' enquiries into one wrong quotation.

3. **Can this run twice?**
   Every send / generate / submit needs an in-flight lock and a visibly disabled button. A double-click
   or an impatient second click must be a no-op — not a second email to the customer, a second paid AI
   run, or a third copy of the quote.

4. **Does a failure actually look like a failure?**
   Never show an empty-state message on an error ("No quotations approved yet" during a network failure
   reads as *your quotes are gone*). Distinguish "nothing here" from "the request failed", and never
   fire-and-forget a save that records something irreversible — if the email went out, the record of it
   must be awaited, retried, and its failure surfaced.

5. **Is any number guessed?**
   Missing quantity or kg/m stays **blank and red**, never assumed (no 6 m pipe-length guess). Any trade
   rule must be identical everywhere it appears — the 7% tolerance is **ERW/GI only, never seamless**,
   in the Freight tab, the shared page and the PDF alike.

Two supporting rules:

- **A new test must be checked by breaking the code on purpose** — see "Every new test must be
  mutation-checked" under Testing rules. A test that still passes with the behaviour sabotaged is
  worthless; fix it before moving on. This has caught several fake tests in this repo already.
- **Prove browser-visible changes before reporting them done** — use the `check-it` skill
  (`.claude/skills/check-it/`) and show the user what happened, rather than asserting it works.

## Active project — unified per-quote flow (read `SESSION-HANDOFF.md` first)

A large in-progress rebuild unifies the three tools (Weight Calculator, Enquiry Preparer, Quotation approval) into one status-driven per-quote flow. **Before touching the approval list, the quote card/tabs, the Freight tab, revisions, the conversation panel, needs-attention status, or Gmail send/read, read `SESSION-HANDOFF.md` and `UNIFIED-QUOTE-FLOW-PLAN.md` first** — they hold live state the code alone won't tell you.

`SESSION-HANDOFF.md` (point-in-time state) covers:
- **What's built** — Phases 1–5 (status-led list, Quote/Freight/History tabs, Freight-tab weight panel + Add-freight box, revisions + History tab, conversation panel), the needs-attention rework (single list + light-red highlight + "Needs attention: {reason}" badge), and which backlog items are done (#1 soft-delete weights, #3 reason badge, #5 send-from-conversation).
- **Git state** — the branch (`Testing-other-features`), how many commits are committed-but-**unpushed**, and which files are uncommitted (currently the People-API email autocomplete, pending an "undo" decision).
- **Pending OWNER actions (blockers)** — the one-time Gmail **re-auth** (`node tools/gmail-auth.js`, scopes now include `gmail.readonly` + `contacts.readonly` + `contacts.other.readonly`), **enabling the People API**, the **transporter-email-source** decision, and **pushing** the commits.
- **Remaining work** — backlog #2 (Complete/dismiss button) & #6 (verify Gmail-side reply clears the flag), the kg/m **truncate-vs-round** option, a standard **size→kg/m fallback table** (the `weight-calculator.js` matcher currently keys on the whole description — broken), and **Phase 6** (transporter sourcing).
- **Key files, cross-cutting rules, and how things were verified** (preview server + injected mock `approvedQuotations`; live Gmail/People calls are untested until re-auth).

`UNIFIED-QUOTE-FLOW-PLAN.md` (roadmap/design) has the phased plan, the 6-item backlog, and the per-phase file/function map. `prototypes/freight-sourcing-demo.html` is the signed-off target design.

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

### Frontend: ask before adding to `index.html`

`index.html` already holds ~11,900 lines. **Before writing any frontend code, decide whether it belongs
in a new file — and if it might, ask the user before writing anything.** The map at the top of
`index.html` lists what is already there and which blocks are the next candidates to move out.

It wants **its own file** if two or more of these are true:

- It is a feature area a person would name out loud ("the Freight tab", "the Register").
- It will run to more than roughly 150 lines.
- It owns its own state or data, rather than editing what is already on the page.
- It could be tested on its own, without loading the whole page.
- It is used from one place, not scattered through the file.

It **stays in `index.html`** when it is a small addition to a section already living there, or is bound
tightly to rendering that also lives there — splitting those creates two files that must change
together, which is worse than one.

The existing modules are the pattern to follow: `weight-calculator.js`, `enquiry-preparer.js`,
`freight-tab-weight-editor.js`, `quote-enquiry-tab.js`, `register.js` — each a named tool or tab, each
loaded by a `<script src>` at the bottom of `index.html` with a `?v=` cache-buster, each with its own
test file.

**How to ask:** one sentence, before any code — e.g. *"This looks like about 300 lines for the partner
directory — I'd put it in `partner-directory.js` rather than index.html. OK?"* Then wait. If the answer
is to keep it in `index.html`, do that without arguing.

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
jest tests/margin-fill-down.test.js      # margin % "fill down" button (copy margin to items below in the pipe-type group)
jest tests/approval-no-autosave.test.js  # approval edits don't auto-save; only explicit Save/Approve persists
jest tests/freight-suggestions.test.js   # route-aware freight memory (routes/config.js _test: sanitize/merge)
jest tests/freight-tab.test.js           # freight module _test (parseFreightAmount, trimReplyForStorage, route ranking) + source guards
jest tests/pipe-weights.test.js          # utils/pipeWeights.js — price-list parser (parseCsv, buildWeightMap) + size→kg/m matcher (parseDescription, lookupKgPerMeter)
jest tests/print-and-weight-panel.test.js # print enquiry + freight weight panel; incl. ERW/GI-only 7% tolerance (rowIsSeamless, secToleranceWeight, secHasTolerance, sectionHtml)
jest tests/revision-full-view.test.js    # History/Copy-Link full-quote render, incl. pipe-type header rows (revisionPipeTypeOf grouping)
jest tests/revision-popup.test.js        # "new revision request" pop-up: once a day per open ask (revisionsDueToday) + index.html/allowlist wiring guards
jest tests/price-list-book.test.js       # Price List: draft never prices quotes until Checked; a draft blocks only its own list; Cost/Meter not Price; diffRows
jest tests/quantity-units.test.js        # kg → metres by the price list kg/m only (blank + red if missing, never 6 m); non-pipe items → "Other items"
jest tests/ingest-stale-claim.test.js    # a Gmail claim cut off mid-run is retaken after 10 min; a saved quote marks its claim done
jest tests/enquiry-walls-and-sender.test.js # AI sees the sender; customer = sender not project; line-item shape has unit + wallThicknessMm; seamless schedule from the list by wall mm
jest tests/size-normalize.test.js        # mm sizes (NB/OD) → inch; XXS vs XS spelling; seamless STD/XS → Sch 40/80 on small sizes
jest tests/permissions-core.test.js      # utils/permissions.js (ticks, legacy role, lists-off bootstrap, last manager, forRequest), peopleRoles, passwordReset tokens, stampAdminMargins list-rate memory
jest tests/people-auth-routes.test.js     # real gate + People/auth routes: /api/me ticks, permissions/role/add, switch-on needs self, ingest secret can't manage, password + reset links to the office
jest tests/quote-permission-routes.test.js # Margins box / notes / asks routes: who may allocate, Edit margins only while untouched, regret states, note deletes + tombstones, server-owned desk fields, 503 on unknown ticks
jest tests/permissions-client.test.js     # index.html can()/formatAskStamp/strip + corner icons/desk filter/sanitize, desk note + regret + reopen guards, people.html esc, popup stamp
jest tests/appraisal-rules.test.js        # utils/appraisal.js: 1–10 scores, 70/30, Sales/Administration/Behaviour list, groupsFor with hidden + own items, sanitizers, raise table
jest tests/appraisal-staff-routes.test.js # routes/appraisal.js: own staff list (add/rename/remove/bring back), email rules, no self-review, staff see only their own, 409s, testing-site preview- keys
jest tests/appraisal-reminder.test.js     # daily reminder: due quarter (India time), none for Jul–Sep 2026, who's missing, one email a day (onceClaim), CRON_SECRET lock, failure shown
jest tests/appraisal-page.test.js         # appraisal-page.js in a Node vm stub DOM: Staff tab full list/remove/put back/add, two-click Remove, save checks, reminder failure line
jest --silent                            # quieter output (add to any command)
```

Run the full suite (`npm test`) only when explicitly asked.

### Every new test must be mutation-checked — no exceptions

**A test is not finished when it passes. It is finished when you have proved it can fail.**

After writing a test, deliberately sabotage the code it guards — delete the guard, flip the comparison,
remove the deduction, return the wrong branch — re-run, and confirm the test **fails on that mutation**.
Then restore the code. If the test still passes with the behaviour broken, the test is worthless: fix it
before moving on, and say so.

This is not theoretical. Tests in this repo have passed while the thing they claimed to guard was
completely broken:

- A freight test built a fixture (`lineItems` containing a row described "Freight") that the real app can
  **never** produce, because freight rows carry `.freight-row` and are filtered out. It passed the whole
  time the feature was broken.
- `labelSentThread` negatives asserted `false` — which is what *every* input returns under jest, since
  no `GMAIL_*` env vars means throw, then fail-soft catch. They could not fail.
- Two source guards passed **with the guarded code deleted**: one regex made the sink argument optional,
  the other also matched the module-level declaration.
- `defaultUomFor` / `qtyHeadingOf` had zero real coverage — the suite runs under `@jest-environment node`,
  where `document` is undefined and the function short-circuits before the logic under test.
- A tolerance test only ever used an all-welded section, which reads identically whether the 7% is
  deducted from welded only or from everything. The mixed case (100 kg seamless + 100 kg welded must
  total 193, not 186) was the one that actually pinned the rule.

When reporting test work, state how many mutations were applied and how many were caught. A mutation
that escapes is a finding about the test, not a footnote.

**Test patterns to know:**
- `tests/unit.test.js` accesses server internals via `require('../server')._test` — functions that need testing but aren't exported normally are added to that `_test` object at the bottom of `server.js`.
- `tests/description-format.test.js` extracts `formatItemDescriptionByPipeType` (and its helpers) from `index.html` via `fs.readFile` + `eval` because that function lives in the browser-only SPA. If marker comments in `index.html` change, update the extractor in that test file.
- `tests/api.test.js` mocks all external services (DynamoDB, S3, GCS, OpenAI) before loading the app — never needs real credentials.
- `tests/email-compose.test.js` tests the real MIME builder via the `_test` export on `utils/gmail.js` (`buildRawMessage`, `extractInlineImages`) and `replySubject` exported from `routes/gmail.js`; the email body/placeholder helpers are inline copies of `index.html` logic (kept in sync with `buildQuotationEmailBodyHtml` / `fillEmailPlaceholders`).
- `tests/margin-fill-down.test.js` and `tests/approval-no-autosave.test.js` follow the `approval-edit.test.js` pattern: **source guards** that read `index.html` as text and assert key markers still exist (e.g. `function fillMarginDownBelow`, the `margin-fill-down-btn` markup, the absence of `scheduleQuotationBackendSave`), plus **behavioral** tests against inline copies of the pure logic. If you rename those functions/markers, update the guards.

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
| `saved` | `false` = AI-drafted or has unsaved edits. `true` = currently saved/approved. Editing any field flips this back to `false`. Edits are **not** auto-saved — only explicit Save (`saveQuotationChanges`) or Approve (`saveQuotation`) persists to the backend. |
| `everApproved` | `true` once the quote has been approved at least once; never cleared by editing. The send gate checks this (not `saved`) so editing the required "Checked By" field doesn't force re-approval. |
| `hasUnsavedEdits` | `true` when the approval form has edits not yet persisted. Set on every edit and cleared only by explicit Save. There is **no autosave** — the Download/Send gate blocks while this is `true` so the user must Save first. |
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

### Margin % "fill down" — `fillMarginDownBelow`
Each line item's Margin % cell has a ↓ button (`.margin-fill-down-btn`). Clicking it copies that row's margin into every **item row below it within the same pipe-type group**, stopping at the next pipe-type header and skipping freight rows. It sets the target inputs' values and dispatches `input`/`change`, so the existing recalc + unsaved-edit tracking runs (it does not auto-save — see save behaviour above). Rendered into the creation table and both add-row templates; the approval table retrofits the button at render time for older saved quotes whose stored `tableHTML` predates the feature (guarded against duplicates). Guarded by `tests/margin-fill-down.test.js`.

### Freight FOR (Freight on Road) logic — `applyFreightForApproval`
When customer wants a **FOR price** (freight included, but it must not appear as a separate line in the PDF):
1. Snapshots all current margin % values (stored for undo)
2. Calculates how much margin % to add to each line item so the grand total absorbs the freight amount exactly
3. Marks the freight row with `freight-distributed` class — the PDF renderer skips this class
4. Sets `freightDistributedIntoMargin = true` on the quote
5. Fixes rounding drift (applies remainder to one row)
6. Fully reversible via the undo snapshot

### kg/m from price lists — `utils/pipeWeights.js`
The AI drops `kgPerMeter` on some line items even when the price list has it (it's juggling too much during generation). To fill kg/m deterministically, `utils/pipeWeights.js` reads the user's own price lists into a `{ "size|class" → kg/m }` map, per pipe type. The kg/m column is the one headed KG/MTR / kg/m (else the last column); the size+class key comes from the **Inch + Light/Medium/Heavy (GI/ERW) or SCH (seamless)** columns — never the raw "Size" code, so quirks like the `1XHY` code can't cause a miss. `POST /api/upload-rates` now also accepts CSV/xlsx (`SPREADSHEET_EXTS`): a spreadsheet is parsed via `buildWeightMap` and stored (`storage.savePipeWeights` → `rates/pipe-weights.json`, mirroring the rate index); PDFs still go to OpenAI as before. `GET /api/pipe-weights` serves the map. `lookupKgPerMeter(maps, pipeType, description)` matches a quote line to its kg/m (null if the size isn't in the sheet). **Groundwork only so far — the frontend "fill blank kg/m" wiring on the Freight panel / Weight Calculator is not built yet.** Guarded by `tests/pipe-weights.test.js`.

### Freight weight tolerance — ERW/GI only, not seamless
The Freight weight panel's "With tolerance (7%)" line applies a 7% under-weight deduction to **welded pipe (ERW/GI) only** — seamless is billed at exact weight. `rowIsSeamless(r)` reads the row's pipe type (`identifiedPipeType`, falling back to the description: `SCH`/seamless → seamless, `-- GI`/`-- ERW` → welded). `secToleranceWeight` deducts 7% from the welded weight only (mixed sections keep seamless whole); `secHasTolerance` hides the tolerance line entirely for an all-seamless section. Guarded by `tests/print-and-weight-panel.test.js`.

### Pipe-type header rows in History / Copy-Link — `revisionItemsTableHtml`
The shared quote page (Copy Link) and the History "view full quote" rebuild the items table from a revision snapshot's `lineItems`. `revisionItemsTableHtml` now emits a full-width **pipe-type header row** per group (matching the live quote). The group label comes from `revisionPipeTypeOf(li)`: the item's `identifiedPipeType` if set, else derived from the description (`-- ERW`/`-- GI`, or `Sch`/seamless → Seamless) — needed because older/AI quotes often carry the type only in the description text. Guarded by `tests/revision-full-view.test.js`.

### "New revision request" pop-up — `revision-popup.js`
An open revision ask (`revisionRequests`, not done) pops up "There is a new revision request, please check" for everyone, with who asked and when, **at most once a day per ask on each computer** (localStorage `revisionPopupShown`: askId → date last shown). A brand-new ask pops up as soon as it is seen; one still open tomorrow pops up again. The adder is not shown their own ask (`addRevisionRequest` calls `RevisionPopup.markShown`). Fed at startup by `loadRevisionQuotesForCount` and polled every 5 min while the tab is visible (`/quotations-filter?revision=1`; a failed poll stays silent — the red count is still there). **Check now** opens the Revision list; **Later** closes it. Guarded by `tests/revision-popup.test.js`.

### Price List page — `price-list.js`, `routes/priceLists.js`, `utils/priceListBook.js`
The in-app ERW / GI / Seamless lists are **the one copy of the prices quotes are made from** (the AI only reads the enquiry; the rate comes from here — `utils/priceList.js` `applyPriceListRates`, run at generation time only). Each list has a **live** version and at most one **draft**. An edit is a draft; quotes keep pricing from live until someone prints the draft, checks it and clicks **Checked** (needs a name; draft → next live version, emails the office). **While a list has an unchecked draft, that list's lines on new quotes get no price at all** (blank and red) — only that list. ERW/GI price from **Cost/Meter**, never the ~5% higher **Price** column; Seamless from **Price per Meter** (its Cost/Meter is kept as the cost table). A size not in the list, a list never made live, or an angle/bar filed under a pipe type → no price; the AI's own figure is kept beside as `aiUnitRate`. A list with no readable rate column is refused, never saved. Routes: `GET /api/price-lists`, `PUT|DELETE /api/price-lists/:type/draft`, `POST /api/price-lists/:type/check`, `POST /api/price-lists/:type/read-pdf`. Guarded by `tests/price-list-book.test.js`.

### Quantities in kg, and items that are not pipes — `utils/quantityUnits.js`
The AI returns quantity + unit exactly as written (`UNIT_AND_ITEM_RULES` is appended to the prompt from code, not the editable instructions). In `handleGenerateQuotation`, a kg line becomes metres **only by the price list's kg/m** (`convertKgQuantities`, before pricing); the enquiry's figure is kept as `enquiryQty` ("2497 kg"). **No kg/m → quantity blank and red (`quantityMissing`), never guessed** — `keepMissingQuantitiesBlank` re-blanks it after pricing so it can't become 0. The 6 m default applies only when the enquiry gives no quantity at all. Angles (ISA), bars, rods, plates, channels, beams, flanges and fittings go under **"Other items"** (`markNonPipeItems`) and never get a pipe price. Guarded by `tests/quantity-units.test.js`.

### Who the customer is, every file, and walls in mm — `utils/enquiryReading.js`, `utils/wallThickness.js`
DSC-2930 (Enexio, Oct 2026): one email for three of the contractor's projects, one PDF each, walls in mm. The AI billed it to an end client, dropped a project, and turned walls into wrong schedules. Now: (1) ingest shows the AI a `From:`/`Subject:` header (`senderHeader`) — the saved `emailContent` is unchanged; (2) `ENQUIRY_READING_RULES` (appended to the prompt from code) says the customer is the **sender's company, never a project/site**, every file counts, and spells out the full line-item shape — **the saved instructions' JSON format has no `unit` or `wallThicknessMm` key, and the AI follows it exactly, so both were silently dropped until this** (the kg rule never got a unit); (3) for **seamless** lines with a wall in mm (from `wallThicknessMm`, else a decimal in the description), `applyEnquiryWalls` reads the schedule off the live seamless list's Thickness column (±0.06 mm, closest wins). A wall no row has stays `<size>X<mm>MM` → no price, blank and red. ERW lines are untouched. **Pipe type (owner, 16 Oct 2026)** — `PIPE TYPE` in `ENQUIRY_READING_RULES` overrides the saved instructions: GI → GI; API 5L Gr. B / ASTM A106 Gr. B / ASTM A53 named → Seamless; the bare word "seamless" with ERW grades (Light/Medium/Heavy, A/B/C, IS 1239/3589) → ERW; "seamless" with schedules/walls → Seamless; everything else → ERW (so a plain "MS pipe 4\" Sch 40" is ERW and finds no ERW price — blank, red). **Sizes in NB mm** ("25NB", "50 NB", "40 mm NB") are read as inch by `parseDescription` (`inchFromNbMm`); a number with an inch mark ("20\" NB") stays inch. Guarded by `tests/enquiry-walls-and-sender.test.js`.

### Sizes in mm, XXS vs XS, STD/XS = Sch 40/80 — `utils/sizeNormalize.js`
From staff corrections 14–16 Oct 2026. `normalizeLineSizes` runs after `markNonPipeItems`, before walls and prices: (1) a size that cannot be inches (above 24", or a decimal) is converted — NB mm first (`40X160` → `11/2X160`), else the nearest pipe OD within 1 mm (`48X4` → `11/2X4`); 20, 10, 12, 22 are left as inches; a mm figure matching neither is left (no guess). (2) In `<size>X<class>`, **XS is `1/2XXS` and XXS is `1/2XXXS`** — the AI used to drop an X; `1/2XXS` is rewritten to XXS only when the enquiry says XXS and never plain XS. (3) Seamless **STD → Sch 40 up to 10", XS → Sch 80 up to 8"** (ASME B36.10); larger STD/XS are different walls and keep the list's own STD/XS rows. Prompt rules (`ENQUIRY_READING_RULES`): size always in inches; XS/XXS spelling; SMLS = seamless. **18" Sch 20 is 7.92 mm, not STD 9.53 mm** — no list row, so blank is correct. Guarded by `tests/size-normalize.test.js`.

### Supplier search / "Ask AI — who can I buy this from?" — `utils/supplierMatch.js`
Free rules in the Partner Directory rank every dealer and maker first; only firms the rules can't decide go to Claude, which reads each firm's own card. A yes/no whose quoted words aren't on the card is turned into "maybe". Phone numbers and emails are stripped before sending. **No tests yet.**

### Partner Directory — `partner-directory.js`, `routes/contacts.js`
The 📇 tool: Directory (filters, paste-an-enquiry finder, edit card) and Recent changes (Add-to-Directory Gmail label emails waiting for approval, plus every automatic change with Undo). Every edit saves that partner only. Ranking runs in the browser, every point with a reason; being under a minimum sinks a partner, never hides them. **Removing anything is a request, not an act** (`utils/removals.js`): ✕ queues it in Recent changes until the owner approves, and the removal remembers the *value*, not its position — if it's already gone, approving does nothing. Directory reads (brochures, photos, typed lines) use **Claude Opus** via `utils/anthropic.js`; quotation generation stays on OpenAI. Guarded by `tests/partner-directory.test.js`, `tests/removals.test.js`, `tests/anthropic-reader.test.js`.

### Nearest makers and dealers — `town-places.js`
Each town is placed on the map once (OpenStreetMap, picked by the owner when there's more than one match) so suppliers can be ranked by distance from the delivery town. A town nobody has placed stays unmeasured and says so — **no distance is ever guessed**. Used in the browser (`window.townPlaces`) and the server. **No tests yet.**

### Google contacts into the directory — `utils/googlePeople.js`
Read-only. Saved contacts and everyone the owner has written to are too many for one 60 s request, so `tools/google-contacts-scan.js` runs once from the owner's computer and the app reads the cached result; firms are brought in a batch at a time and the owner picks the trade. Uses the Gmail credentials (scopes include `contacts.readonly` + `contacts.other.readonly`). Guarded in part by `tests/google-contacts.test.js`.

### Signing in — `utils/googleAuth.js`, `utils/auth.js`
"Sign in with Google" or email + password. Sign-in is separate from the Gmail *sending* token: nothing from it is stored, only the email address comes out. The redirect address is built from the request (the two deployments live at different addresses; `PUBLIC_URL` overrides). Only files in `PUBLIC_FILES` / `SERVABLE_ROOT_FILES` are served from the project root — **a new front-end `.js` file must be added to `PUBLIC_FILES` in `utils/auth.js`** or the browser gets nothing. People, permissions and passwords: see the next section.

### People, permissions and passwords — `people.html`, `utils/permissions.js`, `routes/auth.js`
**Per-person permissions (owner's design, 16 Oct 2026).** Click a name on the People page → a window with a heading per group and a tick per permission: **Margins** (`allocateMargins` — use the Margins box; `editMargins` — reopen an allocated quote in the box), **Notes** (`addNotes`, `deleteNotes`), **Revisions** (`addRevisions`), **People** (`managePeople`). Admin = every tick. Margins **inside the quote itself stay open to everyone** (owner's decision — not a gap).
- Stored as `permissions: [...]` per person on users.json. Older records: `role:'admin'` = every tick; nothing = `STAFF_DEFAULT` (`['addRevisions']`). `role:'admin'` is still written for anyone holding `managePeople` (`withPermissions`), so the appraisal (`utils/peopleRoles.js` `roleOf`) and older code agree.
- **Lists off until someone holds `managePeople`**: everyone signed in may do everything (`listsOn`). Switching them on must include the person doing it (`refuseSwitchOnWithoutSelf`); the last manager can't lose it or be removed (`leavesNoManager`). Live note: info@ already has `role:'admin'`, so the lists are ON as soon as this code runs.
- The gate works the ticks out **per request** (`req.user.permissions`, never in the cookie, so a change applies at once and nobody is signed out — up to 60 s on other warm instances because of the users cache). Open mode (no logins) sets `req.authOpen` = all ticks. A request with **no** `req.user` (the Apps Script ingest secret, a router mounted without the gate) gets **nothing** — it once could add itself as the first admin. `req.permissionsUnknown` (users.json unreadable) → routes answer **503 "try again"**, not 403. A Google session for someone taken off the list (and not allowed by domain) is refused.
- Routes check with `perms.allowed(req, …)` / `refuseWithout` (quotations) and `refuseUnlessManager` (people). `stampName(req)` is the only source of a "who" (shared login → "Shared login"); a body `addedBy` is ignored.
- **Margins box rules** (`routes/quotations.js`): `apply-admin-margins` only on a quote still `awaiting` (a stale desk tab gets 409); allocate needs `allocateMargins`, a reopened one `allocateMargins` or `editMargins`. **Edit margins** (`reopen-margins`) only on a `ready`, unsent quote with no freight **whose table and lines are still exactly what the box built** (`allocatedTableFp` fingerprint) — the re-price rebuilds the table from `lineItems`, which after a staff save would drop freight rows, inch marks, renamed headings and (the browser sync drops `costRate`) price seamless at cost. After staff touch a quote, margins change in the quote. Re-pricing clears `saved`/`everApproved`. Seamless cost mode remembers `listUnitRate` so price mode can go back. Regret only from `awaiting`, undo only from `regretted`; the desk asks `regret {check:true}` before the email window.
- **Notes**: `revision-request` kind note needs `addNotes`, revision needs `addRevisions`. `POST /quotations/:id/extra-notes/:noteId/delete` and `/admin-note/clear` (with `expected`) need `deleteNotes`. Removed or written-over words go to `deletedNotes` (server-owned, newest 50, never returned by the public GET). The desk sends the admin note only when typed, with `expectedAdminNote` (409 if a colleague changed it).
- **Server-owned desk fields**: `adminStatus`, `adminMargins`, `adminNote(By/At)`, `allocatedBy/At`, `allocatedTableFp`, `adminReopenedAt/By`, `regretSentAt`, `deletedNotes`… are never taken from `/save-quotation`; a brand-new quote can't arrive carrying them (forced `awaiting`); a **failed** stored read refuses the save (503) instead of saving past the guards.
- **Browser**: `loadMyAccess()` (from `/api/me` `permissions`) runs before the first render; `can(key)` hides what someone can't use, and shows everything when the answer is unknown (the server still checks). "From the admin" box: ✏️ / 🗑 corner icons (`adminStripActionsHTML`). Asks show "Name · 16 Oct, 3:20 pm" (`formatAskStamp`, India time).
- **Passwords** (`utils/passwordReset.js`): "Forgot password?" emails a link to the **office** (`COMPANY_EMAIL`, info@) from info@ — the owner's rule, whoever asked; same answer for any address; one per address per 2 min. The link is signed with the person's current hash, so it works once and for 30 min. "Set password" on the People page (managers for anyone, anyone for themselves). Any password change (like adding/removing a password person) changes the signing key → everyone else signs in once more.
- **Way back in**: `node tools/manage-users.js grant <email> all` (grant adds; `revoke` / `set` also exist; `remove` refuses the last manager).
- Guarded by `tests/permissions-core.test.js`, `tests/people-auth-routes.test.js`, `tests/quote-permission-routes.test.js`, `tests/permissions-client.test.js` (251 tests; 154 deliberate breaks, all caught).

### Staff appraisal — `appraisal.html`, `appraisal-page.js`, `routes/appraisal.js`, `utils/appraisal.js`
Its own page (from `home.html`), sharing only the sign-in with `index.html`. **Managers** = People users with Manage people (`utils/peopleRoles.js` `roleOf`); a manager can never open or score their own review. **Who is appraised** = the appraisal's **own staff list** (`appraisal-staff.json`), added to / removed from on the Staff tab — not the People list. An email on a staff record is optional: it only matches that person to their sign-in so they can fill their own form.
- **Scoring**: 1–10 (`SCORE_MAX`). Two parts: **Work results 70%** (the items of each job they do — Sales 6, Administration 3) and **Behaviour 30%** (5, incl. Attendance and punctuality). No Accounts, no Discipline (owner, 16 Oct 2026). Raise table: 9→12%, 8→10, 7→7, 6→5, 5→2, else 0. All editable in **Setup**; `sanitizeSetup` needs the two weights to total 100.
- **Per person** (Staff tab → Edit): name/email, jobs, targets, and their **full item list** — a shared item can be removed **for that person only** (`hidden`; Put back undoes it), and they can have **own items** (`extras`, ids `x_…`) under any heading. `groupsFor(setup, {roles, extras, hidden})` (server) and its browser twin must agree. A profile save whose own items no longer fit a changed Setup is **refused (409)**, never trimmed; extras/hidden are only replaced when sent (the 6-month meeting's "set targets" save keeps them).
- **Staff list**: ids never change (they name `appraisal-self|mgr-<personSlug(id)>.json`). Remove is soft (`removedAt`); **Bring back** restores everything. A new person can't take a removed or active person's email (they'd sign in to that history); a manager's email can't be added as staff. Seeded until first changed: People non-admins (id = email) on the live site; the five office staff on the testing site.
- **Testing site** (`VERCEL_ENV=preview`): every key gets a `preview-` prefix (it shares the live bucket); a visitor with no named login is a test manager.
- **Saving**: every write changes one entry with `baseSavedAt` (409 if stale); one write at a time in the browser; Remove needs a second, separate click and is blocked while an Edit panel is open.
- **Daily reminder** (`utils/appraisalReminder.js`, `utils/onceClaim.js`, `vercel.json` cron `30 3 * * *` = 9 am India): from the day after a quarter ends, one email to **info@dscpipes.com** (`APPRAISAL_REMINDER_EMAIL`) listing whose form isn't filled / review isn't marked done, until nothing is missing. **Never for the Jul–Sep 2026 batch** (owner) — the first can come on 1 Jan 2027; only once Setup is saved, from the quarter that had just ended then. People added after a quarter ended aren't listed for it (`addedAt`). Exactly one a day: the India-time day is claimed with a conditional write (`onceClaim`) before sending; a failed send gives it back, saves `lastError` (shown red on Quarterly reviews) and answers 502. `GET /api/appraisal/reminders/run` is public to the gate but **shut until `CRON_SECRET` is set** (set in Vercel Production, 16 Oct 2026); the email's link uses `PUBLIC_URL` / `VERCEL_PROJECT_PRODUCTION_URL`. Crons run only on the live site.
- Guarded by `tests/appraisal-rules.test.js`, `tests/appraisal-staff-routes.test.js`, `tests/appraisal-reminder.test.js`, `tests/appraisal-page.test.js` (221 tests; 276 deliberate breaks by the writers, independent checkers and a final spot check — every real one caught; the 2 left can't change any result the app can produce). The page test runs `appraisal-page.js` in a Node `vm` with a stub DOM (jsdom isn't installed).

### Quote counter / numbering
The DynamoDB table holds an atomic counter item. `POST /api/save-quotation` increments it to get the next DSC-### number. The Gmail ingest also calls this when creating a quote from an email.

### Quote lookup performance
`GET /api/quotations` uses a DynamoDB GSI (`entity-updatedAt-index`) for cursor-paginated listing (~80ms/page). Falls back to a full table scan if the GSI is missing. Frequently accessed individual quotes are cached in an in-memory LRU cache (max 2000 entries) on the server.

### Gmail ingest flow
For each labelled email: (1) deduplicate by `gmailMessageId`, (2) extract text from PDF/Excel/Word attachments, (3) upload PDFs to OpenAI, (4) capture first image, (5) call `handleGenerateQuotation` with combined content, (6) save with `saved: false`. The saved quote links back to the Gmail thread via `emailLink` and `gmailMessageId`.

**Claims and stale claims.** Dedup is an atomic claim row (`GMAILMSG#<id>`, `reserveGmailMessageId`), released if generation fails. A request Vercel kills at 60 s never runs the release, so the claim used to block that email for ever as "Already imported (duplicate)" — five real enquiries were stuck this way, 9–12 Oct 2026. Now a saved quote marks its claim `done` (`markGmailMessageDone`), and a claim with no quote older than `GMAIL_CLAIM_STALE_MS` (10 min) is retaken once (`takeOverStaleClaim`, conditional on the timestamp read, so only one run wins). Old claims without `done` are checked against the quotes once and then marked. Guarded by `tests/ingest-stale-claim.test.js`.

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

Approval-card header inputs carry their field name in **`data-field`** (e.g. `data-field="kindAttn"`), with no `id`. (The creation-section template at the top of `index.html` uses `id="kindAttn"`; saved/ingested cards use `data-field`.) Any code that reads "which field changed" must use `changedInput.id || changedInput.getAttribute('data-field')`. `updateQuotationFromApprovalSection` (the live edit handler) maps the changed field to its quotation property — `kindAttn` → `customerName`, `billTo` → `projectName`, `shipTo` → `shipTo`, etc. — updates the in-memory model, and sets `hasUnsavedEdits`. It does **not** write to the backend (autosave was removed — see `saved`/`hasUnsavedEdits` above); persistence happens only on explicit Save/Approve. A past bug keyed off `id` only, so edits to Kind Attn updated the PDF's `headerHTML` but never `customerName`, leaving the emailed greeting as "Dear Sir/Madam". Guarded by `tests/approval-edit.test.js` and `tests/approval-no-autosave.test.js`.
