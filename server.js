/*
    ============================================
    QUOTATION AUTOMATION SERVER
    ============================================
    Node.js backend server for quotation automation with OpenAI
*/

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
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
let ddbDocClient = null;
let ddbTableName = null;

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

// Initialize DynamoDB (if configured)
if (useAWS && process.env.DYNAMODB_TABLE) {
    try {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        const region = process.env.AWS_REGION || 'us-east-1';
        const ddbClient = new DynamoDBClient({
            region,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
        });
        ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
        ddbTableName = process.env.DYNAMODB_TABLE;
        console.log(`DynamoDB initialized successfully (table: ${ddbTableName})`);
    } catch (error) {
        console.warn('DynamoDB not available, using localStorage only:', error.message);
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
    
    return response.Contents
        .filter(item => {
            const filename = item.Key.split('/').pop();
            // Hide the rate index file from UI listings
            return filename && filename.toLowerCase() !== 'index.json';
        })
        .map(item => ({
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

// ===============================
// RATE FILE INDEX (JSON MAPPING)
// ===============================
// Stores mapping between S3 files and OpenAI file IDs
// Format: [{ s3Key, openaiFileId, originalName, createdAt }, ...]

async function loadRateIndex() {
    // Returns an array of mappings
    try {
        if (useAWS && s3Client) {
            // Try to read index from S3
            try {
                const buffer = await readFileFromS3('rates/index.json');
                const text = buffer.toString('utf8');
                const data = JSON.parse(text);
                if (Array.isArray(data)) {
                    return data;
                }
            } catch (error) {
                // File doesn't exist yet or parse error - return empty array
                if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) {
                    console.warn('loadRateIndex: parse error, returning empty index:', error.message);
                }
            }
            return [];
        } else if (useGoogleCloud && bucket) {
            // Try to read from GCS
            try {
                const buffer = await readFileFromGCS('rates/index.json');
                const text = buffer.toString('utf8');
                const data = JSON.parse(text);
                if (Array.isArray(data)) {
                    return data;
                }
            } catch (error) {
                if (error.code !== 404) {
                    console.warn('loadRateIndex: parse error, returning empty index:', error.message);
                }
            }
            return [];
        } else {
            // Fallback: local file
            const indexPath = path.join(baseDir, 'rates-index.json');
            if (fs.existsSync(indexPath)) {
                const text = fs.readFileSync(indexPath, 'utf8');
                const data = JSON.parse(text);
                return Array.isArray(data) ? data : [];
            }
            return [];
        }
    } catch (error) {
        // If any error, treat as empty index
        console.warn('loadRateIndex: returning empty index due to error:', error.message);
        return [];
    }
}

async function saveRateIndex(index) {
    const json = JSON.stringify(index, null, 2);
    if (useAWS && s3Client) {
        // Save index to S3 under rates/index.json
        await uploadToS3(Buffer.from(json, 'utf8'), 'index.json', 'rates');
    } else if (useGoogleCloud && bucket) {
        // Save index to GCS
        await uploadToGCS(Buffer.from(json, 'utf8'), 'index.json', 'rates');
    } else {
        // Save locally
        const indexPath = path.join(baseDir, 'rates-index.json');
        fs.writeFileSync(indexPath, json, 'utf8');
    }
}

// Add or update a mapping { s3Key, openaiFileId, originalName, createdAt }
async function addRateMapping(mapping) {
    const index = await loadRateIndex();
    // Remove any existing entry with same s3Key (update case)
    const filtered = index.filter(m => m.s3Key !== mapping.s3Key);
    filtered.push(mapping);
    await saveRateIndex(filtered);
}

// Remove mapping by S3 key
async function removeRateMappingByS3Key(s3Key) {
    const index = await loadRateIndex();
    const filtered = index.filter(m => m.s3Key !== s3Key);
    await saveRateIndex(filtered);
}

// Get all mappings
async function getAllRateMappings() {
    return await loadRateIndex();
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
                
                // For PDF files, also upload to OpenAI and save mapping
                if (fileExt === '.pdf') {
                    try {
                        const s3Key = useAWS && s3Client ? `rates/${savedFileName}` : 
                                     useGoogleCloud && bucket ? `rates/${savedFileName}` : 
                                     path.join(ratesDir, savedFileName);
                        
                        // Ensure we have a proper Buffer (not a stream)
                        // Multer's buffer might have stream-like properties
                        // Solution: Use Buffer.concat to create a completely new Buffer instance
                        // This strips any stream-like properties and methods
                        let fileBuffer;
                        if (Buffer.isBuffer(file.buffer)) {
                            // Use Buffer.concat to create a fresh Buffer with no inherited methods
                            fileBuffer = Buffer.concat([file.buffer]);
                        } else if (file.buffer instanceof Uint8Array) {
                            // Convert Uint8Array to Buffer, then use concat to ensure it's clean
                            fileBuffer = Buffer.concat([Buffer.from(file.buffer)]);
                        } else {
                            // Fallback: convert to array then to Buffer
                            const arr = Array.from(file.buffer);
                            fileBuffer = Buffer.from(arr);
                        }
                        
                        // Final clean buffer (already clean from concat, but double-check)
                        const cleanBuffer = Buffer.concat([fileBuffer]);
                        
                        // Log file size for debugging
                        const fileSizeMB = cleanBuffer.length / (1024 * 1024);
                        const fileSizeBytes = cleanBuffer.length;
                        console.log(`Attempting to upload ${savedFileName} to OpenAI (${fileSizeMB.toFixed(2)} MB / ${fileSizeBytes} bytes)`);
                        console.log(`Buffer type: ${cleanBuffer.constructor.name}, isBuffer: ${Buffer.isBuffer(cleanBuffer)}`);
                        
                        // Don't block - let OpenAI reject if too large, but log the size for debugging
                        // OpenAI's limit appears to be around 50-100 MB based on 413 errors
                        if (fileSizeMB > 100) {
                            console.warn(`WARNING: File ${savedFileName} is ${fileSizeMB.toFixed(2)} MB - may exceed OpenAI's limit`);
                        }
                        
                        // Upload to OpenAI using a File object to avoid SDK payload issues
                        const openAiUploadFile = await toFile(cleanBuffer, savedFileName, { type: 'application/pdf' });
                        const openAiFile = await openai.files.create({
                            file: openAiUploadFile,
                            purpose: 'assistants'
                        });
                        
                        // Save mapping to index
                        await addRateMapping({
                            s3Key: s3Key,
                            openaiFileId: openAiFile.id,
                            originalName: file.originalname,
                            createdAt: new Date().toISOString()
                        });
                        
                        console.log(`Uploaded ${savedFileName} to OpenAI (ID: ${openAiFile.id}) and saved mapping`);
                    } catch (openAiError) {
                        console.error(`Error uploading ${savedFileName} to OpenAI:`, openAiError);
                        // Continue anyway - file is in S3, just not in OpenAI yet
                        // It will be uploaded on next quotation generation
                    }
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
        
        // Determine S3 key based on storage type
        let s3Key;
        if (useGoogleCloud && bucket) {
            s3Key = `rates/${filename}`;
        } else if (useAWS && s3Client) {
            s3Key = `rates/${filename}`;
        } else {
            s3Key = path.join(ratesDir, filename);
        }
        
        // Check if this file has a mapping in the index (for PDFs)
        // If so, delete from OpenAI and remove from index
        try {
            const index = await loadRateIndex();
            const mapping = index.find(m => {
                // Match by filename (handle different path formats)
                const mappingFilename = m.s3Key.split('/').pop();
                return mappingFilename === filename;
            });
            
            if (mapping && mapping.openaiFileId) {
                try {
                    // Delete from OpenAI
                    await openai.files.del(mapping.openaiFileId);
                    console.log(`Deleted file ${filename} from OpenAI (ID: ${mapping.openaiFileId})`);
                } catch (openAiError) {
                    console.warn(`Failed to delete OpenAI file ${mapping.openaiFileId}:`, openAiError.message);
                    // Continue anyway - we'll still delete from S3 and index
                }
                
                // Remove from index
                await removeRateMappingByS3Key(mapping.s3Key);
                console.log(`Removed mapping for ${filename} from index`);
            }
        } catch (indexError) {
            console.warn('Could not load/update rate index during delete:', indexError.message);
            // Continue with S3/local delete anyway
        }
        
        // Delete from storage (S3/GCS/local)
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

// Save quotation to DynamoDB (shared across devices)
app.post('/api/save-quotation', async (req, res) => {
    try {
        if (!ddbDocClient || !ddbTableName) {
            return res.status(500).json({ error: 'DynamoDB not configured. Set DYNAMODB_TABLE in environment variables.' });
        }
        const { quotation } = req.body || {};
        if (!quotation || !quotation.id) {
            return res.status(400).json({ error: 'Quotation with id is required' });
        }
        const { PutCommand } = require('@aws-sdk/lib-dynamodb');
        const now = new Date().toISOString();
        const updatedQuotation = {
            ...quotation,
            createdAt: quotation.createdAt || now,
            updatedAt: now
        };
        const item = {
            id: String(updatedQuotation.id),
            updatedAt: updatedQuotation.updatedAt,
            createdAt: updatedQuotation.createdAt,
            data: updatedQuotation
        };
        await ddbDocClient.send(new PutCommand({
            TableName: ddbTableName,
            Item: item
        }));
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving quotation:', error);
        res.status(500).json({ error: 'Failed to save quotation', details: error.message });
    }
});

// Get all quotations from DynamoDB
app.get('/api/quotations', async (req, res) => {
    try {
        if (!ddbDocClient || !ddbTableName) {
            return res.status(500).json({ error: 'DynamoDB not configured. Set DYNAMODB_TABLE in environment variables.' });
        }
        const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: ddbTableName
        }));
        const items = result.Items || [];
        const quotations = items.map(item => item.data || item).filter(Boolean);
        quotations.sort((a, b) => {
            const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
            const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
            return bTime - aTime;
        });
        res.json({ quotations });
    } catch (error) {
        console.error('Error loading quotations:', error);
        res.status(500).json({ error: 'Failed to load quotations', details: error.message });
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
        
        // Prepare content for OpenAI
        const enquiryText = emailContent || fileContent || '';
        
        // Try to use existing OpenAI file IDs from the rate index (fast path - no S3 read, no upload)
        let uploadedFileIds = [];
        let uploadedFileNames = [];
        
        try {
            const mappings = await getAllRateMappings();
            if (mappings && mappings.length > 0) {
                uploadedFileIds = mappings.map(m => m.openaiFileId);
                uploadedFileNames = mappings.map(m => m.originalName || m.s3Key.split('/').pop());
                console.log(`Using ${uploadedFileIds.length} rate file(s) from index (no upload needed)`);
            }
        } catch (indexError) {
            console.warn('Failed to load rate index, will fall back to uploading from storage:', indexError.message);
        }
        
        // Helper: upload rate files from storage to OpenAI and build index
        async function uploadFromStorageAndBuildIndex() {
            console.log('Rate index empty or invalid, falling back to reading from storage and uploading to OpenAI...');
            // Get all rate files (from cloud storage or local storage)
            let rateFiles = [];
            if (useGoogleCloud && bucket) {
                const gcsFiles = await listFilesFromGCS('rates');
                rateFiles = gcsFiles.map(f => ({ name: f.name, path: f.path, storageType: 'gcs' }));
            } else if (useAWS && s3Client) {
                const s3Files = await listFilesFromS3('rates');
                rateFiles = s3Files.map(f => ({ name: f.name, path: f.path, storageType: 's3' }));
            } else {
                const localFiles = getAllFiles(ratesDir);
                rateFiles = localFiles.map(filePath => ({ name: path.basename(filePath), path: filePath, storageType: 'local' }));
            }

            if (rateFiles.length === 0) {
                throw new Error('No rate files uploaded. Please upload rate files first.');
            }

            // Upload PDF rate files to OpenAI and build index
            let pdfFilesFound = 0;
            let pdfFilesUploaded = 0;
            const uploadErrors = [];
            const newFileIds = [];
            const newFileNames = [];

            for (const rateFile of rateFiles) {
                try {
                    const fileName = rateFile.name;
                    const fileExt = path.extname(fileName).toLowerCase();

                    if (fileExt !== '.pdf') {
                        console.log(`Skipping non-PDF file: ${fileName} (extension: ${fileExt})`);
                        continue;
                    }

                    pdfFilesFound++;
                    console.log(`Processing PDF file: ${fileName}`);

                    // Read file from cloud storage or local storage
                    let fileBuffer;
                    if (rateFile.storageType === 'gcs') {
                        fileBuffer = await readFileFromGCS(rateFile.path);
                    } else if (rateFile.storageType === 's3') {
                        fileBuffer = await readFileFromS3(rateFile.path);
                    } else {
                        fileBuffer = fs.readFileSync(rateFile.path);
                    }

                    console.log(`Read file ${fileName} from storage (${fileBuffer.length} bytes)`);
                    console.log(`Storage type: ${rateFile.storageType}, Path: ${rateFile.path}`);

                    // Log file size for debugging
                    const fileSizeMB = fileBuffer.length / (1024 * 1024);
                    const fileSizeBytes = fileBuffer.length;
                    console.log(`Attempting to upload ${fileName} to OpenAI (${fileSizeMB.toFixed(2)} MB / ${fileSizeBytes} bytes)`);
                    console.log(`Buffer type: ${fileBuffer.constructor.name}, isBuffer: ${Buffer.isBuffer(fileBuffer)}`);
                    
                    // If file is very large, log a warning
                    if (fileSizeMB > 50) {
                        console.warn(`⚠️ Large file detected: ${fileSizeMB.toFixed(2)} MB. This may exceed OpenAI's limits.`);
                    }

                    // Don't block - let OpenAI reject if too large, but log the size for debugging
                    // OpenAI's limit appears to be around 50-100 MB based on 413 errors
                    if (fileSizeMB > 100) {
                        console.warn(`WARNING: File ${fileName} is ${fileSizeMB.toFixed(2)} MB - may exceed OpenAI's limit`);
                    }

                    // Ensure buffer is completely clean (strip any stream-like properties)
                    // This is important when reading from S3 - the buffer might have inherited properties
                    // that confuse the OpenAI SDK, even if the actual size is small
                    const cleanBuffer = Buffer.concat([fileBuffer]);
                    console.log(`Clean buffer created: ${cleanBuffer.length} bytes (${(cleanBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);

                    // Upload to OpenAI using a File object to avoid SDK payload issues
                    const openAiUploadFile = await toFile(cleanBuffer, fileName, { type: 'application/pdf' });
                    const file = await openai.files.create({
                        file: openAiUploadFile,
                        purpose: 'assistants'
                    });

                    newFileIds.push(file.id);
                    newFileNames.push(fileName);
                    pdfFilesUploaded++;
                    console.log(`Uploaded ${fileName} to OpenAI as file ID: ${file.id}`);

                    // Save mapping to index for future use
                    const s3Key = rateFile.path; // Already includes 'rates/' prefix for cloud storage
                    await addRateMapping({
                        s3Key: s3Key,
                        openaiFileId: file.id,
                        originalName: fileName,
                        createdAt: new Date().toISOString()
                    });
                } catch (error) {
                    console.error(`Error uploading file ${rateFile.name} to OpenAI:`, error);
                    
                    // Provide helpful error message for file size issues
                    let errorMessage = error.message || 'Unknown error';
                    let fileSizeMB = 'unknown';
                    
                    // Safely get file size if fileBuffer exists
                    try {
                        if (typeof fileBuffer !== 'undefined' && fileBuffer && fileBuffer.length) {
                            fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
                        }
                    } catch (e) {
                        // Ignore errors getting file size
                    }
                    
                    if (error.status === 413 || error.message.includes('413') || error.message.includes('capacity limit') || error.message.includes('too large') || error.message.includes('exceeds the capacity')) {
                        errorMessage = `File too large: ${fileSizeMB} MB. OpenAI's file size limit may be lower than expected. Please compress the PDF to under 50 MB or split it into smaller files.`;
                    } else {
                        // Include file size in error for debugging if available
                        if (fileSizeMB !== 'unknown') {
                            errorMessage = `${error.message} (File size: ${fileSizeMB} MB)`;
                        } else {
                            errorMessage = error.message;
                        }
                    }
                    
                    uploadErrors.push({ filename: rateFile.name, error: errorMessage });
                    // Continue with other files even if one fails
                }
            }

            if (newFileIds.length === 0) {
                let errorMessage = 'No PDF rate files found. Please upload PDF rate files.';
                if (rateFiles.length > 0) {
                    const nonPdfCount = rateFiles.length - pdfFilesFound;
                    errorMessage += ` Found ${rateFiles.length} file(s) in storage, but ${pdfFilesFound} PDF file(s) found.`;
                    if (pdfFilesFound > 0 && pdfFilesUploaded === 0) {
                        errorMessage += ' All PDF uploads to OpenAI failed.';
                        if (uploadErrors.length > 0) {
                            errorMessage += ` Errors: ${uploadErrors.map(e => `${e.filename}: ${e.error}`).join('; ')}`;
                        }
                    } else if (pdfFilesFound === 0) {
                        errorMessage += ' No PDF files found (only Excel or other file types).';
                    }
                }
                throw new Error(errorMessage);
            }
            return { uploadedFileIds: newFileIds, uploadedFileNames: newFileNames };
        }

        // If no mappings found, fall back to reading from storage and uploading to OpenAI
        // This also builds the index for next time
        if (uploadedFileIds.length === 0) {
            try {
                const result = await uploadFromStorageAndBuildIndex();
                uploadedFileIds = result.uploadedFileIds;
                uploadedFileNames = result.uploadedFileNames;
            } catch (fallbackError) {
                return res.status(400).json({ error: fallbackError.message });
            }
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
        let completion;
        try {
            completion = await openai.responses.create({
                model: 'gpt-5.2',
                input: input,
                text: {
                    format: { type: 'json_object' }
                },
                temperature: 0.3
            });
        } catch (error) {
            // If OpenAI file IDs are missing, rebuild from storage and retry once
            const isMissingFiles = (error.status === 404) || (error.message && error.message.includes('were not found'));
            if (isMissingFiles) {
                console.warn('OpenAI file IDs missing. Rebuilding from storage and retrying...');
                try {
                    const result = await uploadFromStorageAndBuildIndex();
                    uploadedFileIds = result.uploadedFileIds;
                    uploadedFileNames = result.uploadedFileNames;

                    const retryInput = [
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
                    completion = await openai.responses.create({
                        model: 'gpt-5.2',
                        input: retryInput,
                        text: {
                            format: { type: 'json_object' }
                        },
                        temperature: 0.3
                    });
                } catch (retryError) {
                    throw retryError;
                }
            } else {
                throw error;
            }
        }
        
        // NOTE: Do NOT delete OpenAI files here.
        // We reuse file IDs from the index to avoid re-uploading.
        // Deletion is handled only when a rate file is deleted via /api/delete-rate-file.
        
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

