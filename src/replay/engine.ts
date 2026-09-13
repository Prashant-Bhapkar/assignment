/**
 * Deterministic replay engine — the production execution path. No LLM.
 *
 * Guarantees it tries to provide:
 *  - determinism: same artifact + params => same steps, same locator strategy
 *    order, same checkpoints. Timing is handled by polling explicit conditions,
 *    never fixed sleeps (except recovery back-off).
 *  - explicit runtime-error handling: after every step the engine scans the
 *    artifact's error handlers and classifies what it sees as a business
 *    outcome, a recoverable condition, or a hard failure.
 *  - a structured result the calling agent can branch on.
 */
import type { Surface } from '../surface/types.js';
import type { Run } from '../observability/run.js';
import { Guard } from '../safety/policy.js';
import { defaultRedactor } from '../safety/redaction.js';
import { escalate, type EscalationOptions } from '../escalation/escalation.js';
import {
  type CapabilityArtifact,
  type Check,
  type ErrorHandler,
  type ErrorSignal,
  type RecoveryAction,
  type Step,
  type TargetSelector,
} from '../artifact/schema.js';
import type { CheckpointRecord, RecoveredCondition, ReplayResult } from './result.js';

export interface ReplayInput {
  artifact: CapabilityArtifact;
  params: Record<string, string | number | boolean>;
  baseUrl: string;
  surface: Surface;
  run: Run;
  guard?: Guard;
  escalation?: EscalationOptions;
  /** Provided by session bootstrap; used by the reAuthenticate recovery. */
  reauthenticate?: () => Promise<void>;
  allowUnapproved?: boolean;
  /** Max recovery attempts per step before giving up. */
  maxRecoveriesPerStep?: number;
}

const CHECK_POLL_MS = 400;

