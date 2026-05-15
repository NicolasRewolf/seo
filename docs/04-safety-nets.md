# 04 — Les safety nets

Tout ce qui empêche l'outil de produire un diagnostic faux ou actionnable de façon dangereuse. **8 mécanismes** indépendants.

## Les 8 garde-fous

| # | Safety net | Empêche quoi | Code |
|---|---|---|---|
| 1 | **Zod schema validation** | LLM produit du JSON malformé qui pollue la DB | `src/pipeline/diagnose.ts:34` (DiagnosticSchema), `src/pipeline/generate-fixes.ts` (fixes schema), `src/pipeline/create-issues.ts` (re-parse) |
| 2 | **Fact-checker** | LLM hallucine un chiffre (word count, pogo rate, evenness, mobile CTA rate) | `src/lib/diagnostic-fact-check.ts` |
| 3 | **Retry-once corrective** | Le diag passe avec des chiffres faux (donne au LLM 1 chance de se corriger) | `src/pipeline/diagnose.ts:diagnoseFinding()` |
| 4 | **Capture rate guard** | LLM lit les chiffres Cooked en absolu alors que le tracker en capture <50% | `src/prompts/diagnostic.v1.ts:fmtDataQualityCheck()` + bannière `[!WARNING]` dans issue |
| 5 | **NavBoost CAUTION banner** | Page avec pogo dérouté reste sans visibilité dans le body de l'issue | `src/prompts/issue-template.ts:fmtPogoBanner()` |
| 6 | **Mobile-first CAUTION banner** | Conversion mobile en chute non visible | `src/prompts/issue-template.ts:fmtMobileFirstBanner()` |
| 7 | **Treatment vs control assignment** | On dit "le fix marche" sans contre-factuel | `src/pipeline/compute-findings.ts` (50/50 split) + bannière control dans issue |
| 8 | **Source attribution** | L'humain reviewe sans savoir d'où vient chaque chiffre | `src/prompts/issue-template.ts:fmtSource()` (`<sub>(GSC · Cooked)</sub>` partout) |

Plus le **silo Google** (Sprint 19/19.5) qui a son propre garde-fou : 7 règles silo strictes empêchant le LLM de hallucination Google. Cf. [07-google-silo.md](./07-google-silo.md).

---

## 1. Zod schema validation

### Quoi
Tous les payloads reçus du LLM passent par un schema Zod avant d'atterrir en DB. Si le LLM envoie du JSON manquant un champ ou avec un type faux, l'exception est levée immédiatement.

### Pourquoi
Sans Zod : un champ manquant crash le rendering downstream avec un cryptic `undefined.length is not a function` 4 étapes plus loin. Avec Zod : exception explicite à la frontière LLM/DB.

### Comment
```ts
// src/pipeline/diagnose.ts
const DiagnosticSchema = z.object({
  tldr: z.string().optional().default(''),
  intent_mismatch: z.string(),
  snippet_weakness: z.string(),
  hypothesis: z.string(),
  // ... 13 champs total
  pogo_navboost_assessment: z.string().optional().default(''),
  engagement_pattern_assessment: z.string().optional().default(''),
});

const diagnostic = DiagnosticSchema.parse(parsedJson);  // throw if invalid
```

Tous les champs nouveaux sont **`.optional().default('')`** pour rester compatible avec les diagnostics persistés en DB depuis les versions antérieures du prompt.

### Limites
- Zod ne valide que la **structure** (types + champs présents). Il ne valide pas le **contenu** (un `tldr` peut être valide structurellement mais creux). C'est ce que fait le fact-checker.

---

## 2. Fact-checker

### Quoi
Avant de persister un diagnostic, scanne tous les champs prose pour les claims numériques et vérifie chaque chiffre cité contre les sources réelles.

### Pourquoi
Le LLM peut produire des chiffres "cohérents-mais-faux" — ex: "evenness 0.85" alors que la valeur réelle est 0.07. Le fact-checker détecte ça.

### Comment

```ts
// src/lib/diagnostic-fact-check.ts
factCheckDiagnostic({
  diagnostic,                  // le JSON LLM
  content_snapshot,            // pour word_count, H2 count, images, sans alt
  pogo: PogoFacts,             // pour pogo_rate, n=, hard_pogo
  sprint16: Sprint16Facts,     // pour evenness, p25/median/p75, mobile/desktop CTA rate
})
→ {
  total_numeric_claims: number,
  verified: number,
  unverified: Array<{ claim, field, expected_in, note }>,
  passed: boolean,  // true if 0 unverified
}
```

