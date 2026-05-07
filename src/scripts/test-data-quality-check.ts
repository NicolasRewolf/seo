/**
 * Sprint-12 unit tests for fmtDataQualityCheck — the helper that renders
 * the <data_quality_check> block of the diagnostic prompt v6.
 *
 * Cooked agent reviewed the formula + the 4-tier thresholds and added 2
 * caveats for the > 100% / > 150% cases (page has non-Google traffic).
 * These tests pin the verdict strings so a future refactor can't silently
 * regress the LLM-facing wording.
 *
 * Run with: tsx --test src/scripts/test-data-quality-check.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDataQualityCheck } from '../prompts/diagnostic.v1.js';

test('returns the "données insuffisantes" fallback when either input is null', () => {
  assert.match(fmtDataQualityCheck(null, 100), /données insuffisantes/);
  assert.match(fmtDataQualityCheck(100, null), /données insuffisantes/);
  assert.match(fmtDataQualityCheck(undefined, undefined), /données insuffisantes/);
});

test('returns "GSC clicks 28d: 0" when GSC has no clicks (no organic audience)', () => {
  const out = fmtDataQualityCheck(0, 5);
  assert.match(out, /GSC clicks 28d: 0/);
  assert.match(out, /capture rate non significatif/);
});

test('verdict at rate ≥ 80% — ground truth (Cooked = absolute)', () => {
  const out = fmtDataQualityCheck(100, 90); // 90%
  assert.match(out, /Capture rate: 90\/100 = 90%/);
  assert.match(out, /✅ ground truth/);
  assert.match(out, /SSR-bien/);
  assert.ok(!out.includes('FULL VOLUME'));
});

test('verdict at 50% ≤ rate < 80% — lower bound acceptable', () => {
  const out = fmtDataQualityCheck(100, 65); // 65%
  assert.match(out, /Capture rate: 65\/100 = 65%/);
  assert.match(out, /⚠️ lower bound acceptable/);
  assert.match(out, /ad-blockers/);
  assert.match(out, /actionable/);
});

test('verdict at 20% ≤ rate < 50% — sous-capture forte', () => {
  const out = fmtDataQualityCheck(100, 35); // 35%
  assert.match(out, /Capture rate: 35\/100 = 35%/);
  assert.match(out, /⚠️⚠️ sous-capture forte/);
  assert.match(out, /JS-rendered/);
  assert.match(out, /Lecture RELATIVE seulement/);
});

test('verdict at rate < 20% — tracker quasi-cassé', () => {
  const out = fmtDataQualityCheck(100, 10); // 10%
  assert.match(out, /Capture rate: 10\/100 = 10%/);
  assert.match(out, /🚫 tracker quasi-cassé/);
  assert.match(out, /retry sur load/);
  assert.match(out, /NE PAS conclure à l'absence de conversion/);
});

// ---------- Sprint-12 Cooked-agent feedback caveats ------------------------

test('verdict at 100% < rate ≤ 150% — still ground truth (slight non-Google bleed)', () => {
  // 120% — page has some non-Google traffic but not "significant"
  const out = fmtDataQualityCheck(100, 120);
  assert.match(out, /Capture rate: 120\/100 = 120%/);
  assert.match(out, /✅ ground truth/);
  // Should NOT trigger the FULL VOLUME special case yet
  assert.ok(!out.includes('FULL VOLUME'));
});

test('verdict at rate > 150% — ground truth FULL VOLUME (significant non-Google traffic)', () => {
  // 200% — Cooked sees 2× as many sessions as Google clicks → page has
  // significant direct/social/referrer traffic. Cooked is ground truth on
  // the FULL volume; GSC is only the "Google search" slice.
  const out = fmtDataQualityCheck(100, 200);
  assert.match(out, /Capture rate: 200\/100 = 200%/);
  assert.match(out, /✅✅ ground truth FULL VOLUME/);
  assert.match(out, /trafic significatif HORS Google/);
  // Critical instruction: don't use GSC impressions as the conversion denominator
  assert.match(out, /n'utilise PAS les GSC impressions comme dénominateur/);
});

test('output format is consistent — 4 lines, each starting with "- "', () => {
  const out = fmtDataQualityCheck(142, 89); // ~63%
  const lines = out.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.ok(line.startsWith('- '), `line should start with "- ", got: ${line}`);
  }
});
