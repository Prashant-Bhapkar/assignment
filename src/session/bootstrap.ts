/**
 * Session bootstrap.
 *
 * Authentication is a platform concern, not part of a capability — capabilities
 * assume an authenticated session (see the `preconditions` in the artifact).
 * This helper performs a scripted (NOT LLM-driven) login against the mock app
 * and produces a Playwright storageState the discovery and replay surfaces load.
 *
 * The `reauthenticate` closure it returns is what the replay engine's
 * `reAuthenticate` recovery calls when a session times out mid-run.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultRedactor } from '../safety/redaction.js';

export interface BootstrapResult {
  storageStatePath: string;
  reauthenticate: () => Promise<void>;
}

export interface MockCredentials {
  userid: string;
  password: string;
}

export async function bootstrapMockSession(
  baseUrl: string,
  creds: MockCredentials = { userid: 'operator', password: 'password123' },
  storageStatePath = 'runs/.session/mock-storage-state.json',
): Promise<BootstrapResult> {
  defaultRedactor.addSecret(creds.password, 'password');
  mkdirSync(dirname(storageStatePath), { recursive: true });

  const doLogin = async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${baseUrl.replace(/\/$/, '')}/login`, { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="userid"]', creds.userid);
      await page.fill('input[name="password"]', creds.password);
      await page.click('input[type="submit"]');
      await page.waitForURL(/\/dashboard/, { timeout: 8000 });
      await ctx.storageState({ path: storageStatePath });
    } finally {
      await browser.close();
    }
  };

  await doLogin();
  return { storageStatePath, reauthenticate: doLogin };
}
