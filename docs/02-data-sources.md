# 02 — Sources de données

Le LLM ne raisonne JAMAIS sur de la donnée hallucinée. Chaque chiffre cité dans un diag doit tracer vers une source réelle. Voici les 7 sources qui alimentent le prompt.

## Vue d'ensemble

| Source | Type | Ownership | Fréquence |
|---|---|---|---|
| GSC | OAuth file-based | À nous | Pull à chaque snapshot (3 mois) |
| Cooked | RPC Supabase cross-project | Agent jumeau | Lecture seule via 7 RPCs |
| DataForSEO | REST API Basic Auth | À nous | Pull par diag (volumes + SERP) |
| Wix Blog API | JWT IST | À nous | Pull par finding (auteur + dates) |
| DOM scrape | Cheerio HTTP fetch | À nous | Pull par finding (body + outline + images + CTAs) |
| Site catalog | Hardcoded TS | À nous | Statique (curé manuellement) |
| Google Search Central | RSS + JSON + HTML scrape | Public | Cache 1h (silo Sprint 19/19.5) |
| Internal link graph | Crawler interne | À nous | Pull par crawl |

---

## 1. Google Search Console (GSC)

**Quoi** : la source autoritaire pour position, CTR, impressions, clicks réels sur Google.

**Pourquoi** : c'est la seule source du "côté Google" qu'on a. Tout le scoring de findings (CTR gap vs benchmark) est dérivé de GSC.

**Comment** :
- Auth : OAuth file-based (`gsc-oauth-credentials.json` + `gsc-token.json`)
- API : `searchanalytics.query` du `webmasters.googleapis.com`
- Wrapper : `src/lib/gsc.ts`
- Pull : 3 mois rolling, dimensions `[page]` puis `[page, query]` pour les top queries
- Persisté : `gsc_page_snapshots` + `gsc_query_snapshots` (immutable, snapshot per audit_run)

**Ce que ça fournit au LLM** :
- Position moyenne + drift vs audit précédent
- CTR actuel vs benchmark interpolé
- Impressions / mois (rolling 3 mois)
- Top 10 queries de la page avec leur impressions/CTR/position individuels

**Limites** :
- 3-jours de latence Google (les données d'aujourd'hui pas encore dispo)
- Sampling sur les queries à très faible volume
- Pas de breakdown device sans dimension supplémentaire (on prend agrégé)
- Token OAuth se refresh automatiquement, mais si refresh expire → re-auth manuel

**Vérifier** :
```bash
npm run smoke  # → "GSC ✅ property=https://www.jplouton-avocat.fr/, last-7d sample rows=N"
```

---

## 2. Cooked — first-party tracker

**Quoi** : tracker first-party cookieless RGPD-exempt. Live depuis le 5 mai 2026. **Filtré bot-side depuis Sprint 17** — toutes les RPCs retournent des humains purs.

**Pourquoi** : remplace GA4 (consent-biased + sampled). Cooked n'a aucun de ces problèmes : tracking 100% first-party, non-échantillonné, RGPD-exempt. C'est notre unique source de vérité comportementale.

**Comment** :
- Projet Supabase séparé (`mxycmjkeotrycyneacje`), accédé via `service_role` cross-project
- Auth : `COOKED_SECRET_KEY` env var
- Wrapper : `src/lib/cooked.ts`
- 7 RPCs publiées :