export async function replay(input: ReplayInput): Promise<ReplayResult> {
  const { artifact, surface, run } = input;
  const guard = input.guard ?? new Guard();
  const startedAt = Date.now();
  const recovered: RecoveredCondition[] = [];
  const checkpoints: CheckpointRecord[] = [];
  const outputValues: Record<string, unknown> = {};
  const maxRecoveries = input.maxRecoveriesPerStep ?? 2;

  const base = { artifactId: artifact.id, artifactVersion: artifact.version };
  const safeUrl = () => {
    try {
      return surface.currentUrl();
    } catch {
      return '(surface not started)';
    }
  };
  async function captureFailureEvidence(): Promise<{ runDir: string; url: string; screenshotPath?: string; domSnapshotPath?: string }> {
    let screenshotPath: string | undefined;
    let domSnapshotPath: string | undefined;
    try {
      screenshotPath = run.screenshotPath('failure');
      await surface.screenshot(screenshotPath);
      domSnapshotPath = run.writeFile('failure-dom.html', await surface.domSnapshot());
    } catch {
      /* surface may not be started (e.g. input validation) */
    }
    return { runDir: run.dir, url: safeUrl(), screenshotPath, domSnapshotPath };
  }
  const evidence = () => ({ runDir: run.dir, url: safeUrl(), screenshotPath: undefined as string | undefined, domSnapshotPath: undefined as string | undefined });

  // ---- 0. approval gate ----
  if (artifact.policy.requiresApprovalToRun && artifact.approval.state !== 'approved' && !input.allowUnapproved) {
    run.error('replay.blocked', 'artifact requires approval and is not approved');
    return await fail('approval', null, 'approval.state === "approved"', `approval.state === "${artifact.approval.state}"`, 'This capability performs irreversible actions and has not been approved for unattended replay.');
  }

  // ---- 1. validate params against the typed contract ----
  const pctx: Record<string, string> = { baseUrl: input.baseUrl.replace(/\/$/, '') };
  for (const spec of artifact.parameters) {
    const raw = input.params[spec.name];
    if (raw === undefined || raw === '') {
      if (spec.required) return await fail('input', null, `parameter "${spec.name}" provided`, 'missing', `Required parameter "${spec.name}" was not supplied.`);
      continue;
    }
    const val = String(raw);
    if (spec.type === 'number' && Number.isNaN(Number(val))) return await fail('input', null, `"${spec.name}" is a number`, val, `Parameter "${spec.name}" must be a number.`);
    if (spec.pattern && !new RegExp(spec.pattern).test(val)) return await fail('input', null, `"${spec.name}" matches /${spec.pattern}/`, val, `Parameter "${spec.name}" failed validation.`);
    if (spec.enumValues && !spec.enumValues.includes(val)) return await fail('input', null, `"${spec.name}" in ${JSON.stringify(spec.enumValues)}`, val, `Parameter "${spec.name}" is not an allowed value.`);
    pctx[spec.name] = val;
    if (spec.sensitivity !== 'none') defaultRedactor.addSecret(val, spec.sensitivity);
  }
  run.info('replay.start', `${artifact.id}@${artifact.version}`, { params: defaultRedactor.redact(pctx).value });

  // ---- 2. entry point + preconditions ----
  const entryUrl = render(artifact.binding.entryPoint.urlTemplate, pctx);
  if (!guard.urlAllowed(entryUrl) || !artifact.policy.allowedUrlPatterns.some((p) => new RegExp(p).test(entryUrl))) {
    return await fail('guard', null, 'entry URL within allowlist', entryUrl, 'Entry point URL is outside the policy allowlist.');
  }
  await surface.start('');
  const entryResult = await navigateAndHandle(entryUrl, 'entry');
  await snap(run, surface, 'replay-entry');
  if (entryResult) return entryResult;

  for (const pre of artifact.preconditions) {
    const r = await waitForCheck(surface, pre, pctx, 4000);
    checkpoints.push({ step: -1, description: pre.description, pass: r.pass, detail: r.detail });
    if (!r.pass) {
      // A failed "authenticated session" precondition is recoverable if we can re-auth.
      if (input.reauthenticate) {
        run.warn('precondition.recover', 'attempting re-authentication', { precondition: pre.description });
        await input.reauthenticate();
        await surface.navigate(entryUrl);
        const r2 = await waitForCheck(surface, pre, pctx, 4000);
        if (!r2.pass) return await fail('hard', null, pre.description, r2.detail, `Precondition not satisfied: ${pre.description}`);
        recovered.push({ handlerId: 'precondition-reauth', classify: 'recoverable', atStep: -1, action: 'reAuthenticate', detail: pre.description });
      } else {
        return await fail('hard', null, pre.description, r.detail, `Precondition not satisfied: ${pre.description}`);
      }
    }
  }

  // ---- 3. steps ----
  for (const step of artifact.steps) {
    run.info('step.start', `#${step.index} ${step.intent}`, { action: step.action.kind });

    let attempt = 0;
    let stepRecoveries = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;

      // 3a. readiness gates
      let ready = true;
      for (const w of step.waitFor) {
        const r = await waitForCheck(surface, w, pctx, step.timeoutMs);
        if (!r.pass) {
          ready = false;
          const ctx = `waitFor not met: ${w.description} (${r.detail})`;
          const handled = (await scanAndHandle(step, 'content', ctx)) ?? (await scanAndHandle(step, 'timeout', ctx));
          if (handled) return handled;
          if (stepRecoveries < maxRecoveries && (await tryRecover(step, `readiness: ${w.description}`))) {
            stepRecoveries++;
            break; // re-enter while loop
          }
          return await fail('timeout', step.index, w.description, r.detail, `Step ${step.index} never became ready: ${w.description}`, step.intent);
        }
      }
      if (!ready) continue;

      // 3b. guard
      const targetDesc = step.target?.description;
      const preApproved =
        artifact.approval.state === 'approved' || input.allowUnapproved || !artifact.policy.confirmationRequiredForSteps.includes(step.index);
      const decision = guard.check({ action: step.action, url: surface.currentUrl(), targetDescription: targetDesc }, { preApproved });
      run.info('guard.decision', decision.reason, { step: step.index, verdict: decision.verdict, risk: decision.risk });
      if (decision.verdict === 'block') {
        return await fail('guard', step.index, 'action permitted by policy', decision.reason, `Guard blocked step ${step.index}: ${decision.reason}`, step.intent);
      }
      if (decision.verdict === 'confirm') {
        const outc = await escalate(
          surface,
          run,
          {
            origin: 'replay',
            capabilityOrGoal: `${artifact.id}@${artifact.version}`,
            currentStep: `#${step.index} ${step.intent}`,
            reason: `Irreversible step requires confirmation: ${targetDesc ?? step.action.kind}`,
            question: 'Approve this step? Perform it manually or resume to let replay continue.',
          },
          input.escalation,
        );
        run.info('step.confirmed', 'human handled/approved irreversible step', { notes: outc.notes });
      }

      // 3c. act
      const actionErr = await performStep(surface, step, pctx, outputValues, run);
      await snap(run, surface, `step-${step.index}`);

      // 3d. classify anything visible (errors can appear with or without an action error)
      const scanned = await scanAndHandle(step, 'content', actionErr ?? undefined);
      if (scanned) {
        if (scanned.status === 'business_outcome' || scanned.status === 'failure') return scanned;
      }
      const recoverySignal = await findRecoverable(step);
      if (recoverySignal) {
        if (stepRecoveries >= maxRecoveries) {
          return await fail('hard', step.index, 'recoverable condition cleared', recoverySignal.detail, `Step ${step.index}: recovery exhausted for ${recoverySignal.handler.id}`, step.intent);
        }
        stepRecoveries++;
        await applyRecovery(recoverySignal.handler, recoverySignal.handler.recovery!, step);
        recovered.push({
          handlerId: recoverySignal.handler.id,
          classify: 'recoverable',
          atStep: step.index,
          action: recoverySignal.handler.recovery!.kind,
          detail: recoverySignal.handler.description,
        });
        run.info('step.recovered', recoverySignal.handler.id, { action: recoverySignal.handler.recovery!.kind });
        continue; // retry the step
      }

      if (actionErr) {
        if (stepRecoveries < maxRecoveries && (await tryRecover(step, `action error: ${actionErr}`))) {
          stepRecoveries++;
          continue;
        }
        return await fail('locator', step.index, `step ${step.index} action to succeed`, actionErr, `Step ${step.index} failed: ${actionErr}`, step.intent);
      }

      // 3e. postcondition checkpoint
      if (step.postCondition) {
        const r = await waitForCheck(surface, step.postCondition, pctx, step.timeoutMs);
        checkpoints.push({ step: step.index, description: step.postCondition.description, pass: r.pass, detail: r.detail });
        if (!r.pass) {
          const ctx = `postcondition failed: ${step.postCondition.description} (${r.detail})`;
          const handled = (await scanAndHandle(step, 'content', ctx)) ?? (await scanAndHandle(step, 'timeout', ctx));
          if (handled) return handled;
          if (stepRecoveries < maxRecoveries && (await tryRecover(step, `postcondition: ${step.postCondition.description}`))) {
            stepRecoveries++;
            continue;
          }
          if (step.optional) {
            run.warn('step.optional-skip', `optional step ${step.index} postcondition not met; continuing`);
            break;
          }
          return await fail('checkpoint', step.index, step.postCondition.description, r.detail, `Checkpoint failed after step ${step.index}.`, step.intent);
        }
        run.info('checkpoint.pass', step.postCondition.description);
      }
      break; // step done
    }
  }

  // ---- 4. overall success condition ----
  const success = await waitForCheck(surface, artifact.successCondition, pctx, 6000);
  checkpoints.push({ step: 999, description: artifact.successCondition.description, pass: success.pass, detail: success.detail });
  await snap(run, surface, 'replay-final');
  if (!success.pass) {
    return await fail('checkpoint', artifact.steps.length - 1, artifact.successCondition.description, success.detail, 'Success condition not met at end of replay.');
  }

  // ---- 5. collect declared outputs ----
  const outputs: Record<string, unknown> = {};
  for (const o of artifact.outputs) {
    const v = outputValues[o.name] ?? null;
    outputs[o.name] = o.sensitivity === 'none' ? v : defaultRedactor.redactString(String(v ?? '')).value;
  }

  run.info('replay.success', `${artifact.id}@${artifact.version}`, { outputs, recovered: recovered.length });
  return {
    status: 'success',
    ...base,
    outputs,
    checkpoints,
    recovered,
    stepsRun: artifact.steps.length,
    durationMs: Date.now() - startedAt,
  };

  // ------------------------------------------------------------------ helpers
  async function fail(
    failureKind: Extract<ReplayResult, { status: 'failure' }>['failureKind'],
    atStep: number | null,
    expected: string,
    observed: string,
    message: string,
    stepIntent?: string,
  ): Promise<Extract<ReplayResult, { status: 'failure' }>> {
    run.error('replay.failure', message, { failureKind, atStep, expected, observed });
    return {
      status: 'failure',
      ...base,
      failureKind,
      atStep,
      stepIntent,
      expected,
      observed,
      message,
      recovered,
      evidence: await captureFailureEvidence(),
      durationMs: Date.now() - startedAt,
    };
  }

  function business(handler: ErrorHandler, atStep: number): Extract<ReplayResult, { status: 'business_outcome' }> {
    run.info('replay.business_outcome', handler.outcomeCode ?? handler.id, { message: handler.message });
    return {
      status: 'business_outcome',
      ...base,
      outcomeCode: handler.outcomeCode ?? handler.id.toUpperCase(),
      message: handler.message ?? handler.description,
      atStep,
      recovered,
      evidence: evidence(),
      durationMs: Date.now() - startedAt,
    };
  }

  /** Navigate to a URL and run the artifact's error taxonomy against the result
   *  (bounded recovery). Used for the entry point; step navigations are scanned
   *  inside the step loop. */
  async function navigateAndHandle(url: string, label: string): Promise<ReplayResult | undefined> {
    const entryStep: Step = {
      index: -1,
      intent: 'navigate to capability entry point',
      action: { kind: 'navigate', urlTemplate: '' },
      waitFor: [],
      onError: [],
      timeoutMs: 15000,
      optional: false,
      riskClass: 'read_only',
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await surface.navigate(url);
      run.info('navigate', `${label} -> ${url}`, { attempt, ok: r.ok });
      const terminal = await scanAndHandle(entryStep, 'content', `${label} navigation`);
      if (terminal) return terminal;
      const rec = await findRecoverable(entryStep);
      if (!rec) return undefined;
      await applyRecovery(rec.handler, rec.handler.recovery!, entryStep);
      recovered.push({ handlerId: rec.handler.id, classify: 'recoverable', atStep: -1, action: rec.handler.recovery!.kind, detail: `${label}: ${rec.detail}` });
      run.info('entry.recovered', rec.handler.id, { action: rec.handler.recovery!.kind });
    }
    return await fail('hard', null, 'entry point reachable', 'recovery exhausted', `Could not reach a clean entry state for ${label}.`);
  }

  /**
   * Evaluate handlers against the CURRENT page and return a terminal result if
   * one classifies as business/hard.
   *
   * mode "content": every handler whose signal is an observable page fact
   *   (text/url/httpStatus/elementVisible) — checked after every action AND
   *   whenever a checkpoint fails to explain, so "no members matched" is caught
   *   even though it surfaces as a readiness-gate timeout, not an action error.
   * mode "timeout": only handlers explicitly keyed on `checkpointTimeout` — a
   *   catch-all for "I don't have a page signal, but this checkpoint never
   *   coming true IS itself the signal". Only meaningful once a checkpoint has
   *   actually failed, so it is never part of "content".
   */
  async function scanAndHandle(step: Step, mode: 'content' | 'timeout', context?: string): Promise<ReplayResult | undefined> {
    const handlers = [...step.onError, ...artifact.errorHandlers].filter((h) => (mode === 'timeout' ? h.when.kind === 'checkpointTimeout' : h.when.kind !== 'checkpointTimeout'));
    for (const h of handlers) {
      const m = await matchSignal(surface, h.when, pctx);
      if (!m.matched) continue;
      run.warn('error.detected', `${h.id} → ${h.classify}`, { signal: h.when.kind, detail: m.detail, context });
      if (h.classify === 'business_outcome') return business(h, step.index);
      if (h.classify === 'hard_failure') return await fail('hard', step.index, 'no error condition', m.detail, h.message ?? `Hard failure: ${h.description}`, step.intent);
      // recoverable handled by findRecoverable / applyRecovery
    }
    return undefined;
  }

  async function findRecoverable(step: Step): Promise<{ handler: ErrorHandler; detail: string } | undefined> {
    const handlers = [...step.onError, ...artifact.errorHandlers].filter((h) => h.classify === 'recoverable' && h.recovery);
    for (const h of handlers) {
      const m = await matchSignal(surface, h.when, pctx);
      if (m.matched) return { handler: h, detail: m.detail };
    }
    return undefined;
  }

  async function applyRecovery(handler: ErrorHandler, action: RecoveryAction, step: Step): Promise<void> {
    switch (action.kind) {
      case 'click': {
        const o = await surface.resolve(templatizeSelector(action.target, pctx));
        if (o.found) await surface.click(o.target);
        break;
      }
      case 'acknowledgeDialog':
        await surface.answerDialog(action.accept);
        break;
      case 'reload':
        await surface.navigate(surface.currentUrl());
        break;
      case 'waitRetry':
        await new Promise((r) => setTimeout(r, action.backoffMs));
        break;
      case 'reAuthenticate':
        if (input.reauthenticate) await input.reauthenticate();
        else
          await escalate(surface, run, {
            origin: 'replay',
            capabilityOrGoal: `${artifact.id}@${artifact.version}`,
            currentStep: `#${step.index} ${step.intent}`,
            reason: 'Session expired and no re-auth hook is configured.',
            question: 'Sign the session back in, then resume.',
          }, input.escalation);
        break;
      case 'escalate':
        await escalate(surface, run, {
          origin: 'replay',
          capabilityOrGoal: `${artifact.id}@${artifact.version}`,
          currentStep: `#${step.index} ${step.intent}`,
          reason: handler.message ?? handler.description,
          question: 'Resolve the blocking condition, then resume.',
        }, input.escalation);
        break;
    }
  }

  async function tryRecover(step: Step, why: string): Promise<boolean> {
    const rec = await findRecoverable(step);
    if (!rec) return false;
    run.info('step.recover-attempt', `${rec.handler.id} (${why})`);
    await applyRecovery(rec.handler, rec.handler.recovery!, step);
    recovered.push({ handlerId: rec.handler.id, classify: 'recoverable', atStep: step.index, action: rec.handler.recovery!.kind, detail: why });
    return true;
  }
}

