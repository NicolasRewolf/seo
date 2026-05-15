# 01 — Le pipeline en 6 étapes

## Vue d'ensemble

Le pipeline est une **chaîne idempotente** de 6 étapes. Chaque étape lit ce que l'étape précédente a persisté en DB et écrit son propre output. Aucune étape ne ré-écrit ce qu'une précédente a fait — relancer une étape passe les findings déjà traitées.

```
1. snapshot       → audit_runs + gsc_*_snapshots + behavior_page_snapshots
2. audit          → audit_findings (status=pending)
3. pull-state     → current_state + content_snapshot
4. diagnose       → diagnostic + diagnostic_fact_check (status=diagnosed)
5. fixes          → proposed_fixes (status=proposed)
6. issues         → github_issue_number (status=proposed)
   --- humain applique manuellement dans Wix ---
7. apply (manuel) → applied_at (status=applied)
   --- crons quotidiens ---
8. measure T+30   → fix_outcomes + re-render issue body
9. measure T+60   → fix_outcomes + re-render issue body
```

Plus une étape transverse :

```
crawl-internal-links → internal_link_graph (utilisé par diagnose)
```

## Étape par étape

### 1. `npm run snapshot` — pull GSC + Cooked

**Quoi** : tire les 3 derniers mois de GSC (pages + queries) et le snapshot Cooked behavior + CWV pour toutes les URLs.

**Pourquoi** : le pipeline a besoin d'une photographie figée à T0 (immutable) pour pouvoir mesurer T+30/T+60 contre cette baseline.

**Comment** :
- Crée une row `audit_runs` (status=running)
- Pour chaque page GSC, insert dans `gsc_page_snapshots` + top 50 queries dans `gsc_query_snapshots`
- Tire le snapshot Cooked complet (1 row par URL, 70 cols) et insert dans `behavior_page_snapshots`
- Marque `audit_runs.completed_at`

**Où** : `src/pipeline/snapshot.ts`, runner `src/scripts/run-snapshot.ts`.

**Vérifier** :
```bash
npm run snapshot
# → output: "period 2026-02-10 → 2026-05-10 · gsc pages : 312 · gsc queries : 4811 · behavior pgs : 255"
```

**Limites** :
- GSC OAuth requis (file `gsc-token.json` rafraîchi au besoin)
- Cooked snapshot refresh nightly à 03:00 UTC côté Cooked — si tu lances snapshot juste avant, tu prends la veille
- 3 mois de fenêtre hardcodés via `audit_config.audit_period_months`

---

### 2. `npm run audit` — score les findings

**Quoi** : applique les formules de scoring sur le dernier `audit_run` pour identifier les pages sous-performantes.

**Pourquoi** : on n'audite pas tout. On cible les pages où il y a un vrai signal de sous-performance : impressions ≥ 500/mois, position 5-15, CTR ≥ 40% sous benchmark site-spécifique.

**Comment** :
- Pour chaque page du snapshot, calcule `ctr_expected` interpolé depuis la table de benchmarks par position
- Calcule `ctr_gap = (ctr_expected - ctr_actual) / ctr_expected`
- Si gap ≥ seuil + impressions ≥ seuil + position dans la fenêtre → finding éligible
- Score `priority = impressions × ctr_gap × (1 + drift_bonus)` (drift négatif = bonus)
- Insert dans `audit_findings` (status=`pending`)
- Random-assigne `treatment` (50%) ou `control` (50%) — base statistique de la mesure d'impact

**Où** : `src/pipeline/compute-findings.ts`, runner `src/scripts/run-audit.ts`. Tests : `src/scripts/test-scoring.ts` (formules).

**Vérifier** :
```bash
npm run audit
# → output: "audit_run_id=... · findings created: 17 (12 treatment + 5 control)"
```

Variante avec seuils relâchés pour explorer :
```bash
npm run audit:loose  # ctr_gap=0.3, min-impressions=200
```

**Limites** :
- Treatment/control assignment est random mais pas stratifié (pas de pairing par traffic ou intent type)
- Pas de scoring multi-objectif (juste impressions × ctr_gap), pas d'amplification par revenue / lead value

---

### 3. `npm run pull:state` — capture l'état actuel + le contenu

