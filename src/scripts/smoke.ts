/**
 * Sprint 1 smoke test — pings each connector and prints pass/fail.
 * Usage: npm run smoke
 */
import { loadEnvPartial } from '../config.js';
import { smokeTest as supabaseSmoke } from '../lib/supabase.js';
import { smokeTest as anthropicSmoke } from '../lib/anthropic.js';
import { smokeTest as githubSmoke } from '../lib/github.js';
import { smokeTest as gscSmoke } from '../lib/gsc.js';
import { smokeTest as ga4Smoke } from '../lib/ga4.js';
import { smokeTest as wixSmoke } from '../lib/wix.js';

type Probe = { name: string; required: string[]; run: () => Promise<{ ok: boolean; detail: string }> };

const probes: Probe[] = [
  { name: 'Supabase', required: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], run: supabaseSmoke },
  { name: 'Anthropic', required: ['ANTHROPIC_API_KEY'], run: anthropicSmoke },
  { name: 'GitHub', required: ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'], run: githubSmoke },
  {
    name: 'GSC',
    required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GSC_PROPERTY_URL'],
    run: gscSmoke,
  },
  {
    name: 'GA4',
    required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GA4_PROPERTY_ID'],
    run: ga4Smoke,
  },
  { name: 'Wix', required: ['WIX_API_KEY', 'WIX_SITE_ID', 'WIX_ACCOUNT_ID'], run: wixSmoke },
];

function missing(env: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => !env[k] || String(env[k]).trim() === '');
}

async function main(): Promise<void> {
  const env = loadEnvPartial() as Record<string, unknown>;
  const results: Array<{ name: string; status: 'ok' | 'fail' | 'skipped'; detail: string }> = [];

  for (const probe of probes) {
    const miss = missing(env, probe.required);
    if (miss.length > 0) {
      results.push({ name: probe.name, status: 'skipped', detail: `missing: ${miss.join(', ')}` });
      continue;
    }
    try {
      const r = await probe.run();
      results.push({ name: probe.name, status: r.ok ? 'ok' : 'fail', detail: r.detail });
    } catch (err) {
      results.push({ name: probe.name, status: 'fail', detail: (err as Error).message });
    }
  }

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const r of results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'skipped' ? '·' : '✗';
    const tag =
      r.status === 'ok' ? 'OK     ' : r.status === 'skipped' ? 'SKIP   ' : 'FAIL   ';
    process.stdout.write(`${icon}  ${tag} ${r.name.padEnd(10)} ${r.detail}\n`);
    if (r.status === 'ok') ok++;
    else if (r.status === 'fail') fail++;
    else skipped++;
  }
  process.stdout.write(`\n${ok} ok · ${fail} fail · ${skipped} skipped\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`smoke: unexpected error: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
