# 08 — Coordination avec l'agent Cooked

## Le contexte

**Cooked** est un projet jumeau de Seo, maintenu par une **session Claude Code distincte**.

| Propriété | Seo (ce repo) | Cooked |
|---|---|---|
| Repo | https://github.com/NicolasRewolf/seo | https://github.com/NicolasRewolf/cooked |
| Projet Supabase | `lzdnljppbenqoflyxbhi` | `mxycmjkeotrycyneacje` |
| Région | eu-west-3 | eu-west-1 |
| Ownership Claude | cette session | session séparée (jumelle) |
| Rôle | Diagnostic SEO + génération de fixes | First-party tracker (cookieless RGPD-exempt) |

**Les deux agents ne peuvent pas se parler directement.** Nicolas est le relais humain entre les sessions.

## Ce que Cooked publie pour Seo

Voir [02-data-sources.md §Cooked](./02-data-sources.md#2-cooked--first-party-tracker) pour les 7 RPCs détaillées.

En résumé : le snapshot pré-calculé `seo_url_snapshot` (70 cols, refresh nightly 03:00 UTC) et 7 RPCs Live :

```
snapshot_pages_export (cœur du diag)
site_context_export
outbound_destinations_for_path
cta_breakdown_for_path
engagement_density_for_path  (Sprint 16)
tracker_first_seen_global
behavior_pages_for_period
pogo_rates_for_period (pas utilisé en diag)
```

## Briefing reçu de l'agent Cooked (relayé via Nicolas le 2026-05-09)

**Architecture Cooked** :
- Tracking 100% first-party, cookieless, RGPD-exempt, non échantillonné
- Live depuis le 5 mai 2026
- 8 event types : `pageview`, `page_exit`, `scroll_depth`, `engagement_tick`, `web_vitals`, `click_outbound`, `cta_phone_click`, `cta_booking_click`
- Chaque event porte : `session_id`, `anonymous_id`, `path`, `referrer`, `utm_*`, `device`, `browser`, `os`, `viewport`, `occurred_at`
- `anonymous_id` rotate quotidiennement → pas de tracking returning visitors cross-day
- `avg_dwell_seconds` = temps actif réel (somme des engagement_tick active_ms), pas wall-clock

**Bot filter centralisé (Sprint 17 Cooked)** :
- Détection : un `anonymous_id` avec >20 pageviews/jour ET 0 scroll = crawler. Aucun humain ne visite 20+ pages sans scroller.
- Architecture : `events` (raw) → `bot_fingerprints` (refresh nightly) → `events_human` (vue) → toutes les RPCs + snapshot lisent `events_human`
- Résultat : URLs 719 → 255 (464 pages fantômes éliminées), CWV maintenant réalistes (LCP `/` passe de 304ms fake à 4361ms réel)
- Refresh : pg_cron 03:00 UTC (`refresh_seo_url_snapshot()` appelle `refresh_bot_fingerprints()` automatiquement en premier)

**Ce que Cooked NE sait PAS** :
- SERP, CTR Google, positions, impressions (= GSC)
- Concurrents (= seulement jplouton-avocat.fr)
- Returning visitors cross-day

---

## Le protocole d'escalade

`CLAUDE.md` (à la racine du repo) définit 3 zones :

### 🟢 Tu peux faire SANS coordination

- Lire via les RPCs publiées par Cooked
- Modifier ton wrapper `src/lib/cooked.ts` tant que tu consommes les RPCs existantes selon leur contrat
- Modifier tes prompts, pipelines, issue template
- Modifier ta DB Seo
- Bumper les versions de prompts
- Pousser sur main directement (per préférence Nicolas)
- Lancer les workflows GitHub Actions

### 🟡 Tu peux PRÉPARER, pas EXÉCUTER — escalader d'abord

- **Proposer un nouveau RPC Cooked** → écris la signature TS attendue, documente le besoin, demande à Nicolas de relayer
- **Demander un nouveau type d'event Cooked** (`form_view`, `scroll_milestone`, etc.) → écris la spec, demande
- **Pointer un bug suspecté côté Cooked** (data manquante, encoding bizarre, capture rate suspect) → diagnostic-le avec preuves SQL mais ne tente pas de fix toi-même côté Cooked
- **Demander un changement de granularité** dans une RPC existante → écris la justif, demande

### 🔴 STOP — interdit sans go explicite de Nicolas

Avant de toucher à L'UNE des choses suivantes, écris explicitement
**"@nicolas peux-tu demander à l'agent Cooked si OK pour …"** et
attends le retour :

- Toute modification du schéma Cooked (`events`, `seo_url_snapshot`, les RPCs)
- Toute modification de l'Edge Function `track` (Deno)
- Toute modification du `tracker.html` déployé sur Wix Custom Code
- Toute modification du Velo proxy `http-functions.js`
- Toute backfill / DELETE / UPDATE direct sur la DB Cooked
- Tout commit ou push sur le repo `cooked`
- Toute action qui change le contrat publié des RPCs Cooked (rename, type change, behavior change)

---

## Format de demande d'escalade

Quand on veut escalader (zone 🟡 ou 🔴), écris à Nicolas, dans le chat de la session, en bloc isolé :

```
@nicolas — je veux [faire X] côté Cooked.

Raison : [pourquoi maintenant, pourquoi indispensable]
Impact attendu : [comportement nouveau, taille de la migration, etc.]
Alternative locale : [si je peux faire un workaround sans toucher Cooked]

Peux-tu demander à l'agent Cooked :
- si OK sur le principe ?
- sa préférence d'implémentation (RPC vs schéma vs autre) ?
```

Nicolas relaie, l'agent Cooked répond, Nicolas re-relaie. Round-trip typique : 5-15 min selon le niveau de réflexion technique.

**Ne préempte pas** : ne commence pas à coder le côté Cooked en local "au cas où" — tu vas créer du code mort ou pire, des conflits au moment où l'agent Cooked aura sa propre approche.

---

## Briefing reçu de l'agent Cooked (relayé via Nicolas le 2026-05-16)

**4 points actionables + 1 FYI.**

### 1. Sprint 22 — fix `anonymous_id` (critique)

**Bug** : 93 % des sessions avaient >1 `anonymous_id`. Cause = workers Wix Velo stateless avec IPs sortantes différentes → chaque `engagement_tick` hashait une IP différente → 6+ anonymous_id par session réelle.

**Fix Cooked-side (déployé ~15 mai 2026)** : `anonymous_id` vient maintenant du `localStorage` browser (`_ckd_aid`, UUID stable). Données propres à partir du **16 mai**. Fenêtre 28d entièrement nettoyée vers le **13 juin**.

**Impact pour Seo** : `sessions_*` étaient massivement gonflés avant le fix → `bounce_rate` et taux de conversion par session artificiellement bas. Ne JAMAIS tirer de conclusion sur ces ratios pendant la fenêtre de transition.

**Câblé Seo-side** : bloc `<cooked_anonymous_id_advisory>` ajouté au prompt v13 (puis v14) dans `src/prompts/diagnostic.v1.ts`. Le bloc affiche un caveat tant que `now < COOKED_CLEAN_28D_WINDOW_DATE` (= 2026-06-13). Disparaît automatiquement après. Voir aussi `fmtCookedAnonIdAdvisory()`.

### 2. `cta_anchor_click` — angle mort dans les RPCs

**Bug** : Sprint 19 Cooked a introduit `cta_anchor_click` (clics sur TOC sticky + barre sticky mobile des pages expertise). Ces events ont `placement: 'sticky'`, absent de l'enum `'header'|'footer'|'body'` de `cta_breakdown_for_path` → ~30 anchor RDV par 10 jours sont INVISIBLES dans `cta_breakdown_for_path` ET dans `booking_cta_clicks` de `snapshot_pages_export`.

**Impact pour Seo** : sur les pages expertise (les plus stratégiques business), le diag dit "0 booking, page ne convertit pas" alors qu'il y a 30 anchor clicks invisibles → recommandation erronée ("ajouter un CTA" alors qu'il y en a déjà un qui marche).

