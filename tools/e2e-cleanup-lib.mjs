/**
 * Shared cleanup for automated test quotations after e2e / Playwright scripts.
 * Calls POST /api/quotations/cleanup-test-data (force-deletes all test rows).
 */
export function getTestServerBaseUrl() {
    return process.env.TEST_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';
}

export async function cleanupAutomatedTestQuotations(baseUrl) {
    const base = baseUrl || getTestServerBaseUrl();
    try {
        const response = await fetch(`${base}/api/quotations/cleanup-test-data`, { method: 'POST' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            return { ok: false, error: body.error || response.statusText, deletedCount: 0 };
        }
        return { ok: true, deletedCount: body.deletedCount || 0, deletedIds: body.deletedIds || [] };
    } catch (error) {
        return { ok: false, error: error.message, deletedCount: 0 };
    }
}

/** Call at end of Playwright / debug scripts to remove test rows from DynamoDB. */
export async function runTestQuotationCleanup(baseUrl) {
    const cleanup = await cleanupAutomatedTestQuotations(baseUrl);
    if (cleanup.ok && cleanup.deletedCount > 0) {
        console.log(`Cleaned up ${cleanup.deletedCount} test quotation(s).`);
    } else if (!cleanup.ok) {
        console.warn('Test quotation cleanup skipped:', cleanup.error);
    }
    return cleanup;
}
