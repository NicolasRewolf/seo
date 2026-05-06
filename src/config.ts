import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// `.env` wins over the inherited shell env. This is intentional for a local
// CLI tool — without override, an empty shell var (e.g. ANTHROPIC_API_KEY=
// injected by some launcher) silently shadows the real value in .env. CI/Docker
// can still set values directly because they don't ship with a .env file.
dotenvConfig({ override: true });

/**
 * Each connector validates only the env vars it needs (via its own section).
 * `loadEnv()` is the strict full-validation entry point used at app boot;
 * individual lib files use the narrow section getters so partial setups
 * (e.g. the smoke test) don't fail on unrelated missing vars.
 */

const SupabaseSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const AnthropicSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
});

const GitHubSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
});

/**
 * Google OAuth — file-based pattern.
 * The OAuth client credentials JSON (downloaded from GCP) can be shared
 * between GSC and GA4 since the OAuth project is the same. Each scope
 * needs its own user-consent token, so we keep two token paths.
 */
const GscSchema = z.object({
  GSC_OAUTH_CREDENTIALS_FILE: z.string().min(1),
  GSC_TOKEN_FILE: z.string().min(1),
  GSC_SITE_URL: z.string().url(),
});

const Ga4Schema = z.object({
  GA4_OAUTH_CREDENTIALS_FILE: z.string().min(1),
  GA4_TOKEN_FILE: z.string().min(1),
  GA4_PROPERTY_ID: z.string().min(1),
});

const WixSchema = z.object({
  WIX_API_KEY: z.string().min(1),
  WIX_SITE_ID: z.string().min(1),
  WIX_ACCOUNT_ID: z.string().min(1),
});

const AuditSchema = z.object({
  AUDIT_PERIOD_MONTHS: z.coerce.number().int().positive().default(3),
  MIN_IMPRESSIONS_THRESHOLD: z.coerce.number().int().nonnegative().default(500),
  CTR_GAP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  POSITION_RANGE_MIN: z.coerce.number().int().min(1).default(5),
  POSITION_RANGE_MAX: z.coerce.number().int().min(1).default(15),
});

const FullSchema = SupabaseSchema
  .merge(AnthropicSchema)
  .merge(GitHubSchema)
  .merge(GscSchema)
  .merge(Ga4Schema)
  .merge(WixSchema)
  .merge(AuditSchema);

function parseOrThrow<S extends z.ZodTypeAny>(name: string, schema: S): z.infer<S> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Missing/invalid ${name} env vars:\n${issues}`);
  }
  return result.data;
}

export const env = {
  supabase: () => parseOrThrow('Supabase', SupabaseSchema),
  anthropic: () => parseOrThrow('Anthropic', AnthropicSchema),
  github: () => parseOrThrow('GitHub', GitHubSchema),
  gsc: () => parseOrThrow('GSC', GscSchema),
  ga4: () => parseOrThrow('GA4', Ga4Schema),
  wix: () => parseOrThrow('Wix', WixSchema),
  audit: () => parseOrThrow('Audit', AuditSchema),
};

export type FullEnv = z.infer<typeof FullSchema>;

/** Strict full validation — call from production entrypoints to fail fast. */
export function loadEnv(): FullEnv {
  return parseOrThrow('full', FullSchema);
}
