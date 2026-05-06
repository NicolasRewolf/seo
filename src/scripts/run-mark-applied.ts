/**
 * Sprint 6 — driver to mark a finding as applied after manual Wix edit.
 *
 * Usage:
 *   npm run apply -- --finding=<uuid> [--by=nicolas@rewolf.studio]
 *                    [--types=title,meta_description,intro]
 *                    [--at=2026-05-06T15:00:00Z]
 *                    [--no-github-label]
 *
 * Behaviour: writes one applied_fixes row per proposed_fix (status='draft')
 * that matches the optional --types filter, flips them + the finding to
 * 'applied', adds the status:applied label on the linked GH issue.
 */
import { markFindingApplied } from '../pipeline/mark-applied.js';

function parseArgs() {
  const args: {
    findingId?: string;
    appliedBy?: string;
    onlyFixTypes?: string[];
    appliedAt?: string;
    skipGithubLabel?: boolean;
  } = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--no-github-label') {
      args.skipGithubLabel = true;
      continue;
    }
    const [k, v] = arg.split('=');
    if (!v) continue;
    switch (k) {
      case '--finding':
        args.findingId = v;
        break;
      case '--by':
        args.appliedBy = v;
        break;
      case '--types':
        args.onlyFixTypes = v.split(',').filter(Boolean);
        break;
      case '--at':
        args.appliedAt = v;
        break;
      default:
        process.stderr.write(`unknown flag: ${k}\n`);
        process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!opts.findingId) {
    process.stderr.write('--finding=<uuid> is required\n');
    process.exit(2);
  }
  const r = await markFindingApplied(opts as { findingId: string });
  process.stdout.write(
    [
      ``,
      `finding         : ${r.findingId}`,
      `page            : ${r.page}`,
      `fixes applied   : ${r.fixesApplied}`,
      `fixes skipped   : ${r.fixesSkipped}`,
      `applied_at (T0) : ${r.appliedAt}`,
      `gh label set    : ${r.issueLabeledApplied}`,
      ``,
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`mark-applied failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
