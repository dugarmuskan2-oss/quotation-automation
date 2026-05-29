/*
    ============================================
    QUOTATION AUTOMATION SERVER
    ============================================
    Node.js backend server for quotation automation with OpenAI

    Log noise: DEP0169 (url.parse) comes from a dependency (e.g. Express), not this file.
    To hide it, set in env: NODE_NO_DEPRECATION=1 or NODE_OPTIONS=--disable-warning=DEP0169
*/

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { Readable } = require('stream');
require('dotenv').config();

const storage = require('./storage');

// DynamoDB (quotation persistence — not part of file storage)
let ddbDocClient = null;
let ddbTableName = null;

const hasAwsCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

// Initialize DynamoDB (if configured)
if (process.env.DYNAMODB_TABLE) {
    try {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        const ddbConfig = { region: awsRegion };
        if (hasAwsCredentials) {
            ddbConfig.credentials = {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            };
        }
        const ddbClient = new DynamoDBClient(ddbConfig);
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
app.use(express.json({ limit: '30mb' }));
app.use(express.static('public')); // Serve static files if needed
app.use(express.static(__dirname)); // Serve root files like index.html/logo.png

// Pull dir paths from storage module (they're computed there)
const { baseDir, uploadsDir, ratesDir } = storage;
const instructionsDir = path.join(uploadsDir, 'instructions');

// Ensure upload directories exist
[uploadsDir, ratesDir, instructionsDir].forEach(dir => {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
        console.error(`Error creating directory ${dir}:`, error);
    }
});

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Configure multer — memory storage when cloud is active, disk otherwise
let multerStorage;
if (storage.isCloudActive()) {
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


// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Debug-mode log sink (writes NDJSON into workspace file).
// NOTE: Do not send secrets/PII here.
app.post('/api/debug-ingest', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const payload = req.body || {};
        const sessionId = String(payload.sessionId || '');
        if (sessionId !== '5f7ab2') {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        const fs = require('fs');
        const path = require('path');
        const logPath = path.join(__dirname, 'debug-5f7ab2.log');
        fs.appendFileSync(logPath, JSON.stringify(payload) + '\n', 'utf8');
        return res.status(204).end();
    } catch (e) {
        return res.status(500).json({ error: 'Failed to write debug log', details: e.message });
    }
});

// Upload rate files (PDF) - Multiple files allowed
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
                const validExtensions = ['.pdf'];
                const fileExt = path.extname(file.originalname).toLowerCase();
                
                if (!validExtensions.includes(fileExt)) {
                    errors.push({
                        filename: file.originalname,
                        error: `Invalid file type: ${fileExt}. Only PDF files are allowed for rate uploads.`
                    });
                    continue;
                }
                
                let savedFileName;

                if (storage.isCloudActive()) {
                    const timestamp = Date.now();
                    const ext = path.extname(file.originalname);
                    const name = path.basename(file.originalname, ext);
                    savedFileName = `${name}_${timestamp}${ext}`;
                    await storage.upload(file.buffer, savedFileName, 'rates');
                } else {
                    // Local storage - file already saved by multer
                    savedFileName = file.filename;
                }

                // For PDF files, also upload to OpenAI and save mapping
                if (fileExt === '.pdf') {
                    try {
                        const s3Key = storage.isCloudActive()
                            ? `rates/${savedFileName}`
                            : path.join(ratesDir, savedFileName);
                        
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
                        await storage.addRateMapping({
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
        
        const s3Key = storage.isCloudActive() ? `rates/${filename}` : path.join(ratesDir, filename);

        // Check if this file has a mapping in the index (for PDFs)
        // If so, delete from OpenAI and remove from index
        try {
            const index = await storage.loadRateIndex();
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
                await storage.removeRateMappingByS3Key(mapping.s3Key);
                console.log(`Removed mapping for ${filename} from index`);
            }
        } catch (indexError) {
            console.warn('Could not load/update rate index during delete:', indexError.message);
            // Continue with S3/local delete anyway
        }
        
        // Delete from storage (S3/GCS/local)
        try {
            await storage.deleteFile(`rates/${filename}`);
        } catch (error) {
            const is404 = error.code === 404 || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
            if (is404) return res.status(404).json({ error: 'File not found' });
            throw error;
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

// View/download rate file
app.get('/api/view-rate-file', async (req, res) => {
    try {
        const rawName = req.query.filename;
        if (!rawName) {
            return res.status(400).json({ error: 'Filename is required' });
        }
        const filename = path.basename(String(rawName));
        if (!filename) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const ext = path.extname(filename).toLowerCase();
        const contentTypeMap = {
            '.pdf': 'application/pdf',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
            '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
            '.xlx': 'application/vnd.ms-excel',
            '.xlw': 'application/vnd.ms-excel',
            '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
            '.fods': 'application/vnd.oasis.opendocument.spreadsheet.flat',
            '.csv': 'text/csv'
        };
        res.setHeader('Content-Type', contentTypeMap[ext] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

        try {
            await storage.streamToResponse(`rates/${filename}`, res);
        } catch (error) {
            if (error.code === 404 && !res.headersSent) {
                res.status(404).json({ error: 'File not found' });
            } else if (!res.headersSent) {
                throw error;
            }
        }
        return;
    } catch (error) {
        console.error('Error viewing rate file:', error);
        return res.status(500).json({ error: 'Failed to load rate file', details: error.message });
    }
});

// Get current rate files info
app.get('/api/current-rates', async (req, res) => {
    try {
        let filenames = [];
        
        const files = await storage.list('rates');
        filenames = files.map(f => f.name);
        
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
        
        await storage.saveText('instructions.txt', instructions);
        
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
        
        content = await storage.readText('instructions.txt');
        hasFile = content !== null;
        
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

// Save default terms and conditions to server (shared across all users/devices)
app.post('/api/save-default-terms', express.json(), async (req, res) => {
    try {
        const { defaultTerms } = req.body;

        if (defaultTerms === undefined || defaultTerms === null) {
            return res.status(400).json({ error: 'Default terms text is required' });
        }

        const content = typeof defaultTerms === 'string' ? defaultTerms : String(defaultTerms);

        await storage.saveText('default-terms.txt', content);

        res.json({
            success: true,
            message: 'Default terms saved successfully'
        });
    } catch (error) {
        console.error('Error saving default terms:', error);
        res.status(500).json({
            error: 'Failed to save default terms',
            details: error.message
        });
    }
});

// Get default terms and conditions from server (shared across all users/devices)
app.get('/api/get-default-terms', async (req, res) => {
    try {
        let content = null;
        let hasFile = false;

        content = await storage.readText('default-terms.txt');
        hasFile = content !== null;

        res.json({
            hasFile: hasFile,
            content: content || ''
        });
    } catch (error) {
        console.error('Error getting default terms:', error);
        res.status(500).json({
            error: 'Failed to get default terms',
            details: error.message
        });
    }
});

function normalizeMarginValue(value) {
    if (value === '' || value === null || value === undefined) {
        return '';
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return '';
    }
    return String(parsed);
}

function sanitizeDefaultMargins(input) {
    const source = (input && typeof input === 'object') ? input : {};
    return {
        erw: normalizeMarginValue(source.erw),
        gi: normalizeMarginValue(source.gi),
        seamless: normalizeMarginValue(source.seamless)
    };
}

// Save default margins to server (shared across all users/devices)
app.post('/api/save-default-margins', express.json(), async (req, res) => {
    try {
        const sanitized = sanitizeDefaultMargins(req.body && req.body.defaultMargins);
        const content = JSON.stringify(sanitized);

        await storage.saveText('default-margins.json', content);

        res.json({
            success: true,
            defaultMargins: sanitized
        });
    } catch (error) {
        console.error('Error saving default margins:', error);
        res.status(500).json({
            error: 'Failed to save default margins',
            details: error.message
        });
    }
});

// Get default margins from server (shared across all users/devices)
app.get('/api/get-default-margins', async (req, res) => {
    try {
        let content = null;
        let hasFile = false;

        content = await storage.readText('default-margins.json');
        hasFile = content !== null;

        let parsed = {};
        if (content) {
            try {
                parsed = JSON.parse(content);
            } catch (parseError) {
                parsed = {};
            }
        }
        const sanitized = sanitizeDefaultMargins(parsed);

        res.json({
            hasFile: hasFile,
            defaultMargins: sanitized
        });
    } catch (error) {
        console.error('Error getting default margins:', error);
        res.status(500).json({
            error: 'Failed to get default margins',
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
            payload: updatedQuotation
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

// Get next quote number (atomic increment in DynamoDB)
app.get('/api/next-quote-number', async (req, res) => {
    try {
        if (!ddbDocClient || !ddbTableName) {
            return res.status(500).json({ error: 'DynamoDB not configured. Set DYNAMODB_TABLE in environment variables.' });
        }
        const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
        const startValue = 107; // first increment yields 108
        const result = await ddbDocClient.send(new UpdateCommand({
            TableName: ddbTableName,
            Key: { id: 'QUOTE_NUMBER_COUNTER' },
            UpdateExpression: 'SET #v = if_not_exists(#v, :start) + :inc, #t = :type',
            ExpressionAttributeNames: {
                '#v': 'value',
                '#t': 'type'
            },
            ExpressionAttributeValues: {
                ':start': startValue,
                ':inc': 1,
                ':type': 'counter'
            },
            ReturnValues: 'UPDATED_NEW'
        }));
        const nextValue = result?.Attributes?.value;
        if (!nextValue) {
            return res.status(500).json({ error: 'Failed to generate next quote number' });
        }
        res.json({ value: nextValue });
    } catch (error) {
        console.error('Error generating next quote number:', error);
        res.status(500).json({ error: 'Failed to generate next quote number', details: error.message });
    }
});

// Max quotations returned by GET /api/quotations (client can pass ?limit= up to this cap)
const QUOTATIONS_LIST_LIMIT = 600;

// Fields that are large and only needed when a quotation folder is actually opened.
// These are stripped from the list response and fetched on-demand via GET /api/quotations/:id.
const QUOTATION_HEAVY_FIELDS = ['tableHTML', 'headerHTML', 'emailContent', 'emailContentHtml', 'fileContent'];

function toQuotationSummary(q) {
    const summary = { ...q };
    QUOTATION_HEAVY_FIELDS.forEach(f => delete summary[f]);
    return summary;
}

// Summary fields projected directly from DynamoDB — avoids reading large map sub-fields
// (tableHTML, emailContent, emailContentHtml, fileContent, etc.) which reduces scan pages.
// Some rows store the quotation under `payload`, others under `data`; we project both.
// 'saved' is aliased because it can conflict with DynamoDB reserved words.
const SUMMARY_NESTED_PATHS = [
    'id', 'quoteNumber', 'companyName', 'projectName',
    'customerName', 'quotationDate', '#sv',
    'assignedTo', 'checkedBy', 'emailLink',
    'gmailMessageId', 'billTo', 'shipTo', 'grandTotal'
];
const SUMMARY_PROJECTION = [
    'id', 'updatedAt', 'createdAt',
    ...SUMMARY_NESTED_PATHS.map(seg => (seg === '#sv' ? '#p.#sv' : '#p.' + seg)),
    ...SUMMARY_NESTED_PATHS.map(seg => (seg === '#sv' ? '#d.#sv' : '#d.' + seg))
].join(', ');
const SUMMARY_EXPR_NAMES = { '#p': 'payload', '#d': 'data', '#sv': 'saved' };

// In-memory cache: quoteNumber(lower) -> quotation id
// Keeps the "load by quote number" flow fast after first hit.
const quotationIdByQuoteNumberCache = new Map();
const QUOTE_NUMBER_CACHE_MAX = 2000;

function normalizeQuoteNumberKey(value) {
    return String(value || '').trim().toLowerCase();
}

function setQuoteNumberCache(key, id) {
    if (!key || !id) return;
    // Simple bounded map. If it grows too large, drop oldest insertion.
    if (quotationIdByQuoteNumberCache.size >= QUOTE_NUMBER_CACHE_MAX) {
        const firstKey = quotationIdByQuoteNumberCache.keys().next().value;
        if (firstKey) quotationIdByQuoteNumberCache.delete(firstKey);
    }
    quotationIdByQuoteNumberCache.set(key, String(id));
}

/** When both `data` and `payload` exist, shallow-merge can leave header fields empty if one map has "" and the other has the real value. Prefer a non-empty string from either map. */
const QUOTATION_HEADER_MERGE_KEYS = [
    'quoteNumber', 'companyName', 'projectName', 'customerName', 'quotationDate',
    'assignedTo', 'checkedBy', 'grandTotal', 'billTo', 'shipTo', 'emailLink', 'gmailMessageId'
];

// Prefer non-empty array/object fields from either map (some older rows store these in only one map,
// or one map can contain an empty array while the other contains the real data).
const QUOTATION_NON_EMPTY_MERGE_KEYS = [
    'lineItems',
    'tableHTML',
    'headerHTML',
    'termsText'
];

function isEmptyStringish(value) {
    if (value == null) {
        return true;
    }
    if (typeof value === 'string') {
        return value.trim() === '';
    }
    return false;
}

function mergeQuotationPayloadAndDataMaps(data, payload) {
    const merged = { ...(data || {}), ...(payload || {}) };
    QUOTATION_HEADER_MERGE_KEYS.forEach((key) => {
        if (!isEmptyStringish(merged[key])) {
            return;
        }
        const dVal = data && data[key];
        const pVal = payload && payload[key];
        if (!isEmptyStringish(dVal)) {
            merged[key] = dVal;
        } else if (!isEmptyStringish(pVal)) {
            merged[key] = pVal;
        }
    });

    QUOTATION_NON_EMPTY_MERGE_KEYS.forEach((key) => {
        const cur = merged[key];
        const dVal = data && data[key];
        const pVal = payload && payload[key];

        const curIsEmptyArray = Array.isArray(cur) && cur.length === 0;
        const dIsNonEmptyArray = Array.isArray(dVal) && dVal.length > 0;
        const pIsNonEmptyArray = Array.isArray(pVal) && pVal.length > 0;

        if ((cur == null || curIsEmptyArray) && (dIsNonEmptyArray || pIsNonEmptyArray)) {
            merged[key] = dIsNonEmptyArray ? dVal : pVal;
            return;
        }

        if (isEmptyStringish(cur) && !isEmptyStringish(dVal)) {
            merged[key] = dVal;
            return;
        }
        if (isEmptyStringish(cur) && !isEmptyStringish(pVal)) {
            merged[key] = pVal;
        }
    });
    return merged;
}

/** Merge `payload` and `data` maps from a DynamoDB item into one quotation object (list or full GET). */
function quotationSummaryFromDdbItem(item) {
    if (!item || item.id === 'QUOTE_NUMBER_COUNTER') {
        return null;
    }
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : null;
    const data = item.data && typeof item.data === 'object' ? item.data : null;
    if (!payload && !data) {
        return null;
    }
    const merged = mergeQuotationPayloadAndDataMaps(data, payload);
    if (merged.id == null) {
        merged.id = item.id;
    }
    if (!merged.createdAt && item.createdAt) {
        merged.createdAt = item.createdAt;
    }
    if (!merged.updatedAt && item.updatedAt) {
        merged.updatedAt = item.updatedAt;
    }
    return merged;
}

// Get all quotations from DynamoDB (summary fields only — heavy fields stripped for speed)
app.get('/api/quotations', async (req, res) => {
    try {
        if (!ddbDocClient || !ddbTableName) {
            return res.status(500).json({ error: 'DynamoDB not configured. Set DYNAMODB_TABLE in environment variables.' });
        }
        const requestedLimit = Math.min(
            QUOTATIONS_LIST_LIMIT,
            Math.max(1, parseInt(req.query.limit, 10) || QUOTATIONS_LIST_LIMIT)
        );
        const requestedOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
        let items = [];
        let lastKey = null;
        let scanPages = 0;
        const _t0 = Date.now();
        do {
            const scanParams = {
                TableName: ddbTableName,
                // ProjectionExpression tells DynamoDB to only return summary fields.
                // This reduces data per scan page → fewer pages → faster scan.
                ProjectionExpression: SUMMARY_PROJECTION,
                ExpressionAttributeNames: SUMMARY_EXPR_NAMES
            };
            if (lastKey) scanParams.ExclusiveStartKey = lastKey;
            const result = await ddbDocClient.send(new ScanCommand(scanParams));
            items = items.concat(result.Items || []);
            lastKey = result.LastEvaluatedKey || null;
            scanPages++;
        } while (lastKey);
        const _tScan = Date.now();
        let quotations = items
            .map(quotationSummaryFromDdbItem)
            .filter(Boolean);
        quotations.sort((a, b) => {
            const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
            const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
            return bTime - aTime;
        });
        const total = quotations.length;
        const pagedQuotations = quotations.slice(requestedOffset, requestedOffset + requestedLimit);
        const hasMore = (requestedOffset + pagedQuotations.length) < total;
        const _tDone = Date.now();
        // Timing headers visible in browser Network tab — useful for diagnosing production speed
        res.set('X-Scan-Ms', String(_tScan - _t0));
        res.set('X-Total-Ms', String(_tDone - _t0));
        res.set('X-Scan-Pages', String(scanPages));
        res.set('X-Item-Count', String(items.length));
        console.log(`[quotations] scanMs=${_tScan-_t0} totalMs=${_tDone-_t0} pages=${scanPages} items=${items.length}`);
        res.json({
            quotations: pagedQuotations,
            hasMore,
            total,
            limit: requestedLimit,
            offset: requestedOffset
        });
    } catch (error) {
        console.error('Error loading quotations:', error);
        res.status(500).json({ error: 'Failed to load quotations', details: error.message });
    }
});

// Lookup quotation id by quoteNumber (fast path for weight calculator).
// Uses a filtered scan with summary projection and returns as soon as a match is found.
app.get('/api/quotations/by-number/:quoteNumber', async (req, res) => {
    try {
        if (!ddbDocClient || !ddbTableName) {
            return res.status(500).json({ error: 'DynamoDB not configured. Set DYNAMODB_TABLE in environment variables.' });
        }
        const rawQn = req.params.quoteNumber;
        const qn = String(rawQn || '').trim();
        if (!qn) {
            return res.status(400).json({ error: 'quoteNumber is required' });
        }
        const key = normalizeQuoteNumberKey(qn);
        const cached = quotationIdByQuoteNumberCache.get(key);
        if (cached) {
            return res.json({ found: true, id: cached, cached: true });
        }

        const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
        const t0 = Date.now();
        let lastKey = null;
        let pages = 0;
        let scanned = 0;

        // Filter must check both payload.quoteNumber and data.quoteNumber.
        const exprNames = { ...SUMMARY_EXPR_NAMES, '#qn': 'quoteNumber' };
        const filter = '(#p.#qn = :qn OR #d.#qn = :qn)';

        while (pages < 200) {
            pages++;
            const params = {
                TableName: ddbTableName,
                ProjectionExpression: SUMMARY_PROJECTION,
                ExpressionAttributeNames: exprNames,
                FilterExpression: filter,
                ExpressionAttributeValues: { ':qn': qn }
            };
            if (lastKey) params.ExclusiveStartKey = lastKey;
            const result = await ddbDocClient.send(new ScanCommand(params));
            scanned += (result.ScannedCount || 0);
            const items = result.Items || [];
            if (items.length) {
                const quotation = quotationSummaryFromDdbItem(items[0]);
                const id = quotation && quotation.id != null ? String(quotation.id) : null;
                if (id) {
                    setQuoteNumberCache(key, id);
                    console.log(`[quotations-by-number] qn=${qn} found id=${id} pages=${pages} scanned=${scanned} ms=${Date.now() - t0}`);
                    return res.json({ found: true, id, cached: false });
                }
            }
            lastKey = result.LastEvaluatedKey || null;
            if (!lastKey) break;
        }

        console.log(`[quotations-by-number] qn=${qn} not-found pages=${pages} scanned=${scanned} ms=${Date.now() - t0}`);
        return res.json({ found: false });
    } catch (error) {
        console.error('Error looking up quotation by number:', error);
        return res.status(500).json({ error: 'Failed to lookup quotation', details: error.message });
    }
});

// Get a single quotation by ID with full data (including heavy fields)
app.get('/api/quotations/:id', async (req, res) => {
    try {
        if (!ddbDocClient || !ddbTableName) {
            return res.status(500).json({ error: 'DynamoDB not configured.' });
        }
        const { GetCommand } = require('@aws-sdk/lib-dynamodb');
        const result = await ddbDocClient.send(new GetCommand({
            TableName: ddbTableName,
            Key: { id: String(req.params.id) }
        }));
        if (!result.Item) {
            return res.status(404).json({ error: 'Quotation not found' });
        }
        const quotation = quotationSummaryFromDdbItem(result.Item);
        if (!quotation) {
            return res.status(404).json({ error: 'Quotation not found' });
        }
        res.json({ quotation });
    } catch (error) {
        console.error('Error fetching quotation:', error);
        res.status(500).json({ error: 'Failed to fetch quotation', details: error.message });
    }
});

async function getUploadedFileContent(uploadedFile) {
    if (!uploadedFile) {
        return '';
    }
    if (uploadedFile.buffer) {
        return uploadedFile.buffer.toString('utf8');
    }
    if (uploadedFile.path) {
        return readFileContent(uploadedFile.path);
    }
    return '';
}

function getMimeTypeForEnquiryFile(fileName) {
    const ext = (path.extname(fileName || '').toLowerCase());
    const mime = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.rtf': 'application/rtf',
        '.txt': 'text/plain',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
        '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
        '.xlx': 'application/vnd.ms-excel',
        '.xlw': 'application/vnd.ms-excel',
        '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
        '.fods': 'application/vnd.oasis.opendocument.spreadsheet.flat',
        '.csv': 'text/csv',
        '.xml': 'application/xml'
    }[ext];
    return mime || 'application/octet-stream';
}

function isWordEnquiryFile(fileName) {
    const ext = (path.extname(fileName || '').toLowerCase());
    return ext === '.doc' || ext === '.docx' || ext === '.rtf';
}

const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.xlx', '.xlw', '.ods', '.fods', '.csv', '.dif', '.sylk', '.slk', '.prn', '.xml'];
function isExcelEnquiryFile(fileName) {
    const ext = (path.extname(fileName || '').toLowerCase());
    return SPREADSHEET_EXTENSIONS.includes(ext);
}

function isImageEnquiryFile(fileName) {
    const ext = (path.extname(fileName || '').toLowerCase());
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
}

function getImageDataUrl(uploadedFile) {
    let fileBuffer;
    if (uploadedFile.buffer) {
        fileBuffer = uploadedFile.buffer;
    } else if (uploadedFile.path) {
        fileBuffer = fs.readFileSync(uploadedFile.path);
    }
    if (!fileBuffer) return null;
    const ext = (path.extname(uploadedFile.originalname || '').toLowerCase());
    const mime = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
    }[ext] || 'image/png';
    const base64 = fileBuffer.toString('base64');
    return `data:${mime};base64,${base64}`;
}

async function extractTextFromWordFile(uploadedFile) {
    const mammoth = require('mammoth');
    let fileBuffer;
    if (uploadedFile.buffer) {
        fileBuffer = uploadedFile.buffer;
    } else if (uploadedFile.path) {
        fileBuffer = fs.readFileSync(uploadedFile.path);
    }
    if (!fileBuffer) return '';
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value || '';
}

function extractTextFromExcelFile(uploadedFile) {
    const XLSX = require('xlsx');
    let fileBuffer;
    if (uploadedFile.buffer) {
        fileBuffer = uploadedFile.buffer;
    } else if (uploadedFile.path) {
        fileBuffer = fs.readFileSync(uploadedFile.path);
    }
    if (!fileBuffer) return '';
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: true });
    const parts = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (csv.trim()) {
            parts.push(`[Sheet: ${sheetName}]\n${csv}`);
        }
    }
    return parts.join('\n\n');
}

async function extractTextFromAttachment(fileLike) {
    if (!fileLike || !fileLike.buffer) return '';
    const name = fileLike.originalname || fileLike.name || '';
    const ext = (path.extname(name) || '').toLowerCase();
    if (SPREADSHEET_EXTENSIONS.includes(ext)) {
        return extractTextFromExcelFile({ buffer: fileLike.buffer, originalname: name });
    }
    if (ext === '.doc' || ext === '.docx' || ext === '.rtf') {
        return await extractTextFromWordFile({ buffer: fileLike.buffer, originalname: name });
    }
    return '';
}

async function uploadEnquiryFileToOpenAI(uploadedFile) {
    if (!uploadedFile) {
        return null;
    }
    if (isWordEnquiryFile(uploadedFile.originalname) || isExcelEnquiryFile(uploadedFile.originalname) || isImageEnquiryFile(uploadedFile.originalname)) {
        return null;
    }
    let fileBuffer;
    if (uploadedFile.buffer) {
        fileBuffer = Buffer.concat([uploadedFile.buffer]);
    } else if (uploadedFile.path) {
        fileBuffer = fs.readFileSync(uploadedFile.path);
    }
    if (!fileBuffer) {
        return null;
    }
    const fileName = uploadedFile.originalname || 'enquiry-file';
    const mimeType = getMimeTypeForEnquiryFile(fileName);
    const openAiUploadFile = await toFile(fileBuffer, fileName, { type: mimeType });
    const file = await openai.files.create({
        file: openAiUploadFile,
        purpose: 'assistants'
    });
    console.log(`Uploaded enquiry file to OpenAI with ID: ${file.id} (${fileName})`);
    return file.id;
}

async function handleGenerateQuotation({ emailContent, fileContent, instructions, enquiryFileId, enquiryFileIds, enquiryImageDataUrl }, res) {
    try {
        const hasEnquiryFile = enquiryFileId || (enquiryFileIds && enquiryFileIds.length > 0);
        if (!emailContent && !fileContent && !hasEnquiryFile && !enquiryImageDataUrl) {
            return res.status(400).json({ error: 'No content provided' });
        }

        if (!instructions || instructions.trim() === '') {
            return res.status(400).json({ error: 'No instructions provided. Please enter instructions first.' });
        }

        // Prepare content for OpenAI
        let enquiryText = emailContent || fileContent || '';
        if (enquiryImageDataUrl && !enquiryText.trim()) {
            enquiryText = '(Enquiry is in the attached image. Please extract all relevant details from the image.)';
        }

        // Try to use existing OpenAI file IDs from the rate index (fast path - no S3 read, no upload)
        let uploadedFileIds = [];
        let uploadedFileNames = [];

        try {
            const mappings = await storage.getAllRateMappings();
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
            rateFiles = await storage.list('rates');

            if (rateFiles.length === 0) {
                throw new Error('No rate files uploaded. Please upload rate files first.');
            }

            // Upload PDF rate files to OpenAI and build index
            let pdfFilesFound = 0;
            let pdfFilesUploaded = 0;
            const uploadErrors = [];

            for (const rateFile of rateFiles) {
                const fileName = rateFile.name;
                const ext = path.extname(fileName).toLowerCase();

                if (ext !== '.pdf') {
                    continue;
                }

                pdfFilesFound++;

                try {
                    let fileBuffer = await storage.read(rateFile.path);

                    console.log(`Uploading file ${fileName} to OpenAI...`);
                    console.log(`Storage type: ${rateFile.storageType}, Path: ${rateFile.path}`);

                    // Log file size for debugging
                    const fileSizeMB = fileBuffer.length / (1024 * 1024);
                    console.log(`File size: ${fileSizeMB.toFixed(2)} MB`);
                    if (fileSizeMB > 10) {
                        console.warn(`⚠️ Large file detected: ${fileSizeMB.toFixed(2)} MB. This may exceed OpenAI's limits.`);
                    }

                    // Ensure buffer is completely clean (strip any stream-like properties)
                    const cleanBuffer = Buffer.from(fileBuffer);

                    // Upload to OpenAI
                    const file = await openai.files.create({
                        file: cleanBuffer,
                        purpose: 'assistants'
                    });

                    console.log(`Uploaded to OpenAI with ID: ${file.id}`);
                    uploadedFileIds.push(file.id);
                    uploadedFileNames.push(fileName);
                    pdfFilesUploaded++;

                    const s3Key = rateFile.path; // Already includes 'rates/' prefix for cloud storage
                    await storage.addRateMapping({ s3Key, openaiFileId: file.id, originalName: fileName });
                } catch (error) {
                    console.error(`Error uploading file ${fileName} to OpenAI:`, error);
                    let errorMessage = error.message || 'Failed to upload to OpenAI';
                    if (error.status === 413 || error.message.includes('413') || error.message.includes('capacity limit') || error.message.includes('too large') || error.message.includes('exceeds the capacity')) {
                        const fileSizeMB = (fileBuffer ? (fileBuffer.length / (1024 * 1024)).toFixed(2) : 'unknown');
                        errorMessage = `File too large: ${fileSizeMB} MB. OpenAI's file size limit may be lower than expected. Please compress the PDF to under 50 MB or split it into smaller files.`;
                    } else if (fileBuffer) {
                        const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
                        errorMessage = `${error.message} (File size: ${fileSizeMB} MB)`;
                    }
                    uploadErrors.push({ filename: fileName, error: errorMessage });
                }
            }

            if (pdfFilesFound === 0) {
                let errorMessage = 'No PDF rate files found. Please upload PDF rate files.';
                if (rateFiles.length > 0) {
                    const nonPdfCount = rateFiles.length - pdfFilesFound;
                    errorMessage += ` Found ${rateFiles.length} file(s) in storage, but ${pdfFilesFound} PDF file(s) found.`;
                }
                throw new Error(errorMessage);
            }

            if (pdfFilesUploaded === 0) {
                const errorMessages = uploadErrors.map(err => `${err.filename}: ${err.error}`).join('; ');
                throw new Error(`Failed to upload rate files to OpenAI. ${errorMessages}`);
            }

            return { uploadErrors };
        }

        if (uploadedFileIds.length === 0) {
            const { uploadErrors } = await uploadFromStorageAndBuildIndex();
            if (uploadErrors.length > 0) {
                console.warn('Some files failed to upload:', uploadErrors);
            }
        }

        const promptText = `Please analyze the following enquiry and extract quotation information. Use the PDF rate files provided (${uploadedFileIds.length} file(s)) to match base rates. Read the PDF files directly to find the correct rates. If the PDF rate files include a KG/meter (or kg per meter / weight per meter) value for an item, extract it into "kgPerMeter". Return the data in this exact JSON format:

{
  "customerName": "",
  "companyName": "",
  "projectName": "",
  "phoneNumber": "",
  "mobileNumber": "",
  "quotationDate": "",
  "lineItems": [
    {
      "originalDescription": "",
      "identifiedPipeType": "",
      "quantity": "",
      "unitRate": "",
      "kgPerMeter": "",
      "marginPercent": "",
      "finalRate": "",
      "lineTotal": ""
    }
  ]
}

Extract all pipe information from the enquiry (including all attached enquiry PDFs if any). Read every enquiry document and combine relevant data. Match with rates from the uploaded PDF rate files, calculate final rates with margins, and return the complete JSON. When KG/meter is not available for a matched item, return an empty string for "kgPerMeter".`;

        const userContentParts = [
            {
                type: 'input_text',
                text: `${promptText}\n\nEnquiry:\n${enquiryText}`
            }
        ];

        const enquiryIds = Array.isArray(enquiryFileIds) && enquiryFileIds.length > 0
            ? enquiryFileIds
            : (enquiryFileId ? [enquiryFileId] : []);
        for (const fid of enquiryIds) {
            userContentParts.push({ type: 'input_file', file_id: fid });
        }
        if (enquiryImageDataUrl) {
            userContentParts.push({
                type: 'input_image',
                image_url: enquiryImageDataUrl
            });
        }

        const completion = await openai.responses.create({
            model: 'gpt-5.2',
            input: [
                {
                    role: 'system',
                    content: instructions || 'You are a quotation extraction assistant. Extract pipe information from enquiries and match them with rates from the provided PDF rate files. Read the PDF files directly to find the correct rates.'
                },
                {
                    role: 'user',
                    content: [
                        ...userContentParts,
                        ...uploadedFileIds.map(fileId => ({
                            type: 'input_file',
                            file_id: fileId
                        }))
                    ]
                }
            ]
        });

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
        quotationData.lineItems = quotationData.lineItems.map(item => calculateLineItem(item));

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
}

// Main API: Generate quotation using OpenAI
app.post('/api/generate-quotation', async (req, res) => {
    const { emailContent, fileContent, instructions } = req.body || {};
    return handleGenerateQuotation({ emailContent, fileContent, instructions }, res);
});

// Generate quotation using OpenAI with multipart upload
app.post('/api/generate-quotation-file', upload.single('enquiryFile'), async (req, res) => {
    const emailContent = req.body?.emailContent || '';
    const instructions = req.body?.instructions || '';
    let fileContent = '';
    let enquiryFileId = null;
    let enquiryImageDataUrl = null;
    try {
        if (req.file && isWordEnquiryFile(req.file.originalname)) {
            fileContent = await extractTextFromWordFile(req.file);
            if (!fileContent.trim() && !emailContent.trim()) {
                return res.status(400).json({ error: 'Could not extract text from Word document or document is empty.' });
            }
        } else if (req.file && isExcelEnquiryFile(req.file.originalname)) {
            fileContent = extractTextFromExcelFile(req.file);
            if (!fileContent.trim() && !emailContent.trim()) {
                return res.status(400).json({ error: 'Could not extract text from Excel file or file is empty.' });
            }
        } else if (req.file && isImageEnquiryFile(req.file.originalname)) {
            enquiryImageDataUrl = getImageDataUrl(req.file);
            if (!enquiryImageDataUrl && !emailContent.trim()) {
                return res.status(400).json({ error: 'Could not read image file.' });
            }
        } else if (req.file) {
            enquiryFileId = await uploadEnquiryFileToOpenAI(req.file);
        }
    } catch (error) {
        console.error('Failed to process enquiry file:', error);
        return res.status(500).json({ error: 'Failed to process enquiry file', details: error.message });
    }
    await handleGenerateQuotation({ emailContent, fileContent, instructions, enquiryFileId, enquiryImageDataUrl }, res);
});

function buildWeightExtractionInstructions(instructions) {
    const baseInstructions = String(instructions || '').trim();
    const weightExtractionScope = [
        'For this request, focus only on extracting pipe line items for the weight calculator.',
        'Identify the pipe description/size, quantity if present, and the corresponding kgPerMeter.',
        'Ignore customer details, quotation headers, pricing, margins, taxes, totals, and non-pipe items.',
        'If kgPerMeter is not available, return it as an empty string.'
    ].join(' ');
    return [baseInstructions, weightExtractionScope].filter(Boolean).join('\n\n');
}

function simplifyWeightExtractionLineItems(lineItems) {
    return (Array.isArray(lineItems) ? lineItems : [])
        .map(item => {
            const quantityValue = parseFlexibleNumber(item.quantity);
            const kgPerMeterValue = parseFlexibleNumber(item.kgPerMeter);
            return {
                lineItemId: item.lineItemId || createLineItemId(),
                originalDescription: item.originalDescription || item.description || '',
                identifiedPipeType: item.identifiedPipeType || '',
                quantity: Number.isFinite(quantityValue) && quantityValue > 0 ? quantityValue.toString() : '',
                kgPerMeter: Number.isFinite(kgPerMeterValue) ? kgPerMeterValue.toFixed(2) : ''
            };
        })
        .filter(item => item.originalDescription || item.identifiedPipeType);
}

app.post('/api/extract-pipe-weights', upload.single('sourceFile'), async (req, res) => {
    const contentText = req.body?.contentText || '';
    const instructions = req.body?.instructions || '';
    let fileContent = '';
    let enquiryFileId = null;
    let enquiryImageDataUrl = null;

    try {
        if (req.file && isWordEnquiryFile(req.file.originalname)) {
            fileContent = await extractTextFromWordFile(req.file);
            if (!fileContent.trim() && !contentText.trim()) {
                return res.status(400).json({ error: 'Could not extract text from Word document or document is empty.' });
            }
        } else if (req.file && isExcelEnquiryFile(req.file.originalname)) {
            fileContent = extractTextFromExcelFile(req.file);
            if (!fileContent.trim() && !contentText.trim()) {
                return res.status(400).json({ error: 'Could not extract text from Excel file or file is empty.' });
            }
        } else if (req.file && isImageEnquiryFile(req.file.originalname)) {
            enquiryImageDataUrl = getImageDataUrl(req.file);
            if (!enquiryImageDataUrl && !contentText.trim()) {
                return res.status(400).json({ error: 'Could not read image file.' });
            }
        } else if (req.file) {
            enquiryFileId = await uploadEnquiryFileToOpenAI(req.file);
        }
    } catch (error) {
        console.error('Failed to process weight extraction file:', error);
        return res.status(500).json({ error: 'Failed to process uploaded file', details: error.message });
    }

    try {
        const quotationData = await generateQuotationData({
            emailContent: contentText,
            fileContent,
            instructions: buildWeightExtractionInstructions(instructions),
            enquiryFileId,
            enquiryImageDataUrl
        });

        return res.json({
            lineItems: simplifyWeightExtractionLineItems(quotationData.lineItems),
            _ai: quotationData._ai || null
        });
    } catch (error) {
        console.error('Error extracting pipe weights:', error);
        const errorMessage = error && typeof error === 'object' && error.error
            ? error.error
            : (error.message || 'Failed to extract pipe weights');
        const errorDetails = error && typeof error === 'object' && error.details
            ? error.details
            : '';
        const statusCode = /No content provided|No instructions provided/i.test(errorMessage) ? 400 : 500;
        return res.status(statusCode).json({
            error: errorMessage,
            details: errorDetails
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

// ---------- Gmail ingest (new files: gmail-ingest/*.js) ----------
async function getInstructionsContent() {
    return (await storage.readText('instructions.txt')) || '';
}
async function getDefaultTermsContent() {
    return (await storage.readText('default-terms.txt')) || '';
}

function createLineItemId(prefix = 'line-item') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Calculate finalRate and lineTotal for a single line item.
 * finalRate = round(unitRate × (1 + margin / 100))
 * lineTotal = quantity × finalRate
 */
function calculateLineItem(item) {
    const unitRate = parseFloat(item.unitRate) || 0;
    const kgPerMeterRaw = parseFlexibleNumber(item.kgPerMeter);
    const kgPerMeter = Number.isFinite(kgPerMeterRaw) ? kgPerMeterRaw : null;
    const marginPercentRaw = parseFloat(item.marginPercent);
    const marginPercent = Number.isFinite(marginPercentRaw) ? marginPercentRaw : 0;
    const quantity = parseFloat(item.quantity) || 0;

    const finalRate = Math.round(unitRate * (1 + marginPercent / 100));
    const lineTotal = quantity * finalRate;

    return {
        lineItemId: item.lineItemId || createLineItemId(),
        originalDescription: item.originalDescription || '',
        identifiedPipeType: item.identifiedPipeType || '',
        quantity: quantity.toString(),
        unitRate: unitRate.toFixed(2),
        kgPerMeter: kgPerMeter == null ? '' : kgPerMeter.toFixed(2),
        marginPercent: marginPercent.toString(),
        finalRate: String(finalRate),
        lineTotal: lineTotal.toFixed(2)
    };
}

function parseFlexibleNumber(value) {
    if (value == null) {
        return null;
    }
    let normalized = String(value).trim();
    if (!normalized) {
        return null;
    }
    normalized = normalized.replace(/[^\d,.\-+]/g, '');
    if (!normalized) {
        return null;
    }

    const hasComma = normalized.includes(',');
    const hasDot = normalized.includes('.');

    if (hasComma && hasDot) {
        if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
            normalized = normalized.replace(/\./g, '').replace(',', '.');
        } else {
            normalized = normalized.replace(/,/g, '');
        }
    } else if (hasComma) {
        // Indian (and Western) format: commas are always thousand separators when there is no dot.
        // Indian: 1,00,000 / 10,00,000 / 1,00,00,000
        // Western: 1,000 / 1,000,000
        // In Indian number format the decimal separator is always a dot, never a comma.
        normalized = normalized.replace(/,/g, '');
    }

    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

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
async function getNextQuoteNumberInternal() {
    if (!ddbDocClient || !ddbTableName) return null;
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const startValue = 107;
    const result = await ddbDocClient.send(new UpdateCommand({
        TableName: ddbTableName,
        Key: { id: 'QUOTE_NUMBER_COUNTER' },
        UpdateExpression: 'SET #v = if_not_exists(#v, :start) + :inc, #t = :type',
        ExpressionAttributeNames: { '#v': 'value', '#t': 'type' },
        ExpressionAttributeValues: { ':start': startValue, ':inc': 1, ':type': 'counter' },
        ReturnValues: 'UPDATED_NEW'
    }));
    return result?.Attributes?.value ?? null;
}
async function findQuotationByGmailMessageId(messageId) {
    if (!ddbDocClient || !ddbTableName || !messageId) return null;
    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
    let items = [];
    let lastKey = null;
    do {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: ddbTableName,
            FilterExpression: '#p.gmailMessageId = :mid',
            ExpressionAttributeNames: { '#p': 'payload' },
            ExpressionAttributeValues: { ':mid': String(messageId) },
            ConsistentRead: true,
            ...(lastKey && { ExclusiveStartKey: lastKey })
        }));
        items = items.concat(result.Items || []);
        lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const found = items[0];
    return found ? (found.payload || found.data || found) : null;
}
async function saveQuotationInternal(quotation) {
    if (!ddbDocClient || !ddbTableName) throw new Error('DynamoDB not configured');
    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const now = new Date().toISOString();
    const updated = { ...quotation, updatedAt: now, createdAt: quotation.createdAt || now };
    await ddbDocClient.send(new PutCommand({
        TableName: ddbTableName,
        Item: {
            id: String(updated.id),
            updatedAt: updated.updatedAt,
            createdAt: updated.createdAt,
            payload: updated
        }
    }));
}
async function uploadEnquiryFileFromBuffer(fileLike) {
    if (!fileLike || !fileLike.buffer) return null;
    return uploadEnquiryFileToOpenAI({
        buffer: fileLike.buffer,
        originalname: fileLike.originalname || 'enquiry.pdf',
        path: null
    });
}

const { createIngestFromGmailRoute } = require('./gmail-ingest/route');
const gmailIngestContext = {
    getInstructionsContent,
    getDefaultTermsContent,
    generateQuotationData,
    getNextQuoteNumber: getNextQuoteNumberInternal,
    saveQuotation: saveQuotationInternal,
    findQuotationByGmailMessageId,
    uploadEnquiryFileToOpenAI: uploadEnquiryFileFromBuffer,
    extractTextFromAttachment
};
const ingestFromGmailHandler = createIngestFromGmailRoute(gmailIngestContext);
app.post('/api/ingest-from-gmail', ingestFromGmailHandler);
app.post('/ingest-from-gmail', ingestFromGmailHandler);
// Gmail ingest via POST /api/health (workaround when /api/ingest-from-gmail 404s on Vercel)
app.post('/api/health', express.json({ limit: '30mb' }), (req, res, next) => {
    if (req.body && Array.isArray(req.body.emails)) {
        return ingestFromGmailHandler(req, res);
    }
    res.json({ status: 'ok', message: 'Server is running' });
});

// Explicit catch for ingest (Vercel may pass path differently)
app.use((req, res, next) => {
    if (req.method === 'POST' && (req.path === '/api/ingest-from-gmail' || req.path === '/ingest-from-gmail' || req.originalUrl === '/api/ingest-from-gmail')) {
        return ingestFromGmailHandler(req, res);
    }
    next();
});

// Error handling middleware - must be after all routes
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        details: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
});

// SPA catch-all — serve index.html for any non-API route so that
// browser history navigation (e.g. /dashboard) works locally too.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 handler for undefined API routes
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`
    });
});

// Export app for Vercel serverless functions
module.exports = app;
module.exports.ingestFromGmailHandler = ingestFromGmailHandler;

// Export pure utility functions for unit testing
module.exports._test = {
    isWordEnquiryFile,
    isExcelEnquiryFile,
    isImageEnquiryFile,
    getImageDataUrl,
    quotationSummaryFromDdbItem,
    calculateLineItem,
    parseFlexibleNumber,
};

// Start server only when running locally (not on Vercel)
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.VERCEL_URL;
const isTest = process.env.NODE_ENV === 'test';
if (!isVercel && !isTest) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
        if (!process.env.OPENAI_API_KEY) console.log('Set OPENAI_API_KEY in env');
    });
}

