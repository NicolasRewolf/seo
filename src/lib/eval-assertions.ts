/**
 * Vague 3 — eval framework assertion DSL.
 *
 * Each golden case carries an `assertions.json` that lists 3-10 claims
 * the diagnostic output MUST satisfy. The DSL is intentionally simple
 * (top-level string fields only, no nested path resolution) — 90% of
 * what we want to pin is in the LLM's free-form synthesis fields like
 * `tldr`, `intent_mismatch`, `snippet_weakness`, `engagement_diagnosis`.
 *
 * If we ever need nested path support (e.g. `top_queries_analysis[0].
 * intent_match == 'partial'`), add a `path` field that uses dot-notation
 * — but resist until we hit a real case that needs it. The current
 * top-level-only design keeps the assertion files readable by humans.
 */
import type { DiagnosticPayload } from '../pipeline/diagnose.js';

export type AssertionKind =
  | 'must_contain_any'
  | 'must_contain_all'
  | 'must_not_contain_any'
  | 'regex'
  | 'regex_not'
  | 'min_length'
  | 'max_length';

export type Assertion = {
  /** Top-level field of DiagnosticPayload (e.g. "tldr", "snippet_weakness"). */
  field: keyof DiagnosticPayload;
  kind: AssertionKind;
  /** For *_contain_* and regex variants, the patterns to match. */
  patterns?: string[];
  /** For min_length / max_length, the threshold in chars. */
  length?: number;
  /** Human-readable rationale — surfaced in failure reports. Required so
   *  whoever reads the report knows WHY this claim matters. */
  why: string;
  /** Optional case-insensitive flag for *_contain_* (default: true). */
  case_sensitive?: boolean;
};

export type AssertionResult = {
  assertion: Assertion;
  passed: boolean;
  /** Why it failed — shown in the report. Null when passed. */
  detail: string | null;
  /** The actual value at `field` — truncated to 300 chars for readability. */
  observed: string;
};

export type CaseResult = {
  case_id: string;
  what: string;
  passed: boolean;
  pass_count: number;
  fail_count: number;
  results: AssertionResult[];
  /** Full LLM output for the run — preserved so a regression can be diff'd
   *  against the baseline next run. */
  output: DiagnosticPayload;
  /** Wall-clock latency of the LLM call. */
  duration_ms: number;
};

function getString(payload: DiagnosticPayload, field: keyof DiagnosticPayload): string {
  const v = (payload as Record<string, unknown>)[field as string];
  if (typeof v === 'string') return v;
  if (v == null) return '';
  // Defensive : if a future schema change makes a field non-string, stringify
  // so the assertion still produces a useful error rather than crashing.
  return JSON.stringify(v);
}

function checkPatterns(
  haystack: string,
  patterns: string[],
  caseSensitive: boolean,
): boolean[] {
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  return patterns.map((p) => {
    const needle = caseSensitive ? p : p.toLowerCase();
    return h.includes(needle);
  });
}

export function runAssertion(payload: DiagnosticPayload, a: Assertion): AssertionResult {
  const observed = getString(payload, a.field);
  const truncated = observed.length > 300 ? observed.slice(0, 300) + '…' : observed;
  const cs = a.case_sensitive ?? false;

  let passed = false;
  let detail: string | null = null;

  switch (a.kind) {
    case 'must_contain_any': {
      const patterns = a.patterns ?? [];
      const hits = checkPatterns(observed, patterns, cs);
      passed = hits.some((h) => h);
      if (!passed) {
        detail = `none of [${patterns.map((p) => `"${p}"`).join(', ')}] found in field "${String(a.field)}"`;
      }
      break;
    }
    case 'must_contain_all': {
      const patterns = a.patterns ?? [];
      const hits = checkPatterns(observed, patterns, cs);
      const missing = patterns.filter((_, i) => !hits[i]);
      passed = missing.length === 0;
      if (!passed) {
        detail = `missing required terms: [${missing.map((p) => `"${p}"`).join(', ')}]`;
      }
      break;
    }
    case 'must_not_contain_any': {
      const patterns = a.patterns ?? [];
      const hits = checkPatterns(observed, patterns, cs);
      const found = patterns.filter((_, i) => hits[i]);
      passed = found.length === 0;
      if (!passed) {
        detail = `forbidden terms found: [${found.map((p) => `"${p}"`).join(', ')}]`;
      }
      break;
    }
    case 'regex': {
      const pattern = a.patterns?.[0] ?? '';
      const flags = cs ? '' : 'i';
      try {
        passed = new RegExp(pattern, flags).test(observed);
        if (!passed) detail = `regex /${pattern}/${flags} did not match`;
      } catch (err) {
        passed = false;
        detail = `invalid regex: ${(err as Error).message}`;
      }
      break;
    }
    case 'regex_not': {
      const pattern = a.patterns?.[0] ?? '';
      const flags = cs ? '' : 'i';
      try {
        passed = !new RegExp(pattern, flags).test(observed);
        if (!passed) detail = `forbidden regex /${pattern}/${flags} matched`;
      } catch (err) {
        passed = false;
        detail = `invalid regex: ${(err as Error).message}`;
      }
      break;
    }
    case 'min_length': {
      const threshold = a.length ?? 0;
      passed = observed.length >= threshold;
      if (!passed) {
        detail = `length ${observed.length} < min ${threshold}`;
      }
      break;
    }
    case 'max_length': {
      const threshold = a.length ?? 0;
      passed = observed.length <= threshold;
      if (!passed) {
        detail = `length ${observed.length} > max ${threshold}`;
      }
      break;
    }
  }

  return { assertion: a, passed, detail, observed: truncated };
}

export function scoreCase(
  caseId: string,
  what: string,
  payload: DiagnosticPayload,
  assertions: Assertion[],
  durationMs: number,
): CaseResult {
  const results = assertions.map((a) => runAssertion(payload, a));
  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;
  return {
    case_id: caseId,
    what,
    passed: failCount === 0,
    pass_count: passCount,
    fail_count: failCount,
    results,
    output: payload,
    duration_ms: durationMs,
  };
}
