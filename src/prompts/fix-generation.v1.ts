/**
 * Fix-generation prompt — ROADMAP §8 + Sprint-7 enrichment + Sprint-11 v5 sync.
 *
 * Iteration history:
 *   v1 — Sprint 7: receives the same enrichment as the diagnostic prompt:
 *        categorized existing maillage (editorial / nav / posts similaires),
 *        the REAL site catalog of internal URLs, DataForSEO volumes per top
 *        query, the article's Wix category + funnel role, and the first-party
 *        Wix views. Without these the v0 fix-gen hallucinated link targets
 *        like /post/licenciement-faute-grave (didn't exist), invented
 *        dateModified values for schema, and re-suggested internal links
 *        that already existed.
 *   v3 — Sprint 12: synced with diagnostic v6 (Cooked full-menu). The fix
 *        LLM now receives raw Cooked counters in addition to the diagnostic
 *        prose, plus the data quality check + cta breakdown. Lets fixes be
 *        chiffrés ("phone_clicks_28d=0 sur 30 sessions → CTA in-body
 *        prioritaire") instead of derivés vagues.
 *   v2 — Sprint 11: synced with diagnostic v5. Three bugs fixed:
 *        (1) `current_internal_links` now carries the Sprint-9 `placement`
 *        field — v1 stripped it via a partial type and re-derived placement
 *        from a regex anchor-heuristic (`editorialMarkers`) abandoned in
 *        Sprint-9. The fix LLM was therefore reasoning about a stale
 *        view of the maillage.
 *        (2) The diagnostic is no longer dumped as raw `JSON.stringify`. It
 *        is rendered as labeled sections with the v5 `tldr`,
 *        `structural_gaps`, `funnel_assessment` and
 *        `internal_authority_assessment` surfaced as first-class — these
 *        are the fields that contain the most directly actionable
 *        guidance (URLs to link to, gaps to fill).
 *        (3) Optional `inbound_summary` block (Sprint-9 graph) is now
 *        passed in so an "internal_links" fix can recommend SEEDING the
 *        page from sources when it's editorially orphaned.
 */
import type { EnrichedContext, EnrichedTopQuery } from '../pipeline/context-enrichment.js';
import type { InboundSummary } from './diagnostic.v1.js';
import type {
  PageSnapshotExtras,
  CtaBreakdownRow,
} from '../lib/cooked.js';
import { FORBIDDEN_LINK_TARGETS } from '../lib/site-catalog.js';

export const FIX_GEN_PROMPT_NAME = 'fix_generation' as const;
export const FIX_GEN_PROMPT_VERSION = 3 as const;

export type FixGenPromptInputs = {
  url: string;
  position: number;
  current_title: string;
  current_meta: string;
  current_h1: string;
  current_intro: string;
  current_schema_jsonld: unknown[] | null;
  /** Sprint-11 v2: `placement` carried through (was stripped by Zod in v1). */
  current_internal_links: Array<{
    anchor: string;
    target: string;
    placement?: 'editorial' | 'related' | 'nav' | 'footer' | 'cta' | 'image';
  }>;
  top_queries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
  diagnostic: unknown;
  enrichment?: EnrichedContext;
  /** Sprint-11 v2: live inbound graph signal. Null if not yet crawled. */
  inbound_summary?: InboundSummary | null;
  // ---------- Sprint-12 v3 — Cooked full-menu (raw, not just prose) ----------
  cooked_extras?: PageSnapshotExtras | null;
  cta_breakdown?: CtaBreakdownRow[];
  gsc_clicks_28d?: number | null;
};

function fmtTopQueries(rows: FixGenPromptInputs['top_queries']): string {
  if (rows.length === 0) return '(none)';
  return rows.map((r) => `${r.query} (${r.impressions} imp, ${(r.ctr * 100).toFixed(2)}% CTR, pos ${r.position.toFixed(1)})`).join('; ');
}

function fmtEnrichedTopQueries(rows: EnrichedTopQuery[]): string {
  if (rows.length === 0) return '(none)';
  return rows
    .map((r) => {
      const ctr = (r.ctr * 100).toFixed(2);
      const vol = r.monthly_volume_fr != null ? r.monthly_volume_fr.toLocaleString('fr-FR') + ' rech/mois FR' : 'vol n/a';
      const sov = r.share_of_voice_pct != null ? `SOV ${r.share_of_voice_pct}%` : '';
      return `${r.query} — ${r.impressions} imp/3mo, CTR ${ctr}%, pos ${r.position.toFixed(1)}, ${vol}${sov ? ', ' + sov : ''}`;
    })
    .join(' | ');
}

