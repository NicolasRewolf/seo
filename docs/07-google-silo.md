# 07 — Le silo Google Search Central guidance

Sources publiques Google que le LLM consulte directement, en silo strict (pas mélangé aux signaux page-data).

## Pourquoi un silo

Les croyances SEO du LLM viennent de :
1. Son training data (figé pré-2026)
2. Les datas qu'on lui ingère (GSC, Cooked, SERP, DOM)

Sans Sprint 19, il rate les évolutions Google récentes (nouvelles spam policies, core updates, retraits de systèmes). Le silo Google colmate cette fuite **sans perturber** son raisonnement page-data : c'est lu comme un signal externe d'autorité.

## Les 6 sources qui composent le silo

| # | Source | Format | Refresh | Ce qu'on en tire |
|---|---|---|---|---|
| 1 | [Search Central Blog](https://developers.google.com/search/blog) | RSS 2.0 | Cache 1h | Annonces officielles 90j (filtrées pivot keywords) |
| 2 | [Search Status Dashboard](https://status.search.google.com/) | JSON | Cache 1h | Updates actives + ranking-system updates 60j |
| 3 | Top 2 posts pivot deep-fetched | HTML scrape | Cache 1h | 1200 chars de body au lieu du 220-char summary RSS |
| 4 | [Ranking Systems guide](https://developers.google.com/search/docs/appearance/ranking-systems-guide) | HTML scrape | Cache 1h | 17 systèmes nommés actifs (BERT, MUM, Reviews, Reliable Information, etc.) |
| 5 | [Spam Policies](https://developers.google.com/search/docs/essentials/spam-policies) | HTML scrape | Cache 1h | 17 policies enumerees (Cloaking, Scaled Content Abuse, etc.) |
| 6 | **[AI Optimization Guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)** (Sprint-23) | Static text | Constante | Anti-patterns AEO/GEO + pillar #1 "non-commodity content" |

Sources 1-5 vivent dans **`src/lib/google-search-central.ts`** (fetched at prompt build time).
Source 6 vit dans **`src/prompts/google-genai-guide.ts`** — c'est du texte statique parce que Google publie ce guide comme référence stable (pas un flux qui change chaque semaine). On bump quand Google met à jour le guide.

---

## Source 1 : Search Central Blog (RSS)

### Endpoint
`https://developers.google.com/search/blog/feed.xml` (RSS 2.0)

### Filtrage "pivot"
Garde uniquement les posts dont le titre OU le résumé matche AU MOINS 1 des ~25 patterns pivot :

```ts
// src/lib/google-search-central.ts:PIVOT_PATTERNS
[
  /\bcore update\b/i,
  /\bspam update\b/i,
  /\bspam polic/i,
  /\bhelpful content\b/i,
  /\branking system/i,
  /\bEEAT\b|E-?E-?A-?T/i,
  /\bYMYL\b/i,
  /\bAI(?:-| )(?:generated|content|overview)\b/i,
  /\bcore web vital/i,
  /\bINP\b|interaction to next paint/i,
  /\bschema(?:\.org)?\b/i,
  /\bstructured data\b/i,
  /\bcrawl(?:ing|er|ed)?\b/i,
  /\bindex(?:ing|er|ed|ation)?\b/i,
  /\bsitemap/i,
  /\bfeatured snippet/i,
  /\bcanonical/i,
  /\bhreflang\b/i,
  // ... 25 total
]
```

**Exclus implicitement** : posts d'événements ("Search Central Live à Shanghai"), holidays wishes, mineurs.

### Exemple de capture (state au 10 mai 2026)
- ✅ "Introducing a new spam policy for 'back button hijacking'" (avril 2026, pivot match `spam policy`)
- ✅ "Inside Googlebot: demystifying crawling, fetching, and the bytes we process" (mars 2026, pivot match `crawl`)
- ❌ "Search Central Live is Coming to Shanghai in 2026!" (pas pivot)
- ❌ "Search Central Live Asia Pacific 2026" (pas pivot)

### Cap
Top 8 max après filtrage (par recency desc). Évite de gonfler le prompt si Google publie 20 posts pivot d'un coup.

---

## Source 2 : Search Status Dashboard (JSON)

### Endpoint
`https://status.search.google.com/incidents.json`

### Filtrage
Garde :
- **Tout incident actuellement en cours** (pas de `end` date)
- **Updates ranking-system terminées dans les 60 derniers jours** (core/spam/helpful content)

Exclut les "transient ops issues" (e.g., "Serving was experiencing an issue") qui ne sont pas pertinents pour le diag SEO.

### Classification

```ts
// src/lib/google-search-central.ts:classifyIncident()
{
  /\bspam update\b/  → 'spam_update',
  /\bcore update\b/  → 'core_update',
  /\bhelpful content\b/ → 'helpful_content_update',
  default            → 'other'  // filtered out unless active
}
```

### Exemple de capture (state au 10 mai 2026)
- 0 incident actif (pas de core/spam update en cours)
- ✅ "March 2026 core update" (terminée 2026-04-08, ~30j)
- ✅ "March 2026 spam update" (terminée 2026-03-25, ~45j)

---

## Source 3 : Deep-fetch des top 2 posts pivot (Sprint 19.5)

### Quoi
Pour les 2 posts les plus pivot (top 2 par recency dans le résultat filtré), on fetche le HTML complet de la page (pas seulement le résumé RSS), puis on extract le body via cheerio (strip header/footer/sidebar) et truncate à 1200 chars.

### Pourquoi
Le résumé RSS fait 220 chars max — c'est suffisant pour identifier le sujet mais pas pour exploiter les détails actionnables (chiffres bytes-budget Googlebot, recommandations exactes EEAT, etc.). Le deep-fetch capture ces détails.

### Coût
2 GET HTTPS supplémentaires + cheerio parsing. Latence : ~500ms total. Cache 1h.

---

## Source 4 : Ranking Systems guide (HTML scrape)

### Endpoint
`https://developers.google.com/search/docs/appearance/ranking-systems-guide?hl=en`

`?hl=en` + `Accept-Language: en` headers FORCÉS — sinon Google sert un mix multilingue (Hindi, French H2 sections concaténées) qui pollue le prompt. Bug détecté pendant Sprint 19.5 e2e et fixé.

### Parsing
`parseH2Sections(html, excludeAfterH2Id='retired-systems')` :
- Itère sur tous les `<h2 id="...">` 
- Pour chaque section, gather les `<p>` enfants jusqu'au prochain h2
- Truncate description à 300 chars
- **Stop le parsing au H2 `id="retired-systems"`** pour ne capturer que les systèmes actifs (Hummingbird, Panda, Penguin, Helpful Content System now-in-core sont historique)

### Output (17 systèmes actifs)

```
- BERT
- Crisis information systems
- Deduplication systems
- Exact match domain system
- Freshness systems
- Link analysis systems and PageRank
- Local news systems
- MUM
- Neural matching
- Original content systems
- Removal-based demotion systems
- Passage ranking system
- RankBrain
- Reliable information systems
- Reviews system
- Site diversity system
- Spam detection systems
```

Helpful Content System **NOT** listed (intégré au core ranking en March 2024 selon Google — beaucoup de SEO consultants en parlent encore comme système séparé, faux).

---

## Source 5 : Spam Policies (HTML scrape)

### Endpoint
`https://developers.google.com/search/docs/essentials/spam-policies?hl=en`

### Parsing
`parseH2Sections(html)` (pas d'exclude — toute la page est "current state").

Filtre `description.length >= 50` pour drop les H2 de wrapper (genre "Our policies" intro).

### Output (17 policies enumerees)

```
- Cloaking
- Doorway abuse
- Expired domain abuse
- Hacked content
- Hidden text and link abuse
- Keyword stuffing
- Link spam
- Machine-generated traffic
- Malicious practices       ← inclut "back button hijacking" (avril 2026)
- Misleading functionality
- Scaled content abuse      ← AI content sans valeur
- Scraping
- Site reputation abuse     ← nouvelle 2024
- Sneaky redirects
- Thin affiliation
- (+ Legal removals, Personal information removals, Policy circumvention, Scam and fraud — non capturés si description courte)
```

---

## Source 6 : AI Optimization Guide (Sprint-23, static)

### URL
[`https://developers.google.com/search/docs/fundamentals/ai-optimization-guide`](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) — publié 2026-05-15.

### Format
Texte statique en TypeScript dans **`src/prompts/google-genai-guide.ts`**, pas de fetch live (contrairement aux 5 autres sources). Raison : ce guide est une référence Google stable qui change rarement. Quand Google met à jour, on bump le contenu des constantes.

### 2 constantes exportées

**`GOOGLE_GENAI_ANTI_PATTERNS_BLOCK`** — wrapped dans `<google_genai_anti_patterns>` dans le prompt diagnostic **ET** le prompt fix-gen.

Liste les 5 "hacks" AEO/GEO que Google déclare officiellement INUTILES :
- `llms.txt` / fichiers spéciaux AI
- Chunking artificiel / micro-pages
- Réécriture "AI-friendly style"
- Mentions inauthentiques / link spam
- Over-focus structured data comme silver bullet

Locker : le LLM ne doit JAMAIS proposer ces fixes. Avant Sprint-23, rien dans le prompt ne l'en empêchait explicitement.

**`GOOGLE_NON_COMMODITY_PRINCIPLE_BLOCK`** — wrapped dans `<google_non_commodity_principle>` dans le prompt diagnostic + fix-gen.

Frame le pillar #1 de Google pour GenAI Search : **non-commodity content avec POV unique gagne sur RAG retrieval**. Exemples Google verbatim (commodity "7 Tips for First-Time Homebuyers" vs non-commodity "Why We Waived the Inspection & Saved Money"). Pour Plouton : cas anonymisés, plaidoiries, résultats chiffrés, angle territorial Bordeaux.

### Nouveau champ diagnostic : `unique_pov_assessment`

Ajouté au schema Zod `DiagnosticPayload` (Sprint-23). Le LLM doit explicitement classer la page comme COMMODITY ou NON-COMMODITY et recommander un type de contenu différenciant si commodity. Pin par 4 assertions dans le golden case `premeditation-commodity` (cf. [doc 11](./11-eval.md)).

### Down-grade du fix_type `schema`

Sprint-23 a aussi modifié le prompt fix-gen pour que `schema` soit **dernier recours** — Google a explicitement dit que structured data n'est PAS requis pour GenAI Search. À ne plus jamais proposer comme top action ROI quand title/meta/intro/content sont aussi en jeu.

---

## Le bloc XML `<google_recent_guidance>` dans le prompt

Placé **EN HAUT** du prompt diagnostic v11 (avant tous les blocs page-data) car c'est du context-setting global.

### Layout rendered

```markdown
<google_recent_guidance>
Sprint 19+19.5 — SILO de "ce que Google dit / a publié officiellement". 5 sources : ...
Lis ce bloc UNIQUEMENT comme regard EXTERNE / autorité Google. Ne le mélange pas avec tes signaux page-data des autres blocs. Règles strictes :

1. Si une core update / spam update / helpful content update est ACTIVE, mentionne-la dans `tldr` et ouvre `engagement_diagnosis` ou `hypothesis` par un caveat temporel : "les rankings peuvent bouger ces prochaines semaines indépendamment des fixes proposés".

2. Si une guidance récente CONTREDIT ou NUANCE un conseil que tu allais donner sur ta seule formation, défère à Google : ajuste ton conseil et MENTIONNE EXPLICITEMENT la source ("Per Google Search Central [titre du post du DATE], ...").

3. Si une guidance récente RENFORCE un conseil que tu allais déjà donner, c'est une validation utile : tu peux la citer pour appuyer la priorité.

4. Si tu peux nommer un SYSTÈME DE RANKING précis affecté par la page (ex: Original Content Systems pour un article de presse, Reviews System pour une page review, Reliable Information Systems pour du contenu YMYL juridique), CITE-LE PAR SON NOM EXACT depuis la référence ci-dessous. Évite "Helpful Content Update" (intégré au core 2024).

5. Si la page risque de matcher une SPAM POLICY (Scaled Content Abuse pour AI sans valeur, Site Reputation Abuse pour third-party content, Hidden Text Abuse, Sneaky Redirects, Cloaking…), FLAGUE-LE explicitement dans `structural_gaps` ou `hypothesis` en citant le nom officiel de la policy.

6. Si rien dans ce bloc n'est pertinent au diag, IGNORE-le complètement — ne l'évoque pas, ne fais pas de référence creuse.

7. N'invente jamais une guidance Google qui n'est pas dans ce bloc. Si tu veux référencer une best practice Google, elle DOIT venir de ce bloc ou d'une connaissance fondamentale (PageRank, EEAT framework général). Pas de hallucination de "Google a dit récemment X".

## ⚠ Updates Google EN COURS (Search Status Dashboard)
[liste des incidents actifs avec emoji 🔴]

## Updates Google récentes terminées (60j)
[liste des updates ranking-system terminées avec emoji ✅]

## Guidance Google Search Central récente (90j, filtre pivot)
- **2026-04-13** (il y a 27j) — [Introducing a new spam policy for "back button hijacking"](https://...)
  > Today, we are expanding our spam policies to address...
  > _Full text (Sprint 19.5 deep-fetch) :_ [1200 chars du body HTML extrait]
- **2026-03-31** (il y a 40j) — [Inside Googlebot: demystifying crawling...](https://...)
  > If you tuned into episode 105...

## Système de ranking nommés Google (référence officielle, cite-les par leur NOM EXACT)
- **BERT** : Understands word combinations, intent...
- **Reviews System** : Rewards high-quality reviews...
- (... 17 entries)

## Spam Policies Google (référence officielle, cite-les par leur NOM EXACT si tu détectes le pattern)
- **Cloaking** : Presenting different content to users...
- **Scaled content abuse** : Generating many pages with little original value...
- (... 17 entries)
</google_recent_guidance>
```

---

## Le résultat observé sur la cobaye #33

E2E Sprint 19.5 (10 mai 2026) :

> **structural_gaps** : *"Trois manques majeurs : (1) Schema JSON-LD totalement absent — sur YMYL juridique c'est un manque E-E-A-T critique, ajouter Article + FAQPage + LegalService pour appuyer les **Reliable Information Systems** de Google. (2) Byline auteur ABSENT (Maître Plouton non cité dans l'auteur structuré) — pénalisant sur YMYL, à fixer en priorité. (3) ⚠️ Body contient plusieurs paragraphes dupliqués (chaque puce listée 2 fois consécutivement — 'En cas d'interpellation dans la rue', 'En cas de contrôle routier', etc.) qui risquent de matcher le pattern **Scaled content abuse** et de dégrader le signal qualité post-March 2026 core update, **À NETTOYER EN URGENCE**."*

5 things happened ici :
1. ✅ Le LLM a inspecté le `content_snapshot` (page body)
2. ✅ Reconnu un pattern (puces dupliquées)
3. ✅ Cité PAR SON NOM OFFICIEL la spam policy Google qui couvre ce risque (règle 5 du silo)
4. ✅ Lié à l'update temporelle qui en augmente l'impact (règle 1 du silo, partiellement — mention "post-March 2026 core update")
5. ✅ Cité un ranking system par son nom (règle 4 du silo : "Reliable Information Systems")

C'est exactement le type d'analyse causale cross-source visé.

---

## Caching

Module-level cache, **TTL 1h** :

```ts
let cached: { value: GoogleSearchGuidance; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;
```

Pour un batch de 17 findings, on paie **1 seul fetch** (au premier diag), tous les autres lisent le cache. Reset manuel possible via `_resetCacheForTests()`.

---

## Coût

| Item | Coût |
|---|---|
| RSS feed | gratuit |
| Status Dashboard | gratuit |
| HTML scrapes (3 pages) | gratuit |
| LLM input tokens (~3700 tokens addés au prompt) | ~$0.018/diag × 17 findings × 2 LLMs (diag+fix-gen) = **~$0.61/audit complet** |

Trivial vs le saut qualitatif.

---

## Limites connues

- **Pas de Quality Rater Guidelines PDF** — versionné mais manuel à parser, hors scope
- **Pas de Web Vitals fetch** — déjà hardcodé et stable (LCP 2500/4000ms, INP 200/500, CLS 0.1/0.25)
- **Pas de fact-check pattern dédié** pour les claims "Google a dit X" — la règle 7 du silo + le retry-once devraient suffire. À reconsidérer si on observe une hallucination Google dans le wild.
- **Cache 1h fixe** — à raccourcir si Google annonce une core update et qu'on veut le voir tout de suite (`_resetCacheForTests()` accessible)
- **Pas de smart relevance filter** — toutes les 17 ranking systems + 17 spam policies sont incluses dans CHAQUE prompt. C'est intentionnel : le LLM choisit lui-même celles pertinentes au diag (cf. règle 6 du silo : "ignore si rien pertinent")
- **`?hl=en` forced** — la doc Google sert du mix multilingue sans ce param. Documenté dans le code.

---

## Comment ajouter une nouvelle source Google

Exemple : on veut ajouter le Web Stories doc.

1. Add un fetcher dans `src/lib/google-search-central.ts` (mirror du pattern existant)
2. Ajout au type `GoogleSearchGuidance`
3. Ajout au `Promise.all` de `fetchGoogleGuidance()`
4. Update `fmtGoogleRecentGuidance()` dans `src/prompts/diagnostic.v1.ts` pour rendre la nouvelle section
5. Bump `DIAGNOSTIC_PROMPT_VERSION`
6. Update test fixtures dans `src/scripts/test-google-guidance.ts`
7. Run smoke + e2e cobaye #33

Idem pour ajouter une nouvelle source Bing / DuckDuckGo / Yandex si jamais ça devient pertinent.
