/**
 * storage/index.js
 *
 * Unified storage layer. Handles Google Cloud Storage, AWS S3, and local disk.
 * Only one backend is active at a time, chosen by environment variables.
 *
 * Exports a single object with these methods:
 *   upload(buffer, fileName, folder)   — save a file
 *   deleteFile(filePath)               — delete a file
 *   list(folder)                       — list files in a folder
 *   read(filePath)                     — read a file as a Buffer
 *   readText(key)                      — read a config file (instructions, terms, margins)
 *   saveText(key, content)             — save a config file
 *   loadRateIndex()                    — load the OpenAI file ID mapping
 *   saveRateIndex(index)               — save the OpenAI file ID mapping
 *   addRateMapping(mapping)            — add/update one mapping entry
 *   removeRateMappingByS3Key(s3Key)    — remove one mapping entry
 *   getAllRateMappings()               — get all mapping entries
 *   isCloudActive()                    — true if GCS or S3 is configured (used for multer config)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Base directory ───────────────────────────────────────────────────────────
// On Vercel only /tmp is writable; everywhere else use the project root.
const isVercelEnv = process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.VERCEL_URL;
const baseDir     = isVercelEnv ? '/tmp' : path.join(__dirname, '..');
const uploadsDir  = path.join(baseDir, 'uploads');
const ratesDir    = path.join(uploadsDir, 'rates');

// ─── Feature flags ────────────────────────────────────────────────────────────
const useGoogleCloud   = !!(process.env.GOOGLE_CLOUD_BUCKET_NAME || process.env.GOOGLE_CLOUD_CREDENTIALS);
const hasAwsCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const awsRegion        = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const useAWS           = !!(process.env.AWS_S3_BUCKET_NAME || process.env.DYNAMODB_TABLE);

// ─── GCS init ─────────────────────────────────────────────────────────────────
let bucket = null;

if (useGoogleCloud) {
    try {
        const { Storage } = require('@google-cloud/storage');
        let credentials = null;

        if (process.env.GOOGLE_CLOUD_CREDENTIALS) {
            credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS);
        } else if (process.env.GOOGLE_CLOUD_KEY_FILE) {
            const keyPath = path.join(__dirname, '..', process.env.GOOGLE_CLOUD_KEY_FILE);
            if (fs.existsSync(keyPath)) {
                credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            }
        }

        if (credentials) {
            const storageClient = new Storage({
                projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || credentials.project_id,
                credentials,
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

// ─── S3 init ──────────────────────────────────────────────────────────────────
let s3Client     = null;
let s3BucketName = null;

if (process.env.AWS_S3_BUCKET_NAME) {
    try {
        const { S3Client } = require('@aws-sdk/client-s3');
        const s3Config = { region: awsRegion };
        if (hasAwsCredentials) {
            s3Config.credentials = {
                accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            };
        }
        s3Client     = new S3Client(s3Config);
        s3BucketName = process.env.AWS_S3_BUCKET_NAME;
        console.log(`AWS S3 initialized successfully (bucket: ${s3BucketName})`);
    } catch (error) {
        console.warn('AWS S3 not available, using local storage:', error.message);
    }
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function getAllLocalFiles(dir) {
    try {
        const files = fs.readdirSync(dir);
        if (files.length === 0) return [];
        const stats = files.map(file => {
            const filePath = path.join(dir, file);
            return { name: file, path: filePath, time: fs.statSync(filePath).mtime.getTime() };
        });
        stats.sort((a, b) => b.time - a.time);
        return stats.map(f => f.path);
    } catch {
        return [];
    }
}

// ─── GCS helpers ─────────────────────────────────────────────────────────────

async function _gcsUpload(buffer, fileName, folder) {
    const filePath = folder ? `${folder}/${fileName}` : fileName;
    await bucket.file(filePath).save(buffer, { metadata: { contentType: 'application/octet-stream' } });
    return filePath;
}

async function _gcsDelete(filePath) {
    await bucket.file(filePath).delete();
}

async function _gcsList(folder) {
    const [files] = await bucket.getFiles({ prefix: `${folder}/` });
    return files.map(f => ({
        name: f.name.split('/').pop(),
        path: f.name,
        time: f.metadata.updated ? new Date(f.metadata.updated).getTime() : Date.now(),
        storageType: 'gcs',
    }));
}

async function _gcsRead(filePath) {
    const [buffer] = await bucket.file(filePath).download();
    return buffer;
}

// ─── S3 helpers ───────────────────────────────────────────────────────────────

async function _s3Upload(buffer, fileName, folder) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const filePath = folder ? `${folder}/${fileName}` : fileName;
    await s3Client.send(new PutObjectCommand({
        Bucket: s3BucketName, Key: filePath, Body: buffer,
        ContentType: 'application/octet-stream',
    }));
    return filePath;
}

async function _s3Delete(filePath) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new DeleteObjectCommand({ Bucket: s3BucketName, Key: filePath }));
}

async function _s3List(folder) {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const prefix = folder ? `${folder}/` : '';
    const response = await s3Client.send(new ListObjectsV2Command({ Bucket: s3BucketName, Prefix: prefix }));
    if (!response.Contents) return [];
    return response.Contents
        .filter(item => {
            const name = item.Key.split('/').pop();
            return name && name.toLowerCase() !== 'index.json';
        })
        .map(item => ({
            name: item.Key.split('/').pop(),
            path: item.Key,
            time: item.LastModified ? item.LastModified.getTime() : Date.now(),
            storageType: 's3',
        }));
}

async function _s3Read(filePath) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const response = await s3Client.send(new GetObjectCommand({ Bucket: s3BucketName, Key: filePath }));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

// ─── Public unified API ───────────────────────────────────────────────────────

/** Returns true when a cloud backend (GCS or S3) is active. Used by server.js for multer config. */
function isCloudActive() {
    return (useGoogleCloud && !!bucket) || (useAWS && !!s3Client);
}

