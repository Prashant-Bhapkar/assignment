import type { CapabilityArtifact } from '../../src/artifact/schema.js';

/**
 * A hand-authored reference artifact for the "read a member's savings balance"
 * capability. Used by the integration tests. The discovery run produces its own
 * (see /evidence); this one exists so replay/error-handling can be tested
 * without spending model tokens, and doubles as a worked example of the schema.
 */
export function sampleBalanceArtifact(): CapabilityArtifact {
  return {
    schemaVersion: '1.0',
    id: 'meridian-core.member.read_savings_balance',
    version: '1.0.0',
    title: 'Read a member’s current savings balance',
    description:
      'Look up a member by ID and return the current balance of their primary Savings account. Read-only. Discovered against meridian-core.',
    labels: ['read-only', 'member-servicing'],
    binding: {
      surface: 'legacy-web',
      vendorProduct: 'meridian-core',
      appVersionRange: '>=4.0.0 <5.0.0',
      tenantId: null,
      baseCapabilityRef: null,
      entryPoint: { urlTemplate: '{{baseUrl}}/members/{{memberId}}', requiresAuthenticatedSession: true },
    },
    parameters: [
      {
        name: 'memberId',
        type: 'string',
        required: true,
        pattern: '^[0-9]{4,6}$',
        description: 'The institution member number to look up.',
        example: '12345',
        sensitivity: 'none',
      },
    ],
    outputs: [
      {
        name: 'savings_balance',
        type: 'money',
        description: 'Current balance of the member’s primary Savings account, as displayed (e.g. "$3,842.15").',
        required: true,
        sensitivity: 'none',
        producedByStep: 1,
      },
    ],
    preconditions: [
      { description: 'An authenticated operator session exists', assertion: { type: 'textAbsent', text: 'Operator Sign In' } },
    ],
    steps: [
      {
        index: 0,
        intent: 'Open the member detail screen for the requested member.',
        action: { kind: 'navigate', urlTemplate: '{{baseUrl}}/members/{{memberId}}' },
        waitFor: [],
        postCondition: { description: 'Member detail screen is shown', assertion: { type: 'textPresent', text: 'Account Summary' } },
        onError: [],
        timeoutMs: 15000,
        optional: false,
        riskClass: 'read_only',
      },
      {
        index: 1,
        intent: 'Read the Savings account balance from the account summary panel.',
        action: { kind: 'extract', into: 'savings_balance', attribute: 'text', transform: 'trim' },
        target: {
          description: 'the balance cell in the Savings account row of the account-summary table',
          frame: { kind: 'urlContains', value: 'summary' },
          strategies: [
            {
              kind: 'css',
              value: 'tr:has-text("Savings") td:nth-of-type(4)',
              elementHint: 'cell',
              rationale:
                'Row located by the stable account-type label "Savings", then the 4th cell (the balance column). Survives row reordering and value changes; breaks only if a column is inserted.',
              confidence: 0.62,
              brittle: false,
            },
            {
              kind: 'css',
              value: 'tr:has-text("Savings") td:last-child',
              elementHint: 'cell',
              rationale: 'Same row, last cell — resilient to a trailing column being added but not to the balance ceasing to be last.',
              confidence: 0.5,
              brittle: true,
            },
          ],
        },
        waitFor: [
          {
            description: 'account-summary table has loaded in the panel',
            assertion: { type: 'textPresent', text: 'Current Balance', frame: { kind: 'urlContains', value: 'summary' } },
          },
        ],
        postCondition: undefined,
        onError: [],
        timeoutMs: 10000,
        optional: false,
        riskClass: 'read_only',
      },
    ],
    successCondition: { description: 'A balance value was located on the account summary', assertion: { type: 'textPresent', text: 'Current Balance', frame: { kind: 'urlContains', value: 'summary' } } },
    errorHandlers: [
      {
        id: 'member-not-found-text',
        description: 'The member ID does not exist.',
        when: { kind: 'textPresent', text: 'No member exists' },
        classify: 'business_outcome',
        outcomeCode: 'MEMBER_NOT_FOUND',
        message: 'No member exists with the supplied ID.',
      },
      {
        id: 'member-not-found-404',
        description: 'Member lookup returned HTTP 404.',
        when: { kind: 'httpStatus', codes: [404] },
        classify: 'business_outcome',
        outcomeCode: 'MEMBER_NOT_FOUND',
        message: 'No member exists with the supplied ID.',
      },
      {
        id: 'permission-denied',
        description: 'Operator is not authorized for this member.',
        when: { kind: 'textPresent', text: 'do not have authorization' },
        classify: 'business_outcome',
        outcomeCode: 'PERMISSION_DENIED',
        message: 'The operator is not authorized to view this member.',
      },
      {
        id: 'permission-denied-403',
        description: 'Access returned HTTP 403.',
        when: { kind: 'httpStatus', codes: [403] },
        classify: 'business_outcome',
        outcomeCode: 'PERMISSION_DENIED',
        message: 'The operator is not authorized to view this member.',
      },
      {
        id: 'maintenance-interstitial',
        description: 'Unexpected "acknowledge to continue" maintenance notice.',
        when: { kind: 'textPresent', text: 'Maintenance Notice' },
        classify: 'recoverable',
        recovery: {
          kind: 'click',
          target: {
            description: 'the Acknowledge and Continue button on the maintenance notice',
            frame: { kind: 'main' },
            strategies: [
              { kind: 'role', role: 'button', name: 'Acknowledge and Continue', rationale: 'Interstitial confirm button by accessible name.', confidence: 0.9, brittle: false },
              { kind: 'text', name: 'Acknowledge', rationale: 'Partial visible-text fallback.', confidence: 0.6, brittle: true },
            ],
          },
        },
        message: 'Dismissed a maintenance interstitial and retried.',
      },
      {
        id: 'session-timeout-440',
        description: 'Server signalled the session has ended.',
        when: { kind: 'httpStatus', codes: [440] },
        classify: 'recoverable',
        recovery: { kind: 'reAuthenticate' },
        message: 'Session expired; re-authenticated and retried.',
      },
      {
        id: 'session-timeout-text',
        description: 'Session-ended page detected.',
        when: { kind: 'textPresent', text: 'session has' },
        classify: 'recoverable',
        recovery: { kind: 'reAuthenticate' },
        message: 'Session expired; re-authenticated and retried.',
      },
      {
        id: 'app-error-5xx',
        description: 'Application returned a 5xx error.',
        when: { kind: 'httpStatus', codes: [500, 502, 503] },
        classify: 'hard_failure',
        message: 'The application reported an internal error; the operation did not complete.',
      },
      {
        id: 'app-error-text',
        description: 'Application error page detected.',
        when: { kind: 'textPresent', text: 'unexpected error occurred' },
        classify: 'hard_failure',
        message: 'The application reported an internal error; the operation did not complete.',
      },
    ],
    policy: {
      allowedActionKinds: ['navigate', 'extract'],
      allowedUrlPatterns: ['^http://localhost:\\d+/', '^http://127\\.0\\.0\\.1:\\d+/'],
      riskLevel: 'read_only',
      requiresApprovalToRun: false,
      confirmationRequiredForSteps: [],
    },
    provenance: {
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'discovery-agent',
      model: 'hand-authored-fixture',
      discoveryRunId: 'fixture',
      sourceGoal: 'look up member 12345 and read their current savings balance',
      redactions: [],
      notes: 'Reference fixture; see /evidence for a model-discovered artifact.',
    },
    approval: { state: 'approved', approvedBy: 'fixture', approvedAt: '2026-01-01T00:00:00.000Z' },
    stability: { replays: 0, successes: 0, lastVerifiedAt: null },
  };
}
