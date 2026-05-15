# 06 — Base de données Supabase

Projet Supabase **Seo** (`lzdnljppbenqoflyxbhi`, eu-west-3). Postgres 17 avec RLS partout (service-role bypass exclusif).

## Vue d'ensemble des tables

| Table | Rôle | Cardinalité | Écrit par |
|---|---|---|---|
| `audit_config` | Constantes (CTR benchmarks, seuils) | ~3 rows | Migration initiale + manuel |
| `audit_runs` | 1 row par run du pipeline | ~1/semaine | `pipeline/snapshot.ts` |
| `gsc_page_snapshots` | Snapshot GSC par page par audit | ~300 / run | `pipeline/snapshot.ts` |
| `gsc_query_snapshots` | Snapshot GSC par (page, query) par audit | ~5000 / run | `pipeline/snapshot.ts` |
| `behavior_page_snapshots` | Snapshot Cooked CWV + behavior par page (Sprint 8 — anciennement `ga4_page_snapshots`) | ~250 / run | `pipeline/snapshot.ts` |
| `audit_findings` | LE table central. 1 row par finding identifiée. | ~17 / run | `pipeline/compute-findings.ts` (insert) → `pipeline/pull-current-state.ts` (update) → `pipeline/diagnose.ts` (update) → `pipeline/create-issues.ts` (update) |
| `proposed_fixes` | Fixes générés par le LLM | ~6-8 par finding | `pipeline/generate-fixes.ts` |
| `applied_fixes` | Signal manuel "fix appliqué" | 1 par fix appliqué | `pipeline/mark-applied.ts` |
| `fix_outcomes` | Mesures T+30 / T+60 vs baseline | 1 par finding par milestone | `pipeline/measure.ts` |
| `internal_link_graph` | Graph d'autorité interne (Sprint 9) | ~2500 rows | `pipeline/crawl-internal-links.ts` |
| `v_internal_link_summary` | View aggregée du graph par page-target | View (computed) | — |

---

## Le table central : `audit_findings`

C'est le pivot du pipeline. Chaque étape l'enrichit en updatant des champs.

### Schema

```sql
create table audit_findings (
  id uuid primary key,
  audit_run_id uuid references audit_runs(id),
  page text not null,
  
  -- Computed by audit (étape 2)
  impressions int,
  ctr_actual numeric,
  ctr_expected numeric,
  ctr_gap numeric,
  avg_position numeric,
  position_drift numeric,
  priority_score numeric,
  priority_tier int,             -- 1, 2, 3
  group_assignment text,         -- 'treatment' | 'control'
  
  -- Behavior fallback (Cooked at audit time, used as fallback in box rendering)
  pages_per_session numeric,
  avg_session_duration_seconds int,
  scroll_depth_avg numeric,
  scroll_complete_pct numeric,
  outbound_clicks int,
  
  -- CWV fallback (Cooked at audit time)
  lcp_p75_ms numeric,
  inp_p75_ms numeric,
  cls_p75 numeric,
  ttfb_p75_ms numeric,
  
  -- Filled by pull-current-state (étape 3)
  current_state jsonb,           -- title, meta, h1, intro_first_100_words, internal_links_outbound, schema_jsonld
  content_snapshot jsonb,        -- Sprint 14 — body, outline, images, CTAs, author (immutable)
  
  -- Filled by diagnose (étape 4)
  diagnostic jsonb,              -- 16 sections du LLM v11 output
  diagnostic_fact_check jsonb,   -- Sprint 14bis — { total, verified, unverified[], passed, retry_attempted }
  
  -- Filled by issues (étape 6)
  github_issue_number int,
  github_issue_url text,
  
  -- Lifecycle
  status text,                   -- 'pending' | 'diagnosed' | 'proposed' | 'applied' | 'measured'
  created_at timestamptz,
  updated_at timestamptz
);
```

### Lifecycle des status

```
pending      ← compute-findings (audit step)
diagnosed    ← diagnose
proposed     ← generate-fixes
applied      ← mark-applied (manual)
measured     ← measure (T+30 ou T+60)
```

