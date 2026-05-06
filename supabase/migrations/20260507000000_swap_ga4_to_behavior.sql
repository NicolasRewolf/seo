-- ============================================================
-- Swap GA4 for Cooked first-party behavioral source.
-- ============================================================
-- 1. Renames `ga4_page_snapshots` → `behavior_page_snapshots` (data preserved).
-- 2. Adds Core Web Vitals + scroll-completion + outbound-click columns to
--    behavior_page_snapshots and audit_findings.
-- 3. Existing engagement columns (sessions, pages_per_session,
--    avg_session_duration_seconds, bounce_rate, scroll_depth_avg) are kept
--    so downstream consumers (compute-findings, measure) keep working
--    without a same-PR breaking change.
-- ============================================================

alter table ga4_page_snapshots rename to behavior_page_snapshots;
alter index ga4_snap_page_idx rename to behavior_snap_page_idx;

alter table behavior_page_snapshots
  add column if not exists scroll_complete_pct numeric(5,2),
  add column if not exists lcp_p75_ms numeric(7,1),
  add column if not exists inp_p75_ms numeric(7,1),
  add column if not exists cls_p75 numeric(5,3),
  add column if not exists ttfb_p75_ms numeric(7,1),
  add column if not exists outbound_clicks int;

alter table audit_findings
  add column if not exists scroll_complete_pct numeric(5,2),
  add column if not exists lcp_p75_ms numeric(7,1),
  add column if not exists inp_p75_ms numeric(7,1),
  add column if not exists cls_p75 numeric(5,3),
  add column if not exists ttfb_p75_ms numeric(7,1),
  add column if not exists outbound_clicks int;
