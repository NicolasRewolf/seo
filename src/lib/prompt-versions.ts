/**
 * AMDEC fix M4 — prompt version traceability.
 *
 * Au boot du diag / fix-gen, garantit qu'une row `prompt_versions` existe
 * pour la (name, version) courante et retourne son UUID. Le caller stocke
 * cet UUID sur :
 *   - audit_findings.diagnostic_prompt_version_id (pour 'diagnostic')
 *   - proposed_fixes.prompt_version_id (pour 'fix_generation')
 *
 * Module-level cache : 1 lookup par (name, version) par process.
 * En batch de 17 findings, on paie 1 seul SELECT (+0 ou 1 INSERT).
 */
import { supabase } from './supabase.js';

export type PromptName = 'diagnostic' | 'fix_generation';

const cache = new Map<string, string>(); // key=`${name}|${version}` → uuid

function cacheKey(name: PromptName, version: number): string {
  return `${name}|${version}`;
}

/**
 * Idempotent : SELECT WHERE (name, version) → si trouvée, retourne l'id ;
 * sinon INSERT minimal placeholder + retourne le nouvel id. La col
 * `template` est requise NOT NULL : on stocke un placeholder court qui
 * référence le code source (le vrai prompt vit dans des constantes TS,
 * pas en DB — c'est versionné dans Git).
 */
export async function ensurePromptVersion(
  name: PromptName,
  version: number,
  notes?: string,
): Promise<string> {
  const key = cacheKey(name, version);
  const cached = cache.get(key);
  if (cached) return cached;

  const sb = supabase();

  // SELECT existing
  const { data: existing, error: selErr } = await sb
    .from('prompt_versions')
    .select('id')
    .eq('prompt_name', name)
    .eq('version', version)
    .maybeSingle();
  if (selErr) throw new Error(`prompt_versions select: ${selErr.message}`);
  if (existing?.id) {
    cache.set(key, existing.id as string);
    return existing.id as string;
  }

  // INSERT new
  const placeholder =
    `${name} prompt v${version} — code source : src/prompts/${name === 'diagnostic' ? 'diagnostic.v1.ts' : 'fix-generation.v1.ts'}. ` +
    `Snapshotté en DB pour traçabilité (le vrai template vit dans Git).`;
  const { data: inserted, error: insErr } = await sb
    .from('prompt_versions')
    .insert({
      prompt_name: name,
      version,
      template: placeholder,
      notes: notes ?? null,
      active: true,
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`prompt_versions insert: ${insErr.message}`);
  if (!inserted?.id) throw new Error('prompt_versions insert returned no id');

  cache.set(key, inserted.id as string);
  return inserted.id as string;
}

/** Reset du cache — utilitaire test. Pas utilisé en prod. */
export function _resetCacheForTests(): void {
  cache.clear();
}
