/**
 * AMDEC fix M1 unit tests for fmtCookedHealth — the helper that renders
 * the <cooked_data_health> banner inside the diagnostic prompt v12 when
 * one or more Cooked RPCs failed during the diagnose pipeline run.
 *
 * Pin behavior :
 *   1. Returns null when health is undefined / null (omit block entirely).
 *   2. Returns null when every source is `ok` or `empty` (nominal — empty
 *      ≠ failed, no warning needed).
 *   3. Returns a banner mentioning the failed source name(s) when ≥1 source
 *      is `failed`.
 *   4. Banner includes the failure_messages so the LLM/operator can grep.
 *   5. Banner explicitly tells the LLM to read related blocks as "unknown",
 *      not as zero.
 *
 * Run with: npm run test:cooked-health  (or part of `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtCookedHealth } from '../prompts/diagnostic.v1.js';

test('fmtCookedHealth: undefined → null (omit block)', () => {
  assert.equal(fmtCookedHealth(undefined), null);
  assert.equal(fmtCookedHealth(null), null);
});

test('fmtCookedHealth: all ok → null', () => {
  const out = fmtCookedHealth({
    snapshot_extras: 'ok',
    site_context: 'ok',
    outbound: 'ok',
    cta: 'ok',
    engagement_density: 'ok',
    failure_messages: [],
  });
  assert.equal(out, null);
});

test('fmtCookedHealth: mix of ok + empty → null (empty ≠ failed)', () => {
  const out = fmtCookedHealth({
    snapshot_extras: 'ok',
    site_context: 'empty',
    outbound: 'empty',
    cta: 'empty',
    engagement_density: 'ok',
    failure_messages: [],
  });
  assert.equal(out, null);
});

test('fmtCookedHealth: 1 failed source → banner with the name', () => {
  const out = fmtCookedHealth({
    snapshot_extras: 'ok',
    site_context: 'ok',
    outbound: 'ok',
    cta: 'ok',
    engagement_density: 'failed',
    failure_messages: ['engagement_density: timeout after 30s'],
  });
  assert.ok(out, 'should return banner string');
  assert.ok(out!.includes('1/5 sources Cooked en échec'), 'mentions count');
  assert.ok(out!.includes('engagement_density'), 'mentions failed source name');
  assert.ok(out!.includes('timeout after 30s'), 'includes failure message');
  assert.ok(out!.includes('inconnus'), 'tells LLM to treat as unknown');
});

test('fmtCookedHealth: 3 failed → banner lists all 3', () => {
  const out = fmtCookedHealth({
    snapshot_extras: 'failed',
    site_context: 'ok',
    outbound: 'failed',
    cta: 'ok',
    engagement_density: 'failed',
    failure_messages: [
      'snapshot_extras: 503 service unavailable',
      'outbound: connection reset',
      'engagement_density: rpc not found',
    ],
  });
  assert.ok(out);
  assert.ok(out!.includes('3/5'));
  assert.ok(out!.includes('snapshot_extras'));
  assert.ok(out!.includes('outbound'));
  assert.ok(out!.includes('engagement_density'));
  assert.ok(out!.includes('503 service unavailable'));
});

test('fmtCookedHealth: failed + empty mix → only failed counted in banner', () => {
  const out = fmtCookedHealth({
    snapshot_extras: 'failed',
    site_context: 'empty',
    outbound: 'empty',
    cta: 'empty',
    engagement_density: 'empty',
    failure_messages: ['snapshot_extras: 500'],
  });
  assert.ok(out);
  // Empty sources are NOT counted as failed.
  assert.ok(out!.includes('1/5 sources'));
  assert.ok(!out!.includes('site_context'));
});
