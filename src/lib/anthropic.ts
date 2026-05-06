import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../config.js';

let cached: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (cached) return cached;
  const env = loadEnv();
  cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cached;
}

export function model(): string {
  return loadEnv().ANTHROPIC_MODEL;
}

/** Smoke test: 1-token completion to verify auth + model availability. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const env = loadEnv();
    const res = await anthropic().messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const first = res.content[0];
    const text = first?.type === 'text' ? first.text.trim() : '<non-text>';
    return { ok: true, detail: `model=${res.model} reply="${text}"` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
