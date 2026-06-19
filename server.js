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
require('dotenv').config();

const storage = require('./storage');
const { createLineItemId, parseFlexibleNumber, calculateLineItem } = require('./utils/calculations');
const {
    ENTITY_QUOTATION,
    QUOTE_COUNTER_ID,
    QUOTE_COUNTER_START,
    CONFIG_KEY_INSTRUCTIONS,
    CONFIG_KEY_DEFAULT_TERMS,
} = require('./utils/constants');

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

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
const { uploadsDir, ratesDir } = storage;
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
    limits: { fileSize: MAX_UPLOAD_SIZE_BYTES }
});


// ── Modular route files ───────────────────────────────────────────────────────
const createRatesRouter      = require('./routes/rates');
const createConfigRouter     = require('./routes/config');
const createQuotationsRouter = require('./routes/quotations');
const createGmailRouter      = require('./routes/gmail');

app.use('/api', createRatesRouter({ openai, upload, storage, ratesDir }));
app.use('/api', createConfigRouter({ storage }));
app.use('/api', createQuotationsRouter({ ddbDocClient, ddbTableName }));
app.use('/api', createGmailRouter({ ddbDocClient, ddbTableName }));

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

// ── Routes handled by modular files (rates.js, config.js, quotations.js) ─────
// See routes/ directory for upload-rates, delete-rate-file, view-rate-file,
// current-rates, save/get-instructions, save/get-default-terms, save/get-default-margins,
// save-quotation, next-quote-number, GET quotations, GET quotations/:id.

