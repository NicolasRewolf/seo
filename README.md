# Plouton SEO Audit Tool

Pipeline diagnostic SEO automatisé orienté **NavBoost** pour `jplouton-avocat.fr`.
Pour chaque page sous-performante, croise GSC + tracker Cooked first-party + DataForSEO + DOM scrape, fait raisonner Claude Opus 4.7 sur ~21 blocs structurés, valide chaque chiffre cité contre les données sources (fact-checker + retry-once), produit une **issue GitHub** avec diagnostic causal, fixes prêts à appliquer, et cycle de mesure T+30 / T+60.

> Roadmap technique de référence : [`ROADMAP.md`](./ROADMAP.md). Le scope a largement dépassé le roadmap initial — ce README documente l'**état actuel** sur `main` (Sprint 17, prompt v9, Opus 4.7).

---

## Quick start

```bash
git clone https://github.com/NicolasRewolf/seo.git && cd seo
npm install
cp .env.example .env  # remplir les variables (cf. plus bas)
npm run smoke         # vérifie que tous les connecteurs répondent
npm test              # 126 tests unitaires
npx tsc --noEmit      # typecheck strict
```

---

## Pipeline en 6 étapes

| # | Commande | Rôle | Sortie DB |
|---|---|---|---|
| 1 | `npm run snapshot` | Pull GSC pages + queries (3 mois) + Cooked behavior + Core Web Vitals | `gsc_*_snapshots`, `behavior_page_snapshots`, `audit_runs` |
| 2 | `npm run audit` | Score les findings (CTR gap vs benchmark site, priority, treatment/control) | `audit_findings` (status=`pending`) |
| 3 | `npm run pull:state` | Récupère le contenu actuel des pages flagged (Wix Blog API ou DOM scrape Cheerio) + extracteur Sprint 14 (body / outline / images / CTAs / E-E-A-T) | `current_state`, `content_snapshot` |
| 4 | `npm run diagnose` | Opus 4.7 raisonne sur ~21 blocs XML (v9 prompt), validation Zod, **fact-check + retry-once**, persiste le verdict | `diagnostic`, `diagnostic_fact_check` |
| 5 | `npm run fixes` | Opus 4.7 produit 6-8 fixes structurés (title, meta, intro, schema, internal_links, content_addition) | `proposed_fixes` (status=`draft`) |
| 6 | `npm run issues` | Crée 1 issue GitHub par finding avec source attribution, alerts, collapsibles | `github_issue_number` + label `priority-{1,2,3}` + `{treatment,control}` |

**Cycle T+30 / T+60** :

```bash
# Après ton edit manuel dans Wix éditeur :
npm run apply -- --finding=<uuid> --by=nicolas@rewolf.studio
# → écrit applied_fixes (T0), bascule status, label l'issue

# Cron quotidien (mais runnable à la main) :
npm run measure
# → fix_outcomes T+30 / T+60 vs baseline + re-render issue body avec verdict + comment timestampé
```

Le crawl du graph interne tourne séparément :

```bash
npm run crawl  # populate internal_link_graph (Sprint 9 DOM-structural classifier)
```

---

## Architecture du diagnostic

```
GSC                            \
DataForSEO (volumes FR + SOV)   \
Wix Blog API (auteur + dates)    → buildDiagnosticInputs() → renderDiagnosticPrompt(v9)
Cooked RPCs × 7                 /                                    │
Site catalog (curé)            /                                     ▼
Sprint-9 internal_link_graph  /                          Anthropic Opus 4.7
DOM extractor (Cheerio)      /                          (max_tokens=8000)
                                                                     │
                                                                     ▼
                                                          Zod validation
                                                                     │
                                                                     ▼
                                              factCheckDiagnostic() — chiffres tracés ?
                                                              │           │
                                                          ✅ passé   ⚠️ unverified
                                                              │           │
                                                              │      retry-once avec
                                                              │      message correctif
                                                              │           │
                                                              ▼           ▼
                                                          Issue GitHub rendue (template Sprint 16)
```

