/**
 * GitHub issue Markdown template — ROADMAP §9.
 *
 * Pure renderer: takes a fully-loaded IssueInputs object and returns
 * { title, body, labels }. No DB / API access here so the template can be
 * unit-tested in isolation and previewed without touching GitHub.
 *
 * Sprint 11 redesign — synthesis-first, scannable layout:
 *   1. TL;DR callout (the v5 diagnostic.tldr — single sentence cause + action)
 *   2. Compact GSC + Cooked metrics box (single table, no prose around it)
 *   3. Diagnostic bullets (one bullet per analytic field; no more 5 H2s of
 *      prose to skim)
 *   4. Numbered actions with cible-CTR hint
 *   5. Footer (cycle dates / workflow / refs)
 *
 * Sprint 13 UI/UX pass — within GitHub markdown limits:
 *   - Native GitHub Alerts (`> [!IMPORTANT]`, `> [!TIP]`, `> [!WARNING]`,
 *     `> [!CAUTION]`) replace emoji-prefixed blockquotes — colored boxes
 *     rendered natively by GitHub, no custom CSS needed.
 *   - `<sub>(Source)</sub>` discreet inline source attribution per data
 *     point + per diagnostic bullet so the human reader can tell at a
 *     glance whether a value comes from GSC, Cooked, DataForSEO, DOM
 *     scrape, computed SEO-side, or LLM synthesis. Convention via
 *     fmtSource() helper.
 *   - <details> collapsibles for verbose `current_value` blocks (intro,
 *     internal_links) — reduces visual clutter while keeping the data
 *     accessible on click.
 */
import { addDays, format } from 'date-fns';

/**
 * Sprint 13 — discreet inline source attribution.
 * Renders as small text below or after a data point, e.g.:
 *   "Pages/session 1.0 <sub>_(Cooked)_</sub>"
 *
 * Convention used across the issue:
 *   - GSC          → Google Search Console (impressions, clicks, CTR, position)
 *   - Cooked       → first-party tracker (behavior, CWV, conversion CTAs, provenance, device)
 *   - DataForSEO   → keyword volume FR, share of voice
 *   - Wix          → category, blog views/likes/comments
 *   - DOM          → Sprint-9 HTML scrape (title, meta, H1, intro, schema, link placement)
 *   - SEO calc     → SEO-side computed value (ctr_expected interpolation,
 *                    capture_rate, priority_score, CWV verdicts, formules)
 *   - LLM          → Claude Sonnet 4.6 synthesis
 *   - Catalogue    → curated lib/site-catalog.ts (anti-hallucination URLs)
 */
function fmtSource(...sources: string[]): string {
  if (sources.length === 0) return '';
  return ` <sub>_(${sources.join(' · ')})_</sub>`;
}

export type IssueProposedFix = {
  fix_type:
    | 'title'
    | 'meta_description'
    | 'h1'
    | 'intro'
    | 'schema'
    | 'internal_links'
    | 'content_addition';
  current_value: string | null;
  proposed_value: string;
  rationale: string;
};

export type IssueDiagnostic = {
  /** Sprint-11 v5: single-sentence synthesis. Fallback to '' for older diagnostics. */
  tldr?: string;
  intent_mismatch: string;
  snippet_weakness: string;
  hypothesis: string;
  engagement_diagnosis: string;
  /** Sprint-8 (v2). May be '' on legacy v1 diagnostics. */
  performance_diagnosis?: string;
  /** Sprint-7 (v3). May be '' on legacy v1/v2 diagnostics. */
  structural_gaps?: string;
  funnel_assessment?: string;
  /** Sprint-9 (v4). May be '' on legacy v1-v3 diagnostics. */
  internal_authority_assessment?: string;
  /** Sprint-12 (v6). May be '' on legacy v1-v5 diagnostics. */
  conversion_assessment?: string;
  traffic_strategy_note?: string;
  device_optimization_note?: string;
  outbound_leak_note?: string;
  /** Sprint-15 (v8). May be '' on legacy v1-v7 diagnostics. */
  pogo_navboost_assessment?: string;
  /** Sprint-16 (v9). May be '' on legacy v1-v8 diagnostics. */
  engagement_pattern_assessment?: string;
  top_queries_analysis: Array<{
    query: string;
    impressions: number;
    ctr: number;
    position: number;
    intent_match: 'yes' | 'partial' | 'no';
    note?: string;
  }>;
};

/** Sprint-14 — one row from `fix_outcomes`, surfaced in the issue body
 *  after a T+30 or T+60 measurement has landed. The issue template
 *  renders ZERO measurement UI when the array is empty (default state
 *  for findings that haven't been measured yet). */
export type IssueMeasurement = {
  days_after_fix: number; // typically 30 or 60
  measured_at: string; // ISO timestamp
  applied_at: string; // ISO timestamp — fix application date (T0)
  baseline_ctr: number; // 0..1
  current_ctr: number; // 0..1
  ctr_delta_pct: number; // signed % change (e.g. +16.2 = +16.2%)
  baseline_position: number;
  current_position: number;
  position_delta: number; // current - baseline (negative = improvement)
  baseline_impressions: number;
  current_impressions: number;
  /** Optional treatment-vs-control gap note ("ctr +5.2% / position -0.3"). */
  significance_note?: string | null;
};

/** Sprint-12: optional Cooked extras surfaced in the issue box. Issue
 *  template is rendered without these on findings created before Sprint-12,
 *  so all fields are optional and degraded cleanly. */