// --------------------------------------------------------------------------- pure helpers

function render(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => ctx[k] ?? `{{${k}}}`);
}

function templatizeSelector(sel: TargetSelector, ctx: Record<string, string>): TargetSelector {
  return {
    ...sel,
    strategies: sel.strategies.map((s) => ({ ...s, name: s.name ? render(s.name, ctx) : s.name, value: s.value ? render(s.value, ctx) : s.value })),
  };
}

function templatizeCheck(check: Check, ctx: Record<string, string>): Check {
  const a = check.assertion;
  const t = (s: string) => render(s, ctx);
  switch (a.type) {
    case 'urlMatches':
      return { ...check, assertion: { ...a, pattern: t(a.pattern) } };
    case 'urlContains':
      return { ...check, assertion: { ...a, value: t(a.value) } };
    case 'textPresent':
      return { ...check, assertion: { ...a, text: t(a.text), scope: a.scope ? templatizeSelector(a.scope, ctx) : undefined } };
    case 'textAbsent':
      return { ...check, assertion: { ...a, text: t(a.text) } };
    case 'elementVisible':
      return { ...check, assertion: { ...a, target: templatizeSelector(a.target, ctx) } };
    case 'elementCount':
      return { ...check, assertion: { ...a, target: templatizeSelector(a.target, ctx) } };
  }
}

