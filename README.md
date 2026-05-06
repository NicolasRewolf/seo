# Plouton SEO Audit Tool

Pipeline automatisé d'audit SEO orienté NavBoost pour `jplouton-avocat.fr`.
Détecte les pages sous-performantes, génère diagnostic + fixes via LLM enrichi
avec données first-party (Wix Blog Metrics + Wix Analytics) + volumes France
réels (DataForSEO), et crée des issues GitHub structurées par finding. Mesure
l'impact via groupe de contrôle treatment vs control.

> Roadmap technique de référence : voir [`ROADMAP.md`](./ROADMAP.md). Le
> README ci-dessous documente l'**état actuel** du code, qui a évolué au-delà
> du roadmap initial pendant Sprint 7 (enrichissement contextuel).

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
| 1 | `npm run snapshot` | Pull GSC pages + queries (3 mois) + GA4 engagement → `*_snapshots` |
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
- **GA4 Data API** (`analytics.readonly`) : sessions / scroll / pages-per-session par pagePath — **biaisé par le consent CNIL**
- **Wix REST** :
  - `Blog API v3` : `getBlogPostBySlug` (SEO + contentText + richContent + categoryIds)
  - `Blog Post Metrics` (`/v3/posts/{id}/metrics`) : views/likes/comments first-party par post
  - `Analytics Data API v2` (`/analytics/v2/site-analytics/data`) : sessions site-wide first-party (calibration consent)
- **DataForSEO** : volumes mensuels France réels par keyword + share-of-voice computé page-side
- **OAuth Google** : pattern fichier (`gsc-oauth-credentials.json` + `gsc-token.json` + `ga4-token.json`), gitignored
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
│   ├── google-auth.ts            # OAuth file-based loader (shared GSC/GA4)
│   ├── gsc.ts                    # searchanalytics.query wrapper
│   ├── ga4.ts                    # runReport wrapper
│   ├── wix.ts                    # Blog API + Site Properties + Blog Metrics + Site Analytics + HTML scrape fallback
│   ├── dataforseo.ts             # search_volume Live (Basic Auth)
│   └── site-catalog.ts           # Hardcoded catalog of REAL Plouton URLs + Wix category role mapping
├── pipeline/
│   ├── snapshot.ts               # GSC pages/queries + GA4 (idempotent delete-before-insert)
│   ├── compute-findings.ts       # Scoring (page-level site benchmark, ctr_gap, priority_score, engagement penalty, treatment/control)
│   ├── pull-current-state.ts     # Loop: getCurrentStateForUrl → audit_findings.current_state
│   ├── context-enrichment.ts     # Sprint 7: gather wix_views + DataForSEO volumes + categorized maillage + consent calibration
│   ├── diagnose.ts               # Claude call + Zod validation → audit_findings.diagnostic
│   ├── generate-fixes.ts         # Claude call + insert proposed_fixes (status='draft')
│   ├── create-issues.ts          # Octokit create + store issue_number/url
│   ├── mark-applied.ts           # Manual signal (no auto-Wix-push)
│   └── measure.ts                # T+30/T+60 outcomes + treatment-vs-control gap
├── prompts/
│   ├── diagnostic.v1.ts          # Sprint-7 enriched: category role, schema, categorized maillage, real volumes, consent caveat
│   ├── fix-generation.v1.ts      # Sprint-7 enriched: catalog of REAL URLs, no hallucination, schema with placeholders
│   └── issue-template.ts         # Pure renderer for §9 markdown
└── scripts/
    ├── smoke.ts                  # Per-connector ping
    ├── auth-ga4.ts               # One-off OAuth consent flow (analytics.readonly)
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
    └── 20260506000000_initial_schema.sql

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
| 2 | ✅ | Snapshot GSC + GA4 + cron `audit-weekly.yml` (puis chainé en Sprint 5) |
| 3 | ✅ | Compute findings (page-level site benchmarks, scoring, treatment/control) |
| 4 | ✅ | Pull current state (Wix Blog + HTML fallback) + diagnostic LLM + génération de fixes LLM |
| 5 | ✅ | Création d'issues GitHub + chainage `audit-weekly.yml` (snapshot → audit → pull → diagnose → fixes → issues) |
| 6 | ✅ | Prompts enrichis v1 (schema + maillage + 7 fix types), `npm run apply` (signal manuel post-edit Wix), `pipeline/measure.ts` + cron `measure-outcomes.yml` |
| **7** | 🟡 **en cours** | **Enrichissement contextuel** : DataForSEO (volumes France réels + share-of-voice), Wix Blog Metrics (views first-party), Wix Analytics (calibration consent), `site-catalog.ts` (URLs internes réelles → 0 hallucination), maillage catégorisé éditorial vs nav, prompt `funnel_assessment` field. **Mode itératif** : on perfectionne le diagnostic d'**une seule** page (`/post/abandon-de-poste-quels-risques`, [issue #23](https://github.com/NicolasRewolf/seo/issues/23)) avant de relancer sur les 15 autres findings. |

