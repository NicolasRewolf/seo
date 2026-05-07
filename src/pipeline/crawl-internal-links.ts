/**
 * Sprint 9 — Internal link graph crawler.
 *
 * Walks Plouton's sitemap, fetches every URL, parses with cheerio, classifies
 * <a> tags by DOM placement (editorial / nav / footer / related / cta /
 * image), and upserts them into `internal_link_graph`. Each run inserts a
 * `crawl_runs` row for observability (attempts / successes / failures /
 * link counts / error details).
 *
 * Idempotent: deletes existing rows for each `source_path` before inserting
 * the freshly-crawled set, so re-runs on a per-source basis stay clean.
 *
 * Tuned for Wix CDN: concurrency 10, retry/backoff on 429/503/504/socket
 * errors (cf. lib/crawl.ts).
 */
import { supabase } from '../lib/supabase.js';
import { listSitemapUrls } from '../lib/sitemap.js';
import { crawlPool, type CrawlError } from '../lib/crawl.js';
import { classifyLinks } from '../lib/dom-link-classifier.js';
import { canonicalUrl, pathOf } from '../lib/url.js';

const SUPABASE_BATCH = 500;

export type CrawlSummary = {
  crawl_run_id: string;
  sitemap_url: string;
  urls_attempted: number;
  urls_succeeded: number;
  urls_failed: number;
  links_inserted: number;
  errors_count: number;
  duration_ms: number;
};

async function chunkedInsert(
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += SUPABASE_BATCH) {
    const chunk = rows.slice(i, i + SUPABASE_BATCH);
    const { error } = await supabase().from(table).insert(chunk);
    if (error) throw new Error(`insert ${table} (chunk ${i}): ${error.message}`);
  }
}

export async function runCrawl(opts: {
  sitemapUrl: string;
  concurrency?: number;
  /** If set, only crawl the first N URLs (handy for smoke / dev). */
  limit?: number;
}): Promise<CrawlSummary> {
  const t0 = Date.now();
  const sb = supabase();

  // 1. Open crawl_runs row
  const { data: runRow, error: runErr } = await sb
    .from('crawl_runs')
    .insert({ sitemap_url: opts.sitemapUrl, status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`open crawl_runs: ${runErr?.message ?? 'no row'}`);
  const crawlRunId = runRow.id as string;

  try {
    // 2. Discover URLs
    const allUrls = await listSitemapUrls(opts.sitemapUrl);
    const urls = (opts.limit && opts.limit > 0 ? allUrls.slice(0, opts.limit) : allUrls)
      .map((u) => canonicalUrl(u));

    // 3. Fetch in pool
    const results = await crawlPool({ urls, concurrency: opts.concurrency ?? 10 });

    // 4. Classify + collect
    const allEdges: Array<Record<string, unknown>> = [];
    const sourcePaths = new Set<string>();
    const errors: CrawlError[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const r of results) {
      if (!r.ok) {
        failed++;
        errors.push(r.error);
        continue;
      }
      succeeded++;
      const links = classifyLinks({ pageUrl: r.url, html: r.html });
      const srcPath = pathOf(r.url);
      sourcePaths.add(srcPath);
      for (const l of links) {
        allEdges.push({
          source_path: l.source_path,
          target_path: l.target_path,
          anchor_text: l.anchor_text,
          placement: l.placement,
          rel: l.rel,
          crawl_run_id: crawlRunId,
        });
      }
    }

    // 5. Idempotent replace: drop existing edges for the source pages we
    //    just (re-)crawled so the graph reflects the latest crawl. Chunk the
    //    IN clause — PostgREST encodes it as a URL query param and a 440-URL
    //    crawl easily blows past the request URL length limit (~16 KB).
    const sourcesArr = Array.from(sourcePaths);
    const DELETE_CHUNK = 100;
    for (let i = 0; i < sourcesArr.length; i += DELETE_CHUNK) {
      const slice = sourcesArr.slice(i, i + DELETE_CHUNK);
      const { error: delErr } = await sb
        .from('internal_link_graph')
        .delete()
        .in('source_path', slice);
      if (delErr) throw new Error(`delete previous edges (chunk ${i}): ${delErr.message}`);
    }

    // 6. Insert new edges in chunks (Supabase request size limit)
    if (allEdges.length > 0) {
      await chunkedInsert('internal_link_graph', allEdges);
    }

    // 7. Close crawl_runs row
    const { error: updErr } = await sb
      .from('crawl_runs')
      .update({
        completed_at: new Date().toISOString(),
        urls_attempted: urls.length,
        urls_succeeded: succeeded,
        urls_failed: failed,
        links_inserted: allEdges.length,
        errors: errors.slice(0, 200), // cap to keep the row reasonable
        status: 'completed',
      })
      .eq('id', crawlRunId);
    if (updErr) throw new Error(`finalize crawl_runs: ${updErr.message}`);

    return {
      crawl_run_id: crawlRunId,
      sitemap_url: opts.sitemapUrl,
      urls_attempted: urls.length,
      urls_succeeded: succeeded,
      urls_failed: failed,
      links_inserted: allEdges.length,
      errors_count: errors.length,
      duration_ms: Date.now() - t0,
    };
  } catch (err) {
    await sb
      .from('crawl_runs')
      .update({
        completed_at: new Date().toISOString(),
        status: 'failed',
        errors: [{ url: opts.sitemapUrl, status_code: null, message: (err as Error).message, attempt_n: 0 }],
      })
      .eq('id', crawlRunId);
    throw err;
  }
}
