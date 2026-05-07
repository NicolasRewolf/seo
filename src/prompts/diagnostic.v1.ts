/**
 * Diagnostic prompt v6 — ROADMAP §8 + Sprint-7/8/9 + Sprint-11 + Sprint-12 Cooked full-menu.
 *
 * Iteration history:
 *   v1 — original §8 template with engagement (GA4) section.
 *   v2 — Sprint 8: replaced GA4 engagement with Cooked first-party behavior,
 *        added Core Web Vitals section + `performance_diagnosis` JSON field.
 *   v3 — Sprint 7 ported on top of v2: article identity (Wix category +
 *        funnel role), Wix Blog views, DataForSEO volume + share-of-voice
 *        per query, real internal-pages catalog (kills URL hallucinations),
 *        categorized maillage (editorial vs nav vs related-post),
 *        + `funnel_assessment` JSON field.
 *   v4 — Sprint 9: replaced anchor-heuristic categorization with DOM-classified
 *        placements (editorial/nav/footer/related/cta/image), added inbound
 *        graph block + `internal_authority_assessment` JSON field.
 *   v5 — Sprint 11 prompt-redesign: (1) wrapped outbound/inbound blocks in
 *        explicit <outbound_links_from_this_page> / <inbound_links_to_this_page>
 *        XML tags to stop the LLM from conflating the two graphs (root cause
 *        of finding #26 hallucination — it reported "0 outbound editorial"
 *        which was the EDITORIAL count, while the unclassified-79 bucket was
 *        the actual outbound truth). (2) Suppressed the misleading "cul-de-sac
 *        funnel" warning when the snapshot is pre-Sprint-9 (all links in
 *        `unclassified` bucket — placement is genuinely unknown, not zero).
 *        (3) Added `tldr` (max 280 chars) as the FIRST JSON field to force
 *        synthesis upfront before the long-form fields.
 *   v6 — Sprint 12 Cooked full-menu integration. Adds 8 new XML blocks fed
 *        by 4 RPCs published Cooked-side (snapshot_pages_export, site_context_export,
 *        outbound_destinations_for_path, cta_breakdown_for_path):
 *        - <data_quality_check>: GSC clicks ÷ Cooked sessions = capture rate.
 *          Tells the LLM whether to read Cooked metrics as ground truth or
 *          lower bound. Listed FIRST in the prompt body — pondère tout.
 *        - <conversion_signals>: phone/email/booking_cta clicks per window.
 *        - <cta_breakdown_by_placement>: footer-vs-body split — distinguishes
 *          intent-qualified body clicks from ambient header/footer clicks.
 *          (Cooked agent flagged this as central, not optional.)
 *        - <traffic_provenance>: top_source/medium/referrer 28d → calibrates
 *          which channel the page should optimize for.
 *        - <device_split>: mobile/desktop/tablet % → mobile-first calibration.
 *        - <multi_window_trend>: 7d/28d/90d/365d comparison → trending vs fading.
 *        - <top_outbound_destinations>: where users go after this page →
 *          detects topical leaks (legifrance/service-public on legal pages).
 *        - <site_context>: global mix + median sessions/day → relative reads.
 *        New JSON output fields: conversion_assessment, traffic_strategy_note,
 *        device_optimization_note, outbound_leak_note.
 *
 * Older diagnostics persisted under v1-v5 schemas remain readable: every
 * new JSON field is `.optional().default('')` in the Zod validator
 * (cf. src/pipeline/diagnose.ts).
 *
 * Renders the prompt with simple `{{var}}` substitution. Top-level export is
 * a function rather than a string so future versions can plug in with the
 * same signature.
 */
import type {
  EnrichedTopQuery,
  EnrichedContext,
} from '../pipeline/context-enrichment.js';
import type { CatalogEntry } from '../lib/site-catalog.js';
import type {
  PageSnapshotExtras,
  SiteContext,
  OutboundDestination,
  CtaBreakdownRow,
} from '../lib/cooked.js';

export const DIAGNOSTIC_PROMPT_NAME = 'diagnostic' as const;
export const DIAGNOSTIC_PROMPT_VERSION = 6 as const;

/**
 * Sprint-9: live snapshot of how the rest of the site links to this page.
 * Comes from `internal_link_graph` (queried fresh each diagnose run, NOT
 * snapshotted in current_state — inbound is an emergent property of the
 * whole site that should reflect the latest crawl, even when the finding
 * was opened weeks ago).
 */
export type InboundSummary = {
  outbound_total: number;
  inbound_total: number;
  inbound_distinct_sources: number;
  /** Inbound from inside <article>/<main> body — the meaningful editorial links. */
  inbound_editorial: number;
  /** Inbound from header/nav/footer — present-on-every-page boilerplate. */
  inbound_nav_footer: number;
  /** Up to 15 source pages with editorial inbound links (anchor text included). */
  top_editorial_sources: Array<{ source_path: string; anchor_text: string }>;
};