---

## Sources de données (et ce qu'elles publient)

| Source | Ownership | Fournit |
|---|---|---|
| **GSC** | nous (OAuth file) | Top queries 3 mois, position moyenne + drift, CTR, impressions |
| **Cooked** ([repo](https://github.com/NicolasRewolf/cooked)) | agent jumeau | First-party tracker cookieless RGPD-exempt depuis 5 mai 2026. 7 RPCs : `snapshot_pages_export` (70 cols/page : behavior 4-fenêtres, CWV p75, conversion CTAs, **pogo-stick NavBoost**, **CTA per device**), `site_context_export`, `outbound_destinations_for_path`, `cta_breakdown_for_path`, `engagement_density_for_path` (p25/median/p75 + evenness), `tracker_first_seen_global`, `behavior_pages_for_period`, `pogo_rates_for_period`. **Bot filter centralisé depuis Sprint 17** — toutes les RPCs retournent des humains purs. |
| **DataForSEO** | nous (Basic Auth) | Volumes mensuels France par keyword, share-of-voice computée |
| **Wix Blog API** | nous (JWT IST...) | `getBlogPostBySlug` (SEO + contentText + richContent + categoryIds), `Blog Post Metrics`, auteur + date publication / modification |
| **DOM scrape** | nous (Cheerio) | Body texte complet, outline H2/H3/H4 avec offsets, images + alt, CTA in-body avec offsets, schema JSON-LD — extracteur Sprint 14 stable sur Wix Studio markup (`.wixui-header`, `.wixui-footer`) |
| **Site catalog** | nous (`src/lib/site-catalog.ts`) | Catalogue dur des URLs internes RÉELLES + rôle funnel — empêche le LLM d'halluciner des liens de maillage |

---

## Stack technique

- **TypeScript strict** ESM, Node 20+
- **Anthropic Claude Opus 4.7** (`max_tokens=8000`) — diagnostic + fix-generation
- **Supabase Postgres** — service-role bypass, schéma `audit_findings` + 5 migrations
- **Octokit** — création/PATCH d'issues
- **Cheerio** — extracteur HTML (PAS Readability — Wix Studio markup est stable)
- **Zod** — validation de tous les payloads LLM avant insertion
- **DataForSEO** REST (Basic Auth) — volumes France
- **Pino** logging structuré
- **GitHub Actions** : `audit-weekly.yml` (lundi 06:00 UTC, full chain) + `measure-outcomes.yml` (quotidien 07:00 UTC)

---

## Safety nets (les garde-fous qui rendent la sortie auditable)

| Safety net | Sprint | Quand ça déclenche | Ce que ça produit |
|---|---|---|---|
| **Zod schema validation** | 4 | Toujours, après chaque appel LLM | Exception explicite si JSON mal formé — pas de garbage en DB |
| **Capture rate guard** | 12 | `cooked_sessions_28d / gsc_clicks_28d < 50%` sur la page | Banner `[!WARNING]` + le LLM est instruit de lire en RELATIF, pas en absolu |
| **Fact-checker** | 14bis → 17 | Tout chiffre cité dans le diag (word_count, H2 count, images, pogo, n=, evenness, dwell percentiles, mobile/desktop CTA rates) | Verifié contre `content_snapshot`, `pogo_28d`, `cta_per_device_28d`, `engagement_density_for_path`. Si ≥1 unverified → **retry-once** avec message correctif. Persisté dans `diagnostic_fact_check` JSONB |
| **NavBoost CAUTION banner** | 15 | `pogo_rate_28d > 20%` AND `google_sessions_28d ≥ 30` | `[!CAUTION]` "Signal NavBoost négatif fort" + le LLM met le pogo en cause #1 |
| **Mobile-first CAUTION banner** | 16 | `cta_rate_mobile / cta_rate_desktop < 0.25` AND `mobile_sessions_28d ≥ 30` AND `cta_rate_desktop > 0` | `[!CAUTION]` "Mobile-first urgent" |
| **Source attribution** | 13 | Toujours | Chaque cellule de la metrics box et chaque diag bullet trailé `<sub>(GSC · Cooked · ...)</sub>` |
| **Treatment vs control** | 3 | 50% des findings random-assigned à `control` | Banner `[!CAUTION]` "ne pas appliquer pendant 4 semaines" pour mesurer le contre-factuel |

---

## Le prompt diagnostic v9 (le cerveau)

`src/prompts/diagnostic.v1.ts` — 911 lignes, version 9. Compose ~21 blocs XML structurés que le LLM lit dans l'ordre :

```
<identité>                  → cabinet, rôle de la page dans le funnel
<page_metrics>              → GSC : position, drift, CTR vs benchmark
<top_queries>               → GSC + DataForSEO volumes + share-of-voice
<page_body>                 → Sprint 14 — full body (jusqu'à 8000 mots)
<page_outline>              → H2/H3/H4 avec word offsets
<images>                    → src + alt + in_body
<cta_in_body_positions>     → ancres + targets + offsets
<author_eeat>               → Wix Blog API
<conversion_signals>        → Cooked phone/email/booking 7d/28d/90d
<cta_breakdown_by_placement>→ body vs header/footer (intent qualifié vs ambient)
<traffic_provenance>        → top_source/medium/referrer 28d
<pogo_navboost>             → Sprint 15 — pogo_rate + reliability gate n≥30
<engagement_density>        → Sprint 16 — p25/median/p75 + evenness_score
<cta_per_device>            → Sprint 16 — mobile/desktop CTA rate + reliability gate
<device_split>
<multi_window_trend>        → 7d vs 28d (avec caveat 90d/365d en cours de remplissage)
<top_outbound_destinations>
<site_context>              → médiane site, agrégats, baseline pour comparer
<inbound_links_to_this_page>→ Sprint 9 — graph d'autorité interne
<outbound_links_from_this_page>
<data_quality_check>        → capture rate Cooked / GSC, calibrage de tonalité
```

Le LLM produit un JSON de 13 sections analytiques (validé Zod) :
`tldr`, `intent_mismatch`, `snippet_weakness`, `hypothesis`, `top_queries_analysis`, `engagement_diagnosis`, `performance_diagnosis`, `structural_gaps`, `funnel_assessment`, `internal_authority_assessment`, `conversion_assessment`, `traffic_strategy_note`, `device_optimization_note`, `outbound_leak_note`, `pogo_navboost_assessment`, `engagement_pattern_assessment`.

---

## Le template d'issue GitHub

`src/prompts/issue-template.ts` — pure renderer. Une issue contient (de haut en bas) :

1. **TLDR** dans un `[!IMPORTANT]` GitHub alert (synthèse en 280 chars max)
2. **Verdict T+30/T+60** si mesuré : `[!TIP]` (✅), `[!CAUTION]` (🚫), ou `[!NOTE]` (ℹ️ neutre)
3. **Group banner** : `[!TIP]` treatment ou `[!CAUTION]` control (ne pas appliquer)
4. **Metrics box** 2 colonnes × 23 lignes (GSC + Cooked + CWV + Conversion + Provenance + Pogo + CTA per device + Engagement density + Capture rate + Priorité)
5. **Banners contextuelles** : `[!CAUTION]` NavBoost / Mobile-first, `[!WARNING]` data quality, `[!NOTE]` fact-check "0 halluciné"
6. **Diagnostic** : 13-15 bullets avec source attribution (`<sub>_(GSC · Cooked)_</sub>`)
7. **Top 5 queries** table
8. **Actions proposées** : 4-6 sections (title, meta, intro, internal_links, schema, content_addition) avec `<details>` collapsibles pour les valeurs longues
9. **Cycle de mesure** : T0, T+30, T+60
10. **Workflow checkboxes** : Reviewed → Applied → Measured T+30 → Measured T+60
11. **Refs** : audit_run_id, finding_id, lien Supabase

---

## Coordination avec les agents jumeaux

Trois projets Supabase coexistent — règles dans [`CLAUDE.md`](./CLAUDE.md).

- **Seo** (ce repo, `lzdnljppbenqoflyxbhi`) : à moi
- **Cooked** ([repo](https://github.com/NicolasRewolf/cooked), `mxycmjkeotrycyneacje`) : agent Claude Code séparé. Lecture only via les RPCs publiées. Tout changement de schéma / RPC / Edge Function / tracker passe par escalade via Nicolas.
- **Links** (`xjblcgvjhrssyszmrrvi`) : pas utilisé actuellement par ce repo.

Le briefing complet de Cooked (8 event types, 70 cols snapshot, ce qu'il n'est PAS) est résumé dans `CLAUDE.md`.

---

## Structure du repo

```
src/
├── config.ts                       # Per-section env validation (Zod)
├── lib/
│   ├── supabase.ts                 # service-role client
│   ├── anthropic.ts                # client + smokeTest (Opus 4.7)
│   ├── github.ts                   # Octokit
│   ├── google-auth.ts              # OAuth file-based loader (GSC)
│   ├── gsc.ts                      # searchanalytics.query wrapper
│   ├── cooked.ts                   # 7 RPC wrappers + types (PageSnapshotExtras, EngagementDensity, ...)
│   ├── wix.ts                      # Blog API + Site Properties + Blog Metrics + HTML scrape
│   ├── dataforseo.ts               # search_volume Live (Basic Auth)
│   ├── site-catalog.ts             # Hardcoded catalog of REAL Plouton URLs + funnel role
│   ├── page-content-extractor.ts   # Sprint 14 — Cheerio extractor (body / outline / images / CTAs / author)
│   ├── url.ts                      # pathOf + normalize
│   └── diagnostic-fact-check.ts    # Sprint 14bis → 17 — numeric claim verification + retry msg
├── pipeline/
│   ├── snapshot.ts                 # GSC + Cooked behavior+CWV
│   ├── compute-findings.ts         # Scoring (CTR gap, priority, treatment/control)
│   ├── pull-current-state.ts       # current_state + content_snapshot population
│   ├── context-enrichment.ts       # DataForSEO + Wix category + URL catalog
│   ├── diagnose.ts                 # buildDiagnosticInputs + LLM call + fact-check + retry
│   ├── generate-fixes.ts           # LLM fix-gen (idempotent : delete drafts then insert)
│   ├── create-issues.ts            # Octokit create + updateIssueAfterMeasurement
│   ├── mark-applied.ts             # Manual signal (no auto-Wix-push)
│   └── measure.ts                  # T+30/T+60 outcomes + re-render + comment
├── prompts/
│   ├── diagnostic.v1.ts            # Prompt v9 (Sprint 16 + 17) — 21 XML blocks
│   ├── fix-generation.v1.ts        # v3 catalog-aware, 7 fix_type options, schema placeholders
│   └── issue-template.ts           # Pure renderer (Sprint 13 UI + Sprint 14-16 banners)
└── scripts/
    ├── smoke.ts                    # Per-connector ping
    ├── run-{snapshot,audit,pull:state,diagnose,fixes,issues,apply,measure,crawl}.ts
    ├── test-scoring.ts             # 14 tests — formules ROADMAP §7 + CWV thresholds
    ├── test-issue-template.ts      # 58 tests — rendu markdown
    ├── test-data-quality-check.ts  # 14 tests — capture rate + bootstrap pro-rating
    ├── test-content-extractor.ts   # 11 tests — Sprint 14 extractor
    └── test-diagnostic-fact-check.ts # 29 tests — fact-checker patterns + Sprint 17 regressions

supabase/migrations/
├── 20260506000000_initial_schema.sql
├── 20260507000000_swap_ga4_to_behavior.sql       # Sprint 8 (GA4 → Cooked)
├── 20260507120000_internal_link_graph.sql        # Sprint 9
├── 20260507180000_content_snapshot.sql           # Sprint 14
└── 20260508000000_diagnostic_fact_check.sql      # Sprint 14bis

.github/workflows/
├── audit-weekly.yml                # Lundi 06:00 UTC : snapshot → audit → pull → diagnose → fixes → issues
└── measure-outcomes.yml            # Quotidien 07:00 UTC : measure T+30/T+60
```

---

## Sprints livrés (résumé)

| # | Contenu | PR / commit |
|---|---|---|
| 0-3 | Bootstrap, schéma Supabase, snapshot GSC, scoring | early commits |
| 4-6 | Pull-state, diagnostic LLM, fix-gen, issues GitHub, apply, measure | early commits |
| 7 | Enrichissement contextuel (DataForSEO + Wix categoryId + catalogue URLs) | `0a1b008` |
| 8 | GA4 → **Cooked** + Core Web Vitals au scoring | `7946115` |
| 9 | Internal link graph (Sprint-9 DOM-structural classifier) | `c5a0797` |
| 11 | Diagnostic prompt v5 + issue template redesign | `a8a227a` |
| 12 | Cooked full-menu integration (diagnostic v6 + fix-gen v3 + 4 RPCs) | #29 |
| 13 | UI/UX issue refresh : source attribution + GitHub Alerts + collapsibles + 2-col metrics box | #34 |
| 14 | **Page content extraction** + diagnostic v7 (sortie des "100 premiers mots") | #35 |
| 14bis | **Fact-checker** câblé dans diagnose + retry-once + persistence `diagnostic_fact_check` | #36 |
| Switch | Default LLM **Opus 4.7** | #37 |
| 15 | **Pogo-sticking / NavBoost** signal (4 cols snapshot + diag v8 + CAUTION banner) | #38 |
| Cooked alignment | Caveat fenêtres 90d/365d + CLAUDE.md briefing Cooked | #39 |
| 16 | **Engagement density + CTA per device** (RPC + 4 cols + diag v9 + Mobile-first banner) | #40 |
| 17 | **Bot filter** (Cooked-side, transparent) + bounce_rate /100 fix + 3 fact-checker false-positive fixes | #41 |

---

## Tests

```bash
npm test                          # tous les suites (126 tests)
npm run test:scoring              # 14 — formules de scoring + seuils CWV
npm run test:issue-template       # 58 — rendu markdown + alerts + Sprint 13-16 features
npm run test:data-quality         # 14 — capture rate + bootstrap pro-rating
npm run test:content-extractor    # 11 — Sprint 14 Cheerio extractor
npm run test:fact-check           # 29 — fact-checker patterns + Sprint 17 regressions
npx tsc --noEmit                  # typecheck strict
```

---

## Workflow opérationnel

1. **Cron `audit-weekly.yml`** (lundi 06:00 UTC) tourne tout le pipeline → ~17 issues GitHub fresh avec diagnostic + fixes
2. Tu **reviewes** chaque issue dans GitHub. Les findings du **groupe `control`** ont un bandeau `[!CAUTION]` "ne pas appliquer pendant 4 semaines" — laisse-les tels quels (mesure d'impact)
3. Pour appliquer un fix de groupe **`treatment`** : copier-coller dans l'éditeur Wix manuellement
4. Une fois fait : `npm run apply -- --finding=<uuid> --by=nicolas@rewolf.studio`
5. Le cron `measure-outcomes.yml` (quotidien 07:00 UTC) écrit automatiquement les `fix_outcomes` à T+30 et T+60, re-PATCH l'issue body avec verdict, poste un comment timestampé

### Mode itératif sur une seule finding (avant scale)

Quand on touche les prompts ou l'extraction de données, on travaille **sur une seule issue** d'abord (#33 = la cobaye permanente) avant de scaler aux autres :

1. Identifier le bug (extraction ou prompt)
2. Patcher le code
3. Re-run sur la cobaye :
   ```bash
   npm run diagnose -- --ids=<uuid-cobaye>
   # → vérifier le diag dans GitHub avant batch
   ```
4. Si OK → batch sur les autres findings via le runner approprié

---

## GitHub Actions — secrets requis

Repo Settings → Secrets and variables → Actions :

| Secret | Valeur |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase Seo |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé `sb_secret_...` (server-side only) |
| `ANTHROPIC_API_KEY` | clé `sk-ant-api03-...` |
| `ANTHROPIC_MODEL` | `claude-opus-4-7` (default) |
| `GH_API_TOKEN` | PAT fine-grained avec scopes `repo` + `issues:write` |
| `GSC_SITE_URL` | `https://www.jplouton-avocat.fr/` |
| `GSC_OAUTH_CREDENTIALS_JSON` | Contenu brut de `gsc-oauth-credentials.json` |
| `GSC_TOKEN_JSON` | Contenu brut de `gsc-token.json` |
| `COOKED_SUPABASE_URL` | URL du projet Cooked |
| `COOKED_SECRET_KEY` | Clé `sb_secret_...` du projet Cooked |
| `WIX_API_KEY` | JWT IST.eyJ... |
| `WIX_SITE_ID` | UUID du site Wix |
| `WIX_ACCOUNT_ID` | UUID du compte **owner** du site (pas du contributor) |
| `DATAFORSEO_AUTH` | Base64 de `login:password` |

Variables `.env` locales : voir `.env.example`. **Important** : `dotenv` est chargé avec `override: true` parce qu'un launcher peut injecter `ANTHROPIC_API_KEY=` vide qui shadow silencieusement le `.env`.

---

## Limitations connues

- ~~GA4 biaisé consent~~ — résolu Sprint 8 (Cooked first-party).
- ~~CWV faussés par les bots~~ — résolu Sprint 17 (Cooked bot filter centralisé). Les pages Wix lourdes apparaissent maintenant en "Poor" — c'est normal et c'est le vrai signal à fixer.
- **Bootstrap Cooked** : le tracker tourne depuis le 5 mai 2026 → fenêtres `90d` / `365d` en cours de remplissage. Le prompt v9 (`fmtMultiWindowTrend`) annote ce caveat pour que le LLM ne sur-interprète pas.
- **`anonymous_id` rotate quotidiennement** côté Cooked → pas de tracking returning visitors cross-day. Mes prompts ne formulent jamais de claim sur retours multi-jours.
- **Pages statiques** (non `/post/*`) : extracteur DOM peut capturer du chrome de menu Wix (rare grâce aux `.wixui-header` / `.wixui-footer` selectors stables, mais possible sur templates custom).
- **Position drift** = `null` au premier audit (pas de snapshot d'il y a 3 mois). Calculable dès le 2e cycle hebdo.
- **Apply auto désactivé** par choix produit : Nicolas édite à la main dans Wix, puis appelle `npm run apply` pour signaler T0.
- **Wix Blog Post Metrics** = cumulatif lifetime, pas de range. Pour avoir un delta hebdo, il faudrait snapshotter à chaque cron — pas implémenté (low ROI).
- **Bug `bounce_rate` côté Cooked** : `site_context_export()` retourne 0..1, `snapshot_pages_export()` retourne 0..100. Inconsistance documentée et neutralisée côté Seo (voir `cooked.ts` L319 commentaire).

---

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` : **server-side uniquement**, jamais en frontend
- RLS activé sur toutes les tables — service-role bypass, pas d'accès anon
- Tous les payloads LLM validés via Zod avant insertion
- Aucun fix poussé sur Wix sans intervention manuelle (`apply-fixes.ts` n'existe pas par choix)
- Tokens OAuth (`gsc-*.json`) et `.env` dans `.gitignore`
- `DATAFORSEO_AUTH` est en Basic Auth Base64 — usage server-side uniquement

---

## Coordination cross-agent

Quand un changement touche `Cooked` (RPCs, schéma, tracker, Edge Function) → escalade via Nicolas. Format dans [`CLAUDE.md`](./CLAUDE.md). Round-trip typique 5-15 min selon profondeur technique.