### Patterns vérifiés (par catégorie)

| Catégorie | Pattern | Source vérité | Tolérance |
|---|---|---|---|
| Word count | `"X mots"` patterns (article fait X mots, page de X mots, X mots au total) | `content_snapshot.word_count` | ±5% |
| H2 reference | `"H2 #N"` | `content_snapshot.outline.filter(level=2).length` | exact |
| Image count | `"X images"` | `content_snapshot.images.length` (in_body OR total) | exact |
| Sans alt | `"X sans alt"` | `content_snapshot.images.filter(in_body && !alt).length` | exact |
| Pogo n= | `"\bn=N"` (avec context Google/pogo dans 60 chars) | `pogo.google_sessions` | ±2 |
| Pogo google sessions | `"X google_sessions"` ou `"X sessions Google"` | `pogo.google_sessions` | ±2 |
| Pogo sticks | `"X pogo"` (pas hard pogo) | `pogo.pogo_sticks` | exact |
| Hard pogo | `"X hard pogo"` | `pogo.hard_pogo` | exact |
| Pogo rate | `"pogo X%"` (avec context pogo) | `pogo.pogo_rate_pct` | ±0.5pp |
| Evenness | `"evenness 0.07"` | `sprint16.density_evenness_score` | ±0.05 |
| Dwell percentiles | `"p25=7s"`, `"p75=103s"`, `"median=41s"` | `sprint16.density_dwell_p25/p75/median` | ±1s |
| Mobile CTA rate | `"mobile X%"` (avec context CTA/convert/rate dans la même phrase + sans `scroll/share/split/trafic/audience` dans le gap) | `sprint16.cta_rate_mobile_pct` | ±0.5pp |
| Desktop CTA rate | idem | `sprint16.cta_rate_desktop_pct` | ±0.5pp |

### Pourquoi ces patterns ET PAS d'autres

- **Word offset claims** intentionnellement NON validés. Le LLM utilise les offsets en deux usages : (a) citation d'une H2 existante (verifiable), (b) recommandation d'insertion (pas verifiable car nouvel offset). Distinguer (a) de (b) au regex est trop brittle.
- **Sentence-boundary check** sur les CTA per device : les false positives mobiles "Mobile 80% du trafic" (audience share) étaient catastrophiques avant Sprint 17. Le fix : restreindre le context check à la LOCAL SENTENCE (split sur `. ! ? : \n`).
- **Negative keywords gap** sur les CTA per device : "mobile + scroll_avg 24.4%" → 24.4% appartient au scroll, pas au CTA. Reject si gap contient `scroll|share|split|trafic|audience|sessions`.

### Tests

29 tests dans `src/scripts/test-diagnostic-fact-check.ts`. Couvrent :
- Verified cases (claim trace correctement)
- Unverified cases (hallucination détectée)
- Format français des nombres ("1 800 mots")
- Sentence-length / reading-speed mentions ignorées (false positive prevention)
- Sprint-17 regression tests pour les 3 false positives observés sur #33

