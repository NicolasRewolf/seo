/**
 * Sprint 9 — driver for crawl-internal-links.
 * Usage: npm run crawl  (or npm run crawl -- --limit=5 for smoke)
 */
import { runCrawl } from '../pipeline/crawl-internal-links.js';
import { env } from '../config.js';

function parseArgs(): { limit?: number; sitemap?: string } {
  const out: { limit?: number; sitemap?: string } = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split('=');
    if (!v) continue;
    if (k === '--limit') out.limit = Number(v);
    else if (k === '--sitemap') out.sitemap = v;
    else {
      process.stderr.write(`unknown flag: ${k}\n`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const siteUrl = env.gsc().GSC_SITE_URL.replace(/\/$/, '');
  const sitemapUrl = opts.sitemap ?? `${siteUrl}/sitemap.xml`;

  process.stdout.write(`crawl starting on ${sitemapUrl}…\n`);
  const r = await runCrawl({
    sitemapUrl,
    // Wix CDN starts returning stripped 200s above ~5 parallel — keep this
    // low; we trade a few seconds of wall-clock for full-fidelity HTML.
    concurrency: 5,
    ...(opts.limit ? { limit: opts.limit } : {}),
  });

  process.stdout.write(
    [
      ``,
      `crawl_run_id    : ${r.crawl_run_id}`,
      `sitemap         : ${r.sitemap_url}`,
      `urls attempted  : ${r.urls_attempted}`,
      `urls succeeded  : ${r.urls_succeeded}`,
      `urls failed     : ${r.urls_failed}`,
      `links inserted  : ${r.links_inserted}`,
      `errors logged   : ${r.errors_count}`,
      `duration        : ${(r.duration_ms / 1000).toFixed(1)}s`,
      ``,
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`crawl failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
