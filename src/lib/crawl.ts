/**
 * Sprint 9 — Polite HTTP crawler with retry/backoff.
 *
 * Wix CDN throttles aggressively (we already saw 503s on the Wix Blog API
 * during Sprint 7 reconciliation). The crawler uses concurrency 10 with
 * exponential backoff on 429/503/504 + transient socket errors so a brief
 * throttle doesn't drop URLs from the inbound graph (which would create
 * false "page newly orphan" signals on the next audit cycle).
 *
 * Retries are bounded (max 3 attempts) so a permanently-broken endpoint
 * doesn't stall the whole crawl.
 */

export type CrawlError = {
  url: string;
  status_code: number | null;
  message: string;
  attempt_n: number;
};

export type FetchResult =
  | { url: string; ok: true; html: string; status: number }
  | { url: string; ok: false; error: CrawlError };

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

function shouldRetry(status: number | null, message: string): boolean {
  if (status != null && RETRY_STATUS.has(status)) return true;
  // Network-layer errors: ECONNRESET, ETIMEDOUT, etc.
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_/i.test(message)) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wix CDN throttle behavior: under concurrency, returns 200 with a sharply
 * reduced HTML payload (~30 % of nominal) instead of 429/503. We treat
 * unusually-small responses as a soft failure and retry — without this,
 * the crawler reports 100% success while the parser silently produces a
 * fraction of the expected edges (observed 5910 vs ~23k on Plouton's
 * 440-URL sitemap at concurrency 10).
 */
const MIN_HTML_BYTES = 200_000; // Plouton's smallest content page is ~400 KB

async function fetchWithRetry(url: string): Promise<FetchResult> {
  let lastErr: CrawlError = {
    url,
    status_code: null,
    message: 'no attempt',
    attempt_n: 0,
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'plouton-seo-audit/0.0.1 (+link-graph-crawler)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err: CrawlError = {
          url,
          status_code: res.status,
          message: body.slice(0, 200) || res.statusText,
          attempt_n: attempt,
        };
        if (!shouldRetry(res.status, err.message) || attempt === MAX_ATTEMPTS) {
          return { url, ok: false, error: err };
        }
        lastErr = err;
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }
      const html = await res.text();
      // Sanity check: Wix throttle returns 200 with a stripped shell.
      if (html.length < MIN_HTML_BYTES) {
        const err: CrawlError = {
          url,
          status_code: res.status,
          message: `suspiciously small HTML (${html.length} bytes < ${MIN_HTML_BYTES}); likely Wix CDN throttle`,
          attempt_n: attempt,
        };
        if (attempt === MAX_ATTEMPTS) {
          // Accept the small response on last attempt rather than dropping
          // the URL entirely — better to record the truncated content
          // than to lose the source from the graph.
          return { url, ok: true, html, status: res.status };
        }
        lastErr = err;
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }
      return { url, ok: true, html, status: res.status };
    } catch (e) {
      const msg = (e as Error).message;
      const err: CrawlError = { url, status_code: null, message: msg, attempt_n: attempt };
      if (!shouldRetry(null, msg) || attempt === MAX_ATTEMPTS) {
        return { url, ok: false, error: err };
      }
      lastErr = err;
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
  }
  return { url, ok: false, error: lastErr };
}

/**
 * Pool of `concurrency` workers consuming `urls`. Returns results in input
 * order. Each result is either { ok:true, html } or { ok:false, error }
 * — caller decides how to count successes/failures.
 */
export async function crawlPool(opts: {
  urls: string[];
  concurrency?: number;
}): Promise<FetchResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 10);
  const out: FetchResult[] = new Array(opts.urls.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= opts.urls.length) return;
      const url = opts.urls[i]!;
      out[i] = await fetchWithRetry(url);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