/** Upload a file buffer. Returns the stored path/key. */
async function upload(buffer, fileName, folder = 'rates') {
    if (useGoogleCloud && bucket) return _gcsUpload(buffer, fileName, folder);
    if (useAWS && s3Client)       return _s3Upload(buffer, fileName, folder);
    const dir = path.join(uploadsDir, folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

/** Delete a file by its stored path/key. */
async function deleteFile(filePath) {
    if (useGoogleCloud && bucket) return _gcsDelete(filePath);
    if (useAWS && s3Client)       return _s3Delete(filePath);
    if (fs.existsSync(filePath))  fs.unlinkSync(filePath);
}

/** List files in a folder. Returns [{ name, path, time, storageType }] */
async function list(folder = 'rates') {
    if (useGoogleCloud && bucket) return _gcsList(folder);
    if (useAWS && s3Client)       return _s3List(folder);
    const dir = folder === 'rates' ? ratesDir : path.join(uploadsDir, folder);
    return getAllLocalFiles(dir).map(f => ({
        name: path.basename(f), path: f,
        time: fs.statSync(f).mtime.getTime(), storageType: 'local',
    }));
}

/** Read a file and return a Buffer. */
async function read(filePath) {
    if (useGoogleCloud && bucket) return _gcsRead(filePath);
    if (useAWS && s3Client)       return _s3Read(filePath);
    return fs.readFileSync(filePath);
}

/**
 * Read a config/text file (instructions.txt, default-terms.txt, default-margins.json).
 * Returns the file content as a string, or null if it doesn't exist.
 */
async function readText(key) {
    try {
        if (useGoogleCloud && bucket) {
            const buffer = await _gcsRead(key);
            return buffer.toString('utf8');
        }
        if (useAWS && s3Client) {
            const buffer = await _s3Read(key);
            return buffer.toString('utf8');
        }
        // Local fallback
        const filePath = path.join(baseDir, key);
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
        return null;
    } catch (error) {
        const is404 = error.code === 404 || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
        if (is404) return null;
        throw error;
    }
}

/** Save a config/text file. */
async function saveText(key, content) {
    const buffer = Buffer.from(content, 'utf8');
    if (useGoogleCloud && bucket) return _gcsUpload(buffer, key, '');
    if (useAWS && s3Client)       return _s3Upload(buffer, key, '');
    fs.writeFileSync(path.join(baseDir, key), content, 'utf8');
}

// ─── Rate index (OpenAI file ID mapping) ──────────────────────────────────────

async function loadRateIndex() {
    try {
        if (useAWS && s3Client) {
            try {
                const buffer = await _s3Read('rates/index.json');
                const data = JSON.parse(buffer.toString('utf8'));
                if (Array.isArray(data)) return data;
            } catch (error) {
                const is404 = error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
                if (!is404) console.warn('loadRateIndex: parse error, returning empty index:', error.message);
            }
            return [];
        }
        if (useGoogleCloud && bucket) {
            try {
                const buffer = await _gcsRead('rates/index.json');
                const data = JSON.parse(buffer.toString('utf8'));
                if (Array.isArray(data)) return data;
            } catch (error) {
                if (error.code !== 404) console.warn('loadRateIndex: parse error, returning empty index:', error.message);
            }
            return [];
        }
        // Local fallback
        const indexPath = path.join(baseDir, 'rates-index.json');
        if (fs.existsSync(indexPath)) {
            const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
        return [];
    } catch (error) {
        console.warn('loadRateIndex: returning empty index due to error:', error.message);
        return [];
    }
}

async function saveRateIndex(index) {
    const json = JSON.stringify(index, null, 2);
    if (useAWS && s3Client)       return _s3Upload(Buffer.from(json, 'utf8'), 'index.json', 'rates');
    if (useGoogleCloud && bucket) return _gcsUpload(Buffer.from(json, 'utf8'), 'index.json', 'rates');
    fs.writeFileSync(path.join(baseDir, 'rates-index.json'), json, 'utf8');
}

async function addRateMapping(mapping) {
    const index = await loadRateIndex();
    const filtered = index.filter(m => m.s3Key !== mapping.s3Key);
    filtered.push(mapping);
    await saveRateIndex(filtered);
}

async function removeRateMappingByS3Key(s3Key) {
    const index = await loadRateIndex();
    await saveRateIndex(index.filter(m => m.s3Key !== s3Key));
}

async function getAllRateMappings() {
    return loadRateIndex();
}

/**
 * Stream a file directly into an HTTP response (efficient for large files).
 * Falls back to buffered send if streaming is not available.
 */
async function streamToResponse(filePath, res) {
    if (useGoogleCloud && bucket) {
        return new Promise((resolve, reject) => {
            const stream = bucket.file(filePath).createReadStream();
            stream.on('error', reject);
            stream.on('end', resolve);
            stream.pipe(res);
        });
    }
    if (useAWS && s3Client) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const response = await s3Client.send(new GetObjectCommand({ Bucket: s3BucketName, Key: filePath }));
        if (!response.Body) throw Object.assign(new Error('Not found'), { code: 404 });
        return new Promise((resolve, reject) => {
            response.Body.on('error', reject).on('end', resolve).pipe(res);
        });
    }
    // Local
    const abs = filePath.startsWith('/') || filePath.includes(':\\') ? filePath : path.join(uploadsDir, filePath);
    if (!require('fs').existsSync(abs)) throw Object.assign(new Error('Not found'), { code: 404 });
    return new Promise((resolve, reject) => {
        const stream = require('fs').createReadStream(abs);
        stream.on('error', reject).on('end', resolve).pipe(res);
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Config
    baseDir,
    uploadsDir,
    ratesDir,
    useAWS,
    useGoogleCloud,
    isCloudActive,
    // File operations
    upload,
    deleteFile,
    list,
    read,
    streamToResponse,
    readText,
    saveText,
    getAllLocalFiles,
    // Rate index
    loadRateIndex,
    saveRateIndex,
    addRateMapping,
    removeRateMappingByS3Key,
    getAllRateMappings,
};
