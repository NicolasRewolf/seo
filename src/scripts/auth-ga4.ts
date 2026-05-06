/**
 * One-off OAuth consent flow for GA4 (analytics.readonly scope).
 *
 * Usage: npm run auth:ga4
 *
 * Reads the OAuth client JSON pointed to by GA4_OAUTH_CREDENTIALS_FILE in .env
 * (defaults to ./gsc-oauth-credentials.json — the same credentials file as GSC,
 * since both APIs live in the same GCP project), opens a consent URL in your
 * browser, captures the redirect on http://localhost:<random-port>, exchanges
 * the code for tokens, and writes the result to GA4_TOKEN_FILE (default
 * ./ga4-token.json).
 *
 * The token includes a refresh_token so subsequent API calls don't require
 * re-consent.
 */
import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import { z } from 'zod';

dotenvConfig({ override: true });

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const InstalledClient = z.object({
  client_id: z.string(),
  client_secret: z.string(),
});
const ClientWrapper = z.union([
  z.object({ installed: InstalledClient }),
  z.object({ web: InstalledClient }),
  InstalledClient,
]);

function readClientCreds(filePath: string): { client_id: string; client_secret: string } {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) throw new Error(`OAuth credentials file not found at ${abs}`);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  const parsed = ClientWrapper.parse(raw);
  if ('installed' in parsed) return parsed.installed;
  if ('web' in parsed) return parsed.web;
  return parsed;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      process.stderr.write(`(could not auto-open browser; paste this URL manually)\n${url}\n`);
    }
  });
}

async function captureCode(port: number): Promise<string> {
  return new Promise((resolveFn, rejectFn) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`OAuth error: ${error}. You can close this tab.`);
          server.close();
          rejectFn(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing ?code parameter.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2rem">
          <h2>✅ GA4 OAuth done</h2>
          <p>Token saved. You can close this tab and return to your terminal.</p>
        </body></html>`);
        server.close();
        resolveFn(code);
      } catch (e) {
        rejectFn(e as Error);
      }
    });
    server.on('error', rejectFn);
    server.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  const credsFile = process.env.GA4_OAUTH_CREDENTIALS_FILE ?? './gsc-oauth-credentials.json';
  const tokenFile = process.env.GA4_TOKEN_FILE ?? './ga4-token.json';

  process.stdout.write(`Using OAuth client: ${credsFile}\n`);
  process.stdout.write(`Will write token to: ${tokenFile}\n`);

  const { client_id, client_secret } = readClientCreds(credsFile);

  // Listen on a random free port; redirect URI is http://127.0.0.1:<port>
  // For "installed" OAuth client type, Google accepts any localhost port.
  const tempServer = createServer();
  await new Promise<void>((resolveFn) => tempServer.listen(0, '127.0.0.1', resolveFn));
  const port = (tempServer.address() as AddressInfo).port;
  tempServer.close();

  const redirectUri = `http://127.0.0.1:${port}`;
  const oauth = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token even on re-consent
    scope: [SCOPE],
  });

  process.stdout.write(`\nOpening consent URL in your browser...\n${authUrl}\n\n`);
  process.stdout.write(`Listening for redirect on ${redirectUri} ...\n`);

  openBrowser(authUrl);
  const code = await captureCode(port);

  const { tokens } = await oauth.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token returned. Try revoking the previous grant at ' +
        'https://myaccount.google.com/permissions and rerun.',
    );
  }

  const out = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date,
  };

  const abs = resolve(process.cwd(), tokenFile);
  writeFileSync(abs, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`\n✓ Token written to ${abs}\n`);
  process.stdout.write(`  scope: ${tokens.scope}\n`);
  process.stdout.write(`\nNext: set GA4_PROPERTY_ID in .env then run \`npm run smoke\`.\n`);
}

main().catch((err) => {
  process.stderr.write(`auth-ga4 failed: ${(err as Error).message}\n`);
  process.exit(1);
});
