/*
    ============================================
    QUOTATION AUTOMATION SERVER
    ============================================
    Node.js backend server for quotation automation with OpenAI
*/

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const { Readable } = require('stream');
require('dotenv').config();

// Cloud Storage Configuration (Google Cloud or AWS S3)
let storageClient = null;
let bucket = null;
let s3Client = null;
let s3BucketName = null;

const useGoogleCloud = !!(process.env.GOOGLE_CLOUD_BUCKET_NAME || process.env.GOOGLE_CLOUD_CREDENTIALS);
const useAWS = !!(process.env.AWS_S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

// Initialize Google Cloud Storage (if configured)
if (useGoogleCloud) {
    try {
        const { Storage } = require('@google-cloud/storage');
        
        // Initialize Google Cloud Storage
        let credentials = null;
        if (process.env.GOOGLE_CLOUD_CREDENTIALS) {
            // For Vercel - credentials are in environment variable as JSON string
            credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS);
        } else if (process.env.GOOGLE_CLOUD_KEY_FILE) {
            // For local - credentials are in a file
            const keyPath = path.join(__dirname, process.env.GOOGLE_CLOUD_KEY_FILE);
            if (fs.existsSync(keyPath)) {
                credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            }
        }
        
        if (credentials) {
            storageClient = new Storage({
                projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || credentials.project_id,
                credentials: credentials
            });
            bucket = storageClient.bucket(process.env.GOOGLE_CLOUD_BUCKET_NAME);
            console.log('Google Cloud Storage initialized successfully');
        } else {
            console.warn('Google Cloud Storage credentials not found, using local storage');
        }
    } catch (error) {
        console.warn('Google Cloud Storage not available, using local storage:', error.message);
    }
}

// Initialize AWS S3 (if configured)
if (useAWS) {
    try {
        const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
        
        s3Client = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
        });
        s3BucketName = process.env.AWS_S3_BUCKET_NAME;
        console.log(`AWS S3 initialized successfully (bucket: ${s3BucketName})`);
    } catch (error) {
        console.warn('AWS S3 not available, using local storage:', error.message);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files if needed
app.use(express.static(__dirname)); // Serve root files like index.html/logo.png

// Ensure upload directories exist
// On Vercel, use /tmp directory (writable), otherwise use project directory
const isVercelEnv = process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.VERCEL_URL;
const baseDir = isVercelEnv ? '/tmp' : __dirname;

const uploadsDir = path.join(baseDir, 'uploads');
const ratesDir = path.join(uploadsDir, 'rates');
const instructionsDir = path.join(uploadsDir, 'instructions');

// Create directories (they need to exist for multer to work)
// On Vercel, /tmp exists but subdirectories need to be created
[uploadsDir, ratesDir, instructionsDir].forEach(dir => {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (error) {
        console.error(`Error creating directory ${dir}:`, error);
        // Continue anyway - multer might handle it
    }
});

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Configure multer for file uploads
// Use memory storage if cloud storage (Google Cloud or AWS S3) is enabled, otherwise use disk storage
let multerStorage;
if ((useGoogleCloud && bucket) || (useAWS && s3Client)) {
    // Memory storage - files will be uploaded to cloud storage
    multerStorage = multer.memoryStorage();
} else {
    // Disk storage - files saved locally
    multerStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            if (file.fieldname === 'rateFile' || file.fieldname === 'rateFiles') {
                cb(null, ratesDir);
            } else if (file.fieldname === 'instructionsFile') {
                cb(null, instructionsDir);
            } else {
                cb(null, uploadsDir);
            }
        },
        filename: function (req, file, cb) {
            // Keep original filename with timestamp
            const timestamp = Date.now();
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            cb(null, `${name}_${timestamp}${ext}`);
        }
    });
}

