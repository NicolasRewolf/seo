/**
 * Sprint 9 — Compare the legacy regex link extractor (pre-Sprint-9) against
 * the new DOM-based classifier on real Plouton URLs.
 *
 * Usage: npm run compare:scrapers
 *
 * For each URL we print:
 *   - Per-bucket counts (legacy editorial/nav vs new editorial/nav/footer/related/cta/image)
 *   - Matches    — link present in both with same classification
 *   - Diffs      — link present in both but classification differs
 *   - Lost       — link present in legacy, absent in new
 *   - Gained     — link present in new, absent in legacy
 *
 * Output is also written as JSON fixtures to tests/fixtures/scraper-diff/
 * (one file per URL). Useful as snapshot tests next time someone touches
 * the parser logic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyLinks } from '../lib/dom-link-classifier.js';
import { pathOf } from '../lib/url.js';
import { supabase } from '../lib/supabase.js';

// --- Legacy extractor (pre-Sprint-9) — verbatim copy of what was on main
//     before the Sprint-9 refactor. Kept here as a frozen reference so we
//     can A/B compare. DO NOT call this from production code.
type LegacyLink = { anchor: string; target: string; placement: 'editorial' | 'nav' | 'related_post' };

const NAMED_ENTITIES_LEGACY: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å',
  ocirc: 'ô', ouml: 'ö', oslash: 'ø',
  ucirc: 'û', uuml: 'ü', icirc: 'î', iuml: 'ï',
  ccedil: 'ç', ntilde: 'ñ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â',
  Ocirc: 'Ô', Ucirc: 'Û', Icirc: 'Î', Ccedil: 'Ç',
  laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  hellip: '…', ndash: '–', mdash: '—',
};
function decodeEntitiesLegacy(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (full, name: string) => NAMED_ENTITIES_LEGACY[name] ?? full);
}
function stripTagsLegacy(s: string): string {
  return decodeEntitiesLegacy(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function classifyAnchorHeuristic(anchor: string, target: string): 'editorial' | 'nav' | 'related_post' {
  let p = '';
  try {
    p = new URL(target).pathname;
  } catch {
    p = target;
  }
  if (p.startsWith('/post/')) return 'related_post';
  const a = anchor.toLowerCase();
  const editorialMarkers = /\b(découvrez|consultez|contactez|notre cabinet|nos services|cabinet plouton|en savoir plus|voir nos|cliquez ici|notre équipe)\b/;
  if (a.length > 25 || editorialMarkers.test(a)) return 'editorial';
  return 'nav';
}
async function legacyExtract(pageUrl: string): Promise<LegacyLink[]> {
  const res = await fetch(pageUrl, { headers: { 'User-Agent': 'plouton-seo-audit/0.0.1' } });
  if (!res.ok) return [];
  const html = await res.text();
  const sameSite = new URL(pageUrl).host;
  const matches = Array.from(
    html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  );
  const seen = new Set<string>();
  const out: LegacyLink[] = [];
  for (const m of matches) {
    const href = m[1]!;
    const anchor = stripTagsLegacy(m[2]!);
    if (!anchor) continue;
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    try {
      if (new URL(absolute).host !== sameSite) continue;
    } catch {
      continue;
    }
    if (absolute === pageUrl || absolute.split('#')[0] === pageUrl) continue;
    const path = (() => {
      try { return new URL(absolute).pathname; } catch { return absolute; }
    })();
    if (path.includes('/categories/')) continue;
    if (path === '/blog' || path === '/blog/') continue;
    if (path === '/mentions-legales') continue;
    if (path === '/comprendre-le-droit') continue;
    const key = absolute + '|' + anchor.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anchor: anchor.slice(0, 120),
      target: absolute,
      placement: classifyAnchorHeuristic(anchor, absolute),
    });
    if (out.length >= 60) break;
  }
  return out;
}

// --- Comparison ---

type DiffRow = {
  status: 'match' | 'diff' | 'lost' | 'gained';
  target: string;
  anchor: string;
  legacy_placement?: string;
  new_placement?: string;
};

function diff(legacy: LegacyLink[], next: ReturnType<typeof classifyLinks>): DiffRow[] {
  const key = (target: string, anchor: string): string => `${target}|${anchor.toLowerCase().slice(0, 80)}`;
  const legacyMap = new Map<string, LegacyLink>();
  for (const l of legacy) legacyMap.set(key(pathOf(l.target), l.anchor), l);
  const nextMap = new Map<string, typeof next[number]>();
  for (const n of next) nextMap.set(key(n.target_path, n.anchor_text), n);

  const allKeys = new Set([...legacyMap.keys(), ...nextMap.keys()]);
  const rows: DiffRow[] = [];
  for (const k of allKeys) {
    const l = legacyMap.get(k);
    const n = nextMap.get(k);
    if (l && !n) {
      rows.push({ status: 'lost', target: pathOf(l.target), anchor: l.anchor, legacy_placement: l.placement });
    } else if (!l && n) {
      rows.push({ status: 'gained', target: n.target_path, anchor: n.anchor_text, new_placement: n.placement });
    } else if (l && n) {
      const lp = l.placement === 'related_post' ? 'related' : l.placement;
      if (lp === n.placement) {
        rows.push({ status: 'match', target: pathOf(l.target), anchor: l.anchor, legacy_placement: l.placement, new_placement: n.placement });
      } else {
        rows.push({ status: 'diff', target: pathOf(l.target), anchor: l.anchor, legacy_placement: l.placement, new_placement: n.placement });
      }
    }
  }
  return rows;
}

function summarize(rows: DiffRow[]): { match: number; diff: number; lost: number; gained: number } {
  return rows.reduce(
    (acc, r) => {
      acc[r.status]++;
      return acc;
    },
    { match: 0, diff: 0, lost: 0, gained: 0 },
  );
}

async function main(): Promise<void> {
  // Pull URLs of currently-active findings (priority signal — these are the
  // pages where the prompt v4 will run next, so a regression here matters).
  const sb = supabase();
  const { data: findings } = await sb
    .from('audit_findings')
    .select('page')
    .in('status', ['pending', 'diagnosed', 'proposed', 'reviewed'])
    .order('priority_score', { ascending: false })
    .limit(5);
  const findingUrls = (findings ?? []).map((r) => r.page as string);
  // Round out with a few static pages of varied shape for breadth.
  const fixtureUrls = [
    'https://www.jplouton-avocat.fr',
    'https://www.jplouton-avocat.fr/notre-cabinet',
    'https://www.jplouton-avocat.fr/honoraires-rendez-vous',
    'https://www.jplouton-avocat.fr/defense-penale/violences-conjugales-et-feminicides',
  ];
  const urls = Array.from(new Set([...findingUrls, ...fixtureUrls]));

  const fixturesDir = resolve(process.cwd(), 'tests/fixtures/scraper-diff');
  mkdirSync(fixturesDir, { recursive: true });

  process.stdout.write(`Comparing legacy vs Sprint-9 DOM scraper on ${urls.length} URLs…\n\n`);

  for (const url of urls) {
    const res = await fetch(url, { headers: { 'User-Agent': 'plouton-seo-audit/0.0.1' } });
    if (!res.ok) {
      process.stdout.write(`  ${url} → fetch ${res.status}, skip\n`);
      continue;
    }
    const html = await res.text();
    const legacy = await legacyExtract(url);
    const next = classifyLinks({ pageUrl: url, html });

    const rows = diff(legacy, next);
    const sum = summarize(rows);

    process.stdout.write(`▶ ${url}\n`);
    process.stdout.write(`  legacy: editorial=${legacy.filter((l) => l.placement === 'editorial').length} nav=${legacy.filter((l) => l.placement === 'nav').length} related=${legacy.filter((l) => l.placement === 'related_post').length} (total ${legacy.length})\n`);
    const nb = (k: string): number => next.filter((n) => n.placement === k).length;
    process.stdout.write(`  new   : editorial=${nb('editorial')} nav=${nb('nav')} footer=${nb('footer')} related=${nb('related')} cta=${nb('cta')} image=${nb('image')} (total ${next.length})\n`);
    process.stdout.write(`  diff  : match=${sum.match}  diff=${sum.diff}  lost=${sum.lost}  gained=${sum.gained}\n`);
    if (sum.diff > 0) {
      process.stdout.write(`  classification flips:\n`);
      for (const r of rows.filter((r) => r.status === 'diff').slice(0, 6)) {
        process.stdout.write(`    "${r.anchor.slice(0, 50)}" → ${r.target}  [${r.legacy_placement} → ${r.new_placement}]\n`);
      }
    }
    if (sum.lost > 0) {
      process.stdout.write(`  lost (legacy had, new dropped):\n`);
      for (const r of rows.filter((r) => r.status === 'lost').slice(0, 4)) {
        process.stdout.write(`    "${r.anchor.slice(0, 50)}" → ${r.target}  [${r.legacy_placement}]\n`);
      }
    }
    if (sum.gained > 0) {
      process.stdout.write(`  gained (new captured, legacy missed):\n`);
      for (const r of rows.filter((r) => r.status === 'gained').slice(0, 4)) {
        process.stdout.write(`    "${r.anchor.slice(0, 50)}" → ${r.target}  [${r.new_placement}]\n`);
      }
    }
    process.stdout.write('\n');

    // Persist fixture
    const safeName = pathOf(url).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
    const fixturePath = resolve(fixturesDir, `${safeName}.json`);
    writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          url,
          generated_at: new Date().toISOString(),
          legacy,
          next,
          summary: sum,
          rows,
        },
        null,
        2,
      ),
    );
  }

  process.stdout.write(`Fixtures written to ${fixturesDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`compare-scrapers failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