export type DiagnosticPromptInputs = {
  url: string;
  // GSC
  avg_position: number;
  position_drift: number | null;
  impressions_monthly: number;
  ctr_actual: number;
  ctr_expected: number;
  ctr_gap_pct: number;
  // Cooked behavior (Sprint 8)
  pages_per_session: number | null;
  avg_duration_seconds: number | null;
  scroll_depth: number | null;
  scroll_complete_pct: number | null;
  outbound_clicks: number | null;
  // Cooked Core Web Vitals (Sprint 8)
  lcp_p75_ms: number | null;
  inp_p75_ms: number | null;
  cls_p75: number | null;
  ttfb_p75_ms: number | null;
  // Current SEO state
  current_title: string;
  current_meta: string;
  current_h1: string;
  current_intro: string;
  current_schema_jsonld: unknown[] | null;
  current_internal_links: Array<{
    anchor: string;
    target: string;
    placement?: 'editorial' | 'related' | 'nav' | 'footer' | 'cta' | 'image';
  }>;
  // Top queries (raw — enriched if context-enrichment ran)
  top_queries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
  /** Sprint-7 enrichment (optional during transition / when API is unavailable). */
  enrichment?: EnrichedContext;
  /** Sprint-9 inbound graph signal. Null if the link graph hasn't been crawled yet. */
  inbound_summary?: InboundSummary | null;
  // ---------- Sprint-12 (v6) — Cooked full-menu integration ----------
  /** Multi-window snapshot from cooked.snapshot_pages_export. Null when
   *  Cooked is freshly seeded and the page has no row yet. */
  cooked_extras?: PageSnapshotExtras | null;
  /** Site-wide Cooked context — global mix and trend. Null if RPC failed. */
  cooked_site_context?: SiteContext | null;
  /** Top hostnames users navigate to AFTER this page. Empty if no clicks. */
  outbound_destinations?: OutboundDestination[];
  /** CTA clicks broken down by placement (footer/header/body) per cta_type.
   *  THE signal that distinguishes intent-qualified body clicks from
   *  ambient footer clicks (Cooked-side gate). */
  cta_breakdown?: CtaBreakdownRow[];
  /** GSC clicks over the same window as cooked_extras.windows['28d'] —
   *  used to compute the data quality / capture rate sanity check. */
  gsc_clicks_28d?: number | null;
};

// ---------- formatting helpers ---------------------------------------------

function fmtPct(n: number): string {
  return (n * 100).toFixed(2);
}

function fmtNumOrNA(n: number | null | undefined, suffix = ''): string {
  return n == null ? 'n/a' : `${n}${suffix}`;
}

