/**
 * Smoke tests for the GitHub issue template renderer (ROADMAP §9).
 * Run with: npm run test:issue-template
 *
 * Pure-function tests — no DB, no GitHub. We just feed a fixture and
 * assert the rendered title / labels / body shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderIssue,
  renderIssueLabels,
  renderIssueTitle,
  type IssueInputs,
} from '../prompts/issue-template.js';

const fixture: IssueInputs = {
  finding_id: '00000000-0000-0000-0000-000000000001',
  audit_run_id: '00000000-0000-0000-0000-0000000000aa',
  page: 'https://www.jplouton-avocat.fr/post/durée-de-la-garde-à-vue',
  avg_position: 5.2,
  position_drift: 4.0,
  impressions: 35330,
  audit_period_months: 3,
  ctr_actual: 0.0142,
  ctr_expected: 0.0364,
  ctr_gap: 0.61,
  priority_score: 360.77,
  priority_tier: 1,
  group_assignment: 'treatment',
  pages_per_session: 1.02,
  avg_session_duration_seconds: 96,
  scroll_depth_avg: 12.4,
  current_title: 'old title',
  current_meta: 'old meta',
  current_intro: 'old intro paragraph',
  diagnostic: {
    tldr: 'TLDR sentence — synthesis upfront.',
    intent_mismatch: 'mismatch text',
    snippet_weakness: 'weakness text',
    hypothesis: 'hypothesis text',
    engagement_diagnosis: 'engagement text',
    performance_diagnosis: 'CWV satisfaisant.',
    structural_gaps: 'gaps text',
    funnel_assessment: 'funnel text',
    internal_authority_assessment: 'authority text',
    top_queries_analysis: [
      { query: 'q1', impressions: 1000, ctr: 0.02, position: 5.0, intent_match: 'yes' },
      { query: 'q2', impressions: 800, ctr: 0.01, position: 6.5, intent_match: 'partial' },
    ],
  },
  fixes: [
    { fix_type: 'title', current_value: 'old title', proposed_value: 'new title', rationale: 'r1' },
    {
      fix_type: 'meta_description',
      current_value: 'old meta',
      proposed_value: 'new meta',
      rationale: 'r2',
    },
    {
      fix_type: 'intro',
      current_value: 'old intro',
      proposed_value: 'new intro',
      rationale: 'r3',
    },
    {
      fix_type: 'internal_links',
      current_value: null,
      proposed_value: 'a → b | c → d',
      rationale: 'r4',
    },
  ],
  baseline_date: '2026-05-06',
};

test('title format matches ROADMAP §9', () => {
  const t = renderIssueTitle(fixture);
  assert.match(t, /^\[SEO-P1\] /);
  assert.match(t, /CTR 1\.42% vs 3\.64% en pos\. 5\.2/);
  // Path included
  assert.ok(t.includes('/post/durée-de-la-garde-à-vue'));
});

test('labels include audit + priority + group + status', () => {
  const labels = renderIssueLabels(fixture);
  assert.deepEqual(labels.sort(), ['priority-1', 'seo-audit', 'status:proposed', 'treatment'].sort());
});

test('control group gets the no-apply warning', () => {
  const r = renderIssue({ ...fixture, group_assignment: 'control' });
  assert.match(r.body, /Groupe contrôle.*ne pas appliquer/i);
});

test('treatment group gets the apply-after-review prompt', () => {
  const r = renderIssue(fixture);
  assert.match(r.body, /Groupe traitement.*à appliquer après revue/i);
});

test('body contains all 4 fix sections + 4 workflow checkboxes', () => {
  const r = renderIssue(fixture);
  assert.ok(r.body.includes('### 1. Title'));
  assert.ok(r.body.includes('### 2. Meta description'));
  assert.ok(r.body.includes('### 3. Intro'));
  assert.ok(r.body.includes('### 4. Maillage interne'));
  assert.equal((r.body.match(/^- \[ \] /gm) ?? []).length, 4);
});

test('cycle de mesure dates are baseline + 30 + 60', () => {
  const r = renderIssue(fixture);
  assert.ok(r.body.includes('**T0 (baseline)** : 2026-05-06'));
  assert.ok(r.body.includes('**T+30 mesure 1** : prévue le 2026-06-05'));
  assert.ok(r.body.includes('**T+60 mesure 2** : prévue le 2026-07-05'));
});

test('Cooked behavior interpretations flag the warning thresholds', () => {
  const r = renderIssue(fixture);
  // Sprint-13 v2: 2-col layout, labels are "Pages/session", "Scroll moyen".
  assert.match(r.body, /Pages\/session.*1\.02.*rebond rapide/);
  assert.match(r.body, /Scroll moyen.*12\.4%.*scroll superficiel/);
});

test('drift cell falls back gracefully when null (first audit)', () => {
  const r = renderIssue({ ...fixture, position_drift: null });
  // Sprint-13 v2: row label is "Position moyenne" in the 2-col table.
  assert.match(r.body, /Position moyenne.*premier audit/);
});

test('finding + audit_run IDs appear in Refs', () => {
  const r = renderIssue(fixture);
  assert.ok(r.body.includes(fixture.finding_id));
  assert.ok(r.body.includes(fixture.audit_run_id));
});

// ---------- Sprint-11 redesign-specific tests ------------------------------

test('TL;DR callout sits at the very top of the body (Sprint-13: GitHub IMPORTANT alert)', () => {
  const r = renderIssue(fixture);
  // Sprint-13: switched from emoji blockquote to native GitHub `[!IMPORTANT]`
  // alert (purple side-bar). Body now starts with the alert directive.
  assert.ok(
    r.body.startsWith('> [!IMPORTANT]\n> ### 🎯 TL;DR'),
    `body should start with [!IMPORTANT] TL;DR alert, got:\n${r.body.slice(0, 200)}`,
  );
  assert.ok(r.body.includes('TLDR sentence — synthesis upfront.'));
});

test('TL;DR falls back to hypothesis when v5 tldr field is missing (legacy)', () => {
  const legacyDiag = { ...fixture.diagnostic };
  delete legacyDiag.tldr;
  const r = renderIssue({ ...fixture, diagnostic: legacyDiag });
  // Should still render the TL;DR alert, populated with hypothesis text.
  assert.ok(r.body.startsWith('> [!IMPORTANT]\n> ### 🎯 TL;DR'));
  assert.ok(r.body.includes('hypothesis text'));
});

test('diagnostic bullets surface ALL v3-v5 analytic fields', () => {
  const r = renderIssue(fixture);
  for (const label of [
    'Hypothèse',
    'Intent mismatch',
    'Snippet',
    'Engagement',
    'CWV / perf',
    'Structure',
    'Funnel',
    'Autorité interne',
  ]) {
    assert.match(r.body, new RegExp(`- \\*\\*${label}\\*\\*`), `missing bullet: ${label}`);
  }
});

test('empty diagnostic fields are omitted (legacy v1 cleanly renders)', () => {
  const skinnyDiag = {
    ...fixture.diagnostic,
    performance_diagnosis: '',
    structural_gaps: '',
    funnel_assessment: '',
    internal_authority_assessment: '',
  };
  const r = renderIssue({ ...fixture, diagnostic: skinnyDiag });
  // Still has the v1 fields…
  assert.match(r.body, /- \*\*Hypothèse\*\*/);
  // …but skips the v3+ ones rather than printing empty bullets.
  assert.ok(!r.body.includes('- **CWV / perf** —'));
  assert.ok(!r.body.includes('- **Structure** —'));
});

