import { Octokit } from '@octokit/rest';
import { env } from '../config.js';

let cached: Octokit | null = null;

export function github(): Octokit {
  if (cached) return cached;
  cached = new Octokit({
    auth: env.github().GITHUB_TOKEN,
    userAgent: 'plouton-seo-audit/0.0.1',
  });
  return cached;
}

export function repoCoords(): { owner: string; repo: string } {
  const e = env.github();
  return { owner: e.GITHUB_OWNER, repo: e.GITHUB_REPO };
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