### Limites
- Si le LLM cite un chiffre dans un format inattendu (ex: "huit cent mots" en lettres), le pattern ne matche pas → ratée
- Si la source vérité elle-même est null (ex: page sans Google sessions), les claims pogo sont marquées "facts not available", pas wrong (n'augmente pas le retry trigger inutilement)
- Pas de validation cross-source (ex: si diag dit "evenness 0.5" et "p25=8s, p75=100s" → mathematiquement evenness devrait être 0.08, pas 0.5 ; non vérifié)

---

## 3. Retry-once corrective

### Quoi
Si le fact-checker détecte ≥1 chiffre unverified, le diag prompt est ré-appelé avec un message correctif listant les claims faux et demandant au LLM de produire un diag corrigé.

### Pourquoi
Sans retry : un diag avec hallucinations passerait directement à la persist. Avec retry-once : le LLM a 1 chance de se corriger. En pratique ~30-50% des retries produisent un diag clean.

### Comment

```ts
// src/pipeline/diagnose.ts:diagnoseFinding()
let diagnostic = await callDiagnosticLLM(prompt);
let factCheck = factCheckDiagnostic({ diagnostic, ... });

if (!factCheck.passed && (cs || pogoFacts || sprint16Facts)) {
  const retryMsg = buildRetryMessage(factCheck.unverified);
  // → "Ton diagnostic précédent contient des chiffres qui ne tracent pas vers
  //    les blocs sources fournis (<page_body>, <page_outline>, <images>,
  //    <cta_in_body_positions>, <pogo_navboost>, <engagement_density>,
  //    <cta_per_device>).
  //    Claims à corriger :
  //    1. Champ `engagement_pattern_assessment` — claim 'evenness 0.85' — claimed 0.85, actual 0.07
  //    ..."
  
  diagnostic = await callDiagnosticLLM(prompt, [
    { role: 'assistant', content: JSON.stringify(diagnostic) },
    { role: 'user', content: retryMsg },
  ]);
  factCheck = factCheckDiagnostic({ diagnostic, ... });
  factCheck.retry_attempted = true;
}
```

### Persistence
Le résultat final (diag + fact-check) est persisté quoi qu'il arrive. Le `diagnostic_fact_check` JSONB contient `{ total, verified, unverified[], passed, retry_attempted }` — auditable per-finding.

### Limites
- Pas de retry-many. Si la 2ème pass produit encore des unverified, on garde quand même (mieux qu'aucun diag).
- Coût : un retry = ~1 diag de plus (~$0.20)

---

## 4. Capture rate guard

### Quoi
Si Cooked capture <50% des sessions GSC sur la page, une bannière `[!WARNING]` s'affiche dans le body de l'issue ET le LLM est instruit de lire les chiffres Cooked en RELATIF, pas en absolu.

### Pourquoi
Cooked est first-party non-échantillonné, mais (a) live depuis 5 mai 2026 → bootstrap, (b) ~10% des sessions n'ont pas le tracker chargé (adblockers, JS désactivé). Si on présente "0 phone clicks" comme un fait alors qu'on n'a tracké que 30% du trafic, l'humain prend une mauvaise décision.

### Comment
```ts
// src/prompts/diagnostic.v1.ts:fmtDataQualityCheck()
captureRate = cookedSessions28d / gscClicks28d * 100
// Pro-rated par tracker_first_seen_global() pendant le bootstrap

if (captureRate < 50) {
  // Bloc <data_quality_check> avec verdict "low_capture"
  // → instruction au LLM : "préfixe ta lecture par 'sous réserve de capture rate insuffisant'
  //    et reste en relatif/qualitatif, jamais en absolu"
}
```

```ts
// src/prompts/issue-template.ts:renderIssueBody()
if (capture_rate_pct < 50) {
  // Banner [!WARNING] dans le body
  // → "Data quality — Cooked capture rate X%. Lis les chiffres Cooked
  //    comme un lower bound, pas comme des absolus."
}
```

### Limites
- Le seuil 50% est arbitraire. Pourrait être 75% pour être plus strict.
- Pas de fact-check sur les claims qualitatives produites quand le capture rate est bas.

---

## 5. NavBoost CAUTION banner (Sprint 15)

### Quoi
Si `pogo_rate_28d > 20%` AND `google_sessions_28d ≥ 30`, une bannière `[!CAUTION]` s'affiche dans le body de l'issue ET le LLM met le pogo en hypothèse #1.

### Pourquoi
Le pogo-sticking (visiteur arrive de Google, 1 page, repart en <10s) est le signal NavBoost négatif le plus fort. Si Google déroute la page, c'est urgent et c'est probablement la cause #1 d'une chute de position. Sans cette bannière, l'humain peut focaliser sur le snippet alors que le vrai problème est l'intent satisfaction.

### Comment
- Cooked publie `pogo_rate_28d` dans le snapshot
- Le diag prompt v8+ a un bloc `<pogo_navboost>` que le LLM lit
- Si `pogo_rate > 20%` AND `n_google >= 30` → bannière déclenchée dans le rendering issue

### Limites
- Seuils 20% / n=30 hardcoded. Ajustables dans `src/prompts/issue-template.ts:fmtPogoBanner()`.
- Pas de comparaison "ta pogo vs la médiane site" — juste un seuil absolu.

---

## 6. Mobile-first CAUTION banner (Sprint 16)

### Quoi
Si `cta_rate_mobile / cta_rate_desktop < 0.25` AND `mobile_sessions_28d ≥ 30` AND `cta_rate_desktop > 0`, une bannière `[!CAUTION]` "Mobile-first urgent" s'affiche.

### Pourquoi
Détecte les pages où le mobile bleed (le trafic mobile arrive mais ne convertit pas, contrairement au desktop). Symptôme classique : CTA in-body absente sur viewport mobile, formulaire trop long, bouton sous le fold. Sans cette bannière, l'humain ne voit pas le pattern car le CTR moyen est dilué.

### Comment
- Cooked publie `cta_rate_mobile_28d` + `cta_rate_desktop_28d` + `mobile_sessions_28d` + `desktop_sessions_28d` dans le snapshot
- Le diag prompt v9+ a un bloc `<cta_per_device>` que le LLM lit
- Le rendering issue applique les 3 conditions (ratio < 0.25 + n_mobile ≥ 30 + cta_rate_desktop > 0)

### Limites
- 3 conditions cumulatives → la bannière ne se déclenche pas si la page n'a pas du tout de CTA in-body (cas des articles purement informationnels, qui sont LA majorité des findings actuellement). Acceptable : ces pages n'ont pas de mobile-first issue à signaler.

---

## 7. Treatment vs control assignment

### Quoi
À la création des findings (étape `audit`), 50% sont random-assignés au groupe `control`. Une bannière `[!CAUTION]` "Groupe contrôle — ne pas appliquer pendant 4 semaines" s'affiche dans le body de l'issue.

### Pourquoi
Sans contre-factuel, on ne peut pas dire "le fix a amélioré le CTR". Les pages control servent de baseline : si le control voit aussi un mouvement de CTR/position pendant la fenêtre T+30, c'est l'algo Google qui a bougé, pas notre fix.

### Comment
```ts
// src/pipeline/compute-findings.ts
const isControl = Math.random() < 0.5;
const group = isControl ? 'control' : 'treatment';

// Persisté dans audit_findings.group_assignment
```

```ts
// src/prompts/issue-template.ts
if (group === 'control') {
  // Banner [!CAUTION] "Groupe contrôle — ne pas appliquer pendant 4 semaines"
}
```

### Limites
- Random pas stratifié (pas de pairing par traffic ou intent type). Pour 17 findings c'est OK ; sur 100+ findings on devrait stratifier.
- Si Nicolas applique un fix sur un control par accident → la mesure est polluée. Aucune protection technique (juste la bannière visuelle).

---

## 8. Source attribution

### Quoi
Chaque cellule de la metrics box et chaque diag bullet est trailé par `<sub>_(SourceA · SourceB)_</sub>`.

### Pourquoi
L'humain qui reviewe doit savoir D'OÙ vient chaque chiffre. Sans attribution, on ne peut pas savoir si "pogo 9.6%" vient de Cooked ou si le LLM l'a inventé.

### Comment
```ts
// src/prompts/issue-template.ts
function fmtSource(...sources: string[]): string {
  return ` <sub>_(${sources.join(' · ')})_</sub>`;
}

// Usage :
`| Position moyenne | ${i.avg_position.toFixed(1)} (drift ${...})${fmtSource('GSC')} |`,
fmtDiagBullet('Pogo / NavBoost', i.diagnostic.pogo_navboost_assessment, 'Cooked google_sessions_28d', 'Cooked pogo_rate_28d'),
```

### Convention
- `GSC` = Google Search Console
- `Cooked` ou `Cooked X_28d` = nom de la col Cooked
- `DataForSEO` ou `DataForSEO SOV` = SOV est computée side, mais l'input est DataForSEO
- `DOM scrape` = extracteur Cheerio
- `LLM` = inférence pure (rare — pour les conclusions causales du diag)
- `SEO calc` = formule appliquée (CTR benchmark interpolé, capture rate)
- `Catalogue` = site catalog hardcoded

---

## Comment tester un safety net

```bash
npm test                             # 155 tests, dont 29 fact-check + 50 issue-template + 14 data-quality
npm run test:fact-check              # juste fact-checker
npm run test:issue-template          # juste rendu (banners, layout)
npm run test:data-quality            # juste capture rate calculation
```

Si tu modifies un safety net :
1. Ajoute un test de régression pour le bug que tu fixe
2. Run tous les tests existants pour vérifier que tu ne casses pas les autres
3. Run l'e2e sur la cobaye #33 (cf. [10-operational.md](./10-operational.md))