---

## Mode itération actuel (Sprint 7)

Pour stabiliser la qualité du LLM avant de scaler, on travaille **sur une seule
issue à la fois**. Tant qu'elle n'est pas validée, on ne touche pas aux autres.

À chaque retour utilisateur :
1. Identifier le bug dans l'extraction de données ou dans le prompt
2. Patcher le code concerné (lib, pipeline ou prompt)
3. Reset la finding ciblée (`status='pending'`, `diagnostic=null`)
4. Re-run `npm run pull:state && npm run diagnose && npm run fixes`
5. Soit recréer une issue propre, soit poster un commentaire de comparaison

**Bugs trouvés et corrigés pendant cette itération** :

| # | Bug | Fix |
|---|---|---|
| 1 | `internal_links_outbound` hardcodé à `[]` pour les blog posts → LLM diagnostiquait "cul-de-sac funnel" alors que le maillage existe | `scrapeInternalLinks(url)` parallèle au Blog API |
| 2 | Consent rate calculé à >100% (impossible) car GA4 sommé sur 3 mois vs Wix sur 30 j | Aligner les deux périodes via `runReport` site-wide last-30d |
| 3 | LLM mélangeait nav menu + liens éditoriaux → conclusions fausses | Classifier les liens en 3 buckets (`editorial`, `related_post`, `nav`) avant injection prompt |
| 4 | Fix-gen v0 hallucinait des URLs (`/post/licenciement-faute-grave` n'existe pas) | Catalogue dur des URLs réelles Plouton injecté dans le prompt avec règle "uniquement celles-ci" |
| 5 | LLM inventait `dateModified` / `datePublished` pour les schemas Article | Prompt impose le placeholder `{{TO_FILL_BY_AUTHOR}}` quand la vraie date n'est pas connue |
| 6 | `max_tokens=2000/2500` truncatait les réponses LLM (~1/3 des findings) | Bumpé à 4000 (~16k chars output) |
| 7 | YAML anchors dans `audit-weekly.yml` (non supportés par GHA) → silently résolus en null | `env:` au niveau du job |

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
| `GA4_TOKEN_JSON` | Contenu brut de `ga4-token.json` |
| `GA4_PROPERTY_ID` | ID numérique GA4 (ex: `375034206`) |
| `WIX_API_KEY` | JWT IST.eyJ... |
| `WIX_SITE_ID` | UUID du site Wix |
| `WIX_ACCOUNT_ID` | UUID du compte **owner** du site (pas du contributor) |
| `DATAFORSEO_AUTH` | Base64 de `login:password` |

Variables `.env` locales : voir `.env.example`. **Important** : `dotenv` est chargé avec `override: true` parce qu'un launcher peut injecter `ANTHROPIC_API_KEY=` vide qui shadow silencieusement le `.env`.

---

## Limitations connues

- **GA4 biaisé consent** : ~3.5% des sessions visibles sur jplouton-avocat.fr (CNIL stricte). Les valeurs absolues (sessions, durée, scroll) sont sous-estimées. Les **ratios inter-pages** restent valides pour le scoring relatif. Le prompt diagnostic surface le ratio Wix/GA4 pour que le LLM pondère.
- **Wix Analytics Data API** = site-wide uniquement, pas de breakdown per-page (vérifié empiriquement avec tous les filtres `groupBy`/`dimensions`/`filter.*`). Sert uniquement à la calibration.
- **Wix Blog Post Metrics** = cumulatif lifetime, pas de range. Pour avoir un delta hebdo, il faudrait snapshotter les views à chaque cron — pas encore implémenté.
- **Pages statiques** (non `/post/*`) : extraction via scrape HTML qui peut capturer du chrome de menu Wix dans l'intro. Acceptable pour title/meta, dégradé pour intro.
- **Position drift** = `null` au premier audit (pas de snapshot d'il y a 3 mois). Devient calculable dès le 2e cycle hebdo.
- **Apply auto désactivé** : choix produit explicite (Nicolas édite à la main dans Wix éditeur, puis appelle `npm run apply` pour signaler le T0).

---

## Tests

```bash
npm run test:scoring         # 10 cases — formules de scoring (ROADMAP §7)
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