/**
 * Sprint 18 — Compact SERP top 3 per query for fix-gen.
 *
 * Rendu différent du diagnostic : ici on veut des MUNITIONS pour différencier
 * le title/meta proposé. Format compact : top 3 organiques par query (suffit
 * pour identifier les angles à éviter / différencier).
 *
 * Le bloc fix-gen est input-only ; le LLM rend des fixes title/meta qui
 * s'appuient implicitement sur ces concurrents (cf. instructions plus bas).
 */
export function fmtSerpTop3ForFixGen(rows: EnrichedTopQuery[]): string {
  const withSerp = rows.filter((r) => r.serp != null && r.serp.organic.length > 0);
  if (withSerp.length === 0) return '_(SERP indisponible)_';
  const sections: string[] = [];
  for (const r of withSerp) {
    const s = r.serp!;
    const featBadges: string[] = [];
    if (s.features.has_ai_overview) featBadges.push('🤖AI');
    if (s.features.has_featured_snippet) featBadges.push('📌FS');
    if (s.features.has_people_also_ask) featBadges.push('❓PAA');
    if (s.features.has_local_pack) featBadges.push('📍LP');
    const featStr = featBadges.length > 0 ? ` [${featBadges.join('·')}]` : '';
    const top3 = s.organic.slice(0, 3).map((it, idx) => {
      const title = (it.title ?? '').replace(/\s+/g, ' ').slice(0, 70);
      return `  ${idx + 1}. **${it.domain ?? '?'}** — "${title}"`;
    }).join('\n');
    sections.push(`- **"${r.query}"**${featStr} :\n${top3}`);
  }
  return sections.join('\n\n');
}

/**
 * Sprint-11 v2: classification is driven by the Sprint-9 DOM `placement`
 * field stored on each link row, NOT by a regex on the anchor text.
 * Pre-Sprint-9 snapshots have all rows in the `unclassified` bucket — in
 * that case we suppress the "ne PAS re-suggérer" guidance because we
 * genuinely don't know what's in there (the same legacy-snapshot guard
 * the diagnostic v5 uses).
 */
function fmtCategorizedLinks(rows: FixGenPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '_(aucun lien sortant détecté)_';

  const buckets: Record<string, typeof rows> = {
    editorial: [], related: [], cta: [], nav: [], footer: [], image: [], unclassified: [],
  };
  for (const l of rows) {
    const k = l.placement ?? 'unclassified';
    (buckets[k] ?? buckets.unclassified)!.push(l);
  }

  const totalClassified =
    buckets.editorial!.length +
    buckets.related!.length +
    buckets.cta!.length +
    buckets.nav!.length +
    buckets.footer!.length +
    buckets.image!.length;
  const isLegacySnapshot = totalClassified === 0 && buckets.unclassified!.length > 0;

  if (isLegacySnapshot) {
    return (
      `⚠️ **Snapshot pré-Sprint-9** : ${buckets.unclassified!.length} liens sortants ` +
      `dont le placement DOM n'a pas été capturé. Tu ne peux PAS savoir lesquels ` +
      `sont éditoriaux ou nav-cruft. Pour le fix \`internal_links\`, propose ` +
      `librement depuis le catalogue ci-dessous — le QA détectera les doublons ` +
      `au moment de l'application.`
    );
  }

  const fmtRow = (l: typeof rows[number]): string =>
    `  - ${l.anchor.slice(0, 80) || '(no text)'} → ${l.target}`;

  const out: string[] = [];
  out.push(
    `LIENS ÉDITORIAUX in-body (${buckets.editorial!.length}) — **ne PAS re-suggérer** ces liens, ils existent déjà :\n` +
      (buckets.editorial!.length > 0 ? buckets.editorial!.map(fmtRow).join('\n') : '  _(aucun)_'),
  );
  if (buckets.cta!.length > 0) {
    out.push(`CTA buttons (${buckets.cta!.length}) — déjà présents :\n${buckets.cta!.map(fmtRow).join('\n')}`);
  }
  out.push(
    `LIENS auto "posts similaires" (${buckets.related!.length}) — auto-générés Wix, pas un signal éditorial actionnable.`,
  );
  out.push(
    `LIENS nav header/footer (${buckets.nav!.length} / ${buckets.footer!.length}) — présents sur toutes les pages, pas un maillage propre à cet article.`,
  );
  return out.join('\n');
}

