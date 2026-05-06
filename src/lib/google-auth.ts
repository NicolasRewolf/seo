import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { loadEnv } from '../config.js';

let cached: OAuth2Client | null = null;

/**
 * Shared OAuth2 client for GSC + GA4. The user authorizes once with both scopes
 * (webmasters.readonly + analytics.readonly) and stores the refresh token in
 * GOOGLE_REFRESH_TOKEN.
 */
export function googleOAuth(): OAuth2Client {
  if (cached) return cached;
  const env = loadEnv();
  const client = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  cached = client;
  return cached;
}
