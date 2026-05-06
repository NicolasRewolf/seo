import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  // GitHub
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),

  // Google
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  GSC_PROPERTY_URL: z.string().url(),
  GA4_PROPERTY_ID: z.string().min(1),

  // Wix
  WIX_API_KEY: z.string().min(1),
  WIX_SITE_ID: z.string().min(1),
  WIX_ACCOUNT_ID: z.string().min(1),

  // Audit
  AUDIT_PERIOD_MONTHS: z.coerce.number().int().positive().default(3),
  MIN_IMPRESSIONS_THRESHOLD: z.coerce.number().int().nonnegative().default(500),
  CTR_GAP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  POSITION_RANGE_MIN: z.coerce.number().int().min(1).default(5),
  POSITION_RANGE_MAX: z.coerce.number().int().min(1).default(15),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function loadEnvPartial(): Partial<Env> {
  return EnvSchema.partial().parse(process.env);
}