/**
 * Sprint-11 v2: render the diagnostic as labeled, prioritized sections
 * instead of dumping raw JSON. The v5 fields (`tldr`, `structural_gaps`,
 * `funnel_assessment`, `internal_authority_assessment`) are surfaced
 * first-class because they contain the most directly actionable guidance
 * (URLs to link to, sections to add, orphan/hub posture). Any unknown
 * fields are still emitted at the bottom as JSON so legacy diagnostics
 * (v1-v4 without a tldr) and future fields don't get silently dropped.
 */
function fmtDiagnosticBlock(diag: unknown): string {
  if (!diag || typeof diag !== 'object') {
    return '_(diagnostic absent ou malformé)_';
  }
  const d = diag as Record<string, unknown>;
  const get = (k: string): string => {
    const v = d[k];
    return typeof v === 'string' ? v.trim() : '';
  };

  const sections: string[] = [];
  const tldr = get('tldr');
  if (tldr) sections.push(`> 🎯 **TL;DR du diagnostic** : ${tldr}`);

  const labelMap: Array<[string, string]> = [
    ['hypothesis', '**Hypothèse principale**'],
    ['intent_mismatch', '**Intent mismatch**'],
    ['snippet_weakness', '**Faiblesse snippet** (utile pour fix title/meta)'],
    ['engagement_diagnosis', '**Engagement** (utile pour fix intro/maillage)'],
    ['performance_diagnosis', '**Perf / CWV**'],
    ['structural_gaps', '**Manques structurels** (utile pour fix schema/content_addition)'],
    ['funnel_assessment', '**Funnel assessment** (utile pour fix internal_links — souvent contient les URLs cibles précises)'],
    ['internal_authority_assessment', '**Autorité interne** (utile si page orpheline → fix internal_links côté seeding)'],
  ];
  for (const [k, label] of labelMap) {
    const v = get(k);
    if (v) sections.push(`- ${label} — ${v}`);
  }

  // Top queries analysis (v3+) — flatten if present, else skip.
  const tqa = d['top_queries_analysis'];
  if (Array.isArray(tqa) && tqa.length > 0) {
    const lines = tqa
      .map((r) => {
        const row = r as Record<string, unknown>;
        const q = String(row.query ?? '');
        const im = String(row.intent_match ?? '');
        const note = typeof row.note === 'string' && row.note.trim() ? ` — ${row.note}` : '';
        return `  - "${q}" : intent_match=${im}${note}`;
      })
      .join('\n');
    sections.push(`- **Analyse top queries** :\n${lines}`);
  }

  return sections.join('\n');
}

function fmtInboundForFixes(s: InboundSummary | null | undefined): string {
  if (!s) return '_(graph inbound pas encore crawlé — pas de signal d\'autorité interne dispo)_';
  const orphan = s.inbound_editorial === 0 && s.inbound_total > 0;
  const hub = s.inbound_editorial >= 10;
  const lines: string[] = [
    `- **Inbound éditorial** : ${s.inbound_editorial} liens depuis ${s.inbound_distinct_sources} pages distinctes`,
    `- **Inbound nav/footer** : ${s.inbound_nav_footer} (boilerplate, pas un signal)`,
  ];
  if (orphan) {
    lines.push(
      `- ⚠️ **Page orpheline éditorialement** — un fix \`internal_links\` peut, en plus de proposer des liens SORTANTS, mentionner explicitement dans le \`rationale\` que la page bénéficierait d'être linkée DEPUIS 2-3 pages sources naturelles (info à exploiter par Nicolas hors de cette page).`,
    );
  } else if (hub) {
    lines.push(`- ✅ **Page hub** (${s.inbound_editorial} sources éditoriales) — les fixes ne doivent PAS casser la structure existante qui apporte cette autorité.`);
  }
  return lines.join('\n');
}

function fmtCatalogForFixes(catalog: EnrichedContext['internal_pages_catalog'] | undefined): string {
  if (!catalog) return '_(catalog non disponible)_';
  const fmt = (entries: typeof catalog.expertise): string =>
    entries.map((e) => `  - ${e.url}${e.topic ? ` — ${e.topic}` : ''}`).join('\n');
  const sections: string[] = [];
  if (catalog.expertise.length > 0) sections.push(`Pages expertise :\n${fmt(catalog.expertise)}`);
  if (catalog.cta.length > 0) sections.push(`Pages CTA / RDV :\n${fmt(catalog.cta)}`);
  if (catalog.trust.length > 0) sections.push(`Pages trust (cabinet/affaires) :\n${fmt(catalog.trust)}`);
  return sections.join('\n');
}