async function waitForCheck(surface: Surface, check: Check, ctx: Record<string, string>, timeoutMs: number): Promise<{ pass: boolean; detail: string }> {
  const c = templatizeCheck(check, ctx);
  const deadline = Date.now() + timeoutMs;
  let last = { pass: false, detail: 'not evaluated' };
  do {
    last = await surface.evaluate(c);
    if (last.pass) return last;
    await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
  } while (Date.now() < deadline);
  return last;
}

async function matchSignal(surface: Surface, signal: ErrorSignal, ctx: Record<string, string>): Promise<{ matched: boolean; detail: string }> {
  switch (signal.kind) {
    case 'textPresent': {
      const r = await surface.evaluate({ description: 'error signal', assertion: { type: 'textPresent', text: render(signal.text, ctx), frame: signal.frame } });
      return { matched: r.pass, detail: r.detail };
    }
    case 'urlMatches': {
      const r = await surface.evaluate({ description: 'error signal', assertion: { type: 'urlMatches', pattern: render(signal.pattern, ctx) } });
      return { matched: r.pass, detail: r.detail };
    }
    case 'httpStatus': {
      const recent = surface.recentHttpStatuses();
      const hit = recent.find((s) => signal.codes.includes(s.status));
      return { matched: !!hit, detail: hit ? `saw HTTP ${hit.status} for ${hit.url}` : `no ${signal.codes.join('/')} in recent responses` };
    }
    case 'elementVisible': {
      const r = await surface.evaluate({ description: 'error signal', assertion: { type: 'elementVisible', target: templatizeSelector(signal.target, ctx) } });
      return { matched: r.pass, detail: r.detail };
    }
    case 'checkpointTimeout':
      return { matched: true, detail: 'evaluated in checkpoint-timeout context' };
  }
}

