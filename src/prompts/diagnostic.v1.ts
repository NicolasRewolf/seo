/**
 * Diagnostic prompt v1 — ROADMAP §8.
 *
 * Renders the prompt with simple `{{var}}` substitution. Top-level export is
 * a function rather than a string so future versions (v2 etc.) can plug in
 * with the same signature, and so we can store the rendered prompt in
 * audit_runs.config_snapshot if we want to debug a specific run.
 */
export const DIAGNOSTIC_PROMPT_NAME = 'diagnostic' as const;
export const DIAGNOSTIC_PROMPT_VERSION = 1 as const;

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
  current_title: string;
  current_meta: string;
  current_h1: string;
  current_intro: string;
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

# Engagement (GA4)
Pages/session : ${fmtNumOrNA(i.pages_per_session)}
Durée moyenne : ${fmtNumOrNA(i.avg_duration_seconds, 's')}
Scroll depth : ${fmtNumOrNA(i.scroll_depth, '%')}

# État actuel de la page
**Title** : ${i.current_title || '(empty)'}
**Meta description** : ${i.current_meta || '(empty)'}
**H1** : ${i.current_h1 || '(empty)'}
**Intro (100 premiers mots)** : ${i.current_intro || '(empty)'}

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
  "engagement_diagnosis": "Si pages_per_session < 1.3 ou duration < 30s ou scroll < 50%, explique ce que ça signale. Sinon: 'engagement satisfaisant'."
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
