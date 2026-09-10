/**
 * RunTrace — the structured record the discovery loop produces.
 *
 * This is intentionally NOT the model transcript. It is the distilled sequence
 * of (observation → decision → action → outcome) that artifact synthesis
 * compiles into a CapabilityArtifact. The raw transcript is kept separately in
 * the run directory for debugging only.
 */
import type { Action } from '../artifact/schema.js';
import type { InteractableDescriptor } from '../surface/types.js';

export interface TraceStep {
  index: number;
  intent: string; // the model's stated reason for this step
  expectation?: string; // what the model expected to be true afterward
  action: Action;
  targetDescriptor?: InteractableDescriptor; // the element acted on (for locator synthesis)
  guard: { verdict: string; risk: string; reason: string };
  resolution?: { strategyKind: string; matchCount: number; attempts: number };
  result: { ok: boolean; error?: string; urlBefore: string; urlAfter: string };
  checkpoint?: { pass: boolean; detail: string };
  extracted?: { name: string; type: string; rawValue: string | null };
  screenshotPath?: string;
  observationRef?: string;
  humanIntervention?: { reason: string; actions: string[]; durationMs: number };
}

export interface RunTrace {
  runId: string;
  goal: string;
  params: Record<string, string>;
  target: { entryUrl: string; vendorProduct: string };
  model: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'success' | 'stuck' | 'failed' | 'escalated-unresolved';
  summary: string;
  steps: TraceStep[];
  outputs: Record<string, { type: string; value: string | null }>;
  stoppedReason?: string;
}
