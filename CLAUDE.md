# CLAUDE.md — instructions pour les sessions Claude Code travaillant sur ce repo

> Ce fichier est lu automatiquement au démarrage de chaque session
> Claude Code dans ce repo. Il définit le périmètre d'autonomie de
> l'agent et le protocole de coordination avec les agents jumeaux.

---

## Identité du projet

`seo` est un **outil de diagnostic SEO automatisé** pour le site
`jplouton-avocat.fr`. Pipeline en 6 étapes :

```
snapshot → audit → pull-current-state → diagnose → fixes → issues
```

Pour chaque page sous-performante, produit une issue GitHub structurée
avec analyse GSC + comportement Cooked + maillage interne + suggestions
de fixes (title / meta / intro / liens / schema / sections de contenu).

---

## Périmètre d'autonomie de cet agent

L'agent `seo` est **propriétaire** de :

- Le code TypeScript de ce repo (`src/lib/*`, `src/pipeline/*`,
  `src/prompts/*`, `src/scripts/*`)
- Le projet Supabase Seo (`lzdnljppbenqoflyxbhi`) et son schéma
  (`audit_findings`, `behavior_page_snapshots`, `gsc_*_snapshots`,
  `internal_link_graph`, etc.)
- Les prompts diagnostic v6+ et fix-generation v3+
- Le template d'issue GitHub
- Les wrappers TypeScript dans `src/lib/cooked.ts` qui consomment
  les RPCs Cooked (mais pas le contrat lui-même)
- Les workflows GitHub Actions (`.github/workflows/*.yml`)
- Tout ce qui touche aux intégrations GSC, Wix Blog API, DataForSEO

L'agent `seo` **N'EST PAS propriétaire** de :