const upload = multer({ 
    storage: multerStorage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper function to get latest file from directory
function getLatestFile(dir) {
    try {
        const files = fs.readdirSync(dir);
        if (files.length === 0) return null;
        
        const fileStats = files.map(file => {
            const filePath = path.join(dir, file);
            return {
                name: file,
                path: filePath,
                time: fs.statSync(filePath).mtime.getTime()
            };
        });
        
        // Sort by modification time (newest first)
        fileStats.sort((a, b) => b.time - a.time);
        return fileStats[0].path;
    } catch (error) {
        console.error('Error reading directory:', error);
        return null;
    }
}

// Helper function to get all files from directory (sorted by date, newest first)
function getAllFiles(dir) {
    try {
        const files = fs.readdirSync(dir);
        if (files.length === 0) return [];
        
        const fileStats = files.map(file => {
            const filePath = path.join(dir, file);
            return {
                name: file,
                path: filePath,
                time: fs.statSync(filePath).mtime.getTime()
            };
        });
        
        // Sort by modification time (newest first)
        fileStats.sort((a, b) => b.time - a.time);
        return fileStats.map(f => f.path);
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
}

// Helper function to read file content
function readFileContent(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        console.error('Error reading file:', error);
        return null;
    }
}

// Helper function to convert Excel to readable text format
function excelToText(filePath) {
    try {
        const workbook = XLSX.readFile(filePath);
        let textContent = '';
        const fileName = path.basename(filePath);
        
        textContent += `\n=== FILE: ${fileName} ===\n`;
        
        // Read all sheets
        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
            
            textContent += `\nSheet: ${sheetName}\n`;
            textContent += '='.repeat(50) + '\n';
            
            // Convert to readable table format
            jsonData.forEach(row => {
                if (row && row.length > 0) {
                    textContent += row.join(' | ') + '\n';
                }
            });
            textContent += '\n';
        });
        
        return textContent;
    } catch (error) {
        console.error('Error reading Excel file:', error);
        return null;
    }
}

// Helper function to convert all Excel files to text
function allExcelFilesToText(filePaths) {
    let allContent = '';
    filePaths.forEach((filePath, index) => {
        const content = excelToText(filePath);
        if (content) {
            allContent += `\n\n${'='.repeat(60)}\n`;
            allContent += `RATE FILE ${index + 1} of ${filePaths.length}\n`;
            allContent += `${'='.repeat(60)}\n`;
            allContent += content;
        }
    });
    return allContent;
}

