# 10 — Opérationnel

Tout ce qui concerne le déploiement, les workflows GitHub Actions, les secrets, et les conventions de runtime.

## Workflows GitHub Actions

### `.github/workflows/audit-weekly.yml`

**Déclencheurs** :
- Cron : `0 6 * * 1` (lundi 06:00 UTC = 07:00 ou 08:00 Paris selon DST)
- Manuel : `workflow_dispatch` avec input `skip_snapshot` (pour tester l'audit sur snapshots existants sans re-puller)

**Steps** :
```
checkout → install deps → setup env → 
crawl-internal-links →    (Sprint 9 : populate graph BEFORE diagnose)
snapshot →
audit →
pull-current-state →
diagnose →
generate-fixes →
create-issues
```

**Timeout** : 45 min. Le crawl prend ~5 min, snapshot ~2 min, le reste est LLM-bound (proportionnel au nombre de findings).

**Secrets requis** : voir section ci-dessous.

### `.github/workflows/measure-outcomes.yml`

**Déclencheurs** :
- Cron : `0 7 * * *` (quotidien 07:00 UTC, **après** l'audit du lundi)
- Manuel : `workflow_dispatch`

**Steps** :
```
checkout → install deps → setup env → measure
```

**Timeout** : 10 min. Pure read-then-insert, pas de LLM call.

---

## Secrets requis (GitHub Actions)

Repo Settings → Secrets and variables → Actions :

| Secret | Valeur |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase Seo |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé `sb_secret_...` (server-side only, RLS bypass) |
| `ANTHROPIC_API_KEY` | clé `sk-ant-api03-...` |
| `ANTHROPIC_MODEL` | `claude-opus-4-7` (default si non set) |
| `GH_API_TOKEN` | PAT fine-grained avec scopes `repo` + `issues:write` |
| `GSC_SITE_URL` | `https://www.jplouton-avocat.fr/` |
| `GSC_OAUTH_CREDENTIALS_JSON` | Contenu brut du fichier `gsc-oauth-credentials.json` |
| `GSC_TOKEN_JSON` | Contenu brut du fichier `gsc-token.json` |
| `COOKED_SUPABASE_URL` | URL du projet Cooked (`https://mxycmjkeotrycyneacje.supabase.co`) |
| `COOKED_SECRET_KEY` | Clé `sb_secret_...` du projet Cooked |
| `WIX_API_KEY` | JWT IST.eyJ... |
| `WIX_SITE_ID` | UUID du site Wix |
| `WIX_ACCOUNT_ID` | UUID du compte **owner** du site (cf. mémoire `feedback_dotenv_override.md` — c'est `07454f1f-...`, PAS `d05c9ea4-...`) |
| `DATAFORSEO_AUTH` | Base64 de `login:password` |

**Pas de secret pour Google Search Central** — endpoints publics.

---

## Variables d'env locales (`.env`)

Voir `.env.example`. Mêmes valeurs que les secrets GitHub mais en local. À noter :

### Le piège dotenv

Sur le Mac de Nicolas, le shell injecte un `ANTHROPIC_API_KEY=` vide qui shadow silencieusement le `.env` (probablement injecté par Claude Code). Solution : `dotenv` est chargé avec `{ override: true }` partout :

```ts
// src/config.ts
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ override: true });  // CRITIQUE — sans ça, le shell vide gagne
```

Documenté dans la mémoire `~/.claude/projects/-Users-nicolas-Desktop-Seo/memory/feedback_dotenv_override.md`.

---

## Le runner pattern

Tous les pipelines ont un script runner dans `src/scripts/run-*.ts` qui :
1. Parse les flags CLI (`--ids=uuid`, `--limit=N`, `--ctr-gap=0.3`, etc.)
2. Appelle la fonction du pipeline
3. Print un résumé human-readable

Liste des runners :

| Script | Wrapper |
|---|---|
| `run-snapshot.ts` | `pipeline/snapshot.ts` |
| `run-crawl.ts` | `pipeline/crawl-internal-links.ts` |
| `run-audit.ts` | `pipeline/compute-findings.ts` |
| `run-pull-current-state.ts` | `pipeline/pull-current-state.ts` |
| `run-diagnose.ts` | `pipeline/diagnose.ts` (`--ids=uuid` filter) |
| `run-generate-fixes.ts` | `pipeline/generate-fixes.ts` |
| `run-create-issues.ts` | `pipeline/create-issues.ts` |
| `run-mark-applied.ts` | `pipeline/mark-applied.ts` (`--finding=uuid --by=email`) |
| `run-measure.ts` | `pipeline/measure.ts` |
| `smoke.ts` | Tous les `lib/*:smokeTest()` |

Tous appelables via `npm run <name>` — voir `package.json:scripts`.

---

## Cycle opérationnel hebdomadaire

```
Lundi 06:00 UTC  → audit-weekly.yml run automatique
                   → ~17 issues créées avec diagnostic + fixes

Lundi-vendredi   → Nicolas reviewe les issues sur GitHub
                   → applique les fixes treatment manuellement dans Wix
                   → npm run apply -- --finding=<uuid> --by=nicolas@rewolf.studio

Quotidien 07:00 UTC → measure-outcomes.yml run automatique
                      → détecte les findings T+30 / T+60
                      → écrit fix_outcomes
                      → re-PATCH issue body avec verdict + delta table
                      → poste un comment timestampé
```

---

## Mode itératif (developement)

Quand on touche les prompts ou l'extraction de données :

1. **Modifier le code** (prompts, fact-checker, extracteur, etc.)
2. **Bump la version** si applicable (`DIAGNOSTIC_PROMPT_VERSION`)
3. **`npm test` + `npx tsc --noEmit`** — verts obligatoire
4. **Throwaway script** qui appelle `diagnoseFinding(uuid-de-#33)` et `gh issue edit 33 --body-file ...`
5. **Lire l'issue #33 sur GitHub** — vérifier le rendu visuel + le diag content
6. **Si OK** → re-batch sur les 16 autres findings
7. **Cleanup** : `rm src/scripts/validate-sprint-XX.ts`

Cf. [09-testing.md §End-to-end](./09-testing.md#end-to-end-manuel-sur-la-cobaye) pour le détail.

---

## Coût opérationnel

### Par run de pipeline complet (cron lundi)

| Item | Coût |
|---|---|
| GSC (OAuth) | gratuit |
| Cooked RPCs | gratuit (own infra) |
| DataForSEO volumes (~1 batch) | ~$0.075 |
| DataForSEO SERP (5 queries × 17 findings × 2 LLMs) | ~$0.34 |
| Anthropic diag (17 findings × ~$0.20) | ~$3.40 |
| Anthropic fix-gen (17 findings × ~$0.40) | ~$6.80 |
| Wix Blog API | gratuit |
| Google Search Central | gratuit |
| GitHub Actions runtime | inclus dans le free tier (45 min × 4 runs/mois) |
| Supabase storage + queries | inclus dans le free tier |
| **Total par audit complet** | **~$10.60** |

### Par run de mesure (cron quotidien)

| Item | Coût |
|---|---|
| GSC (OAuth) | gratuit |
| Octokit (PATCH + comment) | gratuit |
| GitHub Actions runtime | inclus |
| **Total par mesure** | **~$0** |

---

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` : **server-side uniquement**, jamais en frontend
- RLS activée sur toutes les tables — aucune policy `anon` / `authenticated` → service-role bypass exclusif
- Tous les payloads LLM validés via Zod avant insertion
- Aucun fix poussé sur Wix sans intervention manuelle (`apply-fixes.ts` n'existe pas par choix produit)
- Tokens OAuth (`gsc-*.json`) et `.env` dans `.gitignore`
- `DATAFORSEO_AUTH` est en Basic Auth Base64 — usage server-side uniquement
- `WIX_API_KEY` : JWT IST avec scope service-account, server-side uniquement

---

## Limites opérationnelles connues

- **Cron lundi 06:00 UTC** : choix arbitraire, pourrait être ajusté. Idéalement après un cron Cooked (03:00 UTC) pour avoir le snapshot frais
- **Pas de retry-on-failure** dans les workflows : si `audit-weekly.yml` fail à mi-pipeline (ex: rate-limit Anthropic), il faut re-trigger manuellement. Idempotent côté DB donc OK.
- **Pas d'alerte Slack/email** sur fail de cron → checker manuellement les Actions logs
- **Pas de rotation auto des secrets** : à faire manuellement (PAT GitHub 90j max, OAuth GSC peut expirer après 6 mois sans usage)
- **Pas de monitoring du nombre de findings** : si l'audit produit 0 finding une semaine (Google update qui rétablit le CTR ?) on n'est pas alerté
- **Pas de versioning des migrations** : on ne peut pas rollback automatiquement (mais `supabase db reset` reste possible en dev)

---

## Déployer une migration DB

```bash
# 1. Créer la migration
# (timestamp UTC obligatoire pour ordering)
touch supabase/migrations/$(date -u +%Y%m%d%H%M%S)_my_change.sql

# 2. Écrire le SQL (additif uniquement — pas de DROP COLUMN sans coordination)

# 3. Appliquer via Supabase MCP
# (cf. les sprints 14, 14bis : utilisé `mcp__supabase__apply_migration`)
```

**Convention** :
- Toutes les migrations sont **additives** (`ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`)
- Aucun `DROP COLUMN` ni `RENAME` sans coordination explicite avec Nicolas
- Les nouveaux champs JSONB doivent être nullable (rétro-compat avec les rows existantes)
- Documenter avec `comment on column ... is '...'` pour traçabilité Sprint
