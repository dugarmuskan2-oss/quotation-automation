# Gmail Integration Flow

## Overview

Emails with a specific Gmail label are sent to the Quotation Automation app when you generate a report in Google Apps Script. The app processes each email (generates a quotation) and adds it to the **Approval** section with a link back to the original Gmail message.

---

## Flow

1. **Labels added** – Emails in Gmail receive the label (e.g. "Quotation Request").
2. **Report generated** – You run the Apps Script report; it finds all emails with that label.
3. **App receives them** – The script POSTs those emails (body + attachments) to the app.
4. **App processes and adds to Approval** – For each email the app:
   - Runs the existing "generate quotation" logic (AI extraction).
   - Adds the result to the **Approval** section (same list as when you approve in the UI).
   - Stores a **link to the Gmail message** so you can open the email from the app.

---

## Implementation

### Part 1: App (Node/Express)

#### 1. Ingest endpoint

- **Route:** `POST /api/ingest-from-gmail`
- **Body (JSON):**  
  `{ emails: [ { id, subject, from, date, body, attachments: [ { name, contentType, base64 } ] } ] }`
  - `id` = Gmail message ID (used for the "View in Gmail" link).
- **Behaviour:**
  - For each item in `emails`:
    - Decode the first PDF (or first attachment) from `base64` to a Buffer.
    - Call existing quotation generation (e.g. `handleGenerateQuotation` with `emailContent` and file / `enquiryFileId`).
    - Add the returned quotation to the Approval list (same as Approve flow: e.g. `addQuotationToApprovedQuotations`, persist, refresh).
    - Set on the quotation: `emailLink: 'https://mail.google.com/mail/u/0/#inbox/' + id` (or store `gmailMessageId` and build the link in the UI).
  - Return a summary (e.g. `{ created: number, ids: [...] }`).
- **Optional:** Require a header (e.g. `X-Ingest-Secret`) and validate against a secret in env so only your script can call this endpoint.

#### 2. Approval section UI

- When rendering each quotation in the Approval section, if the quotation has `emailLink` or `gmailMessageId`:
  - Show a link: **"View in Gmail"** (or "Open email") with `href = emailLink`, `target="_blank"`.

#### 3. Duplicates (optional)

- To avoid adding the same email twice if you run the report again:
  - In the app: before adding, check if a quotation with the same `gmailMessageId` already exists; skip if so.
  - Or in the script: record which message IDs were already sent and skip them.

---

### Part 2: Google Apps Script

#### 1. Reuse report logic

- Use the same code that builds your report (get all threads/messages with the label).

#### 2. Build payload

- For each message with the label:
  - `id` = message.getId()
  - `subject` = message.getSubject()
  - `from` = message.getFrom()
  - `date` = message.getDate().toISOString()
  - `body` = message.getPlainBody()
  - `attachments` = for each message.getAttachments(): `{ name: getName(), contentType: getContentType(), base64: Utilities.base64Encode(getBytes()) }`
- Build: `payload = { emails: [ ... ] }`

#### 3. POST to app

- `UrlFetchApp.fetch(appUrl + '/api/ingest-from-gmail', { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), headers: { 'X-Ingest-Secret': 'YOUR_SECRET' }, muteHttpExceptions: true })`
- Store `appUrl` and secret in Script Properties.

#### 4. When to run

- Call this "send to app" step at the end of your existing "create report" function, or from a separate menu/button (e.g. "Send labeled emails to Quotation app").

---

## Gmail link format

- **Format:** `https://mail.google.com/mail/u/0/#inbox/` + message ID  
- Replace `0` with the account index if using a different Gmail account.  
- Alternative: `https://mail.google.com/mail/u/0/#label/YourLabelName/` + message ID to open in that label.

---

## Checklist

| Step | Where | What |
|------|--------|------|
| 1 | App | Add `POST /api/ingest-from-gmail` accepting `{ emails: [ { id, subject, from, date, body, attachments } ] }`. |
| 2 | App | For each email: decode attachment, run generate-quotation, add result to Approval list and persist. |
| 3 | App | Set `emailLink` or `gmailMessageId` on each quotation. |
| 4 | App | In Approval section UI, show "View in Gmail" when link/id is present. |
| 5 | Script | After building the report, collect all labeled emails and POST to `/api/ingest-from-gmail`. |
| 6 | (Optional) | Deduplicate by `gmailMessageId` or in script by sent message IDs. |

---

## Summary

**Labels added → Report generated → App reads it → Adds everything to the Approval section with a link to the email.**
