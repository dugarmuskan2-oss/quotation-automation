/**
 * @jest-environment node
 *
 * tests/enquiry-upload-url.test.js
 *
 * GET /api/enquiry-upload-url — the presigned-URL endpoint the Apps Script uses
 * to upload a LARGE enquiry attachment straight to storage (bypassing the app's
 * request-size limit). Mounts the real rates router with a fake storage so no
 * AWS/S3 is touched.
 */

const express = require('express');
const request = require('supertest');
const createRatesRouter = require('../routes/rates');

// storageFn(name) -> resolves the presign result (or null), or throws.
function makeApp(storageFn) {
    const app = express();
    app.use(express.json());
    const storage = { getEnquiryUploadUrl: storageFn };
    const upload = { array: () => (req, res, next) => next() };   // /upload-rates needs this at mount time
    app.use('/api', createRatesRouter({ openai: {}, upload, storage, ratesDir: '/tmp/rates' }));
    return app;
}

describe('GET /api/enquiry-upload-url', () => {
    const savedSecret = process.env.INGEST_SECRET;
    afterEach(() => {
        if (savedSecret === undefined) delete process.env.INGEST_SECRET;
        else process.env.INGEST_SECRET = savedSecret;
    });

    test('returns the presigned url + key from storage', async () => {
        delete process.env.INGEST_SECRET;
        let calledWith;
        const app = makeApp(async (name) => { calledWith = name; return { url: 'https://s3.example/put', key: 'enquiries/123-big.pdf' }; });
        const res = await request(app).get('/api/enquiry-upload-url?name=123-big.pdf');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ url: 'https://s3.example/put', key: 'enquiries/123-big.pdf' });
        expect(calledWith).toBe('123-big.pdf');
    });

    test('400 when name is missing', async () => {
        delete process.env.INGEST_SECRET;
        let called = false;
        const res = await request(makeApp(async () => { called = true; return null; })).get('/api/enquiry-upload-url');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name is required/);
        expect(called).toBe(false);
    });

    test('501 when storage cannot presign (e.g. S3 not configured)', async () => {
        delete process.env.INGEST_SECRET;
        const res = await request(makeApp(async () => null)).get('/api/enquiry-upload-url?name=big.pdf');
        expect(res.status).toBe(501);
        expect(res.body.error).toMatch(/unavailable/i);
    });

    test('500 when storage throws', async () => {
        delete process.env.INGEST_SECRET;
        const res = await request(makeApp(async () => { throw new Error('boom'); })).get('/api/enquiry-upload-url?name=big.pdf');
        expect(res.status).toBe(500);
    });

    describe('ingest-secret gate', () => {
        const ok = async () => ({ url: 'u', key: 'enquiries/k' });

        test('401 without the secret header when a secret is configured', async () => {
            process.env.INGEST_SECRET = 'sekret';
            let called = false;
            const res = await request(makeApp(async () => { called = true; return ok(); })).get('/api/enquiry-upload-url?name=big.pdf');
            expect(res.status).toBe(401);
            expect(called).toBe(false);
        });

        test('401 with the wrong secret', async () => {
            process.env.INGEST_SECRET = 'sekret';
            const res = await request(makeApp(ok)).get('/api/enquiry-upload-url?name=big.pdf').set('X-Ingest-Secret', 'nope');
            expect(res.status).toBe(401);
        });

        test('200 with the correct secret', async () => {
            process.env.INGEST_SECRET = 'sekret';
            const res = await request(makeApp(ok)).get('/api/enquiry-upload-url?name=big.pdf').set('X-Ingest-Secret', 'sekret');
            expect(res.status).toBe(200);
        });
    });
});

describe('source guard — storage presigner + view route', () => {
    const fs = require('fs');
    const path = require('path');
    const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'storage', 'index.js'), 'utf8');
    const ratesSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'rates.js'), 'utf8');

    test('storage.getEnquiryUploadUrl presigns a PUT under enquiries/ and is S3-only', () => {
        expect(storageSrc).toContain('function getEnquiryUploadUrl');
        expect(storageSrc).toContain('@aws-sdk/s3-request-presigner');
        expect(storageSrc).toContain("'enquiries/' + safe");
        expect(storageSrc).toContain('if (!(useAWS && s3Client)) return null;');
    });

    test('the view route (which serves the uploaded file) only serves enquiries keys', () => {
        expect(ratesSrc).toContain("router.get('/view-enquiry-file'");
        expect(ratesSrc).toContain("!key.includes('enquiries')");
    });
});
