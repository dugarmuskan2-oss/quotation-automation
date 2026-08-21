---
name: check-it
description: Prove a change actually works by driving the real app in a browser — start the server, load a mock quote, click the thing that changed, screenshot it. Use when the user says "check it", "show me it works", "did that work", or after finishing any change the browser can display.
---

# Check it

The owner does not read code. "Done" is only believable with a picture. This skill turns a claim
into evidence.

## First: is there anything to see?

Look at what actually changed (`git status`, `git diff`, or what you just edited).

- **Browser-visible** (`index.html`, `freight-tab-weight-editor.js`, `quote-enquiry-tab.js`,
  `register.js`, `weight-calculator.js`, `enquiry-preparer.js`, anything that renders) → run the
  steps below.
- **Not browser-visible** (a route's internals, `utils/`, tests, tooling) → say so plainly, run the
  relevant jest file instead, and stop. Do not start a server that cannot prove anything. Theatre is
  worse than nothing.

## The rule that matters most

⚠ **The local `.env` points at the REAL database and the production S3 bucket** (`quotationauto`).

- Drive a **mock quote injected into the page**, not a real one.
- Never click Save, Approve, Send, Regret, or delete against real data during a check.
- If a check genuinely needs a real quote, say so and ask first.

## Steps

1. **Start the app** — `preview_start` with `{name: "quotation-app"}` (from `.claude/launch.json`,
   port 3000). Reuses the server if it is already running.

2. **Load a mock quote.** In the page, set `approvedQuotations` to an array holding one realistic
   quote object, then render and open it:

   ```js
   approvedQuotations = [mock];        // declared in index.html
   displayAllApprovedQuotations();     // paints the list
   toggleQuotationFolder(mock.id);     // opens the card
   ```

   Build the mock from the field names in CLAUDE.md's "Quotation Data Structure" — note it is
   `originalDescription` / `unitRate` / `lineTotal`, **not** `description` / `baseRate` / `total`.
   Give it whatever the change needs: line items with `kgPerMeter` and `identifiedPipeType` for
   weight or freight work, `revisions` for History, `custReplyPending` for the badge, and so on.
   Stub `fetch` for any Gmail or People endpoint the flow touches so nothing leaves the machine.

3. **Drive the actual change.** Click, type, switch tabs — reach the specific control that changed,
   the way the owner would. `read_page` gives you refs; `computer` clicks them.

4. **Check for damage** — `read_console_messages` and `preview_logs` for errors, and
   `read_network_requests` if the change touches a route.

5. **Show it.** Screenshot the result and give it to the user. If the change is visual, that picture
   *is* the answer. Say in one line what it shows.

6. **If it is broken** — fix the source file (never patch the live page to fake a pass), reload, and
   go again from step 3. Report what was wrong and what fixed it.

## Reporting back

Short and plain — the owner is not reading code:

- What you clicked, and what happened.
- The screenshot.
- Anything still not right, stated honestly. A partly-working change reported as working is the one
  failure this skill exists to prevent.
