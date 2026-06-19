# DSC Pipes — Workflow Redesign (Split-at-Send Model)

## The one rule

Status is split at **the moment the quote is sent to the customer.**

- **Before sent → the APP's job.** It tracks the operational work Bigin can't see (drafted, being checked, waiting on a freight/dealer rate).
- **After sent → BIGIN's job.** The commercial pipeline you already track there: awaiting customer, negotiating, stalled, won, lost.

Nothing is tracked in both places. The instant a quote is sent, it leaves the app's attention list and hands off to Bigin with a "View in Bigin" link.

---

## What already exists (do NOT rebuild)

A code review showed most building blocks are already there — they're just separate tabs you bridge by retyping the quote number.

| Feature | Status | Where |
|---|---|---|
| Quotation generator (paste/upload → AI quote → edit → approve) | ✅ Built | `index.html` Creation section |
| Weight Calculator (by quote no., AI-extract, or CSV; red-tints missing weights) | ✅ Built | `weight-calculator.js` |
| Enquiry Preparer (OUR REQUIREMENT / YOUR OFFER table; copies Outlook-ready HTML) | ✅ Built | `enquiry-preparer.js` |
| Add Freight (as a line item) | ✅ Built | `index.html` |
| Freight FOR (distributes freight into item margins; hidden in PDF; with undo) | ✅ Built | `index.html` `applyFreightForApproval` |
| Assigned To / Checked By fields | ✅ Built | `index.html` |
| Gmail ingest (auto-creates `DSC-###` quotes, dedupes, links to Gmail) | ✅ Built | `gmail-ingest/` |
| Talk to AI about a quote | ✅ Built | `index.html` AI Response section |
| Approval list (searchable, paginated) | ✅ Built | `index.html` Approval section |

So weight calc, enquiry generation, freight, FOR, Gmail-in, and assignment are **done**. The gap is that they're disconnected.

---

## The status model (app side — pre-send only)

A small field, just 5 values, ending at the handoff:

1. `Needs check` — AI drafted it, nobody's verified yet
2. `Awaiting freight` — enquiry out to a transporter
3. `Awaiting dealer/factory price` — enquiry out to a supplier
4. `Reply in` — a supplier replied; rate needs applying
5. → `Sent` — quote goes to customer; **hands off to Bigin and leaves the app's list**

That's the whole pipeline the app needs. No stalled, won, or lost — those are Bigin's.

---

## One screen instead of three tabs

Today: to do freight on DSC-108 you open Quotation, switch to Weight Calc and retype the number, switch to Enquiry Preparer and retype it again.

Proposed: **one screen per quote number.** The quote is always visible; the optional tools (Freight, Dealer/Factory enquiry) appear as sections on that same screen — sharing the quote number, never retyped. Add only the sections a given quote needs.

---

## Your work queue (just two buckets)

The app's home screen answers one question — *"what needs me before a quote can go out?"*

- **New to check** — freshly AI-drafted quotes awaiting verification
- **Replies in** — supplier (freight/dealer/factory) replied; rate ready to apply

Nothing else. Stalled / won / lost you check in Bigin, exactly as you do today.

---

## The handoff to Bigin

- You keep creating the Bigin deal manually (avoids duplicate companies/contacts).
- When a quote is **sent** (or a revised quote saved), the app offers a "View in Bigin" link, and — optionally, later — pushes the quote PDF onto the deal so you stop uploading manually.
- The app never writes commercial pipeline stages. Bigin stays the single source of truth for everything post-send.

---

## What actually needs building

| To build | Difficulty | Notes |
|---|---|---|
| Pre-send status field (5 values) | Easy | The spine everything else hangs on |
| Unify 3 tabs → one per-quote screen | Medium | The change that removes the most friction |
| Work queue (New to check + Replies in) | Medium | Needs the status field first |
| Send email from app (freight/dealer/customer) | Medium | Gmail API write permission (one-time) |
| Capture replies + AI reads rate | Medium–Hard | Save Gmail thread id on send; refresh pulls the reply |
| Bigin: PDF attach on send | Easy | One API call; deal creation stays manual |

---

## Build order (revised — smaller than first thought)

**Phase 1 — Make it one workflow (the real win)**
1. Add the pre-send status field
2. Unify the three tools onto one quote screen
3. Build the two-bucket work queue

**Phase 2 — Email out**
4. Send freight / dealer / customer emails from the app (reuse the Enquiry Preparer's HTML)

**Phase 3 — Email in**
5. Save thread id on send; a Refresh button pulls the reply; AI extracts the rate; you confirm → applied

**Phase 4 — Bigin convenience**
6. Auto-attach the quote PDF to the Bigin deal on send

---

## Risks

1. **Reply matching** — if a supplier forwards instead of replying, the thread breaks and you paste the rate manually.
2. **Gmail write permission** — sending from the app is a one-time Google OAuth approval.
3. **Bigin PDF attach** — needs the Bigin API key connected; skip it and everything else still works.
