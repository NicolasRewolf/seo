import { Octokit } from '@octokit/rest';
import { loadEnv } from '../config.js';

let cached: Octokit | null = null;

export function github(): Octokit {
  if (cached) return cached;
  const env = loadEnv();
  cached = new Octokit({ auth: env.GITHUB_TOKEN, userAgent: 'plouton-seo-audit/0.0.1' });
  return cached;
}

export function repoCoords(): { owner: string; repo: string } {
  const env = loadEnv();
  return { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO };
}

/** Smoke test: GET the configured repo. Confirms token + repo access. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { owner, repo } = repoCoords();
    const { data } = await github().rest.repos.get({ owner, repo });
    return {
      ok: true,
      detail: `${data.full_name} (default=${data.default_branch}, private=${data.private})`,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
