/**
 * Capability Artifact schema — the focal point of the system.
 *
 * A CapabilityArtifact is a typed, versioned, human- and agent-reviewable
 * description of a UI flow that has been proven once by the discovery agent and
 * can thereafter be replayed deterministically with no model in the loop.
 *
 * Design goals (see REPORT.md §2):
 *  1. Decoupled from the model transcript — this is a distilled flow, not chat logs.
 *  2. A real contract — typed input parameters and typed outputs, not just steps.
 *  3. Robust targeting — every target carries an ORDERED list of locator
 *     strategies with rationale/confidence, so replay degrades instead of breaking.
 *  4. Explicit checkpoints — per-step postconditions and one overall success
 *     condition, so we assert state instead of assuming clicks worked.
 *  5. An error taxonomy in the artifact itself — each foreseeable exceptional
 *     state is classified as business-outcome / recoverable / hard-failure.
 *  6. A surface seam — steps describe intent + a surface-agnostic TargetSelector;
 *     a per-surface adapter resolves it (web today, desktop/legacy later).
 *  7. Multi-tenant reuse — `binding` ties an artifact to a vendor product and
 *     optionally a tenant, and an artifact can specialize a base via overrides.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = '1.0' as const;

// ---------------------------------------------------------------------------
// Surface seam: how we point at a control without assuming a clean DOM.
// ---------------------------------------------------------------------------

export const FrameRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('urlContains'), value: z.string() }),
  z.object({ kind: z.literal('name'), value: z.string() }),
  z.object({ kind: z.literal('index'), value: z.number().int().nonnegative() }),
]);
export type FrameRef = z.infer<typeof FrameRef>;

/**
 * One way to find a control. Strategies are ordered most→least robust and tried
 * in sequence at replay time. `rationale` and `confidence` are recorded so a
 * human reviewer can judge the flow's durability without re-running it.
 */
export const LocatorStrategy = z.object({
  kind: z.enum([
    'role', // ARIA / accessibility role + accessible name — most portable, works on desktop too
    'label', // form control associated with visible label text
    'placeholder',
    'text', // visible text of the element itself (links, buttons)
    'nearText', // "the input immediately after the label 'Member ID'"
    'altText',
    'title',
    'testId', // data-testid — rare in legacy apps, highest confidence when present
    'css', // structural selector — brittle, flagged
    'xpath',
  ]),
  role: z.string().optional(),
  name: z.string().optional(), // accessible name / label / anchor text depending on kind
  exact: z.boolean().optional(),
  value: z.string().optional(), // selector string for css/xpath/testId
  elementHint: z.enum(['button', 'link', 'input', 'select', 'textarea', 'checkbox', 'radio', 'cell', 'any']).optional(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  brittle: z.boolean().default(false),
});
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const TargetSelector = z.object({
  description: z.string(), // human-readable: "the Search submit button in the member search form"
  frame: FrameRef.default({ kind: 'main' }),
  strategies: z.array(LocatorStrategy).min(1),
  disambiguation: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('first') }),
      z.object({ kind: z.literal('last') }),
      z.object({ kind: z.literal('nth'), index: z.number().int() }),
      z.object({ kind: z.literal('withText'), text: z.string() }),
    ])
    .optional(),
});
export type TargetSelector = z.infer<typeof TargetSelector>;

// ---------------------------------------------------------------------------
// Checkpoints / conditions
// ---------------------------------------------------------------------------

export const Check = z.object({
  description: z.string(),
  assertion: z.discriminatedUnion('type', [
    z.object({ type: z.literal('urlMatches'), pattern: z.string() }),
    z.object({ type: z.literal('urlContains'), value: z.string() }),
    z.object({ type: z.literal('textPresent'), text: z.string(), scope: TargetSelector.optional(), frame: FrameRef.optional() }),
    z.object({ type: z.literal('textAbsent'), text: z.string(), frame: FrameRef.optional() }),
    z.object({ type: z.literal('elementVisible'), target: TargetSelector }),
    z.object({ type: z.literal('elementCount'), target: TargetSelector, op: z.enum(['gte', 'eq', 'lte']), value: z.number().int() }),
  ]),
});
export type Check = z.infer<typeof Check>;

// ---------------------------------------------------------------------------
// Error taxonomy — carried in the artifact, evaluated during replay.
// ---------------------------------------------------------------------------

export const ErrorSignal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('textPresent'), text: z.string(), frame: FrameRef.optional() }),
  z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
  z.object({ kind: z.literal('httpStatus'), codes: z.array(z.number().int()) }),
  z.object({ kind: z.literal('elementVisible'), target: TargetSelector }),
  z.object({ kind: z.literal('checkpointTimeout') }), // expected postcondition never became true
]);
export type ErrorSignal = z.infer<typeof ErrorSignal>;

export const RecoveryAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), target: TargetSelector }), // dismiss a known interstitial
  z.object({ kind: z.literal('acknowledgeDialog'), accept: z.boolean() }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('waitRetry'), attempts: z.number().int().min(1).max(5), backoffMs: z.number().int() }),
  z.object({ kind: z.literal('reAuthenticate') }), // uses injected session bootstrap; escalates if unavailable
  z.object({ kind: z.literal('escalate') }),
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const ErrorHandler = z.object({
  id: z.string(),
  description: z.string(),
  when: ErrorSignal,
  /**
   * business_outcome: a legitimate result the caller must know about (not a crash).
   * recoverable:      the run can continue after `recovery`.
   * hard_failure:     stop, capture evidence, surface a debuggable error.
   */
  classify: z.enum(['business_outcome', 'recoverable', 'hard_failure']),
  outcomeCode: z.string().optional(), // required when classify === business_outcome, e.g. "MEMBER_NOT_FOUND"
  recovery: RecoveryAction.optional(), // required when classify === recoverable
  message: z.string().optional(),
});
export type ErrorHandler = z.infer<typeof ErrorHandler>;

