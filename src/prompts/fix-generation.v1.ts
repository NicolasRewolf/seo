/**
 * Fix-generation prompt v1 — ROADMAP §8 + Sprint-7 enrichment.
 *
 * Now receives the same enrichment as the diagnostic prompt: categorized
 * existing maillage (editorial / nav / posts similaires), the REAL site
 * catalog of internal URLs, DataForSEO volumes per top query, the article's
 * Wix category + funnel role, and the first-party Wix views.
 *
 * Without these the v0 fix-gen hallucinated link targets like
 * /post/licenciement-faute-grave (didn't exist), invented dateModified
 * values for schema, and re-suggested internal links that already existed.
 */
import type { EnrichedContext, EnrichedTopQuery } from '../pipeline/context-enrichment.js';

export const FIX_GEN_PROMPT_NAME = 'fix_generation' as const;
export const FIX_GEN_PROMPT_VERSION = 1 as const;

export type FixGenPromptInputs = {
  url: string;
  position: number;
  current_title: string;
  current_meta: string;
  current_h1: string;
  current_intro: string;
  current_schema_jsonld: unknown[] | null;
  current_internal_links: Array<{ anchor: string; target: string }>;
  top_queries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
  diagnostic: unknown;
  enrichment?: EnrichedContext;
};

function fmtTopQueries(rows: FixGenPromptInputs['top_queries']): string {
  if (rows.length === 0) return '(none)';
  return rows.map((r) => `${r.query} (${r.impressions} imp, ${(r.ctr * 100).toFixed(2)}% CTR, pos ${r.position.toFixed(1)})`).join('; ');
}

function fmtEnrichedTopQueries(rows: EnrichedTopQuery[]): string {
  if (rows.length === 0) return '(none)';
  return rows
    .map((r) => {
      const ctr = (r.ctr * 100).toFixed(2);
      const vol = r.monthly_volume_fr != null ? r.monthly_volume_fr.toLocaleString('fr-FR') + ' rech/mois FR' : 'vol n/a';
      const sov = r.share_of_voice_pct != null ? `SOV ${r.share_of_voice_pct}%` : '';
      return `${r.query} — ${r.impressions} imp/3mo, CTR ${ctr}%, pos ${r.position.toFixed(1)}, ${vol}${sov ? ', ' + sov : ''}`;
    })
    .join(' | ');
}

function fmtCategorizedLinks(rows: FixGenPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '_(aucun lien sortant détecté)_';
  const editorial: string[] = [];
  const related: string[] = [];
  const nav: string[] = [];
  const editorialMarkers = /\b(découvrez|consultez|contactez|notre cabinet|nos services|cabinet plouton|en savoir plus|voir nos|notre équipe)\b/;
  for (const l of rows) {
    let path = '';
    try {
      path = new URL(l.target).pathname;
    } catch {
      path = l.target;
    }
    const a = l.anchor.toLowerCase();
    if (path.startsWith('/post/')) related.push(`${l.anchor.slice(0, 60)} → ${l.target}`);
    else if (a.length > 25 || editorialMarkers.test(a)) editorial.push(`${l.anchor.slice(0, 80)} → ${l.target}`);
    else nav.push(`${l.anchor.slice(0, 30)} → ${path}`);
  }
  const out: string[] = [];
  out.push(
    `LIENS ÉDITORIAUX in-body (${editorial.length}) — ne PAS re-suggérer ces liens, ils existent déjà :\n  - ` +
      (editorial.length > 0 ? editorial.join('\n  - ') : '_(aucun)_'),
  );
  out.push(
    `LIENS auto "posts similaires" (${related.length}) — pas un signal éditorial actionnable.`,
  );
  out.push(
    `LIENS nav header/footer (${nav.length}) — présents sur toutes les pages, pas un maillage propre à cet article.`,
  );
  return out.join('\n');
}

function fmtCatalogForFixes(catalog: EnrichedContext['internal_pages_catalog'] | undefined): string {
  if (!catalog) return '_(catalog non disponible)_';
  const fmt = (entries: typeof catalog.expertise): string =>
    entries.map((e) => `  - ${e.url}${e.topic ? ` — ${e.topic}` : ''}`).join('\n');
  const sections: string[] = [];
  if (catalog.expertise.length > 0) sections.push(`Pages expertise :\n${fmt(catalog.expertise)}`);
  if (catalog.cta.length > 0) sections.push(`Pages CTA / RDV :\n${fmt(catalog.cta)}`);
  if (catalog.trust.length > 0) sections.push(`Pages trust (cabinet/affaires) :\n${fmt(catalog.trust)}`);
  return sections.join('\n');
}

function fmtCategoryRoleForFixes(enr: EnrichedContext | undefined): string {
  if (!enr || !enr.category) return '';
  const role = enr.category.role;
  const lines: string[] = [`- **Catégorie Wix** : ${enr.category.label}`];
  if (role === 'knowledge_brick') {
    lines.push(
      "- **Rôle funnel** : article RESSOURCES — doit funneler vers (a) une page expertise thématique pertinente, (b) un CTA prise de RDV, et (c) une page trust (notre-cabinet ou nos-affaires) pour rassurer.",
    );
  } else if (role === 'topic_expertise' && enr.category.funnelTo) {
    lines.push(
      `- **Rôle funnel** : article TOPIC ALIGNÉ avec ${enr.category.label} — doit linker en priorité vers ${enr.category.funnelTo} et vers un CTA RDV.`,
    );
  } else if (role === 'press') {
    lines.push(
      "- **Rôle funnel** : article PRESSE — signal de confiance, ne pas optimiser comme une page transactionnelle.",
    );
  }
  return lines.join('\n');
}
function fmtSchemaTypes(blocks: unknown[] | null): string {
  if (!blocks || blocks.length === 0) return '(aucun)';
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return '<malformed>';
      const t = (b as Record<string, unknown>)['@type'];
      if (Array.isArray(t)) return t.join(', ');
      if (typeof t === 'string') return t;
      return '<no @type>';
    })
    .join(' / ');
}
function fmtLinks(rows: FixGenPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '(aucun lien interne sortant repéré)';
  const sample = rows.slice(0, 8).map((l) => `${l.anchor} → ${l.target}`);
  const tail = rows.length > 8 ? ` … (+ ${rows.length - 8} autres)` : '';
  return sample.join(' | ') + tail;
}

