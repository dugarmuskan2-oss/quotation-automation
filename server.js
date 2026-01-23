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
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files if needed
app.use(express.static(__dirname)); // Serve root files like index.html/logo.png

// Ensure upload directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const ratesDir = path.join(uploadsDir, 'rates');
const instructionsDir = path.join(uploadsDir, 'instructions');

[uploadsDir, ratesDir, instructionsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Configure multer for file uploads
const storage = multer.diskStorage({
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

const upload = multer({ 
    storage: storage,
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
        const tempDir = path.join(__dirname, 'uploads', 'temp');

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
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

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Upload rate files (Excel) - Multiple files allowed
app.post('/api/upload-rates', upload.array('rateFiles', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const results = [];
        const errors = [];
        
        req.files.forEach((file, index) => {
            try {
                // Additional validation
                const validExtensions = ['.xlsx', '.xls', '.pdf'];
                const fileExt = path.extname(file.originalname).toLowerCase();
                
                if (!validExtensions.includes(fileExt)) {
                    errors.push({
                        filename: file.originalname,
                        error: `Invalid file type: ${fileExt}. Only .xlsx, .xls, and .pdf files are allowed.`
                    });
                    // Delete the uploaded file
                    try {
                        fs.unlinkSync(file.path);
                    } catch (unlinkError) {
                        console.error(`Error deleting invalid file ${file.path}:`, unlinkError);
                    }
                    return;
                }
                
                results.push({
                    filename: file.filename,
                    originalName: file.originalname,
                    size: file.size
                });
            } catch (fileError) {
                errors.push({
                    filename: file.originalname || 'Unknown',
                    error: fileError.message
                });
                // Try to clean up
                try {
                    if (file.path) {
                        fs.unlinkSync(file.path);
                    }
                } catch (unlinkError) {
                    // Ignore cleanup errors
                }
            }
        });
        
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
app.post('/api/delete-rate-file', (req, res) => {
    try {
        const { filename } = req.body;
        
        if (!filename) {
            return res.status(400).json({ error: 'Filename required' });
        }
        
        const filePath = path.join(ratesDir, filename);
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Delete the file
        fs.unlinkSync(filePath);
        
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
app.get('/api/current-rates', (req, res) => {
    try {
        const allFiles = getAllFiles(ratesDir);
        if (allFiles.length === 0) {
            return res.json({ hasFiles: false, filenames: [], count: 0 });
        }
        
        const filenames = allFiles.map(filePath => path.basename(filePath));
        
        res.json({ 
            hasFiles: true, 
            filenames: filenames,
            count: allFiles.length
        });
    } catch (error) {
        console.error('Error getting rate files info:', error);
        res.status(500).json({ error: 'Failed to get rate files info' });
    }
});

// Get current instructions (from request body, stored in localStorage on frontend)
app.post('/api/get-instructions', (req, res) => {
    // Instructions are now stored in browser localStorage
    // This endpoint is kept for compatibility but returns empty
    res.json({ 
        hasFile: false,
        content: null
    });
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
        
        // Get all rate files
        const rateFilePaths = getAllFiles(ratesDir);
        
        if (rateFilePaths.length === 0) {
            return res.status(400).json({ error: 'No rate files uploaded. Please upload rate files first.' });
        }
        
        // Prepare content for OpenAI
        const enquiryText = emailContent || fileContent || '';
        
        // Upload PDF rate files directly to OpenAI Files API
        const uploadedFileIds = [];
        const uploadedFileNames = [];
        const tempTxtFiles = [];
        
        for (const rateFilePath of rateFilePaths) {
            try {
                const fileName = path.basename(rateFilePath);
                const fileExt = path.extname(rateFilePath).toLowerCase();

                if (fileExt !== '.pdf') {
                    console.log(`Skipping non-PDF file: ${fileName}`);
                    continue;
                }

                const fileStream = fs.createReadStream(rateFilePath);
                const file = await openai.files.create({
                    file: fileStream,
                    purpose: 'assistants'
                });

                uploadedFileIds.push(file.id);
                uploadedFileNames.push(fileName);
                console.log(`Uploaded ${fileName} to OpenAI as file ID: ${file.id}`);
            } catch (error) {
                console.error(`Error uploading file ${rateFilePath} to OpenAI:`, error);
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

