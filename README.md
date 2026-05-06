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
- [ ] Sprint 2 — Snapshot GSC + GA4
- [ ] Sprint 3 — Compute findings (formules de scoring)
- [ ] Sprint 4 — Diagnostic + fixes via LLM
- [ ] Sprint 5 — Création d'issues GitHub
- [ ] Sprint 6 — Apply fixes via Wix + mesure J+30 / J+60

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` : **server-side uniquement**.
- Jamais de fix appliqué sur Wix sans revue humaine (label GitHub `status:reviewed`).
- Tous les payloads LLM validés via Zod avant insertion.
- Rate-limit : max 5 fixes appliqués par jour (mesure propre).
