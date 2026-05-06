# Plouton SEO Audit Tool

Pipeline automatisé d'audit SEO orienté NavBoost pour `jplouton-avocat.fr`.
Détecte les pages sous-performantes, génère diagnostic + fixes via LLM enrichi
avec données first-party (Wix Blog Metrics + Wix Analytics) + volumes France
réels (DataForSEO), et crée des issues GitHub structurées par finding. Mesure
l'impact via groupe de contrôle treatment vs control.

> Roadmap technique de référence : voir [`ROADMAP.md`](./ROADMAP.md). Le
> README ci-dessous documente l'**état actuel** du code. Le scope a dépassé
> le roadmap initial avec deux extensions livrées : Sprint 7 (enrichissement
> contextuel — DataForSEO + catalogue d'URLs réelles + funnel role) et
> Sprint 8 (remplacement de GA4 par Cooked first-party + Core Web Vitals).
> Tous les sprints sont sur `main`.

---

## Quick start

```bash
# 1. Cloner + installer
git clone https://github.com/NicolasRewolf/seo.git
cd seo
npm install

# 2. Configurer les credentials
cp .env.example .env
# Remplir les variables (cf. liste complète plus bas)

# 3. Vérifier que tous les connecteurs répondent
npm run smoke
```

---

## Pipeline en 6 étapes

| # | Commande | Rôle |
|---|---|---|
| 1 | `npm run snapshot` | Pull GSC pages + queries (3 mois) + Cooked first-party behavior & Core Web Vitals → `*_snapshots` |
| 2 | `npm run audit` | Calcule findings (CTR gap vs benchmark site-spécifique, scoring, treatment/control) → `audit_findings` |
| 3 | `npm run pull:state` | Récupère le contenu actuel des pages flagged (Wix Blog API + scrape HTML pour les liens) → `current_state` |
| 4 | `npm run diagnose` | LLM Sonnet 4.6 produit un diagnostic enrichi par page → `diagnostic` |
| 5 | `npm run fixes` | LLM propose des fixes structurés (title, meta, h1, intro, schema, internal_links, content_addition) → `proposed_fixes` |
| 6 | `npm run issues` | Crée une issue GitHub par finding avec labels priority + treatment/control |

**Cycle d'application + mesure** :

```bash
# Après ton edit manuel dans Wix éditeur :
npm run apply -- --finding=<uuid> --by=nicolas@rewolf.studio
# → écrit applied_fixes (T0), bascule status, label l'issue

# Tourne en cron quotidien (mais runnable à la main) :
npm run measure
# → calcule les fix_outcomes à T+30 / T+60 vs baseline + treatment-vs-control
```

---

## Stack

- **TypeScript strict**, Node 20+, ESM
- **Supabase Postgres** : 11 tables (snapshots, findings, fixes, outcomes) + 2 vues + RLS
- **Anthropic Claude Sonnet 4.6** : diagnostic + fix-generation (max_tokens=4000 pour éviter la troncature)
- **GitHub Issues** : 1 issue par finding, labels `seo-audit` + `priority-{1-3}` + `{treatment|control}` + `status:proposed`
- **Google Search Console** (`webmasters.readonly`) : positions, impressions, CTR par page + par query, sur 3 mois
- **Cooked** ([repo](https://github.com/NicolasRewolf/cooked)) : sessions / dwell actif / scroll (avg + median + complete %) / **Core Web Vitals (LCP, INP, CLS, TTFB p75)** / outbound clicks par URL — first-party, cookieless, RGPD-exempt, **non échantillonné, non thresholdé, non biaisé consent** (vs GA4 historique)
- **Wix REST** :
  - `Blog API v3` : `getBlogPostBySlug` (SEO + contentText + richContent + categoryIds) + scrape HTML parallèle pour les liens éditoriaux que l'API ne renvoie pas
  - `Blog Post Metrics` (`/v3/posts/{id}/metrics`) : views/likes/comments first-party par post
  - `Site Properties` (`/site-properties/v4/properties`) pour le smoke test
  - _Wix Analytics Data API existe et est connue (`/analytics/v2/site-analytics/data`, site-wide only) mais plus utilisée depuis le Sprint 8 — Cooked = ground truth comportementale._
- **DataForSEO** : volumes mensuels France réels par keyword + share-of-voice computé page-side
- **OAuth Google** : pattern fichier (`gsc-oauth-credentials.json` + `gsc-token.json`), gitignored
- **GitHub Actions** : `audit-weekly.yml` (lundi 06:00 UTC, full chain) + `measure-outcomes.yml` (quotidien 07:00 UTC)

---

## Structure du repo

```
src/
├── config.ts                     # Per-section env validation (Zod)
├── lib/
│   ├── supabase.ts               # service-role client
│   ├── anthropic.ts
│   ├── github.ts                 # Octokit
│   ├── google-auth.ts            # OAuth file-based loader (GSC)
│   ├── gsc.ts                    # searchanalytics.query wrapper
│   ├── cooked.ts                 # Cross-project Supabase client → behavior_pages_for_period RPC
│   ├── wix.ts                    # Blog API + Site Properties + Blog Metrics + Site Analytics + HTML scrape fallback
│   ├── dataforseo.ts             # search_volume Live (Basic Auth)
│   └── site-catalog.ts           # Hardcoded catalog of REAL Plouton URLs + Wix category role mapping
├── pipeline/
│   ├── snapshot.ts               # GSC pages/queries + Cooked behavior+CWV (idempotent delete-before-insert)
│   ├── compute-findings.ts       # Scoring (page-level site benchmark, ctr_gap, priority_score, engagement+CWV penalty, treatment/control)
│   ├── pull-current-state.ts     # Loop: getCurrentStateForUrl → audit_findings.current_state
│   ├── context-enrichment.ts     # Sprint 7: Wix category + funnel role + post views + DataForSEO volumes + URL catalog
│   ├── diagnose.ts               # Claude call + Zod validation → audit_findings.diagnostic
│   ├── generate-fixes.ts         # Claude call + insert proposed_fixes (status='draft')
│   ├── create-issues.ts          # Octokit create + store issue_number/url
│   ├── mark-applied.ts           # Manual signal (no auto-Wix-push)
│   └── measure.ts                # T+30/T+60 outcomes + treatment-vs-control gap
├── prompts/
│   ├── diagnostic.v1.ts          # v3 prompt: identité+rôle, GSC, Cooked behavior, CWV, état SEO, maillage catégorisé, top queries enrichies, catalogue URLs, mission JSON 8-fields
│   ├── fix-generation.v1.ts      # Catalog-aware (no URL hallucination), schema with {{TO_FILL_BY_AUTHOR}} placeholders, 7 fix_type options
│   └── issue-template.ts         # Pure renderer for §9 markdown
└── scripts/
    ├── smoke.ts                  # Per-connector ping
    ├── run-snapshot.ts
    ├── run-audit.ts
    ├── run-pull-current-state.ts
    ├── run-diagnose.ts
    ├── run-generate-fixes.ts
    ├── run-create-issues.ts
    ├── run-mark-applied.ts
    ├── run-measure.ts
    ├── test-scoring.ts           # 10 unit tests (formules ROADMAP §7)
    └── test-issue-template.ts    # 9 unit tests (template §9)

supabase/
└── migrations/
    ├── 20260506000000_initial_schema.sql
    └── 20260507000000_swap_ga4_to_behavior.sql   # Sprint 8 rename + CWV columns

.github/workflows/
├── audit-weekly.yml              # Full chain: snapshot → audit → pull → diagnose → fixes → issues
└── measure-outcomes.yml          # Daily T+30/T+60 measurement
```

---

## Sprints

| # | Statut | Contenu |
|---|---|---|
| 0 | ✅ | Bootstrap (TS, deps, env, repo) |
| 1 | ✅ | Schéma Supabase + connecteurs `lib/*` |
| 2 | ✅ | Snapshot GSC + GA4 (puis remplacé par Cooked au Sprint 8) + cron `audit-weekly.yml` (puis chainé en Sprint 5) |
| 3 | ✅ | Compute findings (page-level site benchmarks, scoring, treatment/control) |
| 4 | ✅ | Pull current state (Wix Blog + HTML fallback) + diagnostic LLM + génération de fixes LLM |
| 5 | ✅ | Création d'issues GitHub + chainage `audit-weekly.yml` (snapshot → audit → pull → diagnose → fixes → issues) |
| 6 | ✅ | Prompts enrichis v1 (schema + maillage + 7 fix types), `npm run apply` (signal manuel post-edit Wix), `pipeline/measure.ts` + cron `measure-outcomes.yml` |
| **7** | ✅ | **Enrichissement contextuel** (PR #25 → `0a1b008`) : DataForSEO (volumes France réels + share-of-voice par query), Wix Blog Metrics (views first-party par post), `site-catalog.ts` (catalogue dur des URLs internes réelles → 0 hallucination LLM), Wix `categoryId` → rôle funnel (`knowledge_brick` / `topic_expertise` / `press`), maillage catégorisé in-body éditorial vs nav vs related-post, scrape HTML parallèle au Wix Blog API pour récupérer les liens en corps d'article (l'API ne les renvoie pas). Nouveau champ JSON `funnel_assessment` dans la sortie LLM. |
| **8** | ✅ | **GA4 → Cooked** (`7946115`) : remplace la source comportementale par le tracker first-party Cooked. `ga4_page_snapshots` → `behavior_page_snapshots` (data préservée). Ajoute Core Web Vitals (LCP/INP/CLS/TTFB p75) + `scroll_complete_pct` + `outbound_clicks` au snapshot et au scoring. Pénalité scoring étendue avec les seuils Google (LCP > 2500ms +0.15, INP > 200ms +0.15, CLS > 0.1 +0.10, cap global 0.7). Prompt diagnostic v2 ajoute la section CWV + champ `performance_diagnosis`. La couche `consent_calibration` (Wix Analytics vs GA4) devient sans objet — droppée pendant le merge de réconciliation. |
| **réconciliation 7+8** | ✅ | Le merge de Sprint 7 sur la base Sprint 8 (déjà sur `main`) compose un prompt **diagnostic v3** dans l'ordre : identité + rôle funnel → GSC → Cooked behavior → CWV → état SEO → maillage catégorisé → queries enrichies (volumes FR + SOV) → catalogue URLs → mission JSON (8 fields incluant `funnel_assessment` + `performance_diagnosis`). Les anciens diagnostics v1/v2 persistés restent lisibles (Zod `.optional().default('')` sur les nouveaux champs). |

---

## Mode itératif (pour stabiliser la qualité)

Quand on touche les prompts ou l'extraction de données, on travaille **sur une
seule issue à la fois** avant de scaler aux 16 findings. Boucle :

1. Identifier le bug (extraction de données ou prompt)
2. Patcher le code concerné (lib, pipeline ou prompt)
3. Reset la finding ciblée :
   ```sql
   delete from proposed_fixes where finding_id = '<uuid>';
   update audit_findings
     set status='pending', diagnostic=null, current_state=null,
         github_issue_number=null, github_issue_url=null
     where id='<uuid>';
   ```
4. Re-run `npm run pull:state -- --ids=<uuid> && npm run diagnose -- --ids=<uuid> && npm run fixes -- --ids=<uuid> && npm run issues -- --ids=<uuid>`
5. Review l'issue créée. Si OK → `gh workflow run audit-weekly.yml` pour relancer sur tout.

**Bugs trouvés et corrigés pendant les itérations** (utile comme historique
de leçons) :

| # | Bug | Fix |
|---|---|---|
| 1 | `internal_links_outbound` hardcodé à `[]` pour les blog posts → LLM diagnostiquait "cul-de-sac funnel" alors que le maillage existe | `scrapeInternalLinks(url)` parallèle au Blog API |
| 2 | Consent rate calculé à >100% (impossible) car GA4 sommé sur 3 mois vs Wix sur 30 j | Aligner les deux périodes (puis tout droppé au Sprint 8 quand GA4 a sauté) |
| 3 | LLM mélangeait nav menu + liens éditoriaux → conclusions fausses | Classifier les liens en 3 buckets (`editorial`, `related_post`, `nav`) avant injection prompt |
| 4 | Fix-gen v0 hallucinait des URLs (`/post/licenciement-faute-grave` n'existe pas) | Catalogue dur des URLs réelles Plouton injecté dans le prompt avec règle "uniquement celles-ci" |
| 5 | LLM inventait `dateModified` / `datePublished` pour les schemas Article | Prompt impose le placeholder `{{TO_FILL_BY_AUTHOR}}` quand la vraie date n'est pas connue |
| 6 | `max_tokens=2000/2500` truncatait les réponses LLM (~1/3 des findings) | Bumpé à 4000 (~16k chars output) |
| 7 | YAML anchors dans `audit-weekly.yml` (non supportés par GHA) → silently résolus en null | `env:` au niveau du job |
| 8 | Wix Blog `getBlogPostBySlug` peut renvoyer 503 transient pendant fix-gen | Re-tenter après ~10-15s suffit (idempotent côté pipeline) |

---

## Workflow opérationnel

1. **Cron `audit-weekly.yml` (lundi 06:00 UTC)** tourne tout le pipeline → ~N issues GitHub fresh avec diagnostic + fixes proposés.
2. Tu **reviewes** chaque issue dans GitHub. Les findings du **groupe `control`** ont un bandeau "ne pas appliquer pendant 4 semaines" — laisse-les tels quels (mesure d'impact treatment vs control).
3. Pour appliquer un fix de groupe **`treatment`** : copie-colle les valeurs proposées **dans l'éditeur Wix manuellement** (pas d'auto-apply, choix explicite).
4. Une fois fait, lance localement :
   ```bash
   npm run apply -- --finding=<uuid> --by=nicolas@rewolf.studio
   ```
5. Le cron `measure-outcomes.yml` (quotidien 07:00 UTC) écrit automatiquement les `fix_outcomes` à T+30 et T+60.

---

## GitHub Action — secrets requis

Repo Settings → Secrets and variables → Actions :

| Secret | Valeur |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase (ex: `https://lzdnljppbenqoflyxbhi.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé `sb_secret_...` (server-side only) |
| `ANTHROPIC_API_KEY` | clé `sk-ant-api03-...` |
| `GH_API_TOKEN` | PAT fine-grained avec scopes `repo` + `issues:write` |
| `GSC_SITE_URL` | `https://www.jplouton-avocat.fr/` |
| `GSC_OAUTH_CREDENTIALS_JSON` | Contenu brut de `gsc-oauth-credentials.json` |
| `GSC_TOKEN_JSON` | Contenu brut de `gsc-token.json` |
| `COOKED_SUPABASE_URL` | URL du projet Cooked (ex: `https://mxycmjkeotrycyneacje.supabase.co`) |
| `COOKED_SECRET_KEY` | Clé `sb_secret_...` du projet Cooked (Settings → API) |
| `WIX_API_KEY` | JWT IST.eyJ... |
| `WIX_SITE_ID` | UUID du site Wix |
| `WIX_ACCOUNT_ID` | UUID du compte **owner** du site (pas du contributor) |
| `DATAFORSEO_AUTH` | Base64 de `login:password` |

Variables `.env` locales : voir `.env.example`. **Important** : `dotenv` est chargé avec `override: true` parce qu'un launcher peut injecter `ANTHROPIC_API_KEY=` vide qui shadow silencieusement le `.env`.

---

## Limitations connues

- ~~GA4 biaisé consent~~ — **résolu Sprint 8** : on a swappé GA4 pour Cooked (first-party, exempté CNIL). 100% des sessions sont capturées, plus aucun thresholding ni sampling ni modeled data.
- **Backfill historique Cooked** : Cooked a démarré la collecte le jour de son déploiement. Les premiers audits auront `null` sur les CWV et le comportement par page tant que le tracker n'a pas accumulé d'événements (~28 jours pour CWV en plein régime). Le scoring est neutre sur `null` (pas de pénalité ajoutée), et le prompt diagnostic le dit explicitement (`'CWV en cours de collecte (n/a)'`).
- **Wix Blog Post Metrics** = cumulatif lifetime, pas de range. Pour avoir un delta hebdo, il faudrait snapshotter les views à chaque cron — pas encore implémenté.
- **Pages statiques** (non `/post/*`) : extraction via scrape HTML qui peut capturer du chrome de menu Wix dans l'intro. Acceptable pour title/meta, dégradé pour intro.
- **Position drift** = `null` au premier audit (pas de snapshot d'il y a 3 mois). Devient calculable dès le 2e cycle hebdo.
- **Apply auto désactivé** : choix produit explicite (Nicolas édite à la main dans Wix éditeur, puis appelle `npm run apply` pour signaler le T0).

---

## Tests

```bash
npm run test:scoring         # 14 cases — formules de scoring (ROADMAP §7) + seuils CWV (Sprint 8)
npm run test:issue-template  # 9 cases — rendu markdown des issues (ROADMAP §9)
npx tsc --noEmit             # typecheck strict
```

---

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` : **server-side uniquement**, jamais en frontend.
- RLS activé sur toutes les tables — service-role bypass, pas d'accès anon.
- Tous les payloads LLM validés via Zod avant insertion (`DiagnosticSchema`, `FixesPayload`).
- Aucun fix poussé sur Wix sans intervention manuelle (`apply-fixes.ts` n'existe pas par choix).
- Tokens OAuth et `.env` dans `.gitignore`.
- `DATAFORSEO_AUTH` est en Basic Auth Base64 (équivalent HTTPS clair) — usage server-side uniquement.
