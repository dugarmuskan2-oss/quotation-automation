# AWS S3 Setup Guide - Step by Step

This guide will help you set up AWS S3 for persistent file storage in your Quotation Automation application.

## Prerequisites
- An AWS account (if you don't have one, go to https://aws.amazon.com and sign up)
- Basic understanding of cloud storage concepts

---

## Step 1: Sign in to AWS Console

1. Go to **https://console.aws.amazon.com**
2. Sign in with your AWS account credentials
3. You should see the AWS Management Console dashboard

---

## Step 2: Create an S3 Bucket

1. In the AWS Console, search for **"S3"** in the top search bar
2. Click on **"S3"** service (it should show "Object storage built to retrieve any amount of data")
3. Click the **"Create bucket"** button (orange button on the right)
4. Fill in the bucket details:
   - **Bucket name**: Choose a unique name (e.g., `quotation-automation-files`)
     - Must be globally unique across all AWS accounts
     - Use only lowercase letters, numbers, and hyphens
     - Example: `my-quotation-app-2024`
   - **AWS Region**: Select the region closest to you (e.g., `us-east-1`, `ap-south-1` for India)
   - **Object Ownership**: Keep default "ACLs disabled (recommended)"
   - **Block Public Access settings**: 
     - ✅ **Uncheck** "Block all public access" (we need to access files)
     - Or keep it checked if you only want private access
   - **Bucket Versioning**: Leave as "Disabled" (unless you need versioning)
   - **Default encryption**: Leave as default or enable if you want encryption
   - **Advanced settings**: Leave as default
5. Click **"Create bucket"** at the bottom
6. ✅ Your bucket is now created!

---

## Step 3: Create an IAM User (for Programmatic Access)

1. In the AWS Console, search for **"IAM"** (Identity and Access Management)
2. Click on **"IAM"** service
3. In the left sidebar, click **"Users"**
4. Click the **"Create user"** button
5. **User name**: Enter a name (e.g., `quotation-app-s3-user`)
6. Click **"Next"**
7. **Set permissions**:
   - Select **"Attach policies directly"**
   - Search for **"S3"** in the filter
   - Check the box for **"AmazonS3FullAccess"** (or create a custom policy with only needed permissions)
   - Click **"Next"**
8. Review and click **"Create user"**
9. ✅ User created!

---

## Step 4: Create Access Keys

1. Click on the user you just created (from Step 3)
2. Click on the **"Security credentials"** tab
3. Scroll down to **"Access keys"** section
4. Click **"Create access key"**
5. Select **"Application running outside AWS"** as the use case
6. Click **"Next"**
7. (Optional) Add a description tag, then click **"Create access key"**
8. **⚠️ IMPORTANT**: You will see:
   - **Access key ID** (starts with `AKIA...`)
   - **Secret access key** (long string)
   - **Copy both immediately** - you won't be able to see the secret key again!
   - Save them securely (we'll use these in Step 6)
9. Click **"Done"**

---

## Step 5: Install AWS SDK

Open your terminal in the project directory and run:

```bash
npm install @aws-sdk/client-s3
```

---

## Step 6: Configure Environment Variables

### For Local Development:

1. Open your `.env` file (create it if it doesn't exist)
2. Add these lines:

```env
# AWS S3 Configuration
AWS_S3_BUCKET_NAME=your-bucket-name-here
AWS_REGION=your-region-here
AWS_ACCESS_KEY_ID=your-access-key-id-here
AWS_SECRET_ACCESS_KEY=your-secret-access-key-here
```

**Replace:**
- `your-bucket-name-here` with your bucket name from Step 2
- `your-region-here` with your region (e.g., `us-east-1`, `ap-south-1`)
- `your-access-key-id-here` with your Access Key ID from Step 4
- `your-secret-access-key-here` with your Secret Access Key from Step 4

### For Vercel Deployment:

1. Go to your Vercel project dashboard
2. Click on **"Settings"** → **"Environment Variables"**
3. Add each variable:
   - `AWS_S3_BUCKET_NAME` = your bucket name
   - `AWS_REGION` = your region
   - `AWS_ACCESS_KEY_ID` = your access key ID
   - `AWS_SECRET_ACCESS_KEY` = your secret access key
4. Click **"Save"** for each variable

---

## Step 7: Update .gitignore

Make sure your `.gitignore` file includes:

```
.env
*.json
aws-credentials.json
```

This prevents accidentally committing your AWS credentials to GitHub.

---

## Step 8: Test the Connection

1. Start your server: `npm start`
2. Try uploading a file through your application
3. Check your S3 bucket in AWS Console - you should see the uploaded file!

---

## Troubleshooting

### Error: "Access Denied"
- Check that your IAM user has S3 permissions
- Verify your access keys are correct
- Make sure the bucket name is correct

### Error: "Bucket not found"
- Verify the bucket name matches exactly (case-sensitive)
- Check that the bucket exists in the correct region

### Error: "Invalid credentials"
- Double-check your Access Key ID and Secret Access Key
- Make sure there are no extra spaces when copying

---

## Security Best Practices

1. **Never commit credentials to Git** - always use `.gitignore`
2. **Use IAM roles** instead of access keys when possible (for EC2, Lambda, etc.)
3. **Rotate access keys** periodically (every 90 days recommended)
4. **Use least privilege** - only grant the minimum permissions needed
5. **Enable MFA** on your AWS account for extra security

---

## Cost Considerations

AWS S3 pricing (as of 2024):
- **Storage**: ~$0.023 per GB/month (varies by region)
- **Requests**: 
  - PUT requests: $0.005 per 1,000 requests
  - GET requests: $0.0004 per 1,000 requests
- **Data transfer**: Free for first 100 GB/month, then varies

For a small application, costs are typically **under $1-5/month**.

---

## Need Help?

- AWS S3 Documentation: https://docs.aws.amazon.com/s3/
- AWS Support: https://aws.amazon.com/support/