export type IssueCookedExtras = {
  // CWV — already classified Good / Needs Improvement / Poor against Google thresholds
  lcp_p75_ms?: number | null;
  inp_p75_ms?: number | null;
  cls_p75?: number | null;
  ttfb_p75_ms?: number | null;
  // Sprint-12 hotfix: 28d behavior signals from Cooked, used as fallback for
  // the box when audit_findings columns are null (forged findings / stale
  // behavior_page_snapshots).
  pages_per_session_28d?: number | null;
  avg_session_duration_28d?: number | null;
  scroll_avg_28d?: number | null;
  // Conversion — 28d CTAs with body-vs-ambient breakdown
  phone_clicks_28d?: number | null;
  email_clicks_28d?: number | null;
  booking_cta_clicks_28d?: number | null;
  cta_body_pct?: number | null; // % of CTA clicks that came from body (intent qualified)
  // Provenance
  top_source?: string | null;
  top_medium?: string | null;
  /** Sprint-12 hotfix: fallback when top_source is null (no UTM tagging). */
  top_referrer?: string | null;
  // Device
  device_split?: { desktop: number; mobile: number; tablet: number } | null;
  // Data quality (capture rate)
  cooked_sessions_28d?: number | null;
  gsc_clicks_28d?: number | null;
  capture_rate_pct?: number | null; // 0..100
  // Sprint-15 — Pogo-sticking signal (NavBoost negative). All optional; pages
  // with no Google traffic over 28d get nulls (cannot compute the rate).
  google_sessions_28d?: number | null;
  pogo_sticks_28d?: number | null;
  hard_pogo_28d?: number | null;
  pogo_rate_pct?: number | null; // 0..100, already computed by Cooked
  // Sprint-16 — CTA conversion rate split by device + dwell distribution.
  // The 4 CTA fields come from snapshot_pages_export(), the engagement
  // density fields come from the engagement_density_for_path RPC.
  mobile_sessions_28d?: number | null;
  desktop_sessions_28d?: number | null;
  cta_rate_mobile_pct?: number | null; // 0..100
  cta_rate_desktop_pct?: number | null; // 0..100
  density_sessions_28d?: number | null;
  density_dwell_p25_seconds?: number | null;
  density_dwell_median_seconds?: number | null;
  density_dwell_p75_seconds?: number | null;
  density_evenness_score?: number | null; // 0..1
};

export type IssueInputs = {
  // Identifiers
  finding_id: string;
  audit_run_id: string;
  page: string;

  // Metrics
  avg_position: number;
  position_drift: number | null;
  impressions: number; // total over the analysis window
  audit_period_months: number;
  ctr_actual: number;
  ctr_expected: number;
  ctr_gap: number; // 0..1
  priority_score: number;
  priority_tier: 1 | 2 | 3;
  group_assignment: 'treatment' | 'control';

  // Engagement
  pages_per_session: number | null;
  avg_session_duration_seconds: number | null;
  scroll_depth_avg: number | null;

  // Current SEO state (used for fix "current" values when missing on the fix itself)
  current_title: string;
  current_meta: string;
  current_intro: string;

  // LLM payload
  diagnostic: IssueDiagnostic;
  fixes: IssueProposedFix[];

  // Cycle dates
  baseline_date: string; // yyyy-MM-dd

  // Optional links to external dashboards
  supabase_finding_url?: string;

  // Sprint-12: Cooked full-menu extras for the issue box. Optional —
  // findings created before Sprint-12 render cleanly without it.
  cooked_extras?: IssueCookedExtras;

  // Sprint-14: outcomes from measure.ts (T+30, T+60). Optional — the
  // measurement UI (verdict alert + delta table) only renders when at
  // least one measurement exists. Pre-measurement, the issue body is
  // identical to a Sprint-13 render.
  measurements?: IssueMeasurement[];

  // Sprint-14bis: fact-check result for the diagnostic v7 numeric claims.
  // Optional — pre-Sprint-14bis findings render cleanly without it.
  // When present, surfaces a [!CAUTION] alert in the body if any claim
  // didn't trace to content_snapshot, or a [!NOTE] confirming "0 chiffre
  // halluciné" when everything verified.
  fact_check?: IssueFactCheck;
};

export type IssueFactCheck = {
  total_numeric_claims: number;
  verified: number;
  unverified: Array<{ claim: string; field: string; note?: string }>;
  passed: boolean;
  retry_attempted: boolean;
};

function pct(n: number, digits = 2): string {
  return (n * 100).toFixed(digits);
}

function shortPath(url: string, max = 60): string {
  try {
    const u = new URL(url);
    // WHATWG URL re-encodes non-ASCII pathnames; decode for human readability.
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep encoded if invalid escapes
    }
    return p.length > max ? p.slice(0, max - 1) + '…' : p;
  } catch {
    return url.length > max ? url.slice(0, max - 1) + '…' : url;
  }
}

export function renderIssueTitle(i: IssueInputs): string {
  const path = shortPath(i.page, 60);
  return `[SEO-P${i.priority_tier}] ${path} — CTR ${pct(i.ctr_actual)}% vs ${pct(i.ctr_expected)}% en pos. ${i.avg_position.toFixed(1)}`;
}

export function renderIssueLabels(i: IssueInputs): string[] {
  return [
    'seo-audit',
    `priority-${i.priority_tier}`,
    i.group_assignment,
    'status:proposed',
  ];
}

function fmtNumOrNA(n: number | null | undefined, suffix = '', digits = 2): string {
  if (n == null) return 'n/a';
  return `${typeof n === 'number' ? n.toFixed(digits) : n}${suffix}`;
}

function ppsInterpretation(n: number | null): string {
  if (n == null) return 'pas de données';
  if (n < 1.3) return '⚠️ rebond rapide (< 1.3)';
  if (n < 2.0) return 'standard';
  return '✅ navigation profonde';
}
function durationInterpretation(s: number | null): string {
  if (s == null) return 'pas de données';
  if (s < 30) return '⚠️ pogo-stick (< 30s)';
  if (s < 90) return 'court mais lu';
  return '✅ session longue';
}
function scrollInterpretation(p: number | null): string {
  if (p == null) return 'pas de données';
  if (p < 50) return '⚠️ scroll superficiel (< 50%)';
  if (p < 75) return 'lecture partielle';
  return '✅ scroll profond';
}

// ============================================================================
// Sprint-14 — measurement (T+30 / T+60) rendering helpers.
// All emit empty string when no measurements are passed, so the Sprint-13
// body stays unchanged for pre-measurement findings.
// ============================================================================