function fmtCategoryRoleForFixes(enr: EnrichedContext | undefined): string {
  if (!enr || !enr.category) return '';
  const role = enr.category.role;
  const lines: string[] = [`- **Catégorie Wix** : ${enr.category.label}`];
  if (role === 'knowledge_brick') {
    lines.push(
      "- **Rôle funnel** : article RESSOURCES — doit funneler vers (a) une page expertise thématique pertinente, (b) un CTA prise de RDV, et (c) une page trust (notre-cabinet ou nos-affaires) pour rassurer.",
    );
  } else if (role === 'topic_expertise' && enr.category.funnelTo) {
    lines.push(
      `- **Rôle funnel** : article TOPIC ALIGNÉ avec ${enr.category.label} — doit linker en priorité vers ${enr.category.funnelTo} et vers un CTA RDV.`,
    );
  } else if (role === 'press') {
    lines.push(
      "- **Rôle funnel** : article PRESSE — signal de confiance, ne pas optimiser comme une page transactionnelle.",
    );
  }
  return lines.join('\n');
}
function fmtSchemaTypes(blocks: unknown[] | null): string {
  if (!blocks || blocks.length === 0) return '(aucun)';
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return '<malformed>';
      const t = (b as Record<string, unknown>)['@type'];
      if (Array.isArray(t)) return t.join(', ');
      if (typeof t === 'string') return t;
      return '<no @type>';
    })
    .join(' / ');
}
function fmtLinks(rows: FixGenPromptInputs['current_internal_links']): string {
  if (rows.length === 0) return '(aucun lien interne sortant repéré)';
  const sample = rows.slice(0, 8).map((l) => `${l.anchor} → ${l.target}`);
  const tail = rows.length > 8 ? ` … (+ ${rows.length - 8} autres)` : '';
  return sample.join(' | ') + tail;
}

/**
 * Sprint-12 v3: compact Cooked block for the fix-gen prompt.
 * Focused on what's actionable for FIXES (vs the diagnostic which had
 * the full multi-window trend / device split / etc).
 */
