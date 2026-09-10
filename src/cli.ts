/**
 * CLI entry point. See README.md for the demo path.
 */
import 'dotenv/config';
import { Command } from 'commander';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Run, newRunId, evidenceDir } from './observability/run.js';
import { PlaywrightSurface } from './surface/web/playwright-surface.js';
import { bootstrapMockSession } from './session/bootstrap.js';
import { Llm } from './agent/llm.js';
import { discover } from './agent/loop.js';
import { traceToArtifact } from './artifact/synthesize.js';
import { loadArtifact, loadArtifactByPath, saveArtifact, listArtifacts, setApproval, recordReplayOutcome } from './artifact/store.js';
import { replay } from './replay/engine.js';
import { Guard, DEFAULT_ALLOWLIST } from './safety/policy.js';
import { buildCatalog, invokeCapability } from './catalog/catalog.js';
import { startCatalogServer } from './catalog/server.js';

const program = new Command();
program.name('cua').description('Computer-use automation: discover once, replay deterministically.');

function collectParams(val: string, acc: Record<string, string>) {
  const i = val.indexOf('=');
  if (i < 0) throw new Error(`--param must be key=value, got "${val}"`);
  acc[val.slice(0, i)] = val.slice(i + 1);
  return acc;
}

function copyEvidence(run: Run, label: string): string {
  const dest = join(evidenceDir(), `${label}-${run.id}`);
  mkdirSync(dest, { recursive: true });
  for (const f of ['events.jsonl', 'trace.json', 'result.json', 'transcript.json']) {
    if (existsSync(join(run.dir, f))) cpSync(join(run.dir, f), join(dest, f));
  }
  for (const d of ['screenshots', 'observations']) {
    if (existsSync(join(run.dir, d))) cpSync(join(run.dir, d), join(dest, d), { recursive: true });
  }
  return dest;
}

