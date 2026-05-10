/**
 * Diagnostic prompt v7 — ROADMAP §8 + Sprint-7/8/9 + Sprint-11 + Sprint-12 Cooked full-menu + Sprint-14 page content.
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
 *   v7 — Sprint 14 page content extraction. Sortie du "100 premiers mots".
 *        Le LLM consomme désormais le full body via 4 nouveaux blocs XML :
 *        - <page_body>: texte propre + word_count (8000 mots max)
 *        - <page_outline>: H2/H3/H4 hiérarchique avec word_offset
 *        - <images>: audit alt-text (in-body, header/footer ignorés)
 *        - <author_eeat>: byline + dates publication/modif (E-E-A-T YMYL)
 *        - <cta_in_body_positions>: position word_offset des CTAs (proxy
 *          du % scroll, caveat explicite)
 *        Drop de l'ancien `intro_first_100_words` du prompt (la donnée
 *        reste en DB pour retro-compat des findings v1-v6 mais n'est
 *        plus réinjectée). Tighten de structural_gaps et funnel_assessment
 *        pour citer les blocs <page_outline> / <page_body> / <cta_positions>.
 *
 * Older diagnostics persisted under v1-v6 schemas remain readable: every
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
  EngagementDensity,
} from '../lib/cooked.js';
import { fetchTrackerFirstSeen } from '../lib/cooked.js';
import type { ContentSnapshot } from '../lib/page-content-extractor.js';
import type { GoogleSearchGuidance } from '../lib/google-search-central.js';

export const DIAGNOSTIC_PROMPT_NAME = 'diagnostic' as const;
export const DIAGNOSTIC_PROMPT_VERSION = 11 as const;

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
  /** Sprint-13bis: when Cooked first saw an event ever. Used to pro-rate
   *  the capture rate during the bootstrap window. The diagnose pipeline
   *  fetches this once via `getCookedFirstSeen()` and passes it down. */
  cooked_first_seen?: Date | null;
  /** Sprint-14: full structured content (body, outline, images, author,
   *  CTA positions). When present, the prompt v7 adds 4 new XML blocks
   *  and the LLM stops being limited to intro_first_100_words. */
  content_snapshot?: ContentSnapshot | null;
  /** Sprint-16: dwell-time distribution (p25/median/p75 + evenness_score).
   *  Cooked publishes this via the `engagement_density_for_path` RPC.
   *  When present, the prompt v9 adds an <engagement_density> block to
   *  give the LLM a read on bimodal vs uniform engagement (a low evenness
   *  signals that the page works for SOME visitors but not all). */
  engagement_density?: EngagementDensity | null;
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
 * Sprint 18 — Competitive SERP landscape per top query.
 *
 * Pour chaque top query, rend le top 10 organique Google FR (rank, domaine,
 * title, snippet truncaté à 100 chars) + les SERP features observées
 * (AI Overview, featured snippet, PAA box, knowledge graph, local pack).
 *
 * Le LLM lit ce bloc EN PRIORITÉ pour analyser :
 *   - snippet_weakness : pourquoi notre snippet ne convertit pas vs concurrents
 *   - intent_mismatch : si la SERP est dominée par Wikipedia/.gouv → intent
 *     informationnel ; si par cabinets d'avocats → intent commercial
 *   - feature gating : si AI Overview présent, le CTR organique est plafonné
 *
 * Truncate snippet à 100 chars : assez pour saisir l'angle, pas assez pour
 * gonfler le prompt (cap ~2500 input tokens pour 5 queries × 10 résultats).
 */
