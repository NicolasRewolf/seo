import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { env } from '../config.js';

let cached: OAuth2Client | null = null;

/**
 * Shared OAuth2 client for GSC + GA4. The user authorizes once with both scopes
 * (webmasters.readonly + analytics.readonly) and stores the resulting refresh
 * token in GOOGLE_REFRESH_TOKEN.
 */
export function googleOAuth(): OAuth2Client {
  if (cached) return cached;
  const e = env.google();
  const client = new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: e.GOOGLE_REFRESH_TOKEN });
  cached = client;
  return cached;
}
