# Super detailed steps: Step 2 and Step 3

---

# STEP 2: Generate quotation without sending a response

**Goal:** Call the same logic that runs when a user clicks “Generate Quotation”, but get the result as a JavaScript object (no HTTP response). That way the Gmail ingest route can use it to build the full quotation and save it.

---

## 2.1 What “generate without response” means

- The normal flow is: **browser** → `POST /api/generate-quotation` → **handleGenerateQuotation(opts, res)** → **res.json(quotationData)**.
- For ingest we need: **ingest route** → same **handleGenerateQuotation** logic → **get the quotationData in code** (no `res` sent to a client).
- So we need a wrapper that:
  1. Calls `handleGenerateQuotation(opts, res)` with a **fake `res`**.
  2. When `handleGenerateQuotation` calls `res.json(data)`, the wrapper **resolves a Promise** with that `data`.
  3. If it calls `res.status(400).json(...)` or any error response, the wrapper **rejects** the Promise with that payload.

---

## 2.2 Where the code lives

- **File:** `server.js`
- **Location:** Search for `function generateQuotationData` (around line 1987).
- **Snippet:**

```javascript
function generateQuotationData(opts) {
    return new Promise((resolve, reject) => {
        const res = {
            _status: 200,
            status(code) { this._status = code; return this; },
            json(data) {
                if (this._status >= 400) reject(data);
                else resolve(data);
            }
        };
        handleGenerateQuotation(opts, res).catch(reject);
    });
}
```

---

## 2.3 What each part does

| Part | Purpose |
|------|--------|
| `return new Promise((resolve, reject) => { ... })` | So the ingest route can `await generateQuotationData(opts)` and get the result or catch an error. |
| `res._status = 200` | Default status. If the handler calls `res.status(400)` (or 500, etc.), the next call is `res.json(...)`, and we need to know it was an error. |
| `res.status(code)` | Saves `code` in `this._status` and returns `this` so the real handler can chain: `res.status(400).json({ error: '...' })`. |
| `res.json(data)` | If `_status >= 400`, **reject** the promise with `data` (so the caller gets an error). Otherwise **resolve** with `data` (the quotation object). |
| `handleGenerateQuotation(opts, res).catch(reject)` | Run the real handler. If it throws (e.g. OpenAI failure), the promise rejects. |

---

## 2.4 What you pass in (`opts`)

`opts` is the same object the normal “Generate Quotation” API uses:

| Field | Type | Required | Meaning |
|-------|------|----------|--------|
| `emailContent` | string | One of these required | Plain text body of the email (or enquiry). |
| `fileContent` | string | One of these required | Alternative: raw text from an uploaded file. |
| `enquiryFileId` | string | Optional | OpenAI file ID of an uploaded PDF (from `uploadEnquiryFileToOpenAI`). |
| `instructions` | string | Yes | The AI instructions (from “get instructions” / `getInstructionsContent()`). |

Example for Gmail ingest:

```javascript
const opts = {
    emailContent: email.body,        // from the Gmail payload
    instructions: instructions,      // from getInstructionsContent()
    enquiryFileId: enquiryFileId     // from uploadEnquiryFileToOpenAI(firstPdfAttachment), or undefined
};
const aiResult = await generateQuotationData(opts);
```

---

## 2.5 What you get back (success)

When the handler calls `res.json(...)` with a 2xx status, the Promise resolves with that object. It’s the same shape as the “Generate Quotation” API response, for example:

```javascript
{
  customerName: "...",
  companyName: "...",
  projectName: "...",
  phoneNumber: "...",
  mobileNumber: "...",
  quotationDate: "...",
  lineItems: [
    {
      originalDescription: "...",
      identifiedPipeType: "...",
      quantity: "100",
      unitRate: "50.00",
      marginPercent: "10",
      finalRate: "55.00",
      lineTotal: "5500.00"
    }
    // ... more rows
  ],
  _ai: {
    raw: "...",
    model: "gpt-5.2",
    files: ["..."]
  }
}
```

You use `customerName`, `companyName`, `projectName`, `quotationDate`, `lineItems`, `phoneNumber`, `mobileNumber` (and optionally `_ai`) in Step 3 and when building the full quotation to save.

---

## 2.6 What happens on error

- If the handler does **res.status(400).json({ error: '...' })** (or 500, etc.), the Promise **rejects** with that object, e.g. `{ error: 'No content provided' }`.
- If **handleGenerateQuotation** throws (e.g. OpenAI API error), the Promise **rejects** with that error.
- In the ingest route you typically **catch** and then push an entry to the `errors` array for that email and continue with the next one.

---

## 2.7 How to test Step 2 in isolation (optional)

