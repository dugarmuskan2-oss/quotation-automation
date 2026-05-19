/** Shared cleanup for automated test quotations after e2e scripts. */
export async function cleanupAutomatedTestQuotations(baseUrl) {
    const base = baseUrl || process.env.TEST_URL || 'http://127.0.0.1:3000';
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
