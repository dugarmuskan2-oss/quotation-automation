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
            hasSwitchW: typeof window.switchToWeightTab === 'function'
        }));
        if (!apis.hasWeight) fail('window.pipeWeightCalculator missing');
        if (!apis.hasSwitchQ || !apis.hasSwitchW) fail('tab switchers missing');

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