1. Start the server: `node server.js`.
2. Ensure you have **instructions** saved (via the app or by putting a file at the path your server uses for instructions).
3. In a temporary route or in Node REPL (if you load the app), call:

```javascript
const instructions = await getInstructionsContent();
const result = await generateQuotationData({
  emailContent: 'Customer: ABC, need 50 pipes 2" NB',
  instructions
});
console.log(result.customerName, result.lineItems?.length);
```

4. You should see the same kind of object as the “Generate Quotation” API returns, with no HTTP response involved.

---

# STEP 3: Build HTML from the AI result

**Goal:** Turn the AI result (especially `lineItems`) into the **table HTML** and **header HTML** that the Approval section expects. This is done in code only (no browser DOM), so it can run on the server when processing Gmail emails.

---

## 3.1 Why HTML is needed

- The Approval section renders each quotation with **fixed structure**: a **header** block (date, customer, quote number, bill to, ship to, etc.) and a **table** of line items (description, quantity, rates, amount).
- Those are stored as **strings**: `quotation.headerHTML` and `quotation.tableHTML`.
- When the app loads quotations (e.g. from DynamoDB), it injects these strings into the page. So for Gmail-created quotations we must build the **same kind of HTML** on the server.

---

## 3.2 Where the code lives

- **File:** `gmail-ingest/htmlBuilder.js`
- **Exports:**  
  `escapeHtmlForTable`, `computeGrandTotalFromLineItems`, `buildTableHTMLFromLineItems`, `buildHeaderHTMLFromQuotation`

---

## 3.3 Helper 1: `escapeHtmlForTable(str)`

**Purpose:** Make a string safe to put inside HTML (so user/AI content doesn’t break the page or create XSS).

**Steps:**

1. If `str` is `null` or `undefined`, return `''`.
2. Convert to string, then replace:
   - `&` → `&amp;`
   - `<` → `&lt;`
   - `>` → `&gt;`
   - `"` → `&quot;`
3. Return the result.

**Used in:** Every place we insert AI or email text into HTML (table cells, header input `value=""` attributes).

**Example:**

```javascript
escapeHtmlForTable('2" NB x 6m')  // '2&quot; NB x 6m'
escapeHtmlForTable('<script>')     // '&lt;script&gt;'
```

---

## 3.4 Helper 2: `computeGrandTotalFromLineItems(lineItems)`

**Purpose:** Sum (quantity × finalRate) for all rows and return both the number and a formatted string.

**Steps:**

1. If `lineItems` is missing or not an array, return `{ total: 0, formatted: '0.00' }`.
2. Loop over each item:
   - `qty = parseFloat(item.quantity) || 0`
   - `rate = parseFloat(item.finalRate) || 0`
   - Add `qty * rate` to a running total.
3. Return `{ total: number, formatted: total.toFixed(2) }`.

**Used in:** You can use this for a grand total label; in the current flow the grand total is also computed inside `buildTableHTMLFromLineItems` and returned there.

---

## 3.5 Helper 3: `buildTableHTMLFromLineItems(lineItems)` — detailed steps

**Purpose:** Build the full `<table>...</table>` string that matches the Approval section’s quotation table (same columns and class names).

**Input:** `lineItems` = array from the AI result (Step 2), each item with at least:

- `originalDescription` or `identifiedPipeType`
- `quantity`, `unitRate`, `marginPercent`, `finalRate` (and optionally `lineTotal`)

**Steps:**

1. **Empty case**  
   If `lineItems` is missing, not an array, or length 0, return an empty table with the same header row and empty `<tbody>`, and `grandTotal: 0`, `grandTotalFormatted: '0.00'`.

2. **Header row (one string)**  
   Build a single string for `<thead>`, with one `<tr>` and 8 `<th>` cells in this order:
   - Empty (width 50px)
   - "S. NO"
   - "ITEMS AND DESCRIPTION"
   - "QTY (Mtrs)"
   - "BASE RATE" (class `col-base-rate`)
   - "MARGIN %" (class `col-margin`)
   - "Rate per Mtr"
   - "AMOUNT"

3. **Body rows**  
   For each element in `lineItems` (index `i`):
   - Parse `quantity` and `finalRate`; compute `lineTotal = quantity * finalRate`.
   - Add `lineTotal` to a running `grandTotal`.
   - Escape all user-facing strings with `escapeHtmlForTable(...)`.
   - Build one `<tr class="item-row">` with 8 `<td>` cells in this order:
     - Empty cell
     - S. NO: `i + 1`
     - Description (escaped)
     - Quantity (escaped)
     - Base rate: `₹` + escaped `unitRate`
     - Margin % (escaped)
     - Rate per mtr: `₹` + escaped `finalRate`
     - Amount: `₹` + `lineTotal.toFixed(2)`

