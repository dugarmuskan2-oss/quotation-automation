# Quotation Generator - Beginner's Guide

## 📖 What is this?

This is a **browser-only quotation generator** that helps staff create quotations from email content or uploaded files. It's a prototype that works entirely in your web browser - no installation needed!

## 🚀 How to Use (Step by Step)

### Step 1: Open the File
1. Find the `index.html` file on your computer
2. **Double-click** on `index.html`
3. It will open in your default web browser (Chrome, Firefox, Edge, etc.)

**That's it!** No installation, no setup, no Node.js needed.

### Step 2: Use the App

#### Option A: Paste Email Content
1. Copy email content from your email
2. Paste it into the large text box labeled "Email Content"
3. Click the **"Generate Quotation"** button

#### Option B: Upload a File
1. Click the **"Choose File"** button
2. Select a PDF, Word document, or text file
3. Click the **"Generate Quotation"** button

#### Option C: Use Both
- You can paste email content AND upload a file at the same time
- Then click **"Generate Quotation"**

### Step 3: View the Quotation
- After clicking the button, a quotation will appear below
- It shows:
  - Customer information
  - Project details
  - A table with pipe items, quantities, rates, and totals
  - Grand total at the bottom

## 📁 File Structure

```
Quotation Automation/
└── index.html          ← The only file you need!
```

**That's it!** Just one file contains everything.

## 🔍 Understanding the Code (For Learning)

The `index.html` file contains three main parts:

### 1. HTML (Structure)
- Creates the page layout
- Defines buttons, text areas, tables
- Like the skeleton of a house

### 2. CSS (Styling)
- Makes everything look nice
- Controls colors, fonts, spacing
- Like painting and decorating the house

### 3. JavaScript (Functionality)
- Makes buttons work
- Performs calculations
- Like the electrical and plumbing in the house

## 🎯 Key Features Explained

### Mock AI Function
- Currently uses **sample data** (not real AI)
- In the future, this will connect to real AI
- Look for comments marked `TODO` in the code

### Calculations
- **Final Rate** = Base Rate × (1 + Margin%)
- **Line Total** = Quantity × Final Rate
- **Grand Total** = Sum of all Line Totals

### File Reading
- Text files: Reads content directly
- PDF/Word files: Shows binary data (needs special libraries for real parsing)
- In production, backend would handle PDF/Word parsing

## 🔮 Future Enhancements (Not Implemented Yet)

1. **Real AI Integration**
   - Replace `mockAIExtraction()` function
   - Connect to AI API (like OpenAI, etc.)
   - Extract actual data from emails/files

2. **Backend Connection**
   - Connect to Node.js server
   - Handle file processing server-side
   - Store quotations in database

3. **PDF/Word Parsing**
   - Properly extract text from PDF files
   - Parse Word documents
   - Currently only handles plain text files well

## 🛠️ Troubleshooting

### The file won't open
- Make sure you're double-clicking `index.html`
- Try right-clicking → "Open with" → Choose your browser

### Nothing happens when I click the button
- Make sure you entered email content OR uploaded a file
- Check browser console (F12) for error messages

### The quotation looks wrong
- This is a prototype with sample data
- Real data extraction will be added later

### File upload doesn't work
- Make sure file is PDF, Word (.doc/.docx), or text (.txt)
- Text files work best currently

## 📝 Notes for Developers

### Where to Add Real AI:
Look for this function in the code:
```javascript
function mockAIExtraction(emailContent, fileContent) {
    // TODO: Replace this with real AI API call
}
```

### Where to Add Backend:
The mock AI function should be replaced with an API call:
```javascript
// Future: Replace with fetch() call to Node.js backend
const response = await fetch('/api/extract-quotation', {
    method: 'POST',
    body: JSON.stringify({ emailContent, fileContent })
});
```

## ✅ What Works Now

- ✅ Paste email content
- ✅ Upload files (basic support)
- ✅ Generate quotation with sample data
- ✅ Display formatted quotation
- ✅ Calculate totals automatically
- ✅ Show/hide sections dynamically
- ✅ Error handling

## ❌ What Doesn't Work Yet

- ❌ Real AI extraction (uses mock data)
- ❌ Backend connection (browser-only)
- ❌ PDF/Word parsing (needs libraries)
- ❌ Save quotations
- ❌ Print quotations
- ❌ Email quotations

## 🎓 Learning Resources

If you want to learn more:

- **HTML**: Structure of web pages
- **CSS**: Making pages look good
- **JavaScript**: Making pages interactive
- **MDN Web Docs**: Great resource for web development

## 📞 Need Help?

This is a prototype demonstration. For production use:
1. Add real AI integration
2. Connect to backend server
3. Add proper file parsing
4. Add database storage
5. Add user authentication

---

**Remember**: This is a prototype! It demonstrates the concept but uses sample data. Real implementation will require backend services and AI integration.



