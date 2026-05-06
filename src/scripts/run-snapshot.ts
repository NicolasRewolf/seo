/**
 * Sprint 2 — manual snapshot runner.
 * Usage: npm run snapshot
 *
 * Optional flags:
 *   --months=3          override AUDIT_PERIOD_MONTHS
 *   --end=2026-05-06    override end date (yyyy-MM-dd)
 *   --min-impressions=100  threshold for which pages get query-level pulls
 */
import { runSnapshot, type SnapshotOptions } from '../pipeline/snapshot.js';

function parseArgs(): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split('=');
    if (!v) continue;
    switch (k) {
      case '--months':
        opts.months = Number(v);
        break;
      case '--end':
        opts.endDate = new Date(v);
        break;
      case '--min-impressions':
        opts.minImpressionsForQueries = Number(v);
        break;
      default:
        process.stderr.write(`unknown flag: ${k}\n`);
        process.exit(2);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  process.stdout.write(`snapshot starting…\n`);
  const summary = await runSnapshot(opts);
  process.stdout.write(
    [
      ``,
      `period       : ${summary.periodStart} → ${summary.periodEnd}`,
      `gsc pages    : ${summary.gscPages}`,
      `gsc queries  : ${summary.gscQueries}`,
      `ga4 pages    : ${summary.ga4Pages}`,
      `duration     : ${(summary.durationMs / 1000).toFixed(1)}s`,
      ``,
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`snapshot failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
