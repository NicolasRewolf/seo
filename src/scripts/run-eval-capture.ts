#!/usr/bin/env tsx
/**
 * Vague 3 — capture a real prod finding into a frozen golden case.
 *
 * Usage :
 *   npm run eval:capture -- --finding=<uuid> --case=<slug> --what="short label"
 *
 * What it does :
 *   1. Loads finding by id, calls `buildDiagnosticInputs(finding_id)` to get
 *      the full DiagnosticPromptInputs (queries Cooked, link graph, etc).
 *   2. Serializes the inputs to `eval/cases/<case-id>/inputs.json` (Date
 *      fields go through ISO string roundtrip — see `revive` in run script).
 *   3. Writes a stub `assertions.json` with a TODO header — the human edits
 *      it to encode what the diagnostic MUST say about this case.
 *   4. Writes `meta.json` with provenance (source finding, page, captured_at,
 *      prompt version at capture time).
 *
 * Why this matters : the inputs are FROZEN. When we bump the prompt v12 →
 * v13, we re-run against the SAME inputs to detect behavior drift. If the
 * inputs were re-fetched live, every prompt change would be conflated with
 * data drift and the eval would be useless.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildDiagnosticInputs } from '../pipeline/diagnose.js';
import { DIAGNOSTIC_PROMPT_VERSION } from '../prompts/diagnostic.v1.js';

type Args = {
  findingId: string;
  caseId: string;
  what: string;
  /** Default: eval/cases. Tests use /tmp. */
  outDir: string;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { outDir: 'eval/cases' };
  for (const raw of argv) {
    const [k, ...rest] = raw.replace(/^--/, '').split('=');
    const v = rest.join('=');
    if (k === 'finding') out.findingId = v;
    else if (k === 'case') out.caseId = v;
    else if (k === 'what') out.what = v;
    else if (k === 'out') out.outDir = v;
  }
  if (!out.findingId || !out.caseId || !out.what) {
    process.stderr.write(
      'Usage: npm run eval:capture -- --finding=<uuid> --case=<slug> --what="short label"\n',
    );
    process.exit(2);
  }
  if (!/^[a-z0-9-]+$/.test(out.caseId)) {
    process.stderr.write('--case must be a kebab-slug ([a-z0-9-]+)\n');
    process.exit(2);
  }
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`[eval:capture] loading inputs for finding ${args.findingId}…\n`);
  const inputs = await buildDiagnosticInputs(args.findingId);

  const caseDir = path.resolve(args.outDir, args.caseId);
  await fs.mkdir(caseDir, { recursive: true });

  await fs.writeFile(
    path.join(caseDir, 'inputs.json'),
    JSON.stringify(inputs, null, 2),
    'utf8',
  );

  // Write a stub assertions.json — the human MUST edit this. We don't
  // try to auto-generate assertions from the captured output because the
  // whole point is to encode HUMAN judgment about what's correct.
  const stubAssertions = {
    case_id: args.caseId,
    what: args.what,
    asserts: [
      {
        field: 'tldr',
        kind: 'min_length',
        length: 50,
        why: 'TODO — replace this stub with real assertions before this case becomes useful.',
      },
    ],
  };
  const assertionsPath = path.join(caseDir, 'assertions.json');
  // Don't overwrite existing assertions if re-capturing the same case (the
  // human may have already edited them).
  try {
    await fs.access(assertionsPath);
    process.stderr.write(`[eval:capture] assertions.json exists — keeping it.\n`);
  } catch {
    await fs.writeFile(assertionsPath, JSON.stringify(stubAssertions, null, 2), 'utf8');
    process.stderr.write(`[eval:capture] wrote stub assertions.json (EDIT IT before running eval).\n`);
  }

  await fs.writeFile(
    path.join(caseDir, 'meta.json'),
    JSON.stringify(
      {
        case_id: args.caseId,
        what: args.what,
        source_finding_id: args.findingId,
        page_url: inputs.url,
        captured_at: new Date().toISOString(),
        prompt_version_at_capture: DIAGNOSTIC_PROMPT_VERSION,
      },
      null,
      2,
    ),
    'utf8',
  );

  process.stderr.write(`[eval:capture] OK → ${caseDir}\n`);
  process.stderr.write(`[eval:capture] Next : edit ${path.join(caseDir, 'assertions.json')}, then run \`npm run eval\`.\n`);
}

main().catch((err) => {
  process.stderr.write(`[eval:capture] FATAL: ${(err as Error).message}\n`);
  process.exit(1);
});