export function renderFixGenPrompt(i: FixGenPromptInputs): string {
  const enrichedQueries: EnrichedTopQuery[] =
    i.enrichment?.enriched_top_queries ??
    i.top_queries.map((q) => ({
      ...q,
      monthly_volume_fr: null,
      cpc: null,
      share_of_voice_pct: null,
    }));

  return `Tu es un copywriter SEO expert pour cabinets d'avocats. Tu connais le funnel : article ressources → page expertise → prise de RDV. Sur la base du diagnostic suivant, propose des fixes concrets pour corriger le sous-CTR et le pages/session de cette page.

# Contexte de la page
URL : ${i.url}
${fmtCategoryRoleForFixes(i.enrichment)}
Position : ${i.position.toFixed(1)}

État actuel :
- Title : ${i.current_title || '(empty)'}
- Meta : ${i.current_meta || '(empty)'}
- H1 : ${i.current_h1 || '(empty)'}
- Intro : ${i.current_intro || '(empty)'}
- Schema.org JSON-LD présent : ${fmtSchemaTypes(i.current_schema_jsonld)}

## Maillage interne actuel (catégorisé)
${fmtCategorizedLinks(i.current_internal_links)}

# Top queries avec volume FR et share of voice
${fmtEnrichedTopQueries(enrichedQueries)}

# Catalogue d'URLs internes RÉELLES (utilise UNIQUEMENT celles-ci pour tout maillage proposé — toute autre URL est une hallucination que le QA rejettera)
${fmtCatalogForFixes(i.enrichment?.internal_pages_catalog)}

# Diagnostic
${JSON.stringify(i.diagnostic, null, 2)}

# Tes contraintes
- Le client est Cabinet Plouton, avocat pénaliste à Bordeaux
- Pas de promesse de résultat (déontologie avocat)
- Pas de "meilleur avocat" ou superlatifs interdits par les ordres
- Mots-clés naturels, pas de stuffing
- Title : ≤60 caractères, mot-clé principal en début, angle distinctif (spécificité géographique, donnée chiffrée, ou bénéfice concret)
- Meta : ≤155 caractères, répond directement à l'intention principale, contient un appel à l'action implicite
- Intro (100 premiers mots) : répond à la requête principale dans la première phrase, pas d'intro contextuelle, structure "réponse → contexte → ce que tu vas trouver dans la suite"
- **Pour les liens internes** :
  - URLs proposées DOIVENT venir du catalogue ci-dessus (pas d'invention)
  - Ne PAS re-suggérer un lien déjà listé dans "LIENS ÉDITORIAUX in-body" (il existe déjà)
  - Si un lien éditorial existant pointe vers une mauvaise sous-expertise, dis-le explicitement et propose le REMPLACEMENT
- **Pour le schema** : ne propose pas un type déjà présent. Pour Article schema, n'invente pas de dateModified/datePublished — si tu n'as pas la vraie date, écris "{{TO_FILL_BY_AUTHOR}}" comme placeholder.
- **Pour les CTA** : tenir compte du rôle funnel ci-dessus. Un knowledge_brick doit avoir un CTA explicite et hiérarchisé en bas d'article, pas noyé.

# Format de réponse JSON strict

{
  "fixes": [
    // Une entrée par fix que tu décides de proposer. Tu choisis dynamiquement
    // les fix_type pertinents — ne propose que ce qui apporte un vrai gain.
    //
    // Valeurs possibles pour fix_type :
    //   - "title"             — toujours pertinent si le title actuel est ≥60 chars, ne match pas l'intent, ou enterre les mots-clés
    //   - "meta_description"  — toujours pertinent si la meta est >155 chars, manque un signal différenciant ou un bénéfice
    //   - "h1"                — UNIQUEMENT si le H1 diffère du title et peut être affûté
    //   - "intro"             — si l'intro actuelle est faible, polluée (nav cruft), ou ne répond pas à la requête principale
    //   - "schema"            — UNIQUEMENT si un type Schema.org pertinent manque (ex: FAQPage si les top queries sont des questions, BreadcrumbList si la page a une hiérarchie claire). Pour le proposed_value, fournis du JSON-LD valide complet en string.
    //   - "internal_links"    — si NavBoost faible (pages/session bas, durée courte) OU si maillage anémique. Format proposed_value: "ancre1 → URL1 | ancre2 → URL2 | ancre3 → URL3"
    //   - "content_addition"  — UNIQUEMENT si une top query est partiellement matched et appelle une section éditoriale manquante. Décris la section à ajouter (titre + 2-3 lignes du contenu attendu).
    //
    // Toujours proposer title et meta_description si les valeurs actuelles ne sont pas optimales.
    // Les autres ne doivent apparaître que si réellement actionnables.
    {
      "fix_type": "<une des valeurs ci-dessus>",
      "current_value": "<la valeur actuelle exacte, ou null si non applicable>",
      "proposed_value": "<ta proposition>",
      "rationale": "1-2 phrases : pourquoi ce fix, quelle requête il vise, quel signal NavBoost il améliore"
    }
  ]
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
