/*
 * Extract text from uploaded enquiry files: PDF, DOCX, and images (via OpenAI Vision).
 * Used so the quotation API can accept file uploads instead of only pasted text.
 */

const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

function isImage(filename, mimeType) {
    const ext = path.extname((filename || '').toLowerCase());
    return IMAGE_EXTENSIONS.has(ext) || (mimeType && IMAGE_MIMES.has(mimeType.toLowerCase()));
}

/**
 * Extract text from a file buffer.
 * @param {Buffer} buffer - File contents
 * @param {string} originalName - Original filename (e.g. "quote.pdf")
 * @param {object} options - Optional: { openai } for image OCR via OpenAI Vision
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromFile(buffer, originalName, options = {}) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
        return '';
    }
    const ext = path.extname((originalName || '').toLowerCase());
    const mime = (options.mimeType || '').toLowerCase();

    // Images: use OpenAI Vision if available
    if (isImage(originalName, mime || null)) {
        if (options.openai) {
            return extractTextFromImageWithVision(buffer, options.openai, options.mimeType || 'image/png');
        }
        return '[Image uploaded but OpenAI Vision not available for OCR. Add email or text for best results.]';
    }

    // PDF
    if (ext === '.pdf' || mime === 'application/pdf') {
        return extractTextFromPdf(buffer, options);
    }

    // Word
    if (['.docx', '.doc'].includes(ext) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword') {
        return extractTextFromDocx(buffer);
    }

    // Plain text
    if (['.txt', '.text'].includes(ext) || mime === 'text/plain') {
        return buffer.toString('utf8');
    }

    return '';
}

const MIN_PDF_TEXT_LENGTH = 25;

async function extractTextFromPdf(buffer, options = {}) {
    let parser;
    try {
        const { PDFParse } = require('pdf-parse');
        parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        let text = (result && result.text) ? String(result.text).trim() : '';
        await parser.destroy();
        parser = null;

        if (text && text.length >= MIN_PDF_TEXT_LENGTH) {
            console.log('PDF extraction OK (text), length:', text.length);
            return text;
        }

        if (text && text.length > 0) {
            console.warn('PDF text very short (' + text.length + ' chars), treating as image for OCR');
        } else {
            console.warn('PDF extraction returned no text, treating as image for OCR');
        }

        if (!options.openai) {
            return text || '[PDF has no extractable text. For scanned/image PDFs, OpenAI Vision (OCR) is required.]';
        }

        parser = new PDFParse({ data: buffer });
        const screenshotResult = await parser.getScreenshot({ imageDataUrl: true });
        await parser.destroy();
        parser = null;

        const parts = [];
        const pages = screenshotResult && screenshotResult.pages ? screenshotResult.pages : [];
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const dataUrl = page.dataUrl;
            if (!dataUrl) continue;
            const pageText = await extractTextFromImageUrl(dataUrl, options.openai);
            if (pageText) {
                parts.push(pages.length > 1 ? `--- Page ${(page.pageNumber || i + 1)} ---\n${pageText}` : pageText);
            }
        }
        const ocrText = parts.join('\n\n');
        if (ocrText) {
            console.log('PDF OCR (Vision) OK, total length:', ocrText.length);
        }
        return ocrText;
    } catch (err) {
        console.warn('pdf-parse error:', err.message);
        return '';
    } finally {
        if (parser && typeof parser.destroy === 'function') {
            try {
                await parser.destroy();
            } catch (e) {
                // ignore
            }
        }
    }
}

async function extractTextFromImageUrl(dataUrl, openai) {
    if (!dataUrl || !openai) return '';
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Extract all text and any numbers, lists, or table-like content from this image. Include anything that could be used for a quotation (items, quantities, descriptions). Return only the extracted text, no commentary.'
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: dataUrl,
                                detail: 'high'
                            }
                        }
                    ]
                }
            ],
            max_tokens: 4096
        });
        const text = completion.choices && completion.choices[0] && completion.choices[0].message
            ? completion.choices[0].message.content
            : '';
        return (text || '').trim();
    } catch (err) {
        console.warn('OpenAI Vision (image URL) error:', err.message);
        return '';
    }
}

async function extractTextFromDocx(buffer) {
    try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return (result && result.value) ? String(result.value).trim() : '';
    } catch (err) {
        console.warn('mammoth extract error:', err.message);
        return '';
    }
}

async function extractTextFromImageWithVision(buffer, openai, mimeType) {
    const base64 = buffer.toString('base64');
    const mediaType = mimeType || 'image/png';
    const dataUrl = `data:${mediaType};base64,${base64}`;
    return extractTextFromImageUrl(dataUrl, openai);
}

module.exports = {
    extractTextFromFile,
    isImage
};
