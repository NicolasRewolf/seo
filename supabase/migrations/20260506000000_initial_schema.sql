-- ============================================================
-- REWOLF · Plouton SEO Audit Tool — Initial Schema
-- Migration: 20260506_initial_schema
-- Source: ROADMAP.md §4
-- ============================================================

-- Extensions ---------------------------------------------------
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

insert into audit_config (key, value, description) values
  ('ctr_benchmarks_by_position', '{
    "1": 0.30, "2": 0.16, "3": 0.11, "4": 0.08, "5": 0.065,
    "6": 0.05, "7": 0.04, "8": 0.035, "9": 0.03, "10": 0.025,
    "11": 0.02, "12": 0.018, "13": 0.015, "14": 0.013, "15": 0.012
  }'::jsonb, 'Benchmarks CTR moyens par position SERP en 2026 (hors AI Overview)'),
  ('thresholds', '{
    "min_impressions_monthly": 500,
    "ctr_gap_threshold": 0.4,
    "position_min": 5,
    "position_max": 15,
    "drift_threshold": 3
  }'::jsonb, 'Seuils de détection des findings'),
  ('audit_period_months', '3'::jsonb, 'Fenêtre d''analyse en mois');

-- ============================================================
-- 2. SNAPSHOTS GSC
-- ============================================================
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
  config_snapshot jsonb,
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

  impressions int not null,
  ctr_actual numeric(6,4) not null,
  ctr_expected numeric(6,4) not null,
  ctr_gap numeric(5,4) not null,
  avg_position numeric(5,2) not null,
  position_drift numeric(5,2),
  priority_score numeric(8,2) not null,
  priority_tier int check (priority_tier in (1, 2, 3)),

  pages_per_session numeric(5,2),
  avg_session_duration_seconds int,
  scroll_depth_avg numeric(5,2),

  group_assignment text check (group_assignment in ('treatment','control')),

  current_state jsonb,
  diagnostic jsonb,

  github_issue_number int,
  github_issue_url text,

  status text default 'pending' check (status in (
    'pending',
    'diagnosed',
    'proposed',
    'reviewed',
    'applied',
    'measured',
    'ignored',
    'failed'
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
  days_after_fix int not null,
  baseline_ctr numeric(6,4),
  current_ctr numeric(6,4),
  ctr_delta_pct numeric(6,2),
  baseline_position numeric(5,2),
  current_position numeric(5,2),
  position_delta numeric(5,2),
  baseline_impressions int,
  current_impressions int,
  significance_note text
);

-- ============================================================
-- 9. PROMPT VERSIONING
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
-- 10. WIX PAGE MAPPING (cf. ROADMAP §10)
-- ============================================================
create table wix_page_mapping (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  page_id text not null,
  slug text,
  page_type text,
  last_synced_at timestamptz default now()
);
create index wix_page_mapping_url_idx on wix_page_mapping (url);

-- ============================================================
-- 11. VUES UTILES
-- ============================================================
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
alter view v_pending_findings set (security_invoker = true);

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
alter view v_treatment_vs_control set (security_invoker = true);

-- ============================================================
-- 12. ROW-LEVEL SECURITY (service-role bypass; no public access)
-- ============================================================
alter table audit_config enable row level security;
alter table gsc_page_snapshots enable row level security;
alter table gsc_query_snapshots enable row level security;
alter table ga4_page_snapshots enable row level security;
alter table audit_runs enable row level security;
alter table audit_findings enable row level security;
alter table proposed_fixes enable row level security;
alter table applied_fixes enable row level security;
alter table fix_outcomes enable row level security;
alter table prompt_versions enable row level security;
alter table wix_page_mapping enable row level security;
