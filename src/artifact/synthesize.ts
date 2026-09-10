/**
 * Artifact synthesis: compile a RunTrace into a CapabilityArtifact.
 *
 * Deterministic. The model is NOT consulted here — structure comes from what
 * actually happened during discovery. (An optional `annotate` pass can ask the
 * model to improve human-readable descriptions; it never changes structure.)
 */
import type { RunTrace, TraceStep } from '../agent/trace.js';
import type { InteractableDescriptor } from '../surface/types.js';
import {
  type Action,
  type CapabilityArtifact,
  type Check,
  type ErrorHandler,
  type LocatorStrategy,
  type OutputSpec,
  type ParamSpec,
  type Step,
  type TargetSelector,
  SCHEMA_VERSION,
} from './schema.js';

/**
 * Turn a captured element descriptor into an ordered set of locator strategies,
 * most robust first. This is where "robustness reasoning" is encoded.
 */
export function descriptorToSelector(d: InteractableDescriptor, description?: string): TargetSelector {
  const strategies: LocatorStrategy[] = [];

  if (d.attrs.testId) {
    strategies.push({
      kind: 'testId',
      value: d.attrs.testId,
      elementHint: hint(d),
      rationale: 'Explicit test id — added by developers for automation; survives visual/layout change.',
      confidence: 0.98,
      brittle: false,
    });
  }

  const roleName = d.name || d.text || d.label;
  if (roleName && ['button', 'link', 'checkbox', 'radio'].includes(d.kind)) {
    strategies.push({
      kind: 'role',
      role: d.role,
      name: roleName,
      exact: false,
      elementHint: hint(d),
      rationale: `Accessibility role "${d.role}" + accessible name "${truncate(roleName)}". Portable across DOM refactors and has a desktop (UIA) analogue.`,
      confidence: 0.9,
      brittle: false,
    });
  }

  if (d.label && (d.kind === 'textbox' || d.kind === 'combobox')) {
    strategies.push({
      kind: 'label',
      name: d.label,
      elementHint: hint(d),
      rationale: `Form control associated with visible label "${truncate(d.label)}". Stable as long as the field's business meaning is unchanged.`,
      confidence: 0.82,
      brittle: false,
    });
    strategies.push({
      kind: 'nearText',
      name: d.label,
      elementHint: hint(d),
      rationale: 'Positional fallback: the first input following the label text. Covers legacy markup where the label is not programmatically associated.',
      confidence: 0.55,
      brittle: true,
    });
  }

  if (d.placeholder && d.kind === 'textbox') {
    strategies.push({
      kind: 'placeholder',
      name: d.placeholder,
      rationale: `Placeholder text "${truncate(d.placeholder)}".`,
      confidence: 0.6,
      brittle: false,
    });
  }

  if (d.kind === 'cell') {
    // Locate a data cell by a stable anchor word in its row, then column position.
    const anchor = (d.rowCells ?? []).find((c) => c && c !== d.text && /^[A-Za-z][A-Za-z /-]{1,24}$/.test(c));
    if (anchor && typeof d.colIndex === 'number') {
      strategies.push({
        kind: 'css',
        value: `tr:has-text(${JSON.stringify(anchor)}) td:nth-of-type(${d.colIndex + 1})`,
        elementHint: 'cell',
        rationale: `Row identified by the stable label "${anchor}" in it, then the ${ordinal(d.colIndex + 1)} cell. Survives row reordering and value changes; breaks only if a column is inserted.`,
        confidence: 0.62,
        brittle: false,
      });
    }
    if (d.label) {
      strategies.push({
        kind: 'nearText',
        name: d.label,
        elementHint: 'cell',
        rationale: `Value cell adjacent to the label "${truncate(d.label)}".`,
        confidence: 0.5,
        brittle: true,
      });
    }
  }

  if (d.text && d.kind === 'link') {
    strategies.push({
      kind: 'text',
      name: d.text,
      elementHint: 'link',
      rationale: `Visible link text "${truncate(d.text)}".`,
      confidence: 0.75,
      brittle: false,
    });
  }

  // CSS candidates as ordered fallbacks. name/id-based ones first, structural last.
  d.cssCandidates.forEach((css, i) => {
    const structural = css.includes('>') || css.includes(':nth-of-type');
    strategies.push({
      kind: 'css',
      value: css,
      elementHint: hint(d),
      rationale: structural
        ? 'Structural CSS path — last-resort fallback; will break if the surrounding markup is reorganised.'
        : `Attribute selector on ${css.startsWith('#') ? 'id' : 'name'} — reasonably stable if the attribute is not auto-generated.`,
      confidence: structural ? 0.25 : 0.7,
      brittle: structural,
    });
  });

  if (strategies.length === 0) {
    strategies.push({
      kind: 'css',
      value: d.cssCandidates[0] ?? '*',
      rationale: 'No stable signal available on this element; recorded for completeness.',
      confidence: 0.1,
      brittle: true,
    });
  }

  return {
    description: description ?? d.name ?? d.text ?? d.label ?? `${d.role} element`,
    frame: d.frame,
    strategies: dedupeStrategies(strategies),
  };
}

