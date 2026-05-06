import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

/**
 * File-based OAuth pattern: load an OAuth client (`installed` or `web`) JSON
 * + a token JSON produced by a one-off consent flow. The same credentials
 * file can serve multiple scopes (GSC, GA4) by pairing with different tokens.
 */

const InstalledClient = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  redirect_uris: z.array(z.string()).optional(),
});

const ClientWrapper = z.union([
  z.object({ installed: InstalledClient }),
  z.object({ web: InstalledClient }),
  InstalledClient,
]);

const TokenSchema = z.object({
  refresh_token: z.string(),
  access_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  expiry_date: z.number().optional(),
});

function readJson(filePath: string, label: string): unknown {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) {
    throw new Error(`${label} file not found at ${abs}`);
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`${label} at ${abs} is not valid JSON: ${(err as Error).message}`);
  }
}

const cache = new Map<string, OAuth2Client>();

/**
 * Build (and cache) an OAuth2 client from a credentials file + a token file.
 * Cache key is the joined paths so GSC and GA4 get distinct clients.
 */
export function googleOAuthFromFiles(opts: {
  credentialsFile: string;
  tokenFile: string;
}): OAuth2Client {
  const key = `${opts.credentialsFile}::${opts.tokenFile}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const credsRaw = readJson(opts.credentialsFile, 'OAuth credentials');
  const credsParsed = ClientWrapper.parse(credsRaw);
  const creds =
    'installed' in credsParsed
      ? credsParsed.installed
      : 'web' in credsParsed
        ? credsParsed.web
        : credsParsed;

  const tokenParsed = TokenSchema.parse(readJson(opts.tokenFile, 'OAuth token'));

  const client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  client.setCredentials({
    refresh_token: tokenParsed.refresh_token,
    ...(tokenParsed.access_token ? { access_token: tokenParsed.access_token } : {}),
    ...(tokenParsed.expiry_date ? { expiry_date: tokenParsed.expiry_date } : {}),
    ...(tokenParsed.scope ? { scope: tokenParsed.scope } : {}),
    ...(tokenParsed.token_type ? { token_type: tokenParsed.token_type } : {}),
  });

  cache.set(key, client);
  return client;
}
