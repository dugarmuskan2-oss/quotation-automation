# Quotation Automation - Setup Guide

## Prerequisites

1. **Node.js installed** (you've already done this ✓)
2. **OpenAI API Key** - Get one from https://platform.openai.com/api-keys

## Setup Steps

### 1. Install Dependencies

Open PowerShell or Command Prompt in this folder and run:

```bash
npm install
```

This will install all required packages (Express, OpenAI, Multer, etc.)

### 2. Set Up OpenAI API Key

1. Create a file named `.env` in this folder
2. Add your OpenAI API key:

```
OPENAI_API_KEY=your_actual_api_key_here
PORT=3000
```

**Important:** Never share your `.env` file or commit it to git!

### 3. Start the Server

Run:

```bash
npm start
```

You should see:
```
Server running on http://localhost:3000
Make sure to set OPENAI_API_KEY in .env file
```

### 4. Open the Application

1. Open `index.html` in your browser
   - Or navigate to `http://localhost:3000` if you set up static file serving
   - For now, just double-click `index.html` to open it

## How to Use

### First Time Setup

1. **Upload Rate File:**
   - Download your Excel rate file from Google Sheets
   - In the app, click "Upload Rate File" and select your Excel file
   - Wait for confirmation message

2. **Upload Instructions:**
   - Create a text file with your AI instructions
   - In the app, click "Upload Instructions" and select your text file
   - Wait for confirmation message

### Generating Quotations

1. Paste email content or upload a file in the input area
2. Click "Generate Quotation"
3. The AI will:
   - Read your enquiry
   - Match pipes with rates from your Excel file
   - Extract all information
   - Return a structured quotation

4. Review and edit the quotation
5. Click "Approve" to move it to Approval section
6. Click "Save" to save it as a folder

## File Structure

```
Quotation Automation/
├── index.html          # Frontend application
├── server.js           # Backend server
├── package.json        # Node.js dependencies
├── .env                # Your API key (create this)
├── uploads/
│   ├── rates/          # Uploaded Excel rate files
│   └── instructions/   # Uploaded instruction files
└── README_SETUP.md     # This file
```

## Troubleshooting

### "Failed to generate quotation"
- Check that rate file is uploaded
- Check that instructions file is uploaded
- Verify OpenAI API key is correct in `.env`
- Check server console for error messages

### "Connection refused" or "Failed to fetch"
- Make sure the server is running (`npm start`)
- Check that server is on `http://localhost:3000`
- Try refreshing the page

### "No rate file uploaded"
- Upload your Excel rate file first
- Check the status message shows "Current: [filename]"

## API Endpoints

- `POST /api/generate-quotation` - Generate quotation using AI
- `POST /api/upload-rates` - Upload Excel rate file
- `POST /api/upload-instructions` - Upload AI instructions
- `GET /api/current-rates` - Check current rate file
- `GET /api/current-instructions` - Check current instructions

## Notes

- The server must be running for the app to work
- Rate files and instructions persist until you upload new ones
- Saved quotations are stored in browser localStorage
- Excel files are sent directly to OpenAI (no parsing needed)


