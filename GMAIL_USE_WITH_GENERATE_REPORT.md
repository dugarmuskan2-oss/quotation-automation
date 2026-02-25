# Use Gmail integration with your existing "Run Report" button

There is **no separate "Send to app" button**. The send-to-app step runs when you run your existing **Run Report** (the one that already reads labels and lists email counts and Gmail links).

---

## What to do

### 1. Add the send-to-app code to your report project

- Copy **all** the code from **`apps-script/SendLabeledEmailsToApp.gs`** into your Google Apps Script project (the same project where your Run Report code lives).
- Paste it into an existing file or add a new file (e.g. "SendToQuotationApp").

### 2. Add one line at the end of your Run Report function

Open the function that runs when you click **"Run Report"**. At the **very end** of that function (after the report is built and shown), add this line:

```javascript
sendLabeledEmailsToAppForLabel('Quotation Request');
```

Replace **`'Quotation Request'`** with the **exact name** of the Gmail label whose emails should be sent to the Quotation app (e.g. the same label you use in the report, or a label like "Quotation Request").

### 3. Set Script properties (once)

- **Project settings** → **Script properties**
- **APP_URL** = your app URL (e.g. `https://your-app.vercel.app`), no trailing slash
- **INGEST_SECRET** = same as on the server (optional)

---

## What happens when you click Run Report

1. Your report runs as it does now (labels, counts, Gmail links).
2. At the end, the script calls **sendLabeledEmailsToAppForLabel(...)**.
3. All emails with that label are sent to the Quotation app.
4. The app creates one quotation per email and adds them to the Approval section.
5. Already-imported emails are skipped (no duplicates).

No extra button. One click on **Run Report** does both the report and the send-to-app step.
