/**
 * Diagnostic prompt v3 — ROADMAP §8 + Sprint-7 enrichment + Sprint-8 Cooked/CWV.
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
 *
 * Older diagnostics persisted under v1/v2 schemas remain readable: every
 * new JSON field is `.optional().default('')` in the Zod validator (cf.
 * src/pipeline/diagnose.ts).
 *
 * Renders the prompt with simple `{{var}}` substitution. Top-level export is
 * a function rather than a string so future versions (v4 etc.) can plug in
 * with the same signature.
 */
import type {
  EnrichedTopQuery,
  EnrichedContext,
} from '../pipeline/context-enrichment.js';
import type { CatalogEntry } from '../lib/site-catalog.js';

export const DIAGNOSTIC_PROMPT_NAME = 'diagnostic' as const;
export const DIAGNOSTIC_PROMPT_VERSION = 3 as const;

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
  current_internal_links: Array<{ anchor: string; target: string }>;
  // Top queries (raw — enriched if context-enrichment ran)
  top_queries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
  /** Sprint-7 enrichment (optional during transition / when API is unavailable). */
  enrichment?: EnrichedContext;
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
 * Group extracted links into editorial vs navigation buckets so the LLM
 * doesn't conflate the two (e.g. don't conclude "no editorial maillage"
 * just because the only links it sees are header menu items).
 *  - "related_post" → links to /post/* (Wix "posts similaires" block)
 *  - "editorial"   → anchor has a sentence-like quality (long, or contains
 *                    French body verbs like "découvrez/contactez/notre/nos")
 *  - "nav"         → everything else (header menu, footer nav, repeated
 *                    expertise labels)
 */
function classifyLink(link: { anchor: string; target: string }): 'editorial' | 'nav' | 'related_post' {
  let path = '';
  try {
    path = new URL(link.target).pathname;
  } catch {
    path = link.target;
  }
  if (path.startsWith('/post/')) return 'related_post';
  const a = link.anchor.toLowerCase();
  const editorialMarkers = /\b(découvrez|consultez|contactez|notre cabinet|nos services|cabinet plouton|en savoir plus|voir nos|cliquez ici|notre équipe)\b/;
  if (a.length > 25 || editorialMarkers.test(a)) return 'editorial';
  return 'nav';
}

function fmtCategorizedLinks(rows: DiagnosticPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '_(aucun lien interne sortant détecté)_';

  const editorial: typeof rows = [];
  const nav: typeof rows = [];
  const related: typeof rows = [];
  for (const l of rows) {
    const k = classifyLink(l);
    if (k === 'editorial') editorial.push(l);
    else if (k === 'nav') nav.push(l);
    else related.push(l);
  }

  const sections: string[] = [];
  sections.push(
    `**Liens éditoriaux in-body** (${editorial.length}) — ce sont les vrais signaux de funnel choisis par l'auteur :\n` +
      (editorial.length === 0
        ? '_(aucun lien éditorial détecté dans le corps de l\'article — fort signal de cul-de-sac funnel)_'
        : editorial.map((l) => `- "${l.anchor.slice(0, 100)}" → ${l.target}`).join('\n')),
  );
  sections.push(
    `**Liens "posts similaires"** auto-générés par Wix (${related.length}) — pas de signal éditorial :\n` +
      (related.length === 0
        ? '_(aucun)_'
        : related
            .slice(0, 5)
            .map((l) => `- "${l.anchor.slice(0, 80)}" → ${l.target}`)
            .join('\n')),
  );
  sections.push(
    `**Liens header/footer/nav** (${nav.length}) — présents sur TOUTES les pages, pas un signal de maillage propre à cette page : ` +
      (nav.length === 0
        ? '_aucun_'
        : `${nav.slice(0, 5).map((l) => l.anchor.slice(0, 30)).join(', ')}…`),
  );
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

## Maillage interne sortant déjà présent (catégorisé)
${fmtCategorizedLinks(i.current_internal_links)}

# Top requêtes (3 derniers mois) avec volume réel France et share of voice
${fmtEnrichedQueriesTable(enrichedQueries)}
${fmtDemandBlock(i.enrichment)}

# Catalogue d'URLs internes RÉELLES (utilise UNIQUEMENT celles-ci pour tout maillage proposé — toute autre URL est une hallucination)
${i.enrichment ? fmtCatalog(i.enrichment.internal_pages_catalog) : '_(catalog non chargé)_'}

# Ta mission
Produis un diagnostic JSON strict avec ce schéma :

{
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
  "engagement_diagnosis": "Lecture des signaux comportementaux Cooked (first-party, non biaisé). Si pages/session<1.3, scroll<50%, ou peu de clics sortants, explique ce que ça signale (intention déçue, contenu insuffisant, CTA manquante). Sinon: 'engagement satisfaisant'. Note: si Cooked vient juste d'être déployé et que les valeurs sont null, écris 'données comportementales en cours de collecte (n/a au premier audit)'.",
  "performance_diagnosis": "Si LCP > 2500ms, INP > 200ms ou CLS > 0.1 (zones 'Needs Improvement' ou 'Poor' Google), explique l'impact NavBoost direct (Google rétrograde les pages lentes/instables) et donne l'action prioritaire (image trop lourde, JS bloquant, layout shift sur header...). Si toutes les valeurs sont null: 'CWV en cours de collecte (n/a)'. Sinon: 'performance technique satisfaisante'.",
  "structural_gaps": "1-3 phrases sur les manques structurels. Tu DOIS prendre en compte : le schema déjà présent (ne pas suggérer ce qui existe), le maillage actuel catégorisé ci-dessus (ne pas re-suggérer des liens éditoriaux déjà en place — la nav menu ne compte pas comme maillage éditorial), et le RÔLE FUNNEL de la page.",
  "funnel_assessment": "1-2 phrases : la page remplit-elle correctement son rôle dans le funnel attendu pour sa catégorie ? Quels sont les 2-3 maillons manquants vers les pages expertise + CTA du catalogue ? Cite les URLs cibles précises depuis le catalogue. Pour un knowledge_brick, exiger au minimum 1 lien expertise + 1 CTA RDV éditorialement intégrés (pas juste dans la nav)."
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
