/**
 * End-to-end replay tests against the live mock app. No LLM involved.
 * Exercises: happy path + typed output, an expected business outcome, a
 * recoverable interstitial, and a hard failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Run, newRunId } from '../src/observability/run.js';
import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { bootstrapMockSession } from '../src/session/bootstrap.js';
import { replay } from '../src/replay/engine.js';
import { parseArtifact } from '../src/artifact/schema.js';
import { sampleBalanceArtifact } from './fixtures/sample-artifact.js';

const PORT = 4791;
const BASE = `http://localhost:${PORT}`;
let mock: ChildProcess;

async function waitForServer(url: string, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 302) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server ${url} did not start`);
}

async function arm(flag: string) {
  await fetch(`${BASE}/_control`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `flag=${flag}` });
}

async function runReplay(params: Record<string, string>, opts: { inject?: string } = {}) {
  if (opts.inject) await arm(opts.inject);
  const run = new Run('replay', `${newRunId()}-test`);
  const { storageStatePath, reauthenticate } = await bootstrapMockSession(BASE);
  const surface = new PlaywrightSurface({ headless: true, storageStatePath });
  try {
    return await replay({
      artifact: parseArtifact(sampleBalanceArtifact()),
      params,
      baseUrl: BASE,
      surface,
      run,
      reauthenticate,
      escalation: {},
    });
  } finally {
    await surface.close();
  }
}

beforeAll(async () => {
  mock = spawn('npx', ['tsx', 'src/mock-app/server.ts'], {
    env: { ...process.env, MOCK_APP_PORT: String(PORT) },
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  await waitForServer(`${BASE}/login`);
}, 40000);

afterAll(() => {
  mock?.kill();
  try {
    rmSync('runs', { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('deterministic replay', () => {
  it('happy path: returns the typed savings_balance output', async () => {
    const r = await runReplay({ memberId: '12345' });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(String(r.outputs.savings_balance)).toMatch(/^\$[\d,]+\.\d{2}$/);
      expect(r.checkpoints.some((c) => c.pass)).toBe(true);
    }
  }, 60000);

  it('business outcome: unknown member is MEMBER_NOT_FOUND, not a crash', async () => {
    const r = await runReplay({ memberId: '00000' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.outcomeCode).toBe('MEMBER_NOT_FOUND');
  }, 60000);

  it('business outcome: restricted member is PERMISSION_DENIED', async () => {
    const r = await runReplay({ memberId: '99999' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.outcomeCode).toBe('PERMISSION_DENIED');
  }, 60000);

  it('recoverable: dismisses an unexpected maintenance interstitial and still succeeds', async () => {
    const r = await runReplay({ memberId: '12345' }, { inject: 'maintenance_interstitial' });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.recovered.map((x) => x.handlerId)).toContain('maintenance-interstitial');
  }, 60000);

  it('hard failure: an application 500 stops with a debuggable error', async () => {
    const r = await runReplay({ memberId: '12345' }, { inject: 'app_error' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.failureKind).toBe('hard');
  }, 60000);

  it('input validation: a malformed member id fails fast', async () => {
    const r = await runReplay({ memberId: 'abc' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.failureKind).toBe('input');
  }, 30000);
});
