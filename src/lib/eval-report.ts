/**
 * Vague 3 — eval report renderer.
 *
 * Two output formats per run :
 *   - report.md   : human-readable, what failed and why, pasteable in PR
 *                   description or issue comment.
 *   - report.json : machine-readable, used by CI to set the run status
 *                   and by `eval:diff` (later) to compare runs.
 *
 * Both are written to `eval/results/<timestamp>-<summary>/` (gitignored).
 */
import type { CaseResult } from './eval-assertions.js';

export type RunReport = {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  prompt_version: number;
  model: string;
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  total_assertions: number;
  passed_assertions: number;
  failed_assertions: number;
  cases: CaseResult[];
};

export function buildReport(opts: {
  startedAt: Date;
  finishedAt: Date;
  promptVersion: number;
  model: string;
  cases: CaseResult[];
}): RunReport {
  const cases = opts.cases;
  const totalAssertions = cases.reduce((acc, c) => acc + c.results.length, 0);
  const passedAssertions = cases.reduce((acc, c) => acc + c.pass_count, 0);
  return {
    started_at: opts.startedAt.toISOString(),
    finished_at: opts.finishedAt.toISOString(),
    duration_ms: opts.finishedAt.getTime() - opts.startedAt.getTime(),
    prompt_version: opts.promptVersion,
    model: opts.model,
    total_cases: cases.length,
    passed_cases: cases.filter((c) => c.passed).length,
    failed_cases: cases.filter((c) => !c.passed).length,
    total_assertions: totalAssertions,
    passed_assertions: passedAssertions,
    failed_assertions: totalAssertions - passedAssertions,
    cases,
  };
}

export function renderMarkdown(r: RunReport): string {
  const headerEmoji = r.failed_cases === 0 ? '✅' : '❌';
  const lines: string[] = [
    `# ${headerEmoji} Eval run — prompt v${r.prompt_version} (${r.model})`,
    '',
    `- **Cases** : ${r.passed_cases}/${r.total_cases} passed`,
    `- **Assertions** : ${r.passed_assertions}/${r.total_assertions} passed`,
    `- **Duration** : ${(r.duration_ms / 1000).toFixed(1)}s`,
    `- **Started** : ${r.started_at}`,
    '',
    '---',
    '',
  ];

  for (const c of r.cases) {
    const emoji = c.passed ? '✅' : '❌';
    lines.push(`## ${emoji} \`${c.case_id}\` — ${c.pass_count}/${c.results.length}`);
    lines.push('');
    lines.push(`> ${c.what}`);
    lines.push('');
    lines.push(`_LLM call: ${(c.duration_ms / 1000).toFixed(1)}s_`);
    lines.push('');

    if (c.fail_count > 0) {
      lines.push('### Failed assertions');
      lines.push('');
      for (const r of c.results.filter((x) => !x.passed)) {
        lines.push(`- ❌ **\`${String(r.assertion.field)}\`** [${r.assertion.kind}]`);
        lines.push(`  - **Why this matters** : ${r.assertion.why}`);
        lines.push(`  - **Failure** : ${r.detail}`);
        lines.push(`  - **Observed** : \`${r.observed.replace(/`/g, '\\`')}\``);
        lines.push('');
      }
    }

    if (c.pass_count > 0) {
      lines.push('<details><summary>Passed assertions</summary>');
      lines.push('');
      for (const r of c.results.filter((x) => x.passed)) {
        lines.push(`- ✅ \`${String(r.assertion.field)}\` [${r.assertion.kind}] — ${r.assertion.why}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  if (r.failed_cases === 0) {
    lines.push('🟢 **All cases passed.** No regressions detected against the assertion set.');
  } else {
    lines.push(`🔴 **${r.failed_cases} case(s) failed.** Review the failures above before bumping the prompt version.`);
  }

  return lines.join('\n');
}
