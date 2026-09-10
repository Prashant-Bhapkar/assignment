import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/safety/redaction.js';
import { Guard, DEFAULT_ALLOWLIST } from '../src/safety/policy.js';
import { descriptorToSelector, traceToArtifact } from '../src/artifact/synthesize.js';
import { parseArtifact } from '../src/artifact/schema.js';
import type { InteractableDescriptor } from '../src/surface/types.js';
import type { RunTrace } from '../src/agent/trace.js';

describe('redaction', () => {
  it('masks registered secrets and well-known PII shapes everywhere', () => {
    const r = new Redactor();
    r.addSecret('hunter2', 'password');
    const out = r.redact({
      note: 'login with hunter2',
      ssn: '123-45-6789',
      email: 'a.b@example.com',
      key: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123',
      nested: [{ pw: 'hunter2' }],
    });
    expect(JSON.stringify(out.value)).not.toContain('hunter2');
    expect(JSON.stringify(out.value)).not.toContain('123-45-6789');
    expect(JSON.stringify(out.value)).not.toContain('example.com');
    expect(out.applied).toContain('registered_secret');
    expect(out.applied).toContain('ssn');
  });
});

describe('guard', () => {
  const guard = new Guard({ ...DEFAULT_ALLOWLIST, allowedUrlPatterns: ['^http://localhost:\\d+/'] });

  it('blocks navigation outside the allowlist', () => {
    const d = guard.check({ action: { kind: 'navigate', urlTemplate: 'https://evil.example.com' }, url: 'https://evil.example.com' });
    expect(d.verdict).toBe('block');
  });

  it('classifies a "Submit Sub-Account" click as irreversible and asks for confirmation', () => {
    const d = guard.check({ action: { kind: 'click' }, url: 'http://localhost:4599/x', targetDescription: 'Submit Sub-Account button' });
    expect(d.risk).toBe('irreversible');
    expect(d.verdict).toBe('confirm');
  });

  it('allows a plain search click', () => {
    const d = guard.check({ action: { kind: 'click' }, url: 'http://localhost:4599/x', targetDescription: 'Search button' });
    expect(d.verdict).toBe('allow');
    expect(d.risk).toBe('reversible');
  });
});

describe('locator synthesis', () => {
  it('prefers role+name, records rationale, and keeps css as a flagged fallback', () => {
    const d: InteractableDescriptor = {
      ref: 'e1',
      kind: 'button',
      role: 'button',
      name: 'Search',
      frame: { kind: 'main' },
      attrs: { type: 'submit' },
      cssCandidates: ['input[type="submit"][value="Search"]', 'table > tr > td:nth-of-type(3) > input'],
    };
    const sel = descriptorToSelector(d);
    expect(sel.strategies[0]!.kind).toBe('role');
    expect(sel.strategies[0]!.confidence).toBeGreaterThan(0.8);
    expect(sel.strategies.every((s) => typeof s.rationale === 'string' && s.rationale.length > 0)).toBe(true);
    const structural = sel.strategies.find((s) => s.value?.includes('nth-of-type'));
    expect(structural?.brittle).toBe(true);
  });
});

describe('trace -> artifact', () => {
  const trace: RunTrace = {
    runId: 'r1',
    goal: 'look up member 12345 and read their current savings balance',
    params: { memberId: '12345' },
    target: { entryUrl: 'http://localhost:4599/dashboard', vendorProduct: 'meridian-core' },
    model: 'test',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
    outcome: 'success',
    summary: 'done',
    outputs: { savings_balance: { type: 'money', value: '$3,842.15' } },
    steps: [
      {
        index: 0,
        intent: 'Open member detail',
        expectation: 'the "Account Summary" panel is visible',
        action: { kind: 'type', valueTemplate: '12345', secret: false, pressEnter: true, clearFirst: true },
        targetDescriptor: {
          ref: 'e2',
          kind: 'textbox',
          role: 'textbox',
          name: '',
          label: 'Member ID or last name',
          frame: { kind: 'main' },
          attrs: { name: 'q' },
          cssCandidates: ['input[name="q"]'],
        },
        guard: { verdict: 'allow', risk: 'reversible', reason: 'ok' },
        result: { ok: true, urlBefore: 'x', urlAfter: 'y' },
      },
      {
        index: 1,
        intent: 'Read balance',
        action: { kind: 'extract', into: 'savings_balance', attribute: 'text', transform: 'trim' },
        targetDescriptor: {
          ref: 'r4',
          kind: 'cell',
          role: 'cell',
          name: '$3,842.15',
          text: '$3,842.15',
          frame: { kind: 'urlContains', value: 'summary' },
          attrs: {},
          cssCandidates: ['tr:nth-of-type(2) > td:nth-of-type(4)'],
          rowCells: ['SAV-0012345-01', 'Savings', 'Open', '$3,842.15'],
          colIndex: 3,
        },
        guard: { verdict: 'allow', risk: 'read_only', reason: 'ok' },
        result: { ok: true, urlBefore: 'y', urlAfter: 'y' },
        extracted: { name: 'savings_balance', type: 'money', rawValue: '$3,842.15' },
      },
    ],
  };

  it('produces a valid, parameterised, versioned artifact', () => {
    const artifact = traceToArtifact(trace, { capabilityId: 'meridian-core.member.read_savings_balance', vendorProduct: 'meridian-core', baseUrl: 'http://localhost:4599' });
    expect(() => parseArtifact(artifact)).not.toThrow();
    expect(artifact.parameters.map((p) => p.name)).toContain('memberId');
    // the literal "12345" should have been templatised out of the type step
    const typeStep = artifact.steps.find((s) => s.action.kind === 'type');
    expect((typeStep!.action as { valueTemplate: string }).valueTemplate).toBe('{{memberId}}');
    expect(artifact.outputs[0]!.name).toBe('savings_balance');
    expect(artifact.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(artifact.errorHandlers.length).toBeGreaterThan(3);
  });
});
