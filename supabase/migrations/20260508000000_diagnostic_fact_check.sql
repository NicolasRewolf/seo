-- ============================================================
-- Sprint 14bis — diagnostic_fact_check column on audit_findings
--
-- Persists the fact-checker result for each diagnostic run. The
-- fact-checker (cf. src/lib/diagnostic-fact-check.ts) scans the LLM
-- diagnostic JSON for numeric claims (word count, H2 count, image
-- count, "X sans alt") and verifies each against the immutable
-- content_snapshot.
--
-- Cooked-agent flag (Sprint 14 §5 critère négatif) : "le risque
-- d'ajouter du contexte = le LLM se sent autorisé à inventer des
-- choses cohérentes-mais-fausses". This column makes the
-- "0 chiffre halluciné" guarantee auditable per finding instead
-- of theoretical.
--
-- Same immutability semantics as `diagnostic` : written once at
-- diagnose time, never updated after. If a finding is re-diagnosed
-- (e.g. prompt version bump), the column is overwritten.
-- ============================================================

alter table audit_findings
  add column if not exists diagnostic_fact_check jsonb;

comment on column audit_findings.diagnostic_fact_check is
  'Sprint-14bis: FactCheckResult from src/lib/diagnostic-fact-check.ts. Schema: {total_numeric_claims, verified, unverified[], passed, retry_attempted}.';