export function fmtSerpCompetitiveLandscape(rows: EnrichedTopQuery[]): string {
  const withSerp = rows.filter((r) => r.serp != null && r.serp.organic.length > 0);
  if (withSerp.length === 0) {
    return '_(SERP indisponible — DataForSEO non configuré ou erreur sur toutes les queries)_';
  }
  const sections: string[] = [];
  for (const r of withSerp) {
    const s = r.serp!;
    const featBadges: string[] = [];
    if (s.features.has_ai_overview) featBadges.push('🤖 AI Overview');
    if (s.features.has_featured_snippet) featBadges.push('📌 Featured Snippet');
    if (s.features.has_people_also_ask) featBadges.push('❓ People Also Ask');
    if (s.features.has_knowledge_graph) featBadges.push('📚 Knowledge Graph');
    if (s.features.has_local_pack) featBadges.push('📍 Local Pack');
    if (s.features.has_video) featBadges.push('🎬 Video');
    const featsLine = featBadges.length > 0 ? featBadges.join(' · ') : '_(aucune SERP feature majeure)_';

    const tableLines = [
      `### "${r.query}"  ·  features : ${featsLine}`,
      ``,
      `| pos | domaine | title | snippet |`,
      `|---|---|---|---|`,
    ];
    for (const item of s.organic.slice(0, 10)) {
      const snippet = (item.description ?? '').replace(/\s+/g, ' ').slice(0, 100);
      const title = (item.title ?? '').replace(/\s+/g, ' ').slice(0, 80);
      const pos = item.rank_group ?? item.rank_absolute ?? '?';
      tableLines.push(`| ${pos} | ${item.domain ?? '?'} | ${title} | ${snippet} |`);
    }
    sections.push(tableLines.join('\n'));
  }
  return sections.join('\n\n');
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

/**
 * Sprint 15 — Pogo-sticking signal (NavBoost negative).
 *
 * A "pogo" = visiteur arrive de Google, vue 1 page, repart en <10s. Le hard
 * pogo ajoute scroll<5% (n'a même pas essayé de lire). C'est le signal
 * NavBoost négatif le plus fort qu'on puisse capter sans accès aux logs
 * Google. Cooked publie les 4 colonnes via snapshot_pages_export() depuis
 * Sprint 15.
 *
 * Reliability caveat : `pogo_rate_pct` calculé sur n<30 sessions Google
 * a une marge de bruit large (CI ~±15-20pp pour n=10). On expose toujours
 * la valeur mais on annote la fiabilité pour que le LLM ne crie pas au
 * loup sur un faible n. Le seuil d'alerte (>20%) côté issue body applique
 * AUSSI un n≥30 — c'est uniquement DANS le prompt qu'on laisse passer le
 * faible n avec caveat (en cas de signal très fort, ex: 50% à n=10).
 */
function fmtPogoSignal(ex: PageSnapshotExtras | null | undefined): string {
  if (!ex) return '_(Cooked snapshot indisponible)_';
  const p = ex.pogo_28d;
  if (p.google_sessions == null || p.google_sessions === 0) {
    return '_(0 session Google captée sur 28d — pas de signal pogo lisible. Soit la page n\'est pas indexée, soit Cooked vient de démarrer le tracking sur ce path)_';
  }
  const lines: string[] = [];
  lines.push(`- google_sessions_28d: ${p.google_sessions}`);
  lines.push(`- pogo_sticks_28d: ${p.pogo_sticks ?? 0} (Google → 1 page → <10s)`);
  lines.push(`- hard_pogo_28d: ${p.hard_pogo ?? 0} (idem + scroll <5%)`);
  if (p.pogo_rate_pct != null) {
    lines.push(`- **pogo_rate_28d: ${p.pogo_rate_pct.toFixed(1)}%**`);
  }
  // Fiabilité statistique
  if (p.google_sessions < 30) {
    lines.push('');
    lines.push(
      `_⚠ Échantillon faible (${p.google_sessions} sessions Google < 30) : le rate a une marge de bruit large (CI ~±15-20pp). N'évoquer le pogo comme verdict que si l'écart à la moyenne site est très net, sinon le mentionner comme "à surveiller"._`,
    );
  } else if (p.pogo_rate_pct != null && p.pogo_rate_pct > 20) {
    lines.push('');
    lines.push(
      `_🚨 **Signal NavBoost négatif fort** (${p.pogo_rate_pct.toFixed(0)}% > 20% sur n=${p.google_sessions}) : Google a probablement déjà commencé à dérouter cette page. Diagnostic en priorité — c'est l'explication la plus probable de tout écart de position négatif._`,
    );
  }
  return lines.join('\n');
}

/**
 * Sprint 16 — CTA rate per device (mobile vs desktop).
 *
 * Cooked publie depuis Sprint 16 :
 *   cta_rate_mobile_28d = (phone + booking) / mobile_sessions * 100
 *   cta_rate_desktop_28d = (phone + booking) / desktop_sessions * 100
 *   mobile_sessions_28d, desktop_sessions_28d (denominateurs)
 *
 * Garde de fiabilité : on n'allume pas de signal "mobile-first urgent"
 * si mobile_sessions < 30 (rate trop bruité). En revanche on expose
 * toujours les valeurs au LLM avec caveat — il peut les mentionner
 * qualitativement sans les transformer en verdict.
 *
 * Heuristique mobile-first : ratio cta_rate_mobile / cta_rate_desktop
 * < 0.25 ET mobile_sessions ≥ 30 ET desktop_rate > 0 → vrai signal
 * d'urgence mobile. Sinon mentionner sans alarme.
 */
function fmtCtaPerDevice(ex: PageSnapshotExtras | null | undefined): string {
  if (!ex) return '_(Cooked snapshot indisponible)_';
  const c = ex.cta_per_device_28d;
  const ms = c.mobile_sessions ?? 0;
  const ds = c.desktop_sessions ?? 0;
  if (ms === 0 && ds === 0) {
    return '_(0 session captée sur 28d — pas de signal device lisible)_';
  }
  const lines: string[] = [];
  lines.push(
    `- mobile: ${c.cta_rate_mobile_pct != null ? c.cta_rate_mobile_pct.toFixed(2) : 'n/a'}% sur ${ms} sessions`,
  );
  lines.push(
    `- desktop: ${c.cta_rate_desktop_pct != null ? c.cta_rate_desktop_pct.toFixed(2) : 'n/a'}% sur ${ds} sessions`,
  );
  // Lecture comparative
  if (
    c.cta_rate_mobile_pct != null &&
    c.cta_rate_desktop_pct != null &&
    c.cta_rate_desktop_pct > 0
  ) {
    const ratio = c.cta_rate_mobile_pct / c.cta_rate_desktop_pct;
    lines.push(`- ratio mobile/desktop: ${ratio.toFixed(2)}`);
    lines.push('');
    if (ms < 30) {
      lines.push(
        `_⚠ mobile_sessions=${ms} < 30 — le ratio est bruité, mentionner qualitativement sans en faire un verdict. Si le ratio est très extrême (ex: 0.0 sur 11 sessions), signaler "à surveiller" sans crier au mobile-first impératif._`,
      );
    } else if (ratio < 0.25) {
      lines.push(
        `_🚨 **Mobile-first impératif** (mobile convertit à ${(ratio * 100).toFixed(0)}% du desktop sur n=${ms}). Cause #1 probable : CTA in-body absente sur mobile, formulaire trop long, ou bouton sous le fold mobile. À traiter en priorité dans la section conversion._`,
      );
    } else if (ratio > 1.3) {
      lines.push(
        `_📱 Mobile sur-convertit (ratio ${ratio.toFixed(2)}). Inverse du pattern habituel — soit l'audience mobile est sur-qualifiée, soit le desktop a un blocage UX (popup, formulaire). À investiguer côté desktop._`,
      );
    } else {
      lines.push(`_(parité device acceptable, pas de levier device-specific)_`);
    }
  } else if (
    c.cta_rate_mobile_pct === 0 &&
    c.cta_rate_desktop_pct === 0 &&
    ms + ds >= 30
  ) {
    lines.push('');
    lines.push(
      `_(0 CTA click sur les deux devices avec ${ms + ds} sessions — soit la page n'a pas de CTA in-body, soit l'intent ne pousse pas à la conversion. Cohérent avec un article de blog informationnel)_`,
    );
  }
  return lines.join('\n');
}

/**
 * Sprint 16 — Engagement density (distribution intra-session du dwell).
 *
 * Cooked publie via la RPC `engagement_density_for_path(path, days)` :
 *   sessions, dwell_p25, dwell_median, dwell_p75, evenness_score
 * où evenness_score = dwell_p25 / dwell_p75. Lecture :
 *   evenness > 0.6 → distribution étroite, lecture régulière
 *   0.3 ≤ evenness ≤ 0.6 → variabilité normale
 *   evenness < 0.3 → distribution bimodale (lots de pogos + queue d'engagés)
 *
 * Le contraste avec pogo_rate est intéressant : pogo capte les <10s,
 * evenness capte la queue moyenne — un page peut avoir un pogo OK et un
 * evenness pourri (= les non-pogos sont quand même mal engagés).
 */
function fmtEngagementDensity(d: EngagementDensity | null | undefined): string {
  if (!d) return '_(densité non disponible — RPC engagement_density_for_path indisponible ou page sans data)_';
  if (d.sessions === 0) return '_(0 sessions captées — pas de signal lisible)_';
  const lines: string[] = [];
  lines.push(`- sessions: ${d.sessions}`);
  lines.push(
    `- dwell distribution: p25=${d.dwell_p25_seconds ?? 'n/a'}s | median=${d.dwell_median_seconds ?? 'n/a'}s | p75=${d.dwell_p75_seconds ?? 'n/a'}s`,
  );
  if (d.evenness_score != null) {
    lines.push(`- **evenness_score: ${d.evenness_score.toFixed(2)}**`);
    lines.push('');
    if (d.evenness_score < 0.15) {
      lines.push(
        `_🌗 **Distribution très bimodale** (evenness=${d.evenness_score.toFixed(2)}) : la page travaille bien pour CERTAINS visiteurs (queue p75=${d.dwell_p75_seconds ?? '?'}s) mais perd les autres très tôt (p25=${d.dwell_p25_seconds ?? '?'}s). Signal d'intent mismatch partiel — le contenu ne match pas l'attente d'une partie du trafic. Croiser avec <pogo_navboost> : si pogo OK, le problème est sur les sessions moyennes (40-60s) qui partent à mi-page._`,
      );
    } else if (d.evenness_score < 0.3) {
      lines.push(
        `_⚠ Distribution variable (evenness=${d.evenness_score.toFixed(2)}). L'engagement n'est pas homogène — vérifier si la page a une rupture de qualité narrative (intro forte, milieu faible) ou si l'intent attire 2 audiences distinctes._`,
      );
    } else if (d.evenness_score > 0.6) {
      lines.push(
        `_✅ Engagement régulier (evenness=${d.evenness_score.toFixed(2)}). Quand les visiteurs lisent, ils lisent jusqu'au bout. Bon proxy pour "le contenu retient" — protéger ce signal lors des fixes._`,
      );
    }
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

function fmtMultiWindowTrend(
  ex: PageSnapshotExtras | null | undefined,
  cookedFirstSeen?: Date,
): string {
  if (!ex) return '_(Cooked snapshot indisponible)_';
  const w = ex.windows;
  const ratePerDay = (n: number, days: number): string => (days > 0 ? (n / days).toFixed(2) : '0');
  // Cooked agent briefing: "live since 5 mai 2026 — fenêtres 90d et 365d quasi
  // vides, privilégie 7d et 28d". On annotate la sortie en fonction du nombre
  // de jours de données réellement collectés depuis cookedFirstSeen.
  const daysCollected = cookedFirstSeen
    ? Math.max(0, Math.floor((Date.now() - cookedFirstSeen.getTime()) / (24 * 60 * 60 * 1000)))
    : null;
  const lines = [
    `- sessions: 7d=${w['7d'].sessions} (${ratePerDay(w['7d'].sessions, 7)}/jour) | 28d=${w['28d'].sessions} (${ratePerDay(w['28d'].sessions, 28)}/jour) | 90d=${w['90d'].sessions} | 365d=${w['365d'].sessions}`,
    `- bounce_rate: 7d=${(w['7d'].bounce_rate * 100).toFixed(1)}% | 28d=${(w['28d'].bounce_rate * 100).toFixed(1)}% | 90d=${(w['90d'].bounce_rate * 100).toFixed(1)}%`,
    `- scroll_avg: 7d=${w['7d'].scroll_avg.toFixed(1)}% | 28d=${w['28d'].scroll_avg.toFixed(1)}% | 90d=${w['90d'].scroll_avg.toFixed(1)}%`,
    `- avg_dwell: 7d=${w['7d'].avg_dwell_seconds.toFixed(0)}s | 28d=${w['28d'].avg_dwell_seconds.toFixed(0)}s`,
    `- outbound_clicks: 7d=${w['7d'].outbound_clicks} | 28d=${w['28d'].outbound_clicks} | 90d=${w['90d'].outbound_clicks}`,
  ];
  if (daysCollected !== null) {
    if (daysCollected < 90) {
      lines.push('');
      lines.push(
        `_⚠ Cooked tourne depuis ${daysCollected} jours seulement (live 5 mai 2026). La fenêtre 90d ${daysCollected < 28 ? 'ET 28d sont' : 'est'} en cours de remplissage : ${daysCollected < 90 ? 'la 90d ' : ''}${daysCollected < 365 ? 'et la 365d ' : ''}contiennent ${daysCollected} jours de data réelle, pas plus. N'interprète PAS de "trend stable sur 90 jours" — ce serait du bruit. Compare uniquement 7d vs 28d, et même 28d est borné à ${Math.min(daysCollected, 28)} jours._`,
      );
    }
  }
  return lines.join('\n');
}

function fmtOutboundDestinations(rows: OutboundDestination[] | undefined): string {
  if (!rows || rows.length === 0) return '_(aucun click sortant capturé sur 28d)_';
  return rows.slice(0, 10).map((r) => `- ${r.hostname}: ${r.clicks} clicks`).join('\n');
}

/**
 * Sprint-13bis: replaced the Sprint-12 hardcoded deploy date with a fetch
 * against Cooked's `tracker_first_seen_global()` RPC, with a 1h in-memory
 * cache to avoid spamming the RPC across all findings of one audit run.
 *
 * The hardcoded fallback below stays as a safety net for the pathological
 * case where the RPC errors (network blip, Cooked transient outage, etc.) —
 * the helper never throws, just degrades to the known-good baseline.
 */
const COOKED_TRACKER_DEPLOY_FALLBACK = new Date('2026-05-06T17:00:00Z');

let _cachedFirstSeen: { value: Date; at: number } | null = null;
const CACHE_TTL_MS = 3600_000; // 1h

/**
 * Returns the date Cooked first started collecting events, with 1h cache.
 * Falls back to the hardcoded deploy date on RPC error so the helper never
 * throws — the data quality check is too central to crash the diagnose call.
 */
export async function getCookedFirstSeen(now: Date = new Date()): Promise<Date> {
  if (_cachedFirstSeen && now.getTime() - _cachedFirstSeen.at < CACHE_TTL_MS) {
    return _cachedFirstSeen.value;
  }
  const fetched = await fetchTrackerFirstSeen();
  const value = fetched ?? COOKED_TRACKER_DEPLOY_FALLBACK;
  _cachedFirstSeen = { value, at: now.getTime() };
  return value;
}

/** Test-only: reset the cache between test runs to avoid state leakage. */
export function _resetCookedFirstSeenCache(): void {
  _cachedFirstSeen = null;
}

function daysCookedHasCollected(firstSeen: Date, now: Date): number {
  const ms = now.getTime() - firstSeen.getTime();
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
//
// Sprint-13bis: takes `cookedFirstSeen` explicitly. The diagnose pipeline
// fetches it once per audit run via `getCookedFirstSeen()` (cache 1h) and
// passes it through DiagnosticPromptInputs. Tests pass it directly.
// Pure-sync function — no I/O.
export function fmtDataQualityCheck(
  gscClicks28d: number | null | undefined,
  cookedSessions28d: number | null | undefined,
  cookedFirstSeen: Date | null,
  /** Optional override for tests (default = real time). */
  now: Date = new Date(),
): string {
  const firstSeen = cookedFirstSeen ?? COOKED_TRACKER_DEPLOY_FALLBACK;
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
  const daysCooked = daysCookedHasCollected(firstSeen, now);
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

// ============================================================================
// Sprint-14 — page content rendering helpers (body / outline / images / author).
// Replaces the v6 `intro_first_100_words` (Cooked-agent Q2: stop feeding it,
// the body supersedes — keep only for legacy retro-compat in DB).
// ============================================================================

/**
 * Render the full body text in a fenced block, with a word-count summary.
 * Truncates at 8000 words to keep prompt tokens reasonable on edge cases —
 * 99% of Plouton articles are < 3000 words so this is a safety net.
 */
function fmtPageBody(c: ContentSnapshot | null | undefined): string {
  if (!c) return '_(content_snapshot indisponible — finding pré-Sprint-14, le LLM tombe sur intro_first_100_words seulement)_';
  if (!c.body_text || c.body_text.length === 0) {
    return '_(body vide — extraction Cheerio n\'a rien trouvé, vérifier que la page est SSR pas JS-rendered)_';
  }
  const truncated = c.word_count > 8000 ? c.body_text.split(/\s+/).slice(0, 8000).join(' ') + '\n\n[…tronqué à 8000 mots]' : c.body_text;
  return [
    `**Word count** : ${c.word_count} mots`,
    ``,
    `\`\`\`text`,
    truncated,
    `\`\`\``,
  ].join('\n');
}

/**
 * Outline as a hierarchical list with H2/H3/H4 indentation + word offsets.
 * The word_offset is what lets the LLM recommend a precise insertion point
 * for a `content_addition` fix (e.g. "ajouter H2 'X' entre H2 #2 (offset 350)
 * et H2 #3 (offset 720)").
 */
function fmtPageOutline(c: ContentSnapshot | null | undefined): string {
  if (!c || c.outline.length === 0) {
    return '_(aucun H2/H3/H4 détecté dans le body — page très peu structurée)_';
  }
  const lines: string[] = [];
  for (const o of c.outline) {
    const indent = o.level === 2 ? '' : o.level === 3 ? '  ' : '    ';
    const prefix = o.level === 2 ? '##' : o.level === 3 ? '###' : '####';
    lines.push(`${indent}- ${prefix} ${o.text} _(offset ${o.word_offset} mots${o.anchor ? `, id="${o.anchor}"` : ''})_`);
  }
  return lines.join('\n');
}

/**
 * Image audit block — surfaces missing alt-text (accessibility + Image Search
 * blocker). Distinguishes in-body vs decorative (header/footer).
 */
function fmtImageAudit(c: ContentSnapshot | null | undefined): string {
  if (!c || c.images.length === 0) {
    return '_(aucune image détectée sur la page)_';
  }
  const inBody = c.images.filter((i) => i.in_body);
  const missingAlt = inBody.filter((i) => !i.alt);
  const lines: string[] = [
    `- **${inBody.length} images dans le body** (header/footer décoratives ignorées)`,
    `- **${missingAlt.length} sans alt-text** ${missingAlt.length > 0 ? '⚠️ blocage Image Search + accessibilité' : '✅'}`,
  ];
  if (missingAlt.length > 0) {
    lines.push(``, `Images sans alt :`);
    for (const i of missingAlt.slice(0, 5)) {
      lines.push(`  - \`${i.src.slice(0, 80)}${i.src.length > 80 ? '…' : ''}\``);
    }
    if (missingAlt.length > 5) lines.push(`  - _(+ ${missingAlt.length - 5} autres)_`);
  }
  return lines.join('\n');
}

/**
 * E-E-A-T author signal — byline + dates. Critical for YMYL topics
 * (legal/medical/financial — Plouton hits this category hard).
 */
function fmtAuthorEEAT(c: ContentSnapshot | null | undefined): string {
  if (!c || !c.author) {
    return '_(aucune info auteur/date détectée — signal E-E-A-T faible, particulièrement pénalisant en YMYL juridique)_';
  }
  const a = c.author;
  const lines: string[] = [];
  lines.push(`- **Auteur** : ${a.name ?? '_(absent)_'}${a.url ? ` ([profil](${a.url}))` : ''}`);
  lines.push(`- **Date publication** : ${a.date_published ?? '_(absente)_'}`);
  lines.push(`- **Date dernière modif** : ${a.date_modified ?? '_(absente)_'}`);
  if (!a.name) lines.push(`- ⚠️ Byline manquant — risque E-E-A-T sur YMYL juridique`);
  if (!a.date_modified || !a.date_published) lines.push(`- ⚠️ Dates manquantes — Google peut juger contenu obsolète`);
  return lines.join('\n');
}

/**
 * CTA in-body positions block — surfaces the position of internal CTAs
 * relative to the body word count, so the LLM can recommend repositioning.
 *
 * IMPORTANT CAVEAT (Cooked-agent flag #2): word_offset / word_count is a
 * PROXY for scroll position, not an exact correspondence. Pages with image-
 * heavy content or long footers can shift the actual scroll % significantly.
 * The block surfaces this caveat explicitly so the LLM doesn't claim exact
 * scroll-percentage figures.
 */
function fmtCtaPositions(c: ContentSnapshot | null | undefined): string {
  if (!c) return '_(content_snapshot indisponible)_';
  if (c.cta_in_body_positions.length === 0) {
    return '_(aucun CTA in-body détecté — peut être un déficit de maillage interne)_';
  }
  const lines: string[] = [
    `⚠️ **Caveat** : word_offset/word_count est un PROXY du % de scroll, pas une correspondance exacte. Une page avec beaucoup d'images ou un footer touffu peut décaler le scroll réel. À utiliser comme estimation, pas comme valeur absolue.`,
    ``,
    `Word count total : ${c.word_count}`,
    ``,
  ];
  for (const cta of c.cta_in_body_positions.slice(0, 12)) {
    const pct = c.word_count > 0 ? ((cta.word_offset / c.word_count) * 100).toFixed(0) : '?';
    lines.push(`- "${cta.anchor.slice(0, 60)}" → \`${cta.target}\` _(offset ${cta.word_offset}/${c.word_count} mots ≈ ${pct}% du body)_`);
  }
  if (c.cta_in_body_positions.length > 12) {
    lines.push(`- _(+ ${c.cta_in_body_positions.length - 12} autres CTAs)_`);
  }
  return lines.join('\n');
}

/**
 * Sprint 19 — Render the Google Search Central guidance block.
 *
 * SILO logic : this is "what Google says recently", separate from page-data
 * signals. Output a list of pivot blog posts (last 90 days, filtered for
 * relevance) + active or recent ranking-system updates (core/spam/helpful
 * content). Empty string when there's truly nothing pivot to surface —
 * downstream the prompt block is omitted entirely.
 */
export function fmtGoogleRecentGuidance(g: GoogleSearchGuidance | null | undefined): string {
  if (!g) return '_(guidance Google indisponible — fetch a échoué)_';
  const sections: string[] = [];

  // Section 1 : currently ACTIVE updates (highest priority signal)
  const active = g.incidents.filter((i) => i.is_active);
  if (active.length > 0) {
    const lines = active.map((i) => {
      const sinceDays = Math.floor((Date.now() - new Date(i.begin).getTime()) / (24 * 60 * 60 * 1000));
      return `- 🔴 **${i.title}** — démarré ${i.begin.slice(0, 10)} (en cours depuis ${sinceDays}j)`;
    });
    sections.push(`## ⚠ Updates Google EN COURS (Search Status Dashboard)\n\n${lines.join('\n')}`);
  }

  // Section 2 : recent (ended) ranking updates
  const recent = g.incidents.filter((i) => !i.is_active);
  if (recent.length > 0) {
    const lines = recent.slice(0, 5).map((i) => {
      const endDate = i.end ? i.end.slice(0, 10) : '?';
      const daysAgo = i.end ? Math.floor((Date.now() - new Date(i.end).getTime()) / (24 * 60 * 60 * 1000)) : 0;
      return `- ✅ **${i.title}** — terminé ${endDate} (il y a ${daysAgo}j)`;
    });
    sections.push(`## Updates Google récentes terminées (60j)\n\n${lines.join('\n')}`);
  }

  // Section 3 : pivot blog posts
  if (g.blog_posts.length > 0) {
    const lines = g.blog_posts.map((p) => {
      const ageLabel = p.age_days < 30 ? `${p.age_days}j` : `${Math.floor(p.age_days / 30)}mo`;
      return `- **${p.published_date}** (il y a ${ageLabel}) — [${p.title}](${p.link})\n  > ${p.summary}`;
    });
    sections.push(`## Guidance Google Search Central récente (90j, filtre pivot)\n\n${lines.join('\n\n')}`);
  }

  if (sections.length === 0) {
    return '_(rien de pivot dans les 90 derniers jours côté Google — RAS, tu peux raisonner sans signal externe)_';
  }
  return sections.join('\n\n');
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

<google_recent_guidance>
Sprint 19 — SILO de "ce que Google dit récemment". Lis ce bloc UNIQUEMENT comme regard EXTERNE / autorité Google. Ne le mélange pas avec tes signaux page-data des autres blocs. Règles strictes :

1. **Si une core update / spam update / helpful content update est ACTIVE**, mentionne-la dans \`tldr\` et ouvre \`engagement_diagnosis\` ou \`hypothesis\` par un caveat temporel : "les rankings peuvent bouger ces prochaines semaines indépendamment des fixes proposés, attendre la stabilisation avant de mesurer T+30".

2. **Si une guidance récente CONTREDIT ou NUANCE** un conseil que tu allais donner sur ta seule formation, défère à Google : ajuste ton conseil et MENTIONNE EXPLICITEMENT la source ("Per Google Search Central [titre du post du DATE], ...").

3. **Si une guidance récente RENFORCE** un conseil que tu allais déjà donner, c'est une validation utile : tu peux la citer pour appuyer la priorité.

4. **Si rien dans ce bloc n'est pertinent au diag**, IGNORE-le complètement — ne l'évoque pas, ne fais pas de référence creuse.

5. **N'invente jamais une guidance Google** qui n'est pas dans ce bloc. Si tu veux référencer une best practice Google, elle DOIT venir de ce bloc ou d'une connaissance fondamentale (PageRank, EEAT framework général). Pas de hallucination de "Google a dit récemment X".

${fmtGoogleRecentGuidance(i.enrichment?.google_guidance ?? null)}
</google_recent_guidance>

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

## Schema.org JSON-LD déjà présent
${fmtSchemaSummary(i.current_schema_jsonld)}

# Contenu de l'article (Sprint-14 — full body, plus de limite à 100 mots)

<page_body>
Le texte propre du body, headings inline, header/footer/nav exclus. Tu peux compter les mots, citer les passages précis, identifier les sections existantes et les manques. Si word_count est faible vs benchmark juridique-FR (~1 800 mots médian), c'est un signal "thin content" actionnable.

${fmtPageBody(i.content_snapshot)}
</page_body>

<page_outline>
Structure H2/H3/H4 actuelle avec word_offset (= position dans le body en mots). Utilise ce bloc pour : (a) détecter les manques de section vs les top requêtes (\`structural_gaps\`), (b) recommander des content_addition à un emplacement PRÉCIS (ex: "ajouter H2 'X' entre l'offset 350 et 720").

${fmtPageOutline(i.content_snapshot)}
</page_outline>

<images>
Audit images du body (header/footer décoratives ignorées). Compte les images sans alt-text — c'est un blocage Image Search + accessibilité.

${fmtImageAudit(i.content_snapshot)}
</images>

<author_eeat>
Signal E-E-A-T (Experience-Expertise-Authoritativeness-Trustworthiness). Critique sur YMYL juridique.

${fmtAuthorEEAT(i.content_snapshot)}
</author_eeat>

<cta_in_body_positions>
Position de chaque CTA in-body en word_offset (PROXY du % de scroll, voir caveat dans le bloc). Croise avec scroll_avg du Cooked behavior — si CTA est à 80% du body et scroll_avg est 22%, ce CTA est mort dans 78% des sessions.

${fmtCtaPositions(i.content_snapshot)}
</cta_in_body_positions>

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

<serp_competitive_landscape>
Sprint 18 — Top 10 SERP Google FR (organique) + features observées, pour les top 5 requêtes. C'est la VEILLE CONCURRENTIELLE qui te permet de répondre causalement à \`snippet_weakness\` et \`intent_mismatch\`.

Lis ce bloc EN PRIORITÉ avant d'écrire ces 2 champs :
- **snippet_weakness** : compare TON title/meta (cf. <état SEO>) aux titles+snippets des 3 premiers résultats. Identifie l'angle qui te manque (bénéfice chiffré ? autorité ? émotion ? action ?). Cite les domaines concurrents par leur nom (ex: "service-public.fr couvre l'aspect officiel, Wikipedia capte l'informationnel pur, le cabinet X mise sur l'angle dégât humain").
- **intent_mismatch** : la composition du SERP révèle l'intent dominant. SERP dominé par .gouv/.fr et Wikipedia → informationnel pur. SERP avec cabinets d'avocats en top 3 → commercial qualifié. SERP avec local pack + AI Overview → recherche locale immédiate. Confirme ou contredis ton diagnostic basé sur les queries seules.
- **SERP features** : si AI Overview présent, le CTR organique est plafonné (Google répond avant le clic) → action prioritaire = optimiser pour ÊTRE dans l'AI Overview, pas pour grimper en pos 1. Si Featured Snippet pris par un concurrent, viser à le déloger via meilleure réponse structurée (<= 50 mots, schema FAQPage). Si People Also Ask, vérifier qu'on couvre les questions associées dans nos H2.

${fmtSerpCompetitiveLandscape(enrichedQueries)}
</serp_competitive_landscape>

# Catalogue d'URLs internes RÉELLES (utilise UNIQUEMENT celles-ci pour tout maillage proposé — toute autre URL est une hallucination)
${i.enrichment ? fmtCatalog(i.enrichment.internal_pages_catalog) : '_(catalog non chargé)_'}

# Cooked full-menu (Sprint 12) — SIGNAUX BEHAVIOR & CONVERSION

⚠️ **Lis le bloc \`<data_quality_check>\` EN PREMIER.** Il te dit si tu peux lire les chiffres Cooked comme ground truth ou comme lower bound. Tous les autres blocs sont à pondérer en conséquence.

<data_quality_check>
${fmtDataQualityCheck(i.gsc_clicks_28d, i.cooked_extras?.windows['28d'].sessions ?? null, i.cooked_first_seen ?? null)}
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

<pogo_navboost>
Sprint 15 — Signal NavBoost négatif. Pogo-stick = visiteur arrive de Google, vue 1 page, repart en <10s sans rien lire. Hard pogo = idem + scroll <5%. Plus le pogo_rate est élevé, plus Google considère la page comme insatisfaisante pour la requête → dérouting progressif (chute de position observable). Lis ce bloc EN PRIORITÉ pour expliquer une position_drift négative : si pogo_rate > 20% sur n≥30, c'est probablement la cause #1. Ne sur-interprète PAS sur n<30 (la marge de bruit du rate est large), mais signale-le quand même comme "à surveiller".

${fmtPogoSignal(i.cooked_extras)}
</pogo_navboost>

<engagement_density>
Sprint 16 — Distribution intra-session du temps actif sur la page. Le pogo capture les visites <10s, l'evenness capture la queue moyenne (40-60s) — deux signaux complémentaires. Une page peut avoir un pogo OK et une evenness pourrie : ça veut dire que les non-pogos sont quand même mal engagés (perte à mi-page). À l'inverse, evenness élevée = quand on lit, on lit jusqu'au bout. À croiser avec <pogo_navboost> et avec scroll_avg.

${fmtEngagementDensity(i.engagement_density)}
</engagement_density>

<cta_per_device>
Sprint 16 — CTA conversion rate splitté mobile vs desktop. Cooked publie (phone+booking)/sessions par device sur 28d. Lis le ratio mobile/desktop : si <0.25 sur n_mobile≥30 → mobile-first impératif (CTA in-body absente sur mobile, formulaire long, bouton sous le fold). Si >1.3 → mobile sur-convertit, vérifier desktop (popup, formulaire bloquant). Sur n_mobile<30 le ratio est trop bruité pour conclure mais peut être mentionné qualitativement.

${fmtCtaPerDevice(i.cooked_extras)}
</cta_per_device>

<device_split>
Calibre les recommandations. 70% mobile + scroll court → fix mobile-first. 70% desktop → marges plus larges, intro plus longue OK.

${fmtDeviceSplit(i.cooked_extras)}
</device_split>

<multi_window_trend>
Détecte les pages en pic ou en chute. Compare 7d normalisé vs 28d normalisé.

${fmtMultiWindowTrend(i.cooked_extras, i.cooked_first_seen ?? undefined)}
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
  "intent_mismatch": "Décris en 1-3 phrases le mismatch entre l'intention dominante des top requêtes (en t'appuyant sur les volumes réels France) et le cadrage actuel du title/meta/H1. Cite les requêtes concernées avec leurs volumes. (Sprint 18) **Lis aussi <serp_competitive_landscape>** : la composition du SERP révèle l'intent dominant — SERP dominé par .gouv/Wikipedia → informationnel ; SERP avec cabinets d'avocats en top 3 → commercial qualifié ; AI Overview présent → recherche immédiate plafonnée. Confirme ou contredis ton diagnostic d'intent par ce que la SERP montre VRAIMENT.",
  "snippet_weakness": "Décris en 1-3 phrases pourquoi le snippet (title + meta) ne convertit pas. Sois précis : trop générique ? Pas de bénéfice chiffré ? Concurrent plus fort dans la SERP ? Si la share of voice est déjà élevée (>50%) le levier est sur le CTR pas sur le ranking. (Sprint 18) **Lis EN PRIORITÉ <serp_competitive_landscape>** : compare ton title/meta aux titles+snippets des 3 premiers résultats organiques de chaque top query. Cite les domaines concurrents par leur nom (ex: 'service-public.fr couvre l'aspect officiel, Wikipedia capte l'informationnel pur, le cabinet X mise sur l'angle dégât humain — ton snippet n'a pas d'angle distinct'). Si AI Overview ou Featured Snippet présent, mentionne explicitement leur impact sur le CTR organique plafonné.",
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
  "device_optimization_note": "1-2 phrases. (Sprint-16) **Lis EN PRIORITÉ <cta_per_device>** plus que <device_split> : c'est le ratio cta_rate_mobile/cta_rate_desktop qui dit si la page convertit autant sur les 2 formats. Si ratio < 0.25 sur n_mobile≥30 → 'mobile-first impératif (CTA mobile X% du desktop), ajouter CTA in-body above-the-fold mobile en priorité absolue'. Si ratio > 1.3 → 'mobile sur-convertit, vérifier blocage UX desktop'. Si ratio en parité → utiliser <device_split> seul : si mobile ≥ 65% + scroll_avg < 30% → 'fix mobile-first impératif (intro courte)', sinon 'audience hybride OK'. Si n_mobile<30 ou pas de data CTA: 'split device non significatif sur les conversions, lecture qualitative seulement'.",
  "engagement_pattern_assessment": "1-2 phrases. (Sprint-16) Lis <engagement_density>. Si evenness < 0.15 → 'distribution très bimodale, la page travaille pour certains visiteurs (queue p75=Xs) mais perd les autres très tôt (p25=Ys), signal d'intent mismatch partiel'. À CROISER avec <pogo_navboost> : si pogo OK + evenness <0.15 → 'le problème n'est pas la première seconde mais la mi-page (les visiteurs lisent puis abandonnent vers Xs)'. Si evenness > 0.6 → 'engagement régulier, quand on lit on va au bout, contenu retient — protéger ce signal lors des fixes'. Si entre 0.3-0.6 → mention courte, pas de verdict fort. Si pas de data : 'densité d'engagement non disponible'.",
  "outbound_leak_note": "1 phrase ou 'pas de leak significatif'. Lis <top_outbound_destinations>: si la top destination est sémantiquement liée à la thématique de la page (ex: legifrance.gouv.fr / service-public.fr sur une page juridique), c'est une fuite réparable → 'ajoute la citation X in-page au lieu de laisser fuir vers source externe Y'. Sinon : 'fuites externes normales (autorités juridiques officielles), pas un signal de fix'.",
  "pogo_navboost_assessment": "1-2 phrases. Lis <pogo_navboost>. Si pogo_rate > 20% sur n≥30 google_sessions → cause #1 d'une éventuelle position_drift négative, à mettre en tête des hypothèses : 'NavBoost dérouté la page (pogo XX% sur n=YY) — l'intent ne match pas, soit le snippet ment, soit la page n'apporte pas la réponse attendue dans les 10 premières secondes'. Si n<30, mentionne 'à surveiller, échantillon trop faible pour conclure'. Si pas de signal (0 google_sessions ou tracker récent), écris 'signal pogo non disponible (Cooked vient de démarrer ou page non indexée)'. Si pogo_rate ≤ 10% sur n≥30, écris brièvement 'engagement Google satisfaisant (pogo XX%)' — c'est une info utile à l'inverse pour ne pas fixer ce qui marche.",
  "structural_gaps": "1-3 phrases sur les manques structurels. Tu DOIS prendre en compte : le schema déjà présent (ne pas suggérer ce qui existe), le bloc <outbound_links_from_this_page> (ne pas re-suggérer des liens existants), le RÔLE FUNNEL de la page, ET (Sprint-14) **le bloc <page_outline> et le word_count du <page_body>**. Si le word_count est < 1500 mots sur un sujet juridique substantiel, dis 'thin content vs benchmark juridique-FR ~1800 mots médian'. Si une top requête à fort volume n'a pas de H2 dédié dans <page_outline>, dis-le explicitement avec l'offset où l'insérer. Cite le bloc <images> si plusieurs images sans alt-text. ⚠️ **Si le bloc outbound est marqué 'Snapshot pré-Sprint-9', traite le maillage éditorial sortant comme INCONNU.** ⚠️ **Si <page_body> est indisponible/vide, écris 'extraction body indisponible' et ne fais PAS de claim sur word_count ou outline.**",
  "funnel_assessment": "1-2 phrases : la page remplit-elle correctement son rôle funnel ? Quels maillons manquants vers les pages expertise + CTA du catalogue ? Cite les URLs précises du catalogue. (Sprint-14) **Lis aussi <cta_in_body_positions>** — si un CTA existant est très tard dans le body (offset > 70% du word_count) et que scroll_avg Cooked est faible (<50%), recommande explicitement de le repositionner plus tôt avec l'offset cible. ⚠️ **Si <outbound_links_from_this_page> est 'Snapshot pré-Sprint-9', écris : 'maillage éditorial sortant non capturé — réévaluer'.**",
  "internal_authority_assessment": "1-2 phrases sur la position de cette page dans le graph interne (lis EXCLUSIVEMENT le bloc <inbound_links_to_this_page>, JAMAIS le bloc outbound). Si inbound_editorial>=10 → 'page hub à protéger' (les fixes ne doivent pas casser ce statut). Si inbound_editorial==0 et inbound_total>0 → 'page orpheline éditorialement' : prioriser absolument l'ajout de liens depuis 2-3 pages sources naturelles. Sinon → position standard, pas de levier graph spécifique. Si le graph n'est pas encore crawlé, écris 'graph non disponible (premier crawl en cours)'."
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