function fmtSchemaSummary(blocks: unknown[] | null): string {
  if (!blocks || blocks.length === 0) return '_(aucun schema JSON-LD détecté sur la page)_';
  const types = blocks.map((b) => {
    if (!b || typeof b !== 'object') return '<malformed>';
    const t = (b as Record<string, unknown>)['@type'];
    if (Array.isArray(t)) return t.join(', ');
    if (typeof t === 'string') return t;
    return '<no @type>';
  });
  return types.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

/** Classify a Core Web Vital value against Google's tri-tier thresholds. */
function classifyCwv(metric: 'LCP' | 'INP' | 'CLS' | 'TTFB', v: number): string {
  switch (metric) {
    case 'LCP':
      return v <= 2500 ? 'Good' : v <= 4000 ? 'Needs Improvement' : 'Poor';
    case 'INP':
      return v <= 200 ? 'Good' : v <= 500 ? 'Needs Improvement' : 'Poor';
    case 'CLS':
      return v <= 0.1 ? 'Good' : v <= 0.25 ? 'Needs Improvement' : 'Poor';
    case 'TTFB':
      return v <= 800 ? 'Good' : v <= 1800 ? 'Needs Improvement' : 'Poor';
  }
}

function fmtCwvLine(metric: 'LCP' | 'INP' | 'CLS' | 'TTFB', v: number | null, unit: string): string {
  if (v == null) return `- ${metric} : n/a`;
  const display = unit === 'ms' ? `${Math.round(v)}${unit}` : v.toFixed(3);
  return `- ${metric} (p75) : ${display} → **${classifyCwv(metric, v)}**`;
}

function fmtEnrichedQueriesTable(rows: EnrichedTopQuery[]): string {
  if (rows.length === 0) return '_(no query data available)_';
  const lines = [
    '| query | imp/3mo | ctr | pos | volume FR/mois | share of voice |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const ctr = (r.ctr * 100).toFixed(2) + '%';
    const vol = r.monthly_volume_fr != null ? r.monthly_volume_fr.toLocaleString('fr-FR') : '_n/a_';
    const sov = r.share_of_voice_pct != null ? `${r.share_of_voice_pct}%` : '_n/a_';
    lines.push(
      `| ${r.query} | ${r.impressions} | ${ctr} | ${r.position.toFixed(1)} | ${vol} | ${sov} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Sprint-9: classification is now done structurally by the DOM classifier
 * (lib/dom-link-classifier.ts) at scrape time — placement is a property
 * of each row, not derived from anchor text. This function just groups
 * the rows by their stored placement. Links missing `placement` (legacy
 * findings persisted before Sprint 9) fall back to the "unclassified"
 * bucket so they're still visible to the LLM.
 */
function fmtCategorizedLinks(rows: DiagnosticPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '_(aucun lien interne sortant détecté)_';

  const buckets: Record<string, typeof rows> = {
    editorial: [], related: [], cta: [], nav: [], footer: [], image: [], unclassified: [],
  };
  for (const l of rows) {
    const k = l.placement ?? 'unclassified';
    (buckets[k] ?? buckets.unclassified)!.push(l);
  }

  const fmtRow = (l: typeof rows[number]): string =>
    `- "${l.anchor.slice(0, 100) || '(no text)'}" → ${l.target}`;

  // ---- SNAPSHOT-AGE GUARD (Sprint-11) ------------------------------------
  // If every classified bucket is empty AND we have unclassified rows, the
  // snapshot was taken before Sprint 9 and placement is genuinely UNKNOWN.
  // Suppress the editorial-zero "cul-de-sac" warning — printing it would lie
  // to the LLM, which then reports a structural gap that doesn't exist
  // (the real bug behind finding #26 v4 diagnosis).
  const totalClassified =
    buckets.editorial!.length +
    buckets.related!.length +
    buckets.cta!.length +
    buckets.nav!.length +
    buckets.footer!.length +
    buckets.image!.length;
  const isLegacySnapshot = totalClassified === 0 && buckets.unclassified!.length > 0;

  if (isLegacySnapshot) {
    return (
      `⚠️ **Snapshot pré-Sprint-9** : ${buckets.unclassified!.length} liens sortants ` +
      `dont le placement DOM n'a PAS été capturé (finding antérieure au crawler ` +
      `structurel).\n\n` +
      `**Conséquence pour ton diagnostic** : tu ne peux PAS conclure à un manque ` +
      `de maillage éditorial sur cette page — la donnée est inconnue, pas zéro. ` +
      `Le prochain crawl reclassifiera ces liens. Skip toute mention de ` +
      `"cul-de-sac funnel" / "0 lien éditorial" dans \`structural_gaps\` et ` +
      `\`funnel_assessment\`.`
    );
  }

  const sections: string[] = [];
  sections.push(
    `**Liens éditoriaux in-body** (${buckets.editorial!.length}) — vrais signaux de funnel choisis par l'auteur :\n` +
      (buckets.editorial!.length === 0
        ? '_(aucun lien éditorial détecté dans le corps de l\'article — fort signal de cul-de-sac funnel)_'
        : buckets.editorial!.map(fmtRow).join('\n')),
  );
  if (buckets.cta!.length > 0) {
    sections.push(`**CTA buttons** (${buckets.cta!.length}) :\n${buckets.cta!.map(fmtRow).join('\n')}`);
  }
  sections.push(
    `**Liens "posts similaires"** auto-générés par Wix (${buckets.related!.length}) — pas de signal éditorial actionnable.` +
      (buckets.related!.length > 0
        ? `\n${buckets.related!.slice(0, 5).map(fmtRow).join('\n')}${buckets.related!.length > 5 ? `\n_(+ ${buckets.related!.length - 5} autres)_` : ''}`
        : ''),
  );
  sections.push(
    `**Liens header/nav** (${buckets.nav!.length}) + **footer** (${buckets.footer!.length}) — présents sur toutes les pages, pas un signal propre à cette page.`,
  );
  if (buckets.image!.length > 0) {
    sections.push(`**Liens images** (${buckets.image!.length}, sans texte d'ancrage)`);
  }
  if (buckets.unclassified!.length > 0) {
    sections.push(
      `**Non classés** (${buckets.unclassified!.length}) — placement DOM non disponible (mix legacy + nouveaux liens).`,
    );
  }
  return sections.join('\n\n');
}

function fmtInboundBlock(s: InboundSummary | null | undefined): string {
  if (!s) {
    return '_(graph de liens internes pas encore crawlé — le signal inbound apparaîtra au prochain audit)_';
  }
  // Sprint-11: dropped the `Outbound total` line that previously appeared
  // here. It was bleeding the outbound signal into the inbound-only section
  // and confusing the LLM (finding #26 v4 conflated the two). Outbound is
  // covered exclusively in the <outbound_links_from_this_page> block above.
  const lines: string[] = [
    `- **Inbound total** : ${s.inbound_total} liens depuis ${s.inbound_distinct_sources} pages distinctes`,
    `- **Inbound éditorial** (in-body, vrais signaux d'autorité interne) : **${s.inbound_editorial}**`,
    `- **Inbound nav/footer** (boilerplate présent sur toutes les pages) : ${s.inbound_nav_footer}`,
  ];
  if (s.top_editorial_sources.length > 0) {
    lines.push(`\n**Top sources éditoriales linkant cette page** :`);
    for (const src of s.top_editorial_sources.slice(0, 10)) {
      lines.push(`  - ${src.source_path}${src.anchor_text ? ` ("${src.anchor_text.slice(0, 80)}")` : ''}`);
    }
  } else if (s.inbound_editorial === 0 && s.inbound_total > 0) {
    lines.push(
      `\n> ⚠️ **Aucun lien éditorial entrant** — la page est exclusivement linkée depuis nav/footer (présence sur toutes les pages mais aucun rédacteur n'a choisi de la pointer dans un article). Page **orpheline éditorialement**.`,
    );
  }
  return lines.join('\n');
}

// ============================================================================
// Sprint 12 (v6) — Cooked full-menu rendering helpers.
// All emit blocks safe to drop into the prompt body. Each gracefully handles
// null / missing inputs so a freshly-seeded Cooked DB doesn't crash the run.
// ============================================================================

function fmtConversionSignals(
  ex: PageSnapshotExtras | null | undefined,
): string {
  if (!ex) return '_(Cooked snapshot indisponible — capture en cours)_';
  const sess28 = ex.windows['28d'].sessions;
  const c = ex.conversion;
  const rate = (n: number): string => (sess28 > 0 ? ((n / sess28) * 100).toFixed(2) + '%' : 'n/a');
  return [
    `- phone_clicks_28d: ${c.phone_clicks['28d']} (call_rate = ${rate(c.phone_clicks['28d'])} sur ${sess28} sessions)`,
    `- email_clicks_28d: ${c.email_clicks['28d']} (email_rate = ${rate(c.email_clicks['28d'])})`,
    `- booking_cta_clicks_28d: ${c.booking_cta_clicks['28d']} (booking_rate = ${rate(c.booking_cta_clicks['28d'])})`,
    `- 7d trend: phone=${c.phone_clicks['7d']} email=${c.email_clicks['7d']} booking=${c.booking_cta_clicks['7d']}`,
    `- 90d cumul: phone=${c.phone_clicks['90d']} email=${c.email_clicks['90d']} booking=${c.booking_cta_clicks['90d']}`,
  ].join('\n');
}

/**
 * THE breakdown that distinguishes intent-qualified body clicks from
 * ambient footer clicks. Cooked agent flagged this as central, not optional.
 */
function fmtCtaBreakdown(rows: CtaBreakdownRow[] | undefined): string {
  if (!rows || rows.length === 0) {
    return '_(aucun CTA click capturé sur cette page sur 28 jours — soit vraiment 0 conversion, soit Cooked vient de démarrer)_';
  }
  const lines = ['cta_type | placement | clicks | anchor_sample'];
  lines.push('---|---|---|---');
  for (const r of rows) {
    lines.push(`${r.cta_type} | ${r.placement} | ${r.clicks} | "${r.anchor_sample.slice(0, 40)}"`);
  }
  // Compute body-vs-ambient split for the most common cta_type to surface the qualitative read
  const byPlacement: Record<string, number> = { header: 0, footer: 0, body: 0 };
  for (const r of rows) byPlacement[r.placement] = (byPlacement[r.placement] ?? 0) + r.clicks;
  const total = byPlacement.header! + byPlacement.footer! + byPlacement.body!;
  if (total > 0) {
    const bodyPct = ((byPlacement.body! / total) * 100).toFixed(0);
    lines.push('');
    lines.push(
      `**Lecture** : ${byPlacement.body} clicks body / ${total} total = **${bodyPct}% intent qualifié** (le reste = clicks ambiants header/footer présents sur toutes les pages).`,
    );
  }
  return lines.join('\n');
}

function fmtTrafficProvenance(ex: PageSnapshotExtras | null | undefined): string {
  if (!ex) return '_(Cooked snapshot indisponible)_';
  const p = ex.provenance_28d;
  const lines: string[] = [];
  if (p.top_source) lines.push(`- top_source: ${p.top_source}`);
  if (p.top_medium) lines.push(`- top_medium: ${p.top_medium}`);
  if (p.top_referrer) lines.push(`- top_referrer: ${p.top_referrer}`);
  if (lines.length === 0) lines.push('_(pas de données de provenance sur 28d)_');
  return lines.join('\n');
}

function fmtDeviceSplit(ex: PageSnapshotExtras | null | undefined): string {
  if (!ex || !ex.device_split_28d) return '_(pas de breakdown device sur 28d)_';
  const d = ex.device_split_28d;
  return `- mobile: ${d.mobile.toFixed(0)}%  |  desktop: ${d.desktop.toFixed(0)}%  |  tablet: ${d.tablet.toFixed(0)}%`;
}

function fmtMultiWindowTrend(ex: PageSnapshotExtras | null | undefined): string {
  if (!ex) return '_(Cooked snapshot indisponible)_';
  const w = ex.windows;
  const ratePerDay = (n: number, days: number): string => (days > 0 ? (n / days).toFixed(2) : '0');
  return [
    `- sessions: 7d=${w['7d'].sessions} (${ratePerDay(w['7d'].sessions, 7)}/jour) | 28d=${w['28d'].sessions} (${ratePerDay(w['28d'].sessions, 28)}/jour) | 90d=${w['90d'].sessions} | 365d=${w['365d'].sessions}`,
    `- bounce_rate: 7d=${(w['7d'].bounce_rate * 100).toFixed(1)}% | 28d=${(w['28d'].bounce_rate * 100).toFixed(1)}% | 90d=${(w['90d'].bounce_rate * 100).toFixed(1)}%`,
    `- scroll_avg: 7d=${w['7d'].scroll_avg.toFixed(1)}% | 28d=${w['28d'].scroll_avg.toFixed(1)}% | 90d=${w['90d'].scroll_avg.toFixed(1)}%`,
    `- avg_dwell: 7d=${w['7d'].avg_dwell_seconds.toFixed(0)}s | 28d=${w['28d'].avg_dwell_seconds.toFixed(0)}s`,
    `- outbound_clicks: 7d=${w['7d'].outbound_clicks} | 28d=${w['28d'].outbound_clicks} | 90d=${w['90d'].outbound_clicks}`,
  ].join('\n');
}

function fmtOutboundDestinations(rows: OutboundDestination[] | undefined): string {
  if (!rows || rows.length === 0) return '_(aucun click sortant capturé sur 28d)_';
  return rows.slice(0, 10).map((r) => `- ${r.hostname}: ${r.clicks} clicks`).join('\n');
}

/**
 * Sprint-12 hotfix: Cooked-tracker deploy date for jplouton-avocat.fr.
 * Used to pro-rate the capture rate during the bootstrap window. Before this
 * fix, the helper compared 28d-window-of-Cooked-data (which actually held
 * <2 days of collection) against 28d-window-of-GSC-data, producing artificial
 * "5% — tracker quasi-cassé" verdicts during the first 28 days post-deploy.
 *
 * TODO: replace with a Cooked RPC `tracker_first_seen_global()` once published
 * — Cooked agent offered this; the hardcode unblocks today.
 */
export const COOKED_TRACKER_DEPLOY_DATE = new Date('2026-05-06T17:00:00Z');

function daysCookedHasCollected(now: Date): number {
  const ms = now.getTime() - COOKED_TRACKER_DEPLOY_DATE.getTime();
  const days = ms / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.min(28, days));
}

