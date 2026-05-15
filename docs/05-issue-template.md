# 05 — Le template d'issue GitHub

Le livrable de l'outil est une **issue GitHub par finding sous-performante**. Le body est un markdown structuré rendu par `src/prompts/issue-template.ts` (pure function `renderIssue(inputs)`).

## Anatomie du body de haut en bas

11 zones, rendues dans cet ordre. Les zones vides sont filtrées out (pas de blank gap).

```
┌─────────────────────────────────────────────────────────┐
│ 1. TLDR              (toujours)        [!IMPORTANT]      │
│ 2. Verdict T+30/T+60 (si mesuré)       [!TIP/CAUTION/NOTE] │
│ 3. Group banner      (toujours)        [!TIP/CAUTION]    │
│ 4. Metrics box       (toujours)        2-col × 23 rows   │
│ 5. Measurement table (si mesuré)       Delta table        │
│ 6. Pogo banner       (cond.)           [!CAUTION]        │
│ 7. Mobile-first banner (cond.)         [!CAUTION]        │
│ 8. Data quality      (cond.)           [!WARNING]        │
│ ─── divider ───                                          │
│ 9. Diagnostic        (toujours)        13-15 bullets      │
│ 10. Top 5 queries    (toujours)        Table              │
│ 11. Fact-check banner (toujours)       [!NOTE/CAUTION]    │
│ ─── divider ───                                          │
│ 12. Actions proposées (toujours)        4-6 sections       │
│ 13. Cycle de mesure  (toujours)         T0, T+30, T+60   │
│ 14. Workflow         (toujours)        Checkboxes         │
│ 15. Refs             (toujours)        IDs + Supabase    │
└─────────────────────────────────────────────────────────┘
```

---

## 1. TLDR — `[!IMPORTANT]`

**Quoi** : la synthèse exécutive en ≤280 chars : cause #1 + action #1.

**Pourquoi** : c'est ce que l'humain voit en premier. Si on ne lit qu'une chose, c'est ça.

**Code** : `renderIssueBody:tldrBlock`. Source : `diagnostic.tldr` (LLM v5+). Fallback : `diagnostic.hypothesis` pour les diagnostics legacy v1-v4.

---

## 2. Verdict T+30/T+60 — `[!TIP]` / `[!CAUTION]` / `[!NOTE]`

**Quoi** : si une mesure T+30 ou T+60 a landed, un alert affiche le verdict :
- `[!TIP]` ✅ Fix qui marche — `ctr_delta_pct ≥ 5%` AND `position_delta ≤ 0` (négatif = mieux)
- `[!CAUTION]` 🚫 Régression — `ctr_delta_pct ≤ -5%`
- `[!NOTE]` ℹ️ Mouvement neutre — entre les deux, "observer T+60"

**Pourquoi** : transformer une mesure brute en verdict actionnable visible immédiatement.

**Code** : `fmtMeasurementVerdict()`. Source : `measurements[]` (rempli par `update-issue.ts` quand `measure.ts` insert un `fix_outcomes` row).

**Limite** : règles fixes (`5%`), pas adapté au volume d'impressions. Une page à 100 impressions a une variance énorme sur le CTR.

---

## 3. Group banner — `[!TIP]` (treatment) / `[!CAUTION]` (control)

**Quoi** :
- Treatment : "À appliquer après revue"
- Control : "Groupe contrôle — ne pas appliquer pendant 4 semaines"

