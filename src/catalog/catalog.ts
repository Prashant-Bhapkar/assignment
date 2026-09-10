/**
 * Agent-facing capability catalog (stretch goal).
 *
 * Saved artifacts are exposed as a catalog of callable, typed capabilities. An
 * AI agent discovers them by name, sees typed args + typed return shape, and
 * invokes one — which runs deterministic replay under the hood.
 */
import type { CapabilityArtifact, OutputSpec, ParamSpec } from '../artifact/schema.js';
import { listArtifacts, loadArtifact, recordReplayOutcome } from '../artifact/store.js';
import { Run, newRunId } from '../observability/run.js';
import { PlaywrightSurface } from '../surface/web/playwright-surface.js';
import { bootstrapMockSession } from '../session/bootstrap.js';
import { replay } from '../replay/engine.js';
import type { ReplayResult } from '../replay/result.js';

export interface CapabilityToolDef {
  name: string;
  version: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; pattern?: string }>;
    required: string[];
  };
  returns: Record<string, { type: string; description: string }>;
  risk: string;
  approval: string;
  stability: { replays: number; successes: number };
}

function paramJson(p: ParamSpec) {
  return {
    type: p.type === 'enum' ? 'string' : p.type,
    description: p.description + (p.example ? ` (e.g. ${p.example})` : ''),
    ...(p.enumValues ? { enum: p.enumValues } : {}),
    ...(p.pattern ? { pattern: p.pattern } : {}),
  };
}
function outJson(o: OutputSpec) {
  return { type: o.type, description: o.description };
}

export function toToolDef(a: CapabilityArtifact): CapabilityToolDef {
  return {
    name: a.id,
    version: a.version,
    description: a.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(a.parameters.map((p) => [p.name, paramJson(p)])),
      required: a.parameters.filter((p) => p.required).map((p) => p.name),
    },
    returns: Object.fromEntries(a.outputs.map((o) => [o.name, outJson(o)])),
    risk: a.policy.riskLevel,
    approval: a.approval.state,
    stability: { replays: a.stability.replays, successes: a.stability.successes },
  };
}

export function buildCatalog(): CapabilityToolDef[] {
  return listArtifacts().map((row) => toToolDef(loadArtifact(row.id, row.version)));
}

export interface InvokeOptions {
  baseUrl: string;
  headless?: boolean;
  allowUnapproved?: boolean;
}

export async function invokeCapability(
  id: string,
  args: Record<string, string | number | boolean>,
  opts: InvokeOptions,
  version?: string,
): Promise<ReplayResult> {
  const artifact = loadArtifact(id, version);
  const run = new Run('replay', `${newRunId()}-catalog`);
  const { storageStatePath, reauthenticate } = await bootstrapMockSession(opts.baseUrl);
  const surface = new PlaywrightSurface({ headless: opts.headless ?? true, storageStatePath });

  try {
    const result = await replay({
      artifact,
      params: args,
      baseUrl: opts.baseUrl,
      surface,
      run,
      reauthenticate,
      allowUnapproved: opts.allowUnapproved,
    });
    run.writeResult(result);
    recordReplayOutcome(artifact.id, artifact.version, result.status === 'success');
    return result;
  } finally {
    await surface.close();
  }
}