4. **Assemble**  
   - Full table = `<table id="quotationTable">` + thead + `<tbody>` + all row strings joined + `</tbody></table>`.
   - Return:
     - `tableHTML`: that string
     - `grandTotal`: number
     - `grandTotalFormatted`: `grandTotal.toFixed(2)`

**Output shape:**

```javascript
{
  tableHTML: "<table id=\"quotationTable\">...",
  grandTotal: 12345.67,
  grandTotalFormatted: "12345.67"
}
```

**Important:** Column count and class names (`item-row`, `row-number`, `col-base-rate`, `col-margin`) must match what the front-end Approval section uses, so styling and layout stay correct.

---

## 3.6 Helper 4: `buildHeaderHTMLFromQuotation(q)` — detailed steps

**Purpose:** Build the **header block** HTML (quotation date, kind attn, phone, mobile, prepared by, assigned to, checked by, quote number, bill to, ship to) so it matches the creation header structure and the Approval section’s expectations.

**Input:** `q` = object with any of:

- `quotationDate`, `customerName` or `kindAttn`, `companyName`, `projectName`, `billTo`, `shipTo`
- `phoneNumber`, `mobileNumber`, `quoteNumber`
- `preparedBy`, `assignedTo`, `checkedBy`

**Steps:**

1. **Take each field** from `q` and fall back to `''` if missing (e.g. `quotationDate = q.quotationDate || ''`).
2. **Escape every value** with `escapeHtmlForTable(...)` (for use in HTML attributes).
3. **Map to the right labels:**
   - Kind attn ← `customerName` or `kindAttn`
   - Bill to ← `companyName` or `projectName` or `billTo`
   - Ship to ← `projectName` or `shipTo`
4. **Build one big HTML string** that matches the structure in `index.html` (creation header):
   - Outer: `<div class="quotation-header" id="creationQuotationHeader">`
   - Inside: a block with class `quote-meta` containing two columns of `meta-row` divs, each with a `<span>` label and an `<input data-field="..." class="header-editable" value="...">`.
   - `data-field` values must be: `quotationDate`, `kindAttn`, `phoneNumber`, `mobileNumber`, `preparedBy`, `assignedTo`, `checkedBy`, `quoteNumber`, then `billTo` and `shipTo` in the `bill-ship` block.
5. Return that string.

**Important:** Reusing the same class names and `data-field` names keeps the Approval section’s behavior (e.g. editing, PDF export) consistent for Gmail-created quotations.

---

## 3.7 Where Step 3 is used in the flow

- **In `gmail-ingest/ingestLogic.js`**, inside `buildQuotationToSave()`:
  1. It calls `buildTableHTMLFromLineItems(aiResult.lineItems)` to get `tableHTML` and `grandTotalFormatted`.
  2. It calls `buildHeaderHTMLFromQuotation({ ...aiResult, quoteNumber })` to get `headerHTML`.
  3. It puts those into the quotation object that gets saved to DynamoDB and later shown in the Approval section.

So Step 2 gives you `aiResult` (with `lineItems` and header fields); Step 3 turns that into `tableHTML` and `headerHTML`; then the rest of the ingest logic adds quote number, terms, email link, and saves.

---

## 3.8 How to test Step 3 in isolation (optional)

In Node (from the project root, with `gmail-ingest` available):

```javascript
const { buildTableHTMLFromLineItems, buildHeaderHTMLFromQuotation } = require('./gmail-ingest/htmlBuilder');

const lineItems = [
  { originalDescription: '2" NB', quantity: '10', unitRate: '50', marginPercent: '10', finalRate: '55' }
];
const table = buildTableHTMLFromLineItems(lineItems);
console.log(table.grandTotalFormatted);  // e.g. "550.00"
console.log(table.tableHTML.includes('item-row'));  // true

const header = buildHeaderHTMLFromQuotation({
  quotationDate: 'January 1, 2025',
  customerName: 'ABC Corp',
  quoteNumber: '108'
});
console.log(header.includes('creationQuotationHeader'));  // true
```

---

## Quick reference

| Step | What it does | Where it lives |
|------|----------------|----------------|
| **Step 2** | Run “Generate Quotation” logic and get the result object (no HTTP). | `server.js` → `generateQuotationData(opts)` |
| **Step 3** | Turn AI `lineItems` and header fields into `tableHTML` and `headerHTML`. | `gmail-ingest/htmlBuilder.js` → `buildTableHTMLFromLineItems`, `buildHeaderHTMLFromQuotation` |

After Step 2 you have the AI result; after Step 3 you have the HTML strings to store on the quotation and show in the Approval section.
