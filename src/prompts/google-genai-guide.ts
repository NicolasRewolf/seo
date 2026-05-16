/**
 * Sprint-23 — Google "AI Optimization Guide" pillar (published 2026-05-15).
 *
 * Source : https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
 *
 * Google has now officially documented its stance on AEO/GEO :
 *   - The classical SEO best practices ARE the AI-optimization best practices.
 *     RAG (Retrieval-Augmented Generation) and Query Fan-Out both rely on the
 *     same core ranking signals as Search.
 *   - "AEO" and "GEO" are just SEO renamed. There is no separate optimization.
 *   - A list of common "hacks" is explicitly debunked as USELESS for Google.
 *
 * Two constants exported below :
 *
 * 1. `GOOGLE_GENAI_ANTI_PATTERNS_BLOCK` — wrap in <google_genai_anti_patterns>
 *    inside the diagnostic + fix-gen prompts. Locks the LLM out of proposing
 *    fixes that contradict Google's own published guidance.
 *
 * 2. `GOOGLE_NON_COMMODITY_PRINCIPLE_BLOCK` — wrap in <google_non_commodity_principle>
 *    inside the diagnostic prompt. Frames the #1 lever Google flags as the
 *    long-term winner : non-commodity, unique-POV, first-hand content.
 *
 * These are static text (no I/O, no dynamic rendering) so they go into both
 * prompts at build time. When Google updates the guide we bump the constants
 * here, bump the prompt version, and re-run the eval.
 */

export const GOOGLE_GENAI_ANTI_PATTERNS_BLOCK = `Source : Google AI Optimization Guide (officiel, publié 2026-05-15).
URL : https://developers.google.com/search/docs/fundamentals/ai-optimization-guide

⛔ **JAMAIS proposer ces fixes** — Google les liste explicitement comme INUTILES pour la GenAI Search (AI Overviews, AI Mode) :

1. **\`llms.txt\` ou autres "fichiers spéciaux AI"** : aucun fichier markdown / AI-text / markup spécial n'est lu différemment par Google. Si tu vois "ajouter un llms.txt" comme suggestion, REJETTE-LA.

2. **"Chunking" / micro-pages** : ne propose JAMAIS de découper un sujet en N micro-pages pour "mieux nourrir les LLM". Google comprend les pages longues, et la prolifération artificielle viole le **scaled content abuse spam policy** (= risque de pénalité).

3. **Réécriture pour "AI-friendly style"** : pas de jargon style "écris pour les LLM, ajoute des phrases concises courtes". Les systèmes Google comprennent les synonymes et l'intent — un contenu bien écrit pour les humains suffit. Pas de keyword stuffing variantes longue-traîne sous prétexte de "fan-out queries".

4. **Mentions inauthentiques / link spam** : ne propose JAMAIS d'acheter des mentions, faux avis, posts de forums orchestrés. C'est filtré par les anti-spam systems Google et inutile pour la GenAI Search.

5. **Over-focus structured data comme silver bullet** : le schema JSON-LD n'est PAS requis pour apparaître en GenAI Search. Reste utile pour les rich results classiques, mais ne le propose JAMAIS comme top action ROI. Préfère title/meta/content/internal_links si la page en a besoin.

Règle de validation : avant chaque fix que tu proposes, demande-toi "Google demanderait-il qu'on fasse ça pour mieux servir l'utilisateur, ou est-ce de l'optimisation pour la machine ?" Si c'est le second cas, rejette.`;

export const GOOGLE_NON_COMMODITY_PRINCIPLE_BLOCK = `Source : Google AI Optimization Guide (officiel, publié 2026-05-15).
URL : https://developers.google.com/search/docs/fundamentals/ai-optimization-guide#create-valuable-content

🎯 **Le levier #1 pour la GenAI Search selon Google : créer du contenu NON-COMMODITY avec un POINT DE VUE UNIQUE.**

Définition Google :
- **Commodity content** = ce qui pourrait être produit par n'importe quel LLM à partir des sources existantes. Exemple cité : *"7 Tips for First-Time Homebuyers"*. Personne ne se démarque, tout le monde a la même chose.
- **Non-commodity content** = expérience expert/first-hand qui va au-delà du sens commun. Exemple cité : *"Why We Waived the Inspection & Saved Money: A Look Inside the Sewer Line"*. Un POV unique, un cas réel, une décision argumentée.

**Pour ce cabinet d'avocats pénaliste** : la différence se joue sur :
- Des CAS RÉELS de plaidoiries (avec accord client, anonymisé) — pas seulement "voici la procédure"
- Des RÉSULTATS chiffrés (acquittement, peine ramenée, nullité obtenue)
- L'angle EXPERTISE TERRITORIALE (Bordeaux, juridictions locales) que Légifrance / service-public.gouv.fr ne peuvent PAS avoir
- Un ANGLE DE DÉFENSE explicite ("voici la stratégie que j'utilise dans ce type d'affaire") au lieu d'un guide neutre informationnel

**Quand tu écris \`structural_gaps\` ou \`unique_pov_assessment\` :**
- Si le top 3 SERP est dominé par des sources institutionnelles (.gouv, Wikipedia, Légifrance, Dalloz) ET que la page Plouton est elle aussi en mode neutre informationnel → c'est de la **commodity** = handicap structurel majeur. La page ne peut pas battre ces autorités sur leur propre terrain. Le levier = NON-COMMODITY (cas concret, angle avocat).
- Si la page contient déjà un cas, une plaidoirie, un résultat → c'est un ATOUT à amplifier (titres / intro / schema PracticeArea).
- Si tu vois un fix \`content_addition\` qui ressemble à "ajouter une section sur la procédure XYZ" sans angle expert/cas → c'est encore de la commodity. Préfère "ajouter un encart 'Cas réel : affaire ABC, peine ramenée de X à Y'".`;