| RPC | Retour | Usage Seo |
|---|---|---|
| `snapshot_pages_export(paths)` | 70 cols par URL : behavior 4-fenêtres (7d/28d/90d/365d), CWV p75, conversion CTAs, **pogo-stick + hard pogo + google_sessions** (Sprint 15), **mobile/desktop sessions + CTA rate** (Sprint 16), provenance, device split | Cœur du diag : alimente la metrics box + tous les `<conversion_signals>`, `<cta_breakdown>`, `<pogo_navboost>`, `<cta_per_device>`, `<device_split>` |
| `site_context_export()` | Agrégats site-wide 28d : total sessions, bounce médian, top sources | Bloc `<site_context>` pour calibrer le diag (la page X est-elle au-dessus/en-dessous de la médiane site ?) |
| `outbound_destinations_for_path(path, days)` | Top 10 destinations des clicks sortants pour cette page | Bloc `<top_outbound_destinations>` — détecte les "leaks" vers des sources externes (legifrance.gouv.fr) qu'on pourrait citer in-page |
| `cta_breakdown_for_path(path, days)` | Répartition CTAs par placement (header/footer/body) | Bloc `<cta_breakdown_by_placement>` — distingue intent qualifié (body) vs ambient (header/footer) |
| `engagement_density_for_path(path, days)` | Distribution dwell : p25/median/p75 + evenness_score | Bloc `<engagement_density>` (Sprint 16) — détecte les pages bimodales |
| `tracker_first_seen_global()` | Date du premier event capté côté tracker | Calibrage du capture rate (pro-rate sur la fenêtre où le tracker était actif) |
| `behavior_pages_for_period(from, to)` | Toutes les pages avec métriques + CWV pour une période custom | Snapshot snapshot pipeline (étape 1) |
| `pogo_rates_for_period(from, to)` | Pogo par page sur période custom | Pas utilisé en diag — outils ad-hoc seulement (le snapshot a déjà ces cols) |

**Ce que Cooked ne sait PAS** :
- SERP, CTR Google, positions, impressions (= GSC)
- Concurrents (= seulement jplouton-avocat.fr)
- Returning visitors cross-day (`anonymous_id` rotate quotidiennement)

**Limites** :
- Live depuis 5 mai 2026 → fenêtres `90d`/`365d` quasi vides au moment de la rédaction. Le prompt v11 (`fmtMultiWindowTrend`) annote ce caveat pour que le LLM ne sur-interprète pas.
- `bounce_rate_28d` per-page est en 0..100, mais `global_bounce_rate_28d` du `site_context_export()` est en 0..1 (inconsistance API documentée et neutralisée côté Seo).

**Vérifier** :
```bash
npm run smoke  # → "Cooked ✅ host=mxycmjkeotrycyneacje, snapshot_export=N_rows, site_context_sessions_28d=X, cta_breakdown=Y_rows"
```

---

## 3. DataForSEO

**Quoi** : volumes mensuels France pour chaque keyword + **SERP organic top 10** (Sprint 18) + features SERP observées.

**Pourquoi** : (a) sans le volume FR réel, le LLM ne peut pas estimer la share-of-voice (impressions GSC / volume = quel % de la demande on capte). (b) sans le SERP, le LLM diagnostique le snippet en aveugle ; avec, il sait qui sont les concurrents par leur domaine.

**Comment** :
- Auth : Basic Auth (`DATAFORSEO_AUTH` env var, base64 de `login:password`)
- 2 endpoints utilisés :
  - `keywords_data/google/search_volume/live` : volumes par keyword
  - `serp/google/organic/live/advanced` : SERP top 10 + SERP features (AI Overview, Featured Snippet, PAA, Knowledge Graph, Local Pack)
- Wrapper : `src/lib/dataforseo.ts`
- Coût : volumes ~$0.075 / batch (peu importe la taille). SERP ~$0.002 / query × top 5 queries × 17 findings × 2 LLMs = ~$0.34/audit complet

**Ce que ça fournit au LLM** :
- `<top_queries>` : enrichi avec `monthly_volume_fr` + `share_of_voice_pct`
- `<serp_competitive_landscape>` (Sprint 18) : top 10 organique par query avec position, domaine, title, snippet (truncated 100 chars) + flags features observées

**Limites** :
- Volumes : précision DataForSEO ±20% (typique pour ces APIs)
- SERP : capturé "à un instant T" — peut différer du SERP que tes utilisateurs voient (personnalisation, géolocalisation)
- Mobile vs desktop : on ne tire que desktop (moins de personnalisation)

**Vérifier** :
```bash
npm run smoke  # → "DataForSEO ✅ top1=consultation.avocat.fr · 10 organic · features={ai:0,fs:0,paa:1}"
```

---

## 4. Wix Blog API

**Quoi** : pour les pages `/post/*`, accès aux meta SEO + content + author + categoryIds + dates.

**Pourquoi** : (a) éviter de scraper le HTML rendered de Wix qui peut contenir du chrome de menu ; (b) accéder à des champs structurés (auteur, dates, categoryIds) qui n'existent pas dans le HTML.

