# 09 — Tests

3 niveaux de tests :
1. **Tests unitaires** (155 tests, < 1s) — pur fonction, pas de DB ni d'HTTP
2. **Smoke tests** (8 connecteurs) — ping live API, < 10s total
3. **End-to-end** (manuel) — diag complet sur la cobaye #33

## Tests unitaires

### Suites disponibles

```bash
npm test                          # all (155 tests)

npm run test:scoring              # 14 — formules de scoring + seuils CWV
npm run test:issue-template       # 50 — rendu markdown + alerts + Sprint 13-19 features
npm run test:data-quality         # 14 — capture rate + bootstrap pro-rating
npm run test:content-extractor    # 11 — Sprint 14 Cheerio extractor
npm run test:fact-check           # 29 — fact-checker patterns + Sprint 17 regressions
npm run test:serp                 # 11 — Sprint 18 SERP helpers (diag + fix-gen)
npm run test:google               # 18 — Sprint 19+19.5 Google guidance (parsing + render)
```

### Convention

- Tests vivent dans `src/scripts/test-*.ts`
- Utilise `node:test` natif (pas Jest) — pas de framework lourd
- Pas de mock HTTP : on teste les **pure functions** (helpers de rendering, parsers, patterns regex)
- Pour les fetch live (Cooked, DataForSEO, Wix) → smoke test
- Pour le bout-en-bout LLM → e2e manuel sur cobaye

### Ce qui est testé en pure unit

| Suite | Coverage |
|---|---|
| `test-scoring.ts` | Formules ROADMAP §7 : `getCtrExpected` (interpolation), `computePriorityScore`, `assignTreatmentControl` (random seed pour reproductibilité), `classifyCwv` (seuils Good/NI/Poor) |
| `test-issue-template.ts` | Render markdown : labels, title format, body sections (TLDR alert, group banner, metrics box 23 rows, fact-check banner, pogo banner, mobile-first banner, measurement table, fix sections, collapsibles), Sprint-15 / 16 / 18 specific features |
| `test-data-quality-check.ts` | Capture rate calc, bootstrap pro-rating quand tracker_first_seen récent, verdict thresholds, edge cases (0 sessions, gsc null) |
| `test-content-extractor.ts` | Cheerio extractor sur fixtures HTML : word count, outline ordering, image alt detection, CTA in-body offsets, Wix header/footer strip, fallback `<body>` |
| `test-diagnostic-fact-check.ts` | Fact-check patterns : verified/unverified par catégorie (word count, H2, images, sans alt, pogo n=, pogo rate, evenness, dwell percentiles, mobile/desktop CTA), Sprint 17 regressions (médian=41s n= false positive, "Mobile 80% du trafic" sentence-boundary, "mobile + scroll_avg 24.4%" gap negative keywords) |
| `test-serp-helpers.ts` | `fmtSerpCompetitiveLandscape` (diag) + `fmtSerpTop3ForFixGen` (fix-gen) : empty/populated, truncation 100/70/220 chars, feature badges, top-N capping |
| `test-google-guidance.ts` | RSS parser (CDATA, entities, pubDate, truncation), `fmtGoogleRecentGuidance` render (3 sections : active updates / recent ended / blog posts ; Sprint 19.5 sections ranking systems + spam policies + deep-fetched bodies) |

### Politique d'ajout de test

À chaque modification d'un mécanisme :
1. Ajoute un test de **régression** pour le bug que tu fixe (cf. les Sprint-17 regression tests pour modèle)
2. Run `npm test` pour vérifier que tu ne casses pas les autres
3. Run `npx tsc --noEmit` (typecheck strict)
4. Si le test live (HTTP / DB) est nécessaire → préfère le faire en throwaway script + smoke, pas en test

---

## Smoke tests

### `npm run smoke`

Ping chaque connecteur live, output ok / fail / skipped.

```bash
$ npm run smoke

✓  OK      Supabase   audit_config keys: ctr_benchmarks_by_position, thresholds, audit_period_months
✓  OK      Anthropic  model=claude-opus-4-7 reply="Pong! 🏓"
✓  OK      GitHub     NicolasRewolf/seo (default=main, private=false)
✓  OK      GSC        property=https://www.jplouton-avocat.fr/, last-7d sample rows=N
✓  OK      Cooked     host=mxycmjkeotrycyneacje.supabase.co, snapshot_export=N_rows, site_context_sessions_28d=X
✓  OK      Wix        connected to Wix site "Cabinet Plouton"
✓  OK      DataForSEO top1=consultation.avocat.fr (rank_abs=5) · 10 organic
✓  OK      Google Search Central N pivot posts (M deep) · K incidents (J active) · 17 ranking systems · 17 spam policies · cache 1h

8 ok · 0 fail · 0 skipped
```

### Convention

- Chaque lib qui a un connecteur externe expose `smokeTest()` retournant `{ ok: boolean; detail: string }`
- `src/scripts/smoke.ts` orchestre + skip si l'env var n'est pas set
- Latence totale ~5-10s

### Ajout d'un connecteur

