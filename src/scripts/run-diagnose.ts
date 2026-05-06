/**
 * Sprint 4 — driver for the diagnostic LLM step.
 * Usage: npm run diagnose -- [--limit=3] [--ids=uuid1,uuid2]
 */
import { diagnosePending } from '../pipeline/diagnose.js';

function parseArgs(): { limit?: number; onlyFindingIds?: string[] } {
  const out: { limit?: number; onlyFindingIds?: string[] } = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split('=');
    if (!v) continue;
    if (k === '--limit') out.limit = Number(v);
    else if (k === '--ids') out.onlyFindingIds = v.split(',').filter(Boolean);
    else {
      process.stderr.write(`unknown flag: ${k}\n`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  process.stdout.write(`diagnose starting…\n`);
  const r = await diagnosePending(opts);
  process.stdout.write(
    [
      ``,
      `attempted : ${r.attempted}`,
      `succeeded : ${r.succeeded}`,
      `failed    : ${r.failed}`,
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
  process.stderr.write(`diagnose failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