**Comment** :
- Auth : JWT `IST.eyJ...` via `WIX_API_KEY` env var. **Important** : `WIX_ACCOUNT_ID` doit être l'account **owner** (`07454f1f-...`), pas le tenant du token (`d05c9ea4-...`). Cf. mémoire `feedback_dotenv_override.md`.
- Endpoints :
  - `getBlogPostBySlug` : meta SEO + contentText + richContent + categoryIds
  - `Blog Post Metrics` : views, likes, comments cumulatifs lifetime
  - Site Properties : info générale du site
- Wrapper : `src/lib/wix.ts`

**Ce que ça fournit au LLM** :
- `<author_eeat>` : nom de l'auteur (Maître Plouton), date publication, date modification → signal E-E-A-T sur YMYL juridique
- Catégorie Wix → mapping vers `funnel role` (article-ressource / expertise / cta)
- (Wix Blog Post Metrics utilisé pour enrichment mais pas surfacé dans le diag — low ROI)

**Limites** :
- Wix Blog Post Metrics = cumulatif lifetime, pas de range. Pour avoir un delta hebdo il faudrait snapshotter à chaque cron — pas implémenté.
- Pages non-`/post/*` : pas d'API Wix, on tombe sur le DOM scrape

**Vérifier** :
```bash
npm run smoke  # → "Wix ✅ connected to Wix site \"Cabinet Plouton\""
```

---

## 5. DOM scrape (Cheerio)

**Quoi** : extraction structurée du HTML rendered : body complet, outline H2/H3/H4 avec offsets, images + alt, CTA in-body avec offsets, schema JSON-LD.

**Pourquoi** : le LLM doit voir CE QUE LE VISITEUR VOIT, pas ce qu'on devine. Sans cet extracteur, le LLM était limité à `intro_first_100_words` (Sprint pré-14) — il ne pouvait pas compter les images sans alt, ni voir si une H2 manquait pour une top query.

**Comment** :
- User-Agent : `plouton-content-bot/1.0 (+nicolas@rewolf.studio)` (UA distinctif demandé par Cooked agent pour pouvoir filtrer côté tracker)
- Wix Studio markup stable → selectors stables : `.wixui-header`, `.wixui-footer` (strip avant analyse body)
- Wrapper : `src/lib/page-content-extractor.ts`
- Output type : `ContentSnapshot` (body_text, word_count, outline[], images[], cta_in_body_positions[], author?, extracted_at)

