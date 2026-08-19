export interface Stage1Config {
  publisherEnabled: boolean;
  workerEnabled: boolean;
  sampleRate: number;
  killSwitch: boolean;
  retentionMs: number;
  leaseMs: number;
  workerTimeoutMs: number;
  maxAttempts: number;
}

function enabled(value: string | undefined): boolean {
  return value === "true";
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function loadStage1Config(environment: Record<string, string | undefined> = process.env): Stage1Config {
  return Object.freeze({
    publisherEnabled: enabled(environment.DOCUMENT_SHADOW_STAGE1_PUBLISHER_ENABLED),
    workerEnabled: enabled(environment.DOCUMENT_SHADOW_STAGE1_WORKER_ENABLED),
    sampleRate: boundedNumber(environment.DOCUMENT_SHADOW_STAGE1_SAMPLE_RATE, 0, 0, 1),
    killSwitch: environment.DOCUMENT_SHADOW_STAGE1_KILL_SWITCH !== "false",
    retentionMs: boundedNumber(environment.DOCUMENT_SHADOW_STAGE1_RETENTION_MS, 86_400_000, 60_000, 604_800_000),
    leaseMs: boundedNumber(environment.DOCUMENT_SHADOW_STAGE1_LEASE_MS, 60_000, 1_000, 600_000),
    workerTimeoutMs: boundedNumber(environment.DOCUMENT_SHADOW_STAGE1_WORKER_TIMEOUT_MS, 60_000, 1_000, 300_000),
    maxAttempts: Math.trunc(boundedNumber(environment.DOCUMENT_SHADOW_STAGE1_MAX_ATTEMPTS, 3, 1, 10)),
  });
}