/**
 * GSC clicks ÷ Cooked sessions = tracker capture rate. Cooked agent insisted
 * this lands DÈS Phase C, not Sprint+1, because the LLM must know whether to
 * read Cooked metrics as ground truth or as a lower bound.
 *
 * Sprint-12 Cooked-agent feedback integrated:
 *   - rate > 100% is normal (page has non-Google traffic — direct, social,
 *     other referrers). At rate > 150%, surface explicitly that Cooked is
 *     ground truth on the FULL volume (not just the GSC slice).
 *   - 4-tier verdicts enriched with empirical Cooked-side explanations
 *     (SSR vs JS-rendered, ad-blockers, tracker load timing).
 *
 * Sprint-12 hotfix:
 *   - Pro-rate by `daysCookedHasCollected()` to kill the bootstrap artefact
 *     where a freshly-deployed Cooked install gave artificial "🚫 tracker
 *     cassé" verdicts on every page during the first 28 days.
 */
// Exported so the unit tests can validate the verdict strings without
// having to render the full prompt body. Not part of the public API —
// callers should not rely on the exact wording.
export function fmtDataQualityCheck(
  gscClicks28d: number | null | undefined,
  cookedSessions28d: number | null | undefined,
  /** Sprint-12 hotfix: optional override for tests (default = real time). */
  now: Date = new Date(),
): string {
  if (gscClicks28d == null || cookedSessions28d == null) {
    return '_(données insuffisantes pour calculer le capture rate — Cooked en cours d\'absorption)_';
  }
  if (gscClicks28d === 0) {
    return '- GSC clicks 28d: 0 (pas d\'audience organique sur cette fenêtre — capture rate non significatif)';
  }
  // Sprint-12 hotfix: pro-rate by the actual days Cooked has been collecting.
  // sessions / days_collected = real per-day Cooked rate. Compare to GSC's
  // per-day rate over its full 28d window. This eliminates the bootstrap
  // artefact that made every FR page look like "🚫 tracker cassé" during the
  // first 28 days post-deploy.
  const daysCooked = daysCookedHasCollected(now);
  if (daysCooked < 1) {
    return [
      `- GSC clicks 28d: ${gscClicks28d}`,
      `- Cooked sessions (so far): ${cookedSessions28d}`,
      `- ⏳ Cooked en phase d'amorçage (< 1 jour de collection effective) — capture rate non-évaluable. Le tracker vient juste d'être déployé. Réévaluer après J+7.`,
    ].join('\n');
  }
  const cookedPerDay = cookedSessions28d / daysCooked;
  const gscPerDay = gscClicks28d / 28;
  const rate = gscPerDay > 0 ? (cookedPerDay / gscPerDay) * 100 : 0;
  let verdict: string;
  // Empirical thresholds calibrated for Wix Studio (Cooked agent feedback).
  if (rate > 150) {
    verdict =
      '✅✅ ground truth FULL VOLUME — cette page a du trafic significatif HORS Google (direct, social, referrers). Cooked voit l\'ensemble, GSC ne voit que la slice "Google search". Lis tous les chiffres Cooked comme absolus, et n\'utilise PAS les GSC impressions comme dénominateur de conversion (utilise Cooked sessions à la place).';
  } else if (rate >= 80) {
    verdict =
      '✅ ground truth — la page est SSR-bien, le tracker se charge tôt, peu d\'ad-blockers actifs. Chiffres Cooked = absolus.';
  } else if (rate >= 50) {
    verdict =
      '⚠️ lower bound acceptable — quelques % d\'ad-blockers + des hits où le tracker n\'a pas eu le temps de charger avant que l\'user reparte. Toujours actionable, lire les conversion rates comme un plancher (ils sont en réalité ≥ ce que tu vois).';
  } else if (rate >= 20) {
    verdict =
      '⚠️⚠️ sous-capture forte — investigation requise côté tracker. Causes probables : (a) page partiellement JS-rendered (le widget Wix qui contient le contenu charge en client-side après le render initial), (b) ad-blocker pattern spécifique sur cette URL. Lecture RELATIVE seulement — ne JAMAIS comparer en absolu à d\'autres pages, ni convertir en taux de conversion %.';
  } else {
    verdict =
      '🚫 tracker quasi-cassé sur cette URL. Soit on fix le tracker (ajout d\'un retry sur load), soit on désactive cette page de l\'audit comportemental jusqu\'à fix. NE PAS conclure à l\'absence de conversion sur ces chiffres — c\'est probablement un problème de capture, pas un problème de page.';
  }
  // Surface the pro-rating math when Cooked is still in its first 28d so
  // the LLM and the human can see we're not comparing apples to oranges.
  const isBootstrap = daysCooked < 28;
  const lines: string[] = [
    `- GSC clicks 28d: ${gscClicks28d} (= ${gscPerDay.toFixed(1)}/jour)`,
    `- Cooked sessions: ${cookedSessions28d} sur ${daysCooked.toFixed(1)} jours de collection (= ${cookedPerDay.toFixed(1)}/jour)`,
    `- Capture rate (rate/jour normalisé): ${rate.toFixed(0)}%`,
  ];
  if (isBootstrap) {
    lines.push(`- ⓘ Cooked en phase d'amorçage (déployé il y a ${daysCooked.toFixed(1)} jours), pro-rated pour comparer apples-to-apples avec GSC.`);
  }
  lines.push(`- Verdict: ${verdict}`);
  return lines.join('\n');
}

