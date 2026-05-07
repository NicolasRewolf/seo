/**
 * Sprint-12 unit tests for fmtDataQualityCheck — the helper that renders
 * the <data_quality_check> block of the diagnostic prompt v6.
 *
 * Cooked agent reviewed the formula + the 4-tier thresholds and added 2
 * caveats for the > 100% / > 150% cases (page has non-Google traffic).
 * These tests pin the verdict strings so a future refactor can't silently
 * regress the LLM-facing wording.
 *
 * Sprint-12 hotfix: the helper now pro-rates by `daysCookedHasCollected()`
 * to kill the bootstrap artefact. Tests pass `now` explicitly so they're
 * deterministic. Two anchors:
 *   - POST_BOOTSTRAP_NOW = 2026-06-15 (40 days after Cooked deploy →
 *     daysCooked clamped to 28 → pro-rating is a no-op, same math as before)
 *   - MID_BOOTSTRAP_NOW  = 2026-05-08 (~36h after deploy → pro-rating
 *     kicks in and changes the rate)
 *
 * Run with: npm run test:data-quality
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDataQualityCheck } from '../prompts/diagnostic.v1.js';

const POST_BOOTSTRAP_NOW = new Date('2026-06-15T00:00:00Z');
const MID_BOOTSTRAP_NOW = new Date('2026-05-08T05:00:00Z'); // ~36h post-deploy
const PRE_BOOTSTRAP_NOW = new Date('2026-05-06T20:00:00Z'); // ~3h post-deploy

test('returns the "données insuffisantes" fallback when either input is null', () => {
  assert.match(fmtDataQualityCheck(null, 100, POST_BOOTSTRAP_NOW), /données insuffisantes/);
  assert.match(fmtDataQualityCheck(100, null, POST_BOOTSTRAP_NOW), /données insuffisantes/);
  assert.match(fmtDataQualityCheck(undefined, undefined, POST_BOOTSTRAP_NOW), /données insuffisantes/);
});

test('returns "GSC clicks 28d: 0" when GSC has no clicks (no organic audience)', () => {
  const out = fmtDataQualityCheck(0, 5, POST_BOOTSTRAP_NOW);
  assert.match(out, /GSC clicks 28d: 0/);
  assert.match(out, /capture rate non significatif/);
});

test('verdict at rate ≥ 80% — ground truth (Cooked = absolute)', () => {
  const out = fmtDataQualityCheck(100, 90, POST_BOOTSTRAP_NOW); // post-bootstrap → 90%
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 90%/);
  assert.match(out, /✅ ground truth/);
  assert.match(out, /SSR-bien/);
  assert.ok(!out.includes('FULL VOLUME'));
});

test('verdict at 50% ≤ rate < 80% — lower bound acceptable', () => {
  const out = fmtDataQualityCheck(100, 65, POST_BOOTSTRAP_NOW);
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 65%/);
  assert.match(out, /⚠️ lower bound acceptable/);
  assert.match(out, /ad-blockers/);
  assert.match(out, /actionable/);
});

test('verdict at 20% ≤ rate < 50% — sous-capture forte', () => {
  const out = fmtDataQualityCheck(100, 35, POST_BOOTSTRAP_NOW);
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 35%/);
  assert.match(out, /⚠️⚠️ sous-capture forte/);
  assert.match(out, /JS-rendered/);
  assert.match(out, /Lecture RELATIVE seulement/);
});

test('verdict at rate < 20% — tracker quasi-cassé', () => {
  const out = fmtDataQualityCheck(100, 10, POST_BOOTSTRAP_NOW);
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 10%/);
  assert.match(out, /🚫 tracker quasi-cassé/);
  assert.match(out, /retry sur load/);
  assert.match(out, /NE PAS conclure à l'absence de conversion/);
});

// ---------- Sprint-12 Cooked-agent feedback caveats ------------------------

test('verdict at 100% < rate ≤ 150% — still ground truth (slight non-Google bleed)', () => {
  const out = fmtDataQualityCheck(100, 120, POST_BOOTSTRAP_NOW);
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 120%/);
  assert.match(out, /✅ ground truth/);
  assert.ok(!out.includes('FULL VOLUME'));
});

test('verdict at rate > 150% — ground truth FULL VOLUME (significant non-Google traffic)', () => {
  const out = fmtDataQualityCheck(100, 200, POST_BOOTSTRAP_NOW);
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 200%/);
  assert.match(out, /✅✅ ground truth FULL VOLUME/);
  assert.match(out, /trafic significatif HORS Google/);
  assert.match(out, /n'utilise PAS les GSC impressions comme dénominateur/);
});

// ---------- Sprint-12 hotfix #3 — bootstrap pro-rating tests ---------------

test('bootstrap: < 1 day collected → "amorçage" message, no verdict', () => {
  // 3 hours after deploy
  const out = fmtDataQualityCheck(218, 11, PRE_BOOTSTRAP_NOW);
  assert.match(out, /Cooked en phase d'amorçage/);
  assert.match(out, /Réévaluer après J\+7/);
  // No verdict line at this stage
  assert.ok(!out.includes('Verdict:'));
});

test('bootstrap: ~36h collected → pro-rating kicks in, qspa case', () => {
  // The qspa scenario at issue creation : 218 GSC clicks 28d, 11 Cooked
  // sessions in ~36h. Without pro-rating: 11/218 = 5% → "🚫 tracker cassé".
  // With pro-rating: cookedPerDay = 11/1.5 ≈ 7.33, gscPerDay = 218/28 ≈ 7.79,
  // rate ≈ 94% → "✅ ground truth".
  const out = fmtDataQualityCheck(218, 11, MID_BOOTSTRAP_NOW);
  // Surface the math so the LLM and human see the pro-rating
  assert.match(out, /jours de collection/);
  assert.match(out, /pro-rated pour comparer apples-to-apples/);
  // Must flip to ground truth (was "tracker cassé" pre-fix)
  assert.match(out, /✅ ground truth/);
  assert.ok(!out.includes('🚫 tracker quasi-cassé'));
});

test('post-bootstrap: ≥ 28 days → pro-rating is a no-op (same as pre-fix math)', () => {
  // After 28+ days, daysCooked clamps to 28. cookedPerDay = sessions/28,
  // gscPerDay = clicks/28, ratio = sessions/clicks → identical to old math.
  const out = fmtDataQualityCheck(100, 90, POST_BOOTSTRAP_NOW);
  assert.match(out, /Capture rate \(rate\/jour normalisé\): 90%/);
  // No bootstrap info line once we're past 28 days
  assert.ok(!out.includes('phase d\'amorçage'));
  assert.ok(!out.includes('pro-rated'));
});

test('bootstrap output surfaces the days_collected count for debuggability', () => {
  const out = fmtDataQualityCheck(218, 11, MID_BOOTSTRAP_NOW);
  // The "X.Y jours de collection" should appear so a human reading the
  // prompt can verify the math themselves.
  assert.match(out, /sur \d+\.\d jours de collection/);
});