// Helper function to convert Excel to TXT and save temp files
function excelToTxtFiles(filePath) {
    const txtFilePaths = [];
    try {
        const workbook = XLSX.readFile(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const tempDir = path.join(baseDir, 'uploads', 'temp');

        // Create temp directory if it doesn't exist
        try {
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
        } catch (error) {
            console.error(`Error creating temp directory ${tempDir}:`, error);
            // Continue anyway
        }

        workbook.SheetNames.forEach((sheetName, index) => {
            const worksheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(worksheet);
            const safeSheetName = sheetName.replace(/[<>:"/\\|?*]/g, '_');
            const tempFileName = `${baseName}_${safeSheetName}_${Date.now()}_${index}.txt`;
            const tempFilePath = path.join(tempDir, tempFileName);
            fs.writeFileSync(tempFilePath, csv, 'utf8');
            txtFilePaths.push(tempFilePath);
        });
    } catch (error) {
        console.error('Error converting Excel to TXT:', error);
    }
    return txtFilePaths;
}

// Google Cloud Storage Helper Functions
async function uploadToGCS(fileBuffer, fileName, folder = 'rates') {
    if (!bucket) {
        throw new Error('Google Cloud Storage not configured');
    }
    
    const filePath = `${folder}/${fileName}`;
    const file = bucket.file(filePath);
    
    await file.save(fileBuffer, {
        metadata: {
            contentType: 'application/octet-stream'
        }
    });
    
    return filePath;
}

async function deleteFromGCS(filePath) {
    if (!bucket) {
        throw new Error('Google Cloud Storage not configured');
    }
    
    const file = bucket.file(filePath);
    await file.delete();
}

async function listFilesFromGCS(folder = 'rates') {
    if (!bucket) {
        return [];
    }
    
    const [files] = await bucket.getFiles({ prefix: `${folder}/` });
    return files.map(file => ({
        name: file.name.split('/').pop(), // Get just the filename
        path: file.name,
        time: file.metadata.updated ? new Date(file.metadata.updated).getTime() : Date.now()
    }));
}

async function readFileFromGCS(filePath) {
    if (!bucket) {
        throw new Error('Google Cloud Storage not configured');
    }
    
    const file = bucket.file(filePath);
    const [buffer] = await file.download();
    return buffer;
}

async function readInstructionsFromGCS() {
    try {
        const buffer = await readFileFromGCS('instructions.txt');
        return buffer.toString('utf8');
    } catch (error) {
        if (error.code === 404) {
            return null; // File doesn't exist
        }
        throw error;
    }
}

async function saveInstructionsToGCS(content) {
    await uploadToGCS(Buffer.from(content, 'utf8'), 'instructions.txt', '');
}

// AWS S3 Helper Functions
async function uploadToS3(fileBuffer, fileName, folder = 'rates') {
    if (!s3Client || !s3BucketName) {
        throw new Error('AWS S3 not configured');
    }
    
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const filePath = folder ? `${folder}/${fileName}` : fileName;
    
    const command = new PutObjectCommand({
        Bucket: s3BucketName,
        Key: filePath,
        Body: fileBuffer,
        ContentType: 'application/octet-stream'
    });
    
    await s3Client.send(command);
    return filePath;
}

async function deleteFromS3(filePath) {
    if (!s3Client || !s3BucketName) {
        throw new Error('AWS S3 not configured');
    }
    
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const command = new DeleteObjectCommand({
        Bucket: s3BucketName,
        Key: filePath
    });
    
    await s3Client.send(command);
}

async function listFilesFromS3(folder = 'rates') {
    if (!s3Client || !s3BucketName) {
        return [];
    }
    
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const prefix = folder ? `${folder}/` : '';
    
    const command = new ListObjectsV2Command({
        Bucket: s3BucketName,
        Prefix: prefix
    });
    
    const response = await s3Client.send(command);
    
    if (!response.Contents) {
        return [];
    }
    
    return response.Contents.map(item => ({
        name: item.Key.split('/').pop(), // Get just the filename
        path: item.Key,
        time: item.LastModified ? item.LastModified.getTime() : Date.now()
    }));
}

async function readFileFromS3(filePath) {
    if (!s3Client || !s3BucketName) {
        throw new Error('AWS S3 not configured');
    }
    
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const command = new GetObjectCommand({
        Bucket: s3BucketName,
        Key: filePath
    });
    
    const response = await s3Client.send(command);
    const chunks = [];
    
    for await (const chunk of response.Body) {
        chunks.push(chunk);
    }
    
    return Buffer.concat(chunks);
}

async function readInstructionsFromS3() {
    try {
        const buffer = await readFileFromS3('instructions.txt');
        return buffer.toString('utf8');
    } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
            return null; // File doesn't exist
        }
        throw error;
    }
}

async function saveInstructionsToS3(content) {
    await uploadToS3(Buffer.from(content, 'utf8'), 'instructions.txt', '');
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Upload rate files (Excel) - Multiple files allowed
app.post('/api/upload-rates', upload.array('rateFiles', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const results = [];
        const errors = [];
        
        for (const file of req.files) {
            try {
                // Additional validation
                const validExtensions = ['.xlsx', '.xls', '.pdf'];
                const fileExt = path.extname(file.originalname).toLowerCase();
                
                if (!validExtensions.includes(fileExt)) {
                    errors.push({
                        filename: file.originalname,
                        error: `Invalid file type: ${fileExt}. Only .xlsx, .xls, and .pdf files are allowed.`
                    });
                    continue;
                }
                
                let savedFileName;
                
                if (useGoogleCloud && bucket) {
                    // Upload to Google Cloud Storage
                    const timestamp = Date.now();
                    const ext = path.extname(file.originalname);
                    const name = path.basename(file.originalname, ext);
                    savedFileName = `${name}_${timestamp}${ext}`;
                    
                    // file.buffer is available when using memory storage
                    await uploadToGCS(file.buffer, savedFileName, 'rates');
                } else if (useAWS && s3Client) {
                    // Upload to AWS S3
                    const timestamp = Date.now();
                    const ext = path.extname(file.originalname);
                    const name = path.basename(file.originalname, ext);
                    savedFileName = `${name}_${timestamp}${ext}`;
                    
                    // file.buffer is available when using memory storage
                    await uploadToS3(file.buffer, savedFileName, 'rates');
                } else {
                    // Local storage - file already saved by multer
                    savedFileName = file.filename;
                }
                
                results.push({
                    filename: savedFileName,
                    originalName: file.originalname,
                    size: file.size
                });
            } catch (fileError) {
                errors.push({
                    filename: file.originalname || 'Unknown',
                    error: fileError.message
                });
                // Try to clean up local file if it exists
                try {
                    if (file.path && fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                    }
                } catch (unlinkError) {
                    // Ignore cleanup errors
                }
            }
        }
        
        if (results.length === 0 && errors.length > 0) {
            return res.status(400).json({ 
                error: 'All files failed to upload',
                details: errors
            });
        }
        
        res.json({ 
            success: true, 
            message: `${results.length} rate file(s) uploaded successfully`,
            filenames: results.map(r => r.filename),
            count: results.length,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('Error uploading rate files:', error);
        res.status(500).json({ 
            error: 'Failed to upload rate files',
            details: error.message
        });
    }
});

// Delete rate file
app.post('/api/delete-rate-file', async (req, res) => {
    try {
        const { filename } = req.body;
        
        if (!filename) {
            return res.status(400).json({ error: 'Filename required' });
        }
        
        if (useGoogleCloud && bucket) {
            // Delete from Google Cloud Storage
            const filePath = `rates/${filename}`;
            try {
                await deleteFromGCS(filePath);
            } catch (error) {
                if (error.code === 404) {
                    return res.status(404).json({ error: 'File not found' });
                }
                throw error;
            }
        } else if (useAWS && s3Client) {
            // Delete from AWS S3
            const filePath = `rates/${filename}`;
            try {
                await deleteFromS3(filePath);
            } catch (error) {
                if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                    return res.status(404).json({ error: 'File not found' });
                }
                throw error;
            }
        } else {
            // Delete from local storage
            const filePath = path.join(ratesDir, filename);
            
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }
            
            // Delete the file
            fs.unlinkSync(filePath);
        }
        
        res.json({ 
            success: true, 
            message: 'File deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Get current rate files info
app.get('/api/current-rates', async (req, res) => {
    try {
        let filenames = [];
        
        if (useGoogleCloud && bucket) {
            // Get files from Google Cloud Storage
            const files = await listFilesFromGCS('rates');
            filenames = files.map(f => f.name);
        } else if (useAWS && s3Client) {
            // Get files from AWS S3
            const files = await listFilesFromS3('rates');
            filenames = files.map(f => f.name);
        } else {
            // Get files from local storage
            const allFiles = getAllFiles(ratesDir);
            filenames = allFiles.map(filePath => path.basename(filePath));
        }
        
        if (filenames.length === 0) {
            return res.json({ hasFiles: false, filenames: [], count: 0 });
        }
        
        res.json({ 
            hasFiles: true, 
            filenames: filenames,
            count: filenames.length
        });
    } catch (error) {
        console.error('Error getting rate files info:', error);
        res.status(500).json({ error: 'Failed to get rate files info' });
    }
});

// Save instructions to server (shared across all users/devices)
app.post('/api/save-instructions', express.json(), async (req, res) => {
    try {
        const { instructions } = req.body;
        
        if (!instructions) {
            return res.status(400).json({ error: 'Instructions text is required' });
        }
        
        if (useGoogleCloud && bucket) {
            // Save to Google Cloud Storage
            await saveInstructionsToGCS(instructions);
        } else if (useAWS && s3Client) {
            // Save to AWS S3
            await saveInstructionsToS3(instructions);
        } else {
            // Save to local file
            const instructionsFile = path.join(baseDir, 'instructions.txt');
            fs.writeFileSync(instructionsFile, instructions, 'utf8');
        }
        
        res.json({ 
            success: true,
            message: 'Instructions saved successfully'
        });
    } catch (error) {
        console.error('Error saving instructions:', error);
        res.status(500).json({ 
            error: 'Failed to save instructions',
            details: error.message
        });
    }
});

// Get instructions from server (shared across all users/devices)
app.get('/api/get-instructions', async (req, res) => {
    try {
        let content = null;
        let hasFile = false;
        
        if (useGoogleCloud && bucket) {
            // Get from Google Cloud Storage
            content = await readInstructionsFromGCS();
            hasFile = content !== null;
        } else if (useAWS && s3Client) {
            // Get from AWS S3
            content = await readInstructionsFromS3();
            hasFile = content !== null;
        } else {
            // Get from local file
            const instructionsFile = path.join(baseDir, 'instructions.txt');
            if (fs.existsSync(instructionsFile)) {
                content = fs.readFileSync(instructionsFile, 'utf8');
                hasFile = true;
            }
        }
        
        res.json({ 
            hasFile: hasFile,
            content: content || ''
        });
    } catch (error) {
        console.error('Error getting instructions:', error);
        res.status(500).json({ 
            error: 'Failed to get instructions',
            details: error.message
        });
    }
});

// Main API: Generate quotation using OpenAI
app.post('/api/generate-quotation', async (req, res) => {
    try {
        const { emailContent, fileContent, instructions } = req.body;
        
        if (!emailContent && !fileContent) {
            return res.status(400).json({ error: 'No content provided' });
        }
        
        // Get instructions from request (sent from frontend localStorage)
        if (!instructions || instructions.trim() === '') {
            return res.status(400).json({ error: 'No instructions provided. Please enter instructions first.' });
        }
        
        // Get all rate files (from GCS or local storage)
        let rateFiles = [];
        
        if (useGoogleCloud && bucket) {
            // Get files from Google Cloud Storage
            const gcsFiles = await listFilesFromGCS('rates');
            rateFiles = gcsFiles.map(f => ({
                name: f.name,
                path: f.path,
                storageType: 'gcs'
            }));
        } else if (useAWS && s3Client) {
            // Get files from AWS S3
            const s3Files = await listFilesFromS3('rates');
            rateFiles = s3Files.map(f => ({
                name: f.name,
                path: f.path,
                storageType: 's3'
            }));
        } else {
            // Get files from local storage
            const localFiles = getAllFiles(ratesDir);
            rateFiles = localFiles.map(filePath => ({
                name: path.basename(filePath),
                path: filePath,
                storageType: 'local'
            }));
        }
        
        if (rateFiles.length === 0) {
            return res.status(400).json({ error: 'No rate files uploaded. Please upload rate files first.' });
        }
        
        // Prepare content for OpenAI
        const enquiryText = emailContent || fileContent || '';
        
        // Upload PDF rate files directly to OpenAI Files API
        const uploadedFileIds = [];
        const uploadedFileNames = [];
        const tempTxtFiles = [];
        
        for (const rateFile of rateFiles) {
            try {
                const fileName = rateFile.name;
                const fileExt = path.extname(fileName).toLowerCase();

                if (fileExt !== '.pdf') {
                    console.log(`Skipping non-PDF file: ${fileName}`);
                    continue;
                }

                // Read file from cloud storage or local storage
                let fileBuffer;
                if (rateFile.storageType === 'gcs') {
                    fileBuffer = await readFileFromGCS(rateFile.path);
                } else if (rateFile.storageType === 's3') {
                    fileBuffer = await readFileFromS3(rateFile.path);
                } else {
                    fileBuffer = fs.readFileSync(rateFile.path);
                }

                // Create a stream from buffer for OpenAI
                const fileStream = Readable.from(fileBuffer);
                
                const file = await openai.files.create({
                    file: fileStream,
                    purpose: 'assistants'
                });

                uploadedFileIds.push(file.id);
                uploadedFileNames.push(fileName);
                console.log(`Uploaded ${fileName} to OpenAI as file ID: ${file.id}`);
            } catch (error) {
                console.error(`Error uploading file ${rateFile.name} to OpenAI:`, error);
                // Continue with other files even if one fails
            }
        }

        if (uploadedFileIds.length === 0) {
            return res.status(400).json({ error: 'No PDF rate files found. Please upload PDF rate files.' });
        }
        
        if (uploadedFileIds.length === 0) {
            return res.status(500).json({ error: 'Failed to upload rate files to OpenAI' });
        }
        
        // Prepare input for Responses API with file references
        const promptText = `Please analyze the following enquiry and extract quotation information. Use the Excel rate files provided (${uploadedFileIds.length} file(s)) to match base rates. Read the Excel files directly to find the correct rates. Return the data in this exact JSON format:

{
  "customerName": "",
  "projectName": "",
  "contactDetails": "",
  "quotationDate": "",
  "lineItems": [
    {
      "originalDescription": "",
      "identifiedPipeType": "",
      "quantity": "",
      "unitRate": "",
      "marginPercent": "",
      "finalRate": "",
      "lineTotal": ""
    }
  ]
}

=== ENQUIRY CONTENT ===
${enquiryText}

Extract all pipe information from the enquiry, match with rates from the uploaded Excel rate files, calculate final rates with margins, and return the complete JSON.`;

        const input = [
            {
                role: 'system',
                content: instructions || 'You are a quotation extraction assistant. Extract pipe information from enquiries and match them with rates from the provided Excel rate files. Read the Excel files directly to find the correct rates.'
            },
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: promptText },
                    ...uploadedFileIds.map(fileId => ({
                        type: 'input_file',
                        file_id: fileId
                    }))
                ]
            }
        ];

        // Call OpenAI Responses API (supports input_file)
        const completion = await openai.responses.create({
            model: 'gpt-5.2',
            input: input,
            text: {
                format: { type: 'json_object' }
            },
            temperature: 0.3
        });
        
        // Clean up uploaded files after use
        for (const fileId of uploadedFileIds) {
            try {
                await openai.files.del(fileId);
                console.log(`Deleted temporary file ${fileId} from OpenAI`);
            } catch (error) {
                console.error(`Error deleting file ${fileId}:`, error);
            }
        }

        // No temp files to clean up (PDFs are used directly)
        
        // Parse response
        const responseText =
            completion.output_text ||
            completion.output?.[0]?.content?.[0]?.text ||
            completion.output?.[0]?.content?.[0]?.value ||
            '';
        let quotationData;
        
        try {
            quotationData = JSON.parse(responseText);
        } catch (parseError) {
            // Try to extract JSON from response if it's wrapped in markdown
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                quotationData = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('Failed to parse AI response as JSON');
            }
        }
        
        // Validate and format response
        if (!quotationData.lineItems || !Array.isArray(quotationData.lineItems)) {
            quotationData.lineItems = [];
        }
        
        // Calculate final rates and line totals if not provided
        quotationData.lineItems = quotationData.lineItems.map(item => {
            const unitRate = parseFloat(item.unitRate) || 0;
            const marginPercentRaw = parseFloat(item.marginPercent);
            const marginPercent = Number.isFinite(marginPercentRaw) ? marginPercentRaw : 0;
            const quantity = parseFloat(item.quantity) || 0;
            
            const finalRate = unitRate * (1 + marginPercent / 100);
            const lineTotal = quantity * finalRate;
            
            return {
                originalDescription: item.originalDescription || '',
                identifiedPipeType: item.identifiedPipeType || '',
                quantity: quantity.toString(),
                unitRate: unitRate.toFixed(2),
                marginPercent: marginPercent.toString(),
                finalRate: finalRate.toFixed(2),
                lineTotal: lineTotal.toFixed(2)
            };
        });
        
        // Set quotation date if not provided
        if (!quotationData.quotationDate) {
            const today = new Date();
            quotationData.quotationDate = today.toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });
        }
        
        res.json({
            ...quotationData,
            _ai: {
                raw: responseText,
                model: 'gpt-5.2',
                files: uploadedFileNames
            }
        });
        
    } catch (error) {
        console.error('Error generating quotation:', error);
        res.status(500).json({ 
            error: 'Failed to generate quotation',
            details: error.message 
        });
    }
});

