# Google Cloud Storage Setup Guide

## Step-by-Step Instructions

### Step 1: Create Google Cloud Project
1. Go to https://console.cloud.google.com
2. Sign in with your Google account
3. Click "Select a project" → "New Project"
4. Name: `quotation-automation`
5. Click "Create"

### Step 2: Enable Cloud Storage API
1. In your project, go to "APIs & Services" → "Library"
2. Search for "Cloud Storage API"
3. Click "Enable"

### Step 3: Create Storage Bucket
1. Go to "Cloud Storage" → "Buckets"
2. Click "Create Bucket"
3. **Bucket name**: `quotation-automation-files` (must be globally unique - add your name/numbers if taken)
4. **Location type**: Region
5. **Region**: Choose closest to you (e.g., `us-central1`, `asia-south1` for India)
6. Click "Create"

### Step 4: Create Service Account
1. Go to "IAM & Admin" → "Service Accounts"
2. Click "Create Service Account"
3. **Name**: `quotation-storage`
4. Click "Create and Continue"
5. **Role**: Select "Storage Admin" (full control)
6. Click "Continue" → "Done"

### Step 5: Create and Download Key
1. Click on the service account you just created
2. Go to "Keys" tab
3. Click "Add Key" → "Create new key"
4. **Key type**: JSON
5. Click "Create" (this downloads a JSON file)
6. **IMPORTANT**: Save this file as `google-cloud-key.json` in your project folder
7. **DO NOT** commit this file to Git (it's already in .gitignore)

### Step 6: Install Package
Run in your project folder:
```bash
npm install
```

### Step 7: Add Environment Variables

#### For Local Development (.env file):
Add these lines to your `.env` file:
```
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GOOGLE_CLOUD_BUCKET_NAME=quotation-automation-files
GOOGLE_CLOUD_KEY_FILE=google-cloud-key.json
```

To find your Project ID:
- Go to Google Cloud Console
- Your project ID is shown at the top (different from project name)

#### For Vercel:
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Add these variables:
   - `GOOGLE_CLOUD_PROJECT_ID` = your project ID
   - `GOOGLE_CLOUD_BUCKET_NAME` = your bucket name
   - `GOOGLE_CLOUD_KEY_FILE` = (see below)

For Vercel, you need to add the service account key as an environment variable:
1. Open your `google-cloud-key.json` file
2. Copy the entire JSON content
3. In Vercel, add environment variable:
   - **Key**: `GOOGLE_CLOUD_CREDENTIALS`
   - **Value**: Paste the entire JSON content
   - **Environment**: All (Production, Preview, Development)

### Step 8: Test the Setup
1. Start your server: `npm start`
2. Try uploading a rate file
3. Check Google Cloud Console → Cloud Storage → Your Bucket
4. You should see the uploaded files there!

## Cost Information
- **Free Tier**: 5 GB storage, 5,000 Class A operations, 50,000 Class B operations per month
- **After Free Tier**: Very cheap (around $0.020 per GB storage, $0.05 per 10,000 operations)
- For typical usage, you'll likely stay within the free tier

## Troubleshooting

### Error: "Bucket not found"
- Check that bucket name in `.env` matches exactly
- Make sure bucket was created successfully

### Error: "Permission denied"
- Check service account has "Storage Admin" role
- Verify the key file is correct

### Error: "Project not found"
- Check project ID in `.env` matches your Google Cloud project ID
- Project ID is different from project name

## Security Notes
- Never commit `google-cloud-key.json` to Git
- Keep your service account key secure
- Consider using different keys for development and production

