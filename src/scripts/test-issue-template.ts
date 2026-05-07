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
  // Sprint-11: behavior signals now live in the metrics box right column
  // (Pages/session, Durée, Scroll moy.), one row per signal.
  assert.match(r.body, /Pages\/session.*1\.02.*rebond rapide/);
  assert.match(r.body, /Scroll moy\..*12\.4%.*scroll superficiel/);
});

test('drift cell falls back gracefully when null (first audit)', () => {
  const r = renderIssue({ ...fixture, position_drift: null });
  // Sprint-11: drift moved inline into the Position cell of the metrics box.
  assert.match(r.body, /Position moy\..*premier audit/);
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

test('metrics box has the Sprint-12 4-column layout (GSC × Cooked × CWV × Conversion)', () => {
  const r = renderIssue(fixture);
  assert.match(
    r.body,
    /\| 📊 GSC \(3 mois\) \| Valeur \| 🧭 Cooked behavior \| Valeur \| ⚡ CWV \(28d p75\) \| Valeur \| 📞 Conversion \(28d\) \| Valeur \|/,
  );
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
  // The 4 CWV labels still appear, but cells are em-dashes
  assert.ok(r.body.includes('| LCP | — '));
  assert.ok(r.body.includes('| INP | — '));
  assert.ok(r.body.includes('| CLS | — '));
  assert.ok(r.body.includes('| TTFB | — '));
});

test('conversion column shows phone/email/booking + body share', () => {
  const r = renderIssue({
    ...fixture,
    cooked_extras: {
      phone_clicks_28d: 5,
      email_clicks_28d: 1,
      booking_cta_clicks_28d: 0,
      cta_body_pct: 60,
    },
  });
  assert.ok(r.body.includes('| Phone clicks | 5 |'));
  assert.ok(r.body.includes('| Email clicks | 1 |'));
  assert.ok(r.body.includes('| Booking CTA | 0 |'));
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

test('absent cooked_extras renders cleanly (no banner, "—" cells in box)', () => {
  const r = renderIssue(fixture); // no cooked_extras
  assert.ok(!r.body.includes('Data quality'));
  assert.ok(r.body.includes('| Phone clicks | — |'));
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
  assert.match(r.body, /Pages\/session.*1\.42.*standard/);
  assert.match(r.body, /Durée active.*117s.*session longue/);
  assert.match(r.body, /Scroll moy\..*28\.5%.*scroll superficiel/);
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

test('Sprint-13 — box cells differing from column header carry SEO calc tag', () => {
  const r = renderIssue(fixture);
  // CTR benchmark is interpolated → tag visible
  assert.match(r.body, /CTR benchmark \| 3\.64% <sub>_\(SEO calc · interpolé\)_<\/sub>/);
  // Gap vs benchmark is computed
  assert.match(r.body, /Gap vs benchmark\*\* \| \*\*61\.0% sous\*\* <sub>_\(SEO calc\)_<\/sub>/);
  // Priority cell is computed
  assert.match(r.body, /tier 1 \(score 360\.77\) <sub>_\(SEO calc\)_<\/sub>/);
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