**Décision Seo (2026-05-16)** : OUI on veut le fix. Confirmation transmise à l'agent Cooked via Nicolas. Implémentation préférée :
- Ajouter `'sticky'` à l'enum `placement` de `cta_breakdown_for_path`
- Mapper les 2 aria-labels (cf. référentiel ci-dessous) en `cta_type='booking'`

**Préparation Seo-side** : `src/lib/cooked.ts` annoté avec TODO + commentaires défensifs. `CtaPlacement` actuel reste `'header'|'footer'|'body'`. Une fois la migration Cooked en prod, ajouter `'sticky'` au type + adapter le smoke check ligne 476 + adapter `fmtCtaBreakdown` côté prompt pour interpréter le nouveau placement (sticky = intent qualifié comme body, peut-être MEME PLUS QUE BODY puisque user a consciemment cherché le sticky).

### 3. `form_submit` — piège `device_type='server'`

Les `form_submit` arrivent avec `device_type='server'` (insérés server-side par l'edge function `form-webhook`). Un filtre exclusif `device_type != 'server'` pour exclure les bots jetterait aussi tous les `form_submit`.

**Règle SQL correcte** :
```sql
WHERE name IN ('cta_phone_click','form_submit')
  AND (device_type != 'server' OR name = 'form_submit')
```

**Vérifié Seo-side** : aucun filtre `device_type` dans `src/lib/cooked.ts`. Commentaire défensif ajouté pour qu'aucune session future ne réintroduise ce piège.

### 4. Référentiel complet aria-label → event (source de vérité)

C'est le mapping authoritatif Cooked-side. À consulter avant tout diagnostic / fix qui interprète les compteurs CTA.

| Composant | Devices | Aria-label | Event |
|---|---|---|---|
| Header | Desktop | `Prendre rendez-vous — header` | `cta_booking_click` |
| Header burger | Tab+Mobile | `Prendre rendez-vous — menu mobile` | `cta_booking_click` |
| Header burger | Tab+Mobile | `Appeler le cabinet — menu mobile` | `cta_phone_click` |
| Footer | Tous | `Appeler le cabinet — footer` | `cta_phone_click` |
| Footer | Tous | `Prendre rendez-vous — footer` | `cta_booking_click` |
| TOC sticky expertise | Tous | `Je prends rendez-vous — table des matières` | `cta_anchor_click` (→ `booking` post-fix Sprint 23) |
| TOC sticky expertise | Tous | _nom section libre_ | `cta_anchor_click` (navigation, PAS conversion) |
| Barre sticky expertise | Tab+Mobile | `Demander un RDV — formulaire expertise` | `cta_anchor_click` (→ `booking` post-fix Sprint 23) |
| Barre sticky expertise | Tab+Mobile | `Appeler le cabinet — barre mobile expertise` | `cta_phone_click` |

⚠️ Tout `cta_anchor_click` avec un label `nom section libre` (ex: "Défendre vos intérêts") = navigation interne intra-page, **PAS** une conversion. Ne jamais le compter comme micro-conversion.

### 5. Noise filtering 56 % — FYI

`events_human` (vue consommée par toutes les RPCs) combine :
- Sprint 17 `bot_fingerprints` (UA suspects)
- Sprint 20/21 `noise_sessions` (sessions courtes, JS-only, crawlers non-UA)

Aucune action requise Seo-side. Les RPCs héritent du filtre automatiquement.

---

## Historique des collabos cross-agent

Pour archive (utile aux futures sessions) :

| Round | Cooked → Seo | Seo → Cooked |
|---|---|---|
| Briefing initial (2026-05-09) | Cooked transmet sa carte de capacités complète : 8 event types, 70-col snapshot, 7 RPCs, ce qu'il N'EST PAS | Seo accuse réception + ajuste prompt v9 (caveat fenêtres 90d/365d quasi vides, anonymous_id daily) |
| Pogo signal (Sprint 15) | Cooked livre `pogo_rates_for_period` puis intègre 4 cols pogo dans `seo_url_snapshot` | Seo livre `<pogo_navboost>` block dans prompt v8 + bannière `[!CAUTION]` |
| Engagement density + CTA per device (Sprint 16) | Cooked livre `engagement_density_for_path` RPC + 4 cols CTA per device | Seo livre 2 blocs XML + bannière mobile-first + helper évenness verdict |
| Bot filter (Sprint 17) | Cooked livre filtre bot centralisé. Bonus : signale bug `bounce_rate /100` côté Seo | Seo fixe le bug bounce + 3 false positives fact-checker découverts pendant Sprint 17 e2e |
| Briefing Sprint 22 + cta_anchor_click + form_submit + aria-label référentiel (2026-05-16) | Cooked annonce fix anonymous_id, signale `cta_anchor_click` invisible, donne le piège `device_type='server'` + référentiel aria-label complet | Seo livre bloc `<cooked_anonymous_id_advisory>` v14, prépare le type `CtaPlacement` pour 'sticky', ajoute garde-fou `device_type` dans `src/lib/cooked.ts`, confirme demande de migration `cta_breakdown_for_path` |

Le pattern est solide :
1. Identification d'un besoin / amélioration
2. Spec écrite par l'un, validée par l'autre via Nicolas
3. Implémentation parallèle (Cooked livre les données, Seo livre la consommation)
4. Validation e2e sur la cobaye #33
5. Round suivant

---

## Le projet Links

Il existe un troisième projet Supabase nommé **Links** (`xjblcgvjhrssyszmrrvi`, eu-west-3, créé 2026-04-30 — antérieur à Seo).

**Statut actuel** : Seo n'utilise rien dans Links. Pas de wrapper, pas de RPC consommée. Probablement un autre service indépendant de Nicolas.

Si jamais on veut consommer Links un jour, il faudrait :
1. Briefing similaire à Cooked (qu'est-ce qu'il publie, quel est le contrat)
2. Wrapper dédié `src/lib/links.ts`
3. Documentation dans ce fichier
