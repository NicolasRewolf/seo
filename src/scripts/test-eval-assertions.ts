/**
 * Vague 3 — unit tests for the eval assertion DSL.
 *
 * The DSL itself has no LLM dependency, so we can pin every operator's
 * pass/fail behavior with zero API cost. Tests cover :
 *   - the 7 assertion kinds (must_contain_any/all, must_not_contain_any,
 *     regex, regex_not, min_length, max_length)
 *   - case-insensitive default vs case_sensitive: true override
 *   - empty/null field handling (treated as empty string, not crash)
 *   - aggregation via scoreCase (passed flag = AND of all asserts)
 *
 * Run : npm run test:eval-assertions  (or part of `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssertion, scoreCase, type Assertion } from '../lib/eval-assertions.js';
import type { DiagnosticPayload } from '../pipeline/diagnose.js';

function payload(overrides: Partial<DiagnosticPayload> = {}): DiagnosticPayload {
  return {
    tldr: 'Page en pos 3 avec CTR sous-performant — snippet faible',
    intent_mismatch: 'L\'intent matche correctement les top queries',
    snippet_weakness: 'Le title fait 70 chars mais ne mentionne pas le bénéfice. Meta vide.',
    hypothesis: 'Snippet weakness est le driver principal',
    top_queries_analysis: [],
    engagement_diagnosis: 'Bonnes métriques de scroll, pages/session correct',
    performance_diagnosis: '',
    structural_gaps: '',
    funnel_assessment: '',
    internal_authority_assessment: '',
    conversion_assessment: '',
    traffic_strategy_note: '',
    device_optimization_note: '',
    outbound_leak_note: '',
    pogo_navboost_assessment: '',
    engagement_pattern_assessment: '',
    ...overrides,
  };
}

// ---------- must_contain_any ----------

test('must_contain_any: passes if any pattern matches', () => {
  const a: Assertion = {
    field: 'snippet_weakness',
    kind: 'must_contain_any',
    patterns: ['snippet', 'meta'],
    why: 'doit pointer le snippet',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
  assert.equal(r.detail, null);
});

test('must_contain_any: fails when no pattern matches', () => {
  const a: Assertion = {
    field: 'snippet_weakness',
    kind: 'must_contain_any',
    patterns: ['authority', 'backlinks'],
    why: 'should mention authority',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /none of/);
});

test('must_contain_any: case-insensitive by default', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'must_contain_any',
    patterns: ['POS 3', 'POSITION 3'],
    why: 'mentions position',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('must_contain_any: case_sensitive: true respected', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'must_contain_any',
    patterns: ['POS 3'],
    case_sensitive: true,
    why: 'exact case',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
});

// ---------- must_contain_all ----------

test('must_contain_all: passes only when ALL patterns match', () => {
  const a: Assertion = {
    field: 'snippet_weakness',
    kind: 'must_contain_all',
    patterns: ['title', 'meta'],
    why: 'both should be flagged',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('must_contain_all: fails listing missing terms', () => {
  const a: Assertion = {
    field: 'snippet_weakness',
    kind: 'must_contain_all',
    patterns: ['title', 'authority', 'backlinks'],
    why: 'should mention all 3',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /authority/);
  assert.match(r.detail!, /backlinks/);
  assert.doesNotMatch(r.detail!, /"title"/);
});

// ---------- must_not_contain_any ----------

test('must_not_contain_any: passes when none match', () => {
  const a: Assertion = {
    field: 'engagement_diagnosis',
    kind: 'must_not_contain_any',
    patterns: ['catastrophique', 'désastreux'],
    why: 'page is fine, no alarmist words',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('must_not_contain_any: fails listing forbidden terms found', () => {
  const a: Assertion = {
    field: 'engagement_diagnosis',
    kind: 'must_not_contain_any',
    patterns: ['scroll', 'bonnes'],
    why: 'should not mention these',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /scroll/);
  assert.match(r.detail!, /bonnes/);
});

// ---------- regex / regex_not ----------

test('regex: matches', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'regex',
    patterns: ['pos\\s+\\d'],
    why: 'mentions a position number',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('regex: fails when no match', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'regex',
    patterns: ['^Excellent'],
    why: 'starts with Excellent',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /did not match/);
});

test('regex_not: passes when forbidden pattern is absent', () => {
  const a: Assertion = {
    field: 'engagement_diagnosis',
    kind: 'regex_not',
    patterns: ['n/a'],
    why: 'should not be n/a',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('regex_not: fails when forbidden pattern matches', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'regex_not',
    patterns: ['snippet'],
    why: 'tldr should focus on action, not diagnosis',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
});

test('regex: invalid pattern → fail with parse error in detail', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'regex',
    patterns: ['['],
    why: 'broken regex',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /invalid regex/);
});

// ---------- length ----------

test('min_length: passes when long enough', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'min_length',
    length: 20,
    why: 'tldr should be substantive',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('min_length: fails when too short', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'min_length',
    length: 500,
    why: 'tldr should be very long',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /< min 500/);
});

test('max_length: passes when short enough', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'max_length',
    length: 200,
    why: 'tldr stays concise',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, true);
});

test('max_length: fails when too long', () => {
  const a: Assertion = {
    field: 'tldr',
    kind: 'max_length',
    length: 10,
    why: 'tldr extremely concise',
  };
  const r = runAssertion(payload(), a);
  assert.equal(r.passed, false);
  assert.match(r.detail!, /> max 10/);
});

// ---------- empty fields ----------

test('empty field: treated as empty string, doesn\'t crash', () => {
  const a: Assertion = {
    field: 'performance_diagnosis',
    kind: 'must_contain_any',
    patterns: ['LCP'],
    why: 'should mention LCP',
  };
  const r = runAssertion(payload({ performance_diagnosis: '' }), a);
  assert.equal(r.passed, false);
  assert.equal(r.observed, '');
});

// ---------- scoreCase aggregation ----------

test('scoreCase: passes when all assertions pass', () => {
  const asserts: Assertion[] = [
    { field: 'tldr', kind: 'min_length', length: 10, why: '' },
    // patterns must match the FIXTURE content, not the field name. The
    // default snippet_weakness text mentions "title" and "meta".
    { field: 'snippet_weakness', kind: 'must_contain_any', patterns: ['title'], why: '' },
  ];
  const c = scoreCase('test-1', 'all good', payload(), asserts, 1234);
  assert.equal(c.passed, true);
  assert.equal(c.pass_count, 2);
  assert.equal(c.fail_count, 0);
  assert.equal(c.duration_ms, 1234);
});

test('scoreCase: fails when ANY assertion fails', () => {
  const asserts: Assertion[] = [
    { field: 'tldr', kind: 'min_length', length: 10, why: '' },
    { field: 'snippet_weakness', kind: 'must_contain_any', patterns: ['authority'], why: '' },
  ];
  const c = scoreCase('test-2', 'one fails', payload(), asserts, 100);
  assert.equal(c.passed, false);
  assert.equal(c.pass_count, 1);
  assert.equal(c.fail_count, 1);
});

test('scoreCase: observed truncated to 300 chars', () => {
  const longTldr = 'x'.repeat(500);
  const asserts: Assertion[] = [
    { field: 'tldr', kind: 'must_contain_any', patterns: ['NOMATCH'], why: '' },
  ];
  const c = scoreCase('test-3', 'truncate', payload({ tldr: longTldr }), asserts, 0);
  assert.ok(c.results[0]!.observed.length <= 301); // 300 chars + ellipsis
  assert.ok(c.results[0]!.observed.endsWith('…'));
});
