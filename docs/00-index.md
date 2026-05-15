# Documentation — Plouton SEO Audit Tool

Documentation siloée par mécanisme. Chaque doc est self-contained : tu peux la lire sans avoir lu les autres.

## Reading guide

| # | Doc | Lis-le pour comprendre... |
|---|---|---|
| 01 | [Pipeline](./01-pipeline.md) | Les 6 étapes du pipeline + les 2 crons GitHub Actions |
| 02 | [Sources de données](./02-data-sources.md) | Chacune des 7 sources et ce qu'elle publie au LLM |
| 03 | [Prompts LLM](./03-prompts.md) | L'anatomie du prompt diagnostic v11 + fix-gen, bloc par bloc |
| 04 | [Safety nets](./04-safety-nets.md) | Tout ce qui empêche le LLM de produire du faux : Zod, fact-checker, retry-once, banners contextuelles, treatment/control |
| 05 | [Issue template GitHub](./05-issue-template.md) | L'anatomie du body de l'issue : 11 zones de haut en bas |
| 06 | [Base de données](./06-database.md) | Schéma Supabase, 5 migrations, qui écrit quoi |
| 07 | [Silo Google Search Central](./07-google-silo.md) | Comment le LLM consulte Google directement (RSS blog + Status Dashboard + ranking systems + spam policies + deep posts) |
| 08 | [Coordination Cooked](./08-cooked-coordination.md) | Le protocole pour collaborer avec l'agent jumeau Cooked |
| 09 | [Tests](./09-testing.md) | Les 7 suites de tests unitaires + smoke + e2e |
| 10 | [Opérationnel](./10-operational.md) | Workflows GitHub Actions, secrets, env vars, cycle de mesure |
| 11 | [Eval LLM](./11-eval.md) | Le golden set de regression sur le diagnostic LLM : 5 cases frozen, ~25 assertions, gate avant bump prompt |

## Lecture rapide selon ton intention

- **Tu débutes / tu arrives sur le projet** : [01](./01-pipeline.md) → [02](./02-data-sources.md) → [05](./05-issue-template.md)
- **Tu veux modifier le prompt LLM** : [03](./03-prompts.md) + [04](./04-safety-nets.md) + run `npm run eval` (cf. [11](./11-eval.md))
- **Tu veux ajouter une source** : [02](./02-data-sources.md) puis [03](./03-prompts.md) (le wiring vers le prompt)
- **Tu veux comprendre comment l'outil reste honnête** : [04](./04-safety-nets.md)
- **Tu déploies / tu débugues le cron** : [10](./10-operational.md)
- **Tu coordonnes avec Cooked** : [08](./08-cooked-coordination.md)