/**
 * Verdict alert at the top of the issue (right after TLDR). Uses the
 * MOST RECENT measurement to call green / yellow / red. Empty string
 * when no measurements yet.
 *
 * Verdict logic — keep it simple and conservative:
 *   - CTR delta ≥ +5%  AND  position delta ≤ 0  → ✅ TIP    (fix qui marche)
 *   - CTR delta ≤ -5%                            → 🚫 CAUTION (régression)
 *   - else                                       → ℹ️ NOTE   (mouvement neutre)
 */
/**
 * Sprint-14bis — fact-check banner. Shows under the diagnostic if any
 * numeric claim didn't trace to <page_body>/<page_outline>/<images>/
 * <cta_in_body_positions>. Renders nothing when no fact-check is on the
 * finding (pre-Sprint-14bis), or as a quiet [!NOTE] confirming "0 chiffre
 * halluciné" when everything verified.
 */
function fmtFactCheckBanner(fc: IssueFactCheck | undefined): string {
  if (!fc) return '';
  if (fc.passed) {
    if (fc.total_numeric_claims === 0) return '';
    const retried = fc.retry_attempted ? ' (corrigé en 1 retry)' : '';
    return [
      `> [!NOTE]`,
      `> **Fact-check** — ${fc.verified}/${fc.total_numeric_claims} chiffres tracés vers \`content_snapshot\`${retried}. 0 halluciné.`,
      `> ${fmtSource('SEO calc · diagnostic-fact-check').trim()}`,
    ].join('\n');
  }
  const items = fc.unverified
    .slice(0, 5)
    .map((u) => `> - \`${u.field}\` — "${u.claim}"${u.note ? ` (${u.note})` : ''}`);
  const overflow = fc.unverified.length > 5 ? `\n> - …et ${fc.unverified.length - 5} de plus` : '';
  const retried = fc.retry_attempted ? ' (1 retry tenté)' : '';
  return [
    `> [!CAUTION]`,
    `> **Fact-check** — ${fc.unverified.length}/${fc.total_numeric_claims} chiffre${fc.unverified.length > 1 ? 's' : ''} non vérifié${fc.unverified.length > 1 ? 's' : ''}${retried}. À recouper avec la page :`,
    items.join('\n') + overflow,
    `> ${fmtSource('SEO calc · diagnostic-fact-check').trim()}`,
  ].join('\n');
}

function fmtMeasurementVerdict(measurements: IssueMeasurement[] | undefined): string {
  if (!measurements || measurements.length === 0) return '';
  const sorted = [...measurements].sort((a, b) => a.days_after_fix - b.days_after_fix);
  const latest = sorted[sorted.length - 1]!;
  const ctrSignal = latest.ctr_delta_pct;
  const posSignal = latest.position_delta; // negative = better
  let alert: string;
  let verdict: string;
  if (ctrSignal >= 5 && posSignal <= 0) {
    alert = '[!TIP]';
    verdict = `✅ **Fix qui marche** — garder. CTR ${ctrSignal > 0 ? '+' : ''}${ctrSignal.toFixed(1)}%${posSignal !== 0 ? `, position ${posSignal > 0 ? '+' : ''}${posSignal.toFixed(2)}` : ''}.`;
  } else if (ctrSignal <= -5) {
    alert = '[!CAUTION]';
    verdict = `🚫 **Régression** — envisager rollback. CTR ${ctrSignal.toFixed(1)}%${posSignal !== 0 ? `, position ${posSignal > 0 ? '+' : ''}${posSignal.toFixed(2)}` : ''}.`;
  } else {
    alert = '[!NOTE]';
    verdict = `ℹ️ **Mouvement neutre** — observer T+60 avant conclusion. CTR ${ctrSignal > 0 ? '+' : ''}${ctrSignal.toFixed(1)}%${posSignal !== 0 ? `, position ${posSignal > 0 ? '+' : ''}${posSignal.toFixed(2)}` : ''}.`;
  }
  return [
    `> ${alert}`,
    `> ### 📈 Mesure T+${latest.days_after_fix} (${latest.measured_at.slice(0, 10)})`,
    `> Fix appliqué le ${latest.applied_at.slice(0, 10)}.`,
    `> ${verdict}`,
    `> ${fmtSource('SEO calc · GSC fix_outcomes vs baseline T0').trim()}`,
  ].join('\n');
}

/**
 * Detail delta table — sits AFTER the baseline metrics box so the
 * comparison is visually adjacent. Shows CTR / position / impressions.
 * Cols depend on which milestones have landed (T+30 only, or both
 * T+30 + T+60 side by side). Cooked-side deltas are TODO — `fix_outcomes`
 * stores GSC only today; once we extend it to capture Cooked baseline,
 * we'll add rows here.
 */