function fmtCookedBlockForFixes(
  ex: PageSnapshotExtras | null | undefined,
  cta: CtaBreakdownRow[] | undefined,
  gscClicks28d: number | null | undefined,
): string {
  const lines: string[] = [];

  // Capture rate sanity — fix LLM must know if Cooked counts are reliable
  if (gscClicks28d != null && ex && ex.windows['28d'].sessions > 0) {
    const rate = (ex.windows['28d'].sessions / Math.max(1, gscClicks28d)) * 100;
    lines.push(`- capture_rate_28d: ${rate.toFixed(0)}% (${ex.windows['28d'].sessions} Cooked sessions / ${gscClicks28d} GSC clicks)`);
    if (rate < 50) {
      lines.push(`  ⚠️ Cooked under-capture cette page — chiffre tes propositions en RELATIF, pas en absolu`);
    }
  }

  if (ex) {
    const w28 = ex.windows['28d'];
    const c = ex.conversion;
    lines.push(`- 28d: sessions=${w28.sessions}, scroll_avg=${w28.scroll_avg.toFixed(0)}%, dwell=${w28.avg_dwell_seconds.toFixed(0)}s, outbound=${w28.outbound_clicks}`);
    lines.push(`- conversion 28d: phone=${c.phone_clicks['28d']}, email=${c.email_clicks['28d']}, booking_cta=${c.booking_cta_clicks['28d']}`);
    if (ex.device_split_28d) {
      const d = ex.device_split_28d;
      lines.push(`- device_split: mobile=${d.mobile.toFixed(0)}% desktop=${d.desktop.toFixed(0)}%`);
    }
    if (ex.provenance_28d.top_source) {
      lines.push(`- top_source: ${ex.provenance_28d.top_source}/${ex.provenance_28d.top_medium ?? '?'}`);
    }
  } else {
    lines.push(`_(Cooked snapshot indisponible pour cette page — capture en cours)_`);
  }

  if (cta && cta.length > 0) {
    const byPlacement: Record<string, number> = { header: 0, footer: 0, body: 0 };
    for (const r of cta) byPlacement[r.placement] = (byPlacement[r.placement] ?? 0) + r.clicks;
    const total = byPlacement.header! + byPlacement.footer! + byPlacement.body!;
    if (total > 0) {
      const bodyPct = ((byPlacement.body! / total) * 100).toFixed(0);
      lines.push(`- cta_breakdown 28d: ${byPlacement.body} body + ${byPlacement.footer} footer + ${byPlacement.header} header = ${total} (body=${bodyPct}% intent qualifié)`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '_(pas de signal Cooked exploitable)_';
}

export function renderFixGenPrompt(i: FixGenPromptInputs): string {
  const enrichedQueries: EnrichedTopQuery[] =
    i.enrichment?.enriched_top_queries ??
    i.top_queries.map((q) => ({
      ...q,
      monthly_volume_fr: null,
      cpc: null,
      share_of_voice_pct: null,
    }));

  return `Tu es un copywriter SEO expert pour cabinets d'avocats. Tu connais le funnel : article ressources → page expertise → prise de RDV. Sur la base du diagnostic suivant, propose des fixes concrets pour corriger le sous-CTR et le pages/session de cette page.

# Contexte de la page
URL : ${i.url}
${fmtCategoryRoleForFixes(i.enrichment)}
Position : ${i.position.toFixed(1)}

État actuel :
- Title : ${i.current_title || '(empty)'}
- Meta : ${i.current_meta || '(empty)'}
- H1 : ${i.current_h1 || '(empty)'}
- Intro : ${i.current_intro || '(empty)'}
- Schema.org JSON-LD présent : ${fmtSchemaTypes(i.current_schema_jsonld)}

## Maillage interne — DEUX flux distincts à NE PAS confondre

<outbound_links_from_this_page>
Liens que CETTE page émet déjà (snapshotté à l'audit, catégorisé via DOM Sprint-9). Ne re-suggère pas ces liens, ils existent.

${fmtCategorizedLinks(i.current_internal_links)}
</outbound_links_from_this_page>

<inbound_links_to_this_page>
Liens que les AUTRES pages émettent vers cette page (graph live). Lis ce bloc EXCLUSIVEMENT pour évaluer l'autorité interne — pas pour proposer des liens sortants.

${fmtInboundForFixes(i.inbound_summary)}
</inbound_links_to_this_page>

# Top queries avec volume FR et share of voice
${fmtEnrichedTopQueries(enrichedQueries)}

# SERP top 3 par query (Sprint 18 — concurrents directs en SERP Google FR)
Cette liste te dit QUI tu as à battre. Quand tu écris title/meta, ton angle DOIT se différencier des 3 premiers résultats — sinon le snippet noie dans la masse. Lis aussi les SERP features (AI, Featured Snippet, PAA, Local Pack) : si AI Overview présent, le CTR organique est plafonné, propose plutôt un title qui pousse à cliquer pour la nuance que l'AI ne donne pas.

${fmtSerpTop3ForFixGen(enrichedQueries)}

# Catalogue d'URLs internes RÉELLES (utilise UNIQUEMENT celles-ci pour tout maillage proposé — toute autre URL est une hallucination que le QA rejettera)
${fmtCatalogForFixes(i.enrichment?.internal_pages_catalog)}

# URLs INTERDITES en cible de fix \`internal_links\` (préfixes — n'importe quelle URL commençant par l'un de ceux-ci sera rejetée)
${FORBIDDEN_LINK_TARGETS.map((p) => `- ${p}`).join('\n')}
> Pourquoi : ces URLs apparaissent légitimement dans le maillage (footer, mentions légales, blog index Wix) mais n'ont **aucune valeur éditoriale** comme cible de recommandation. Si tu veux pousser un lien CTA, propose une page \`expertise\` ou \`cta\` (honoraires-rendez-vous) du catalogue, pas une page index ni une page legal.

# Diagnostic (rendu sectionné — lis le TL;DR puis pondère les autres sections en fonction de leur étiquette d'utilité)
${fmtDiagnosticBlock(i.diagnostic)}

# Signaux Cooked raw (Sprint-12) — chiffre tes recos avec ces nombres, pas avec la prose du diagnostic seul

<cooked_signals_for_fixes>
${fmtCookedBlockForFixes(i.cooked_extras, i.cta_breakdown, i.gsc_clicks_28d)}
</cooked_signals_for_fixes>

**Comment t'en servir** :
- Si \`capture_rate < 50%\` : reste en relatif ("renforcer" plutôt que "ajouter X clicks")
- Si \`cta_breakdown body=0\` ET \`phone_clicks_28d=0\` : fix \`internal_links\` doit absolument inclure un CTA in-body (pas juste header/footer)
- Si \`cta_breakdown body > 0\` : la page CONVERTIT déjà en intent qualifié — les fixes ne doivent PAS perturber le placement du CTA in-body existant
- Si \`device_split.mobile > 65%\` : le title et l'intro doivent être lus mobile-first (snippets coupés à ~30 chars sur mobile)
- Si \`top_source = google/organic\` : priorité title+meta (la SERP est ton champ de bataille). Si autre : adapter (OG tags pour social, etc.)

# Tes contraintes
- Le client est Cabinet Plouton, avocat pénaliste à Bordeaux
- Pas de promesse de résultat (déontologie avocat)
- Pas de "meilleur avocat" ou superlatifs interdits par les ordres
- Mots-clés naturels, pas de stuffing
- Title : ≤60 caractères, mot-clé principal en début, angle distinctif (spécificité géographique, donnée chiffrée, ou bénéfice concret). **(Sprint 18) L'angle DOIT se différencier des titles des 3 premiers résultats SERP listés plus haut** — si Wikipedia est en pos 1 sur une query informationnelle, ton angle doit être "avocat/expertise/cas concrets/risque" plutôt qu'une définition encyclopédique.
- Meta : ≤155 caractères, répond directement à l'intention principale, contient un appel à l'action implicite. **(Sprint 18) Si AI Overview ou Featured Snippet présent dans la SERP, ta meta doit pousser le clic pour la nuance/personnalisation que l'AI ne donne pas** (ex: "selon votre situation", "avec un avocat pénaliste", "cas concrets bordelais"). Sinon, viser le snippet le plus actionnable possible.
- Intro (100 premiers mots) : répond à la requête principale dans la première phrase, pas d'intro contextuelle, structure "réponse → contexte → ce que tu vas trouver dans la suite"
- **Pour les liens internes** :
  - URLs proposées DOIVENT venir du catalogue ci-dessus (pas d'invention)
  - Ne PAS re-suggérer un lien déjà listé dans "LIENS ÉDITORIAUX in-body" (il existe déjà)
  - Si un lien éditorial existant pointe vers une mauvaise sous-expertise, dis-le explicitement et propose le REMPLACEMENT
- **Pour le schema** : ne propose pas un type déjà présent. Pour Article schema, n'invente pas de dateModified/datePublished — si tu n'as pas la vraie date, écris "{{TO_FILL_BY_AUTHOR}}" comme placeholder.
- **Pour les CTA** : tenir compte du rôle funnel ci-dessus. Un knowledge_brick doit avoir un CTA explicite et hiérarchisé en bas d'article, pas noyé.

# Format de réponse JSON strict

{
  "fixes": [
    // Une entrée par fix que tu décides de proposer. Tu choisis dynamiquement
    // les fix_type pertinents — ne propose que ce qui apporte un vrai gain.
    //
    // Valeurs possibles pour fix_type :
    //   - "title"             — toujours pertinent si le title actuel est ≥60 chars, ne match pas l'intent, ou enterre les mots-clés
    //   - "meta_description"  — toujours pertinent si la meta est >155 chars, manque un signal différenciant ou un bénéfice
    //   - "h1"                — UNIQUEMENT si le H1 diffère du title et peut être affûté
    //   - "intro"             — si l'intro actuelle est faible, polluée (nav cruft), ou ne répond pas à la requête principale
    //   - "schema"            — UNIQUEMENT si un type Schema.org pertinent manque (ex: FAQPage si les top queries sont des questions, BreadcrumbList si la page a une hiérarchie claire). Pour le proposed_value, fournis du JSON-LD valide complet en string.
    //   - "internal_links"    — si NavBoost faible (pages/session bas, durée courte) OU si maillage anémique. Format proposed_value: "ancre1 → URL1 | ancre2 → URL2 | ancre3 → URL3"
    //   - "content_addition"  — UNIQUEMENT si une top query est partiellement matched et appelle une section éditoriale manquante. Décris la section à ajouter (titre + 2-3 lignes du contenu attendu).
    //
    // Toujours proposer title et meta_description si les valeurs actuelles ne sont pas optimales.
    // Les autres ne doivent apparaître que si réellement actionnables.
    {
      "fix_type": "<une des valeurs ci-dessus>",
      "current_value": "<la valeur actuelle exacte, ou null si non applicable>",
      "proposed_value": "<ta proposition>",
      "rationale": "1-2 phrases : pourquoi ce fix, quelle requête il vise, quel signal NavBoost il améliore"
    }
  ]
}

Réponds UNIQUEMENT avec le JSON, pas de markdown, pas de préambule.`;
}