function hint(d: InteractableDescriptor): LocatorStrategy['elementHint'] {
  return d.kind === 'textbox' ? 'input' : d.kind === 'combobox' ? 'select' : d.kind === 'link' ? 'link' : d.kind === 'button' ? 'button' : 'any';
}
function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? 'th'}`;
}
function dedupeStrategies(list: LocatorStrategy[]): LocatorStrategy[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.kind}|${s.role ?? ''}|${s.name ?? ''}|${s.value ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Trace -> Artifact
// ---------------------------------------------------------------------------

function templatize(value: string, params: Record<string, string>): string {
  let out = value;
  for (const [k, v] of Object.entries(params)) {
    if (v && out === v) return `{{${k}}}`;
    if (v && out.includes(v)) out = out.split(v).join(`{{${k}}}`);
  }
  return out;
}

function paramTypeGuess(value: string): ParamSpec['type'] {
  return /^-?\d+(\.\d+)?$/.test(value) ? 'number' : 'string';
}

function checkpointFromExpectation(step: TraceStep, urlAfter: string): Check | undefined {
  if (step.action.kind === 'navigate') {
    return { description: `URL is the ${pathOf(urlAfter)} page`, assertion: { type: 'urlContains', value: pathOf(urlAfter) } };
  }
  if (step.expectation) {
    // Prefer a distinctive phrase from the expectation as a text checkpoint.
    const phrase = step.expectation.replace(/["']/g, '').slice(0, 60);
    return { description: `Page reflects: "${phrase}"`, assertion: { type: 'textPresent', text: keyPhrase(step.expectation) } };
  }
  return undefined;
}

function keyPhrase(s: string): string {
  // crude: take the longest capitalised or quoted run, else first 4 words
  const q = s.match(/"([^"]+)"/)?.[1];
  if (q) return q;
  const words = s.split(/\s+/).slice(0, 4).join(' ');
  return words;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const STANDARD_ERROR_HANDLERS: ErrorHandler[] = [
  {
    id: 'record-not-found',
    description: 'The target record does not exist.',
    when: { kind: 'textPresent', text: 'No member exists' },
    classify: 'business_outcome',
    outcomeCode: 'MEMBER_NOT_FOUND',
    message: 'No member exists with the supplied ID.',
  },
  {
    id: 'record-not-found-status',
    description: 'Record lookup returned 404.',
    when: { kind: 'httpStatus', codes: [404] },
    classify: 'business_outcome',
    outcomeCode: 'MEMBER_NOT_FOUND',
  },
  {
    id: 'permission-denied',
    description: 'Operator lacks authorization for this record.',
    when: { kind: 'textPresent', text: 'do not have authorization' },
    classify: 'business_outcome',
    outcomeCode: 'PERMISSION_DENIED',
    message: 'The operator is not authorized to view this record.',
  },
  {
    id: 'permission-denied-status',
    description: 'Access returned 403.',
    when: { kind: 'httpStatus', codes: [403] },
    classify: 'business_outcome',
    outcomeCode: 'PERMISSION_DENIED',
  },
  {
    id: 'session-timeout',
    description: 'Session expired mid-run.',
    when: { kind: 'textPresent', text: 'session has' },
    classify: 'recoverable',
    recovery: { kind: 'reAuthenticate' },
    message: 'Session expired; re-authentication required.',
  },
  {
    id: 'session-timeout-status',
    description: 'Server signalled session end (440).',
    when: { kind: 'httpStatus', codes: [440] },
    classify: 'recoverable',
    recovery: { kind: 'reAuthenticate' },
  },
  {
    id: 'maintenance-interstitial',
    description: 'Unexpected acknowledge-to-continue notice.',
    when: { kind: 'textPresent', text: 'Maintenance Notice' },
    classify: 'recoverable',
    recovery: {
      kind: 'click',
      target: {
        description: 'the "Acknowledge and Continue" button on the maintenance notice',
        frame: { kind: 'main' },
        strategies: [
          { kind: 'role', role: 'button', name: 'Acknowledge and Continue', rationale: 'Interstitial confirm button by accessible name.', confidence: 0.9, brittle: false },
          { kind: 'text', name: 'Acknowledge', rationale: 'Fallback on partial visible text.', confidence: 0.6, brittle: true },
        ],
      },
    },
  },
  {
    id: 'app-error',
    description: 'Server returned an unexpected application error.',
    when: { kind: 'textPresent', text: 'unexpected error occurred' },
    classify: 'hard_failure',
    message: 'The application reported an internal error; the operation did not complete.',
  },
  {
    id: 'app-error-status',
    description: '5xx from the application.',
    when: { kind: 'httpStatus', codes: [500, 502, 503] },
    classify: 'hard_failure',
  },
  {
    id: 'validation-error',
    description: 'Form validation rejected the input.',
    when: { kind: 'textPresent', text: 'cannot be negative' },
    classify: 'business_outcome',
    outcomeCode: 'VALIDATION_REJECTED',
    message: 'The application rejected the supplied field values.',
  },
];

export interface SynthesisOptions {
  capabilityId: string;
  version?: string;
  vendorProduct: string;
  baseUrl: string;
  outputDescriptions?: Record<string, string>;
}

export function traceToArtifact(trace: RunTrace, opts: SynthesisOptions): CapabilityArtifact {
  const paramValues = trace.params;
  const usedParams = new Set<string>();
  const steps: Step[] = [];

  for (const ts of trace.steps) {
    if (!ts.result.ok && !ts.humanIntervention) continue; // don't bake failed attempts into the flow
    const action: Action = adaptAction(ts.action, paramValues, usedParams);
    const target =
      ts.targetDescriptor && ts.action.kind !== 'navigate'
        ? descriptorToSelector(ts.targetDescriptor, selectorDescription(ts))
        : undefined;

    const step: Step = {
      index: steps.length,
      intent: ts.intent,
      action,
      target,
      waitFor: target ? [{ description: `${target.description} is present`, assertion: { type: 'elementVisible', target } }] : [],
      postCondition: checkpointFromExpectation(ts, ts.result.urlAfter),
      onError: [],
      timeoutMs: 15000,
      optional: false,
      riskClass: (ts.guard.risk as Step['riskClass']) ?? 'read_only',
    };
    steps.push(step);
  }

  const outputs: OutputSpec[] = Object.entries(trace.outputs).map(([name, o], i) => {
    const producing = trace.steps.find((s) => s.extracted?.name === name);
    return {
      name,
      type: (o.type as OutputSpec['type']) ?? 'string',
      description: opts.outputDescriptions?.[name] ?? `Extracted ${name}.`,
      required: true,
      sensitivity: 'none',
      producedByStep: producing ? clampStepIndex(steps, producing) : Math.max(0, steps.length - 1),
    };
  });

  const parameters: ParamSpec[] = [...usedParams].map((name) => ({
    name,
    type: paramTypeGuess(paramValues[name] ?? ''),
    required: true,
    description: `Input "${name}" supplied by the calling agent per invocation.`,
    example: paramValues[name],
    sensitivity: guessSensitivity(name),
  }));

  const lastUrl = trace.steps.at(-1)?.result.urlAfter ?? opts.baseUrl;
  const successCondition: Check =
    outputs.length > 0
      ? { description: 'Target data was located on the final screen', assertion: { type: 'textPresent', text: firstNonEmpty(trace) } }
      : { description: `Reached ${pathOf(lastUrl)}`, assertion: { type: 'urlContains', value: pathOf(lastUrl) } };

  const riskLevel = steps.some((s) => s.riskClass === 'irreversible')
    ? 'irreversible'
    : steps.some((s) => s.riskClass === 'reversible')
      ? 'reversible'
      : 'read_only';

  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.capabilityId,
    version: opts.version ?? '1.0.0',
    title: titleFromGoal(trace.goal),
    description: `${trace.goal.trim()} Discovered against ${opts.vendorProduct}.`,
    labels: deriveLabels(trace.goal),
    binding: {
      surface: 'legacy-web',
      vendorProduct: opts.vendorProduct,
      appVersionRange: undefined,
      tenantId: null,
      baseCapabilityRef: null,
      entryPoint: { urlTemplate: templatize(trace.target.entryUrl, paramValues).replace(opts.baseUrl, '{{baseUrl}}'), requiresAuthenticatedSession: true },
    },
    parameters,
    outputs,
    preconditions: [
      { description: 'An authenticated operator session exists', assertion: { type: 'textAbsent', text: 'Operator Sign In' } },
    ],
    steps,
    successCondition,
    errorHandlers: STANDARD_ERROR_HANDLERS,
    policy: {
      allowedActionKinds: [...new Set(steps.map((s) => s.action.kind))],
      allowedUrlPatterns: [`^${escapeRegex(opts.baseUrl)}`],
      riskLevel,
      requiresApprovalToRun: riskLevel === 'irreversible',
      confirmationRequiredForSteps: steps.filter((s) => s.riskClass === 'irreversible').map((s) => s.index),
    },
    provenance: {
      createdAt: new Date().toISOString(),
      createdBy: 'discovery-agent',
      model: trace.model,
      discoveryRunId: trace.runId,
      sourceGoal: trace.goal,
      redactions: [],
      notes: trace.summary,
    },
    approval: { state: 'draft', approvedBy: null, approvedAt: null },
    stability: { replays: 0, successes: 0, lastVerifiedAt: null },
  };
}

function adaptAction(a: Action, params: Record<string, string>, used: Set<string>): Action {
  if (a.kind === 'type') {
    const before = a.valueTemplate;
    const after = templatize(before, params);
    markUsed(before, after, params, used);
    return { ...a, valueTemplate: after };
  }
  if (a.kind === 'select') {
    const after = templatize(a.valueTemplate, params);
    markUsed(a.valueTemplate, after, params, used);
    return { ...a, valueTemplate: after };
  }
  if (a.kind === 'navigate') {
    return { ...a, urlTemplate: templatize(a.urlTemplate, params) };
  }
  return a;
}

function markUsed(before: string, after: string, params: Record<string, string>, used: Set<string>) {
  for (const [k, v] of Object.entries(params)) {
    if (v && before.includes(v) && after.includes(`{{${k}}}`)) used.add(k);
  }
}

function selectorDescription(ts: TraceStep): string {
  const d = ts.targetDescriptor!;
  const what = d.name || d.label || d.text || `${d.role}`;
  return `${what} (${d.kind})`;
}

function clampStepIndex(steps: Step[], producing: TraceStep): number {
  return Math.min(steps.length - 1, Math.max(0, producing.index));
}

function guessSensitivity(name: string): ParamSpec['sensitivity'] {
  const n = name.toLowerCase();
  if (n.includes('password') || n.includes('secret') || n.includes('token') || n.includes('pin')) return 'secret';
  if (n.includes('ssn') || n.includes('dob') || n.includes('taxid')) return 'pii';
  return 'none';
}

function firstNonEmpty(trace: RunTrace): string {
  for (const s of trace.steps) if (s.extracted?.rawValue) return String(s.extracted.rawValue).slice(0, 40);
  return trace.steps.at(-1)?.expectation?.slice(0, 40) ?? 'confirmation';
}

function titleFromGoal(goal: string): string {
  const g = goal.trim().replace(/[.]$/, '');
  return g.charAt(0).toUpperCase() + g.slice(1, 70);
}

function deriveLabels(goal: string): string[] {
  const l: string[] = [];
  const g = goal.toLowerCase();
  if (g.includes('balance') || g.includes('look up') || g.includes('read')) l.push('read-only');
  if (g.includes('open') || g.includes('create') || g.includes('sub-account')) l.push('write');
  if (g.includes('member')) l.push('member-servicing');
  return l;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
