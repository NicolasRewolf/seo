-- ============================================================
-- Sprint 14 — content_snapshot column on audit_findings
--
-- Adds a JSONB column capturing the page's structured content at finding
-- time : full body text, outline (H2/H3/H4 with word offsets), images
-- with alt-text, author + dates (E-E-A-T signals), and CTA in-body
-- positions.
--
-- Replaces the old `current_state.intro_first_100_words` snapshot for
-- the LLM diagnostic v7 input — the LLM can finally reason on the full
-- article, not just the first 100 words.
--
-- Same immutability discipline as `current_state` : populated by
-- `pull-current-state.ts` once per finding at status='pending', never
-- updated after. Preserves T+30/T+60 attribution semantics.
--
-- Per Sprint-14 plan validated by the Cooked agent : single JSONB column
-- on `audit_findings` (no separate table). Avoids a JOIN for 100% of
-- consumers (`buildDiagnosticInputs`, `buildFixGenInputs`,
-- `create-issues`, `update-issue`). Content fits 5-50 KB / row in JSONB.
-- ============================================================

alter table audit_findings
  add column if not exists content_snapshot jsonb;

comment on column audit_findings.content_snapshot is
  'Sprint-14: full structured content at finding time. Schema: ContentSnapshot (cf. src/lib/page-content-extractor.ts). Immutable post-creation.';
