# Quick Start Guide

## Step 1: Install Dependencies

Open PowerShell in this folder and run:
```bash
npm install
```

## Step 2: Create .env File

Create a file named `.env` in this folder with:
```
OPENAI_API_KEY=your_api_key_here
PORT=3000
```

Get your API key from: https://platform.openai.com/api-keys

## Step 3: Start Server

```bash
npm start
```

Keep this window open - the server must be running!

## Step 4: Open the App

Double-click `index.html` to open in your browser.

## Step 5: First Time Setup

1. **Upload Rate File:**
   - Download Excel file from Google Sheets
   - Click "Upload Rate File" → Select your Excel file
   - Wait for "✓ Uploaded" message

2. **Upload Instructions:**
   - Create a `.txt` file with your AI instructions
   - Click "Upload Instructions" → Select your text file
   - Wait for "✓ Uploaded" message

## Step 6: Generate Quotation

1. Paste enquiry or upload file
2. Click "Generate Quotation"
3. Wait for AI to process (may take 10-30 seconds)
4. Review and edit quotation
5. Click "Approve" then "Save"

## Troubleshooting

**"Connection refused"** → Make sure server is running (`npm start`)

**"No rate file uploaded"** → Upload your Excel file first

**"Failed to generate quotation"** → Check OpenAI API key in `.env` file

