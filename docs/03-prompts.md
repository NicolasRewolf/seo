# 03 — Les prompts LLM

Deux prompts, deux LLMs distincts, deux rôles distincts.

| Prompt | Fichier | Version | Rôle | Output |
|---|---|---|---|---|
| **Diagnostic** | `src/prompts/diagnostic.v1.ts` | v11 | Identifier la cause de la sous-performance | JSON 16 sections analytiques |
| **Fix-generation** | `src/prompts/fix-generation.v1.ts` | v3 | Proposer le contenu pour la résoudre | JSON 6-8 fixes structurés |

---

## Prompt diagnostic v11

### Architecture

Le LLM (Opus 4.7, `max_tokens=8000`) reçoit un système prompt structuré en **~25 blocs XML**. Chaque bloc encapsule une source de données ou un signal. Le LLM lit dans l'ordre, puis produit un JSON validé Zod.

### Les blocs, en ordre d'apparition

| Bloc XML | Source | Pourquoi le LLM en a besoin |
|---|---|---|
| `<google_recent_guidance>` | Sprint 19/19.5 silo (5 sous-sources Google) | **Calibrage externe** : ce que Google dit officiellement maintenant. Lu en silo (pas mélangé aux autres signaux) avec 7 règles strictes (cf. [07-google-silo.md](./07-google-silo.md)) |
| `<identity>` | URL + Wix category mapping | Sait dans quelle expertise/funnel role la page se positionne |
| `<page_metrics>` | GSC | Position, drift, CTR vs benchmark = le "pourquoi cette page est flagged" |
| `<top_queries>` | GSC + DataForSEO volumes | Top 10 queries de la page avec impressions, CTR, position, **volume FR mensuel**, **share-of-voice** |
| `<serp_competitive_landscape>` | DataForSEO SERP | **(Sprint 18)** Top 10 organique Google FR pour les top 5 queries + features observées (AI Overview, Featured Snippet, PAA). Permet le diag du `snippet_weakness` causal |
| `<page_body>` | DOM extractor | Body texte complet (jusqu'à 8000 mots) |
| `<page_outline>` | DOM extractor | H2/H3/H4 avec word_offsets — sait où dans le body manque une section pour une top query |
| `<images>` | DOM extractor | Images avec alt + in_body flag — sait combien sont sans alt |
| `<author_eeat>` | Wix Blog API + DOM fallback | Auteur + dates → signal E-E-A-T critique sur YMYL juridique |
| `<cta_in_body_positions>` | DOM extractor | CTAs in-body avec word_offsets — sait si un CTA est trop tard dans le body |
| `<conversion_signals>` | Cooked snapshot | phone/email/booking clicks par fenêtre |
| `<cta_breakdown_by_placement>` | Cooked RPC | Distingue intent qualifié (body) vs ambient (header/footer) |
| `<traffic_provenance>` | Cooked snapshot | top_source/medium/referrer 28d |
| `<pogo_navboost>` | Cooked snapshot | **(Sprint 15)** Pogo-stick rate Google + reliability gate n≥30 |
| `<engagement_density>` | Cooked RPC | **(Sprint 16)** Distribution dwell : p25/median/p75 + evenness_score |
| `<cta_per_device>` | Cooked snapshot | **(Sprint 16)** mobile vs desktop CTA rate + reliability gate |
| `<device_split>` | Cooked snapshot | mobile/desktop/tablet share |
| `<multi_window_trend>` | Cooked snapshot | 7d vs 28d (avec caveat 90d/365d en cours de remplissage) |
| `<top_outbound_destinations>` | Cooked RPC | Top destinations clicks sortants |
| `<site_context>` | Cooked RPC | Médiane site, agrégats — baseline pour comparer |
| `<inbound_links_to_this_page>` | internal_link_graph | Sprint 9 — graph d'autorité interne |
| `<outbound_links_from_this_page>` | current_state | Liens sortants de la page (du DOM scrape) |
| `<data_quality_check>` | SEO calc Cooked / GSC | **(Sprint 12)** Capture rate Cooked / GSC — instruit le LLM de lire en relatif si <50% |
| `<demand_block>` | Sum DataForSEO volumes | TAM proxy : volume total mensuel des top queries |
| `<catalog>` | Hardcoded site catalog | URLs internes RÉELLES par funnel role — empêche l'hallucination de liens |

### L'output JSON

Validé par Zod (`DiagnosticSchema` dans `src/pipeline/diagnose.ts:34`). 16 champs au total :

| Champ | Quoi | Lecture LLM |
|---|---|---|
| `tldr` | Synthèse exécutive ≤280 chars : cause #1 + action #1 | C'est ce que l'humain voit en premier dans l'issue |
| `intent_mismatch` | 1-3 phrases sur le mismatch entre intent dominant des queries et cadrage actuel du title/meta/H1 | Cite les requêtes par leur volume + lit `<serp_competitive_landscape>` pour valider l'intent |
| `snippet_weakness` | 1-3 phrases sur pourquoi le snippet ne convertit pas | **Sprint 18** : compare title/meta aux concurrents top 3 SERP par leur domaine |
| `hypothesis` | 1 phrase : hypothèse principale du sous-CTR | Synthèse causale |
| `top_queries_analysis` | Array : par top query → intent_match (yes/partial/no) + note | Lit volumes FR + SOV |
| `engagement_diagnosis` | Lecture des signaux Cooked (pages/session, scroll, dwell) | Pondère par `<data_quality_check>` |
| `performance_diagnosis` | Verdict CWV vs seuils Google | Si LCP > 2500ms / INP > 200ms / CLS > 0.1 |
| `structural_gaps` | Manques structurels (word count, H2 manquants, images sans alt) | Lit `<page_body>`, `<page_outline>`, `<images>` ; cite `Scaled content abuse` du silo Sprint 19.5 si pattern matché |
| `funnel_assessment` | La page remplit-elle son rôle funnel ? Maillons manquants ? | Lit `<cta_in_body_positions>` + `<catalog>` |
| `internal_authority_assessment` | Position dans le graph interne | Lit EXCLUSIVEMENT `<inbound_links_to_this_page>` |
| `conversion_assessment` | Lecture `<cta_breakdown_by_placement>` | Distingue body (intent qualifié) vs header/footer (ambient) |
| `traffic_strategy_note` | 1 phrase à partir de `<traffic_provenance>` | Si google/organic → priorité CTR snippet ; si social → OG tags |
| `device_optimization_note` | 1-2 phrases | **Sprint 16** : lit EN PRIORITÉ `<cta_per_device>` (ratio mobile/desktop), fallback `<device_split>` qualitatif |
| `outbound_leak_note` | 1 phrase ou "pas de leak significatif" | Lit `<top_outbound_destinations>` |
| `pogo_navboost_assessment` | 1-2 phrases | **Sprint 15** : si `pogo_rate > 20%` sur n≥30 → cause #1 d'une éventuelle position_drift négative |
| `engagement_pattern_assessment` | 1-2 phrases | **Sprint 16** : si evenness < 0.15 → "distribution bimodale, intent satisfaction trop précoce" ; cross-reference avec pogo |

Tous les champs sont optionnels avec default `''` (Zod) pour rester backward-compatible avec les diagnostics persistés en DB depuis les versions précédentes.

### Cycle d'évolution

| Version | Sprint | Changement majeur |
|---|---|---|
| v1-v4 | 4-9 | Bootstrap → enrichment Wix → Cooked initial → internal link graph |
| v5 | 11 | Ré-architecture sectionnée (TLDR-first), 13 sections analytiques |
| v6 | 12 | Cooked full-menu (4 RPCs additionnelles : conversion, cta_breakdown, outbound, density) |
| v7 | 14 | **Page content extraction** — sortie des "100 premiers mots", body complet visible |
| v8 | 15 | Bloc `<pogo_navboost>` |
| v9 | 16 | Blocs `<engagement_density>` + `<cta_per_device>` + nouveau JSON output `engagement_pattern_assessment` |
| v10 | 18 | Bloc `<serp_competitive_landscape>` (DataForSEO SERP) |
| v11 | 19/19.5 | Bloc `<google_recent_guidance>` silo |

---

## Prompt fix-generation v3

### Architecture

Le LLM (Opus 4.7, `max_tokens=4000`) reçoit le diagnostic produit par le diag prompt + le contexte d'enrichment + des contraintes déontologie. Il produit 6-8 fixes prêts à appliquer.

### Inputs

- Le diag JSON complet (rendu sectionné avec étiquette d'utilité)
- `current_state` (title, meta, H1, intro actuels)
- `current_internal_links` (links sortants existants pour ne pas les re-suggérer)
- `enriched_top_queries` (avec volumes + SOV)
- **(Sprint 18)** Top 3 SERP par query — `fmtSerpTop3ForFixGen` — permet de différencier le title/meta proposé vs concurrents
- `cooked_signals_for_fixes` : raw Cooked pour chiffrer les recos (`capture_rate`, `cta_breakdown body`, `device_split`, `top_source`)
- `inbound_links_for_fixes` : autorité interne pour ne pas casser un hub
- `internal_pages_catalog` (forced URL whitelist)
- `FORBIDDEN_LINK_TARGETS` (préfixes d'URLs interdits en cible — pages legal, blog index, etc.)

### Contraintes hardcoded dans le prompt

- Cabinet d'avocats → pas de promesse de résultat (déontologie)
- Pas de "meilleur avocat" / superlatifs interdits par les ordres
- Mots-clés naturels, pas de stuffing
- **Title** : ≤60 chars, mot-clé principal en début, angle distinctif. **(Sprint 18)** L'angle DOIT se différencier des 3 premiers résultats SERP listés
- **Meta** : ≤155 chars, répond directement à l'intention principale, CTA implicite. **(Sprint 18)** Si AI Overview ou Featured Snippet présent → pousser pour la nuance que l'AI ne donne pas
- **Intro** : structure "réponse → contexte → ce que tu vas trouver dans la suite", répond à la requête principale dans la première phrase
- **Internal_links** : URLs forced depuis `internal_pages_catalog`, ne pas re-suggérer un lien existant
- **Schema** : ne pas proposer un type déjà présent ; placeholders `{{TO_FILL_BY_AUTHOR}}` pour dates inconnues
- **CTA** : tenir compte du rôle funnel — un knowledge_brick doit avoir un CTA explicite hiérarchisé

### Output

JSON validé Zod :

```ts
{
  fixes: [
    {
      fix_type: 'title' | 'meta_description' | 'h1' | 'intro' | 'schema' | 'internal_links' | 'content_addition',
      current_value: string | null,
      proposed_value: string,
      rationale: string,  // 1-2 phrases : pourquoi ce fix, quelle requête il vise, quel signal NavBoost il améliore
    }
  ]
}
```

Idempotent : `delete from proposed_fixes where finding_id=X and status='draft'`, puis insert.

### Limites

- Pas de fact-check sur le fix-gen (on s'appuie sur la qualité du diag input + les contraintes hardcoded)
- Coût ~10-15 min wall-clock par fix-gen sur Opus 4.7 (output dense, schema parfois énorme JSON-LD)
- Le LLM peut proposer des fixes "redondants" (ex: title qui dit la même chose que la meta) — accepté, c'est le job de l'humain de pruner

---

## Le retry-once cycle (côté diagnostic uniquement)

Le diag a une safety net qui n'existe PAS pour le fix-gen :

```
1. callDiagnosticLLM(prompt)        → diagnostic JSON (validé Zod)
2. factCheckDiagnostic(...)          → unverified[]
3. if unverified.length > 0:
     callDiagnosticLLM(prompt + assistant_msg + corrective_user_msg)
     → diagnostic v2
   factCheckDiagnostic(v2)
4. Persist diagnostic + diagnostic_fact_check (passed, retried_attempted)
```

Voir [04-safety-nets.md](./04-safety-nets.md) pour les patterns de fact-check.

---

## Comment modifier un prompt en sécurité

1. Modifier `src/prompts/diagnostic.v1.ts` (ou fix-generation.v1.ts)
2. Bump la version (`DIAGNOSTIC_PROMPT_VERSION = N+1`)
3. Si tu changes le shape JSON output → bump le Zod schema dans `src/pipeline/diagnose.ts` aussi (ou create-issues.ts pour le diag déjà persisté)
4. Run `npm run test:issue-template` + `npm run test:fact-check` (les tests qui touchent les helpers)
5. Run sur la cobaye **#33** seulement : `npm run diagnose -- --ids=<uuid-#33>` (cf. workflow itératif dans [10-operational.md](./10-operational.md))
6. Visiter l'issue #33 sur GitHub, valider le rendu visuel
7. Si OK → batch sur les 17 autres findings via re-run global

**Ne JAMAIS** modifier la version sans bump (la version est utilisée pour traçabilité — toutes les diagnoses persistées ont leur version au moment de la run).