Pattern :

```ts
// src/lib/foo.ts
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetchSomething();
    return { ok: true, detail: `something=${r.value}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
```

```ts
// src/scripts/smoke.ts
import { smokeTest as fooSmoke } from '../lib/foo.js';

const probes: Probe[] = [
  // ...
  { name: 'Foo', required: ['FOO_API_KEY'], run: fooSmoke },
];
```

---

## End-to-end (manuel sur la cobaye)

### Cobaye permanente : issue #33

L'issue GitHub #33 (`/post/durée-de-la-garde-à-vue-24h-48h-96h-...`) est notre "cobaye" : on y teste **toutes** les modifications de prompt avant de batch sur les 16 autres findings.

### Pourquoi une cobaye unique

- Un changement de prompt peut casser la qualité du diag de façon non-évidente. Le valider sur **1 finding** d'abord avant de scale évite de polluer 16 issues si le prompt est buggué.
- Coût d'itération : 1 diag = ~80-120s + ~$0.20. 17 diags = ~25min + ~$3.40. Cobaye seule = test rapide.
- Cohérence de comparaison : on a un état de référence "voici ce que produit le prompt v8 sur cette page", on compare au "voici ce que produit le prompt v9".

### Workflow itératif

```bash
# 1. Modifier le prompt / le helper / le fact-check
vim src/prompts/diagnostic.v1.ts

# 2. Bump version + tests
# Edit DIAGNOSTIC_PROMPT_VERSION = N+1
npm test
npx tsc --noEmit

# 3. Run sur la cobaye SEULE
# (un script throwaway type validate-sprint-X.ts qui appelle diagnoseFinding(uuid-de-#33)
# + log les fields LLM + re-render le body via gh issue edit)

# 4. Visiter https://github.com/NicolasRewolf/seo/issues/33
# Lire le diag, vérifier le rendering visuel

# 5. Si OK → batch sur les 16 autres
# (script similaire qui itère sur tous les findings sauf #33)
```

### Throwaway scripts

Pour chaque sprint, on crée un `src/scripts/validate-sprint-XX.ts` qui :
1. Pre-fetch les sources nouvelles (pour log ce qui sera feedé au LLM)
2. Appelle `diagnoseFinding(findingId)` sur la cobaye
3. Inspecte les champs du diag
4. Vérifie un acceptance signal (ex: "le LLM a-t-il cité un ranking system par son nom ?")
5. Re-render l'issue via `renderIssue()` + `gh issue edit --body-file`
6. Cleanup : `rm src/scripts/validate-sprint-XX.ts` à la fin

Ces scripts ne sont **pas commités** — c'est de l'outillage e2e jetable.

---

## Que faire si un test fail

### Unit test fail

1. Lire le message d'erreur (`assert.equal(actual, expected)`)
2. C'est généralement un changement de comportement non-couvert :
   - Soit le test était bon et le code est cassé → fix le code
   - Soit le code est correct mais le test était trop strict → ajuste le test ET ajoute un commentaire expliquant pourquoi le seuil/format a changé

### Smoke fail

Diagnose par order :

| Connecteur | Probable cause |
|---|---|
| Supabase | Service-role key révoquée OU project paused |
| Anthropic | Crédit épuisé OU API key révoquée |
| GitHub | Token expiré (PAT fine-grained 90j max) |
| GSC | OAuth token expiré → re-auth manuel |
| Cooked | Project paused OU SECRET_KEY changée |
| Wix | JWT expiré (rare, JWT IST a une longue durée) OU `WIX_ACCOUNT_ID` faux (cf. mémoire `feedback_dotenv_override.md`) |
| DataForSEO | Compte épuisé OU `DATAFORSEO_AUTH` mal encodé |
| Google Search Central | Endpoint Google modifié (rare) — re-vérifier les URLs RSS / JSON / HTML |

### E2E fail (LLM hallucine ou diag absurde)

1. **Ne pas paniquer** — les LLMs varient, un mauvais run isolé n'est pas un bug systémique
2. Vérifier `diagnostic_fact_check` : si retry-once a passé sans corriger → bug dans le fact-checker (faux négatif)
3. Vérifier l'output JSON via `select diagnostic from audit_findings where id=...` — voir si c'est cohérent visuellement
4. Si le bug se répète sur plusieurs runs → suspect le prompt (sources mal présentées, instructions ambiguës)
5. Re-itérer sur la cobaye avec un fix prompt

---

## Coverage gaps connus

- **Pas de test de pipeline integration end-to-end** (snapshot → audit → diagnose → issues) — ce serait un mock énorme. On préfère les smoke tests + e2e manuel sur la cobaye.
- **Pas de test de regression LLM** — impossible à tester en unit (sortie LLM non-déterministe). On compense via fact-checker + e2e visuel.
- **Pas de test du crawler internal-links** — would require mocking sitemap.xml + Wix CDN responses. Bas-priorité.
- **Pas de test de generate-fixes** — output dépend lourdement du diag input, pas évident à tester en isolation. Smoke + e2e manuel.
