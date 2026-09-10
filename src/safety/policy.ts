/**
 * Safety & policy guardrails.
 *
 * The guard sits in front of EVERY action, in both discovery and replay:
 *   - allowlist: navigation and actions are refused outside permitted URL patterns
 *     and permitted action kinds.
 *   - risk classification: each action is tagged read_only / reversible /
 *     irreversible. Irreversible actions are handled conservatively — blocked,
 *     or gated on explicit confirmation (human in discovery, policy flag / prior
 *     approval in replay).
 */
import type { Action } from '../artifact/schema.js';

export type RiskClass = 'read_only' | 'reversible' | 'irreversible';
export type GuardDecision = { verdict: 'allow' | 'block' | 'confirm'; risk: RiskClass; reason: string };

export interface AllowlistConfig {
  /** Regex strings. A URL must match at least one to be navigable / actionable. */
  allowedUrlPatterns: string[];
  allowedActionKinds: Action['kind'][];
  /** Text/keyword rules that force a higher risk class regardless of action kind. */
  irreversibleKeywords: string[];
  reversibleKeywords: string[];
  /** How to treat irreversible actions when not pre-approved. */
  irreversibleMode: 'block' | 'confirm';
}

export const DEFAULT_ALLOWLIST: AllowlistConfig = {
  allowedUrlPatterns: ['^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/'],
  allowedActionKinds: ['navigate', 'click', 'type', 'select', 'press', 'acknowledgeDialog', 'extract'],
  irreversibleKeywords: ['submit sub-account', 'confirm', 'approve', 'transfer', 'post transaction', 'delete', 'close account', 'wire'],
  reversibleKeywords: ['continue to review', 'search', 'add', 'open sub-account', 'acknowledge'],
  irreversibleMode: 'confirm',
};

export interface ActionContext {
  action: Action;
  /** Human-readable description of the target (from TargetSelector.description or element name). */
  targetDescription?: string;
  /** Resolved URL for navigate actions, or current URL otherwise. */
  url: string;
}

export class Guard {
  constructor(private readonly cfg: AllowlistConfig = DEFAULT_ALLOWLIST) {}

  get config(): AllowlistConfig {
    return this.cfg;
  }

  urlAllowed(url: string): boolean {
    return this.cfg.allowedUrlPatterns.some((p) => new RegExp(p).test(url));
  }

  classify(ctx: ActionContext): RiskClass {
    const hay = `${ctx.action.kind} ${ctx.targetDescription ?? ''} ${'valueTemplate' in ctx.action ? '' : ''}`.toLowerCase();
    if (ctx.action.kind === 'extract' || ctx.action.kind === 'navigate' || ctx.action.kind === 'press') {
      // still check keywords — a "press Enter" that submits a wire could be irreversible
    }
    if (this.cfg.irreversibleKeywords.some((k) => hay.includes(k.toLowerCase()))) return 'irreversible';
    if (ctx.action.kind === 'extract') return 'read_only';
    if (ctx.action.kind === 'navigate') return 'read_only';
    if (this.cfg.reversibleKeywords.some((k) => hay.includes(k.toLowerCase()))) return 'reversible';
    if (ctx.action.kind === 'type' || ctx.action.kind === 'select') return 'reversible';
    if (ctx.action.kind === 'click') return 'reversible';
    return 'reversible';
  }

  check(ctx: ActionContext, opts: { preApproved?: boolean } = {}): GuardDecision {
    if (!this.cfg.allowedActionKinds.includes(ctx.action.kind)) {
      return { verdict: 'block', risk: 'read_only', reason: `action kind "${ctx.action.kind}" is not in the allowlist` };
    }
    if (!this.urlAllowed(ctx.url)) {
      return { verdict: 'block', risk: 'read_only', reason: `url "${ctx.url}" is outside the allowlist` };
    }
    const risk = this.classify(ctx);
    if (risk === 'irreversible' && !opts.preApproved) {
      return {
        verdict: this.cfg.irreversibleMode === 'block' ? 'block' : 'confirm',
        risk,
        reason: `action classified irreversible (target: ${ctx.targetDescription ?? 'n/a'})`,
      };
    }
    return { verdict: 'allow', risk, reason: 'within policy' };
  }
}
