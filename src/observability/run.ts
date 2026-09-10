/**
 * Run context: a directory per run holding the structured event log and richer
 * evidence (screenshots, DOM snapshots, observations). Every string written
 * through here is passed through the redactor first.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRedactor, Redactor } from '../safety/redaction.js';

export type RunKind = 'discovery' | 'replay';

export interface RunEvent {
  t: string; // ISO timestamp
  seq: number;
  level: 'info' | 'warn' | 'error';
  event: string; // machine key, e.g. "step.start", "guard.block", "checkpoint.pass"
  msg?: string;
  data?: Record<string, unknown>;
}

export class Run {
  readonly dir: string;
  private seq = 0;
  private events: RunEvent[] = [];

  constructor(
    readonly kind: RunKind,
    readonly id: string,
    baseDir = 'runs',
    readonly redactor: Redactor = defaultRedactor,
  ) {
    this.dir = join(baseDir, `${id}-${kind}`);
    mkdirSync(join(this.dir, 'screenshots'), { recursive: true });
    mkdirSync(join(this.dir, 'observations'), { recursive: true });
  }

  log(level: RunEvent['level'], event: string, msg?: string, data?: Record<string, unknown>): void {
    const redacted = this.redactor.redact({ msg, data });
    const e: RunEvent = {
      t: new Date().toISOString(),
      seq: this.seq++,
      level,
      event,
      msg: redacted.value.msg,
      data: redacted.value.data,
    };
    this.events.push(e);
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(e) + '\n');
    const tag = level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
    // eslint-disable-next-line no-console
    console.log(`  ${tag} [${event}] ${e.msg ?? ''}`);
  }

  info(event: string, msg?: string, data?: Record<string, unknown>) {
    this.log('info', event, msg, data);
  }
  warn(event: string, msg?: string, data?: Record<string, unknown>) {
    this.log('warn', event, msg, data);
  }
  error(event: string, msg?: string, data?: Record<string, unknown>) {
    this.log('error', event, msg, data);
  }

  screenshotPath(name: string): string {
    return join(this.dir, 'screenshots', `${String(this.seq).padStart(3, '0')}-${name}.png`);
  }

  writeObservation(name: string, obs: unknown): string {
    const p = join(this.dir, 'observations', `${name}.json`);
    writeFileSync(p, JSON.stringify(this.redactor.redact(obs).value, null, 2));
    return p;
  }

  writeFile(name: string, contents: string): string {
    const p = join(this.dir, name);
    writeFileSync(p, this.redactor.redactString(contents).value);
    return p;
  }

  writeResult(result: unknown): string {
    const p = join(this.dir, 'result.json');
    writeFileSync(p, JSON.stringify(this.redactor.redact(result).value, null, 2));
    return p;
  }

  allEvents(): RunEvent[] {
    return [...this.events];
  }
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export function evidenceDir(): string {
  const d = 'evidence';
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
