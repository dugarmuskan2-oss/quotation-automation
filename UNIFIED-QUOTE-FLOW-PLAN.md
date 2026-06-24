# Unified Per-Quote Flow — Design + Implementation Plan

> **Handoff doc.** Captures the freight/sourcing redesign: what the prototype proves, the phased
> plan to build it into the real app, the decisions still open, and where we are. Read this first
> if you're a fresh session picking this up.

## TL;DR — where we are (as of this writing)

- ✅ **Prototype is complete and signed off** by the owner: `prototypes/freight-sourcing-demo.html`
  (a clickable, standalone mock — no live data, no app code touched).
- ✅ **Implementation plan is done** (this file).
- ⏭️ **Next step: build Phase 1** (status-led list) into `index.html`. Not started yet.
- The owner is non-technical — explain in plain language, keep each phase shippable on its own.

---

## The goal

Unify the three separate tools (Weight Calculator, Enquiry Preparer, Quotation approval) into **one
status-driven per-quote flow**, so the owner stops juggling the app + Gmail + CRM. Every quote
becomes a single card you open, with everything for that quote in one place.

## What the prototype demonstrates

Open `prototypes/freight-sourcing-demo.html` (only **DSC-108** is interactive). It mocks:

**The list (status-led)**
- Two groups: **Needs attention** (a spotlight) and **All quotes** (the permanent home — *every*
  quote is always here). A needs-attention quote appears in **both**; once handled it drops out of
  the spotlight but stays in All quotes. It's one record shown in two views (no sync issue).
- One **next-action button per row** (Send / Resend / Add freight / Reply) so you can act without
  expanding.
- A **"Check for replies"** refresh button next to *Needs attention* (+ "Updated HH:MM"), which in
  the real app = checking Gmail for new transporter/customer replies.
- **Needs-attention triggers** (final, agreed): **New** (AI-drafted from an enquiry email, unreviewed),
  **Transporter reply in**, **Revised-but-not-resent**, **Customer replied**. ❌ *"Approved but not
  sent" was deliberately removed.*

**The card (tabs): Quote · Freight · History**
- Opens on the **current revision** always; the original is read-only history.
- **Quote tab:** header + items + total, **one** status-driven primary button (Send→Resend) +
  **Export ▾** (Print/Download) — *not* a row of buttons. On the **right side**: a **Conversation**
  panel showing all thread messages with an **always-visible reply box** ("Type your reply" + Send),
  plus **View in Gmail**. (Two-column on a normal screen; stacks on narrow.)
- **Freight tab:** stacked controls —
  - **Calculate weight** (collapsible) → editable weight table: edit qty/kg-m, add/delete rows
    (red trash button), **Total weight** footer row, **Print**, **Calculate other weight** to split
    into two shipments with a **⠿ grip** to drag rows between them (grip only shows when split),
    **Request freight** per box (shows even with one shipment).
  - **Send freight enquiry** (collapsible) → **To — transporters** search first (Gmail-backed idea,
    see Phase 6), then **Pickup / Drop** (plain text fields), an **editable message preview**, Send →
    transporter threads → Check replies → "Use Rs X" drops the number into Add freight.
  - **Add freight to quote** (always open, **light-blue** panel): amount(s) + **Line item / FOR**,
    a **Total freight** line when split. A revision is created **only when freight is added to an
    already-sent quote** (button reads "Add freight & create Rev 1"); on an unsent quote it just adds.
- **History tab:** original (Superseded, read-only) + Rev 1 (Current); opening always lands on current.

**Customer conversation / replies**
- Reply in-app (instant) **or** reply from Gmail directly. Either way the quote reconciles to
  *"whoever sent the last message"*: if you have the last word it leaves Needs attention. Gmail-side
  replies update on the **next "Check for replies" sync** (the prototype shows this lag with a
  "not synced" badge).

---

## Implementation roadmap (real app = `index.html` + Node/Express backend)

**Shape:** ~60% reuse, ~40% new. The freight engine, weight calculator, Gmail send/threading, the
approval list, and persistence already work — they mostly need re-homing into a tabbed card. New:
the status engine, a revisions structure in DynamoDB, and Gmail thread *reading*.

### Phase 0 — Decisions to lock (no code) — needs the OWNER
1. **Revision rule:** create a revision only on **Resend** of an already-sent quote (recommend yes).
2. **Threading:** customer thread (`threadId`) vs. per-transporter freight threads — tracked
   **separately** (different conversations).
