#!/usr/bin/env tsx
/**
 * Vague 3 — replay all golden cases against the current prompt + LLM.
 *
 * Usage :
 *   npm run eval                        # all cases
 *   npm run eval -- --cases=foo,bar     # subset
 *   npm run eval -- --concurrency=3     # parallel LLM calls (default: 2)
 *
 * Output : eval/results/<timestamp>-<summary>/{report.md, report.json,
 * <case-id>-output.json}.
 *
 * Exit code : 0 if all cases pass, 1 if any case fails. CI uses this to
 * gate prompt-bump PRs.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  callDiagnosticLLM,
  type DiagnosticPayload,
} from '../pipeline/diagnose.js';
import {
  renderDiagnosticPrompt,
  DIAGNOSTIC_PROMPT_VERSION,
  type DiagnosticPromptInputs,
} from '../prompts/diagnostic.v1.js';
import { model } from '../lib/anthropic.js';
import { scoreCase, type Assertion, type CaseResult } from '../lib/eval-assertions.js';
import { buildReport, renderMarkdown } from '../lib/eval-report.js';

type Args = {
  caseFilter: string[] | null;
  concurrency: number;
  casesDir: string;
  resultsDir: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    caseFilter: null,
    concurrency: 2,
    casesDir: 'eval/cases',
    resultsDir: 'eval/results',
  };
  for (const raw of argv) {
    const [k, ...rest] = raw.replace(/^--/, '').split('=');
    const v = rest.join('=');
    if (k === 'cases') out.caseFilter = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'concurrency') out.concurrency = Math.max(1, Math.min(10, Number(v) || 2));
    else if (k === 'casesDir') out.casesDir = v;
    else if (k === 'resultsDir') out.resultsDir = v;
  }
  return out;
}

/**
 * JSON.parse loses Date types. The only Date field in DiagnosticPromptInputs
 * is `cooked_first_seen`. Revive it explicitly so the prompt renderer
 * (which calls `.getTime()` etc) gets the right type.
 */
function reviveInputs(raw: unknown): DiagnosticPromptInputs {
  const obj = raw as Record<string, unknown>;
  if (obj.cooked_first_seen != null && typeof obj.cooked_first_seen === 'string') {
    obj.cooked_first_seen = new Date(obj.cooked_first_seen);
  }
  return obj as unknown as DiagnosticPromptInputs;
}

async function loadCase(caseDir: string): Promise<{
  caseId: string;
  what: string;
  inputs: DiagnosticPromptInputs;
  assertions: Assertion[];
}> {
  const caseId = path.basename(caseDir);
  const [inputsRaw, assertionsRaw, metaRaw] = await Promise.all([
    fs.readFile(path.join(caseDir, 'inputs.json'), 'utf8'),
    fs.readFile(path.join(caseDir, 'assertions.json'), 'utf8'),
    fs.readFile(path.join(caseDir, 'meta.json'), 'utf8').catch(() => '{}'),
  ]);
  const inputs = reviveInputs(JSON.parse(inputsRaw));
  const assertionsFile = JSON.parse(assertionsRaw) as { what?: string; asserts: Assertion[] };
  const meta = JSON.parse(metaRaw) as { what?: string };
  const what = assertionsFile.what ?? meta.what ?? caseId;
  return { caseId, what, inputs, assertions: assertionsFile.asserts };
}

async function runOneCase(c: Awaited<ReturnType<typeof loadCase>>): Promise<CaseResult> {
  const t0 = Date.now();
  const prompt = renderDiagnosticPrompt(c.inputs);
  let payload: DiagnosticPayload;
  try {
    payload = await callDiagnosticLLM(prompt);
  } catch (err) {
    // Wrap the error as a synthetic failed CaseResult so the report shows
    // it instead of crashing the whole run. One bad LLM call shouldn't
    // tank the whole eval.
    const synthetic: DiagnosticPayload = {
      tldr: `[LLM CALL FAILED: ${(err as Error).message}]`,
      intent_mismatch: '',
      snippet_weakness: '',
      hypothesis: '',
      top_queries_analysis: [],
      engagement_diagnosis: '',
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
    };
    return scoreCase(c.caseId, c.what, synthetic, c.assertions, Date.now() - t0);
  }
  return scoreCase(c.caseId, c.what, payload, c.assertions, Date.now() - t0);
}

/** Bounded-concurrency map. Keeps Anthropic 429 risk low. */
async function pmap<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  // List cases
  let caseDirs: string[];
  try {
    const entries = await fs.readdir(args.casesDir, { withFileTypes: true });
    caseDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(args.casesDir, e.name));
  } catch (err) {
    process.stderr.write(`[eval] cannot read cases dir ${args.casesDir}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (args.caseFilter) {
    const want = new Set(args.caseFilter);
    caseDirs = caseDirs.filter((d) => want.has(path.basename(d)));
  }

  if (caseDirs.length === 0) {
    process.stderr.write(`[eval] no cases found in ${args.casesDir}\n`);
    process.exit(2);
  }

  process.stderr.write(`[eval] running ${caseDirs.length} case(s) at concurrency=${args.concurrency}…\n`);

  const cases = await Promise.all(caseDirs.map(loadCase));
  const results = await pmap(cases, args.concurrency, runOneCase);

  const finishedAt = new Date();
  const report = buildReport({
    startedAt,
    finishedAt,
    promptVersion: DIAGNOSTIC_PROMPT_VERSION,
    model: model(),
    cases: results,
  });

  // Write to timestamped subdir
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const summary = `${report.passed_cases}of${report.total_cases}-pass`;
  const outDir = path.join(args.resultsDir, `${stamp}-${summary}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(path.join(outDir, 'report.md'), renderMarkdown(report), 'utf8');
  // Also dump the full per-case output for diff'ing across runs
  await Promise.all(
    results.map((r) =>
      fs.writeFile(
        path.join(outDir, `${r.case_id}-output.json`),
        JSON.stringify(r.output, null, 2),
        'utf8',
      ),
    ),
  );

  process.stderr.write(`[eval] cases ${report.passed_cases}/${report.total_cases} passed, assertions ${report.passed_assertions}/${report.total_assertions} passed\n`);
  process.stderr.write(`[eval] report → ${outDir}\n`);

  if (report.failed_cases > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[eval] FATAL: ${(err as Error).message}\n`);
  process.exit(1);
});
