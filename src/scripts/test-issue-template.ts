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
    intent_mismatch: 'mismatch text',
    snippet_weakness: 'weakness text',
    hypothesis: 'hypothesis text',
    engagement_diagnosis: 'engagement text',
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

test('engagement interpretations flag the warning thresholds', () => {
  const r = renderIssue(fixture);
  assert.match(r.body, /Pages\/session.*1\.02.*rebond rapide/);
  assert.match(r.body, /Scroll depth.*12\.4%.*scroll superficiel/);
});

test('drift cell falls back gracefully when null (first audit)', () => {
  const r = renderIssue({ ...fixture, position_drift: null });
  assert.match(r.body, /Drift.*premier audit/);
});

test('finding + audit_run IDs appear in Refs', () => {
  const r = renderIssue(fixture);
  assert.ok(r.body.includes(fixture.finding_id));
  assert.ok(r.body.includes(fixture.audit_run_id));
});