test('metrics box uses the Sprint-13 v2 / Sprint-15 / Sprint-16 2-column × 23-row layout', () => {
  const r = renderIssue(fixture);
  // Header is "Métrique | Valeur" — single 2-col table.
  assert.match(r.body, /\| Métrique \| Valeur \|\n\|---\|---\|/);
  // Slice from the table header to the next blank line, then count rows.
  const headerIdx = r.body.indexOf('| Métrique | Valeur |');
  const afterHeader = r.body.slice(headerIdx);
  const blankLineIdx = afterHeader.indexOf('\n\n');
  const tableBody = afterHeader.slice(0, blankLineIdx);
  const allRows = tableBody.split('\n').filter((l) => l.startsWith('|'));
  // Sprint-15: 20 → 21 (Pogo / NavBoost). Sprint-16: 21 → 23 (CTA per device + Engagement density).
  const dataRows = allRows.filter((l) => !l.includes('---') && !l.includes('Métrique | Valeur'));
  assert.equal(dataRows.length, 23, `expected 23 data rows, got ${dataRows.length}: ${dataRows.map((r) => r.slice(0, 40)).join('\n')}`);
});

// ---------- Sprint-12 v6 + Cooked extras tests -----------------------------

test('diagnostic bullets surface ALL v6 fields (conversion / traffic / device / outbound leak)', () => {
  const fullV6Diag = {
    ...fixture.diagnostic,
    conversion_assessment: '5 phone clicks dont 60% body — intent qualifié fort.',
    traffic_strategy_note: 'top_source=google/organic 87% — priorité CTR snippet.',
    device_optimization_note: 'mobile 70% + scroll court — fix mobile-first impératif.',
    outbound_leak_note: 'top destination = legifrance.gouv.fr — ajouter citation in-page.',
  };
  const r = renderIssue({ ...fixture, diagnostic: fullV6Diag });
  for (const label of ['Conversion', 'Traffic strategy', 'Device optimization', 'Outbound leak']) {
    assert.match(r.body, new RegExp(`- \\*\\*${label}\\*\\*`), `missing v6 bullet: ${label}`);
  }
});