### Pourquoi `current_state` et `content_snapshot` sont en JSONB

Pour la **mesure d'impact T+30 / T+60**. Quand on compare "avant" vs "après", on a besoin que le "avant" soit immuable. Si on stockait le `current_state` dans des colonnes séparées et qu'on les overwrite à chaque pull-state, on perdrait la baseline.

JSONB offre :
- Un seul write, immuable post-insert (idempotence : `pull-state` skip si `current_state IS NOT NULL`)
- Lecture structurée (Zod parse `current_state` au moment du diag)
- Cf. `supabase/migrations/20260507180000_content_snapshot.sql` pour le commentaire qui explique cette discipline

---

## Tables de snapshots GSC

```sql
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
```

`gsc_query_snapshots` est similaire mais avec `(page, query)` comme clé.

**Unicité** : `unique (page, period_start, period_end)` — `snapshot.ts` est idempotent grâce à ça (pas de doublon si tu relances).

---

## Table de snapshots Cooked behavior

`behavior_page_snapshots` (renommée depuis `ga4_page_snapshots` au Sprint 8) : 1 row par (page, period). Stockage des chiffres Cooked au moment du snapshot pour scoring.

**Note** : le `audit_findings.pages_per_session`, `lcp_p75_ms`, etc. sont copiés depuis `behavior_page_snapshots` au moment de l'audit. Mais le diag prompt utilise `cooked_extras` LIVE (pas la copie figée), via `fetchPageSnapshotExtras()`. Donc :
- `audit_findings.lcp_p75_ms` = LCP au moment du audit (snapshot frozen)
- `cooked_extras.cwv_28d.lcp_p75_ms` (live à diag time) = LCP fresh (peut différer si Cooked refresh entre temps)

Le rendering issue priorise `cooked_extras` quand dispo, fallback sur la col `audit_findings.lcp_p75_ms`. Cf. `src/prompts/issue-template.ts:renderIssueBody()` cellules CWV.

---

## Table `proposed_fixes`

```sql
create table proposed_fixes (
  id uuid primary key,
  finding_id uuid references audit_findings(id),
  fix_type text not null,        -- 'title' | 'meta_description' | 'h1' | 'intro' | 'schema' | 'internal_links' | 'content_addition'
  current_value text,
  proposed_value text not null,
  rationale text,
  status text default 'draft',   -- 'draft' | 'applied'
  created_at timestamptz default now()
);
```

**Idempotence** : `generate-fixes.ts` fait `delete where finding_id=X and status='draft'` puis insert. Les fixes `applied` (manual signal via `mark-applied.ts`) sont préservés.

---

## Table `applied_fixes`

```sql
create table applied_fixes (
  id uuid primary key,
  finding_id uuid references audit_findings(id),
  applied_by text,
  applied_at timestamptz default now(),
  notes text
);
```

**1 row par fois où Nicolas signale un apply.** Si plusieurs fixes appliqués sur le même finding, plusieurs rows. Le `applied_at` du PREMIER row est le T0 de référence pour les mesures T+30 / T+60.

---

## Table `fix_outcomes`

```sql
create table fix_outcomes (
  id uuid primary key,
  finding_id uuid references audit_findings(id),
  days_after_fix int,            -- 30 | 60
  measured_at timestamptz,
  applied_at timestamptz,        -- copied from applied_fixes (1st row)
  
  ctr_baseline numeric,
  ctr_measured numeric,
  ctr_delta_pct numeric,         -- (measured - baseline) / baseline * 100
  
  position_baseline numeric,
  position_measured numeric,
  position_delta numeric,        -- (measured - baseline) — négatif = mieux
  
  impressions_baseline int,
  impressions_measured int,
  impressions_delta_pct numeric,
  
  unique (finding_id, days_after_fix)
);
```

**Unicité** : `unique (finding_id, days_after_fix)` — pas de doublon T+30 ou T+60 par finding.

---

## Table `internal_link_graph` (Sprint 9)

