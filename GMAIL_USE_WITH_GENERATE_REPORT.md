# Use Gmail integration with your existing "Run Report" button

**GmailLabelReport.gs** already includes both the report and the send-to-app step. When you run **Run Report**, the report runs and labeled emails (in the report’s time window) are sent to the Quotation app.

---

## Two ways to create quotations

### Run Report
- Runs the full report (labels, counts, Gmail links) and sends emails **in the report’s time window** to the app.
- Use this for your normal daily/scheduled run.

### Create Quotations (separate button)
- Sends **only** labeled emails from **after the last report run** to the app. No new report row.
- Use this when new emails arrive (or get labeled) after the report was generated.
- Processes emails from the last report end time up to now.

---

## What to do

### 1. Add the send-to-app code to your report project

- Copy **all** the code from **`apps-script/SendLabeledEmailsToApp.gs`** into your Google Apps Script project.
- Copy **`apps-script/GmailLabelReport.gs`** into the same project (it includes Run Report and Create Quotations).

### 2. Set Script properties (once)

- **Project settings** → **Script properties**
- **APP_URL** = your app URL (e.g. `https://your-app.vercel.app`), no trailing slash
- **INGEST_SECRET** = same as on the server (optional)

### 3. Buttons and menu

- **Run Report** button: You already have this (A1:B3).
- **Create Quotations** button: Added automatically next to Run Report (C1:D3) when you open the sheet. To make it clickable like Run Report: **Insert** → **Drawing** → draw a rectangle → **Save and Close** → place it over the Create Quotations cells → right-click the drawing → **Assign script** → `runCreateQuotationsNow`.
- **Gmail Report** menu: Run `onOpen` once from the script editor, then use **Gmail Report** → **Create Quotations** (no button setup needed).

---

## What happens when you click Run Report

1. The report runs (labels, counts, Gmail links).
2. Emails in the report’s time window are sent to the Quotation app.
3. The app creates one quotation per email and adds them to the Approval section.

## What happens when you click Create Quotations

1. Emails with the label **Quotation Automation/Create Quotation** that arrived **after** the last report run are sent to the app.
2. The app creates quotations for them. No report row is added.
