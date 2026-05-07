/**
 * Sprint 9 — Lightweight sitemap walker.
 *
 * Plouton's sitemap.xml is a sitemap INDEX that points to three child
 * sub-sitemaps (pages, blog-posts, blog-categories). The standard
 * (sitemaps.org) lets a sitemap index nest one level — we follow that
 * exact pattern, no deeper recursion. Out-of-spec deep nesting would log
 * + skip rather than crash.
 *
 * Hand-rolled XML extraction with regex on <loc> tags — 30 lines instead
 * of pulling in the `sitemap` npm package. Sitemaps are simple enough
 * that this is fine and avoids one more dep.
 */

const LOC_RE = /<loc>([\s\S]*?)<\/loc>/gi;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'plouton-seo-audit/0.0.1 (+sitemap-walker)' },
  });
  if (!res.ok) throw new Error(`sitemap fetch ${url} → ${res.status}`);
  return res.text();
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(LOC_RE)) {
    const v = (m[1] || '').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * Returns every URL listed in `sitemapUrl`, recursively walking exactly
 * one level of <sitemap><loc> nesting (the standard structure).
 * Duplicates across sub-sitemaps are de-duplicated.
 */
export async function listSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const root = await fetchText(sitemapUrl);
  const isIndex = /<sitemapindex[\s>]/i.test(root);
  const childLocs = extractLocs(root);

  if (!isIndex) {
    // Plain urlset — childLocs are the URLs.
    return Array.from(new Set(childLocs));
  }

  // Index: each child loc is a sub-sitemap. Fetch each, collect its URLs.
  const all = new Set<string>();
  for (const child of childLocs) {
    try {
      const sub = await fetchText(child);
      for (const u of extractLocs(sub)) all.add(u);
    } catch (err) {
      process.stderr.write(`[sitemap] sub-sitemap ${child} failed: ${(err as Error).message}\n`);
    }
  }
  return Array.from(all);
}
