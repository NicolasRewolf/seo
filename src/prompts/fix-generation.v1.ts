/**
 * Fix-generation prompt v1 — ROADMAP §8.
 *
 * Updated on 2026-05-06: opened the response shape so the LLM proposes
 * fixes from the full list of 7 fix_type values (not the 4 hardcoded ones
 * that the v0 template forced). The LLM decides which are relevant; this
 * removes false-positive intro/links fixes on pages that didn't need them
 * and unlocks h1/schema/content_addition fixes when justified.
 */
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
};

function fmtTopQueries(rows: FixGenPromptInputs['top_queries']): string {
  if (rows.length === 0) return '(none)';
  return rows.map((r) => `${r.query} (${r.impressions} imp, ${(r.ctr * 100).toFixed(2)}% CTR, pos ${r.position.toFixed(1)})`).join('; ');
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
  return `Tu es un copywriter SEO expert pour cabinets d'avocats. Sur la base du diagnostic suivant, propose des fixes concrets pour corriger le sous-CTR de cette page.

# Contexte de la page
URL : ${i.url}
Top requêtes : ${fmtTopQueries(i.top_queries)}
Position : ${i.position.toFixed(1)}
État actuel :
- Title : ${i.current_title || '(empty)'}
- Meta : ${i.current_meta || '(empty)'}
- H1 : ${i.current_h1 || '(empty)'}
- Intro : ${i.current_intro || '(empty)'}
- Schema.org JSON-LD présent : ${fmtSchemaTypes(i.current_schema_jsonld)}
- Maillage interne sortant : ${fmtLinks(i.current_internal_links)}

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
- Pour les liens internes : ne propose PAS de liens qui existent déjà dans le maillage actuel listé ci-dessus. Vise des liens vers des pages thématiques manquantes.
- Pour le schema : ne propose PAS un type qui existe déjà sur la page. Si FAQPage est déjà là, ne le re-suggère pas.

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