function fmtSiteContext(ctx: SiteContext | null | undefined): string {
  if (!ctx) return '_(contexte site indisponible)_';
  const trend = ctx.sessions_trend_pct_7d_vs_28d;
  const trendStr = trend > 0 ? `+${trend.toFixed(1)}%` : `${trend.toFixed(1)}%`;
  const lines: string[] = [
    `- global sessions 28d: ${ctx.global_sessions_28d.toLocaleString('fr-FR')}`,
    `- median sessions/day 28d: ${ctx.sessions_per_day_median_28d.toFixed(0)}`,
    `- global bounce rate 28d: ${(ctx.global_bounce_rate_28d * 100).toFixed(1)}%`,
    `- trend 7d vs 28d (rate/jour): ${trendStr}`,
  ];
  if (ctx.top_sources_28d.length > 0) {
    lines.push(`- top sources: ${ctx.top_sources_28d.map((s) => `${s.source}/${s.medium} (${s.sessions})`).join(', ')}`);
  }
  return lines.join('\n');
}

function fmtCatalog(catalog: EnrichedContext['internal_pages_catalog']): string {
  const sections: string[] = [];
  const fmtList = (entries: CatalogEntry[]): string =>
    entries.map((e) => `- ${e.url}${e.topic ? ` — _${e.topic}_` : ''}`).join('\n');

  if (catalog.expertise.length > 0) {
    sections.push(`### Pages expertise (cible naturelle de funnel)\n${fmtList(catalog.expertise)}`);
  }
  if (catalog.cta.length > 0) {
    sections.push(`### Pages CTA (conversion / RDV / contact)\n${fmtList(catalog.cta)}`);
  }
  if (catalog.trust.length > 0) {
    sections.push(`### Pages trust (cabinet / affaires)\n${fmtList(catalog.trust)}`);
  }
  return sections.join('\n\n');
}