function fmtMeasurementTable(measurements: IssueMeasurement[] | undefined): string {
  if (!measurements || measurements.length === 0) return '';
  const sorted = [...measurements].sort((a, b) => a.days_after_fix - b.days_after_fix);
  const t30 = sorted.find((m) => m.days_after_fix === 30) ?? null;
  const t60 = sorted.find((m) => m.days_after_fix === 60) ?? null;

  const fmtCtr = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const fmtPos = (n: number): string => n.toFixed(1);
  const fmtImp = (n: number): string => Math.round(n).toLocaleString('fr-FR');
  const arrow = (deltaPct: number, lowerIsBetter = false): string => {
    if (Math.abs(deltaPct) < 1) return '';
    const positive = lowerIsBetter ? deltaPct < 0 : deltaPct > 0;
    return positive ? ' ✅' : ' 🚫';
  };
  const fmtDeltaPct = (n: number, lowerIsBetter = false): string =>
    `${n > 0 ? '+' : ''}${n.toFixed(1)}%${arrow(n, lowerIsBetter)}`;
  const fmtPosDelta = (n: number): string =>
    `${n > 0 ? '+' : ''}${n.toFixed(2)}${n === 0 ? '' : n < 0 ? ' ✅' : ' 🚫'}`;
  const impDelta = (b: number, c: number): string => {
    if (!b || b === 0) return '—';
    const pct = ((c - b) / b) * 100;
    return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };

  // Take baseline from the earliest measurement available — they should
  // all have the same baseline (same T0).
  const base = sorted[0]!;

  if (!t60) {
    // T+30 only
    const m = t30 ?? sorted[0]!;
    return [
      `### 📈 Détail mesure T+30${fmtSource('SEO calc · fix_outcomes')}`,
      ``,
      `| Métrique | T0 baseline | T+30 mesuré | Δ |`,
      `|---|---|---|---|`,
      `| CTR | ${fmtCtr(base.baseline_ctr)} | ${fmtCtr(m.current_ctr)} | ${fmtDeltaPct(m.ctr_delta_pct)} |`,
      `| Position moyenne | ${fmtPos(base.baseline_position)} | ${fmtPos(m.current_position)} | ${fmtPosDelta(m.position_delta)} |`,
      `| Impressions | ${fmtImp(base.baseline_impressions)} | ${fmtImp(m.current_impressions)} | ${impDelta(base.baseline_impressions, m.current_impressions)} |`,
      m.significance_note ? `\n_${m.significance_note}_` : '',
    ].filter((s) => s !== '').join('\n');
  }

  // Both T+30 and T+60
  const lines = [
    `### 📈 Détail mesure T+30 / T+60${fmtSource('SEO calc · fix_outcomes')}`,
    ``,
    `| Métrique | T0 baseline | T+30 mesuré | Δ T+30 | T+60 mesuré | Δ T+60 |`,
    `|---|---|---|---|---|---|`,
  ];
  const c30 = t30!;
  const c60 = t60;
  lines.push(
    `| CTR | ${fmtCtr(base.baseline_ctr)} | ${fmtCtr(c30.current_ctr)} | ${fmtDeltaPct(c30.ctr_delta_pct)} | ${fmtCtr(c60.current_ctr)} | ${fmtDeltaPct(c60.ctr_delta_pct)} |`,
  );
  lines.push(
    `| Position moyenne | ${fmtPos(base.baseline_position)} | ${fmtPos(c30.current_position)} | ${fmtPosDelta(c30.position_delta)} | ${fmtPos(c60.current_position)} | ${fmtPosDelta(c60.position_delta)} |`,
  );
  lines.push(
    `| Impressions | ${fmtImp(base.baseline_impressions)} | ${fmtImp(c30.current_impressions)} | ${impDelta(base.baseline_impressions, c30.current_impressions)} | ${fmtImp(c60.current_impressions)} | ${impDelta(base.baseline_impressions, c60.current_impressions)} |`,
  );
  if (c60.significance_note) lines.push(`\n_${c60.significance_note}_`);
  return lines.join('\n');
}

function fmtDriftCell(drift: number | null): string {
  if (drift == null) return 'n/a (premier audit)';
  if (drift > 0) return `+${drift.toFixed(1)} positions sur 3 mois`;
  return `${drift.toFixed(1)} positions sur 3 mois`;
}

function findFix(fixes: IssueProposedFix[], type: IssueProposedFix['fix_type']): IssueProposedFix | null {
  return fixes.find((f) => f.fix_type === type) ?? null;
}

function fmtFixSection(opts: {
  ordinal: number;
  label: string;
  fix: IssueProposedFix | null;
  fallbackCurrent?: string;
  blockquoteCurrent?: boolean;
}): string {
  if (!opts.fix) return '';
  const cur = opts.fix.current_value ?? opts.fallbackCurrent ?? '(empty)';
  const fmt = opts.blockquoteCurrent
    ? `> ${cur.replace(/\n/g, '\n> ')}`
    : '```\n' + cur + '\n```';
  const proposedFmt = opts.blockquoteCurrent
    ? `> ${opts.fix.proposed_value.replace(/\n/g, '\n> ')}`
    : '```\n' + opts.fix.proposed_value + '\n```';

  // Sprint-13 UI: collapse the verbatim "Actuel" block when it's long
  // (intro >300 chars, internal_links proposals). Keeps the fix scannable
  // — the reader expands only if they need to compare verbatim.
  const isLongCurrent = cur.length > 300;
  const currentBlock = isLongCurrent
    ? [
        `<details>`,
        `<summary><b>Actuel</b>${fmtSource('DOM scrape')} — cliquer pour voir</summary>`,
        ``,
        fmt,
        ``,
        `</details>`,
      ].join('\n')
    : [
        `**Actuel**${fmtSource('DOM scrape')} :`,
        fmt,
      ].join('\n');

  return [
    `### ${opts.ordinal}. ${opts.label}${fmtSource('LLM fix-gen')}`,
    ``,
    currentBlock,
    ``,
    `**Proposé** :`,
    proposedFmt,
    ``,
    `**Pourquoi** : ${opts.fix.rationale}`,
    ``,
    `---`,
    ``,
  ].join('\n');
}

