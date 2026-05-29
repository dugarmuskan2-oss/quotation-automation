# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm start          # run server on PORT (default 3000)
npm run dev        # same as npm start
npm run test:e2e   # end-to-end smoke tests
```

## Testing rules

Run only the relevant test file — not the full suite — after each change:

```bash
jest tests/calculations.test.js   # utils/calculations.js changed
jest tests/api.test.js            # any route or server.js changed
jest tests/unit.test.js           # pure helper functions changed
jest --silent                     # quieter output (add to any command)
```

Run the full suite (`npm test`) only when the user explicitly asks.

Open `index.html` directly in a browser — it communicates with the running server via fetch.

## Architecture

### Overview

Full-stack quotation automation tool. Users paste an email or upload a file, AI generates a freight quotation, they approve and save it.

- **Frontend**: `index.html` — single-file SPA (~400KB), all HTML/CSS/JS in one file
- **Backend**: `server.js` — Express app (~870 lines), setup + generate/chat/gmail routes only
- **Routes**: `routes/rates.js`, `routes/config.js`, `routes/quotations.js` — one file per feature
- **Utils**: `utils/calculations.js` — `calculateLineItem`, `parseFlexibleNumber`
- **Storage**: `storage/index.js` — unified GCS / S3 / local file layer
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

If neither S3 nor GCS is configured, files are stored locally.

### Core API Routes

- `POST /api/generate-quotation` — AI quotation from email/text content
- `POST /api/generate-quotation-file` — AI quotation from uploaded file or image
- `POST /api/upload-rates` — Upload Excel rate/pricing file
- `POST /api/save-quotation` — Save approved quotation to DynamoDB
- `GET /api/quotations` — List all saved quotations (paginated)
- `POST /api/ingest-from-gmail` — Receive emails from Google Apps Script
- `POST /api/ai-chat` — Chat with AI about a quotation

### Key Known Issue

`/api/generate-quotation` (server.js ~line 1950) only passes `emailContent`, `fileContent`, and `instructions` to `handleGenerateQuotation()`, but the function also accepts `enquiryFileId`, `enquiryFileIds`, and `enquiryImageDataUrl`. If those are needed from a JSON body request, they must be added to the destructure on that line. The `/api/generate-quotation-file` route handles these correctly.

### Gmail Integration

`gmail-ingest/` contains the server-side intake logic. `apps-script/SendLabeledEmailsToApp.gs` runs in Google Apps Script, pulls emails from Gmail labels, and POSTs them to `/api/ingest-from-gmail`. Secure with `INGEST_SECRET` env var + `X-Ingest-Secret` header.

### Rate File Index

`rates-index.json` caches OpenAI file IDs for uploaded rate files so they don't need to be re-uploaded on every quotation request (fast path in `handleGenerateQuotation`).
