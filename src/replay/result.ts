/**
 * Replay result contract.
 *
 * The single most important distinction (per the brief): an expected BUSINESS
 * OUTCOME ("no such member") is not a failure. Callers branch on `status`.
 */

export interface RecoveredCondition {
  handlerId: string;
  classify: 'recoverable';
  atStep: number;
  action: string;
  detail: string;
}

export interface CheckpointRecord {
  step: number;
  description: string;
  pass: boolean;
  detail: string;
}

export interface ReplayEvidence {
  runDir: string;
  screenshotPath?: string;
  domSnapshotPath?: string;
  url: string;
}

export type ReplayResult =
  | {
      status: 'success';
      artifactId: string;
      artifactVersion: string;
      outputs: Record<string, unknown>;
      checkpoints: CheckpointRecord[];
      recovered: RecoveredCondition[];
      stepsRun: number;
      durationMs: number;
    }
  | {
      status: 'business_outcome';
      artifactId: string;
      artifactVersion: string;
      outcomeCode: string;
      message: string;
      atStep: number;
      recovered: RecoveredCondition[];
      evidence: ReplayEvidence;
      durationMs: number;
    }
  | {
      status: 'failure';
      artifactId: string;
      artifactVersion: string;
      failureKind: 'input' | 'guard' | 'locator' | 'checkpoint' | 'timeout' | 'hard' | 'approval';
      atStep: number | null;
      stepIntent?: string;
      expected: string;
      observed: string;
      message: string;
      recovered: RecoveredCondition[];
      evidence: ReplayEvidence;
      durationMs: number;
    };

export function isSuccess(r: ReplayResult): r is Extract<ReplayResult, { status: 'success' }> {
  return r.status === 'success';
}