test('CWV cells classify against Google thresholds (Good / NI / Poor)', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      lcp_p75_ms: 2200,    // Good (≤ 2500)
      inp_p75_ms: 350,     // Needs Improvement (≤ 500)
      cls_p75: 0.32,       // Poor (> 0.25)
      ttfb_p75_ms: 600,    // Good (≤ 800)
    },
  });
  // Spot the 3 verdicts with the units in the same cell
  assert.match(r.body, /2200ms ✅/);
  assert.match(r.body, /350ms ⚠️/);
  assert.match(r.body, /0\.320 🚫/);
  assert.match(r.body, /600ms ✅/);
});

test('CWV cells degrade to "—" when Cooked extras are absent', () => {
  const r = renderIssue(fixture); // no cooked_extras passed
  // Sprint-13 v2: row labels are "LCP (p75 28j)" etc. in the 2-col table.
  assert.ok(r.body.includes('| LCP (p75 28j) | — |'));
  assert.ok(r.body.includes('| INP (p75 28j) | — |'));
  assert.ok(r.body.includes('| CLS (p75 28j) | — |'));
  assert.ok(r.body.includes('| TTFB (p75 28j) | — |'));
});

test('conversion rows show phone/email/booking + body share (Sprint-13 v2 layout)', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      phone_clicks_28d: 5,
      email_clicks_28d: 1,
      booking_cta_clicks_28d: 0,
      cta_body_pct: 60,
    },
  });
  // Sprint-13 v2: row labels use "(28j)" suffix in the 2-col table.
  assert.match(r.body, /\| Phone clicks \(28j\) \| 5/);
  assert.match(r.body, /\| Email clicks \(28j\) \| 1/);
  assert.match(r.body, /\| Booking CTA clicks \(28j\) \| 0/);
  assert.match(r.body, /60% body \(intent qualifié\)/);
});

test('low capture rate (<50%) surfaces a data quality warning banner (Sprint-13: GitHub WARNING alert)', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      cooked_sessions_28d: 14,
      gsc_clicks_28d: 142,
      capture_rate_pct: 9.86,
    },
  });
  // Sprint-13: switched to native GitHub `[!WARNING]` alert (yellow).
  assert.match(r.body, /> \[!WARNING\]\n> \*\*Data quality\*\* — Cooked capture rate \*\*10%\*\*/);
  assert.match(r.body, /lower bound/);
});

test('healthy capture rate (>=50%) does NOT surface the data quality banner', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      cooked_sessions_28d: 120,
      gsc_clicks_28d: 142,
      capture_rate_pct: 84.5,
    },
  });
  assert.ok(!r.body.includes('Data quality'));
});

test('absent cooked_extras renders cleanly (no banner, "—" cells in 2-col box)', () => {
  const r = renderIssue(fixture); // no cooked_extras
  assert.ok(!r.body.includes('Data quality'));
  assert.ok(r.body.includes('| Phone clicks (28j) | — |'));
});

test('provenance + device cell shows top_source/medium and mobile/desktop split', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      top_source: 'google',
      top_medium: 'organic',
      device_split: { desktop: 28, mobile: 70, tablet: 2 },
    },
  });
  assert.match(r.body, /google\/organic.*mob 70 \/ desk 28/);
});

// ---------- Sprint-12 hotfix tests -----------------------------------------

