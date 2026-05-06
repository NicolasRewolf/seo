/**
 * Sprint 3 — manual audit runner.
 * Usage: npm run audit
 *
 * Optional flags:
 *   --period-start=2026-02-06   override snapshot period (must be paired with --period-end)
 *   --period-end=2026-05-06
 *   --min-impressions=500       monthly threshold override
 *   --ctr-gap=0.4               gap threshold override (0..1)
 *   --pos-min=5
 *   --pos-max=15
 */
import { runAudit, type AuditOptions } from '../pipeline/compute-findings.js';

function parseArgs(): AuditOptions {
  const opts: AuditOptions = {};
  const thresholds: NonNullable<AuditOptions['thresholdsOverride']> = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split('=');
    if (!v) continue;
    switch (k) {
      case '--period-start':
        opts.periodStart = v;
        break;
      case '--period-end':
        opts.periodEnd = v;
        break;
      case '--min-impressions':
        thresholds.min_impressions_monthly = Number(v);
        break;
      case '--ctr-gap':
        thresholds.ctr_gap_threshold = Number(v);
        break;
      case '--pos-min':
        thresholds.position_min = Number(v);
        break;
      case '--pos-max':
        thresholds.position_max = Number(v);
        break;
      default:
        process.stderr.write(`unknown flag: ${k}\n`);
        process.exit(2);
    }
  }
  if (Object.keys(thresholds).length > 0) opts.thresholdsOverride = thresholds;
  return opts;
}

function fmtBenchmarks(b: Record<string, number>): string {
  return Object.keys(b)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .filter((p) => p >= 1 && p <= 15)
    .map((p) => `${p}: ${(b[String(p)]! * 100).toFixed(2)}%`)
    .join('  ');
}

async function main(): Promise<void> {
  const opts = parseArgs();
  process.stdout.write(`audit starting…\n`);
  const summary = await runAudit(opts);
  process.stdout.write(
    [
      ``,
      `audit_run_id   : ${summary.auditRunId}`,
      `period         : ${summary.periodStart} → ${summary.periodEnd}`,
      `pages analyzed : ${summary.pagesAnalyzed}`,
      `findings       : ${summary.findingsCount}`,
      `  by tier      : P1=${summary.findingsByTier[1]}  P2=${summary.findingsByTier[2]}  P3=${summary.findingsByTier[3]}`,
      `  by group     : treatment=${summary.findingsByGroup.treatment}  control=${summary.findingsByGroup.control}`,
      `benchmarks (1-15) : ${fmtBenchmarks(summary.benchmarksUsed)}`,
      `duration       : ${(summary.durationMs / 1000).toFixed(2)}s`,
      ``,
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`audit failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