**Quoi** : pour chaque finding `pending`, récupère le contenu et les meta SEO de la page tels qu'ils sont AUJOURD'HUI.

**Pourquoi** : (a) le LLM a besoin du contenu pour analyser, (b) la mesure d'impact à T+30/T+60 doit pouvoir comparer "avant" vs "après" → on fige le `current_state` immutable.

**Comment** :
- Pour chaque finding sans `current_state` :
  - Si l'URL est `/post/*` → Wix Blog API (`getBlogPostBySlug`) pour SEO meta + content
  - Sinon → DOM scrape (Cheerio) avec User-Agent `plouton-content-bot/1.0`
- Persiste `current_state` (title, meta, H1, intro 100 mots, internal_links_outbound, schema_jsonld)
- En parallèle : extracteur Sprint 14 (`page-content-extractor.ts`) produit `content_snapshot` (body complet, outline H2/H3 avec offsets, images + alt, CTAs in-body avec offsets, author + dates)
- Status reste `pending` jusqu'à ce que `diagnose` le bump

**Où** : `src/pipeline/pull-current-state.ts`, runner `src/scripts/run-pull-current-state.ts`. Extracteur : `src/lib/page-content-extractor.ts`.

**Vérifier** : check qu'`audit_findings.current_state IS NOT NULL` après run.

**Limites** :
- Pages statiques (non `/post/*`) : extracteur peut capturer du chrome de menu Wix (rare grâce aux `.wixui-header` / `.wixui-footer` selectors stables)
- Si la page change ENTRE pull-state et application du fix → le baseline est obsolète. En pratique pas problématique (cycle court)

---

### 4. `npm run diagnose` — LLM cerveau

**Quoi** : pour chaque finding avec `current_state` mais sans `diagnostic`, assemble un prompt XML structuré avec ~25 blocs sources, appelle Opus 4.7, valide la réponse JSON via Zod, exécute le fact-checker, retry-once si nécessaire, persiste.

**Pourquoi** : c'est l'étape qui produit la valeur causale du tool. Sans LLM, on a juste des chiffres ; avec, on a un diagnostic qui explique POURQUOI.

**Comment** :
- `buildDiagnosticInputs(findingId)` agrège : GSC top queries, DataForSEO volumes, Cooked snapshot extras (CWV, behavior, conversion, pogo, device CTA), Cooked density, Cooked outbound, Cooked CTA breakdown, Wix Blog API enrichment, internal_link_graph inbound, content_snapshot, **Google Search Central guidance silo (Sprint 19/19.5)**, SERP organic top 10 (Sprint 18)
- `renderDiagnosticPrompt(inputs)` (prompt v11, `src/prompts/diagnostic.v1.ts`) compose ~25 blocs XML
- Appel Anthropic Opus 4.7, `max_tokens=8000`
- `DiagnosticSchema.parse()` (Zod) — exception si JSON mal formé
- `factCheckDiagnostic(diagnostic, content_snapshot, pogo, sprint16)` — vérifie chaque chiffre cité
- Si fact-check fail → retry-once avec message correctif listant les claims unverified
- Persiste `diagnostic` + `diagnostic_fact_check` JSONB, status → `diagnosed`

**Où** : `src/pipeline/diagnose.ts`, prompt `src/prompts/diagnostic.v1.ts`, fact-checker `src/lib/diagnostic-fact-check.ts`.

**Vérifier** :
```bash
npm run diagnose -- --ids=<finding-uuid>  # cobaye seul
# → check audit_findings : diagnostic IS NOT NULL, diagnostic_fact_check.passed=true
```

**Limites** :
- Coût : ~$0.20-$0.30 par diag (Opus 4.7 + ~25 blocs input + retry parfois)
- Latence : ~80-120s par finding (avec retry possible)
- Le retry-once n'est pas un retry-many — si la 2ème pass produit encore des claims unverified, on garde quand même le diag (lower bar : avoir un diag imparfait > pas de diag)

---

### 5. `npm run fixes` — LLM fix generator

**Quoi** : pour chaque finding `diagnosed` sans fixes, le LLM produit 6-8 fixes structurés.