// ---------------------------------------------------------------------------
// Steps & actions
// ---------------------------------------------------------------------------

export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), urlTemplate: z.string() }),
  z.object({ kind: z.literal('click') }),
  z.object({ kind: z.literal('type'), valueTemplate: z.string(), secret: z.boolean().default(false), pressEnter: z.boolean().default(false), clearFirst: z.boolean().default(true) }),
  z.object({ kind: z.literal('select'), valueTemplate: z.string() }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  z.object({ kind: z.literal('acknowledgeDialog'), accept: z.boolean().default(true) }),
  z.object({
    kind: z.literal('extract'),
    into: z.string(), // output name
    attribute: z.enum(['text', 'innerText', 'value', 'href']).default('text'),
    transform: z.enum(['none', 'trim', 'toNumber', 'moneyToCents', 'regex']).default('trim'),
    regex: z.object({ pattern: z.string(), group: z.number().int().default(0) }).optional(),
  }),
]);
export type Action = z.infer<typeof Action>;

export const Step = z.object({
  index: z.number().int().nonnegative(),
  intent: z.string(), // why this step exists, in plain language
  action: Action,
  target: TargetSelector.optional(), // required for click/type/select/press/extract
  waitFor: z.array(Check).default([]), // readiness gate before acting
  postCondition: Check.optional(), // checkpoint asserted after acting
  onError: z.array(ErrorHandler).default([]), // step-scoped, take precedence over capability-level
  timeoutMs: z.number().int().positive().default(15000),
  optional: z.boolean().default(false), // step may legitimately not apply on some runs
  riskClass: z.enum(['read_only', 'reversible', 'irreversible']).default('read_only'),
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Contract: typed parameters & outputs
// ---------------------------------------------------------------------------

export const ParamSpec = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  required: z.boolean().default(true),
  enumValues: z.array(z.string()).optional(),
  pattern: z.string().optional(), // regex the value must satisfy
  description: z.string(),
  example: z.string().optional(),
  sensitivity: z.enum(['none', 'pii', 'secret']).default('none'), // drives redaction in logs/evidence
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'money', 'boolean', 'date']),
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: z.enum(['none', 'pii', 'secret']).default('none'),
  // The producing step is referenced by index; extraction detail lives on that step's `extract` action.
  producedByStep: z.number().int().nonnegative(),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

// ---------------------------------------------------------------------------
// Binding: surface + vendor product + tenant + specialization
// ---------------------------------------------------------------------------

export const Binding = z.object({
  surface: z.enum(['web', 'legacy-web', 'desktop']),
  vendorProduct: z.string(), // e.g. "meridian-core" — the shared vendor app many tenants run
  appVersionRange: z.string().optional(), // semver range this artifact was validated against
  tenantId: z.string().nullable().default(null), // null => vendor-generic base capability
  baseCapabilityRef: z.object({ id: z.string(), version: z.string() }).nullable().default(null),
  entryPoint: z.object({
    urlTemplate: z.string(), // may contain {{param}} and a {{baseUrl}} placeholder
    requiresAuthenticatedSession: z.boolean().default(true),
  }),
});
export type Binding = z.infer<typeof Binding>;

// ---------------------------------------------------------------------------
// Policy, provenance, approval, stability
// ---------------------------------------------------------------------------

export const Policy = z.object({
  allowedActionKinds: z.array(z.enum(['navigate', 'click', 'type', 'select', 'press', 'acknowledgeDialog', 'extract'])),
  allowedUrlPatterns: z.array(z.string()), // regexes; replay refuses to navigate/act outside these
  riskLevel: z.enum(['read_only', 'reversible', 'irreversible']),
  requiresApprovalToRun: z.boolean().default(false), // unattended replay gated on approval.state === "approved"
  confirmationRequiredForSteps: z.array(z.number().int()).default([]), // step indices needing human OK even in replay
});
export type Policy = z.infer<typeof Policy>;

export const Provenance = z.object({
  createdAt: z.string(), // ISO
  createdBy: z.literal('discovery-agent'),
  model: z.string(),
  discoveryRunId: z.string(),
  sourceGoal: z.string(),
  redactions: z.array(z.string()).default([]), // WHAT was redacted (field names / patterns), never values
  notes: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Approval = z.object({
  state: z.enum(['draft', 'approved', 'deprecated']).default('draft'),
  approvedBy: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
});
export type Approval = z.infer<typeof Approval>;

export const Stability = z.object({
  replays: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  lastVerifiedAt: z.string().nullable().default(null),
});
export type Stability = z.infer<typeof Stability>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const CapabilityArtifact = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(), // stable capability id, e.g. "meridian-core.member.lookup_savings_balance"
  version: z.string(), // semver of THIS revision of the artifact
  title: z.string(),
  description: z.string(), // what the capability does — read by humans and calling agents
  labels: z.array(z.string()).default([]),

  binding: Binding,
  parameters: z.array(ParamSpec),
  outputs: z.array(OutputSpec),

  preconditions: z.array(Check).default([]),
  steps: z.array(Step).min(1),
  successCondition: Check,

  errorHandlers: z.array(ErrorHandler).default([]), // capability-level; step-level ones win

  policy: Policy,
  provenance: Provenance,
  approval: Approval.default({ state: 'draft', approvedBy: null, approvedAt: null }),
  stability: Stability.default({ replays: 0, successes: 0, lastVerifiedAt: null }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

export function parseArtifact(json: unknown): CapabilityArtifact {
  return CapabilityArtifact.parse(json);
}
