# Session handoff — unified per-quote flow rebuild

> **Point-in-time state** (last updated **19 Aug 2026**). Pairs with `UNIFIED-QUOTE-FLOW-PLAN.md`
> (the roadmap/design) — this file is the *current state*: what's built, git state, and what's
> pending. Read both when picking this up in a new session.
>
> ⚠ The previous version of this file was written 21 Jul and had gone a month stale. If anything
> below contradicts your memory of an older session, this file wins.

## Git state (READ FIRST)

| Ref | At | Meaning |
|---|---|---|
| `origin/main` | `1e316d1` (7 Aug) | **live in production** (Vercel) |
| `origin/Testing-other-features` | `1e316d1` (7 Aug) | same commit as main |
| local `main` | `1e316d1` (7 Aug) | in sync |
| local `Testing-other-features` | `61157c4` (19 Aug) | **5 commits ahead of everything — unpushed** |

Everything up to **7 Aug is deployed**. These five commits exist only on this machine:

- `61157c4` The "Customer replied" badge now sticks (19 Aug)
- `6d712bb` Supabase behind a switch: the app can run on either database (18 Aug)
- `a6a29d4` A quote card notices when the quote changed on another device (13 Aug)
- `c4851a5` Tests for the Cc/Bcc send semantics (12 Aug)
- `2aec2e1` Cc and Bcc behave like ordinary email — either one is enough to send (11 Aug)

**Uncommitted (untracked) in the working tree:**
- `tests/quote-freshness.test.js` — the test file for `checkQuoteFreshness` (the `a6a29d4` work).
  Written and passing; just never committed. Belongs with that feature.
- `prototypes/partner-directory-demo.html` — a **new prototype, design discussion in flight**:
  a "Partner directory" (transporters / suppliers) with reason-carrying pills, recipient chips and
  an AI-read-back panel. Not signed off; nothing built from it in the app. Per the standing rule,
  prototypes are not the app — build nothing from it until the owner says so.

⚠ **Never push either branch without a fresh, explicit yes** (CLAUDE.md standing rule; `main`
deploys to production on push). The owner has repeatedly chosen to defer pushing — that is a
choice, not an oversight. Offer at a natural stopping point; don't nag.

## The big effort

Unify the three original tools (Weight Calculator, Enquiry Preparer, Quotation approval) into
**one status-driven per-quote flow**. Roadmap + backlog = `UNIFIED-QUOTE-FLOW-PLAN.md`.
Signed-off target designs: `prototypes/freight-sourcing-demo.html`,
`prototypes/margin-allocation-demo.html`, `prototypes/quote-enquiry-demo.html`.

**All 6 phases are built, committed, and (through 7 Aug) deployed.** The month since has been
features on top plus heavy end-to-end hardening — not phase work.

## What's built (state, not history)

**The quote card** — status-led list, Quote / Freight / Enquiry / History tabs, conversation panel.

- **Freight tab** (`freight-tab-weight-editor.js`): editable + splittable weight panel, soft-deleted
  rows (struck through, "Add back", excluded from totals and Print), Add-freight box wired to the
  FOR engine, per-shipment amounts when split, **7% tolerance on ERW/GI only** (seamless bills
  exact), a Send-freight-enquiry composer with transporter chips, **one email per transporter**
  (own Gmail thread each), route-aware remembered suggestions, and a Check-for-replies that parses
  a price (`parseFreightAmount`) and offers **"Use Rs X"** to fill the Add-freight box.
- **Enquiry tab** (`quote-enquiry-tab.js`) — the **buying-side mirror** of the Freight tab: ask
  suppliers/dealers for their best rate without leaving the quote. Reuses the standalone Enquiry
  Preparer's row builder verbatim (`buildEnquiryRowModel` via its `_test` export) so the two
  formats can never drift apart. Recipients go in **Bcc**, one email per supplier so each reply
  lands in its own thread. Suppliers are remembered **per pipe type** (GI / ERW / Seamless).
- **Cc/Bcc** behave like ordinary email across freight + supplier enquiries — **either one alone is
  enough to send** (no To required); a Bcc-only mail is addressed to ourselves. Two boxes only.
- **Revisions + History** — always-on Save-as-Revision, full-quote History view, `(Rev N)` on the
  document, the email, the list and the number box; revision asks take rich text and pasted images.