3. **Revision numbering:** immutable IDs displayed as "Rev 1/2" (so deleting one doesn't renumber).
4. **Status source:** **derive on read** via a pure helper initially (no schema/GSI cost).
5. **Split + FOR semantics:** distribute each shipment's freight independently or combined? (affects rounding)
6. **Transporter recipients (Phase 6):** hardcoded list / Gmail-label scan / manual entry? *(unresolved)*

### Phase 1 — Status-led two-group list — **START HERE** — size M
Pure frontend, no backend, no Gmail.
- Touches: `displayAllApprovedQuotations`, `buildAllApprovedQuotationsHTMLForList`, badge rendering.
  `loadQuotationsFromBackend` unchanged (existing fields suffice).
- New: pure helpers `needsAttention(q)`, `determineLiveAction(q)`, `statusPill(q)` — live in
  `index.html`; **every later phase reuses them.**
- Gotcha: derive status from existing booleans (`sent`, `everApproved`, `hasUnsavedEdits`) only;
  guard for old quotes lacking `revised`/`custReplyPending`.

### Phase 2 — Tabbed card shell (Quote/Freight/History) — size S–M
- Touches: `buildApprovalSplitLayout` (wrap current layout as the Quote tab), `renderApprovalFolderContent`.
- New: tab CSS + click handlers. Gotcha: **tab state must survive the re-render Save triggers** —
  store active tab on a `data-active-tab` DOM attribute, not a JS variable.

### Phase 3 — Freight tab (weight editor + Add-freight box) — size L
- Reuse `weight-calculator.js` (`parsePipeWeightCsv`, `recalculateFromTable`, `addPipeRowToTable`,
  red-tint, `printWeightTable`, `calculateFromQuotationNumber`) and the freight engine in `index.html`
  (`applyFreightForApproval`, `undoFreightForApproval`, `buildFreightRowHtml`,
  `recalculateApprovalQuotationTotals`, PDF skip of `freight-distributed`).
- New: helper file **`freight-tab-weight-editor.js`** (per modularity rules). Add `freightMode`
  (`line`/`for`) and `sec` (1/2) per line item.
- Gotchas: state **per-open-quote** (prototype uses one global `S`); split+FOR rounding; verify
  `sec`/`freightMode` round-trip through save before building drag.

### Phase 4 — Revisions + History tab — size M
- Touches: `POST /api/save-quotation` (detect "sent + edited" → append snapshot), `gmail-ingest/ingestLogic.js`
  (`revisions: []` init), new `buildHistoryTabContent` in `index.html`.
- New: `revisions[]` = `{ revisionId, createdAt, change, snapshot }`. Logic in `routes/quotations.js`.
- Gotchas: **DynamoDB 400 KB item limit** — cap retained revisions, keep heavy `tableHTML` out of
  snapshots; old quotes have no `revisions[]` (treat as original-only).

### Phase 5 — Conversation panel + Gmail thread reading — size L — **HARD DEPENDENCY**
- **Requires adding the `gmail.readonly` scope** and **re-running `node tools/gmail-auth.js`.** The
  current token (`gmail.send` + `gmail.metadata`) **cannot read message bodies.** Do this first.
- Touches: `tools/gmail-auth.js` (scope), `utils/gmail.js` (new `fetchThreadMessages` + MIME parse —
  use a real parser like mailparser, not regex), `routes/gmail.js` (new `GET /api/thread-messages`,
  `POST /api/send-reply`, `GET /api/check-thread-for-replies`), `index.html` (conversation UI).
- Reuse: all of `utils/gmail.js` send/MIME, reply-subject de-dup, recipient chips.
- Gotchas: quota-sensitive (~2 units/thread read) — cache per quote + debounce the refresh; manual
  button only (no auto-poll); Gmail-side replies update only on next check (document it).

### Phase 6 — Transporter freight sourcing (prototype → real) — size L — **DO LAST**
- Reuse `POST /api/send-email`, recipient chips. New: `freightThreads[]` per quote; each transporter
  is a separate thread. **Blocked on Phase 0 #6** (where transporter emails come from). Keep it a
  prototype until that's decided.

**Recommended first build: Phase 1** — most visible win (triage list), no permissions/schema, and it
forces the status helpers everything else reuses.

---

## Cross-cutting rules to respect throughout

- **No autosave + save-gate:** edits set `hasUnsavedEdits=true` but never persist; only explicit
  Save/Approve writes. Download **and** Send stay blocked while `hasUnsavedEdits`; send also requires
  `everApproved || saved` + "Checked By" filled. New freight/weight edits must dispatch `input`/`change`
  so existing recalc + unsaved tracking fires — never silently write to the backend.
- **Modularity (CLAUDE.md):** routes → `routes/*.js`; Gmail helpers → `utils/gmail.js`; reusable
  freight/weight logic → a new helper file (e.g. `freight-tab-weight-editor.js`), never `server.js`;
  SPA render helpers stay in `index.html`.
- **Approval-card inputs use `data-field`, not `id`** — edit handlers read
  `input.id || input.getAttribute('data-field')`.
- **DynamoDB 400 KB item ceiling:** `revisions[]`, `messages[]`, `freightThreads[]` grow the payload —
  lazy-load on expand, cap history, keep `tableHTML` out of snapshots.
- **Never update CLAUDE.md or add tests without explicit owner approval.** Existing source-guard tests
  (`approval-edit`, `margin-fill-down`, `approval-no-autosave`) assert markers in `index.html`;
  renaming a guarded function means updating those guards.

## Key files
- `prototypes/freight-sourcing-demo.html` — the signed-off target design (reference for everything).
- `index.html` — the SPA (list, card, freight engine, weight tab is loaded from `weight-calculator.js`).
- `weight-calculator.js` — weight logic to reuse in Phase 3.
- `utils/gmail.js`, `routes/gmail.js` — Gmail send/threading (extend for Phase 5).
- `routes/quotations.js` — persistence + listing (extend for Phase 4 revisions).
- `gmail-ingest/ingestLogic.js` — where ingested quotes are built.
- `tools/gmail-auth.js` — OAuth scopes (Phase 5 needs `gmail.readonly` added + re-auth).
