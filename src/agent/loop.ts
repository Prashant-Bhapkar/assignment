/**
 * Discovery loop: LLM-driven observe -> decide -> act against a live surface.
 * Produces a RunTrace (not a transcript). Every action passes the guard first.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Surface, InteractableDescriptor, Observation } from '../surface/types.js';
import type { Action } from '../artifact/schema.js';
import { descriptorToSelector } from '../artifact/synthesize.js';
import { Guard } from '../safety/policy.js';
import { defaultRedactor } from '../safety/redaction.js';
import type { Run } from '../observability/run.js';
import { escalate, type EscalationOptions } from '../escalation/escalation.js';
import { Llm } from './llm.js';
import { TOOLS } from './tools.js';
import { renderObservation, systemPrompt } from './prompt.js';
import type { RunTrace, TraceStep } from './trace.js';

export interface DiscoverInput {
  goal: string;
  params: Record<string, string>;
  entryUrl: string;
  vendorProduct: string;
  maxSteps?: number;
  surface: Surface;
  run: Run;
  llm: Llm;
  guard?: Guard;
  escalation?: EscalationOptions;
  /** How to treat a guard "confirm" verdict on an irreversible action. */
  riskyActionMode?: 'escalate' | 'auto-approve' | 'block';
}

export async function discover(input: DiscoverInput): Promise<RunTrace> {
  const { goal, params, entryUrl, vendorProduct, surface, run, llm } = input;
  const guard = input.guard ?? new Guard();
  const maxSteps = input.maxSteps ?? 15;
  const riskyActionMode = input.riskyActionMode ?? 'escalate';

  for (const [k, v] of Object.entries(params)) {
    // Never let a secret param value leak into logs/artifacts.
    if (/pass|secret|token|pin/i.test(k)) defaultRedactor.addSecret(v, 'param');
  }

  const startedAt = new Date().toISOString();
  const steps: TraceStep[] = [];
  const outputs: RunTrace['outputs'] = {};

  await surface.start(entryUrl);
  let obs = await snapshot(surface, run, 'initial');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: renderObservation(obs, 'Starting state.') }];
  const system = systemPrompt(goal, params, maxSteps);

  let outcome: RunTrace['outcome'] = 'failed';
  let summary = '';
  let stoppedReason: string | undefined;
  let consecutiveErrors = 0;

  for (let stepNo = 0; stepNo < maxSteps; stepNo++) {
    run.info('llm.turn', `step ${stepNo + 1}/${maxSteps}`);
    const { turn, assistant } = await llm.turn(system, messages, TOOLS);
    messages.push(assistant);
    if (turn.text) run.info('llm.text', turn.text.slice(0, 400));

    if (turn.toolCalls.length === 0) {
      messages.push({ role: 'user', content: 'You must call exactly one tool. Choose an action or finish.' });
      continue;
    }

    const call = turn.toolCalls[0]!;
    const toolResults: Anthropic.ToolResultBlockParam[] = turn.toolCalls.slice(1).map((c) => ({
      type: 'tool_result',
      tool_use_id: c.id,
      content: 'Ignored — take one action per turn.',
    }));

    run.info('agent.action', `${call.name} ${JSON.stringify(redactInput(call.input))}`);

    // ---- terminal tools ----
    if (call.name === 'finish') {
      outcome = call.input.status === 'success' ? 'success' : 'stuck';
      summary = String(call.input.summary ?? '');
      toolResults.unshift({ type: 'tool_result', tool_use_id: call.id, content: 'Run ended.' });
      messages.push({ role: 'user', content: toolResults });
      break;
    }

    if (call.name === 'escalate') {
      const outc = await escalate(
        surface,
        run,
        {
          origin: 'discovery',
          capabilityOrGoal: goal,
          currentStep: `after step ${steps.length}: ${String(call.input.reason ?? '')}`,
          reason: String(call.input.reason ?? 'agent escalated'),
          question: String(call.input.question ?? ''),
        },
        input.escalation,
      );
      steps.push({
        index: steps.length,
        intent: `Escalated to human: ${String(call.input.reason ?? '')}`,
        action: { kind: 'press', key: 'noop' } as Action,
        guard: { verdict: 'allow', risk: 'read_only', reason: 'human intervention' },
        result: { ok: true, urlBefore: obs.url, urlAfter: surface.currentUrl() },
        humanIntervention: { reason: String(call.input.reason ?? ''), actions: outc.humanActions.map((a) => `${a.kind}:${a.detail}`), durationMs: outc.durationMs },
      });
      obs = await snapshot(surface, run, `post-escalation-${steps.length}`);
      toolResults.unshift({
        type: 'tool_result',
        tool_use_id: call.id,
        content: `Human completed manual steps. Notes: ${outc.notes || '(none)'}\nActions: ${outc.humanActions.map((a) => `${a.kind} ${a.detail}`).join('; ') || '(none captured)'}\n\n${renderObservation(obs, 'State after human handoff.')}`,
      });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // ---- surface actions ----
    const urlBefore = surface.currentUrl();
    let descriptor: InteractableDescriptor | undefined;
    let action: Action | undefined;
    let resultText = '';
    let ok = false;
    let error: string | undefined;
    let resolution: TraceStep['resolution'];
    let extracted: TraceStep['extracted'];

    try {
      if (call.name === 'navigate') {
        action = { kind: 'navigate', urlTemplate: String(call.input.url) };
        const g = guard.check({ action, url: String(call.input.url) });
        if (g.verdict === 'block') {
          error = `guard blocked: ${g.reason}`;
        } else {
          const r = await surface.navigate(String(call.input.url));
          ok = r.ok;
          error = r.error;
        }
      } else if (call.name === 'acknowledge_dialog') {
        action = { kind: 'acknowledgeDialog', accept: Boolean(call.input.accept) };
        const r = await surface.answerDialog(Boolean(call.input.accept));
        ok = r.ok;
        error = r.error;
      } else {
        descriptor = [...obs.interactables, ...obs.readables].find((i) => i.ref === call.input.ref);
        if (!descriptor) {
          error = `no element with ref "${String(call.input.ref)}" in the current observation`;
        } else {
          action = toAction(call);
          const selector = descriptorToSelector(descriptor);
          const g = guard.check({ action, url: urlBefore, targetDescription: selector.description });
          run.info('guard.decision', g.reason, { verdict: g.verdict, risk: g.risk });

          if (g.verdict === 'block') {
            error = `guard blocked: ${g.reason}`;
          } else if (g.verdict === 'confirm') {
            if (riskyActionMode === 'block') {
              error = `irreversible action blocked by policy: ${g.reason}`;
            } else if (riskyActionMode === 'escalate') {
              const outc = await escalate(
                surface,
                run,
                {
                  origin: 'discovery',
                  capabilityOrGoal: goal,
                  currentStep: `confirm irreversible: ${selector.description}`,
                  reason: `Irreversible action needs human approval: ${selector.description}`,
                  question: 'Approve this action? If yes, perform it yourself or resume to let the agent proceed.',
                },
                input.escalation,
              );
              run.info('guard.confirmed', 'human approved / handled irreversible step', { notes: outc.notes });
            }
            if (!error) {
              const done = await performAction(surface, selector, call, descriptor);
              ok = done.ok;
              error = done.error;
              resolution = done.resolution;
              extracted = done.extracted;
            }
          } else {
            const done = await performAction(surface, selector, call, descriptor);
            ok = done.ok;
            error = done.error;
            resolution = done.resolution;
            extracted = done.extracted;
          }
        }
      }
    } catch (err) {
      error = (err as Error).message;
    }

    obs = await snapshot(surface, run, `step-${steps.length + 1}`);

    if (extracted) {
      const value = extracted.rawValue;
      outputs[extracted.name] = { type: extracted.type, value };
      run.info('output.extracted', `${extracted.name} (${extracted.type})`, { value });
    }

    const expectation = call.input.expectation ? String(call.input.expectation) : undefined;
    const checkpoint = expectation ? evaluateExpectation(expectation, obs) : undefined;

    steps.push({
      index: steps.length,
      intent: String(call.input.intent ?? call.name),
      expectation,
      action: action ?? ({ kind: 'press', key: 'noop' } as Action),
      targetDescriptor: descriptor,
      guard: { verdict: ok ? 'allow' : 'blocked-or-error', risk: 'reversible', reason: error ?? 'ok' },
      resolution,
      result: { ok: ok && !error, error, urlBefore, urlAfter: surface.currentUrl() },
      checkpoint,
      extracted,
      screenshotPath: obs.screenshotPath,
      observationRef: `step-${steps.length + 1}`,
    });

    if (error) {
      consecutiveErrors++;
      resultText = `ACTION FAILED: ${error}\n\n${renderObservation(obs)}`;
      if (consecutiveErrors >= 4) {
        stoppedReason = 'too many consecutive action failures';
        outcome = 'failed';
        summary = stoppedReason;
        toolResults.unshift({ type: 'tool_result', tool_use_id: call.id, content: resultText, is_error: true });
        messages.push({ role: 'user', content: toolResults });
        break;
      }
    } else {
      consecutiveErrors = 0;
      const cp = checkpoint ? `\nCHECKPOINT ${checkpoint.pass ? 'OK' : 'NOT MET'}: ${checkpoint.detail}` : '';
      const ex = extracted ? `\nRECORDED OUTPUT ${extracted.name} = ${JSON.stringify(extracted.rawValue)}` : '';
      resultText = `OK.${cp}${ex}\n\n${renderObservation(obs)}`;
    }

    toolResults.unshift({ type: 'tool_result', tool_use_id: call.id, content: resultText, is_error: !!error });
    messages.push({ role: 'user', content: toolResults });
  }

  if (outcome === 'failed' && !stoppedReason) stoppedReason = 'reached step budget without finishing';

  const trace: RunTrace = {
    runId: run.id,
    goal,
    params,
    target: { entryUrl, vendorProduct },
    model: llm.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome,
    summary: summary || stoppedReason || 'no summary',
    steps,
    outputs,
    stoppedReason,
  };
  run.writeFile('trace.json', JSON.stringify(trace, null, 2));
  run.writeFile('transcript.json', JSON.stringify(messages, null, 2));
  return trace;
}

