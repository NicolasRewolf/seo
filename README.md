# Plouton SEO Audit Tool

Pipeline diagnostic SEO automatisé orienté **NavBoost** pour `jplouton-avocat.fr`.

Pour chaque page sous-performante : croise GSC + tracker first-party Cooked + DataForSEO (volumes + SERP top 10) + DOM scrape + silo Google Search Central officiel, fait raisonner Claude Opus 4.7 sur ~25 blocs structurés, valide chaque chiffre cité contre les sources réelles (fact-checker + retry-once), produit une **issue GitHub** avec diagnostic causal + fixes prêts à appliquer + cycle de mesure T+30 / T+60.

---

## Quick start

```bash
git clone https://github.com/NicolasRewolf/seo.git && cd seo
npm install
cp .env.example .env  # remplir les variables
npm run smoke         # vérifie que les 8 connecteurs répondent
npm test              # 155 tests unitaires
npx tsc --noEmit      # typecheck strict
```

Cycle complet :

```bash
npm run snapshot      # 1. GSC + Cooked snapshot
npm run audit         # 2. score les findings
npm run pull:state    # 3. capture content + meta
npm run diagnose      # 4. LLM diagnostic
npm run fixes         # 5. LLM fix-gen
npm run issues        # 6. crée les issues GitHub
# --- humain applique manuellement dans Wix ---
npm run apply -- --finding=<uuid> --by=<email>  # signal T0
npm run measure       # cron quotidien : outcomes T+30/T+60
```

---

## Documentation

Documentation siloée par mécanisme dans **[`docs/`](./docs/)**.

| # | Doc | Tu lis pour comprendre... |
|---|---|---|
| [00](./docs/00-index.md) | Index | Reading guide selon ton intention |
| [01](./docs/01-pipeline.md) | Pipeline | Les 6 étapes + les 2 crons GitHub Actions |
| [02](./docs/02-data-sources.md) | Sources de données | Chacune des 7 sources et ce qu'elle publie au LLM |
| [03](./docs/03-prompts.md) | Prompts LLM | Anatomie du prompt diagnostic v11 + fix-gen, bloc par bloc |
| [04](./docs/04-safety-nets.md) | Safety nets | 8 garde-fous : Zod, fact-checker, retry-once, banners contextuelles, treatment/control |
| [05](./docs/05-issue-template.md) | Issue template | Anatomie du body d'issue : 11 zones de haut en bas |
| [06](./docs/06-database.md) | Base de données | Schéma Supabase, 5 migrations, qui écrit quoi |
| [07](./docs/07-google-silo.md) | Silo Google | Le silo Search Central : RSS + Status Dashboard + ranking systems + spam policies + deep posts |
| [08](./docs/08-cooked-coordination.md) | Coordination Cooked | Protocole pour collaborer avec l'agent jumeau |
| [09](./docs/09-testing.md) | Tests | 7 suites unitaires + smoke + e2e cobaye |
| [10](./docs/10-operational.md) | Opérationnel | Workflows GitHub Actions, secrets, env vars, cycle de mesure |

---

## Architecture en une image

```
┌─ Sources de données ─────────────────────────────────┐
│ GSC                                                  │
│ Cooked (7 RPCs : snapshot + behavior + CWV +         │
│         conversion + pogo + density + cta_per_dev)   │
│ DataForSEO (volumes FR + SERP top 10)                │
│ Wix Blog API (auteur + dates)                        │
│ DOM extractor (body + outline + images + CTAs)       │
│ Site catalog (URLs internes RÉELLES, hardcoded)      │
│ Google Search Central silo                           │
│   ├ Blog RSS (90j filtre pivot)                      │
│   ├ Status Dashboard (active + recent updates)       │
│   ├ Ranking Systems (17 nommés)                      │
│   ├ Spam Policies (17 enumerees)                     │
│   └ Top 2 posts deep-fetched                         │
│ Internal link graph (Sprint 9 DOM classifier)        │
└──────────────────────┬───────────────────────────────┘
                       │
              buildDiagnosticInputs()
                       │
                       ▼
       renderDiagnosticPrompt(v11) ─ ~25 blocs XML
                       │
                       ▼
            Anthropic Claude Opus 4.7
              (max_tokens=8000)
                       │
                       ▼
          Zod validation (16 fields)
                       │
                       ▼
        factCheckDiagnostic() — chiffres tracés ?
              │                │
          ✅ passé       ⚠️ unverified
                              │
                       retry-once avec
                       message correctif
                              │
                              ▼
       Issue GitHub rendue (template Sprint 13-19.5)
       11 zones : TLDR + verdict + group + metrics 23 rows
                  + banners contextuelles + diagnostic 13-15
                  bullets + top queries + fact-check banner
                  + actions proposées + cycle de mesure +
                  workflow checkboxes + refs
```

---

## Stack technique

- **TypeScript strict** ESM, Node 20+
- **Anthropic Claude Opus 4.7** — diagnostic + fix-generation
- **Supabase Postgres** — service-role bypass, schéma `audit_findings` + 5 migrations
- **Cheerio** — DOM extracteur (pas Readability — Wix Studio markup stable)
- **Zod** — validation tous les payloads LLM avant insertion
- **DataForSEO** REST (Basic Auth) — volumes France + SERP organic
- **Octokit** — création/PATCH d'issues
- **Pino** logging structuré
- **GitHub Actions** : `audit-weekly.yml` (lundi 06:00 UTC) + `measure-outcomes.yml` (quotidien 07:00 UTC)

---

## Coordination cross-agent

Trois projets Supabase coexistent :
- **Seo** (ce repo, `lzdnljppbenqoflyxbhi`) : ce repo
- **Cooked** ([repo](https://github.com/NicolasRewolf/cooked), `mxycmjkeotrycyneacje`) : agent Claude Code séparé. Lecture only via les RPCs publiées.
- **Links** (`xjblcgvjhrssyszmrrvi`) : pas utilisé actuellement par ce repo.

Règles de coordination dans [`CLAUDE.md`](./CLAUDE.md). Détail dans [`docs/08-cooked-coordination.md`](./docs/08-cooked-coordination.md).

---

## Sécurité

- `SUPABASE_SERVICE_ROLE_KEY` : server-side uniquement, jamais en frontend
- RLS activée sur toutes les tables — service-role bypass exclusif
- Tous les payloads LLM validés via Zod avant insertion
- Aucun fix poussé sur Wix sans intervention manuelle (par choix produit)
- Tokens OAuth (`gsc-*.json`) et `.env` dans `.gitignore`

---

## Roadmap

[`ROADMAP.md`](./ROADMAP.md) garde le roadmap initial pour traçabilité historique. Le scope a largement dépassé le roadmap initial — le code actuel est documenté dans [`docs/`](./docs/).
