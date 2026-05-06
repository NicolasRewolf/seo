/**
 * Smoke tests for the scoring formulas (ROADMAP §7).
 * Run with: npx tsx src/scripts/test-scoring.ts
 *
 * Uses node:test instead of pulling in jest/vitest — cheap and dependency-free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCtrExpected,
  computeCtrGap,
  computeEngagementPenalty,
  computePriorityScore,
  computePriorityTier,
  assignGroup,
  type Benchmarks,
} from '../pipeline/compute-findings.js';

const BENCH: Benchmarks = {
  '1': 0.30,
  '2': 0.16,
  '3': 0.11,
  '4': 0.08,
  '5': 0.065,
  '10': 0.025,
  '15': 0.012,
};

test('getCtrExpected: integer position returns exact bench value', () => {
  assert.equal(getCtrExpected(1, BENCH), 0.30);
  assert.equal(getCtrExpected(5, BENCH), 0.065);
  assert.equal(getCtrExpected(15, BENCH), 0.012);
});

test('getCtrExpected: clamps below min and above max position', () => {
  assert.equal(getCtrExpected(0.5, BENCH), 0.30);
  assert.equal(getCtrExpected(20, BENCH), 0.012);
});

test('getCtrExpected: linear interpolation between buckets', () => {
  // Halfway between pos 1 (0.30) and pos 2 (0.16) → 0.23
  assert.equal(Number(getCtrExpected(1.5, BENCH).toFixed(4)), 0.23);
  // 30% from 4 (0.08) to 5 (0.065) → 0.08 + 0.3*(0.065-0.08) = 0.0755
  assert.equal(Number(getCtrExpected(4.3, BENCH).toFixed(4)), 0.0755);
});

test('computeCtrGap: positive when actual under expected', () => {
  assert.equal(computeCtrGap(0.02, 0.05), 0.6); // 60% gap
  assert.equal(computeCtrGap(0.05, 0.05), 0);
  assert.equal(computeCtrGap(0.10, 0.05), 0); // clamped at 0 when over
  assert.equal(computeCtrGap(0.01, 0), 0); // expected = 0 → no signal
});

test('computeEngagementPenalty: stacks behavior signals (3× = 0.5)', () => {
  assert.equal(
    computeEngagementPenalty({
      pagesPerSession: 1.0,
      avgSessionDurationSeconds: 20,
      scrollDepthAvg: 30,
    }),
    0.5,
  );
  assert.equal(
    computeEngagementPenalty({
      pagesPerSession: 2.0,
      avgSessionDurationSeconds: 60,
      scrollDepthAvg: 70,
    }),
    0,
  );
});

test('computeEngagementPenalty: missing signals are not penalized', () => {
  assert.equal(
    computeEngagementPenalty({
      pagesPerSession: null,
      avgSessionDurationSeconds: null,
      scrollDepthAvg: null,
    }),
    0,
  );
});

test('computeEngagementPenalty: each CWV signal added independently', () => {
  // LCP just over Google's "Good" threshold (2500ms)
  assert.equal(
    computeEngagementPenalty({ lcpP75Ms: 2501 }),
    0.15,
  );
  // INP just over 200ms
  assert.equal(
    computeEngagementPenalty({ inpP75Ms: 201 }),
    0.15,
  );
  // CLS just over 0.1
  assert.equal(
    computeEngagementPenalty({ clsP75: 0.11 }),
    0.10,
  );
});

test('computeEngagementPenalty: CWV at "Good" thresholds → 0', () => {
  assert.equal(
    computeEngagementPenalty({
      lcpP75Ms: 2500,
      inpP75Ms: 200,
      clsP75: 0.1,
    }),
    0,
  );
});

test('computeEngagementPenalty: behavior + CWV stack and cap at 0.7', () => {
  // 3 behavior signals (0.50) + 3 CWV signals (0.40) → would be 0.90, capped at 0.7
  assert.equal(
    computeEngagementPenalty({
      pagesPerSession: 1.0,
      avgSessionDurationSeconds: 20,
      scrollDepthAvg: 30,
      lcpP75Ms: 5000,
      inpP75Ms: 600,
      clsP75: 0.3,
    }),
    0.7,
  );
});

test('computeEngagementPenalty: only CWV → max 0.4 before cap', () => {
  assert.equal(
    computeEngagementPenalty({
      lcpP75Ms: 5000,
      inpP75Ms: 600,
      clsP75: 0.3,
    }),
    0.4,
  );
});

test('computePriorityScore: in-position-range ranks higher than out-of-range', () => {
  const inRange = computePriorityScore({
    impressions: 10000,
    ctrGap: 0.5,
    position: 7,
    positionDrift: null,
    engagementPenalty: 0,
    positionRangeMin: 5,
    positionRangeMax: 15,
  });
  const outOfRange = computePriorityScore({
    impressions: 10000,
    ctrGap: 0.5,
    position: 20,
    positionDrift: null,
    engagementPenalty: 0,
    positionRangeMin: 5,
    positionRangeMax: 15,
  });
  assert.ok(inRange > outOfRange);
  // positionWeight 1.0 vs 0.3 → ratio 1/0.3
  assert.equal(Number((inRange / outOfRange).toFixed(2)), 3.33);
});

test('computePriorityScore: drift > 3 applies the 1.5× bonus', () => {
  const noDrift = computePriorityScore({
    impressions: 10000,
    ctrGap: 0.5,
    position: 7,
    positionDrift: null,
    engagementPenalty: 0,
    positionRangeMin: 5,
    positionRangeMax: 15,
  });
  const withDrift = computePriorityScore({
    impressions: 10000,
    ctrGap: 0.5,
    position: 7,
    positionDrift: 5,
    engagementPenalty: 0,
    positionRangeMin: 5,
    positionRangeMax: 15,
  });
  assert.equal(Number((withDrift / noDrift).toFixed(2)), 1.5);
});

test('computePriorityTier: thresholds from ROADMAP §7', () => {
  assert.equal(computePriorityTier(50), 1);
  assert.equal(computePriorityTier(30), 1);
  assert.equal(computePriorityTier(29.99), 2);
  assert.equal(computePriorityTier(15), 2);
  assert.equal(computePriorityTier(14.99), 3);
  assert.equal(computePriorityTier(0), 3);
});

test('assignGroup: strict alternation by rank index', () => {
  assert.equal(assignGroup(0), 'treatment');
  assert.equal(assignGroup(1), 'control');
  assert.equal(assignGroup(2), 'treatment');
  assert.equal(assignGroup(99), 'control');
});
