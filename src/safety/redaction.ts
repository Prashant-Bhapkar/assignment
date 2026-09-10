/**
 * Redaction for regulated financial data.
 *
 * Nothing sensitive should ever land in an artifact, a log line, or an evidence
 * file. Two layers:
 *   1. Pattern-based scrubbing of well-known secret/PII shapes (defence in depth).
 *   2. Value-based scrubbing: callers register exact values that are known-secret
 *      (a typed `secret` action's text, a param whose sensitivity != "none", a
 *      pasted credential) and every occurrence is masked everywhere.
 */

export interface RedactionResult<T> {
  value: T;
  applied: string[]; // categories that fired — recorded in provenance, never the values
}

const PATTERNS: { name: string; re: RegExp; replace: string }[] = [
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: '«redacted:api_key»' },
  { name: 'openai_key', re: /sk-[A-Za-z0-9]{20,}/g, replace: '«redacted:api_key»' },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g, replace: 'Bearer «redacted:token»' },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: '«redacted:ssn»' },
  { name: 'pan', re: /\b(?:\d[ -]?){13,19}\b/g, replace: '«redacted:card»' },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '«redacted:email»' },
];

export class Redactor {
  private literals = new Map<string, string>(); // exact value -> mask

  /** Register a value that must never appear in output (e.g. a password). */
  addSecret(value: string, label = 'secret'): void {
    if (value && value.length >= 3) this.literals.set(value, `«redacted:${label}»`);
  }

  redactString(input: string): RedactionResult<string> {
    let out = input;
    const applied = new Set<string>();
    for (const [lit, mask] of this.literals) {
      if (out.includes(lit)) {
        out = out.split(lit).join(mask);
        applied.add('registered_secret');
      }
    }
    for (const p of PATTERNS) {
      if (p.re.test(out)) {
        out = out.replace(p.re, p.replace);
        applied.add(p.name);
      }
      p.re.lastIndex = 0;
    }
    return { value: out, applied: [...applied] };
  }

  redact<T>(input: T): RedactionResult<T> {
    const applied = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = this.redactString(v);
        r.applied.forEach((a) => applied.add(a));
        return r.value;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
      }
      return v;
    };
    return { value: walk(input) as T, applied: [...applied] };
  }
}

export const defaultRedactor = new Redactor();
