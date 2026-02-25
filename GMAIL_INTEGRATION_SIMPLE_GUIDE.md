# Gmail → Quotation App: Simple Guide (No Tech Jargon)

## What this does, in plain English

Right now, when you get an email that needs a quotation, you probably:
1. Open the email  
2. Copy the text (and maybe open any attachment)  
3. Open the Quotation app  
4. Paste the text (and upload the file)  
5. Click “Generate Quotation”

**With the Gmail integration**, you can do this instead:

1. In Gmail, put a **label** on the emails you want to turn into quotations (e.g. “Quotation Request”).  
2. In Google Apps Script, you run a **“Send to app”** action (or your report that includes it).  
3. The app **automatically** creates a quotation for each of those emails and puts them in the **Approval** section.  
4. You open the app and see all those quotations ready, with a **“View in Gmail”** link to open the original email.

So: **label emails → run the script → quotations appear in the app.** No copy-paste.

---

## What you need to have

- Your **Quotation app** running and reachable on the internet (e.g. on Vercel).  
- A **Google account** (Gmail) where the enquiry emails arrive.  
- A **Google Apps Script** project (the one you use for your “report” that reads labels).  
- **Instructions** and **rate files** already set up in the Quotation app (same as when you generate quotations manually).

---

## Steps you need to take

### Step 1: Create a Gmail label (if you don’t have one)

1. Open **Gmail** in your browser.  
2. On the left, find **Labels** (you may need to click “More” to see them).  
3. Click **“Create new label”**.  
4. Name it something clear, e.g. **“Quotation Request”**.  
5. Save.

**From now on:** when you get an email that should become a quotation, add this label to it (from the email, use the label button or move it to a folder with that label).

---

### Step 2: Get your app’s web address

1. Open your **Quotation app** in the browser (the same place you usually generate quotations).  
2. Look at the **address bar** at the top.  
3. Copy the **full address** up to the first single slash, with no slash at the end.  
   - Examples:  
     - `https://your-app-name.vercel.app`  
     - `https://quotation.example.com`  
     - If you only run it on your own computer: `http://localhost:3000`  
4. Save this somewhere (e.g. in a note). You’ll need it for the script.

This is your **“app URL”**.

---

### Step 3: (Optional) Set a secret password for the app

So that only your script can send emails to the app:

1. Think of a **long random password** (e.g. 20+ characters).  
2. In your app’s hosting (e.g. Vercel), open **Settings** → **Environment variables**.  
3. Add a variable named **`INGEST_SECRET`** and set its value to that password.  
4. Save and redeploy if needed.

If you skip this, the app will still work, but anyone who knows the URL could send fake data. Using a secret is safer.

---

### Step 4: Add the “Send to app” script to Google Apps Script

1. Open **Google Apps Script**: go to [script.google.com](https://script.google.com) and open the project where you already have the **report** that reads emails by label.  
2. In that project, add the code that **sends** those emails to your app.  
   - There is a file in your project: **`apps-script/SendLabeledEmailsToApp.gs`**.  
   - Open it and **copy all the code** from it.  
   - In the Apps Script editor, either:  
     - Paste it into an existing file (e.g. where your report code is), or  
     - Click **+** next to “Files” and add a new file, name it something like “Send to Quotation App”, and paste the code there.  
3. At the **top** of that code, find the line that says something like:  
   `var LABEL_NAME = 'Quotation Request';`  
   Change **`Quotation Request`** to the **exact name** of the Gmail label you use (the one you created in Step 1).  
4. Save the project (Ctrl+S or Cmd+S).

---

### Step 5: Tell the script where your app is (and the secret, if you set one)

1. In the Apps Script editor, click **“Project settings”** (gear icon on the left), or go to **File** → **Project properties**.  
2. Open the **“Script properties”** tab.  
3. Click **“Add script property”**.  
   - **Property:** `APP_URL`  
   - **Value:** the app address you copied in Step 2 (e.g. `https://your-app.vercel.app`), **no slash at the end**.  
4. If you set **INGEST_SECRET** in Step 3, add another property:  
   - **Property:** `INGEST_SECRET`  
   - **Value:** the exact same password you put in the app’s environment variables.  
5. Save.

Now the script knows **where** to send the emails and **with which password** (if you use one).

---

### Step 6: Run “Send to app” when you want quotations created

You have two ways to run it:

**Option A – From the menu (if the script adds a menu)**  
1. In Apps Script, the first time you open the project you may need to run **`onOpen`** once (Run → select `onOpen` → Run).  
2. After that, when you open the linked Google Sheet (if you have one), you may see a menu like **“Quotation App”** with **“Send labeled emails to app”**.  
3. When you want to create quotations from labeled emails, click that menu item and then **“Send labeled emails to app”**.

**Option B – From the script editor**  
1. Open the Apps Script project.  
2. At the top, in the function dropdown, select **`sendLabeledEmailsToApp`**.  
3. Click **Run** (play button).  
4. The first time, Google will ask you to **allow** the script to access your Gmail; click through and allow.  
5. Check the **Execution log** (View → Logs or the log icon) to see how many emails were sent and if any failed.

**What happens when you run it:**  
- The script finds **all emails** that currently have your label (e.g. “Quotation Request”).  
- It sends each email’s text and attachments to your Quotation app.  
- The app creates one quotation per email and puts them in the **Approval** section.  
- If you run it again later, emails that were already imported are **skipped** (no duplicate quotations).

---

### Step 7: Open the Quotation app and use the new quotations

1. Open your **Quotation app** in the browser (same URL as in Step 2).  
2. Go to the **Approval** section (where you usually see approved/saved quotations).  
3. You should see **new quotations** created from the labeled emails.  
4. Each one can have a **“View in Gmail”** link; click it to open the original email in Gmail.  
5. From there you can **approve**, **edit**, or **download PDF** as you normally do.

---

## Quick checklist

- [ ] Gmail label created (e.g. “Quotation Request”).  
- [ ] App URL copied (no trailing slash).  
- [ ] (Optional) INGEST_SECRET set in the app and in Script properties.  
- [ ] Script code added to Apps Script; LABEL_NAME set to your label.  
- [ ] Script properties set: APP_URL and, if used, INGEST_SECRET.  
- [ ] Run “Send to app” (menu or Run `sendLabeledEmailsToApp`).  
- [ ] Open the app and check the Approval section; use “View in Gmail” if you need the original email.

---

## In one sentence

**You add a label to emails in Gmail, run “Send to app” in your script, and the app creates quotations for those emails and shows them in Approval, with a link back to each email.**