**Pourquoi** : protection visuelle pour ne pas appliquer un fix sur un control par accident (ce qui polluerait la mesure d'impact).

**Code** : `renderIssueBody:groupBanner`. Source : `audit_findings.group_assignment`.

---

## 4. Metrics box — 2 colonnes × 23 rows

**Quoi** : tableau exhaustif des métriques de la page.

**Pourquoi** : référence rapide pour l'humain. Permet de comparer entre pages.

**Layout** (Sprint 13 v2 + Sprint 15 + Sprint 16) :

```
| Métrique | Valeur |
|---|---|
| Position moyenne                       | X.X (drift +Y) <sub>(GSC)</sub>                |
| Impressions/mois                       | N (GSC)                                          |
| **CTR actuel**                         | **X.XX%** (GSC)                                  |
| CTR benchmark (interpolé pos. X.X)     | X.XX% (SEO calc · interpolé)                     |
| **Gap vs benchmark**                   | **X.X% sous** (SEO calc)                         |
| Pages/session                          | X.XX — interprétation (Cooked)                   |
| Durée active moyenne                   | XXs — interprétation (Cooked)                    |
| Scroll moyen                           | XX.X% — interprétation (Cooked)                  |
| LCP (p75 28j)                          | XXXXms (verdict Good/NI/Poor) (Cooked)           |
| INP (p75 28j)                          | XXXms (verdict) (Cooked)                         |
| CLS (p75 28j)                          | X.XX (verdict) (Cooked)                          |
| TTFB (p75 28j)                         | XXXms (Cooked)                                   |
| Phone clicks (28j)                     | N (Cooked)                                       |
| Email clicks (28j)                     | N (Cooked)                                       |
| Booking CTA clicks (28j)               | N (Cooked)                                       |
| Body share (CTA in-body / total)       | XX% (SEO calc · depuis Cooked cta_breakdown)     |
| Provenance / Device                    | source/medium • mob X / desk Y (Cooked)          |
| Capture rate (qualité Cooked)          | XX% (N/M) (SEO calc · Cooked ÷ GSC)              |
| Pogo / NavBoost (28j Google)           | X.X% (sticks/google_sessions, hard Y) (Cooked)   |  ← Sprint 15
| CTA rate par device (28j)              | mob X% / desk Y% (n_mob/n_desk · ratio Z) (Cooked) │  ← Sprint 16
| Engagement density (28j)               | evenness X.XX 🌗 bimodal (p25/median/p75, n=N)   │  ← Sprint 16
| Priorité                               | tier X (score Y.YY) (SEO calc)                   │
| Page                                   | [shortPath](url)                                  │
```

**Code** : `renderIssueBody:metricsBox`. Cellules computées en amont (lcpCell, pogoCell, deviceCtaCell, densityCell, captureCell, etc.).

**Convention `<sub>(...)</sub>`** : source attribution. Cf. [04-safety-nets.md](./04-safety-nets.md) §Source attribution.

---

## 5. Measurement table — 5 colonnes (T0 / T+30 / T+60 si applicable)

**Quoi** : delta table entre baseline T0 et chaque milestone.

**Pourquoi** : voir les chiffres exacts du verdict, pas juste le verdict qualitatif.

**Code** : `fmtMeasurementTable()`. Empty string si pas de mesure encore. Cols dépendent de quels milestones ont landed.

---

## 6. Pogo banner — `[!CAUTION]` (Sprint 15)

**Quoi** : "Signal NavBoost négatif fort" si `pogo_rate > 20%` AND `n_google ≥ 30`.

**Pourquoi** : visibilité prioritaire — c'est probablement la cause #1 d'une chute de position.

**Code** : `renderIssueBody:pogoBanner`. Cf. [04-safety-nets.md](./04-safety-nets.md) §5.

---

## 7. Mobile-first banner — `[!CAUTION]` (Sprint 16)

**Quoi** : "Mobile-first urgent" si `cta_rate_mobile / cta_rate_desktop < 0.25` AND `n_mobile ≥ 30`.

**Pourquoi** : détecte le mobile bleed.

**Code** : `renderIssueBody:mobileFirstBanner`. Cf. [04-safety-nets.md](./04-safety-nets.md) §6.

---

## 8. Data quality banner — `[!WARNING]` (Sprint 12)

**Quoi** : "Cooked capture rate X% — Lis les chiffres Cooked comme un lower bound, pas comme des absolus" si `capture_rate_pct < 50`.

**Pourquoi** : éviter qu'un humain prenne une décision basée sur un chiffre Cooked dont la representativité est faible.

**Code** : `renderIssueBody:dataQualityBanner`. Cf. [04-safety-nets.md](./04-safety-nets.md) §4.

---

## 9. Diagnostic — 13-15 bullets

**Quoi** : 13-15 bullets une par champ analytique du diag JSON LLM. Chaque bullet trailé par `<sub>(SourceA · SourceB)</sub>`.

**Pourquoi** : c'est le cerveau du livrable. Un humain peut comprendre ce que le LLM a déduit, et avec quelles sources.

**Layout** :
```
- **Hypothèse** — ...
- **Intent mismatch** — ... (GSC top queries · DataForSEO volumes)
- **Snippet** — ... (DOM scrape · DataForSEO SOV)
- **Engagement** — ... (Cooked · SEO calc capture rate)
- **CWV / perf** — ... (Cooked CWV 28d)
- **Structure** — ... (DOM scrape · GSC top queries)
- **Funnel** — ... (DOM Sprint-9 · Catalogue · Wix category)
- **Autorité interne** — ... (DOM Sprint-9 inbound graph)
- **Conversion** — ... (Cooked CTAs · DOM CTA placement)
- **Traffic strategy** — ... (Cooked top_referrer)
- **Device optimization** — ... (Cooked device_split)
- **Outbound leak** — ... (Cooked outbound_destinations)
- **Pogo / NavBoost** — ... (Cooked google_sessions_28d · Cooked pogo_rate_28d)  ← Sprint 15
- **Engagement pattern** — ... (Cooked engagement_density_for_path)              ← Sprint 16
```

Bullets vides (champ LLM = `''`) sont filtrées out.

**Code** : `renderIssueBody:diagBullets` + `fmtDiagBullet(label, value, ...sources)`.

---

## 10. Top 5 queries — table

**Quoi** : table des 5 queries top de la page avec `intent_match` (yes/partial/no) + note + volumes + SOV.

**Pourquoi** : référence pour valider que le diag a vu les bonnes queries.

**Code** : `fmtTopQueries(rows, 5)`.

---

## 11. Fact-check banner — `[!NOTE]` ou `[!CAUTION]` (Sprint 14bis)

**Quoi** :
- `[!NOTE]` "Fact-check — X/X chiffres tracés vers content_snapshot. 0 halluciné." (passed)
- `[!CAUTION]` "Fact-check — X chiffres non vérifiés (1 retry tenté) :" + liste (failed)

**Pourquoi** : auditer la qualité du diag. Un humain qui voit 0 halluciné peut faire confiance ; sinon il sait quoi vérifier.

**Code** : `renderIssueBody:factCheckBanner`. Source : `audit_findings.diagnostic_fact_check` JSONB. Cf. [04-safety-nets.md](./04-safety-nets.md) §2.

---

## 12. Actions proposées — 4-6 sections

**Quoi** : une section par fix proposé : title, meta, intro, internal_links, schema, content_addition.

**Pourquoi** : c'est le copy-paste pour Wix. Sans ça, le diag est inactionnable.

**Layout** : chaque section a `<details>` collapsible si `proposed_value > 300 chars` (évite de polluer le top scroll).

**Code** : `renderIssueBody:fixSections` + `fmtFixSection({ ordinal, label, fix, fallbackCurrent, blockquoteCurrent })`.

---

## 13. Cycle de mesure

**Quoi** : "T0 (baseline) : YYYY-MM-DD · T+30 mesure 1 : prévue le ... · T+60 mesure 2 : prévue le ..."

**Pourquoi** : cadre temporel visible pour que l'humain sache quand attendre les mesures.

**Code** : `renderIssueBody:cycleBlock`.

---

## 14. Workflow — checkboxes

**Quoi** :
```
- [ ] Reviewed (cocher pour valider les fixes proposés)
- [ ] Applied (cocher après push Wix)
- [ ] Measured T+30
- [ ] Measured T+60
```

**Pourquoi** : tracking visuel de l'avancement par finding. Coché manuellement par l'humain (sauf le check des Measured T+30/T+60 qui pourrait être auto-update — pas implémenté).

**Code** : `renderIssueBody:workflowBlock`.

---

## 15. Refs

**Quoi** : `audit_run_id`, `finding_id`, lien Supabase pour ouvrir directement la row finding dans le Studio.

**Pourquoi** : debug rapide — si un humain veut vérifier "qu'est-ce qui est en DB exactement", clic et il y est.

**Code** : `renderIssueBody:refsBlock`.

---

## Comment ça se met à jour

L'issue body est rendue à 3 moments :

| Moment | Code | Quoi déclenche |
|---|---|---|
| **Création** | `create-issues.ts:createIssueForFinding()` | Quand `audit_findings.github_issue_number IS NULL` et le finding est en status `proposed` |
| **Re-render après measurement** | `create-issues.ts:updateIssueAfterMeasurement(findingId)` | Appelé par `measure.ts` après chaque insert de `fix_outcomes` row |
| **Re-render manuel** (ex: après re-diagnose) | Throwaway script qui appelle `renderIssue()` puis `gh issue edit --body-file` | Quand on modifie le prompt et qu'on veut voir l'effet sur la cobaye sans recréer l'issue |

Toutes ces 3 paths utilisent le MÊME `renderIssue()` pure function. Pas de duplication de logique de rendering.

---

## Limites connues

- **Pas de bulk-update** : si tu re-cours `npm run issues`, les findings déjà avec `github_issue_number` sont skipped. Pour mettre à jour le body sans re-créer, il faut le throwaway script (ou attendre la prochaine measurement qui re-render automatiquement).
- **Body max GitHub** : 65 536 chars. Aujourd'hui les bodies font 14-17k chars. Marge confortable.
- **Markdown GitHub native** : pas de React, pas de Recharts, pas de tableaux interactifs. Tout est statique markdown + GitHub Alerts (`[!IMPORTANT]`, `[!TIP]`, `[!WARNING]`, `[!CAUTION]`, `[!NOTE]`).
- **`<details>` collapsibles** : utilisés pour les `current_value` longs et pour les blocs internal_links proposés. Empêchent le top scroll d'être noyé.
- **Pas de Live preview** : pour iterer sur le rendering, on patch + re-render via throwaway, on regarde le résultat sur GitHub. Pas de hot reload.