- Le projet Supabase Cooked (`mxycmjkeotrycyneacje`)
- Le repo cooked (https://github.com/NicolasRewolf/cooked)
- Les RPCs publiées par Cooked (signatures, types de retour)
- L'Edge Function `track`, le tracker `tracker.html`, le proxy Velo
- Les events bruts dans la table `events` de Cooked

---

## Coordination avec l'agent Cooked

Le projet jumeau **Cooked** (https://github.com/NicolasRewolf/cooked)
fournit les données comportementales first-party consommées par ce
projet. Il est maintenu par une **session Claude Code séparée**.

**Les deux agents ne peuvent pas se parler directement.** Nicolas est
le relais humain entre les sessions.

### Briefing reçu de l'agent Cooked (2026-05-09)

L'agent Cooked a transmis sa carte de capacités complète via Nicolas
le 2026-05-09. À retenir pour calibrer tes prompts et tes attentes :

- **Live depuis le 5 mai 2026** — fenêtres 90d/365d quasi vides, privilégie
  7d et 28d. Même 28d peut être borné à <28 jours de data réelle.
- **Tracking 100% first-party, cookieless, RGPD-exempt, non échantillonné.**
  Pas de consent bias. Chaque visite est captée.
- **`anonymous_id` rotate chaque jour** — pas de tracking returning
  visitors cross-day pour l'instant. Ne formule JAMAIS de claim sur
  retours / visites multi-jours.
- **8 types d'events** dans `events` : `pageview`, `page_exit`,
  `scroll_depth`, `engagement_tick`, `web_vitals`, `click_outbound`,
  `cta_phone_click`, `cta_booking_click`. Chaque event porte
  `session_id, anonymous_id, path, referrer, utm_*, device, browser,
  os, viewport, occurred_at`.
- **`avg_dwell_seconds` = temps actif réel** (somme des engagement_tick
  active_ms), pas wall-clock — ne le compare jamais à GA4 sessions.
- **Cooked ne sait PAS** : SERP, CTR Google, positions, impressions
  (= GSC) ; ne voit PAS les concurrents (= seulement jplouton-avocat.fr) ;
  ne tracke PAS les retours multi-jours (anonymous_id rotate).
- **7 RPCs disponibles** + le snapshot pré-calculé `seo_url_snapshot`
  (70 cols, refresh nightly 03:00 UTC).

### 🟢 Tu peux faire SANS coordination

- Lire via les RPCs publiées par Cooked
  (`snapshot_pages_export`, `site_context_export`,
  `outbound_destinations_for_path`, `cta_breakdown_for_path`,
  `tracker_first_seen_global`, `behavior_pages_for_period`,
  `pogo_rates_for_period`)
- Modifier ton wrapper `src/lib/cooked.ts` tant que tu consommes les
  RPCs existantes selon leur contrat
- Modifier tes prompts, tes pipelines, ton issue template
- Modifier ta DB Seo (toute table dans le projet `lzdnljppbenqoflyxbhi`)
- Forger des findings manuels pour test (ex: `forge-finding-*.ts`)
- Bumper les versions de prompts (v6 → v7 → …)
- Pousser des PRs sur ce repo
- Lancer les workflows GitHub Actions

### 🟡 Tu peux PRÉPARER, pas EXÉCUTER — escalader d'abord

- **Proposer un nouveau RPC Cooked** → écris la signature TS attendue,
  documente le besoin, demande à Nicolas de me consulter
- **Demander un nouveau type d'event** Cooked (`form_view`,
  `scroll_milestone`, `cta_*_click_inline`, …) → écris la spec,
  demande à Nicolas
- **Pointer un bug suspecté côté Cooked** (data manquante, encoding
  bizarre, capture rate suspect) → diagnostic-le avec preuves SQL
  mais ne tente pas de fix toi-même côté Cooked
- **Demander un changement de granularité** dans une RPC existante
  (ex: top 10 → top 20, ou ajout d'une colonne) → écris la justif,
  demande

### 🔴 STOP — interdit sans go explicite

Avant de toucher à L'UNE des choses suivantes, écris explicitement
**"@nicolas peux-tu demander à l'agent Cooked si OK pour …"** et
attends le retour :

- Toute modification du schéma Cooked (`events`, `seo_url_snapshot`,
  les RPCs)
- Toute modification de l'Edge Function `track` (Deno code)
- Toute modification du `tracker.html` déployé sur Wix Custom Code
- Toute modification du Velo proxy `http-functions.js`
- Toute backfill / DELETE / UPDATE direct sur la DB Cooked
- Tout commit ou push sur le repo `cooked`
- Toute action qui change le contrat publié des RPCs Cooked
  (rename, type change, behavior change)

### Format de demande d'escalade

Quand tu veux escalader (zone 🟡 ou 🔴), écris à Nicolas, dans le chat
de la session, en bloc isolé :

```
@nicolas — je veux [faire X] côté Cooked.

Raison : [pourquoi maintenant, pourquoi indispensable]
Impact attendu : [comportement nouveau, taille de la migration, etc.]
Alternative locale : [si je peux faire un workaround sans toucher Cooked]

Peux-tu demander à l'agent Cooked :
- si OK sur le principe ?
- sa préférence d'implémentation (RPC vs schéma vs autre) ?
```

Nicolas relaie, l'agent Cooked répond, Nicolas re-relaie. Round-trip
typique : 5-15 min selon le niveau de réflexion technique nécessaire.

**Ne préempte pas** : ne commence pas à coder le côté Cooked en
local "au cas où" — tu vas créer du code mort ou pire, des conflits
au moment où l'agent Cooked aura sa propre approche.

---

## Méthodologie qui marche (Sprint 12 retex)

À garder comme grille de qualité pour les sprints futurs :

1. **Critères de validation explicites avant exécution** — quand tu
   demandes à Nicolas / à l'agent Cooked de valider quelque chose,
   liste 3-5 critères concrets, vérifiables. Pas de "ça devrait
   marcher", on doit savoir que ça marche.

2. **Avant de valider, regarde concrètement le résultat** — ne signe
   pas "RAS" sans avoir lu le `diagnostic` JSON, le markdown rendu
   de l'issue, la sortie SQL réelle. Les bugs subtils (le 4e bug
   trouvé en pulling le `performance_diagnosis` au Sprint 12) se
   cachent toujours dans ce qu'on n'a pas regardé.

3. **Le math nudge** — quand un verdict semble damning (capture rate
   5%, scroll 0%, etc.), refais les comptes avec les fenêtres
   temporelles avant de conclure à un bug. La plupart des "bugs"
   sont des artefacts d'amorçage.

4. **Mode itératif strict avant scale** — quand un diag/fix est
   nouveau, on le valide sur **1 seule finding** avant de tourner
   sur les 16+ autres. C'est le pattern qui a évité 3 régressions
   silencieuses ce sprint.

---

## Architecture rapide (pour démarrer une session sans relire tout)

```
GSC                    \
DataForSEO              \
Wix Blog API + DOM       → seo pipeline → audit_findings → diagnose v6 → issue GitHub
Cooked (RPCs)           /                  + proposed_fixes
Site catalog (curé)    /
```

Sources de données → 21 blocs structurés dans le prompt v6 → LLM
sectionne en 12 bullets diagnostic + 8 fixes → 1 issue GitHub humanly
readable. Stack qui a livré sa première issue end-to-end le 2026-05-07
sur la finding `que-se-passe-t-il-après-une-garde-à-vue` (#30).