function fmtTopQueries(rows: IssueDiagnostic['top_queries_analysis'], limit = 5): string {
  const subset = rows.slice(0, limit);
  if (subset.length === 0) return '_(pas de données de requêtes)_';
  // Sprint-13: column-level source tags (GSC for the metrics, LLM for the
  // intent_match verdict). Compact via <sub> in the header row.
  const lines = [
    `| Requête <sub>(GSC)</sub> | Imp <sub>(GSC)</sub> | CTR <sub>(GSC)</sub> | Pos <sub>(GSC)</sub> | Intent match <sub>(LLM)</sub> |`,
    `|---|---|---|---|---|`,
  ];
  for (const r of subset) {
    // Sprint-12 hotfix: the LLM outputs CTR as either a fraction (0..1, e.g. 0.0165)
    // OR as a percent (e.g. 1.65) depending on how it copies from the prompt input.
    // Detect defensively — values > 1 are necessarily already a percent.
    const ctrPct = (r.ctr > 1 ? r.ctr : r.ctr * 100).toFixed(2);
    lines.push(
      `| ${r.query} | ${r.impressions} | ${ctrPct}% | ${r.position.toFixed(1)} | ${r.intent_match} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Render a tight diagnostic bullet — only emits the bullet if the field is
 * non-empty (so legacy v1/v2 diagnostics don't show "Structure: " orphans).
 * The label is bolded; the body is rendered as-is (LLM controls the prose).
 *
 * Sprint 13: trailing `<sub>_(LLM · sources)_</sub>` so the reader sees at
 * a glance which sources fed this bullet's reasoning.
 */
function fmtDiagBullet(label: string, value: string | undefined, ...sources: string[]): string {
  if (!value || !value.trim()) return '';
  return `- **${label}** — ${value.trim()}${fmtSource('LLM', ...sources)}`;
}

export function renderIssueBody(i: IssueInputs): string {
  const monthlyImp = Math.round(i.impressions / i.audit_period_months);
  const baselineDate = i.baseline_date;
  const baseline = new Date(`${baselineDate}T00:00:00Z`);
  const t30 = format(addDays(baseline, 30), 'yyyy-MM-dd');
  const t60 = format(addDays(baseline, 60), 'yyyy-MM-dd');

  const titleFix = findFix(i.fixes, 'title');
  const metaFix = findFix(i.fixes, 'meta_description');
  const introFix = findFix(i.fixes, 'intro');
  const linksFix = findFix(i.fixes, 'internal_links');

  const linksSection = linksFix
    ? [
        `### 4. Maillage interne${fmtSource('LLM fix-gen', 'Catalogue')}`,
        ``,
        `<details>`,
        `<summary><b>Proposé</b> — cliquer pour voir le détail</summary>`,
        ``,
        linksFix.proposed_value,
        ``,
        `</details>`,
        ``,
        `**Pourquoi** : ${linksFix.rationale}`,
        ``,
        `---`,
        ``,
      ].join('\n')
    : '';

  // ---- TL;DR callout (Sprint-11 → Sprint-13) ------------------------------
  // Sprint-13: switched to native GitHub `[!IMPORTANT]` alert (purple box,
  // colored side-bar, native icon) — much more visible than a plain
  // blockquote with emoji. Falls back to hypothesis if no v5 tldr.
  const tldrText = (i.diagnostic.tldr && i.diagnostic.tldr.trim()) || i.diagnostic.hypothesis;
  const tldrBlock = [
    `> [!IMPORTANT]`,
    `> ### 🎯 TL;DR`,
    `> ${tldrText.replace(/\n/g, '\n> ')}`,
    `> ${fmtSource('LLM').trim()}`,
  ].join('\n');

  // ---- Group banner (treatment vs control) --------------------------------
  // Sprint-13: native GitHub Alerts. `[!TIP]` = green for treatment,
  // `[!CAUTION]` = red for control (don't apply).
  const groupBanner =
    i.group_assignment === 'control'
      ? [
          `> [!CAUTION]`,
          `> **Groupe contrôle** — ne PAS appliquer ces fixes pendant 4 semaines (mesure d'impact via différence treatment vs contrôle).`,
        ].join('\n')
      : [
          `> [!TIP]`,
          `> **Groupe traitement** — à appliquer après revue.`,
        ].join('\n');

  // ---- Compact metrics box ------------------------------------------------
  // Sprint-12: 4 columns (GSC × Cooked behavior × CWV × Conversion).
  // CWV and Conversion columns degrade to "—" cells when Cooked extras
  // weren't passed (legacy findings or freshly-seeded Cooked DB).
  const ex = i.cooked_extras;
  const cwvCell = (ms: number | null | undefined, threshGood: number, threshNI: number, unit: 'ms' | ''): string => {
    if (ms == null) return '—';
    const verdict = ms <= threshGood ? '✅' : ms <= threshNI ? '⚠️' : '🚫';
    const display = unit === 'ms' ? `${Math.round(ms)}ms` : ms.toFixed(3);
    return `${display} ${verdict}`;
  };
  const lcpCell = cwvCell(ex?.lcp_p75_ms, 2500, 4000, 'ms');
  const inpCell = cwvCell(ex?.inp_p75_ms, 200, 500, 'ms');
  const clsCell = cwvCell(ex?.cls_p75, 0.1, 0.25, '');
  const ttfbCell = cwvCell(ex?.ttfb_p75_ms, 800, 1800, 'ms');

  const conv = (n: number | null | undefined): string => (n == null ? '—' : String(n));
  const phoneCell = conv(ex?.phone_clicks_28d);
  const emailCell = conv(ex?.email_clicks_28d);
  const bookingCell = conv(ex?.booking_cta_clicks_28d);
  const bodyPctCell =
    ex?.cta_body_pct != null
      ? `${ex.cta_body_pct.toFixed(0)}% body (intent qualifié)`
      : '—';
  // Sprint-12 hotfix: fallback chain GA4-style — utm_source > referrer_hostname > 'direct'.
  // Cooked agent confirmed: top_referrer is denser than top_source (every session has
  // a referrer header, only UTM-tagged sessions have utm_source). Box used to display
  // "—" while the LLM correctly synthesized "google.com/organic" from the prompt block
  // — fix the box to reflect the same fallback the LLM uses.
  const provCell = ex?.top_source
    ? `${ex.top_source}/${ex.top_medium ?? '?'}`
    : ex?.top_referrer
    ? `${ex.top_referrer}/referral`
    : ex
    ? 'direct/none'
    : '—';
  const deviceCell =
    ex?.device_split
      ? `mob ${ex.device_split.mobile.toFixed(0)} / desk ${ex.device_split.desktop.toFixed(0)}`
      : '—';
  const captureCell =
    ex?.capture_rate_pct != null
      ? `${ex.capture_rate_pct.toFixed(0)}% (${ex.cooked_sessions_28d ?? '?'}/${ex.gsc_clicks_28d ?? '?'})`
      : '—';

  // Sprint-12 hotfix: behavior cells fallback to cooked_extras (28d window)
  // when the audit_findings columns are null. Same root cause as the CWV
  // fallback: forged findings / stale behavior_page_snapshots leave the
  // canonical columns empty while Cooked has fresh data.
  const ppsValue = i.pages_per_session ?? ex?.pages_per_session_28d ?? null;
  const dwellValue = i.avg_session_duration_seconds ?? ex?.avg_session_duration_28d ?? null;
  const scrollValue = i.scroll_depth_avg ?? ex?.scroll_avg_28d ?? null;

  // Sprint-13 v2: 2-col × 20-row layout (Nicolas feedback — the previous
  // 4-col was too dense). One metric per row, ordered by topical grouping
  // (GSC → Cooked behavior → CWV → conversion → provenance/meta). The
  // source tag at the end of each value visually groups rows by source.
  const captureCellTagged = ex?.capture_rate_pct != null
    ? `${captureCell}${fmtSource('SEO calc · Cooked ÷ GSC')}`
    : captureCell;
  const bodyCellTagged = ex?.cta_body_pct != null
    ? `${bodyPctCell}${fmtSource('SEO calc · depuis Cooked cta_breakdown')}`
    : bodyPctCell;
  // Sprint-15 — Pogo cell. Format: "X% (sticks/google_sessions, hard Y)" with
  // a reliability suffix when n<30 (≈ wide CI). Empty dash when no Google
  // traffic was captured at all.
  let pogoCell = '—';
  if (ex?.pogo_rate_pct != null && ex.google_sessions_28d != null) {
    const reliability = ex.google_sessions_28d < 30 ? ' _échantillon faible_' : '';
    pogoCell = `**${ex.pogo_rate_pct.toFixed(1)}%** (${ex.pogo_sticks_28d ?? '?'}/${ex.google_sessions_28d}, hard ${ex.hard_pogo_28d ?? '?'})${reliability}${fmtSource('Cooked pogo_rate_28d')}`;
  } else if (ex?.google_sessions_28d === 0) {
    pogoCell = '_(0 session Google captée)_';
  }

  // Sprint-16 — Device CTA cell. Format: "mobile X% / desktop Y% (n_mob/n_desk)"
  // with reliability suffix when n_mobile<30. Dash when no data at all.
  let deviceCtaCell = '—';
  if (
    ex?.cta_rate_mobile_pct != null &&
    ex?.cta_rate_desktop_pct != null &&
    ex.mobile_sessions_28d != null &&
    ex.desktop_sessions_28d != null &&
    ex.mobile_sessions_28d + ex.desktop_sessions_28d > 0
  ) {
    const ratio =
      ex.cta_rate_desktop_pct > 0
        ? (ex.cta_rate_mobile_pct / ex.cta_rate_desktop_pct).toFixed(2)
        : null;
    const ratioPart = ratio ? ` · ratio ${ratio}` : '';
    const reliability = ex.mobile_sessions_28d < 30 ? ' _n mobile faible_' : '';
    deviceCtaCell = `mob **${ex.cta_rate_mobile_pct.toFixed(2)}%** / desk **${ex.cta_rate_desktop_pct.toFixed(2)}%** (${ex.mobile_sessions_28d}/${ex.desktop_sessions_28d}${ratioPart})${reliability}${fmtSource('Cooked cta_rate_*_28d')}`;
  }

  // Sprint-16 — Engagement density cell. Format: "evenness X (p25/median/p75)".
  let densityCell = '—';
  if (
    ex?.density_evenness_score != null &&
    ex.density_dwell_p25_seconds != null &&
    ex.density_dwell_p75_seconds != null
  ) {
    const evVerdict =
      ex.density_evenness_score < 0.15
        ? ' 🌗 bimodal'
        : ex.density_evenness_score > 0.6
        ? ' ✅ régulier'
        : '';
    densityCell = `evenness **${ex.density_evenness_score.toFixed(2)}**${evVerdict} (p25=${ex.density_dwell_p25_seconds}s · med=${ex.density_dwell_median_seconds ?? '?'}s · p75=${ex.density_dwell_p75_seconds}s, n=${ex.density_sessions_28d ?? '?'})${fmtSource('Cooked engagement_density_for_path')}`;
  }

  const metricsBox = [
    `| Métrique | Valeur |`,
    `|---|---|`,
    `| Position moyenne | ${i.avg_position.toFixed(1)} (drift ${fmtDriftCell(i.position_drift)})${fmtSource('GSC')} |`,
    `| Impressions/mois | ${monthlyImp.toLocaleString('fr-FR')}${fmtSource('GSC')} |`,
    `| **CTR actuel** | **${pct(i.ctr_actual)}%**${fmtSource('GSC')} |`,
    `| CTR benchmark (interpolé pos. ${i.avg_position.toFixed(1)}) | ${pct(i.ctr_expected)}%${fmtSource('SEO calc · interpolé')} |`,
    `| **Gap vs benchmark** | **${(i.ctr_gap * 100).toFixed(1)}% sous**${fmtSource('SEO calc')} |`,
    `| Pages/session | ${fmtNumOrNA(ppsValue)} — ${ppsInterpretation(ppsValue)}${fmtSource('Cooked')} |`,
    `| Durée active moyenne | ${fmtNumOrNA(dwellValue, 's', 0)} — ${durationInterpretation(dwellValue)}${fmtSource('Cooked')} |`,
    `| Scroll moyen | ${fmtNumOrNA(scrollValue, '%', 1)} — ${scrollInterpretation(scrollValue)}${fmtSource('Cooked')} |`,
    `| LCP (p75 28j) | ${lcpCell}${ex?.lcp_p75_ms != null ? fmtSource('Cooked') : ''} |`,
    `| INP (p75 28j) | ${inpCell}${ex?.inp_p75_ms != null ? fmtSource('Cooked') : ''} |`,
    `| CLS (p75 28j) | ${clsCell}${ex?.cls_p75 != null ? fmtSource('Cooked') : ''} |`,
    `| TTFB (p75 28j) | ${ttfbCell}${ex?.ttfb_p75_ms != null ? fmtSource('Cooked') : ''} |`,
    `| Phone clicks (28j) | ${phoneCell}${ex?.phone_clicks_28d != null ? fmtSource('Cooked') : ''} |`,
    `| Email clicks (28j) | ${emailCell}${ex?.email_clicks_28d != null ? fmtSource('Cooked') : ''} |`,
    `| Booking CTA clicks (28j) | ${bookingCell}${ex?.booking_cta_clicks_28d != null ? fmtSource('Cooked') : ''} |`,
    `| Body share (CTA in-body / total) | ${bodyCellTagged} |`,
    `| Provenance / Device | ${provCell} • ${deviceCell}${ex ? fmtSource('Cooked') : ''} |`,
    `| Capture rate (qualité Cooked) | ${captureCellTagged} |`,
    `| Pogo / NavBoost (28j Google) | ${pogoCell} |`,
    `| CTA rate par device (28j) | ${deviceCtaCell} |`,
    `| Engagement density (28j) | ${densityCell} |`,
    `| Priorité | tier ${i.priority_tier} (score ${i.priority_score.toFixed(2)})${fmtSource('SEO calc')} |`,
    `| Page | [${shortPath(i.page, 50)}](${i.page}) |`,
  ].join('\n');

  // ---- Diagnostic bullets (one per analytic field) ------------------------
  // Sprint-13: each bullet trailed with `<sub>(LLM · sources)</sub>` so the
  // reader sees which sources fed each piece of reasoning.
  const diagBullets = [
    fmtDiagBullet('Hypothèse', i.diagnostic.hypothesis),
    fmtDiagBullet('Intent mismatch', i.diagnostic.intent_mismatch, 'GSC top queries', 'DataForSEO volumes'),
    fmtDiagBullet('Snippet', i.diagnostic.snippet_weakness, 'DOM scrape', 'DataForSEO SOV'),
    fmtDiagBullet('Engagement', i.diagnostic.engagement_diagnosis, 'Cooked', 'SEO calc capture rate'),
    fmtDiagBullet('CWV / perf', i.diagnostic.performance_diagnosis, 'Cooked CWV 28d'),
    fmtDiagBullet('Structure', i.diagnostic.structural_gaps, 'DOM scrape', 'GSC top queries'),
    fmtDiagBullet('Funnel', i.diagnostic.funnel_assessment, 'DOM Sprint-9', 'Catalogue', 'Wix category'),
    fmtDiagBullet('Autorité interne', i.diagnostic.internal_authority_assessment, 'DOM Sprint-9 inbound graph'),
    fmtDiagBullet('Conversion', i.diagnostic.conversion_assessment, 'Cooked CTAs', 'DOM CTA placement'),
    fmtDiagBullet('Traffic strategy', i.diagnostic.traffic_strategy_note, 'Cooked top_referrer'),
    fmtDiagBullet('Device optimization', i.diagnostic.device_optimization_note, 'Cooked device_split'),
    fmtDiagBullet('Outbound leak', i.diagnostic.outbound_leak_note, 'Cooked outbound_destinations'),
    fmtDiagBullet('Pogo / NavBoost', i.diagnostic.pogo_navboost_assessment, 'Cooked google_sessions_28d', 'Cooked pogo_rate_28d'),
    fmtDiagBullet('Engagement pattern', i.diagnostic.engagement_pattern_assessment, 'Cooked engagement_density_for_path'),
  ]
    .filter((s) => s !== '')
    .join('\n');

  // ---- Data quality banner (Sprint-12 → Sprint-13) ------------------------
  // Sprint-13: native GitHub `[!WARNING]` alert (yellow side-bar + icon).
  let dataQualityBanner = '';
  if (i.cooked_extras?.capture_rate_pct != null && i.cooked_extras.capture_rate_pct < 50) {
    const rate = i.cooked_extras.capture_rate_pct.toFixed(0);
    dataQualityBanner = [
      `> [!WARNING]`,
      `> **Data quality** — Cooked capture rate **${rate}%** sur cette page (${i.cooked_extras.cooked_sessions_28d ?? '?'} sessions Cooked vs ${i.cooked_extras.gsc_clicks_28d ?? '?'} GSC clicks 28d). Lis les chiffres Cooked comme un **lower bound**, pas comme des absolus.`,
      `> ${fmtSource('SEO calc · Cooked sessions ÷ GSC clicks 28d').trim()}`,
    ].join('\n');
  }

  // ---- Sprint-15 — Pogo / NavBoost alert ---------------------------------
  // Triggers ONLY when n is statistically meaningful (≥30 google_sessions on
  // 28d) AND pogo_rate > 20%. Below either threshold the metrics box still
  // shows the value but no alert fires — avoids spamming on low-traffic pages.
  let pogoBanner = '';
  const pogoExtras = i.cooked_extras;
  if (
    pogoExtras?.pogo_rate_pct != null &&
    pogoExtras.google_sessions_28d != null &&
    pogoExtras.google_sessions_28d >= 30 &&
    pogoExtras.pogo_rate_pct > 20
  ) {
    pogoBanner = [
      `> [!CAUTION]`,
      `> **Signal NavBoost négatif fort** — pogo_rate **${pogoExtras.pogo_rate_pct.toFixed(1)}%** sur ${pogoExtras.google_sessions_28d} sessions Google 28j (${pogoExtras.pogo_sticks_28d ?? '?'} pogo, ${pogoExtras.hard_pogo_28d ?? '?'} hard). Google a probablement déjà commencé à dérouter cette page : intent ne match pas, soit le snippet ment, soit la page n'apporte pas la réponse dans les 10 premières secondes. À traiter en priorité — c'est l'explication la plus probable d'une éventuelle chute de position.`,
      `> ${fmtSource('Cooked pogo_rate_28d · seuil >20% sur n≥30').trim()}`,
    ].join('\n');
  }

  // ---- Sprint-16 — Mobile-first urgent alert -----------------------------
  // Triggers when mobile sessions are statistically meaningful (≥30) AND
  // mobile converts at <25% of desktop AND desktop has a non-zero rate
  // (otherwise the ratio is meaningless). Doesn't fire on pure-info pages
  // (0 CTA both devices) — those just don't have a CTA in body, no signal.
  let mobileFirstBanner = '';
  const dx = i.cooked_extras;
  if (
    dx?.cta_rate_mobile_pct != null &&
    dx.cta_rate_desktop_pct != null &&
    dx.mobile_sessions_28d != null &&
    dx.mobile_sessions_28d >= 30 &&
    dx.cta_rate_desktop_pct > 0 &&
    dx.cta_rate_mobile_pct / dx.cta_rate_desktop_pct < 0.25
  ) {
    const ratioPct = ((dx.cta_rate_mobile_pct / dx.cta_rate_desktop_pct) * 100).toFixed(0);
    mobileFirstBanner = [
      `> [!CAUTION]`,
      `> **Mobile-first urgent** — mobile convertit à **${ratioPct}%** du desktop (${dx.cta_rate_mobile_pct.toFixed(2)}% sur ${dx.mobile_sessions_28d} sessions vs ${dx.cta_rate_desktop_pct.toFixed(2)}% sur ${dx.desktop_sessions_28d ?? '?'} desktop). La page laisse le trafic mobile s'évaporer sans convertir. Causes probables : CTA in-body absente sur viewport mobile, formulaire trop long, bouton sous le fold, ou tap target trop petit. À traiter en priorité dans les fixes conversion.`,
      `> ${fmtSource('Cooked cta_rate_mobile_28d / cta_rate_desktop_28d · seuil <0.25 sur n_mobile≥30').trim()}`,
    ].join('\n');
  }

  // Sprint-11 layout: each top-level section is a self-contained string with
  // any internal newlines already in place. Sections are joined with BLANK
  // lines (\n\n) so GitHub's Markdown parser respects table boundaries,
  // blockquote breaks, and heading separation. Empty sections (e.g. linksFix
  // absent) are dropped without leaving stray blank lines.
  const refsLines: string[] = [
    `## 🔗 Refs`,
    ``,
    `- Audit run ID : \`${i.audit_run_id}\``,
    `- Finding ID : \`${i.finding_id}\``,
  ];
  if (i.supabase_finding_url) {
    refsLines.push(`- Supabase : [voir le finding](${i.supabase_finding_url})`);
  }
  const refsBlock = refsLines.join('\n');

  const fixSections = [
    fmtFixSection({ ordinal: 1, label: 'Title', fix: titleFix, fallbackCurrent: i.current_title }),
    fmtFixSection({ ordinal: 2, label: 'Meta description', fix: metaFix, fallbackCurrent: i.current_meta }),
    fmtFixSection({
      ordinal: 3,
      label: 'Intro (first screen, ≤100 mots)',
      fix: introFix,
      fallbackCurrent: i.current_intro,
      blockquoteCurrent: true,
    }),
    linksSection,
  ].filter((s) => s !== '');
  const fixesSection =
    fixSections.length > 0
      ? `## 🛠 Actions proposées\n\n${fixSections.join('\n')}`
      : `## 🛠 Actions proposées\n\n_(Pas encore de fixes proposés — sera complété par le pipeline propose-fixes.)_`;

  const cycleBlock = [
    `## 📅 Cycle de mesure`,
    ``,
    `- **T0 (baseline)** : ${baselineDate}`,
    `- **T+30 mesure 1** : prévue le ${t30}`,
    `- **T+60 mesure 2** : prévue le ${t60}`,
  ].join('\n');

  const workflowBlock = [
    `## ✅ Workflow`,
    ``,
    `- [ ] Reviewed (cocher pour valider les fixes proposés)`,
    `- [ ] Applied (cocher après push Wix)`,
    `- [ ] Measured T+30`,
    `- [ ] Measured T+60`,
  ].join('\n');

  const diagSection = [
    `## 🔎 Diagnostic`,
    ``,
    diagBullets,
    ``,
    `### Top 5 requêtes`,
    ``,
    fmtTopQueries(i.diagnostic.top_queries_analysis, 5),
  ].join('\n');

  // Sprint-14: measurement blocks. Empty strings when no measurements yet,
  // so pre-measurement findings render identically to Sprint-13.
  const measurementVerdict = fmtMeasurementVerdict(i.measurements);
  const measurementTable = fmtMeasurementTable(i.measurements);

  // Sprint-14bis: fact-check banner — empty when no fact-check on the
  // finding OR when 0 numeric claims; visible NOTE when all verified;
  // CAUTION listing unverified claims when the LLM still hallucinated
  // after retry.
  const factCheckBanner = fmtFactCheckBanner(i.fact_check);

  // Sections may be empty (e.g. dataQualityBanner when capture rate is OK,
  // measurement blocks when no measurement yet). Filter them out so the
  // join('\n\n') doesn't produce double-blank gaps.
  return [
    tldrBlock,
    measurementVerdict, // Sprint-14: verdict alert sits right after TLDR
    groupBanner,
    metricsBox,
    measurementTable, // Sprint-14: detail delta table sits right after the baseline metrics box
    pogoBanner, // Sprint-15: NavBoost negative alert (CAUTION) — read-first
    mobileFirstBanner, // Sprint-16: mobile CTA-rate alert (CAUTION) — read-first
    dataQualityBanner,
    `---`,
    diagSection,
    factCheckBanner, // Sprint-14bis: fact-check sits right under the diagnostic bullets
    `---`,
    fixesSection,
    cycleBlock,
    workflowBlock,
    refsBlock,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

export type RenderedIssue = { title: string; body: string; labels: string[] };

export function renderIssue(i: IssueInputs): RenderedIssue {
  return {
    title: renderIssueTitle(i),
    body: renderIssueBody(i),
    labels: renderIssueLabels(i),
  };
}