- **Freshness check** (`checkQuoteFreshness` in `index.html`) — on every re-open of a card, notices
  the quote changed on another device (or under a colleague's hands) and refreshes it **without
  clobbering unsaved edits here**. This is what cured "the revision app shows what was loaded prior".

**Margin desk** (admin allocation, above the approval list) — per-type margin controls, shared staff
list, admin note with rich paste, per-pipe-type include tick, soft-delete of accidental quotes with
a 7-day auto-purge, Send-to-approval, and the fixed Regret reply sent in-thread.

**Enquiry Register** (`register.js`, 4th tool tab) — live report over every quotation mirroring the
Google-Sheet layout: merged enquiry-date cells, per-day totals, dual status (App + Manual), auto
Checked By, Sent On, days enquiry→quote (**skips Sundays, keeps Saturdays**), value, plus the manual
workflow columns saved per quote via `POST /api/quotations/:id/register-meta`. Loads **one month at
a time** (`?month=YYYY-MM`) with a per-month localStorage cache. The Sheet mirror still uses `?days=N`.

**Copy Link / shared quote page** — a full internal quote page: every version, weight, freight and
supplier replies, one merged timeline (enquiry activity sits between the versions it explains), and
the **real archived PDF per version**.

**Replies** — global "Check all replies" sweep, auto-check on load, supplier replies pulled
automatically when the app opens. The **"Customer replied" badge is now durable**: a field-only route
`POST /quotations/:id/cust-reply-pending` (conditional read-modify-write, same pattern as the
freight / supplier / revision routes) persists that one boolean for **list summaries too**, so the
badge survives reloads and other devices. It cannot touch line items — deliberately, because the
whole-object save is exactly how six quotes lost their items on 23 July. `custReplyPending` is in
`SERVER_OWNED_LIST_FIELDS`, so a colleague clearing it by replying is picked up rather than
overwritten by this tab's stale copy.

**Ingest** — enquiry attachments retained at ingest, oversized PDFs turned into extracted text +
page images rather than skipped, oversized photos compressed, a photographed enquiry shrunk instead
of refused, every enquiry image sent to the AI.

**Mobile** — the app is usable on a phone (`1e316d1`, the last deployed commit).

**Supabase behind a switch (18 Aug — newest architecture change).**
`storage/supabaseShim.js` is a drop-in stand-in for `DynamoDBDocumentClient` backed by Postgres.
The routes keep issuing the exact DynamoDB commands they issue today; the shim translates them to
SQL over **one table `ddb_items`** whose `item` column holds each record verbatim. Nothing in
`routes/` or `gmail-ingest/` changes. It supports **only** the command shapes this codebase uses and
**throws loudly** on anything else (a silent no-op would corrupt data). Dynamo semantics are kept
where the app can tell the difference: `ConditionalCheckFailedException` by name, and
`LastEvaluatedKey` / `ExclusiveStartKey` pagination in the same shape.

- **The switch:** `QUOTES_DB=supabase` **plus** `SUPABASE_DB_URL` → Supabase at boot; anything else
  (or unset) → DynamoDB. Rollback is flipping the env var back. A shim load failure falls back to
  DynamoDB with a warning.
- **Current local `.env`:** `SUPABASE_DB_URL` **is** set, `QUOTES_DB` is **not** → the app still
  runs on **DynamoDB**. Nothing has been cut over.
- `tools/ddb-to-supabase-sync.js` copies DynamoDB → Supabase (Scan only, **read-only on the AWS
  side**), idempotent (upserts on id), prints no secrets.
- ⚠ The local `.env` is **S3-active** (bucket `quotationauto`, **shared with production**) — be
  careful with test writes.

**Backlog status** (`UNIFIED-QUOTE-FLOW-PLAN.md`): **#1 done** (soft-delete weights), **#3 done**
(reason badge), **#5 done** (send from the conversation panel), **#6 done** (`61157c4`; verified
live — the flag reads back true, clears back to false, appears in the LIST payload, and the quote's
11 line items + `tableHTML` were byte-identical before and after). **#4 is moot** after the
needs-attention rework. **#2 (Complete/dismiss button) is the only one left** — no dismiss handler
exists in `index.html` today.

## Pending OWNER actions