// Chat with AI about the last response
app.post('/api/ai-chat', async (req, res) => {
    try {
        const { message, instructions, context } = req.body;

        if (!message || message.trim() === '') {
            return res.status(400).json({ error: 'Message is required' });
        }

        const input = [
            {
                role: 'system',
                content: 'You are a helpful assistant. Reply normally in plain text. Do NOT return JSON unless the user explicitly asks for JSON.'
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: `Context (last AI output):\n${context || 'No context provided'}\n\nUser question:\n${message}`
                    }
                ]
            }
        ];

        const completion = await openai.responses.create({
            model: 'gpt-5.2',
            input: input,
            temperature: 0.3
        });

        const responseText =
            completion.output_text ||
            completion.output?.[0]?.content?.[0]?.text ||
            completion.output?.[0]?.content?.[0]?.value ||
            '';

        res.json({ reply: responseText });
    } catch (error) {
        console.error('Error in AI chat:', error);
        res.status(500).json({
            error: 'Failed to get AI reply',
            details: error.message
        });
    }
});

// Error handling middleware - must be after all routes
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        details: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
});

// 404 handler for undefined routes
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`
    });
});

// Export app for Vercel serverless functions
module.exports = app;

// Start server only when running locally (not on Vercel)
// Check for Vercel environment variables
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.VERCEL_URL;
if (!isVercel) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Make sure to set OPENAI_API_KEY in .env file`);
    });
}

