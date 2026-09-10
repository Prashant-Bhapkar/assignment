/**
 * Artifact store — filesystem-backed. Artifacts live at
 *   artifacts/<capabilityId>/<version>.json
 * plus a mutable pointer file `latest.json`. Simple on purpose; the access
 * pattern (write-once revisions, read-many) would map cleanly onto object
 * storage + a metadata table later.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityArtifact, parseArtifact } from './schema.js';

const ROOT = 'artifacts';

function dirFor(id: string): string {
  return join(ROOT, id.replace(/[^\w.-]/g, '_'));
}

export function saveArtifact(artifact: CapabilityArtifact): string {
  const parsed = parseArtifact(artifact);
  const dir = dirFor(parsed.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${parsed.version}.json`);
  writeFileSync(path, JSON.stringify(parsed, null, 2));
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ id: parsed.id, version: parsed.version, path: `${parsed.version}.json` }, null, 2));
  return path;
}

export function loadArtifact(id: string, version?: string): CapabilityArtifact {
  const dir = dirFor(id);
  if (!existsSync(dir)) throw new Error(`no artifact "${id}"`);
  let file: string;
  if (version) {
    file = join(dir, `${version}.json`);
  } else {
    const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as { path: string };
    file = join(dir, latest.path);
  }
  return parseArtifact(JSON.parse(readFileSync(file, 'utf8')));
}

export function loadArtifactByPath(path: string): CapabilityArtifact {
  return parseArtifact(JSON.parse(readFileSync(path, 'utf8')));
}

export function listArtifacts(): { id: string; version: string; title: string; approval: string; riskLevel: string }[] {
  if (!existsSync(ROOT)) return [];
  const out: ReturnType<typeof listArtifacts> = [];
  for (const d of readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const latestPath = join(ROOT, d.name, 'latest.json');
    if (!existsSync(latestPath)) continue;
    const { id, version } = JSON.parse(readFileSync(latestPath, 'utf8'));
    try {
      const a = loadArtifact(id, version);
      out.push({ id: a.id, version: a.version, title: a.title, approval: a.approval.state, riskLevel: a.policy.riskLevel });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function setApproval(id: string, version: string, state: 'draft' | 'approved' | 'deprecated', approvedBy: string): CapabilityArtifact {
  const a = loadArtifact(id, version);
  a.approval = { state, approvedBy: state === 'approved' ? approvedBy : null, approvedAt: state === 'approved' ? new Date().toISOString() : null };
  saveArtifact(a);
  return a;
}

export function recordReplayOutcome(id: string, version: string, success: boolean): void {
  try {
    const a = loadArtifact(id, version);
    a.stability.replays += 1;
    if (success) a.stability.successes += 1;
    a.stability.lastVerifiedAt = new Date().toISOString();
    saveArtifact(a);
  } catch {
    /* non-fatal */
  }
}
