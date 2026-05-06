/**
 * Sprint 4 — driver for the fix-generation LLM step.
 * Usage: npm run fixes -- [--limit=3] [--ids=uuid1,uuid2]
 */
import { generateFixesForDiagnosed } from '../pipeline/generate-fixes.js';

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
  process.stdout.write(`generate-fixes starting…\n`);
  const r = await generateFixesForDiagnosed(opts);
  process.stdout.write(
    [
      ``,
      `attempted   : ${r.attempted}`,
      `succeeded   : ${r.succeeded}`,
      `failed      : ${r.failed}`,
      `total fixes : ${r.totalFixes}`,
      `duration    : ${(r.durationMs / 1000).toFixed(1)}s`,
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
  process.stderr.write(`generate-fixes failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
