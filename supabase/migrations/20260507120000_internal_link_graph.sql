-- ============================================================
-- Sprint 9 — Internal link graph + crawl observability
--
-- Adds:
--   1. internal_link_graph     — every (source_path, target_path, anchor)
--                                edge captured during a sitemap crawl,
--                                tagged with structural placement.
--   2. crawl_runs              — per-crawl observability (start/end,
--                                attempt/success/fail counts, errors[]).
--   3. v_internal_link_summary — convenient per-page view: outbound
--                                count + inbound count + distinct
--                                linking pages.
--
-- Designed to power a "page authority" + "orphan detection" surface for
-- the diagnostic LLM without touching the existing audit_findings rows
-- (per ROADMAP §11 immutability of finding snapshots — current_state is
-- still snapshotted at pull time, the graph is queried live for inbound
-- only).
-- ============================================================

create table internal_link_graph (
  id            bigserial primary key,
  source_path   text not null,
  target_path   text not null,
  anchor_text   text,
  -- 'editorial' = inside <article>/<main> body
  -- 'related'   = inside Wix "posts similaires" block
  -- 'nav'       = header / nav role
  -- 'footer'    = footer / contentinfo role
  -- 'cta'       = explicit call-to-action button/link in body
  -- 'image'     = wraps an <img>, no editorial anchor text
  placement     text not null check (placement in (
    'editorial', 'related', 'nav', 'footer', 'cta', 'image'
  )),
  rel           text,                   -- nofollow / sponsored / ugc
  crawl_run_id  uuid,                   -- backref to crawl_runs (nullable for legacy)
  crawled_at    timestamptz default now(),
  unique (source_path, target_path, anchor_text)
);

create index internal_link_graph_source_idx on internal_link_graph (source_path);
create index internal_link_graph_target_idx on internal_link_graph (target_path);
create index internal_link_graph_placement_idx on internal_link_graph (placement);

alter table internal_link_graph enable row level security;
-- service-role bypasses RLS; intentionally no policies (audit-tool internal).

-- ------------------------------------------------------------
-- Per-page summary view: outbound count, inbound count, distinct
-- linking pages. Useful both for the diagnostic prompt and for
-- ad-hoc Supabase Studio inspection.
-- ------------------------------------------------------------
create or replace view v_internal_link_summary as
with outbound as (
  select source_path as page, count(*) as outbound_total
  from internal_link_graph
  group by source_path
),
inbound as (
  select target_path as page,
         count(*) as inbound_total,
         count(distinct source_path) as inbound_distinct_sources,
         count(*) filter (where placement = 'editorial') as inbound_editorial,
         count(*) filter (where placement in ('nav','footer')) as inbound_nav_footer
  from internal_link_graph
  group by target_path
)
select
  coalesce(o.page, i.page) as page,
  coalesce(o.outbound_total, 0) as outbound_total,
  coalesce(i.inbound_total, 0) as inbound_total,
  coalesce(i.inbound_distinct_sources, 0) as inbound_distinct_sources,
  coalesce(i.inbound_editorial, 0) as inbound_editorial,
  coalesce(i.inbound_nav_footer, 0) as inbound_nav_footer
from outbound o
full outer join inbound i on i.page = o.page;
alter view v_internal_link_summary set (security_invoker = true);

-- ============================================================
-- crawl_runs — observability per cron execution
-- ============================================================
create table crawl_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz default now(),
  completed_at    timestamptz,
  sitemap_url     text not null,
  urls_attempted  int default 0,
  urls_succeeded  int default 0,
  urls_failed     int default 0,
  links_inserted  int default 0,
  -- Per-failure detail: [{url, status_code, message, attempt_n}, …]
  errors          jsonb default '[]'::jsonb,
  status          text default 'running' check (status in (
    'running', 'completed', 'failed'
  ))
);

alter table crawl_runs enable row level security;

-- Backref FK from internal_link_graph.crawl_run_id → crawl_runs.id.
-- Kept nullable so historical/manual inserts don't break.
alter table internal_link_graph
  add constraint internal_link_graph_crawl_run_id_fkey
  foreign key (crawl_run_id) references crawl_runs(id) on delete set null;