**Pourquoi** : transformer le diagnostic en actions copy-paste-able. Le diag identifie le problème, le fix-gen propose le contenu pour le résoudre.

**Comment** :
- Reçoit le diag JSON + le contexte enrichment (catalog URLs, top queries, SERP top 3 — Sprint 18)
- Prompt v3 (`src/prompts/fix-generation.v1.ts`) avec contraintes déontologie avocat (pas de "meilleur", pas de promesse de résultat) + contraintes techniques (title ≤60, meta ≤155, intro structurée, URLs cibles uniquement du catalog)
- Output JSON validé Zod : `{ fixes: [{ fix_type, current_value, proposed_value, rationale }] }`
- 7 `fix_type` possibles : `title`, `meta_description`, `h1`, `intro`, `schema`, `internal_links`, `content_addition`
- Idempotent : delete drafts existants pour ce finding, puis insert. Status finding → `proposed`

**Où** : `src/pipeline/generate-fixes.ts`, prompt `src/prompts/fix-generation.v1.ts`.

**Vérifier** :
```bash
npm run fixes -- --ids=<finding-uuid>
# → check proposed_fixes : 6-8 rows pour ce finding_id, status=draft
```

**Limites** :
- Coût plus élevé que diag (souvent 8-12 min pour Opus 4.7 sur ce prompt dense)
- Le fix-gen ne re-vérifie pas le fact-check : on s'appuie sur la qualité du diag input
- Pas de "merge" intelligent avec un fix précédent : c'est un replace complet à chaque run

---

### 6. `npm run issues` — créer les issues GitHub

**Quoi** : pour chaque finding `proposed` sans `github_issue_number`, render un body markdown et crée l'issue.

**Pourquoi** : c'est le livrable humain. L'humain (Nicolas) review l'issue dans GitHub et applique le fix manuellement.

**Comment** :
- Pour chaque finding `proposed` sans issue :
  - Pull `cooked_extras` live (CWV, density, pogo, device CTA, top source/medium, capture rate)
  - Pull les `proposed_fixes` du finding
  - `renderIssue(inputs)` — pure function dans `src/prompts/issue-template.ts`
  - Octokit `issues.create` avec labels `seo-audit`, `priority-{1,2,3}`, `{treatment|control}`, `status:proposed`
- Persiste `github_issue_number` + `github_issue_url`

**Où** : `src/pipeline/create-issues.ts`, template `src/prompts/issue-template.ts`. Cf. [05-issue-template.md](./05-issue-template.md) pour l'anatomie complète du body.

**Vérifier** : check `audit_findings.github_issue_number IS NOT NULL` après run + visite l'issue dans GitHub.

**Limites** :
- Pas de bulk-update si on relance issues : seul le body peut être PATCHé via re-render (pas le state, pas les labels)
- Si tu re-cours `issues`, les findings déjà avec un issue_number sont skipped (idempotent)

---

### 7. `npm run apply -- --finding=<uuid> --by=<email>` — signal manuel

**Quoi** : Nicolas appelle ça après avoir copié-collé un fix dans Wix manuellement.

**Pourquoi** : pas d'auto-push sur Wix par choix produit. Mais il faut un signal T0 pour que `measure` puisse compter T+30 / T+60 à partir d'une date concrète.

**Comment** :
- Insert ligne dans `applied_fixes` (qui fix, par qui, quand)
- Update `audit_findings.status` → `applied`
- Update issue label : `status:applied`

**Où** : `src/pipeline/mark-applied.ts`, runner `src/scripts/run-mark-applied.ts`.

**Vérifier** : `applied_fixes` row + label issue mis à jour.

---

### 8/9. `npm run measure` — outcomes T+30 / T+60

**Quoi** : cron quotidien qui détecte les findings dont la date `applied_at + 30j` (ou +60j) est aujourd'hui, pull les chiffres GSC actuels, compare au baseline, écrit `fix_outcomes`, re-PATCH le body de l'issue.

**Pourquoi** : c'est la mesure d'impact du tool. Sans ça, on n'a aucune validation que les fixes marchent.

