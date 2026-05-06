import { env } from '../config.js';

const WIX_BASE = 'https://www.wixapis.com';

function headers(): Record<string, string> {
  const e = env.wix();
  return {
    Authorization: e.WIX_API_KEY,
    'wix-site-id': e.WIX_SITE_ID,
    'wix-account-id': e.WIX_ACCOUNT_ID,
    'Content-Type': 'application/json',
  };
}

export async function wixGet<T>(path: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${WIX_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: 'GET', headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wix GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function wixPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WIX_BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix POST ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function wixPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WIX_BASE}${path}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix PATCH ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Smoke test: query Wix Site Properties (low-impact endpoint available on most sites).
 * On 401/403, the API key/site/account IDs are wrong.
 */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const data = await wixGet<{ properties?: { siteDisplayName?: string } }>(
      '/site-properties/v4/properties',
    );
    const name = data?.properties?.siteDisplayName ?? '<unknown>';
    return { ok: true, detail: `connected to Wix site "${name}"` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
