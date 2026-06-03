'use strict';

/**
 * routes/rates.js
 *
 * Rate file management: upload, delete, view, list.
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { toFile } = require('openai/uploads');

const router = express.Router();

const MAX_OPENAI_FILE_MB = 100;

module.exports = function createRatesRouter({ openai, upload, storage, ratesDir }) {

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Find any existing index entry that was uploaded from the same original filename. */
    async function findExistingMappingByOriginalName(originalName) {
        const index = await storage.loadRateIndex();
        return index.find(m => m.originalName === originalName) || null;
    }

    /** Delete the old OpenAI file and remove it from the rate index and storage. */
    async function removePreviousRateVersion(existingMapping) {
        if (existingMapping.openaiFileId) {
            try {
                await openai.files.del(existingMapping.openaiFileId);
                console.log(`Replaced: deleted old OpenAI file (ID: ${existingMapping.openaiFileId})`);
            } catch (e) {
                console.warn(`Could not delete old OpenAI file ${existingMapping.openaiFileId}:`, e.message);
            }
        }
        try {
            await storage.deleteFile(existingMapping.s3Key);
        } catch (e) {
            console.warn(`Could not delete old storage file ${existingMapping.s3Key}:`, e.message);
        }
        await storage.removeRateMappingByS3Key(existingMapping.s3Key);
        console.log(`Replaced: removed old mapping for ${existingMapping.originalName}`);
    }

    /** Build a clean Buffer from a multer file object. */
    function buildCleanBuffer(fileBuffer) {
        if (Buffer.isBuffer(fileBuffer)) return Buffer.concat([fileBuffer]);
        return Buffer.concat([Buffer.from(fileBuffer)]);
    }

    /** Upload a PDF buffer to OpenAI and return the file ID. */
    async function uploadToOpenAI(buffer, fileName) {
        const fileSizeMB = buffer.length / (1024 * 1024);
        console.log(`Uploading ${fileName} to OpenAI (${fileSizeMB.toFixed(2)} MB)`);
        if (fileSizeMB > MAX_OPENAI_FILE_MB) {
            console.warn(`WARNING: ${fileName} is ${fileSizeMB.toFixed(2)} MB — may exceed OpenAI limit`);
        }
        const openAiFile = await openai.files.create({
            file: await toFile(buffer, fileName, { type: 'application/pdf' }),
            purpose: 'assistants',
        });
        console.log(`Uploaded ${fileName} to OpenAI (ID: ${openAiFile.id})`);
        return openAiFile.id;
    }

    /** Save the file to storage and return the storage key. */
    async function saveToStorage(fileBuffer, originalName, multerFilename) {
        if (storage.isCloudActive()) {
            const ext          = path.extname(originalName);
            const name         = path.basename(originalName, ext);
            const savedFileName = `${name}_${Date.now()}${ext}`;
            await storage.upload(fileBuffer, savedFileName, 'rates');
            return { savedFileName, s3Key: `rates/${savedFileName}` };
        }
        return { savedFileName: multerFilename, s3Key: path.join(ratesDir, multerFilename) };
    }

    /** Process a single uploaded rate file end-to-end. */
    async function processSingleRateFile(file) {
        const fileExt = path.extname(file.originalname).toLowerCase();
        if (fileExt !== '.pdf') {
            throw new Error(`Invalid file type: ${fileExt}. Only PDF files are allowed.`);
        }

        // Replace previous version of the same file if one exists
        const existing = await findExistingMappingByOriginalName(file.originalname);
        if (existing) {
            await removePreviousRateVersion(existing);
        }

        const cleanBuffer = buildCleanBuffer(file.buffer);
        const { savedFileName, s3Key } = await saveToStorage(cleanBuffer, file.originalname, file.filename);

        try {
            const openaiFileId = await uploadToOpenAI(cleanBuffer, savedFileName);
            await storage.addRateMapping({
                s3Key,
                openaiFileId,
                originalName: file.originalname,
                createdAt: new Date().toISOString(),
            });
        } catch (openAiError) {
            console.error(`OpenAI upload failed for ${savedFileName}:`, openAiError);
            // File is saved to storage — quotation generation will fall back and re-upload
        }

        return { filename: savedFileName, originalName: file.originalname, size: file.size };
    }

    // ── Upload one or more rate PDFs ──────────────────────────────────────────
    router.post('/upload-rates', upload.array('rateFiles', 10), async (req, res) => {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const results = [];
        const errors  = [];

        for (const file of req.files) {
            try {
                const result = await processSingleRateFile(file);
                results.push(result);
            } catch (fileError) {
                errors.push({ filename: file.originalname || 'Unknown', error: fileError.message });
                if (file.path && fs.existsSync(file.path)) {
                    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
                }
            }
        }

        if (results.length === 0 && errors.length > 0) {
            return res.status(400).json({ error: 'All files failed to upload', details: errors });
        }

        res.json({
            success:   true,
            message:   `${results.length} rate file(s) uploaded successfully`,
            filenames: results.map(r => r.filename),
            count:     results.length,
            errors:    errors.length > 0 ? errors : undefined,
        });
    });

    // ── Delete a rate file ────────────────────────────────────────────────────
    router.post('/delete-rate-file', async (req, res) => {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ error: 'Filename required' });

        try {
            const index   = await storage.loadRateIndex();
            const mapping = index.find(m => m.s3Key.split('/').pop() === filename);
            if (mapping) await removePreviousRateVersion(mapping);
        } catch (indexError) {
            console.warn('Could not update rate index during delete:', indexError.message);
        }

        try {
            await storage.deleteFile(`rates/${filename}`);
        } catch (error) {
            const is404 = error.code === 404 || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
            if (is404) return res.status(404).json({ error: 'File not found' });
            console.error('Error deleting file:', error);
            return res.status(500).json({ error: 'Failed to delete file' });
        }

        res.json({ success: true, message: 'File deleted successfully' });
    });

    // ── View / download a rate file ───────────────────────────────────────────
    router.get('/view-rate-file', async (req, res) => {
        const rawName = req.query.filename;
        if (!rawName) return res.status(400).json({ error: 'Filename is required' });

        const filename = path.basename(String(rawName));
        if (!filename) return res.status(400).json({ error: 'Invalid filename' });

        const contentTypeMap = {
            '.pdf':  'application/pdf',
            '.xls':  'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
            '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
            '.xlx':  'application/vnd.ms-excel',
            '.xlw':  'application/vnd.ms-excel',
            '.ods':  'application/vnd.oasis.opendocument.spreadsheet',
            '.fods': 'application/vnd.oasis.opendocument.spreadsheet.flat',
            '.csv':  'text/csv',
        };
        const ext = path.extname(filename).toLowerCase();
        res.setHeader('Content-Type', contentTypeMap[ext] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

        try {
            await storage.streamToResponse(`rates/${filename}`, res);
        } catch (error) {
            if (!res.headersSent) {
                const is404 = error.code === 404;
                res.status(is404 ? 404 : 500).json({ error: is404 ? 'File not found' : 'Failed to load rate file' });
            }
        }
    });

    // ── List current rate files ───────────────────────────────────────────────
    router.get('/current-rates', async (req, res) => {
        try {
            const files     = await storage.list('rates');
            const filenames = files.map(f => f.name);
            if (filenames.length === 0) return res.json({ hasFiles: false, filenames: [], count: 0 });
            res.json({ hasFiles: true, filenames, count: filenames.length });
        } catch (error) {
            console.error('Error getting rate files info:', error);
            res.status(500).json({ error: 'Failed to get rate files info' });
        }
    });

    // ── Re-index: delete all OpenAI file IDs and re-upload with correct filenames ─
    // Use this once to fix rate files that were previously uploaded without filenames.
    router.post('/reindex-rates', async (req, res) => {
        try {
            const index = await storage.loadRateIndex();

            // Delete old OpenAI files (nameless ones)
            for (const mapping of index) {
                if (mapping.openaiFileId) {
                    try {
                        await openai.files.del(mapping.openaiFileId);
                        console.log(`Re-index: deleted old OpenAI file ${mapping.openaiFileId}`);
                    } catch (e) {
                        console.warn(`Re-index: could not delete ${mapping.openaiFileId}:`, e.message);
                    }
                }
                await storage.removeRateMappingByS3Key(mapping.s3Key);
            }

            // Re-upload each stored rate PDF with its correct filename
            const rateFiles = await storage.list('rates');
            const results   = [];
            const errors    = [];

            for (const rateFile of rateFiles) {
                const fileName = rateFile.name;
                if (path.extname(fileName).toLowerCase() !== '.pdf') continue;
                try {
                    const buffer        = await storage.read(rateFile.path);
                    const cleanBuffer   = Buffer.isBuffer(buffer) ? Buffer.concat([buffer]) : Buffer.from(buffer);
                    const openaiFileId  = await uploadToOpenAI(cleanBuffer, fileName);
                    await storage.addRateMapping({
                        s3Key:        rateFile.path,
                        openaiFileId,
                        originalName: fileName,
                        createdAt:    new Date().toISOString(),
                    });
                    results.push(fileName);
                    console.log(`Re-index: re-uploaded ${fileName} as ${openaiFileId}`);
                } catch (e) {
                    errors.push({ file: fileName, error: e.message });
                    console.error(`Re-index: failed for ${fileName}:`, e.message);
                }
            }

            res.json({
                success:   true,
                reindexed: results,
                errors:    errors.length ? errors : undefined,
                message:   `${results.length} file(s) re-indexed with correct filenames.`,
            });
        } catch (err) {
            console.error('Re-index error:', err);
            res.status(500).json({ error: 'Re-index failed', details: err.message });
        }
    });

    return router;
};