test('hotfix #1 — top-5 queries CTR rendered correctly when LLM outputs percent (1.65 not 0.0165)', () => {
  // Reproduce the bug from issue #30: LLM output ctr=1.65 (already percent),
  // we used to render 165.00% (× 100 again). Defensive detect: if ctr > 1 it's
  // already a percent and we don't multiply again.
  const r = renderIssue({
    ...fixture,
    diagnostic: {
      ...fixture.diagnostic,
      top_queries_analysis: [
        { query: 'q-percent', impressions: 100, ctr: 1.65, position: 5, intent_match: 'yes' },
        { query: 'q-fraction', impressions: 100, ctr: 0.0165, position: 5, intent_match: 'yes' },
      ],
    },
  });
  assert.match(r.body, /q-percent.*1\.65%/, 'LLM-percent CTR should render as 1.65%, not 165%');
  assert.match(r.body, /q-fraction.*1\.65%/, 'fraction CTR should also render as 1.65%');
  assert.ok(!r.body.includes('165.00%'), 'should never render impossible CTR > 100%');
});

test('hotfix #2 — provenance falls back from top_source → top_referrer → direct', () => {
  // Case 1: only top_referrer set (real-world: pages with no UTM tagging)
  const r1 = renderIssue({
    ...fixture,
    cooked_extras: { top_referrer: 'www.google.com' },
  });
  assert.match(r1.body, /www\.google\.com\/referral/);

  // Case 2: top_source set → preferred over top_referrer
  const r2 = renderIssue({
    ...fixture,
    cooked_extras: { top_source: 'newsletter', top_medium: 'email', top_referrer: 'gmail.com' },
  });
  assert.match(r2.body, /newsletter\/email/);
  assert.ok(!r2.body.includes('gmail.com'));

  // Case 3: cooked_extras present but both null → "direct/none" (GA4 convention)
  const r3 = renderIssue({
    ...fixture,
    cooked_extras: {},
  });
  assert.match(r3.body, /direct\/none/);
});

test('hotfix #4 — behavior cells fallback to cooked_extras 28d when audit_findings cols null', () => {
  // Forged finding: top-level pps/dwell/scroll are null, but Cooked has fresh
  // 28d data. Box should display the Cooked values instead of "n/a".
  const r = renderIssue({
    ...fixture,
    pages_per_session: null,
    avg_session_duration_seconds: null,
    scroll_depth_avg: null,
    cooked_extras: {
      pages_per_session_28d: 1.42,
      avg_session_duration_28d: 117,
      scroll_avg_28d: 28.5,
    },
  });
  // Sprint-13 v2: 2-col labels. "Durée active moyenne" + "Scroll moyen".
  assert.match(r.body, /Pages\/session.*1\.42.*standard/);
  assert.match(r.body, /Durée active moyenne.*117s.*session longue/);
  assert.match(r.body, /Scroll moyen.*28\.5%.*scroll superficiel/);
});

test('hotfix #4 — top-level values still preferred over cooked_extras when both present', () => {
  // Standard case: audit_findings has values, cooked_extras also has values
  // but with different numbers. The top-level (audit-period snapshot) wins
  // because it's the snapshot at audit time, semantically the right reference.
  const r = renderIssue({
    ...fixture,
    pages_per_session: 0.99,
    cooked_extras: { pages_per_session_28d: 2.5 },
  });
  assert.match(r.body, /Pages\/session.*0\.99/);
  assert.ok(!r.body.includes('2.50'));
});

// ---------- Sprint-13 UI tests --------------------------------------------

test('Sprint-13 — diagnostic bullets carry source attribution as <sub>', () => {
  const r = renderIssue(fixture);
  // Hypothèse only has LLM (no other sources passed)
  assert.match(r.body, /- \*\*Hypothèse\*\* — hypothesis text <sub>_\(LLM\)_<\/sub>/);
  // Intent mismatch carries LLM + GSC top queries + DataForSEO volumes
  assert.match(r.body, /- \*\*Intent mismatch\*\* — mismatch text <sub>_\(LLM · GSC top queries · DataForSEO volumes\)_<\/sub>/);
  // Funnel — LLM + DOM Sprint-9 + Catalogue + Wix category
  assert.match(r.body, /- \*\*Funnel\*\* — funnel text <sub>_\(LLM · DOM Sprint-9 · Catalogue · Wix category\)_<\/sub>/);
});

