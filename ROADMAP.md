# REWOLF · Plouton SEO Audit Tool — Technical Roadmap

> **Objet** : Pipeline automatisé d'audit SEO orienté NavBoost pour `jplouton-avocat.fr`.
> Détecte les pages sous-performantes (CTR < benchmark à leur position, drift négatif), génère un diagnostic + fixes via LLM, et crée une issue GitHub structurée par finding. Mesure l'impact via groupe de contrôle.
>
> **Auteur** : REWOLF / Nico
> **Mode d'exécution** : Claude Code, avec tous les MCPs connectés
> **Cible métier** : faire remonter en 4-8 semaines les pages coincées en position 5-15 avec CTR sous-benchmark.

---

## Sommaire

1. [Vision & livrables](#1-vision--livrables)
2. [Stack technique & MCPs requis](#2-stack-technique--mcps-requis)
3. [Architecture du système](#3-architecture-du-système)
4. [Schéma Supabase complet](#4-schéma-supabase-complet)
5. [Configuration & benchmarks](#5-configuration--benchmarks)
6. [Pipeline d'exécution — 6 étapes](#6-pipeline-dexécution--6-étapes)
7. [Logique d'audit (formules)](#7-logique-daudit-formules)
8. [Prompts LLM (diagnostic + fixes)](#8-prompts-llm-diagnostic--fixes)
9. [Format des issues GitHub](#9-format-des-issues-github)
10. [Application des fixes via Wix](#10-application-des-fixes-via-wix)
11. [Mesure d'impact & groupe de contrôle](#11-mesure-dimpact--groupe-de-contrôle)
12. [Roadmap d'implémentation par sprints](#12-roadmap-dimplémentation-par-sprints)
13. [Checklist de démarrage](#13-checklist-de-démarrage)
14. [Instructions pour Claude Code](#14-instructions-pour-claude-code)

---

## 1. Vision & livrables

### Ce que fait l'outil

À chaque run d'audit (hebdo ou manuel) :

1. **Snapshot** : extrait 3 mois de données GSC (page-level + query-level) et GA4 (engagement)
2. **Détection** : flag les pages qui sous-performent au regard de NavBoost (CTR vs benchmark de position, drift, engagement faible)
3. **Diagnostic** : pour chaque page flagged, analyse via Claude Sonnet 4.6 le mismatch d'intention, la faiblesse du snippet, l'hypothèse principale du sous-CTR
4. **Génération de fixes** : title, meta, intro réécrits, schema éventuel, recos de maillage interne
5. **Issue GitHub** : crée une issue par finding avec priorité, diagnostic, fixes proposés, labels, cycle de mesure
6. **Apply (manuel ou semi-auto)** : après revue humaine, push les fixes via l'API Wix
7. **Mesure** : à T+30 et T+60, compare CTR/position vs baseline. Compare groupe traité vs groupe contrôle pour isoler l'effet.

### Livrables fonctionnels

- Repo GitHub `plouton-seo-audit` avec pipeline TypeScript + scripts Supabase
- Tables Supabase opérationnelles avec RLS
- Cron hebdomadaire (snapshot + audit) via Supabase Edge Functions ou GitHub Actions
- Issues GitHub auto-créées avec labels `seo-audit`, `priority-{1-3}`, `treatment` ou `control`
- Dashboard simple (Next.js ou Vite/React) pour reviewer les fixes avant apply
- Rapport mensuel auto-généré sur le delta agrégé

---

## 2. Stack technique & MCPs requis

### Langages & runtime

- **TypeScript** (Node.js 20+ ou Bun)
- **Supabase Postgres** (DB + RLS + Edge Functions)
- **GitHub Actions** pour les crons (alternative aux Edge Functions Supabase)

### Dépendances npm principales

```json
{
  "@supabase/supabase-js": "^2",
  "@anthropic-ai/sdk": "^0.30",
  "@octokit/rest": "^21",
  "googleapis": "^144",
  "zod": "^3",
  "date-fns": "^4",
  "dotenv": "^16"
}
```

### MCPs à connecter dans Claude Code

À activer avant de commencer :

| MCP | Usage | Déjà installé chez toi |
|---|---|---|
| **GitHub** | Création/MAJ d'issues, push de code | ✅ |
| **Supabase** | Création de tables, requêtes, RLS | ✅ |
| **Wix** | Lecture du contenu actuel + push des fixes | ✅ |
| **GSC** (via OAuth direct) | Snapshot pages + queries | À vérifier |
| **GA4** (via OAuth direct) | Engagement signals | À créer |
| **Ahrefs** | Benchmark CTR-par-position spécifique site | ✅ |

### Variables d'environnement

```bash
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6

# GitHub
GITHUB_TOKEN=
GITHUB_OWNER=rewolf
GITHUB_REPO=plouton-seo-audit

# Google (GSC + GA4)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GSC_PROPERTY_URL=https://jplouton-avocat.fr/
GA4_PROPERTY_ID=

# Wix
WIX_API_KEY=
WIX_SITE_ID=
WIX_ACCOUNT_ID=

# Audit config
AUDIT_PERIOD_MONTHS=3
MIN_IMPRESSIONS_THRESHOLD=500
CTR_GAP_THRESHOLD=0.4
POSITION_RANGE_MIN=5
POSITION_RANGE_MAX=15
```

---

## 3. Architecture du système

```
┌─────────────────┐
│   GSC API       │──┐
└─────────────────┘  │
┌─────────────────┐  │     ┌──────────────────┐
│   GA4 API       │──┼────▶│  Snapshot Job    │
└─────────────────┘  │     │  (hebdo, cron)   │
┌─────────────────┐  │     └────────┬─────────┘
│   Ahrefs API    │──┘              │
└─────────────────┘                 ▼
                          ┌──────────────────┐
                          │  Supabase        │
                          │  (snapshots)     │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  Audit Job       │
                          │  (findings)      │
                          └────────┬─────────┘
                                   │
                          ┌────────┴─────────┐
                          ▼                  ▼
                ┌──────────────────┐  ┌──────────────────┐
                │   Wix API        │  │  Claude API      │
                │   (read content) │  │  (diagnostic)    │
                └────────┬─────────┘  └────────┬─────────┘
                         │                     │
                         └─────────┬───────────┘
                                   ▼
                          ┌──────────────────┐
                          │  Claude API      │
                          │  (génération)    │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  GitHub Issues   │
                          └────────┬─────────┘
                                   │
                                   │ [revue humaine]
                                   ▼
                          ┌──────────────────┐
                          │   Wix API        │
                          │   (apply fixes)  │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  Measurement     │
                          │  J+30, J+60      │
                          └──────────────────┘
```

### Découpage des modules (structure du repo)

```
plouton-seo-audit/
├── README.md
├── ROADMAP.md (ce fichier)
├── package.json
├── tsconfig.json
├── .env.example
├── .github/
│   └── workflows/
│       ├── snapshot-weekly.yml
│       ├── audit-weekly.yml
│       └── measure-outcomes.yml
├── supabase/
│   ├── migrations/
│   │   └── 20260506_initial_schema.sql
│   └── functions/
│       └── (optional Edge Functions)
├── src/
│   ├── config.ts                  # Charge env + audit_config depuis Supabase
│   ├── lib/
│   │   ├── supabase.ts
│   │   ├── anthropic.ts
│   │   ├── github.ts
│   │   ├── gsc.ts
│   │   ├── ga4.ts
│   │   └── wix.ts
│   ├── pipeline/
│   │   ├── snapshot.ts            # Étape 1
│   │   ├── compute-findings.ts    # Étape 2
│   │   ├── pull-current-state.ts  # Étape 3
│   │   ├── diagnose.ts            # Étape 4 (LLM call 1)
│   │   ├── generate-fixes.ts      # Étape 5 (LLM call 2)
│   │   ├── create-issues.ts       # Étape 6
│   │   ├── apply-fixes.ts         # post-revue
│   │   └── measure.ts             # J+30 / J+60
│   ├── prompts/
│   │   ├── diagnostic.v1.ts
│   │   └── fix-generation.v1.ts
│   └── scripts/
│       ├── run-snapshot.ts
│       ├── run-audit.ts
│       └── run-measure.ts
└── dashboard/                     # (Sprint 6, optionnel)
    └── ...
```

---

## 4. Schéma Supabase complet

À déposer dans `supabase/migrations/20260506_initial_schema.sql` :

```sql
-- ============================================================
-- REWOLF · Plouton SEO Audit Tool — Initial Schema
-- ============================================================

-- Extensions
create extension if not exists "uuid-ossp";

-- ============================================================
-- 1. CONFIGURATION
-- ============================================================

create table audit_config (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value jsonb not null,
  description text,
  updated_at timestamptz default now()
);

-- Seed des benchmarks CTR par position (2026)
insert into audit_config (key, value, description) values
  ('ctr_benchmarks_by_position', '{
    "1": 0.30, "2": 0.16, "3": 0.11, "4": 0.08, "5": 0.065,
    "6": 0.05, "7": 0.04, "8": 0.035, "9": 0.03, "10": 0.025,
    "11": 0.02, "12": 0.018, "13": 0.015, "14": 0.013, "15": 0.012
  }', 'Benchmarks CTR moyens par position SERP en 2026 (hors AI Overview)'),
  ('thresholds', '{
    "min_impressions_monthly": 500,
    "ctr_gap_threshold": 0.4,
    "position_min": 5,
    "position_max": 15,
    "drift_threshold": 3
  }', 'Seuils de détection des findings'),
  ('audit_period_months', '3', 'Fenêtre d''analyse en mois');

-- ============================================================
-- 2. SNAPSHOTS GSC
-- ============================================================

-- Page-level
create table gsc_page_snapshots (
  id bigserial primary key,
  page text not null,
  period_start date not null,
  period_end date not null,
  impressions int not null,
  clicks int not null,
  ctr numeric(6,4) not null,
  avg_position numeric(5,2) not null,
  pulled_at timestamptz default now(),
  unique (page, period_start, period_end)
);
create index gsc_page_snap_page_idx on gsc_page_snapshots (page, period_end desc);
create index gsc_page_snap_perf_idx on gsc_page_snapshots (period_end desc, impressions desc);

-- Query-level (par page × query)
create table gsc_query_snapshots (
  id bigserial primary key,
  page text not null,
  query text not null,
  period_start date not null,
  period_end date not null,
  impressions int not null,
  clicks int not null,
  ctr numeric(6,4) not null,
  avg_position numeric(5,2) not null,
  pulled_at timestamptz default now(),
  unique (page, query, period_start, period_end)
);
create index gsc_query_snap_page_idx on gsc_query_snapshots (page, period_end desc);

-- ============================================================
-- 3. SNAPSHOTS GA4
-- ============================================================

create table ga4_page_snapshots (
  id bigserial primary key,
  page text not null,
  period_start date not null,
  period_end date not null,
  sessions int,
  pages_per_session numeric(5,2),
  avg_session_duration_seconds int,
  bounce_rate numeric(5,4),
  scroll_depth_avg numeric(5,2),
  pulled_at timestamptz default now(),
  unique (page, period_start, period_end)
);
create index ga4_snap_page_idx on ga4_page_snapshots (page, period_end desc);

-- ============================================================
-- 4. AUDIT RUNS
-- ============================================================

create table audit_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz default now(),
  completed_at timestamptz,
  period_start date not null,
  period_end date not null,
  pages_analyzed int default 0,
  findings_count int default 0,
  config_snapshot jsonb,    -- copie de audit_config au moment du run
  status text default 'running' check (status in ('running','completed','failed')),
  error_log text
);

-- ============================================================
-- 5. FINDINGS
-- ============================================================

create table audit_findings (
  id uuid primary key default gen_random_uuid(),
  audit_run_id uuid references audit_runs(id) on delete cascade,
  page text not null,

  -- Métriques d'identification
  impressions int not null,
  ctr_actual numeric(6,4) not null,
  ctr_expected numeric(6,4) not null,
  ctr_gap numeric(5,4) not null,         -- (expected - actual) / expected
  avg_position numeric(5,2) not null,
  position_drift numeric(5,2),            -- vs 3 mois avant
  priority_score numeric(8,2) not null,
  priority_tier int check (priority_tier in (1, 2, 3)),

  -- Engagement (snapshot GA4)
  pages_per_session numeric(5,2),
  avg_session_duration_seconds int,
  scroll_depth_avg numeric(5,2),

  -- Groupe expérimental
  group_assignment text check (group_assignment in ('treatment','control')),

  -- État courant capturé via Wix API
  current_state jsonb,
  -- Schema attendu :
  -- {
  --   "title": string,
  --   "meta_description": string,
  --   "h1": string,
  --   "intro_first_100_words": string,
  --   "schema_jsonld": object | null,
  --   "internal_links_outbound": [{ "anchor": string, "target": string }],
  --   "fetched_at": iso_string
  -- }

  -- Diagnostic LLM
  diagnostic jsonb,
  -- Schema attendu :
  -- {
  --   "intent_mismatch": string,
  --   "snippet_weakness": string,
  --   "hypothesis": string,
  --   "top_queries_analysis": [
  --     { "query": string, "impressions": int, "ctr": number, "position": number, "intent_match": "yes"|"partial"|"no" }
  --   ]
  -- }

  -- Lien vers issue GitHub
  github_issue_number int,
  github_issue_url text,

  -- Workflow
  status text default 'pending' check (status in (
    'pending',     -- créé, pas encore diagnostiqué
    'diagnosed',   -- diagnostic LLM fait
    'proposed',    -- fixes générés
    'reviewed',    -- revue humaine OK
    'applied',     -- pushé sur Wix
    'measured',    -- T+60 mesuré
    'ignored',     -- décision humaine de pas traiter
    'failed'       -- erreur dans le pipeline
  )),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index audit_findings_status_idx on audit_findings (status, priority_score desc);
create index audit_findings_page_idx on audit_findings (page);
create index audit_findings_run_idx on audit_findings (audit_run_id);

-- ============================================================
-- 6. PROPOSED FIXES
-- ============================================================

create table proposed_fixes (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid references audit_findings(id) on delete cascade,
  fix_type text not null check (fix_type in (
    'title',
    'meta_description',
    'h1',
    'intro',
    'schema',
    'internal_links',
    'content_addition'
  )),
  current_value text,
  proposed_value text not null,
  rationale text,
  prompt_version_id uuid,
  status text default 'draft' check (status in ('draft','approved','rejected','applied')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index proposed_fixes_finding_idx on proposed_fixes (finding_id);
create index proposed_fixes_status_idx on proposed_fixes (status);

-- ============================================================
-- 7. APPLIED FIXES
-- ============================================================

create table applied_fixes (
  id uuid primary key default gen_random_uuid(),
  proposed_fix_id uuid references proposed_fixes(id),
  applied_at timestamptz default now(),
  applied_by text,
  wix_response jsonb,
  rolled_back_at timestamptz,
  rollback_reason text
);

-- ============================================================
-- 8. MEASUREMENTS
-- ============================================================

create table fix_outcomes (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid references audit_findings(id) on delete cascade,
  measured_at timestamptz default now(),
  days_after_fix int not null,             -- 30, 60, 90...
  baseline_ctr numeric(6,4),
  current_ctr numeric(6,4),
  ctr_delta_pct numeric(6,2),              -- variation relative
  baseline_position numeric(5,2),
  current_position numeric(5,2),
  position_delta numeric(5,2),
  baseline_impressions int,
  current_impressions int,
  significance_note text                    -- "treatment vs control gap = +18%"
);

-- ============================================================
-- 9. PROMPT VERSIONING (pour A/B test)
-- ============================================================

create table prompt_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_name text not null check (prompt_name in ('diagnostic','fix_generation')),
  version int not null,
  template text not null,
  notes text,
  active boolean default false,
  created_at timestamptz default now(),
  unique (prompt_name, version)
);

-- ============================================================
-- 10. VUES UTILES
-- ============================================================

-- Pages prioritaires en attente
create or replace view v_pending_findings as
select
  f.id,
  f.page,
  f.priority_score,
  f.priority_tier,
  f.ctr_gap,
  f.avg_position,
  f.position_drift,
  f.impressions,
  f.status,
  f.group_assignment,
  f.created_at
from audit_findings f
where f.status in ('pending','diagnosed','proposed')
order by f.priority_score desc;

-- Suivi des outcomes
create or replace view v_treatment_vs_control as
select
  f.group_assignment,
  count(*) as n_findings,
  avg(o.ctr_delta_pct) as avg_ctr_delta_pct,
  avg(o.position_delta) as avg_position_delta,
  o.days_after_fix
from audit_findings f
left join fix_outcomes o on o.finding_id = f.id
where f.status = 'measured'
group by f.group_assignment, o.days_after_fix
order by o.days_after_fix, f.group_assignment;
```

---

## 5. Configuration & benchmarks

### Benchmarks CTR par position (2026, hors AI Overview)

| Position | CTR moyen attendu |
|---|---|
| 1 | 30% |
| 2 | 16% |
| 3 | 11% |
| 5 | 6.5% |
| 7 | 4% |
| 10 | 2.5% |
| 15 | 1.2% |

> Ces valeurs sont des moyennes industry. **Préférer les benchmarks site-spécifiques quand disponibles** via Ahrefs `gsc-ctr-by-position`. Stocker les valeurs site-spécifiques dans `audit_config` avec la clé `ctr_benchmarks_by_position_site`. La logique de calcul du `ctr_expected` doit utiliser le benchmark site-spécifique en priorité, fallback sur le benchmark générique.

### Seuils de détection (par défaut)

| Critère | Valeur | Modifiable via |
|---|---|---|
| Impressions minimum/mois | 500 | `audit_config.thresholds.min_impressions_monthly` |
| CTR gap minimum | 0.4 (= 40% sous benchmark) | `audit_config.thresholds.ctr_gap_threshold` |
| Plage de position | 5–15 | `audit_config.thresholds.position_min/max` |
| Drift négatif minimum | 3 positions sur 3 mois | `audit_config.thresholds.drift_threshold` |

### Tiers de priorité

```typescript
function computePriorityTier(score: number): 1 | 2 | 3 {
  if (score >= 30) return 1; // critique
  if (score >= 15) return 2; // important
  return 3;                  // mineur
}
```

---

## 6. Pipeline d'exécution — 6 étapes

### Étape 1 — Snapshot GSC + GA4

**Fréquence** : hebdomadaire (cron lundi 06:00 UTC)
**Script** : `src/scripts/run-snapshot.ts`

**Ce que fait le script** :
1. Calcule la fenêtre : `[today - 3 mois, today]`
2. Pour GSC :
   - Appelle `searchanalytics.query` avec `dimensions=['page']` → insert dans `gsc_page_snapshots`
   - Pour chaque page avec impressions ≥ 100, appelle `searchanalytics.query` avec `dimensions=['page','query']` → insert dans `gsc_query_snapshots`
3. Pour GA4 :
   - Appelle `runReport` avec `dimensions=['pagePath']`, `metrics=['sessions','averageSessionDuration','screenPageViewsPerSession','scrolledUsers','bounceRate']` → insert dans `ga4_page_snapshots`
4. **Idempotence** : `unique (page, period_start, period_end)` → en cas de re-run, upsert.

**Pseudo-code** :

```typescript
import { google } from 'googleapis';

async function runSnapshot() {
  const today = new Date();
  const periodEnd = startOfDay(today);
  const periodStart = subMonths(periodEnd, 3);

  // 1. GSC pages
  const pagesData = await gscClient.searchanalytics.query({
    siteUrl: GSC_PROPERTY_URL,
    requestBody: {
      startDate: format(periodStart, 'yyyy-MM-dd'),
      endDate: format(periodEnd, 'yyyy-MM-dd'),
      dimensions: ['page'],
      rowLimit: 5000,
    },
  });
  await supabase.from('gsc_page_snapshots').upsert(
    pagesData.rows.map(row => ({
      page: row.keys[0],
      period_start: format(periodStart, 'yyyy-MM-dd'),
      period_end: format(periodEnd, 'yyyy-MM-dd'),
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.ctr,
      avg_position: row.position,
    })),
    { onConflict: 'page,period_start,period_end' }
  );

  // 2. GSC queries pour chaque page significative
  // (boucler sur pages avec impressions > 100)
  // ...

  // 3. GA4
  // ...
}
```

### Étape 2 — Compute findings

**Fréquence** : hebdomadaire, juste après snapshot
**Script** : `src/scripts/run-audit.ts`

**Ce que fait le script** :
1. Crée un `audit_runs` avec status='running'
2. Récupère le dernier snapshot par page
3. Pour chaque page :
   - Calcule `ctr_expected` à partir du benchmark de sa position
   - Calcule `ctr_gap = (ctr_expected - ctr_actual) / ctr_expected`
   - Calcule `position_drift` vs snapshot d'il y a 3 mois (si dispo)
   - Calcule `priority_score` (cf. section 7)
4. Filtre selon les seuils (`min_impressions`, `ctr_gap_threshold`, `position_range`)
5. Pour chaque finding retenu, alterne `treatment` / `control`
6. Insert dans `audit_findings` avec status='pending'
7. Update `audit_runs.findings_count`, completed_at, status='completed'

### Étape 3 — Pull current state via Wix

**Pour chaque finding** (status='pending') :
1. Identifie l'ID Wix du page/article correspondant à l'URL
2. Récupère via Wix API : title SEO, meta description, H1, premier paragraphe (~100 mots), schema JSON-LD, liens internes sortants
3. Stocke dans `audit_findings.current_state`
4. Update status → ne change pas encore (reste 'pending' jusqu'au diagnostic)

### Étape 4 — Diagnostic LLM

**Pour chaque finding** (status='pending', current_state IS NOT NULL) :
1. Récupère le top 10 requêtes pour la page depuis `gsc_query_snapshots`
2. Récupère l'engagement GA4 depuis `ga4_page_snapshots`
3. Construit le prompt diagnostic (cf. section 8)
4. Appelle Claude Sonnet 4.6
5. Parse la réponse JSON, valide avec Zod
6. Insert dans `audit_findings.diagnostic`
7. Update status → 'diagnosed'

### Étape 5 — Génération de fixes

**Pour chaque finding** (status='diagnosed') :
1. Construit le prompt fix-generation à partir du diagnostic
2. Appelle Claude Sonnet 4.6
3. Parse la réponse JSON (fixes structurés)
4. Pour chaque type de fix (title, meta, intro, etc.), insert dans `proposed_fixes` avec status='draft'
5. Update finding status → 'proposed'

### Étape 6 — Création de l'issue GitHub

**Pour chaque finding** (status='proposed') :
1. Construit le markdown de l'issue (cf. section 9)
2. Appelle GitHub API `POST /repos/{owner}/{repo}/issues`
3. Labels : `seo-audit`, `priority-{tier}`, `{treatment|control}`, `status:proposed`
4. Stocke `issue_number` et `issue_url` dans `audit_findings`
5. Le finding reste status='proposed' jusqu'à ce qu'un humain le passe à 'reviewed' ou 'ignored' (via la fermeture/labels de l'issue)

---

## 7. Logique d'audit (formules)

### Calcul du `ctr_expected`

```typescript
function getCtrExpected(position: number, benchmarks: Record<string, number>): number {
  const rounded = Math.round(position);
  if (rounded <= 1) return benchmarks['1'];
  if (rounded >= 15) return benchmarks['15'];
  // Interpolation linéaire entre les positions entières
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return benchmarks[String(lower)];
  const lowerCtr = benchmarks[String(lower)];
  const upperCtr = benchmarks[String(upper)];
  const fraction = position - lower;
  return lowerCtr + (upperCtr - lowerCtr) * fraction;
}
```

### Calcul du `ctr_gap`

```typescript
function computeCtrGap(actual: number, expected: number): number {
  if (expected === 0) return 0;
  return Math.max(0, (expected - actual) / expected);
}
```

### Calcul du `priority_score`

```typescript
function computePriorityScore(
  impressions: number,
  ctrGap: number,
  position: number,
  positionDrift: number | null,
  engagementPenalty: number = 0
): number {
  const positionWeight = (position >= 5 && position <= 15) ? 1.0 : 0.3;
  const driftBonus = positionDrift && positionDrift > 3 ? 1.5 : 1.0;
  const baseScore = Math.log10(Math.max(impressions, 1)) * ctrGap * 100 * positionWeight * driftBonus;
  return Math.round(baseScore * (1 + engagementPenalty) * 100) / 100;
}
```

`engagementPenalty` (de 0 à 0.5) ajouté si :
- pages_per_session < 1.3 → +0.15
- avg_session_duration < 30s → +0.20
- scroll_depth < 50% → +0.15

### Assignation treatment/control

```typescript
function assignGroup(rankByScore: number): 'treatment' | 'control' {
  // Alternance stricte sur la liste triée par priority_score desc
  return rankByScore % 2 === 0 ? 'treatment' : 'control';
}
```

---

## 8. Prompts LLM (diagnostic + fixes)

### Prompt diagnostic (`src/prompts/diagnostic.v1.ts`)

```typescript
export const DIAGNOSTIC_PROMPT_V1 = `Tu es un consultant SEO senior expert en NavBoost et signaux de clic Google. Analyse cette page sous-performante et produis un diagnostic structuré.

# Page analysée
URL : {{url}}
Position moyenne : {{avg_position}}
Position drift (3 mois) : {{position_drift}}
Impressions/mois : {{impressions_monthly}}
CTR actuel : {{ctr_actual}}%
CTR attendu pour cette position : {{ctr_expected}}%
Gap : {{ctr_gap_pct}}%

# Engagement (GA4)
Pages/session : {{pages_per_session}}
Durée moyenne : {{avg_duration_seconds}}s
Scroll depth : {{scroll_depth}}%

# État actuel de la page
**Title** : {{current_title}}
**Meta description** : {{current_meta}}
**H1** : {{current_h1}}
**Intro (100 premiers mots)** : {{current_intro}}

# Top 10 requêtes (3 derniers mois)
{{top_queries_table}}

# Ta mission
Produis un diagnostic JSON strict avec ce schéma :

{
  "intent_mismatch": "Décris en 1-3 phrases si le title/meta/H1 ne correspondent pas à l'intention dominante des top requêtes. Cite les requêtes concernées.",
  "snippet_weakness": "Décris en 1-3 phrases pourquoi le snippet (title + meta) ne convertit pas les impressions en clics. Sois précis : trop générique ? Pas de bénéfice ? Pas de signal de spécificité ? Concurrent plus fort ?",
  "hypothesis": "Une seule phrase : ton hypothèse principale du sous-CTR.",
  "top_queries_analysis": [
    {
      "query": "string",
      "impressions": number,
      "ctr": number,
      "position": number,
      "intent_match": "yes" | "partial" | "no",
      "note": "courte note"
    }
  ],
  "engagement_diagnosis": "Si pages_per_session < 1.3 ou duration < 30s ou scroll < 50%, explique ce que ça signale. Sinon: 'engagement satisfaisant'."
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
```

### Prompt fix-generation (`src/prompts/fix-generation.v1.ts`)

```typescript
export const FIX_GENERATION_PROMPT_V1 = `Tu es un copywriter SEO expert pour cabinets d'avocats. Sur la base du diagnostic suivant, propose des fixes concrets pour corriger le sous-CTR de cette page.

# Contexte de la page
URL : {{url}}
Top requêtes : {{top_queries}}
Position : {{position}}
État actuel :
- Title : {{current_title}}
- Meta : {{current_meta}}
- H1 : {{current_h1}}
- Intro : {{current_intro}}

# Diagnostic
{{diagnostic_json}}

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
      "current_value": "{{current_title}}",
      "proposed_value": "string ≤60 chars",
      "rationale": "1-2 phrases : pourquoi ce titre, quelle requête il vise, quel angle"
    },
    {
      "fix_type": "meta_description",
      "current_value": "{{current_meta}}",
      "proposed_value": "string ≤155 chars",
      "rationale": "..."
    },
    {
      "fix_type": "intro",
      "current_value": "{{current_intro}}",
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
```

### Versioning des prompts

À chaque modification, incrémenter la version et insérer dans `prompt_versions` :

```sql
insert into prompt_versions (prompt_name, version, template, notes, active)
values ('diagnostic', 2, '...nouveau template...', 'V2: ajout du engagement_diagnosis', true);

update prompt_versions set active = false where prompt_name = 'diagnostic' and version = 1;
```

A/B test : assigner aléatoirement la moitié des findings à v1 et l'autre à v2 sur un cycle d'audit, comparer les outcomes à T+30.

---

## 9. Format des issues GitHub

### Title

```
[SEO-P{tier}] {page_path_short} — CTR {ctr_actual}% vs {ctr_expected}% en pos. {position}
```

Exemples :
- `[SEO-P1] /violences-conjugales/ordonnance-de-protection — CTR 1.8% vs 6.5% en pos. 5.2`
- `[SEO-P2] /droit-penal-affaires/abus-de-biens-sociaux — CTR 2.1% vs 4.0% en pos. 7.4`

### Body (template Markdown)

````markdown
## 📊 Diagnostic

| Métrique | Valeur |
|---|---|
| **Page** | [{{page}}]({{full_url}}) |
| **Position moyenne (3 mois)** | {{avg_position}} |
| **Drift** | {{position_drift}} positions sur 3 mois |
| **Impressions/mois** | {{impressions_monthly}} |
| **CTR actuel** | {{ctr_actual}}% |
| **CTR attendu (benchmark)** | {{ctr_expected}}% |
| **Gap** | **{{ctr_gap_pct}}%** sous benchmark |
| **Priority score** | {{priority_score}} (tier {{tier}}) |
| **Groupe expérimental** | `{{group}}` |

### Engagement (GA4, 3 mois)

| Signal | Valeur | Interprétation |
|---|---|---|
| Pages/session | {{pages_per_session}} | {{ppss_interpretation}} |
| Durée moyenne | {{avg_duration}}s | {{duration_interpretation}} |
| Scroll depth | {{scroll_depth}}% | {{scroll_interpretation}} |

---

## 🔍 Hypothèse principale

> {{diagnostic.hypothesis}}

### Intent mismatch détecté

{{diagnostic.intent_mismatch}}

### Faiblesse du snippet

{{diagnostic.snippet_weakness}}

### Diagnostic engagement

{{diagnostic.engagement_diagnosis}}

---

## 🔎 Top 5 requêtes

| Requête | Impressions | CTR | Position | Intent match |
|---|---|---|---|---|
{{top_queries_rows}}

---

## 🛠 Fixes proposés

### 1. Title

**Actuel** :
```
{{current_title}}
```

**Proposé** :
```
{{proposed_title}}
```

**Pourquoi** : {{title_rationale}}

---

### 2. Meta description

**Actuel** :
```
{{current_meta}}
```

**Proposé** :
```
{{proposed_meta}}
```

**Pourquoi** : {{meta_rationale}}

---

### 3. Intro (first screen, ≤100 mots)

**Actuel** :
> {{current_intro}}

**Proposé** :
> {{proposed_intro}}

**Pourquoi** : {{intro_rationale}}

---

### 4. Maillage interne

{{internal_links_proposals}}

**Pourquoi** : {{links_rationale}}

---

## 📅 Cycle de mesure

- **T0 (baseline)** : {{snapshot_date}}
- **T+30 mesure 1** : prévue le {{t30_date}}
- **T+60 mesure 2** : prévue le {{t60_date}}

## 🏷 Workflow

- [ ] Reviewed (cocher pour valider les fixes proposés)
- [ ] Applied (cocher après push Wix)
- [ ] Measured T+30
- [ ] Measured T+60

## 🔗 Refs

- Audit run ID : `{{audit_run_id}}`
- Finding ID : `{{finding_id}}`
- Supabase : [voir le finding]({{supabase_url}})
````

### Labels

- `seo-audit` (label permanent sur toutes les issues)
- `priority-1` / `priority-2` / `priority-3`
- `treatment` ou `control`
- `status:proposed` → `status:reviewed` → `status:applied` → `status:measured`

### Hooks GitHub → Supabase

GitHub Action sur `issues.labeled` qui met à jour `audit_findings.status` quand un label `status:*` change.

---

## 10. Application des fixes via Wix

### Identification de la page Wix

Wix Headless / API attend un `pageId` ou `slug`. Stratégie :
1. Au snapshot, mapper chaque URL GSC à son `pageId` Wix via Wix `Pages` API
2. Stocker dans une table `wix_page_mapping (url, page_id, slug, last_synced_at)`
3. Au moment d'apply, lookup direct

### Endpoints Wix utilisés

- **Read** : `GET /pages/{pageId}` → récupère SEO settings
- **Update SEO** : `PATCH /pages/{pageId}/seo` → title, meta, schema
- **Update content** : nécessite Wix CMS API selon le type de page (blog post vs static)

### Logique d'application

```typescript
async function applyFix(proposedFixId: string, applyAuthor: string) {
  const fix = await getProposedFix(proposedFixId);
  const finding = await getFinding(fix.finding_id);
  const wixPageId = await getWixPageId(finding.page);

  let wixResponse;
  switch (fix.fix_type) {
    case 'title':
      wixResponse = await wixClient.pages.updateSeo(wixPageId, { title: fix.proposed_value });
      break;
    case 'meta_description':
      wixResponse = await wixClient.pages.updateSeo(wixPageId, { description: fix.proposed_value });
      break;
    case 'intro':
      // Update CMS content → spécifique au type de page
      wixResponse = await wixClient.cms.updateField(wixPageId, 'intro', fix.proposed_value);
      break;
    // etc.
  }

  await supabase.from('applied_fixes').insert({
    proposed_fix_id: proposedFixId,
    applied_by: applyAuthor,
    wix_response: wixResponse,
  });

  await supabase.from('proposed_fixes').update({ status: 'applied' }).eq('id', proposedFixId);
}
```

### Garde-fous obligatoires

1. **Jamais d'apply automatique** : toujours via revue humaine (GitHub label `status:reviewed` → bouton "Apply" dans dashboard, ou commande CLI manuelle)
2. **Backup avant apply** : snapshot du `current_state` complet dans `applied_fixes.wix_response` (pour rollback)
3. **Rate limiting** : max 5 fixes appliqués par jour pour pouvoir mesurer proprement
4. **Pas de batch sur des findings du même groupe** : alterner treatment/control dans le rythme de déploiement

---

## 11. Mesure d'impact & groupe de contrôle

### Pourquoi un groupe de contrôle

Sans contrôle, impossible de distinguer le lift de tes fixes du bruit (saisonnalité, core update Google, fluctuations naturelles).

### Comment

À l'étape 2 (compute findings), trier par `priority_score` desc, puis assigner alternativement `treatment` / `control`. Tu obtiens deux groupes de findings comparables.

- **Treatment** : fixes appliqués
- **Control** : finding identifié, issue créée avec label `control`, mais **fixes pas appliqués** pendant 4 semaines minimum

### Mesure

À T+30 et T+60, script `src/scripts/run-measure.ts` :
1. Pour chaque finding `status='applied'`, récupère le snapshot GSC le plus récent vs baseline (= snapshot au moment du finding)
2. Calcule `ctr_delta_pct` et `position_delta`
3. Insert dans `fix_outcomes`
4. Update finding status → 'measured'
5. Compute aggregate via la vue `v_treatment_vs_control`

### Critères de succès

Un fix est considéré comme **réussi** si, à T+30 ou T+60 :
- `ctr_delta_pct ≥ +15%` (vs baseline) **ET**
- `(traitement avg) - (contrôle avg) ≥ +10%` sur le même horizon

### Rollback

Si un fix dégrade (`ctr_delta_pct ≤ -10%` à T+30), créer une issue auto avec label `regression`, et permettre rollback via `applied_fixes.rolled_back_at`.

---

## 12. Roadmap d'implémentation par sprints

### Sprint 0 — Bootstrap (½ journée)

- [ ] Créer le repo `plouton-seo-audit` sur GitHub
- [ ] Init du projet TypeScript + dépendances
- [ ] Setup `.env.example`, `.gitignore`
- [ ] Créer le projet Supabase (ou utiliser un projet existant)
- [ ] Configurer toutes les variables d'env
- [ ] Documenter dans le README

### Sprint 1 — Schéma DB + connecteurs (1 jour)

- [ ] Migration Supabase initiale (cf. section 4)
- [ ] Module `lib/supabase.ts` (client initialisé)
- [ ] Module `lib/anthropic.ts`
- [ ] Module `lib/github.ts`
- [ ] Module `lib/gsc.ts` (auth OAuth + wrapper searchanalytics.query)
- [ ] Module `lib/ga4.ts` (auth OAuth + wrapper runReport)
- [ ] Module `lib/wix.ts` (auth + wrappers pages/seo, cms)
- [ ] Test smoke : vérifier que chaque connecteur récupère bien des données réelles

### Sprint 2 — Snapshot job (½ jour)

- [ ] `pipeline/snapshot.ts` complet (GSC pages + queries + GA4)
- [ ] Script `scripts/run-snapshot.ts`
- [ ] GitHub Action `snapshot-weekly.yml` (cron lundi 06:00 UTC)
- [ ] Test : exécuter manuellement, vérifier les 3 tables remplies

### Sprint 3 — Compute findings (½ jour)

- [ ] `pipeline/compute-findings.ts` (formules section 7)
- [ ] Logique d'assignation treatment/control
- [ ] Script `scripts/run-audit.ts`
- [ ] Test : sur les snapshots existants, vérifier que les findings tombent bien et que les seuils sont respectés

### Sprint 4 — Diagnostic + fixes via LLM (1 jour)

- [ ] `pipeline/pull-current-state.ts` (Wix read)
- [ ] `prompts/diagnostic.v1.ts`
- [ ] `pipeline/diagnose.ts` (Claude call + Zod validation)
- [ ] `prompts/fix-generation.v1.ts`
- [ ] `pipeline/generate-fixes.ts`
- [ ] Test : sur 3 findings, valider la qualité du diagnostic et des fixes

### Sprint 5 — Issues GitHub (½ jour)

- [ ] Template Markdown (cf. section 9)
- [ ] `pipeline/create-issues.ts`
- [ ] GitHub Action `audit-weekly.yml` qui chaîne snapshot → audit → diagnose → fixes → issues
- [ ] Test : 1 issue créée bout-en-bout

### Sprint 6 — Apply + mesure (1 jour)

- [ ] `pipeline/apply-fixes.ts`
- [ ] CLI ou mini dashboard pour reviewer les fixes proposés et déclencher l'apply
- [ ] `pipeline/measure.ts`
- [ ] GitHub Action `measure-outcomes.yml` (cron quotidien qui check les findings T+30 et T+60)
- [ ] Test : appliquer 1 fix manuellement, vérifier le tracking

### Sprint 7 (optionnel) — Dashboard (1-2 jours)

- [ ] App Vite/React (template `rewolf-starter`) connectée à Supabase
- [ ] Vues : findings list, finding detail, treatment vs control, top fixes performants
- [ ] Bouton "Apply" qui déclenche le pipeline d'application

### Sprint 8 (continu) — Itération prompts

- [ ] À chaque cycle de mesure (mensuel), analyser les outcomes
- [ ] Identifier les types de fixes qui marchent / qui ratent
- [ ] Itérer sur les prompts (v2, v3...)
- [ ] A/B test sur 2 versions en parallèle

---

## 13. Checklist de démarrage

### Avant de lancer Claude Code

- [ ] Créer le repo GitHub `plouton-seo-audit` (vide, README + ROADMAP.md uniquement)
- [ ] Ouvrir l'accès à un projet Supabase (existant ou nouveau)
- [ ] Récupérer toutes les credentials (cf. variables d'env section 2)
- [ ] Vérifier que les MCPs suivants sont actifs dans Claude Code :
  - GitHub
  - Supabase
  - Wix
  - GSC (OAuth direct ou via Ahrefs)
  - GA4 (à configurer si pas déjà fait)
- [ ] Cloner le repo localement, créer une branche `feat/initial-pipeline`

### Premier prompt à Claude Code

Une fois le repo cloné et ce ROADMAP.md déposé dedans, dans une nouvelle conversation Claude Code :

> Lis `ROADMAP.md` à la racine. Exécute le **Sprint 0 et Sprint 1** : bootstrap du projet TypeScript, dépendances, schéma Supabase, modules de connexion (`lib/*`). Vérifie chaque connecteur en faisant un appel test. Liste-moi à la fin ce qui marche et ce qui bloque.

Puis sprint par sprint, dans des conversations distinctes pour garder le contexte clair.

---

## 14. Instructions pour Claude Code

### Comportement attendu

- **Tu travailles itérativement** : ne tente pas de tout faire en un seul prompt. Sprint par sprint.
- **Tu testes chaque module avant de passer au suivant**. Un appel API doit fonctionner avant qu'on l'intègre dans le pipeline.
- **Tu commit fréquemment** avec des messages clairs : `feat: gsc snapshot pipeline`, `chore: add supabase migration`, etc.
- **Tu n'appliques jamais de fix automatiquement sur Wix** sans validation humaine explicite.
- **Tu valides les schémas LLM avec Zod** avant insertion en DB.
- **Tu logs proprement** chaque appel API avec rate-limiting handling.

### Conventions de code

- TypeScript strict mode
- Pas de `any` — typer correctement (Zod pour les payloads externes)
- Async/await partout, pas de `.then()`
- Erreurs typées (classe `AuditError` avec sous-types)
- Logs via `pino` ou similaire, JSON structuré

### Sécurité

- Service role key Supabase **uniquement côté server** (jamais en frontend)
- Tokens GSC/GA4/Wix chiffrés au repos via Supabase Vault
- RLS activé sur toutes les tables de findings/fixes
- Pas de secrets dans le repo (seulement `.env.example`)

### Tests à écrire

- Unit : formules de scoring (`computePriorityScore`, `getCtrExpected`)
- Integration : chaque pipeline step en isolation avec mocks
- E2E : un audit complet sur un sous-ensemble de 5 pages (env de staging)

### Quand demander confirmation

- Avant le premier `apply` sur Wix (toujours)
- Avant de modifier le schéma DB (migration)
- Avant de créer plus de 10 issues GitHub d'un coup (rate limit + contrôle qualité)
- Si un finding a un `priority_score` anormalement haut (> 100) → suspect, demander revue

---

## Fin du roadmap

Ce document est exécutable bout-en-bout par un agent Claude Code avec les MCPs listés. Chaque sprint est conçu pour tenir dans une conversation Claude Code distincte (~½ à 1 jour de travail à chaque fois).

**Version** : 1.0
**Date** : 2026-05-06
**Maintenu par** : REWOLF