// Alias for internal helpers and _test exports (logic lives in routes/quotations.js)
const { quotationFromItem: quotationSummaryFromDdbItem } = require('./routes/quotations');

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

                    // Upload to OpenAI — include fileName so GPT can distinguish
                    // GI / ERW / Seamless rate files by name when picking rates.
                    const file = await openai.files.create({
                        file: await toFile(cleanBuffer, fileName, { type: 'application/pdf' }),
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

        // Build a per-file rule so GPT knows exactly which file covers which pipe type.
        // Each filename contains a keyword (GI / ERW / Seamless) that identifies its type.
        const fileTypeRules = uploadedFileNames.map(name => {
            if (/\bGI\b/i.test(name))        return `"${name}" → Galvanized Iron (GI) pipes ONLY`;
            if (/\bERW\b/i.test(name))        return `"${name}" → ERW (Electric Resistance Welded) pipes ONLY`;
            if (/seamless/i.test(name))       return `"${name}" → Seamless pipes ONLY`;
            if (/stainless|ss\b/i.test(name)) return `"${name}" → Stainless Steel pipes ONLY`;
            return `"${name}"`;
        });
        const rateFileListText = uploadedFileNames.length > 0
            ? ` RATE FILE RULES — you MUST follow these exactly:\n${fileTypeRules.map((r, i) => `  File ${i + 1}: ${r}`).join('\n')}\nLook at the filename of each rate file to identify its pipe type, then use ONLY that file for matching items of that type. NEVER use GI rates for ERW pipes, ERW rates for GI pipes, or mix any other types. If an item's pipe type is ambiguous, infer it from keywords in its description (e.g. "GI", "galvanised", "ERW", "seamless").`
            : '';

        const promptText = `Please analyze the following enquiry and extract quotation information. Use the PDF rate files provided (${uploadedFileIds.length} file(s)) to match base rates.${rateFileListText} Read the PDF files directly to find the correct rates. If the PDF rate files include a KG/meter (or kg per meter / weight per meter) value for an item, extract it into "kgPerMeter". Return the data in this exact JSON format:

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

Extract ALL items and materials from the enquiry — including pipes, plates, fittings, flanges, structural steel, and any other product types (including all attached enquiry PDFs if any). Do not skip or ignore any item regardless of type. Read every enquiry document and combine relevant data. Match with rates from the uploaded PDF rate files where possible, calculate final rates with margins, and return the complete JSON. When KG/meter is not available for a matched item, return an empty string for "kgPerMeter".`;

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

        // Interleave a text label immediately BEFORE each rate file so GPT can
        // associate each file's content with its pipe type. Dumping all files
        // unlabeled at the end makes GPT read from the first file for every item.
        const rateFileParts = [];
        uploadedFileIds.forEach((fileId, i) => {
            const name = uploadedFileNames[i] || `Rate file ${i + 1}`;
            let typeLabel;
            if (/\bGI\b/i.test(name))                 typeLabel = 'GI PRICE LIST — every rate in this file is for GI (Galvanized Iron) pipes ONLY';
            else if (/\bERW\b/i.test(name))           typeLabel = 'ERW PRICE LIST — every rate in this file is for ERW pipes ONLY';
            else if (/seamless/i.test(name))          typeLabel = 'SEAMLESS PRICE LIST — every rate in this file is for Seamless pipes ONLY';
            else if (/stainless|\bss\b/i.test(name))  typeLabel = 'STAINLESS STEEL PRICE LIST — every rate in this file is for Stainless Steel pipes ONLY';
            else                                       typeLabel = name;
            rateFileParts.push({
                type: 'input_text',
                text: `\n========================================\nRATE FILE ${i + 1} of ${uploadedFileIds.length}: ${typeLabel}.\n(Source filename: "${name}")\nThe PDF immediately following this line IS that price list. Use it ONLY for matching items of that pipe type.\n========================================`
            });
            rateFileParts.push({ type: 'input_file', file_id: fileId });
        });

        const completion = await openai.responses.create({
            model: 'gpt-5.2',
            input: [
                {
                    role: 'system',
                    content: instructions || 'You are a quotation extraction assistant. Extract all items and materials from enquiries — pipes, plates, fittings, flanges, structural steel, or any other product. Match them with rates from the provided PDF rate files where possible. Read the PDF files directly to find the correct rates. Never skip or filter out items based on product type.'
                },
                {
                    role: 'user',
                    content: [
                        ...userContentParts,
                        ...rateFileParts
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

// Lightweight endpoint for the Enquiry Preparer — no rate files, no margin calculations,
// just extract every item exactly as written.
app.post('/api/extract-enquiry-items', upload.single('enquiryFile'), async (req, res) => {
    const emailContent = req.body?.emailContent || '';
    let fileContent = '';
    let enquiryFileId = null;
    let enquiryImageDataUrl = null;

    try {
        if (req.file && isWordEnquiryFile(req.file.originalname)) {
            fileContent = await extractTextFromWordFile(req.file);
        } else if (req.file && isExcelEnquiryFile(req.file.originalname)) {
            fileContent = extractTextFromExcelFile(req.file);
        } else if (req.file && isImageEnquiryFile(req.file.originalname)) {
            enquiryImageDataUrl = getImageDataUrl(req.file);
        } else if (req.file) {
            enquiryFileId = await uploadEnquiryFileToOpenAI(req.file);
        }
    } catch (error) {
        console.error('Failed to process enquiry file:', error);
        return res.status(500).json({ error: 'Failed to process file', details: error.message });
    }

    const contentText = emailContent || fileContent || '';
    if (!contentText && !enquiryFileId && !enquiryImageDataUrl) {
        return res.status(400).json({ error: 'No content provided' });
    }

    const promptText = `Extract every item and material from the following enquiry. Include ALL items — pipes, plates, fittings, flanges, structural steel, or any other product. Never skip any item.

For each item, use your intelligence to separate the description into these four fields:
- "productSpec": the product type plus any standard/grade (everything EXCEPT the size/dimensions). Examples: "ERW Pipe IS:1239 Gr B", "Checkered Plate", "90° Elbow ASTM A234 WPB", "MS Flat Bar"
- "size": the dimensions or size designation only. Examples: "6\\" NB", "3X4", "4\\" NB SCH 40", "50x50x6 MM"
- "quantity": numeric value only, empty string if not mentioned
- "unit": unit of measure (MTRS, NOS, KG, MT, etc.), empty string if not mentioned

Return JSON in this exact format:
{
  "lineItems": [
    {
      "originalDescription": "full item description as written",
      "productSpec": "product type + standard/grade",
      "size": "dimensions/size only",
      "quantity": "numeric quantity or empty string",
      "unit": "UOM or empty string"
    }
  ]
}

Enquiry:
${contentText}`;

    const userContentParts = [{ type: 'input_text', text: promptText }];
    if (enquiryFileId) userContentParts.push({ type: 'input_file', file_id: enquiryFileId });
    if (enquiryImageDataUrl) userContentParts.push({ type: 'input_image', image_url: enquiryImageDataUrl });

    try {
        const completion = await openai.responses.create({
            model: 'gpt-5.2',
            input: [
                {
                    role: 'system',
                    content: 'You are a data extraction assistant for a steel and pipe trading company. Extract every item from the enquiry. For each item intelligently separate the product type+grade into "productSpec" and the dimensions into "size". Never skip any item. Return only valid JSON.'
                },
                {
                    role: 'user',
                    content: userContentParts
                }
            ]
        });

        const responseText =
            completion.output_text ||
            completion.output?.[0]?.content?.[0]?.text ||
            completion.output?.[0]?.content?.[0]?.value || '';

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            const match = responseText.match(/\{[\s\S]*\}/);
            if (match) data = JSON.parse(match[0]);
            else throw new Error('Failed to parse AI response as JSON');
        }

        if (!Array.isArray(data.lineItems)) data.lineItems = [];
        return res.json({ lineItems: data.lineItems });

    } catch (error) {
        console.error('Enquiry item extraction failed:', error);
        return res.status(500).json({ error: 'Failed to extract items', details: error.message });
    }
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
    return (await storage.readText(CONFIG_KEY_INSTRUCTIONS)) || '';
}
async function getDefaultTermsContent() {
    return (await storage.readText(CONFIG_KEY_DEFAULT_TERMS)) || '';
}

// createLineItemId, calculateLineItem, parseFlexibleNumber → utils/calculations.js

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
    const startValue = QUOTE_COUNTER_START;
    const result = await ddbDocClient.send(new UpdateCommand({
        TableName: ddbTableName,
        Key: { id: QUOTE_COUNTER_ID },
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
            _entity: ENTITY_QUOTATION,
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

// SPA catch-all — serve index.html for any non-API GET request so that
// browser history navigation (e.g. /dashboard) works locally too.
// API routes that didn't match any handler fall through to the 404 middleware below.
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
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