test('Sprint-13 — group banner uses GitHub TIP alert (treatment) and CAUTION (control)', () => {
  const rT = renderIssue(fixture);
  assert.match(rT.body, /> \[!TIP\]\n> \*\*Groupe traitement\*\*/);

  const rC = renderIssue({ ...fixture, group_assignment: 'control' });
  assert.match(rC.body, /> \[!CAUTION\]\n> \*\*Groupe contrôle\*\*/);
});

test('Sprint-13 — computed/interpolated rows carry SEO calc tag', () => {
  const r = renderIssue(fixture);
  // CTR benchmark is interpolated
  assert.match(r.body, /CTR benchmark.*3\.64%.*SEO calc · interpolé/);
  // Gap vs benchmark is computed
  assert.match(r.body, /Gap vs benchmark\*\*.*61\.0% sous.*SEO calc/);
  // Priority is computed
  assert.match(r.body, /tier 1 \(score 360\.77\).*SEO calc/);
});

test('Sprint-13 — top-5 queries header has per-column source tags', () => {
  const r = renderIssue(fixture);
  assert.match(r.body, /\| Requête <sub>\(GSC\)<\/sub> \| Imp <sub>\(GSC\)<\/sub> \| CTR <sub>\(GSC\)<\/sub> \| Pos <sub>\(GSC\)<\/sub> \| Intent match <sub>\(LLM\)<\/sub> \|/);
});

test('Sprint-13 — long current_value (>300 chars) wrapped in <details> collapsible', () => {
  const longCurrent = 'L'.repeat(400);
  const r = renderIssue({
    ...fixture,
    fixes: [
      { fix_type: 'title', current_value: longCurrent, proposed_value: 'short proposed', rationale: 'r' },
      { fix_type: 'meta_description', current_value: 'short', proposed_value: 'short', rationale: 'r' },
      { fix_type: 'intro', current_value: 'short', proposed_value: 'short', rationale: 'r' },
      { fix_type: 'internal_links', current_value: null, proposed_value: 'a → b', rationale: 'r' },
    ],
  });
  // Long current → wrapped in details
  assert.match(r.body, /<details>\n<summary><b>Actuel<\/b> <sub>_\(DOM scrape\)_<\/sub> — cliquer pour voir<\/summary>/);
  // Short current → not wrapped
  assert.match(r.body, /\*\*Actuel\*\* <sub>_\(DOM scrape\)_<\/sub> :\n```\nshort\n```/);
});

