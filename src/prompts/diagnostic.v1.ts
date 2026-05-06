/**
 * Diagnostic prompt v2 — ROADMAP §8.
 *
 * v2 (this file) replaces the GA4-derived "engagement" section with first-party
 * behavioral data from Cooked, and adds a Core Web Vitals section. The
 * resulting JSON gains a `performance_diagnosis` field. Older v1 diagnostics
 * persisted in `audit_findings.diagnostic` remain readable — the Zod schema
 * defaults the new field to '' for backward compatibility.
 *
 * Renders the prompt with simple `{{var}}` substitution. Top-level export is
 * a function rather than a string so future versions (v3 etc.) can plug in
 * with the same signature, and so we can store the rendered prompt in
 * audit_runs.config_snapshot if we want to debug a specific run.
 */
export const DIAGNOSTIC_PROMPT_NAME = 'diagnostic' as const;
export const DIAGNOSTIC_PROMPT_VERSION = 2 as const;

export type DiagnosticPromptInputs = {
  url: string;
  avg_position: number;
  position_drift: number | null;
  impressions_monthly: number;
  ctr_actual: number;
  ctr_expected: number;
  ctr_gap_pct: number;
  pages_per_session: number | null;
  avg_duration_seconds: number | null;
  scroll_depth: number | null;
  scroll_complete_pct: number | null;
  outbound_clicks: number | null;
  lcp_p75_ms: number | null;
  inp_p75_ms: number | null;
  cls_p75: number | null;
  ttfb_p75_ms: number | null;
  current_title: string;
  current_meta: string;
  current_h1: string;
  current_intro: string;
  current_schema_jsonld: unknown[] | null;
  current_internal_links: Array<{ anchor: string; target: string }>;
  top_queries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
};

function fmtPct(n: number): string {
  return (n * 100).toFixed(2);
}
function fmtNumOrNA(n: number | null | undefined, suffix = ''): string {
  return n == null ? 'n/a' : `${n}${suffix}`;
}
function fmtQueriesTable(rows: DiagnosticPromptInputs['top_queries']): string {
  if (rows.length === 0) return '(no query data available)';
  const lines = ['| query | impressions | ctr | position |', '|---|---|---|---|'];
  for (const r of rows) {
    const ctr = (r.ctr * 100).toFixed(2) + '%';
    lines.push(`| ${r.query} | ${r.impressions} | ${ctr} | ${r.position.toFixed(1)} |`);
  }
  return lines.join('\n');
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
function fmtExistingLinks(rows: DiagnosticPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '_(aucun lien interne sortant détecté — peut indiquer un scrape limité ou une page maillée trop pauvrement)_';
  const sample = rows.slice(0, 10);
  const more = rows.length > 10 ? ` (+ ${rows.length - 10} autres)` : '';
  return sample.map((l) => `- "${l.anchor}" → ${l.target}`).join('\n') + more;
}

/**
 * Classify a Core Web Vital value against Google's tri-tier thresholds.
 * Source: https://web.dev/articles/vitals (Good / Needs Improvement / Poor).
 */
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

export function renderDiagnosticPrompt(i: DiagnosticPromptInputs): string {
  return `Tu es un consultant SEO senior expert en NavBoost et signaux de clic Google. Analyse cette page sous-performante et produis un diagnostic structuré.

# Page analysée
URL : ${i.url}
Position moyenne : ${i.avg_position.toFixed(1)}
Position drift (3 mois) : ${fmtNumOrNA(i.position_drift)}
Impressions/mois : ${i.impressions_monthly}
CTR actuel : ${fmtPct(i.ctr_actual)}%
CTR attendu pour cette position : ${fmtPct(i.ctr_expected)}%
Gap : ${i.ctr_gap_pct.toFixed(1)}%

# Comportement (first-party, non échantillonné)
Pages/session : ${fmtNumOrNA(i.pages_per_session)}
Durée moyenne : ${fmtNumOrNA(i.avg_duration_seconds, 's')}
Scroll moyen : ${fmtNumOrNA(i.scroll_depth, '%')}
Scroll complet (% sessions atteignant 100%) : ${fmtNumOrNA(i.scroll_complete_pct, '%')}
Clics sortants : ${fmtNumOrNA(i.outbound_clicks)}

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

# Schema.org JSON-LD déjà présent
${fmtSchemaSummary(i.current_schema_jsonld)}

# Maillage interne sortant déjà présent (échantillon)
${fmtExistingLinks(i.current_internal_links)}

# Top 10 requêtes (3 derniers mois)
${fmtQueriesTable(i.top_queries)}

# Ta mission
Produis un diagnostic JSON strict avec ce schéma :

{
  "intent_mismatch": "Décris en 1-3 phrases si le title/meta/H1 ne correspondent pas à l'intention dominante des top requêtes. Cite les requêtes concernées.",
  "snippet_weakness": "Décris en 1-3 phrases pourquoi le snippet (title + meta) ne convertit pas les impressions en clics. Sois précis : trop générique ? Pas de bénéfice ? Pas de signal de spécificité ? Concurrent plus fort ?",
  "hypothesis": "Une seule phrase : ton hypothèse principale du sous-CTR.",
  "top_queries_analysis": [
    {
      "query": "string",
      "impressions": number,
      "ctr": number,
      "position": number,
      "intent_match": "yes" | "partial" | "no",
      "note": "courte note"
    }
  ],
  "engagement_diagnosis": "Si pages_per_session < 1.3 ou duration < 30s ou scroll < 50%, explique ce que ça signale (intention déçue, contenu insuffisant, CTA manquante…). Sinon: 'engagement satisfaisant'.",
  "performance_diagnosis": "Si LCP > 2500ms, INP > 200ms ou CLS > 0.1 (zones 'Needs Improvement' ou 'Poor' Google), explique l'impact NavBoost direct (Google rétrograde les pages lentes/instables) et donne l'action prioritaire (image trop lourde, JS bloquant, layout shift sur header…). Sinon: 'performance technique satisfaisante'.",
  "structural_gaps": "1-3 phrases sur ce qui manque structurellement. Tu DOIS prendre en compte le schema déjà présent (ne pas suggérer ce qui existe) et le maillage actuel. Mentionne uniquement des gaps concrets (ex: 'aucune FAQPage alors que les top queries sont des questions', ou 'maillage anémique vers les pages thématiques connexes')."
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
