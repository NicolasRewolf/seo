/**
 * Sprint 4 — driver for the diagnostic LLM step.
 * Usage: npm run diagnose -- [--limit=3] [--ids=uuid1,uuid2]
 *        npm run diagnose -- --ids=uuid --print-prompt   (debug-only,
 *                            renders prompt to stdout, NO LLM call)
 */
import { diagnosePending, buildDiagnosticInputs } from '../pipeline/diagnose.js';
import { renderDiagnosticPrompt } from '../prompts/diagnostic.v1.js';

type Args = { limit?: number; onlyFindingIds?: string[]; printPrompt?: boolean };

function parseArgs(): Args {
  const out: Args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--print-prompt') {
      out.printPrompt = true;
      continue;
    }
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

  if (opts.printPrompt) {
    if (!opts.onlyFindingIds || opts.onlyFindingIds.length === 0) {
      process.stderr.write('--print-prompt requires --ids=<uuid>\n');
      process.exit(2);
    }
    for (const id of opts.onlyFindingIds) {
      const inputs = await buildDiagnosticInputs(id);
      const prompt = renderDiagnosticPrompt(inputs);
      process.stdout.write(`========== prompt for finding ${id} (${prompt.length} chars) ==========\n`);
      process.stdout.write(prompt);
      process.stdout.write('\n========== end ==========\n\n');
    }
    return;
  }

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
