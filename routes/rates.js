'use strict';

/**
 * routes/rates.js
 *
 * Rate file management: upload, delete, view, list.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { toFile } = require('openai/uploads');
const { Readable } = require('stream');

const router = express.Router();

module.exports = function createRatesRouter({ openai, upload, storage, ratesDir }) {

    // ── Upload one or more rate PDFs ──────────────────────────────────────────
    router.post('/upload-rates', upload.array('rateFiles', 10), async (req, res) => {
        try {
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files uploaded' });
            }

            const results = [];
            const errors  = [];

            for (const file of req.files) {
                try {
                    const fileExt = path.extname(file.originalname).toLowerCase();
                    if (fileExt !== '.pdf') {
                        errors.push({ filename: file.originalname, error: `Invalid file type: ${fileExt}. Only PDF files are allowed.` });
                        continue;
                    }

                    let savedFileName;
                    if (storage.isCloudActive()) {
                        const timestamp = Date.now();
                        const ext  = path.extname(file.originalname);
                        const name = path.basename(file.originalname, ext);
                        savedFileName = `${name}_${timestamp}${ext}`;
                        await storage.upload(file.buffer, savedFileName, 'rates');
                    } else {
                        savedFileName = file.filename;
                    }

                    // Upload to OpenAI and record the mapping
                    try {
                        const s3Key = storage.isCloudActive()
                            ? `rates/${savedFileName}`
                            : path.join(ratesDir, savedFileName);

                        let fileBuffer = Buffer.isBuffer(file.buffer)
                            ? Buffer.concat([file.buffer])
                            : Buffer.concat([Buffer.from(file.buffer)]);
                        const cleanBuffer = Buffer.concat([fileBuffer]);

                        const fileSizeMB = cleanBuffer.length / (1024 * 1024);
                        console.log(`Uploading ${savedFileName} to OpenAI (${fileSizeMB.toFixed(2)} MB)`);
                        if (fileSizeMB > 100) console.warn(`WARNING: ${savedFileName} is ${fileSizeMB.toFixed(2)} MB — may exceed OpenAI limit`);

                        const openAiFile = await openai.files.create({
                            file: await toFile(cleanBuffer, savedFileName, { type: 'application/pdf' }),
                            purpose: 'assistants',
                        });

                        await storage.addRateMapping({
                            s3Key,
                            openaiFileId: openAiFile.id,
                            originalName: file.originalname,
                            createdAt: new Date().toISOString(),
                        });
                        console.log(`Uploaded ${savedFileName} to OpenAI (ID: ${openAiFile.id})`);
                    } catch (openAiError) {
                        console.error(`OpenAI upload failed for ${savedFileName}:`, openAiError);
                        // File is in storage — continue anyway
                    }

                    results.push({ filename: savedFileName, originalName: file.originalname, size: file.size });
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
                success: true,
                message: `${results.length} rate file(s) uploaded successfully`,
                filenames: results.map(r => r.filename),
                count: results.length,
                errors: errors.length > 0 ? errors : undefined,
            });
        } catch (error) {
            console.error('Error uploading rate files:', error);
            res.status(500).json({ error: 'Failed to upload rate files', details: error.message });
        }
    });

    // ── Delete a rate file ────────────────────────────────────────────────────
    router.post('/delete-rate-file', async (req, res) => {
        try {
            const { filename } = req.body;
            if (!filename) return res.status(400).json({ error: 'Filename required' });

            // Remove from OpenAI and rate index if mapped
            try {
                const index   = await storage.loadRateIndex();
                const mapping = index.find(m => m.s3Key.split('/').pop() === filename);
                if (mapping && mapping.openaiFileId) {
                    try {
                        await openai.files.del(mapping.openaiFileId);
                        console.log(`Deleted ${filename} from OpenAI (ID: ${mapping.openaiFileId})`);
                    } catch (e) {
                        console.warn(`Failed to delete OpenAI file ${mapping.openaiFileId}:`, e.message);
                    }
                    await storage.removeRateMappingByS3Key(mapping.s3Key);
                }
            } catch (indexError) {
                console.warn('Could not update rate index during delete:', indexError.message);
            }

            // Delete from storage
            try {
                await storage.deleteFile(`rates/${filename}`);
            } catch (error) {
                const is404 = error.code === 404 || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
                if (is404) return res.status(404).json({ error: 'File not found' });
                throw error;
            }

            res.json({ success: true, message: 'File deleted successfully' });
        } catch (error) {
            console.error('Error deleting file:', error);
            res.status(500).json({ error: 'Failed to delete file' });
        }
    });

    // ── View / download a rate file ───────────────────────────────────────────
    router.get('/view-rate-file', async (req, res) => {
        try {
            const rawName = req.query.filename;
            if (!rawName) return res.status(400).json({ error: 'Filename is required' });

            const filename = path.basename(String(rawName));
            if (!filename) return res.status(400).json({ error: 'Invalid filename' });

            const ext = path.extname(filename).toLowerCase();
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
            res.setHeader('Content-Type', contentTypeMap[ext] || 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

            try {
                await storage.streamToResponse(`rates/${filename}`, res);
            } catch (error) {
                if (error.code === 404 && !res.headersSent) res.status(404).json({ error: 'File not found' });
                else if (!res.headersSent) throw error;
            }
        } catch (error) {
            console.error('Error viewing rate file:', error);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to load rate file', details: error.message });
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

    return router;
};
