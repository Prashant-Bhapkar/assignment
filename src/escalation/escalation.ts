/**
 * Escalation coordinator — used by BOTH the discovery loop and the replay engine.
 *
 * Detect "stuck" -> capture context (which goal/capability, step, state,
 * screenshot, why) -> raise an intervention -> transfer control of the live
 * session to a human -> resume on the same session, preserving evidence and
 * recording what the human did.
 */
import { readFileSync } from 'node:fs';
import type { Surface } from '../surface/types.js';
import type { Run } from '../observability/run.js';

export interface InterventionRequest {
  origin: 'discovery' | 'replay';
  capabilityOrGoal: string;
  currentStep: string;
  reason: string;
  question?: string;
}

export interface InterventionOutcome {
  resolved: boolean;
  notes: string;
  humanActions: { t: string; kind: string; detail: string }[];
  durationMs: number;
  screenshotPath: string;
}

/** Auto-resume mode for unattended / CI runs: a human "resolves" by writing a
 *  file. Real deployments would use the operator console button. */
export interface EscalationOptions {
  /** If set, instead of blocking on the console we poll this file and resume when
   *  it contains JSON {notes,done:true}. Lets tests exercise the full seam. */
  autoResumeFile?: string;
  pollMs?: number;
}

export async function escalate(
  surface: Surface,
  run: Run,
  req: InterventionRequest,
  opts: EscalationOptions = {},
): Promise<InterventionOutcome> {
  const screenshotPath = run.screenshotPath('escalation');
  await surface.screenshot(screenshotPath);
  const obs = await surface.observe();
  const domPath = run.writeFile('escalation-dom.html', await surface.domSnapshot());

  run.warn('escalation.raised', req.reason, {
    origin: req.origin,
    capabilityOrGoal: req.capabilityOrGoal,
    step: req.currentStep,
    question: req.question,
    url: obs.url,
    screenshot: screenshotPath,
    domSnapshot: domPath,
  });

  const control = await surface.cedeControl();
  control.setContext({
    title: `[${req.origin}] ${req.reason}`,
    body: [
      `Capability / goal : ${req.capabilityOrGoal}`,
      `Stopped at step   : ${req.currentStep}`,
      `Reason            : ${req.reason}`,
      req.question ? `Asked of operator : ${req.question}` : '',
      `Current URL       : ${obs.url}`,
      `Screenshot        : ${screenshotPath}`,
      '',
      'Visible text at stop point:',
      obs.visibleText.slice(0, 800),
    ]
      .filter(Boolean)
      .join('\n'),
  });
  run.info('escalation.handoff', 'live session handed to operator', { operatorUrl: control.operatorUrl });

  let outcome: { notes: string; humanActions: any[]; durationMs: number };
  if (opts.autoResumeFile) {
    outcome = await pollFileResume(opts.autoResumeFile, opts.pollMs ?? 1000);
    await control.release();
  } else {
    outcome = await control.waitForResume();
    await control.release();
  }

  run.info('escalation.resumed', 'operator returned control', {
    durationMs: outcome.durationMs,
    humanActionCount: outcome.humanActions.length,
    humanActions: outcome.humanActions,
    notes: outcome.notes,
  });

  return { resolved: true, ...outcome, screenshotPath };
}

async function pollFileResume(file: string, pollMs: number): Promise<{ notes: string; humanActions: any[]; durationMs: number }> {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`  (auto-resume armed: write {"done":true,"notes":"..."} to ${file})`);
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && parsed.done) return { notes: String(parsed.notes ?? 'resolved via file'), humanActions: parsed.humanActions ?? [], durationMs: Date.now() - started };
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, pollMs));
    if (Date.now() - started > 10 * 60_000) throw new Error('escalation timed out waiting for human');
  }
}