```sql
create table internal_link_graph (
  id bigserial primary key,
  source_path text not null,      -- la page qui contient le lien
  target_path text not null,      -- la page cible
  anchor_text text,
  placement text,                 -- 'editorial' | 'related' | 'cta' | 'nav' | 'footer' | 'image'
  crawled_at timestamptz default now()
);
create index ilg_target_idx on internal_link_graph (target_path);
create index ilg_source_idx on internal_link_graph (source_path);
```

**Idempotence** : `crawl-internal-links.ts` fait `delete where source_path=X` pour chaque source crawlée, puis insert.

### View `v_internal_link_summary`

Aggrégation par target_path :

```sql
create view v_internal_link_summary as
select
  target_path as page,
  count(*) as inbound_total,
  count(distinct source_path) as inbound_distinct_sources,
  count(*) filter (where placement = 'editorial') as inbound_editorial,
  count(*) filter (where placement in ('nav', 'footer')) as inbound_nav_footer,
  -- ...
from internal_link_graph
group by target_path;
```

Le diag query cette view via `fetchInboundSummary(targetPath)`.

---

## Migrations

5 migrations dans `supabase/migrations/` :

| Date | Fichier | Sprint | Quoi |
|---|---|---|---|
| 2026-05-06 | `20260506000000_initial_schema.sql` | Sprint 1 | Schéma initial : audit_config, gsc_*, ga4_page_snapshots (sera renommée), audit_runs, audit_findings, proposed_fixes, applied_fixes, fix_outcomes |
| 2026-05-07 | `20260507000000_swap_ga4_to_behavior.sql` | Sprint 8 | Rename `ga4_page_snapshots` → `behavior_page_snapshots` (GA4 swappé pour Cooked) |
| 2026-05-07 | `20260507120000_internal_link_graph.sql` | Sprint 9 | Création `internal_link_graph` + view `v_internal_link_summary` |
| 2026-05-07 | `20260507180000_content_snapshot.sql` | Sprint 14 | Add column `audit_findings.content_snapshot jsonb` |
| 2026-05-08 | `20260508000000_diagnostic_fact_check.sql` | Sprint 14bis | Add column `audit_findings.diagnostic_fact_check jsonb` |

**Aucune migration depuis Sprint 14bis.** Les Sprints 15-19.5 n'ont nécessité aucun changement de schéma : tout passe par les RPCs Cooked + le JSONB `diagnostic`.

---

## RLS — Row Level Security

**Toutes les tables ont RLS activée.** Aucune policy n'est définie pour les rôles `anon` / `authenticated` → lecture/écriture impossible depuis un client public.

Le pipeline accède via **`SUPABASE_SERVICE_ROLE_KEY`** qui bypass RLS. Cette clé est :
- Server-side uniquement (jamais exposée côté frontend)
- Dans `.env` local (gitignored) + secrets GitHub Actions
- Pas de rotation automatique — à rotater manuellement si compromise

---

## Comment debugger une row

```bash
# Via Supabase Studio (web UI)
# https://supabase.com/dashboard/project/lzdnljppbenqoflyxbhi/editor

# Ou via SQL direct (depuis un script TS) :
import { supabase } from './src/lib/supabase.js';
const { data } = await supabase().from('audit_findings').select('*').eq('github_issue_number', 33).single();
console.log(data.diagnostic_fact_check);
```

Chaque issue GitHub a un lien direct vers la row Supabase dans le bloc "Refs" (cf. [05-issue-template.md](./05-issue-template.md) §15).

---

## Limites connues

- **Pas de partitioning** sur les tables historiques (gsc_*_snapshots, behavior_page_snapshots). Sur 1 an de runs hebdo on aura ~50 audit_runs × 300 pages = 15k rows, manageable. Sur 5 ans on devra penser à du archive.
- **Pas d'index sur `audit_findings.status`** — pour les batch scripts qui filtrent par status, c'est un seq scan. Acceptable sur 17 findings, à reconsidérer à 1k+.
- **`audit_findings.diagnostic` JSONB sans index GIN** — on ne fait pas de query sur le contenu du diag, c'est OK.
- **Cooked schema** vit dans le projet Supabase Cooked — pas accessible en migration depuis ce repo. Cf. [08-cooked-coordination.md](./08-cooked-coordination.md).
