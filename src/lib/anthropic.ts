import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import { env } from '../config.js';

let cached: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: env.anthropic().ANTHROPIC_API_KEY });
  return cached;
}

export function model(): string {
  return env.anthropic().ANTHROPIC_MODEL;
}

/**
 * AMDEC fix M9 — retry exponentiel autour de `messages.create`.
 *
 * Anthropic peut renvoyer 429 (rate limit) ou 5xx (overloaded). Sans retry,
 * un batch de 17 findings échouait à la N-ième et abandonnait le reste.
 *
 * Stratégie : 3 essais total (1 nominal + 2 retries), backoff 2s → 8s.
 * Erreurs retried : status 429, 500, 502, 503, 504, 529 (Anthropic
 * "overloaded_error"). Tout autre code (auth 401, balance 400 "credit
 * balance too low", validation 400) NON retried — ces erreurs ne se
 * résolvent pas en attendant.
 *
 * Le cap à 3 essais évite de bloquer un batch trop longtemps si Anthropic
 * a une vraie outage. Les findings non-traités peuvent être relancés via
 * `npm run diagnose -- --ids=<uuids manquants>`.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [2000, 8000]; // entre essai 1→2 et 2→3

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string };
  if (e.status && RETRYABLE_STATUSES.has(e.status)) return true;
  // Filets pour les network errors (ECONNRESET, ETIMEDOUT) — Anthropic SDK
  // les wrappe parfois sans status code.
  const msg = (e.message ?? '').toLowerCase();
  return /econnreset|etimedout|enotfound|socket hang up|fetch failed/.test(msg);
}

export async function messagesCreateWithRetry(
  params: MessageCreateParams,
): Promise<Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Type-cast: messages.create returns Stream OR Message depending on
      // params.stream. We never set stream:true here, so the runtime is Message.
      return (await anthropic().messages.create(params)) as Message;
    } catch (err) {
      lastErr = err;
      const willRetry = attempt < RETRY_DELAYS_MS.length && isRetryable(err);
      if (!willRetry) throw err;
      const delay = RETRY_DELAYS_MS[attempt]!;
      const status = (err as { status?: number }).status ?? '?';
      process.stderr.write(
        `[anthropic] retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after ${delay}ms (status=${status})\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/** Smoke test: 1-token completion to verify auth + model availability. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const e = env.anthropic();
    const res = await anthropic().messages.create({
      model: e.ANTHROPIC_MODEL,
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