function fmtIdentityBlock(url: string, enrichment: EnrichedContext | undefined): string {
  const lines: string[] = [`- URL : ${url}`];
  if (!enrichment) return lines.join('\n');

  const cat = enrichment.category;
  if (cat) {
    const roleLabel: Record<typeof cat.role, string> = {
      knowledge_brick:
        'article de RESSOURCES (apport de savoir) — sa fonction est de capter une intention informationnelle large puis de FUNNEL le lecteur vers une page expertise + un CTA RDV',
      topic_expertise: `article de TOPIC ALIGNÉ avec une expertise (${cat.label}) — doit naturellement linker vers la page expertise correspondante : ${cat.funnelTo ?? '(aucune URL mappée)'}`,
      press:
        'article PRESSE / revue de médias — signal de confiance, pas une page transactionnelle. Intention de recherche faible, à ne pas optimiser comme une page produit.',
      unknown: 'rôle non identifié',
    };
    lines.push(`- **Catégorie Wix** : ${cat.label}`);
    lines.push(`- **Rôle dans le funnel** : ${roleLabel[cat.role]}`);
    if (cat.funnelTo && cat.role === 'topic_expertise') {
      lines.push(`- **Cible funnel directe** : ${cat.funnelTo}`);
    }
  } else {
    lines.push(`- **Catégorie Wix** : (non identifiée — pas de catégorie taggée)`);
  }

  if (enrichment.wix_metrics) {
    const m = enrichment.wix_metrics;
    lines.push(
      `- **Wix Blog views (first-party, cumulés depuis publication)** : ${m.views.toLocaleString('fr-FR')} (likes ${m.likes}, comments ${m.comments})`,
    );
  }
  return lines.join('\n');
}

function fmtDemandBlock(enrichment: EnrichedContext | undefined): string {
  if (!enrichment || !enrichment.total_monthly_demand_fr) return '';
  return `\n_Volume total de demande FR sur les top requêtes (somme DataForSEO) : **${enrichment.total_monthly_demand_fr.toLocaleString('fr-FR')} recherches/mois**. La colonne "share of voice" indique combien de cette demande la page capte déjà via ses impressions GSC._`;
}

// ---------- prompt composition --------------------------------------------