test('Sprint-13 — internal_links section has Catalogue source tag + collapsible proposed', () => {
  const r = renderIssue(fixture);
  assert.match(r.body, /### 4\. Maillage interne <sub>_\(LLM fix-gen · Catalogue\)_<\/sub>/);
  assert.match(r.body, /<details>\n<summary><b>Proposé<\/b> — cliquer pour voir le détail<\/summary>/);
});

// ---------- Sprint-14 measurement (T+30 / T+60) tests --------------------

const positiveT30 = {
  days_after_fix: 30,
  measured_at: '2026-06-08T00:00:00Z',
  applied_at: '2026-05-09T12:00:00Z',
  baseline_ctr: 0.0467,
  current_ctr: 0.0542,
  ctr_delta_pct: 16.1,
  baseline_position: 4.5,
  current_position: 4.1,
  position_delta: -0.4,
  baseline_impressions: 38478,
  current_impressions: 41200,
  significance_note: null,
};

const regressionT30 = {
  ...positiveT30,
  current_ctr: 0.0410,
  ctr_delta_pct: -12.2,
  current_position: 4.8,
  position_delta: 0.3,
  current_impressions: 36500,
};

test('Sprint-14 — pre-measurement render is unchanged (no measurements key)', () => {
  const r = renderIssue(fixture);
  // No verdict alert, no delta table
  assert.ok(!r.body.includes('📈 Mesure T+'));
  assert.ok(!r.body.includes('Détail mesure'));
  // Body still starts with TLDR (Sprint-13 layout)
  assert.ok(r.body.startsWith('> [!IMPORTANT]\n> ### 🎯 TL;DR'));
});

test('Sprint-14 — positive T+30 measurement → green TIP verdict + delta table', () => {
  const r = renderIssue({ ...fixture, measurements: [positiveT30] });
  // Verdict alert appears between TLDR and group banner
  assert.match(r.body, /> \[!TIP\]\n> ### 📈 Mesure T\+30 \(2026-06-08\)/);
  assert.match(r.body, /Fix qui marche/);
  assert.match(r.body, /Fix appliqué le 2026-05-09/);
  // Delta table appears after the metrics box
  assert.match(r.body, /### 📈 Détail mesure T\+30/);
  assert.match(r.body, /\| CTR \| 4\.67% \| 5\.42% \| \+16\.1%/);
  assert.match(r.body, /\| Position moyenne \| 4\.5 \| 4\.1 \| -0\.40 ✅/);
});

test('Sprint-14 — regression T+30 → red CAUTION verdict', () => {
  const r = renderIssue({ ...fixture, measurements: [regressionT30] });
  assert.match(r.body, /> \[!CAUTION\]\n> ### 📈 Mesure T\+30/);
  assert.match(r.body, /Régression/);
  assert.match(r.body, /envisager rollback/);
});

test('Sprint-14 — neutral T+30 (small CTR delta) → blue NOTE verdict', () => {
  const neutral = { ...positiveT30, ctr_delta_pct: 2.5, current_ctr: 0.0479 };
  const r = renderIssue({ ...fixture, measurements: [neutral] });
  assert.match(r.body, /> \[!NOTE\]\n> ### 📈 Mesure T\+30/);
  assert.match(r.body, /Mouvement neutre/);
  assert.match(r.body, /observer T\+60/);
});

test('Sprint-14 — both T+30 and T+60 → 5-col delta table side-by-side', () => {
  const t60 = { ...positiveT30, days_after_fix: 60, measured_at: '2026-07-08T00:00:00Z',
    current_ctr: 0.0581, ctr_delta_pct: 24.4, current_position: 4.0, position_delta: -0.5,
    current_impressions: 42800 };
  const r = renderIssue({ ...fixture, measurements: [positiveT30, t60] });
  // Verdict uses LATEST (T+60) measurement
  assert.match(r.body, /### 📈 Mesure T\+60/);
  // 5-col detail table
  assert.match(r.body, /\| Métrique \| T0 baseline \| T\+30 mesuré \| Δ T\+30 \| T\+60 mesuré \| Δ T\+60 \|/);
  assert.match(r.body, /\| CTR \| 4\.67% \| 5\.42% \| \+16\.1%.* \| 5\.81% \| \+24\.4%/);
});

test('Sprint-14 — measurement source attribution carries SEO calc tag', () => {
  const r = renderIssue({ ...fixture, measurements: [positiveT30] });
  // Verdict alert source
  assert.match(r.body, /SEO calc · GSC fix_outcomes vs baseline T0/);
  // Delta table source
  assert.match(r.body, /SEO calc · fix_outcomes/);
});

test('Sprint-14bis — fact-check passed renders quiet [!NOTE] banner', () => {
  const r = renderIssue({
    ...fixture,
    fact_check: {
      total_numeric_claims: 4,
      verified: 4,
      unverified: [],
      passed: true,
      retry_attempted: false,
    },
  });
  assert.match(r.body, /\[!NOTE\][\s\S]*Fact-check[\s\S]*4\/4 chiffres tracés/);
  assert.match(r.body, /0 halluciné/);
});

test('Sprint-14bis — fact-check failed renders [!CAUTION] with claim list', () => {
  const r = renderIssue({
    ...fixture,
    fact_check: {
      total_numeric_claims: 3,
      verified: 1,
      unverified: [
        { field: 'structural_gaps', claim: '1500 mots', note: 'claimed 1500, actual 720' },
        { field: 'funnel_assessment', claim: 'H2 #5', note: 'only 3 H2' },
      ],
      passed: false,
      retry_attempted: true,
    },
  });
  assert.match(r.body, /\[!CAUTION\][\s\S]*Fact-check/);
  assert.match(r.body, /2\/3 chiffres non vérifiés/);
  assert.match(r.body, /1 retry tenté/);
  assert.match(r.body, /structural_gaps[\s\S]*1500 mots/);
  assert.match(r.body, /funnel_assessment[\s\S]*H2 #5/);
});

test('Sprint-14bis — fact-check absent renders no banner (pre-Sprint-14bis findings)', () => {
  const r = renderIssue(fixture);
  assert.doesNotMatch(r.body, /Fact-check/);
});

test('Sprint-14bis — fact-check with 0 claims renders no banner', () => {
  const r = renderIssue({
    ...fixture,
    fact_check: {
      total_numeric_claims: 0,
      verified: 0,
      unverified: [],
      passed: true,
      retry_attempted: false,
    },
  });
  assert.doesNotMatch(r.body, /Fact-check/);
});

// ---------- Sprint-15 — Pogo / NavBoost tests ----------------------------

test('Sprint-15 — pogo row appears in metrics box with rate + n', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      google_sessions_28d: 50,
      pogo_sticks_28d: 8,
      hard_pogo_28d: 4,
      pogo_rate_pct: 16.0,
    },
  });
  assert.match(r.body, /Pogo \/ NavBoost \(28j Google\)/);
  assert.match(r.body, /\*\*16\.0%\*\* \(8\/50, hard 4\)/);
  assert.match(r.body, /Cooked pogo_rate_28d/);
  // n=50 ≥ 30, so no "échantillon faible" caveat
  assert.doesNotMatch(r.body, /échantillon faible/);
});

test('Sprint-15 — pogo row carries reliability caveat when n<30', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      google_sessions_28d: 22,
      pogo_sticks_28d: 3,
      hard_pogo_28d: 2,
      pogo_rate_pct: 13.6,
    },
  });
  assert.match(r.body, /\*\*13\.6%\*\* \(3\/22, hard 2\) _échantillon faible_/);
});

