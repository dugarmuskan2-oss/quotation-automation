/**
 * Delete all automated test quotations from DynamoDB (debug/E2E rows).
 * Run: npm run cleanup:e2e
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
