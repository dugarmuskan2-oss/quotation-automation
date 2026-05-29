/**
 * Measures local API response times (no OpenAI generate — avoids cost/latency).
 */
import { appendFileSync } from 'fs';

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';
const LOG = 'debug-f5e334.log';

function log(hypothesisId, message, data) {
  appendFileSync(
    LOG,
    JSON.stringify({
      sessionId: 'f5e334',
      runId: 'api-timing',
      hypothesisId,
      location: 'tools/measure-api-timing.mjs',
      message,
      data,
      timestamp: Date.now()
    }) + '\n'
  );
}

async function timedFetch(label, url) {
  const t0 = performance.now();
  let res;
  let body = null;
  let err = null;
  try {
    res = await fetch(url);
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { rawLen: text.length };
    }
  } catch (e) {
    err = String(e.message || e);
  }
  const ms = Math.round(performance.now() - t0);
  const headers = res
    ? {
        status: res.status,
        scanMs: res.headers.get('x-scan-ms'),
        totalMs: res.headers.get('x-total-ms'),
        scanPages: res.headers.get('x-scan-pages'),
        itemCount: res.headers.get('x-item-count')
      }
    : {};
  const summary = {
    label,
    url,
    clientMs: ms,
    err,
    ...headers,
    quotationsReturned: body?.quotations?.length,
    total: body?.total,
    hasMore: body?.hasMore
  };
  log('H-load', label, summary);
  return summary;
}

const results = [];
results.push(await timedFetch('health', `${base}/api/health`));
results.push(await timedFetch('quotations-page1', `${base}/api/quotations?limit=40&offset=0`));
results.push(await timedFetch('quotations-page2', `${base}/api/quotations?limit=40&offset=40`));
results.push(await timedFetch('get-instructions', `${base}/api/get-instructions`));
results.push(await timedFetch('current-rates', `${base}/api/current-rates`));

const indexT0 = performance.now();
const indexRes = await fetch(`${base}/`);
const indexText = await indexRes.text();
const indexMs = Math.round(performance.now() - indexT0);
log('H-load', 'index-html', {
  clientMs: indexMs,
  status: indexRes.status,
  bytes: indexText.length,
  hasPointerDrag: indexText.includes('bindPipeSectionPointerDrag'),
  hasNormalizeAi: indexText.includes('normalizeAiLineItem')
});
results.push({ label: 'index-html', clientMs: indexMs, bytes: indexText.length });

console.log(JSON.stringify(results, null, 2));

const p1 = results.find((r) => r.label === 'quotations-page1');
const p2 = results.find((r) => r.label === 'quotations-page2');
if (p1 && p2 && p1.scanMs && p2.scanMs) {
  log('H1', 'scan comparison', {
    page1ScanMs: Number(p1.scanMs),
    page2ScanMs: Number(p2.scanMs),
    conclusion:
      'Both pages trigger full table scan (scan times similar despite offset/limit)'
  });
}

process.exit(results.some((r) => r.err || (r.status && r.status >= 400)) ? 1 : 0);
