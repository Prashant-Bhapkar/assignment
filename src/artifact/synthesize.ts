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
export function descriptorToSelector(d: InteractableDescriptor, description?: string, paramValues: Record<string, string> = {}): TargetSelector {
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

  // A link whose href encodes an input parameter (e.g. "/members/12345" when
  // memberId="12345") generalizes across every invocation. This beats matching
  // the link's visible text, which is often the record's own data (a name, an
  // account number) and is specific to THIS run — the exact trap a naive
  // "click the search result" locator falls into.
  if (d.attrs.href) {
    const templatedHref = templatize(d.attrs.href, paramValues);
    if (templatedHref !== d.attrs.href) {
      strategies.push({
        kind: 'css',
        value: `a[href="${templatedHref}"]`,
        elementHint: 'link',
        rationale: `The link's href encodes the record id directly (was "${d.attrs.href}"); parameterising it generalizes to any input, unlike the link's visible text ("${truncate(d.text ?? d.name ?? '')}"), which is this record's own data and won't repeat on other invocations.`,
        confidence: 0.88,
        brittle: false,
      });
    }
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

function paramTypeGuess(name: string, value: string): ParamSpec['type'] {
  // Identifiers that happen to be numeric (member IDs, account numbers) must stay
  // strings — leading zeros and exact-match locators/URLs depend on it. Checked
  // as substrings (not \b-delimited words) so camelCase names like "memberId"
  // still match — there's no word boundary between "member" and "Id".
  const n = name.toLowerCase();
  if (n.endsWith('id') || n.includes('_id') || n.includes('number') || n.includes('code')) return 'string';
  return /^-?\d+(\.\d+)?$/.test(value) ? 'number' : 'string';
}

/**
 * Postcondition synthesis is deliberately NOT a guess at page wording.
 *
 * The model's free-text `expectation` ("Member search page loads with a search
 * input...") is not reliable page copy — grabbing its first few words as a
 * `textPresent` check produces a checkpoint that can never pass. Instead we use
 * two signals we can actually verify from the recorded run:
 *   1. did the step change the URL? -> assert the new path is reached.
 *   2. otherwise, what does the NEXT step need to be true? -> assert that
 *      target is visible. This is a real, checkable "did this step make
 *      progress" signal, not a paraphrase of a sentence.
 */
function checkpointFor(current: TraceStep, next: TraceStep | undefined, nextTarget: TargetSelector | undefined, params: Record<string, string>): Check | undefined {
  if (current.result.urlBefore !== current.result.urlAfter) {
    // Templatize the recorded path so a checkpoint on "/members/12345" reads as
    // "/members/{{memberId}}" and generalises to every invocation, not just this one.
    const path = templatize(pathOf(current.result.urlAfter), params);
    return { description: `URL is the ${path} page`, assertion: { type: 'urlContains', value: path } };
  }
  if (nextTarget) {
    return { description: `${nextTarget.description} is present (next step's target)`, assertion: { type: 'elementVisible', target: nextTarget } };
  }
  if (!next && current.action.kind === 'extract' && current.targetDescriptor) {
    // last step, nothing "next" to check against — re-assert the read succeeded.
    return undefined;
  }
  return undefined;
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
    id: 'record-not-found-search',
    description: 'A search-based flow found zero matching records.',
    when: { kind: 'textPresent', text: 'No members matched' },
    classify: 'business_outcome',
    outcomeCode: 'MEMBER_NOT_FOUND',
    message: 'No member matched the supplied search value.',
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

  // Pass 1: distill the successful trace steps into (trace step, action, target) tuples.
  const successful = trace.steps.filter((ts) => ts.result.ok || ts.humanIntervention);
  const tuples = successful.map((ts) => ({
    ts,
    action: adaptAction(ts.action, paramValues, usedParams),
    target: ts.targetDescriptor && ts.action.kind !== 'navigate' ? descriptorToSelector(ts.targetDescriptor, selectorDescription(ts), paramValues) : undefined,
  }));

  // Pass 2: wire each step's postCondition from what comes next (see checkpointFor).
  const steps: Step[] = tuples.map(({ ts, action, target }, i) => ({
    index: i,
    intent: ts.intent,
    action,
    target,
    waitFor: target ? [{ description: `${target.description} is present`, assertion: { type: 'elementVisible', target } }] : [],
    postCondition: checkpointFor(ts, tuples[i + 1]?.ts, tuples[i + 1]?.target, paramValues),
    onError: [],
    timeoutMs: 15000,
    optional: false,
    riskClass: (ts.guard.risk as Step['riskClass']) ?? 'read_only',
  }));

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
    type: paramTypeGuess(name, paramValues[name] ?? ''),
    required: true,
    description: `Input "${name}" supplied by the calling agent per invocation.`,
    example: paramValues[name],
    sensitivity: guessSensitivity(name),
  }));

  const lastTuple = tuples.at(-1);
  const producingTuple = tuples.find((t) => t.ts.extracted);
  const lastUrl = trace.steps.at(-1)?.result.urlAfter ?? opts.baseUrl;
  const successCondition: Check =
    outputs.length > 0 && producingTuple?.target
      ? { description: `${producingTuple.target.description} is present (the extracted data)`, assertion: { type: 'elementVisible', target: producingTuple.target } }
      : lastTuple?.target
        ? { description: `${lastTuple.target.description} is present`, assertion: { type: 'elementVisible', target: lastTuple.target } }
        : { description: `Reached ${templatize(pathOf(lastUrl), paramValues)}`, assertion: { type: 'urlContains', value: templatize(pathOf(lastUrl), paramValues) } };

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