async function performStep(
  surface: Surface,
  step: Step,
  ctx: Record<string, string>,
  outputValues: Record<string, unknown>,
  run: Run,
): Promise<string | null> {
  const a = step.action;
  if (a.kind === 'navigate') {
    const r = await surface.navigate(render(a.urlTemplate, ctx));
    return r.ok ? null : r.error ?? 'navigation failed';
  }
  if (a.kind === 'acknowledgeDialog') {
    const r = await surface.answerDialog(a.accept);
    return r.ok ? null : r.error ?? null; // absence of a dialog is not fatal here
  }
  if (!step.target) return `step ${step.index} has action "${a.kind}" but no target`;
  const selector = templatizeSelector(step.target, ctx);

  if (a.kind === 'extract') {
    const raw = await surface.readValue(selector, a.attribute === 'innerText' ? 'innerText' : a.attribute === 'value' ? 'value' : a.attribute === 'href' ? 'href' : 'text');
    const value = transform(raw, a.transform, a.regex);
    outputValues[a.into] = value;
    run.info('extract', `${a.into} = ${JSON.stringify(value)}`);
    return raw === null ? `could not read "${a.into}" from ${selector.description}` : null;
  }

  const outcome = await surface.resolve(selector);
  if (!outcome.found) {
    return `could not resolve "${selector.description}" — tried ${outcome.attempts.map((x) => `${x.strategyKind}(${x.matchCount})`).join(', ')}`;
  }
  run.info('locator.resolved', selector.description, { strategy: outcome.target.strategyKind, matches: outcome.target.matchCount });

  let r;
  if (a.kind === 'click') r = await surface.click(outcome.target);
  else if (a.kind === 'type') r = await surface.fill(outcome.target, render(a.valueTemplate, ctx), { clearFirst: a.clearFirst, pressEnter: a.pressEnter });
  else if (a.kind === 'select') r = await surface.selectOption(outcome.target, render(a.valueTemplate, ctx));
  else if (a.kind === 'press') r = await surface.press(a.key);
  else return `unsupported action ${(a as { kind: string }).kind}`;

  return r.ok ? null : r.error ?? 'action failed';
}

function transform(raw: string | null, kind: string, regex?: { pattern: string; group: number }): string | null {
  if (raw === null) return null;
  const s = raw.trim();
  switch (kind) {
    case 'toNumber':
      return String(Number(s.replace(/[^0-9.-]/g, '')));
    case 'moneyToCents':
      return String(Math.round(Number(s.replace(/[^0-9.-]/g, '')) * 100));
    case 'regex': {
      if (!regex) return s;
      const m = new RegExp(regex.pattern).exec(s);
      return m ? m[regex.group] ?? m[0] : null;
    }
    case 'none':
      return raw;
    default:
      return s;
  }
}

async function snap(run: Run, surface: Surface, name: string): Promise<void> {
  try {
    await surface.screenshot(run.screenshotPath(name));
    run.writeObservation(name, await surface.observe());
  } catch (err) {
    run.warn('snap.failed', `${name}: ${(err as Error).message}`);
  }
}