async function snapshot(surface: Surface, run: Run, name: string): Promise<Observation> {
  const shot = run.screenshotPath(name);
  const obs = await surface.observe();
  await surface.screenshot(shot);
  obs.screenshotPath = shot;
  run.writeObservation(name, obs);
  return obs;
}

function toAction(call: { name: string; input: Record<string, unknown> }): Action {
  switch (call.name) {
    case 'click':
      return { kind: 'click' };
    case 'type':
      return {
        kind: 'type',
        valueTemplate: String(call.input.text ?? ''),
        secret: Boolean(call.input.is_secret),
        pressEnter: Boolean(call.input.press_enter),
        clearFirst: true,
      };
    case 'select':
      return { kind: 'select', valueTemplate: String(call.input.value ?? '') };
    case 'press_key':
      return { kind: 'press', key: String(call.input.key ?? 'Enter') };
    case 'extract':
      return {
        kind: 'extract',
        into: String(call.input.output_name ?? 'value'),
        attribute: (call.input.attribute as any) ?? 'text',
        transform: (call.input.transform as any) ?? 'trim',
      };
    default:
      return { kind: 'press', key: 'noop' } as Action;
  }
}

async function performAction(
  surface: Surface,
  selector: ReturnType<typeof descriptorToSelector>,
  call: { name: string; input: Record<string, unknown> },
  descriptor: InteractableDescriptor,
): Promise<{ ok: boolean; error?: string; resolution?: TraceStep['resolution']; extracted?: TraceStep['extracted'] }> {
  if (call.name === 'extract') {
    const raw = await surface.readValue(selector, (call.input.attribute as any) ?? 'text');
    const transformed = applyTransform(raw, String(call.input.transform ?? 'trim'));
    return {
      ok: raw !== null,
      error: raw === null ? 'could not read value from element' : undefined,
      extracted: { name: String(call.input.output_name ?? 'value'), type: String(call.input.output_type ?? 'string'), rawValue: transformed },
    };
  }

  const outcome = await surface.resolve(selector);
  if (!outcome.found) {
    return { ok: false, error: `could not resolve target (${outcome.attempts.map((a) => `${a.strategyKind}:${a.matchCount}`).join(', ')})` };
  }
  const resolution = { strategyKind: outcome.target.strategyKind, matchCount: outcome.target.matchCount, attempts: outcome.attempts.length };

  let r;
  if (call.name === 'click') r = await surface.click(outcome.target);
  else if (call.name === 'type')
    r = await surface.fill(outcome.target, String(call.input.text ?? ''), { pressEnter: Boolean(call.input.press_enter), clearFirst: true });
  else if (call.name === 'select') r = await surface.selectOption(outcome.target, String(call.input.value ?? ''));
  else if (call.name === 'press_key') r = await surface.press(String(call.input.key ?? 'Enter'));
  else r = { ok: false, error: `unknown action ${call.name}`, urlAfter: surface.currentUrl() };

  return { ok: r.ok, error: r.error, resolution };
}

export function applyTransform(raw: string | null, transform: string): string | null {
  if (raw === null) return null;
  const s = raw.trim();
  switch (transform) {
    case 'toNumber':
      return String(Number(s.replace(/[^0-9.-]/g, '')));
    case 'moneyToCents':
      return String(Math.round(Number(s.replace(/[^0-9.-]/g, '')) * 100));
    case 'none':
      return raw;
    default:
      return s;
  }
}

function evaluateExpectation(expectation: string, obs: Observation): { pass: boolean; detail: string } {
  const phrase = (expectation.match(/"([^"]+)"/)?.[1] ?? expectation.split(/\s+/).slice(0, 4).join(' ')).toLowerCase();
  const hay = `${obs.visibleText} ${obs.url} ${obs.title}`.toLowerCase();
  const pass = phrase.length > 2 && hay.includes(phrase);
  return { pass, detail: `expected "${phrase}" ${pass ? 'found' : 'not found'} on page` };
}

function redactInput(input: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...input };
  if (clone.is_secret && typeof clone.text === 'string') clone.text = '«redacted»';
  return defaultRedactor.redact(clone).value;
}
