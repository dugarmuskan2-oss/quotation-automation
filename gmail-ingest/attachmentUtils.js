/**
 * Gmail Ingest – Attachment helpers
 * Decode base64 attachments from the ingest payload.
 * Supports PDF (upload to OpenAI), Excel and Word (text extraction).
 */

/**
 * Decode a base64-encoded attachment into a Buffer.
 * @param {string} base64 - Base64 string (e.g. from Utilities.base64Encode in Apps Script)
 * @returns {Buffer}
 */
function decodeBase64Attachment(base64) {
    if (!base64 || typeof base64 !== 'string') {
        throw new Error('Invalid base64 attachment: missing or not a string');
    }
    return Buffer.from(base64, 'base64');
}

/**
 * MIME types and extensions we treat as PDF for enquiry upload.
 */
const PDF_MIME_TYPES = new Set([
    'application/pdf'
]);
const PDF_EXTENSIONS = new Set(['.pdf']);

const EXCEL_EXTENSIONS = new Set([
    '.xlsx', '.xlsm', '.xlsb', '.xls', '.xlx', '.xlw',
    '.ods', '.fods', '.csv', '.dif', '.sylk', '.slk', '.prn',
    '.xml'
]);
const WORD_EXTENSIONS = new Set(['.docx', '.doc', '.rtf']);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * Check if an attachment is an image (for enquiry extraction).
 */
function isImageAttachment(att) {
    if (!att) return false;
    const name = (att.name || '').trim().toLowerCase();
    const contentType = (att.contentType || '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return contentType.indexOf('image/') === 0 || IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get all image attachments for enquiry extraction.
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {Array<{ name: string, contentType: string, buffer: Buffer }>}
 */
function getAllImageAttachments(attachments) {
    const result = [];
    if (!attachments || !Array.isArray(attachments)) return result;
    for (const att of attachments) {
        if (!att.base64) continue;
        if (!isImageAttachment(att)) continue;
        try {
            const buffer = decodeBase64Attachment(att.base64);
            result.push({
                name: att.name || 'enquiry.png',
                contentType: att.contentType || 'image/png',
                buffer
            });
        } catch (e) {
            continue;
        }
    }
    return result;
}

/**
 * Check if an attachment looks like a PDF by name or contentType.
 * @param {{ name?: string, contentType?: string }} att
 * @returns {boolean}
 */
function isPdfAttachment(att) {
    if (!att) return false;
    const name = (att.name || '').toLowerCase();
    const contentType = (att.contentType || '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return PDF_MIME_TYPES.has(contentType) || PDF_EXTENSIONS.has(ext);
}

/**
 * Check if an attachment is Excel (xlsx, xls).
 */
function isExcelAttachment(att) {
    if (!att) return false;
    const name = (att.name || '').trim().toLowerCase();
    const contentType = (att.contentType || '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return EXCEL_EXTENSIONS.has(ext) || contentType.includes('spreadsheet') || contentType.includes('ms-excel') || contentType.includes('opendocument.spreadsheet') || contentType.includes('excel');
}

/**
 * Check if an attachment is Word (docx, doc).
 */
function isWordAttachment(att) {
    if (!att) return false;
    const name = (att.name || '').trim().toLowerCase();
    const contentType = (att.contentType || '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return WORD_EXTENSIONS.has(ext) || contentType.includes('msword') || contentType.includes('wordprocessingml') || contentType.includes('rtf');
}

/**
 * Get the first PDF attachment from the list (for use as enquiry file).
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {{ name: string, contentType: string, buffer: Buffer } | null}
 */
function getFirstPdfAttachment(attachments) {
    const all = getAllPdfAttachments(attachments);
    return all.length > 0 ? all[0] : null;
}

/**
 * Get all PDF attachments from the list (for use as enquiry files).
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {Array<{ name: string, contentType: string, buffer: Buffer }>}
 */
function getAllPdfAttachments(attachments) {
    const result = [];
    if (!attachments || !Array.isArray(attachments)) return result;
    for (const att of attachments) {
        if (!att.base64) continue;
        if (!isPdfAttachment(att)) continue;
        try {
            const buffer = decodeBase64Attachment(att.base64);
            result.push({
                name: att.name || 'enquiry.pdf',
                contentType: att.contentType || 'application/pdf',
                buffer
            });
        } catch (e) {
            continue;
        }
    }
    return result;
}

/**
 * Get all Excel attachments (xlsx, xls) for text extraction.
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {Array<{ name: string, contentType: string, buffer: Buffer }>}
 */
function getAllExcelAttachments(attachments) {
    const result = [];
    if (!attachments || !Array.isArray(attachments)) return result;
    for (const att of attachments) {
        if (!att.base64) continue;
        if (!isExcelAttachment(att)) continue;
        try {
            const buffer = decodeBase64Attachment(att.base64);
            result.push({
                name: att.name || 'enquiry.xlsx',
                contentType: att.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                buffer
            });
        } catch (e) {
            continue;
        }
    }
    return result;
}

/**
 * Get all Word attachments (docx, doc) for text extraction.
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {Array<{ name: string, contentType: string, buffer: Buffer }>}
 */
function getAllWordAttachments(attachments) {
    const result = [];
    if (!attachments || !Array.isArray(attachments)) return result;
    for (const att of attachments) {
        if (!att.base64) continue;
        if (!isWordAttachment(att)) continue;
        try {
            const buffer = decodeBase64Attachment(att.base64);
            result.push({
                name: att.name || 'enquiry.docx',
                contentType: att.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                buffer
            });
        } catch (e) {
            continue;
        }
    }
    return result;
}

/**
 * Get the first attachment that has base64 data (any type), for fallback.
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {{ name: string, contentType: string, buffer: Buffer } | null}
 */
function getFirstAttachment(attachments) {
    if (!attachments || !Array.isArray(attachments)) return null;
    for (const att of attachments) {
        if (!att.base64) continue;
        try {
            const buffer = decodeBase64Attachment(att.base64);
            return {
                name: att.name || 'attachment',
                contentType: att.contentType || 'application/octet-stream',
                buffer
            };
        } catch (e) {
            continue;
        }
    }
    return null;
}

module.exports = {
    decodeBase64Attachment,
    isPdfAttachment,
    isExcelAttachment,
    isWordAttachment,
    isImageAttachment,
    getFirstPdfAttachment,
    getAllPdfAttachments,
    getAllExcelAttachments,
    getAllWordAttachments,
    getAllImageAttachments,
    getFirstAttachment
};
