# Gmail Ingest Module

This folder contains the server-side logic for the Gmail integration: receiving emails from Google Apps Script and adding them to the Approval section.

## Files

| File | Purpose |
|------|--------|
| **htmlBuilder.js** | Builds table and header HTML from AI result (no DOM). `escapeHtmlForTable`, `buildTableHTMLFromLineItems`, `buildHeaderHTMLFromQuotation`, `computeGrandTotalFromLineItems`. |
| **attachmentUtils.js** | Decodes base64 attachments and picks the first PDF. `decodeBase64Attachment`, `getFirstPdfAttachment`, `getFirstAttachment`, `isPdfAttachment`. |
| **ingestLogic.js** | Core flow: duplicate check (by `gmailMessageId`), generate quotation, build quotation object, save. `processOneEmail`, `processAllEmails`, `buildQuotationToSave`. |
| **route.js** | Express route factory. `createIngestFromGmailRoute(ctx)` returns the handler for `POST /api/ingest-from-gmail`. |

## Context (injected by server)

The route and ingest logic expect a `ctx` object with:

- `getInstructionsContent()` → Promise\<string\>
- `getDefaultTermsContent()` → Promise\<string\>
- `generateQuotationData(opts)` → Promise\<object\> (AI result)
- `getNextQuoteNumber()` → Promise\<number\>
- `saveQuotation(quotation)` → Promise\<void\>
- `findQuotationByGmailMessageId(messageId)` → Promise\<object | null\> (duplicate check)
- `uploadEnquiryFileToOpenAI(fileLike)` → Promise\<string | null\> (OpenAI file ID)

The server wires these in `server.js` and passes `ctx` to `createIngestFromGmailRoute`.

## Request format

`POST /api/ingest-from-gmail`  
Body (JSON):

```json
{
  "emails": [
    {
      "id": "Gmail message ID",
      "subject": "...",
      "from": "...",
      "date": "ISO date string",
      "body": "Plain text body",
      "attachments": [
        { "name": "file.pdf", "contentType": "application/pdf", "base64": "..." }
      ]
    }
  ]
}
```

Optional header: `X-Ingest-Secret` (required if `INGEST_SECRET` env is set).

## Response

```json
{
  "success": true,
  "created": 2,
  "ids": [ 1234567890, 1234567891 ],
  "errors": [ { "emailId": "abc", "error": "Already imported (duplicate)" } ]
}
```

## Duplicate handling (Option B)

Duplicates are detected in the app: before saving, `findQuotationByGmailMessageId(email.id)` is called. If a quotation with that `gmailMessageId` already exists, the email is skipped and an error entry is returned.
