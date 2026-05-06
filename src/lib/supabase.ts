import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config.js';

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;
  const e = env.supabase();
  cached = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-app': 'plouton-seo-audit' } },
  });
  return cached;
}

/** Smoke test: read one row from audit_config. Returns true if reachable. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { data, error } = await supabase()
      .from('audit_config')
      .select('key')
      .limit(3);
    if (error) return { ok: false, detail: `${error.code}: ${error.message}` };
    const keys = (data ?? []).map((r: { key: string }) => r.key).join(', ');
    return { ok: true, detail: `audit_config keys: ${keys || '(empty)'}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
