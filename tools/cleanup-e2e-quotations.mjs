/**
 * Delete automated E2E test quotations from DynamoDB (id e2e-* or quote E2E/...).
 * Run: node tools/cleanup-e2e-quotations.mjs
 */
const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

const response = await fetch(`${base}/api/quotations/cleanup-test-data`, { method: 'POST' });
const body = await response.json().catch(() => ({}));
if (!response.ok) {
    console.error('Cleanup failed:', response.status, body);
    process.exit(1);
}
console.log(`Removed ${body.deletedCount || 0} test quotation(s).`);
if (body.deletedIds && body.deletedIds.length) {
    body.deletedIds.forEach((id) => console.log('  -', id));
}