1. **Push the 5 commits** — needs an explicit yes (see Git state).
2. **Decide on the Supabase cutover** — the switch is built and the sync script exists, but nothing
   is cut over. Flipping it on production is a live-data decision and the owner's call alone.
3. **People API** — the contact dropdown (`GET /api/contact-suggestions`) has been in active use in
   both the freight and supplier composers since early Aug, so this looks resolved. If suggestions
   ever come back empty, check DevTools → Network → `contact-suggestions` → `error` field; the fix
   is enabling the People API in the Google Cloud project.
4. Gmail **re-auth is done** (3 Jul; scopes `gmail.send` + `gmail.readonly` + `contacts.readonly`
   + `contacts.other.readonly`).

## Remaining work

- **Commit** `tests/quote-freshness.test.js` alongside the freshness feature.
- Backlog **#2** — a Complete/dismiss button on a flagged quote. Define per trigger what it clears.
- **Partner directory** — prototype only, awaiting the owner's decision. Build nothing yet.
- Optional: kg/m **truncate vs round** (`utils/calculations.js` uses `.toFixed(2)` = rounds; the
  owner's rule says truncate to 2 decimals).
- Optional kg/m backstop: a standard size→kg/m fallback table. Note the matcher in
  `weight-calculator.js` keys on the **whole description** (broken) — a real fix extracts size +
  class + type. `utils/pipeWeights.js` already does this properly from the uploaded price lists.
- `costRate` extraction is still **not** in the AI instructions; seamless cost-mode falls back to
  `unitRate` when it's missing (margins still stamp correctly).

## Key files

`index.html` (the SPA — list, tabbed card, needs-attention, conversation panel, recipient dialog,
contact autocomplete, `checkQuoteFreshness`) · `freight-tab-weight-editor.js` (Freight tab) ·
`quote-enquiry-tab.js` (supplier Enquiry tab) · `enquiry-preparer.js` (standalone Preparer — the row
builder both reuse) · `register.js` (Enquiry Register tab) · `weight-calculator.js` ·
`routes/quotations.js` (persistence, list projection, field-only routes) · `routes/gmail.js` +
`utils/gmail.js` (send / thread read / contact search) · `routes/config.js` (staff list, freight
suggestions, defaults) · `server.js` (`handleGenerateQuotation`, DB init + the `QUOTES_DB` switch) ·
`storage/supabaseShim.js` + `tools/ddb-to-supabase-sync.js` (the Supabase option) · `gmail-ingest/`
(ingest) · `utils/pipeWeights.js` (price-list kg/m).

## Cross-cutting rules to respect

- **No autosave + save-gate.** Edits set `hasUnsavedEdits`; only explicit Save/Approve persists;
  Download **and** Send stay gated. The field-only routes (`cust-reply-pending`, freight, supplier,
  revision) are the exception — each writes one field via a conditional read-modify-write and
  cannot clobber edits or items.
- **Never save a list summary through the whole-object route.** A `PutCommand` overwrite is exactly
  how six quotes lost their line items on 23 July.
- Approval-card inputs use **`data-field`, not `id`**.
- **Modularity** (CLAUDE.md): routes → `routes/`, Gmail → `utils/gmail.js`, freight/weight →
  `freight-tab-weight-editor.js`, supplier enquiry → `quote-enquiry-tab.js`; never `server.js`.
- **DynamoDB 400 KB item cap** — keep `tableHTML` out of revision snapshots.
- **Prototypes are not the app.** A change asked for in `prototypes/*.html` stays in that file.
- **Never** update CLAUDE.md or add tests for a feature without explicit owner approval.

## How things are verified

Full suite green as of 19 Aug: **58 suites, 1693 tests** (`npx jest --silent`, ~17s). The per-file
mapping is in CLAUDE.md — run only the relevant file after a change.

Frontend logic is tested by **extracting the real function out of `index.html`** (or a module's
`_test` export) and running it against a scripted `fetch` plus a minimal DOM stand-in — alongside
**source guards** that assert key markers still exist in `index.html`. Renaming a guarded function
means updating its guard. UI is checked with the preview server on `localhost:3000` with a mock
`approvedQuotations` injected.

Live verification does now happen where it matters: the `cust-reply-pending` route was round-tripped
against the live server on the Supabase copy, with the quote's line items and `tableHTML` compared
byte-for-byte before and after.
