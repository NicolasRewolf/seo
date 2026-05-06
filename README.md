# Plouton SEO Audit Tool

Pipeline automatisé d'audit SEO orienté NavBoost pour `jplouton-avocat.fr`.
Détecte les pages sous-performantes, génère diagnostic + fixes via LLM, et crée
des issues GitHub structurées par finding. Mesure l'impact via groupe de contrôle.

> Roadmap technique complète : voir [`ROADMAP.md`](./ROADMAP.md).

---

## Quick start

```bash
# 1. Cloner + installer
git clone https://github.com/NicolasRewolf/seo.git
cd seo
npm install

# 2. Configurer les credentials
cp .env.example .env
# remplir les variables (Supabase, Anthropic, GitHub, Google, Wix)

# 3. Vérifier que tous les connecteurs répondent
npm run smoke
```

## Stack

- **TypeScript** strict, Node 20+
- **Supabase Postgres** (snapshots, findings, fixes, outcomes)
- **Anthropic Claude Sonnet 4.6** (diagnostic + génération de fixes)
- **GitHub Issues** (workflow de revue humaine)
- **Google Search Console + GA4** (snapshots de perf + engagement)
- **Wix REST** (lecture du contenu, application des fixes)
- **Ahrefs** (benchmark CTR par position site-spécifique)

## Structure

```
src/
├── config.ts                  # Charge .env + audit_config Supabase
├── lib/
│   ├── supabase.ts
│   ├── anthropic.ts
│   ├── github.ts
│   ├── gsc.ts
│   ├── ga4.ts
│   └── wix.ts
├── pipeline/                  # Sprints 2-6 (à venir)
├── prompts/                   # diagnostic.v1, fix-generation.v1
└── scripts/
    ├── smoke.ts               # Sprint 1 : ping chaque connecteur
    ├── run-snapshot.ts
    ├── run-audit.ts
    └── run-measure.ts

supabase/
└── migrations/
    └── 20260506_initial_schema.sql

.github/workflows/             # Crons (à venir)
```

## Sprints

État de la roadmap (cf. `ROADMAP.md` §12) :

- [x] **Sprint 0** — Bootstrap (TS, deps, env, repo)
- [x] **Sprint 1** — Schéma Supabase + connecteurs `lib/*`
- [x] **Sprint 2** — Snapshot GSC + GA4 + cron `snapshot-weekly.yml`
- [x] **Sprint 3** — Compute findings (page-level site benchmarks, scoring, treatment/control) + cron `audit-weekly.yml`
- [ ] Sprint 4 — Diagnostic + fixes via LLM
- [ ] Sprint 5 — Création d'issues GitHub
- [ ] Sprint 6 — Apply fixes via Wix + mesure J+30 / J+60

## GitHub Action — secrets requis

Pour que `snapshot-weekly.yml` puisse tourner (cron lundi 06:00 UTC), ajouter
dans **Repo Settings → Secrets and variables → Actions** :

| Secret | Valeur |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service-role |
| `ANTHROPIC_API_KEY` | (utile dès Sprint 4) |
| `GH_API_TOKEN` | PAT avec scopes `repo` + `issues:write` (le `GITHUB_TOKEN` natif n'a pas les bons scopes pour create-issue cross-cutting) |
| `GSC_SITE_URL` | `https://www.jplouton-avocat.fr/` |
| `GSC_OAUTH_CREDENTIALS_JSON` | Contenu brut de `gsc-oauth-credentials.json` |
| `GSC_TOKEN_JSON` | Contenu brut de `gsc-token.json` |
| `GA4_TOKEN_JSON` | Contenu brut de `ga4-token.json` |
| `GA4_PROPERTY_ID` | ID numérique de la property GA4 |
| `WIX_API_KEY` / `WIX_SITE_ID` / `WIX_ACCOUNT_ID` | (utiles dès Sprint 4) |

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` : **server-side uniquement**.
- Jamais de fix appliqué sur Wix sans revue humaine (label GitHub `status:reviewed`).
- Tous les payloads LLM validés via Zod avant insertion.
- Rate-limit : max 5 fixes appliqués par jour (mesure propre).
