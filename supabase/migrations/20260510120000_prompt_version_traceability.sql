-- ============================================================
-- AMDEC fix M4 — prompt versioning traceability
--
-- La table `prompt_versions` existe depuis le schéma initial mais
-- n'a jamais été peuplée. La col `proposed_fixes.prompt_version_id`
-- existe aussi mais reste NULL → impossible de répondre à
-- "ce diag/fix a été généré par quelle version du prompt ?".
--
-- Cette migration ajoute la même col sur `audit_findings` pour le
-- diag (le fix-gen est déjà câblable via la col existante sur
-- proposed_fixes).
--
-- Le wiring TS (insert dans prompt_versions + set FK) vit dans
-- `src/lib/prompt-versions.ts` + appels dans `diagnose.ts` et
-- `generate-fixes.ts`.
-- ============================================================

alter table audit_findings
  add column if not exists diagnostic_prompt_version_id uuid references prompt_versions(id);

comment on column audit_findings.diagnostic_prompt_version_id is
  'AMDEC M4 — version du prompt diagnostic utilisé pour produire `diagnostic`. NULL pour les rows pré-Sprint-19.5+. Permet l''apprentissage cross-version (apprendre des fix_outcomes par prompt version).';

-- Pas de contrainte FK explicite sur proposed_fixes.prompt_version_id
-- (la col existait sans FK depuis l'initial schema). On en ajoute une
-- pour la cohérence.
do $$
begin
  if not exists (
    select 1 from information_schema.referential_constraints
    where constraint_name = 'proposed_fixes_prompt_version_id_fkey'
  ) then
    alter table proposed_fixes
      add constraint proposed_fixes_prompt_version_id_fkey
      foreign key (prompt_version_id) references prompt_versions(id);
  end if;
end $$;