**Comment** :
- Pour chaque finding `applied` qui a passé le seuil T+30 (ou T+60) sans `fix_outcomes` correspondant :
  - Pull les chiffres GSC sur la fenêtre `applied_at - 30j` (baseline) + `applied_at + 30j` (mesure)
  - Calcule `ctr_delta_pct`, `position_delta`, `impressions_delta_pct`
  - Insert dans `fix_outcomes` (1 row par milestone)
  - Re-render le body de l'issue avec une nouvelle section verdict (`[!TIP]`/`[!CAUTION]`/`[!NOTE]`) + delta table
  - Post un comment timestampé sur l'issue avec le résumé

**Où** : `src/pipeline/measure.ts`, runner `src/scripts/run-measure.ts`. Re-render via `updateIssueAfterMeasurement` dans `src/pipeline/create-issues.ts`.

**Vérifier** : `fix_outcomes` rows + issue body avec section "📈 Mesure T+30" + comment GitHub timestampé.

**Limites** :
- Pas de pairing matched-pair entre treatment et control au moment de la mesure (chaque finding est mesuré individuellement)
- Pas de bayesian update — c'est juste un delta brut
- Le verdict (TIP/CAUTION/NOTE) est règles-fixes (`>=5%` CTR delta = TIP, `<=-5%` = CAUTION, sinon NOTE), pas adapté au volume d'impressions

---

## Étape transverse : `npm run crawl`

**Quoi** : crawler interne du site Plouton (sitemap.xml + récursif) qui populate le `internal_link_graph`.

**Pourquoi** : le diag a besoin de connaître l'autorité interne d'une page (qui linke vers elle, depuis quel placement éditorial vs nav/footer). Sans ce graph live, le LLM est aveugle au signal d'autorité.

**Comment** :
- `sitemap.ts` parse `https://www.jplouton-avocat.fr/sitemap.xml` puis chaque sitemap enfant
- Pour chaque URL : fetch HTML, extract tous les liens internes
- `dom-link-classifier.ts` classifie chaque lien par `placement` : editorial (in-body), related (sidebar/listing), cta (boutons CTA), nav (header/footer nav), footer (legal/footer), image (alt-link)
- Delete-by-source-then-insert dans `internal_link_graph` (idempotent)

**Où** : `src/pipeline/crawl-internal-links.ts`, classifier `src/lib/dom-link-classifier.ts`, sitemap `src/lib/sitemap.ts`.

**Vérifier** : `select count(*) from internal_link_graph` après run.

**Limites** :
- Concurrence limitée à 10 pour rester poli sur Wix CDN
- Les liens JS-rendered (rare sur Wix Studio) sont ratés
- Crawl complet ~5 min sur 440 URLs

---

## Cron GitHub Actions

| Workflow | Quand | Quoi | Où |
|---|---|---|---|
| `audit-weekly.yml` | Lundi 06:00 UTC | snapshot → crawl → audit → pull-state → diagnose → fixes → issues (toute la chaîne) | `.github/workflows/audit-weekly.yml` |
| `measure-outcomes.yml` | Quotidien 07:00 UTC | measure (lit baseline, calcule deltas, re-PATCH issues) | `.github/workflows/measure-outcomes.yml` |

Cf. [10-operational.md](./10-operational.md) pour les secrets requis.

---

## Idempotence

Chaque étape a un mécanisme pour skipper ce qui est déjà fait :

| Étape | Skip condition |
|---|---|
| `snapshot` | unique constraint `(page, period_start, period_end)` |
| `audit` | crée TOUJOURS un nouveau `audit_runs` (pas idempotent au sens strict — chaque run est un audit-run distinct) |
| `pull-state` | `current_state IS NOT NULL` skipped |
| `diagnose` | `diagnostic IS NOT NULL` skipped |
| `fixes` | delete-drafts-then-insert (re-run = remplace les drafts, garde les `applied`) |
| `issues` | `github_issue_number IS NOT NULL` skipped |
| `apply` | manuel uniquement |
| `measure` | une `fix_outcomes` row par finding par milestone (pas de doublon) |

Donc on peut relancer toute la chaîne sans casser quoi que ce soit. Si on veut FORCER le re-traitement d'un finding (ex: nouveau prompt), on peut soit `delete from audit_findings where ...` (radical) soit appeler `diagnose` directement avec `--ids=<uuid>` (plus chirurgical).