**Ce que ça fournit au LLM** :
- `<page_body>` : body texte complet (jusqu'à 8000 mots)
- `<page_outline>` : H2/H3/H4 avec word_offset (où dans le body)
- `<images>` : src + alt + in_body flag
- `<cta_in_body_positions>` : ancres + targets + word_offset (pour repositionner les CTAs)
- `<author_eeat>` : fallback si Wix Blog API n'a pas l'auteur (cas pages statiques)

**Limites** :
- Wix Studio JS-rendered widgets : pas capturés (rare). Si une widget critique apparaît dans le viewport mais pas dans le HTML SSR, ratée.
- Pages très longues (>10k mots) : truncated à 8000 mots (cap input tokens)

**Vérifier** :
```bash
npm run test:content-extractor  # 11 tests sur fixtures HTML
```

---

## 6. Site catalog (curé manuellement)

**Quoi** : catalogue hardcoded des URLs internes RÉELLES de jplouton-avocat.fr, avec leur rôle funnel.

**Pourquoi** : empêcher le LLM d'halluciner des URLs de maillage interne (un fix `internal_links` propose `→ https://...` doit pointer vers une URL qui existe). Le LLM voit le catalog comme "voici le seul vocabulaire d'URLs autorisé".

**Comment** :
- Hardcoded dans `src/lib/site-catalog.ts`
- 4 buckets : `topic_expertise` (pages expertise métier), `cta` (contact / honoraires-rendez-vous), `trust` (cabinet, affaires, équipe), `info` (articles informationnels)
- `WIX_CATEGORIES` mapping : Wix categoryId → bucket

**Ce que ça fournit au LLM** :
- Bloc dans le prompt diag : "Catalogue d'URLs internes RÉELLES (utilise UNIQUEMENT celles-ci pour tout maillage proposé — toute autre URL est une hallucination)"
- Bloc dans le prompt fix-gen : "URLs INTERDITES en cible de fix `internal_links` (préfixes — n'importe quelle URL commençant par l'un de ceux-ci sera rejetée)"

**Limites** :
- Curé manuellement → si Plouton publie une nouvelle page, faut l'ajouter dans `site-catalog.ts` à la main
- Pas de validation runtime que les URLs catalog existent vraiment (HEAD request) — on fait confiance à la curation

**Vérifier** : `cat src/lib/site-catalog.ts`

---

## 7. Google Search Central guidance silo (Sprint 19+19.5)

**Quoi** : silo "ce que Google dit / a publié officiellement". 5 sources :
1. Google Search Central Blog (RSS pivot keywords filter, 90 jours)
2. Search Status Dashboard (incidents en cours + ranking-system updates récentes)
3. Top 2 posts pivot deep-fetched (HTML body 1200 chars vs 220-char summary)
4. Référence officielle : 17 named ranking systems
5. Référence officielle : 17 enumerated spam policies

**Pourquoi** : mes connaissances LLM viennent de mon training data + des datas qu'on m'ingère, donc je rate naturellement les updates Google récentes. Sans ce silo, je donne des conseils potentiellement obsolètes.

**Comment** : voir [07-google-silo.md](./07-google-silo.md) pour le détail complet.

**Ce que ça fournit au LLM** :
- Bloc XML `<google_recent_guidance>` placé en haut du prompt avec 7 règles silo strictes (défère si Google contredit, cite par nom, ignore si rien pertinent, pas de hallucination "Google a dit X")

**Vérifier** :
```bash
npm run smoke  # → "Google Search Central ✅ N pivot posts (M deep) · K incidents (J active) · 17 ranking systems · 17 spam policies · cache 1h"
```

---

## 8. Internal link graph (crawler interne)

**Quoi** : graph d'autorité interne live — qui linke vers qui depuis quel placement (editorial, related, nav, footer, cta, image).

**Pourquoi** : le diag a besoin de connaître la position d'autorité de chaque page dans le maillage. Sans ce graph, le LLM ignore si la page est un hub éditorial (à protéger) ou une orpheline (à booster).

**Comment** : voir étape `crawl` dans [01-pipeline.md](./01-pipeline.md). Wrapper : `src/lib/dom-link-classifier.ts`. Persisté : `internal_link_graph` (delete-by-source-then-insert).

**Ce que ça fournit au LLM** :
- `<inbound_links_to_this_page>` : outbound_total, inbound_total, inbound_distinct_sources, inbound_editorial vs inbound_nav_footer, top 15 editorial sources avec ancres

**Limites** :
- Pas de PageRank-style propagation, c'est juste du counting
- Liens JS-rendered ratés
- Crawl complet ~5 min sur 440 URLs

---

## Récap : par quel chemin chaque source arrive au LLM

```
GSC ─────────► gsc_page_snapshots / gsc_query_snapshots ──► fetchTopQueries() ──┐
DataForSEO ──► getSearchVolumes + getSerpOrganicTop10 ────► enrichTopQueries() ─┤
Wix Blog API ► getBlogPostBySlug + getPostMetrics ─────────► fetchPostMeta() ────┤
Site catalog ► site-catalog.ts (hardcoded) ────────────────► catalogByRole() ─────┤
Google SC ───► fetchGoogleGuidance (RSS + JSON + scrape) ──► enrichContext() ────┼──► buildDiagnosticInputs(findingId)
DOM scrape ──► extractContentForFinding ──────────────────► content_snapshot ──┤              │
Cooked ──────► fetchPageSnapshotExtras + 6 autres RPCs ───► cooked_extras ──────┤              ▼
internal_link_graph ►  fetchInboundSummary ─────────────► inbound_summary ────┘     renderDiagnosticPrompt(v11)
                                                                                           │
                                                                                           ▼
                                                                              Anthropic Opus 4.7
```

Chaque flèche est un appel TS. Tout le câblage vit dans `src/pipeline/diagnose.ts:buildDiagnosticInputs()`.