test('Sprint-15 — pogo row shows "0 session Google captée" when google_sessions_28d=0', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      google_sessions_28d: 0,
      pogo_sticks_28d: 0,
      hard_pogo_28d: 0,
      pogo_rate_pct: null,
    },
  });
  assert.match(r.body, /Pogo \/ NavBoost \(28j Google\) \| _\(0 session Google captée\)_/);
});

test('Sprint-15 — pogo banner [!CAUTION] fires when rate>20% AND n>=30', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      google_sessions_28d: 80,
      pogo_sticks_28d: 24,
      hard_pogo_28d: 18,
      pogo_rate_pct: 30.0,
    },
  });
  assert.match(r.body, /\[!CAUTION\][\s\S]*Signal NavBoost négatif fort/);
  assert.match(r.body, /pogo_rate \*\*30\.0%\*\* sur 80 sessions Google 28j/);
  assert.match(r.body, /\(24 pogo, 18 hard\)/);
});

test('Sprint-15 — pogo banner does NOT fire on low n even if rate>20%', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      google_sessions_28d: 12,
      pogo_sticks_28d: 5,
      hard_pogo_28d: 4,
      pogo_rate_pct: 41.7,
    },
  });
  // No CAUTION banner (n<30), but the row still shows the value with caveat
  assert.doesNotMatch(r.body, /Signal NavBoost négatif fort/);
  assert.match(r.body, /\*\*41\.7%\*\* \(5\/12, hard 4\) _échantillon faible_/);
});

test('Sprint-15 — pogo banner does NOT fire when n>=30 but rate<=20%', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      google_sessions_28d: 100,
      pogo_sticks_28d: 15,
      hard_pogo_28d: 8,
      pogo_rate_pct: 15.0,
    },
  });
  assert.doesNotMatch(r.body, /Signal NavBoost négatif fort/);
});

test('Sprint-15 — pogo bullet appears in diagnostic when assessment present', () => {
  const r = renderIssue({
    ...fixture,
    diagnostic: {
      ...fixture.diagnostic,
      pogo_navboost_assessment: 'NavBoost dérouté la page (pogo 25% sur n=80) — l\'intent ne match pas.',
    },
  });
  assert.match(r.body, /- \*\*Pogo \/ NavBoost\*\*[^\n]*NavBoost dérouté/);
  assert.match(r.body, /Cooked google_sessions_28d/);
});

test('Sprint-15 — pre-Sprint-15 findings render cleanly without pogo fields', () => {
  // No google_sessions_28d / pogo_rate_pct in cooked_extras → row shows "—",
  // no banner, no diag bullet (pogo_navboost_assessment also absent).
  const r = renderIssue(fixture);
  assert.match(r.body, /Pogo \/ NavBoost \(28j Google\) \| —/);
  assert.doesNotMatch(r.body, /Signal NavBoost négatif fort/);
  assert.doesNotMatch(r.body, /- \*\*Pogo \/ NavBoost\*\*/);
});

