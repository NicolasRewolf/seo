/**
 * Sprint 6 — driver for the measurement pipeline.
 * Usage: npm run measure
 *
 * Reads every applied/measured finding, inserts a fix_outcomes row per due
 * milestone (T+30, T+60) that hasn't landed yet, and bumps the finding to
 * 'measured' once T+60 lands. Intended for daily cron.
 */
import { runMeasure } from '../pipeline/measure.js';

async function main(): Promise<void> {
  process.stdout.write(`measure starting…\n`);
  const r = await runMeasure();
  process.stdout.write(
    [
      ``,
      `attempted : ${r.attempted}  (findings in 'applied' or 'measured')`,
      `measured  : ${r.measured}   (new fix_outcomes rows inserted this run)`,
      `skipped   : ${r.skipped}    (no due milestone or already landed)`,
      `duration  : ${(r.durationMs / 1000).toFixed(1)}s`,
      ``,
    ].join('\n'),
  );
  if (r.errors.length > 0) {
    process.stdout.write('errors:\n');
    for (const e of r.errors) {
      process.stdout.write(`  - [${e.findingId}] :: ${e.error.slice(0, 250)}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`measure failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