async function armInject(baseUrl: string, flag: string) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/_control`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `flag=${encodeURIComponent(flag)}`,
  });
  // eslint-disable-next-line no-console
  console.log(`[inject] armed "${flag}":`, await res.json().catch(() => '(no body)'));
}

// --------------------------------------------------------------------------- discover
program
  .command('discover')
  .requiredOption('--goal <text>', 'natural-language goal')
  .option('--param <k=v>', 'input parameter (repeatable)', collectParams, {})
  .option('--base-url <url>', 'target app base URL', 'http://localhost:4599')
  .option('--vendor <name>', 'vendor product id', 'meridian-core')
  .option('--capability-id <id>', 'id for the emitted artifact')
  .option('--max-steps <n>', 'agent step budget', '15')
  .option('--headless', 'run browser headless', false)
  .option('--risky <mode>', 'irreversible-action handling: escalate|auto-approve|block', 'escalate')
  .option('--auto-resume-file <path>', 'file-based escalation resume (for unattended runs)')
  .action(async (opts) => {
    const runId = newRunId();
    const run = new Run('discovery', runId);
    const capabilityId = opts.capabilityId ?? `${opts.vendor}.capability.${runId.replace(/[^\w]/g, '').slice(-6)}`;

    run.info('discover.begin', opts.goal, { params: Object.keys(opts.param), baseUrl: opts.baseUrl });
    const { storageStatePath } = await bootstrapMockSession(opts.baseUrl);
    const surface = new PlaywrightSurface({ headless: !!opts.headless, storageStatePath, slowMoMs: opts.headless ? 0 : 150 });
    const llm = new Llm();
    const guard = new Guard({ ...DEFAULT_ALLOWLIST, allowedUrlPatterns: [`^${escapeRe(opts.baseUrl)}`] });

    let trace;
    try {
      trace = await discover({
        goal: opts.goal,
        params: opts.param,
        entryUrl: `${opts.baseUrl.replace(/\/$/, '')}/dashboard`,
        vendorProduct: opts.vendor,
        maxSteps: Number(opts.maxSteps),
        surface,
        run,
        llm,
        guard,
        riskyActionMode: opts.risky,
        escalation: opts.autoResumeFile ? { autoResumeFile: opts.autoResumeFile } : {},
      });
    } finally {
      await surface.close();
    }

    run.info('discover.outcome', trace.outcome, { summary: trace.summary, steps: trace.steps.length });

    if (trace.outcome !== 'success') {
      const dest = copyEvidence(run, 'discovery-FAILED');
      // eslint-disable-next-line no-console
      console.log(`\nDiscovery did not succeed (${trace.outcome}: ${trace.summary}). Evidence: ${dest}`);
      process.exitCode = 1;
      return;
    }

    const artifact = traceToArtifact(trace, {
      capabilityId,
      vendorProduct: opts.vendor,
      baseUrl: opts.baseUrl.replace(/\/$/, ''),
    });
    const path = saveArtifact(artifact);
    const dest = copyEvidence(run, 'discovery');
    cpSync(path, join(dest, 'artifact.json'));
    // eslint-disable-next-line no-console
    console.log(`\n✓ Discovery succeeded.
  Artifact : ${path}
  Capability: ${artifact.id}@${artifact.version}  (${artifact.policy.riskLevel}, approval=${artifact.approval.state})
  Outputs  : ${artifact.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'}
  Evidence : ${dest}

  Replay it:
    npm run cli -- replay --artifact ${path} ${artifact.parameters.map((p) => `--param ${p.name}=${p.example ?? '<value>'}`).join(' ')}`);
  });

// --------------------------------------------------------------------------- replay
program
  .command('replay')
  .requiredOption('--artifact <idOrPath>', 'capability id or path to artifact json')
  .option('--version <semver>', 'artifact version (when using id)')
  .option('--param <k=v>', 'input parameter (repeatable)', collectParams, {})
  .option('--base-url <url>', 'target app base URL', 'http://localhost:4599')
  .option('--headless', 'run browser headless', false)
  .option('--allow-unapproved', 'run even if the artifact needs approval', false)
  .option('--inject <flag>', 'arm a mock-app failure before replay (record-not-found demo etc.)')
  .option('--auto-resume-file <path>', 'file-based escalation resume (for unattended runs)')
  .action(async (opts) => {
    const artifact = opts.artifact.endsWith('.json') ? loadArtifactByPath(opts.artifact) : loadArtifact(opts.artifact, opts.version);
    const run = new Run('replay', newRunId());

    const { storageStatePath, reauthenticate } = await bootstrapMockSession(opts.baseUrl);
    if (opts.inject) await armInject(opts.baseUrl, opts.inject);

    const surface = new PlaywrightSurface({ headless: !!opts.headless, storageStatePath, slowMoMs: opts.headless ? 0 : 120 });
    const guard = new Guard({ ...DEFAULT_ALLOWLIST, allowedUrlPatterns: [`^${escapeRe(opts.baseUrl)}`] });

    let result;
    try {
      result = await replay({
        artifact,
        params: opts.param,
        baseUrl: opts.baseUrl,
        surface,
        run,
        guard,
        reauthenticate,
        allowUnapproved: !!opts.allowUnapproved,
        escalation: opts.autoResumeFile ? { autoResumeFile: opts.autoResumeFile } : {},
      });
    } finally {
      await surface.close();
    }

    run.writeResult(result);
    recordReplayOutcome(artifact.id, artifact.version, result.status === 'success');
    const dest = copyEvidence(run, `replay-${result.status}`);

    // eslint-disable-next-line no-console
    console.log(`\n=== REPLAY RESULT: ${result.status.toUpperCase()} ===`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\nEvidence: ${dest}`);
    process.exitCode = result.status === 'failure' ? 1 : 0;
  });

// --------------------------------------------------------------------------- catalog
const cat = program.command('catalog').description('agent-facing capability catalog');
cat
  .command('list')
  .action(() => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(buildCatalog(), null, 2));
  });
cat
  .command('serve')
  .option('--port <n>', 'port', '4700')
  .option('--base-url <url>', 'target app base URL', 'http://localhost:4599')
  .action(async (opts) => {
    await startCatalogServer(Number(opts.port), opts.baseUrl);
  });
cat
  .command('invoke <id>')
  .option('--param <k=v>', 'arg (repeatable)', collectParams, {})
  .option('--base-url <url>', 'target app base URL', 'http://localhost:4599')
  .option('--allow-unapproved', 'bypass approval gate', false)
  .action(async (id, opts) => {
    const result = await invokeCapability(id, opts.param, { baseUrl: opts.baseUrl, headless: true, allowUnapproved: !!opts.allowUnapproved });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'failure' ? 1 : 0;
  });
cat
  .command('approve <id>')
  .requiredOption('--version <semver>')
  .option('--by <name>', 'approver', 'cli-user')
  .action((id, opts) => {
    const a = setApproval(id, opts.version, 'approved', opts.by);
    // eslint-disable-next-line no-console
    console.log(`${a.id}@${a.version} -> approval=${a.approval.state} by ${a.approval.approvedBy}`);
  });

// --------------------------------------------------------------------------- misc
program
  .command('inspect <idOrPath>')
  .option('--version <semver>')
  .action((idOrPath, opts) => {
    const a = idOrPath.endsWith('.json') ? loadArtifactByPath(idOrPath) : loadArtifact(idOrPath, opts.version);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(a, null, 2));
  });

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

program.parseAsync().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