export function renderDiagnosticPrompt(i: DiagnosticPromptInputs): string {
  // Fall back to a degraded (no-volume) version of the queries table when
  // enrichment didn't run (e.g. DataForSEO unavailable) — the LLM still has
  // the GSC numbers, just no SOV signal.
  const enrichedQueries: EnrichedTopQuery[] =
    i.enrichment?.enriched_top_queries ??
    i.top_queries.map((q) => ({
      ...q,
      monthly_volume_fr: null,
      cpc: null,
      share_of_voice_pct: null,
    }));

  return `Tu es un consultant SEO senior expert en NavBoost et signaux de clic Google. Tu connais le funnel de conversion d'un cabinet d'avocats : article-ressource → page expertise métier → prise de RDV. Analyse cette page sous-performante et produis un diagnostic structuré.

# Identité de la page
${fmtIdentityBlock(i.url, i.enrichment)}

# Métriques GSC (3 derniers mois)
- Position moyenne : ${i.avg_position.toFixed(1)}
- Position drift : ${fmtNumOrNA(i.position_drift)}
- Impressions/mois : ${i.impressions_monthly.toLocaleString('fr-FR')}
- CTR actuel : ${fmtPct(i.ctr_actual)}%
- CTR attendu (benchmark site-spécifique pour cette position) : ${fmtPct(i.ctr_expected)}%
- Gap : ${i.ctr_gap_pct.toFixed(1)}% sous benchmark

# Comportement (first-party Cooked, non échantillonné)
- Pages/session : ${fmtNumOrNA(i.pages_per_session)}
- Durée moyenne active : ${fmtNumOrNA(i.avg_duration_seconds, 's')}
- Scroll moyen : ${fmtNumOrNA(i.scroll_depth, '%')}
- Scroll complet (% sessions atteignant 100%) : ${fmtNumOrNA(i.scroll_complete_pct, '%')}
- Clics sortants : ${fmtNumOrNA(i.outbound_clicks)}

# Performance technique (Core Web Vitals — seuils Google)
${fmtCwvLine('LCP', i.lcp_p75_ms, 'ms')}
${fmtCwvLine('INP', i.inp_p75_ms, 'ms')}
${fmtCwvLine('CLS', i.cls_p75, '')}
${fmtCwvLine('TTFB', i.ttfb_p75_ms, 'ms')}

# État SEO actuel de la page
**Title** : ${i.current_title || '(empty)'}
**Meta description** : ${i.current_meta || '(empty)'}
**H1** : ${i.current_h1 || '(empty)'}
**Intro (100 premiers mots)** : ${i.current_intro || '(empty)'}

## Schema.org JSON-LD déjà présent
${fmtSchemaSummary(i.current_schema_jsonld)}

## Maillage interne — DEUX flux distincts à NE PAS confondre

<outbound_links_from_this_page>
Liens que CETTE page émet vers d'autres pages du site (snapshotté à l'audit, catégorisé via DOM Sprint-9). Source de vérité pour évaluer si la page funnel correctement le lecteur.

${fmtCategorizedLinks(i.current_internal_links)}
</outbound_links_from_this_page>

<inbound_links_to_this_page>
Liens que les AUTRES pages du site émettent VERS cette page (graph live, recrawlé à chaque audit). Source de vérité pour évaluer l'autorité interne de la page (orpheline / hub / standard).

${fmtInboundBlock(i.inbound_summary)}
</inbound_links_to_this_page>

# Top requêtes (3 derniers mois) avec volume réel France et share of voice
${fmtEnrichedQueriesTable(enrichedQueries)}
${fmtDemandBlock(i.enrichment)}

# Catalogue d'URLs internes RÉELLES (utilise UNIQUEMENT celles-ci pour tout maillage proposé — toute autre URL est une hallucination)
${i.enrichment ? fmtCatalog(i.enrichment.internal_pages_catalog) : '_(catalog non chargé)_'}

# Cooked full-menu (Sprint 12) — SIGNAUX BEHAVIOR & CONVERSION

⚠️ **Lis le bloc \`<data_quality_check>\` EN PREMIER.** Il te dit si tu peux lire les chiffres Cooked comme ground truth ou comme lower bound. Tous les autres blocs sont à pondérer en conséquence.

<data_quality_check>
${fmtDataQualityCheck(i.gsc_clicks_28d, i.cooked_extras?.windows['28d'].sessions ?? null)}
</data_quality_check>

<conversion_signals>
Aggregated counts. Une page de cabinet d'avocats convertit via phone, email, ou booking_cta — pas via pages/session.

${fmtConversionSignals(i.cooked_extras)}
</conversion_signals>

<cta_breakdown_by_placement>
Le breakdown qui distingue les clicks d'INTENT QUALIFIÉ (body — le user a lu la page, vu le CTA dans le contexte du contenu) des clicks AMBIANTS (header/footer — présents sur toutes les pages, le user en transit clique). Lis-les TRÈS différemment.

${fmtCtaBreakdown(i.cta_breakdown)}
</cta_breakdown_by_placement>

<traffic_provenance>
Détermine où la page se bat. Si trafic 80% Google organic → priorité = CTR snippet. Si 50% Facebook social → priorité = OG tags / preview FB.

${fmtTrafficProvenance(i.cooked_extras)}
</traffic_provenance>

<device_split>
Calibre les recommandations. 70% mobile + scroll court → fix mobile-first. 70% desktop → marges plus larges, intro plus longue OK.

${fmtDeviceSplit(i.cooked_extras)}
</device_split>

<multi_window_trend>
Détecte les pages en pic ou en chute. Compare 7d normalisé vs 28d normalisé.

${fmtMultiWindowTrend(i.cooked_extras)}
</multi_window_trend>

<top_outbound_destinations>
Où vont les users APRÈS cette page. Si top destination = source juridique externe (legifrance.gouv.fr, service-public.fr) sur une page juridique, c'est un signal "ajoute la citation in-page au lieu de laisser fuir".

${fmtOutboundDestinations(i.outbound_destinations)}
</top_outbound_destinations>

<site_context>
Pour calibrer en relatif au site. Si la page a scroll_avg=5% et le médian site est 18%, c'est anormalement bas. Si la médiane site est 6%, c'est dans la norme.

${fmtSiteContext(i.cooked_site_context)}
</site_context>

# Ta mission
Produis un diagnostic JSON strict avec ce schéma. **Le champ \`tldr\` vient en PREMIER et résume tout** — c'est ce que le lecteur humain verra en haut du rapport, donc il doit être autonome (lisible sans lire le reste).

{
  "tldr": "Synthèse exécutive en MAX 280 caractères : (1) cause #1 du sous-CTR en 1 phrase, (2) action #1 prioritaire en 1 phrase. Ton direct, pas de hedging. Exemple : 'Title trop générique sur \"abandon de poste\" (43% SOV gâchée par un CTR 2× sous benchmark). Action : reframer en \"Abandon de poste : 7 risques que les employeurs ignorent\" pour aligner sur l'intent informationnel.'",
  "intent_mismatch": "Décris en 1-3 phrases le mismatch entre l'intention dominante des top requêtes (en t'appuyant sur les volumes réels France) et le cadrage actuel du title/meta/H1. Cite les requêtes concernées avec leurs volumes.",
  "snippet_weakness": "Décris en 1-3 phrases pourquoi le snippet (title + meta) ne convertit pas. Sois précis : trop générique ? Pas de bénéfice chiffré ? Concurrent plus fort dans la SERP ? Si la share of voice est déjà élevée (>50%) le levier est sur le CTR pas sur le ranking.",
  "hypothesis": "Une seule phrase : ton hypothèse principale du sous-CTR.",
  "top_queries_analysis": [
    {
      "query": "string",
      "impressions": number,
      "ctr": number,
      "position": number,
      "intent_match": "yes" | "partial" | "no",
      "note": "courte note tenant compte du volume FR et de la share of voice"
    }
  ],
  "engagement_diagnosis": "Lecture des signaux comportementaux Cooked (first-party, non biaisé). Si pages/session<1.3, scroll<50%, ou peu de clics sortants, explique ce que ça signale (intention déçue, contenu insuffisant, CTA manquante). Sinon: 'engagement satisfaisant'. ⚠️ **Pondère ta lecture par le \`<data_quality_check>\` ci-dessus** — si le capture rate est < 50%, qualifie ton verdict de 'sous-évalué probable'. Note: si Cooked vient juste d'être déployé et que les valeurs sont null, écris 'données comportementales en cours de collecte (n/a au premier audit)'.",
  "performance_diagnosis": "Si LCP > 2500ms, INP > 200ms ou CLS > 0.1 (zones 'Needs Improvement' ou 'Poor' Google), explique l'impact NavBoost direct (Google rétrograde les pages lentes/instables) et donne l'action prioritaire (image trop lourde, JS bloquant, layout shift sur header...). Si toutes les valeurs sont null: 'CWV en cours de collecte (n/a)'. Sinon: 'performance technique satisfaisante'.",
  "conversion_assessment": "1-3 phrases. Lis EN PRIORITÉ le bloc <cta_breakdown_by_placement> (pas <conversion_signals> seul) pour évaluer la qualité réelle des conversions. Distingue body (intent qualifié) vs header/footer (ambiant). Exemple : '5 phone_clicks_28d dont 3 body sur 14 sessions = call_rate qualifié de 21%, page convertit fort, fixes doivent renforcer pas perturber'. Ou inverse : '0 phone/email/booking sur 30 sessions, et l'intent des top queries appelle un RDV → CTA in-body manquant prioritaire'. ⚠️ Si data_quality_check verdict ∈ {low capture, tracker cassé} : préfixe ta lecture par 'sous réserve de capture rate insuffisant' et reste en relatif/qualitatif, jamais en absolu.",
  "traffic_strategy_note": "1 phrase. À partir du <traffic_provenance>: si top_source=google + top_medium=organic ≥ 70% → 'priorité = CTR snippet (la bataille se joue dans la SERP Google)'. Si top_referrer = social/réseau → 'priorité = OG tags + preview sociale'. Si direct ≥ 50% → 'audience qualifiée connaît déjà le cabinet, fix CTA conversion plutôt qu'acquisition'. Si pas assez de data: 'provenance non significative'.",
  "device_optimization_note": "1 phrase. À partir du <device_split>: si mobile ≥ 65% + scroll_avg < 30% → 'fix mobile-first impératif (intro courte, CTA above-the-fold mobile)'. Si desktop ≥ 65% → 'OK pour intro plus dense, marges latérales plus larges'. Si équilibré : 'audience hybride, vérifier que le snippet et l'intro fonctionnent sur les 2 formats'. Si pas de data: 'split device non significatif'.",
  "outbound_leak_note": "1 phrase ou 'pas de leak significatif'. Lis <top_outbound_destinations>: si la top destination est sémantiquement liée à la thématique de la page (ex: legifrance.gouv.fr / service-public.fr sur une page juridique), c'est une fuite réparable → 'ajoute la citation X in-page au lieu de laisser fuir vers source externe Y'. Sinon : 'fuites externes normales (autorités juridiques officielles), pas un signal de fix'.",
  "structural_gaps": "1-3 phrases sur les manques structurels. Tu DOIS prendre en compte : le schema déjà présent (ne pas suggérer ce qui existe), le bloc <outbound_links_from_this_page> ci-dessus (ne pas re-suggérer des liens éditoriaux déjà en place — la nav menu ne compte pas comme maillage éditorial), et le RÔLE FUNNEL de la page. ⚠️ **Si le bloc outbound est marqué 'Snapshot pré-Sprint-9', traite le maillage éditorial sortant comme INCONNU et n'invoque PAS de gap basé sur l'absence de liens.**",
  "funnel_assessment": "1-2 phrases : la page remplit-elle correctement son rôle dans le funnel attendu pour sa catégorie ? Quels sont les 2-3 maillons manquants vers les pages expertise + CTA du catalogue ? Cite les URLs cibles précises depuis le catalogue. Pour un knowledge_brick, exiger au minimum 1 lien expertise + 1 CTA RDV éditorialement intégrés (pas juste dans la nav). ⚠️ **Si le bloc outbound est marqué 'Snapshot pré-Sprint-9', écris : 'maillage éditorial sortant non capturé au snapshot — réévaluer après le prochain crawl' et ne propose PAS de maillons manquants.**",
  "internal_authority_assessment": "1-2 phrases sur la position de cette page dans le graph interne (lis EXCLUSIVEMENT le bloc <inbound_links_to_this_page>, JAMAIS le bloc outbound). Si inbound_editorial>=10 → 'page hub à protéger' (les fixes ne doivent pas casser ce statut). Si inbound_editorial==0 et inbound_total>0 → 'page orpheline éditorialement' : prioriser absolument l'ajout de liens depuis 2-3 pages sources naturelles. Sinon → position standard, pas de levier graph spécifique. Si le graph n'est pas encore crawlé, écris 'graph non disponible (premier crawl en cours)'."
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
