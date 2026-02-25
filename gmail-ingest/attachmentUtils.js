/**
 * Gmail Ingest – Attachment helpers
 * Decode base64 attachments from the ingest payload and pick the first PDF.
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
 * Get the first PDF attachment from the list (for use as enquiry file).
 * @param {Array<{ name?: string, contentType?: string, base64?: string }>} attachments
 * @returns {{ name: string, contentType: string, buffer: Buffer } | null}
 */
function getFirstPdfAttachment(attachments) {
    if (!attachments || !Array.isArray(attachments)) return null;
    for (const att of attachments) {
        if (!att.base64) continue;
        if (!isPdfAttachment(att)) continue;
        try {
            const buffer = decodeBase64Attachment(att.base64);
            return {
                name: att.name || 'enquiry.pdf',
                contentType: att.contentType || 'application/pdf',
                buffer
            };
        } catch (e) {
            continue;
        }
    }
    return null;
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
    getFirstPdfAttachment,
    getFirstAttachment
};
