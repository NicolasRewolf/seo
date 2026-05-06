/**
 * Fix-generation prompt v1 — ROADMAP §8.
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
  top_queries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
  diagnostic: unknown;
};

function fmtTopQueries(rows: FixGenPromptInputs['top_queries']): string {
  if (rows.length === 0) return '(none)';
  return rows.map((r) => `${r.query} (${r.impressions} imp, ${(r.ctr * 100).toFixed(2)}% CTR, pos ${r.position.toFixed(1)})`).join('; ');
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

# Format de réponse JSON strict

{
  "fixes": [
    {
      "fix_type": "title",
      "current_value": "${i.current_title.replace(/"/g, '\\"')}",
      "proposed_value": "string ≤60 chars",
      "rationale": "1-2 phrases : pourquoi ce titre, quelle requête il vise, quel angle"
    },
    {
      "fix_type": "meta_description",
      "current_value": "${i.current_meta.replace(/"/g, '\\"')}",
      "proposed_value": "string ≤155 chars",
      "rationale": "..."
    },
    {
      "fix_type": "intro",
      "current_value": "${i.current_intro.replace(/"/g, '\\"').slice(0, 200)}",
      "proposed_value": "string ≤100 mots",
      "rationale": "..."
    },
    {
      "fix_type": "internal_links",
      "current_value": null,
      "proposed_value": "Liste de 2-3 suggestions au format : '[ancre proposée] → [URL cible probable du même site]'",
      "rationale": "Pourquoi ces liens prolongent la session et renforcent le signal NavBoost"
    }
  ]
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