// ---------- Sprint-16 — CTA per device + Engagement density tests --------

test('Sprint-16 — CTA per device row appears with mobile/desktop split + ratio', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      mobile_sessions_28d: 70,
      desktop_sessions_28d: 72,
      cta_rate_mobile_pct: 1.43,
      cta_rate_desktop_pct: 6.94,
    },
  });
  assert.match(r.body, /CTA rate par device \(28j\)/);
  assert.match(r.body, /mob \*\*1\.43%\*\* \/ desk \*\*6\.94%\*\*/);
  assert.match(r.body, /\(70\/72 · ratio 0\.21\)/);
});

test('Sprint-16 — mobile-first CAUTION fires when ratio<0.25 AND n_mobile>=30', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      mobile_sessions_28d: 70,
      desktop_sessions_28d: 72,
      cta_rate_mobile_pct: 1.43,
      cta_rate_desktop_pct: 6.94,
    },
  });
  assert.match(r.body, /\[!CAUTION\][\s\S]*Mobile-first urgent/);
  assert.match(r.body, /mobile convertit à \*\*21%\*\* du desktop/);
  assert.match(r.body, /1\.43% sur 70 sessions vs 6\.94% sur 72 desktop/);
});

test('Sprint-16 — mobile-first does NOT fire when n_mobile<30 even if ratio<0.25', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      mobile_sessions_28d: 11,
      desktop_sessions_28d: 31,
      cta_rate_mobile_pct: 0.0,
      cta_rate_desktop_pct: 9.68,
    },
  });
  // Banner doesn't fire (n<30) but the row still shows the value with caveat
  assert.doesNotMatch(r.body, /Mobile-first urgent/);
  assert.match(r.body, /mob \*\*0\.00%\*\* \/ desk \*\*9\.68%\*\*/);
  assert.match(r.body, /n mobile faible/);
});

test('Sprint-16 — mobile-first does NOT fire when desktop_rate is 0 (pure-info page)', () => {
  // Article without CTAs in body: 0% both devices — no banner because there's
  // nothing to compare to (a 0/0 ratio would be undefined anyway).
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      mobile_sessions_28d: 141,
      desktop_sessions_28d: 34,
      cta_rate_mobile_pct: 0.0,
      cta_rate_desktop_pct: 0.0,
    },
  });
  assert.doesNotMatch(r.body, /Mobile-first urgent/);
});

test('Sprint-16 — engagement density row shows evenness + percentiles', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      density_sessions_28d: 143,
      density_dwell_p25_seconds: 7,
      density_dwell_median_seconds: 41,
      density_dwell_p75_seconds: 103,
      density_evenness_score: 0.07,
    },
  });
  assert.match(r.body, /Engagement density \(28j\)/);
  assert.match(r.body, /evenness \*\*0\.07\*\* 🌗 bimodal/);
  assert.match(r.body, /p25=7s · med=41s · p75=103s, n=143/);
});

test('Sprint-16 — engagement density "régulier" verdict when evenness > 0.6', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      ...fixture.cooked_extras,
      density_sessions_28d: 80,
      density_dwell_p25_seconds: 30,
      density_dwell_median_seconds: 45,
      density_dwell_p75_seconds: 50,
      density_evenness_score: 0.65,
    },
  });
  assert.match(r.body, /evenness \*\*0\.65\*\* ✅ régulier/);
});

test('Sprint-16 — engagement_pattern_assessment bullet appears when present', () => {
  const r = renderIssue({
    ...fixture,
    diagnostic: {
      ...fixture.diagnostic,
      engagement_pattern_assessment: 'Distribution bimodale (evenness 0.07) — la page travaille pour certains visiteurs.',
    },
  });
  assert.match(r.body, /- \*\*Engagement pattern\*\*[^\n]*Distribution bimodale/);
  assert.match(r.body, /Cooked engagement_density_for_path/);
});

test('Sprint-16 — pre-Sprint-16 findings render cleanly without the new fields', () => {
  // No mobile/desktop or density fields → both rows show "—", no banner
  const r = renderIssue(fixture);
  assert.match(r.body, /CTA rate par device \(28j\) \| —/);
  assert.match(r.body, /Engagement density \(28j\) \| —/);
  assert.doesNotMatch(r.body, /Mobile-first urgent/);
  assert.doesNotMatch(r.body, /- \*\*Engagement pattern\*\*/);
});
