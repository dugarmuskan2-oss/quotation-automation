/**
 * End-to-end smoke: HTTP APIs + main UI flows (tabs, weight table, print iframe).
 * Requires: server on TEST_URL (default http://127.0.0.1:3000), Playwright browsers installed (npx playwright install chromium).
 * Run: node tools/e2e-smoke.mjs
 */
import { chromium } from 'playwright';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';

const failures = [];

function fail(msg) {
    failures.push(msg);
    console.error('FAIL:', msg);
}

async function checkHttp() {
    const health = await fetch(`${base}/api/health`);
    if (!health.ok) fail(`/api/health status ${health.status}`);
    const idx = await fetch(base);
    if (!idx.ok) fail(`GET / status ${idx.status}`);
    const quotes = await fetch(`${base}/api/quotations`);
    if (!quotes.ok) fail(`/api/quotations status ${quotes.status}`);
    try {
        const j = await quotes.json();
        if (!Array.isArray(j) && typeof j !== 'object') fail('/api/quotations not JSON object/array');
    } catch (e) {
        fail('/api/quotations JSON parse: ' + e.message);
    }
}

async function checkBrowser() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
    });

    try {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });

        const qVisible = await page.evaluate(() => {
            const el = document.getElementById('quotationApp');
            return el && el.style.display !== 'none';
        });
        if (!qVisible) fail('quotationApp should be visible on load');

        const apis = await page.evaluate(() => ({
            hasWeight: typeof window.pipeWeightCalculator === 'object',
            hasSwitchQ: typeof window.switchToQuotationTab === 'function',
            hasSwitchW: typeof window.switchToWeightTab === 'function',
            hasSwitchE: typeof window.switchToEnquiryTab === 'function',
            hasEnquiry: typeof window.enquiryPreparer === 'object'
        }));
        if (!apis.hasWeight) fail('window.pipeWeightCalculator missing');
        if (!apis.hasSwitchQ || !apis.hasSwitchW) fail('tab switchers missing');
        if (!apis.hasSwitchE) fail('switchToEnquiryTab missing');
        if (!apis.hasEnquiry) fail('window.enquiryPreparer missing');

        await page.evaluate(() => window.switchToWeightTab());
        const weightShown = await page.evaluate(() => {
            const el = document.getElementById('weightCalculatorApp');
            return el && el.style.display !== 'none';
        });
        if (!weightShown) fail('weightCalculatorApp not shown after switchToWeightTab');

        const rowCount = await page.locator('#pipeWeightTableBody tr').count();
        if (rowCount < 1) fail(`expected >=1 weight row, got ${rowCount}`);

        await page.evaluate(() => {
            const tr = document.querySelector('#pipeWeightTableBody tr');
            const inputs = tr.querySelectorAll('input');
            inputs[0].value = 'E2E test line';
            inputs[1].value = '2';
            inputs[2].value = '3';
            window.pipeWeightCalculator.recalculateFromTable();
        });
        const totalText = await page.locator('#pipeWeightGrandTotal').textContent();
        if (!totalText || !totalText.includes('6')) {
            fail(`grand total expected ~6.00, got ${totalText}`);
        }

        await page.evaluate(() => window.pipeWeightCalculator.printWeightTable());
        await page.waitForFunction(
            () => {
                const f = document.querySelector('body > iframe');
                return (
                    f &&
                    f.contentDocument &&
                    f.contentDocument.body &&
                    f.contentDocument.body.innerHTML.length > 100
                );
            },
            null,
            { timeout: 8000 }
        );
        const printOk = await page.evaluate(() => {
            const iframe = document.querySelector('body > iframe');
            if (!iframe?.contentDocument?.body) return false;
            const t = iframe.contentDocument.body.innerText || '';
            return t.includes('E2E test line') && t.includes('Pipe Weight Calculation');
        });
        if (!printOk) fail('print iframe missing expected text');

        await page.evaluate(() => window.switchToQuotationTab());
        const qAgain = await page.evaluate(() => {
            const el = document.getElementById('quotationApp');
            return el && el.style.display !== 'none';
        });
        if (!qAgain) fail('quotationApp not visible after switch back');

        // Enquiry tab basic wiring + template seeded
        await page.evaluate(() => window.switchToEnquiryTab());
        const enquiryShown = await page.evaluate(() => {
            const el = document.getElementById('enquiryPreparerApp');
            return el && el.style.display !== 'none';
        });
        if (!enquiryShown) fail('enquiryPreparerApp not shown after switchToEnquiryTab');

        const templateSeeded = await page.evaluate(() => {
            const el = document.getElementById('enquiryTemplateText');
            const v = (el && el.value) ? el.value.trim() : '';
            return v.length > 20 && v.includes('{{lineItems}}');
        });
        if (!templateSeeded) fail('enquiry template not seeded (expected default placeholders)');

        // Enquiry creation from a REAL quotation:
        // 1) list summaries from /api/quotations
        // 2) fetch details via /api/quotations/:id until we find one with lineItems
        const injectedRealQuote = await page.evaluate(async (baseUrl) => {
            const listRes = await fetch(`${baseUrl}/api/quotations?limit=50&offset=0`);
            const listJson = await listRes.json();
            const list = Array.isArray(listJson?.quotations) ? listJson.quotations : (Array.isArray(listJson) ? listJson : []);
            if (!list.length) return { ok: false, reason: 'No quotations returned from /api/quotations' };

            for (const q of list) {
                const id = q?.id != null ? String(q.id) : '';
                if (!id) continue;
                const detailRes = await fetch(`${baseUrl}/api/quotations/${encodeURIComponent(id)}`);
                if (!detailRes.ok) continue;
                const detailJson = await detailRes.json();
                const full = detailJson?.quotation || null;
                const header = full?.header || {};
                const qn = full?.quoteNumber || header?.quoteNumber || '';
                const items = Array.isArray(full?.lineItems) ? full.lineItems : [];
                if (String(qn).trim() && items.length > 0) {
                    window.approvedQuotations = [full];
                    return { ok: true, quoteNumber: String(qn).trim(), itemCount: items.length };
                }
            }
            return { ok: false, reason: 'Could not find a quotation with lineItems via /api/quotations/:id' };
        }, base);
        if (!injectedRealQuote?.ok) {
            fail(`could not inject real quotation for enquiry test: ${injectedRealQuote?.reason || 'unknown'}`);
        } else {
            await page.fill('#enquiryFromQuoteNumber', injectedRealQuote.quoteNumber);
            await page.click('text=Create From Quotation');
            const outputHasQuoteNo = await page.evaluate((qn) => {
                const el = document.getElementById('generatedEnquiryText');
                const v = (el && el.value) ? el.value : '';
                return v.includes(String(qn).trim());
            }, injectedRealQuote.quoteNumber);
            if (!outputHasQuoteNo) fail('enquiry output missing quote number for real quotation flow');
        }

        // Enquiry creation from MANUAL input (inject a synthetic quotation and generate)
        const manualOk = await page.evaluate(() => {
            window.approvedQuotations = [
                {
                    header: {
                        quoteNumber: 'E2E/MANUAL/001',
                        billTo: 'Manual Client',
                        kindAttn: 'Mr Manual',
                        projectName: 'Manual Project'
                    },
                    lineItems: [
                        { originalDescription: 'MS Pipe 2 inch Sch 40', quantity: '10', unit: 'Nos' },
                        { originalDescription: 'GI Elbow 2 inch', quantity: '5', unit: 'Nos' }
                    ]
                }
            ];
            const input = document.getElementById('enquiryFromQuoteNumber');
            if (!input) return false;
            input.value = 'E2E/MANUAL/001';
            window.enquiryPreparer.createEnquiryFromQuotationNumber();
            const out = document.getElementById('generatedEnquiryText');
            const v = (out && out.value) ? out.value : '';
            return v.includes('E2E/MANUAL/001') && v.includes('MS Pipe 2 inch') && v.includes('GI Elbow 2 inch');
        });
        if (!manualOk) fail('manual enquiry generation failed (synthetic quotation injection)');

        // Ensure copy button handler doesn't throw
        const copyDidNotThrow = await page.evaluate(() => {
            try {
                const out = document.getElementById('generatedEnquiryText');
                if (out) out.value = 'E2E enquiry copy test';
                window.enquiryPreparer.copyGeneratedEnquiry();
                return true;
            } catch (e) {
                return false;
            }
        });
        if (!copyDidNotThrow) fail('enquiry copy handler threw an exception');

        if (consoleErrors.length) {
            console.warn('Browser console errors (may be env-related):', consoleErrors);
        }
    } finally {
        await browser.close();
    }
}

await checkHttp();
await checkBrowser();

if (failures.length) {
    console.error(`\nE2E smoke: ${failures.length} failure(s)`);
    process.exit(1);
}
console.log('\nE2E smoke: OK (HTTP + tabs + weight calc + print iframe)');
