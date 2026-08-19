import { createHash } from "node:crypto";
import { createMarkItDownConverter } from "@/lib/markitdown-shadow";
import type {
  ShadowEnvelope,
  ShadowObjectStore,
  ShadowQueue,
} from "@/lib/document-shadow-stage1/contracts";
import type { ShadowLifecycleStore } from "@/lib/document-shadow-stage1/lifecycle";
import type { Stage1MetricEmitter } from "@/lib/document-shadow-stage1/metrics";

export interface Stage1ObservationInput {
  sourceBytes: Buffer;
  fileClass: "docx" | "txt";
  signal: AbortSignal;
}

type StopReason = "timeout" | "lease_lost" | "shutdown";

interface ActiveJob {
  cancellation: AbortController;
  reason: StopReason | null;
  stopped: Promise<never>;
  stop(reason: StopReason): void;
  done: Promise<void>;
}

function createActiveJob(): ActiveJob {
  let rejectStopped!: (error: Error) => void;
  const job: ActiveJob = {
    cancellation: new AbortController(),
    reason: null,
    stopped: new Promise<never>((_resolve, reject) => { rejectStopped = reject; }),
    stop(reason) {
      if (job.reason) {
        if (reason === "lease_lost" || (reason === "shutdown" && job.reason !== "lease_lost")) {
          job.reason = reason;
        }
        return;
      }
      job.reason = reason;
      job.cancellation.abort();
      rejectStopped(new Error(`shadow_worker_${reason}`));
    },
    done: Promise.resolve(),
  };
  // A shutdown may stop a job while it is still claiming or resolving bytes,
  // before the stop promise is passed to Promise.race(). Mark it handled now.
  void job.stopped.catch(() => undefined);
  return job;
}

function hasValidEnvelopeIntegrity(envelope: ShadowEnvelope): boolean {
  const expectedIdempotencyKey = `${envelope.pointer.tenantKey}:${envelope.pointer.sourceRevisionKey}:${envelope.converterVersion}`;
  const expectedObjectKey = `shadow/${envelope.pointer.tenantKey}/sha256/${envelope.pointer.contentSha256}`;
  return envelope.version === 1
    && envelope.pointer.version === 1
    && envelope.idempotencyKey === expectedIdempotencyKey
    && envelope.pointer.objectKey === expectedObjectKey;
}

export function createShadowWorker(options: {
  enabled: boolean;
  killSwitch: boolean;
  lifecycle: ShadowLifecycleStore;
  store: ShadowObjectStore;
  queue: ShadowQueue;
  observe?: (input: Stage1ObservationInput) => Promise<void>;
  workerId: string;
  timeoutMs: number;
  leaseMs: number;
  maxAttempts: number;
  now?: () => Date;
  emitMetric?: Stage1MetricEmitter;
}) {
  if (options.leaseMs <= 1) throw new Error("shadow_lease_duration_invalid");
  const now = options.now ?? (() => new Date());
  const converter = createMarkItDownConverter();
  const observe = options.observe ?? (async (input: Stage1ObservationInput) => {
    await converter(input.sourceBytes, input.fileClass, input.signal);
  });

  let shuttingDown = false;
  const activeJobs = new Set<ActiveJob>();

  async function process(envelope: ShadowEnvelope, job: ActiveJob): Promise<void> {
    if (!options.enabled || options.killSwitch) {
      await options.queue.acknowledge?.(envelope);
      return;
    }
    if (shuttingDown) return;

    const claim = await options.lifecycle.claim(envelope, options.workerId, now(), options.leaseMs);
    if (claim.status === "duplicate") {
      await options.queue.acknowledge?.(envelope);
      options.emitMetric?.({ type: "worker_duplicate", occurredAt: now().toISOString(), correlationId: envelope.correlationId });
      return;
    }
    if (job.reason === "shutdown") return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalInFlight: Promise<void> | undefined;
    let heartbeatStopped = false;
    let observation: Promise<void> | undefined;
    const renewalCadenceMs = Math.max(1, Math.floor(options.leaseMs / 3));

    const scheduleRenewal = () => {
      if (heartbeatStopped || job.reason === "lease_lost" || job.reason === "shutdown") return;
      renewalTimer = setTimeout(() => {
        renewalInFlight = options.lifecycle
          .renew(envelope, options.workerId, now(), options.leaseMs)
          .catch(() => { job.stop("lease_lost"); })
          .finally(() => {
            renewalInFlight = undefined;
            scheduleRenewal();
          });
      }, renewalCadenceMs);
    };

    const stopHeartbeat = async () => {
      heartbeatStopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      await renewalInFlight?.catch(() => undefined);
    };

    try {
      if (!hasValidEnvelopeIntegrity(envelope)) throw new Error("pointer_mismatch");
      if (Date.parse(envelope.pointer.expiresAt) <= now().getTime()) throw new Error("pointer_mismatch");
      const bytes = Buffer.from(await options.store.resolveImmutable(envelope.pointer));
      if (job.reason) throw new Error(`shadow_worker_${job.reason}`);
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== envelope.pointer.contentSha256 || bytes.byteLength !== envelope.pointer.sizeBytes) {
        throw new Error("pointer_mismatch");
      }

      observation = Promise.resolve().then(() => observe({
        sourceBytes: bytes,
        fileClass: envelope.fileClass,
        signal: job.cancellation.signal,
      }));
      scheduleRenewal();
      timeout = setTimeout(() => { job.stop("timeout"); }, options.timeoutMs);

      await Promise.race([observation, job.stopped]);
      await stopHeartbeat();
      if (job.reason) throw new Error(`shadow_worker_${job.reason}`);

      await options.lifecycle.complete(envelope, options.workerId);
      await options.queue.acknowledge?.(envelope);
      options.emitMetric?.({ type: "worker_completed", occurredAt: now().toISOString(), correlationId: envelope.correlationId, attempt: claim.attempt });
    } catch (error) {
      if (!job.reason) job.cancellation.abort();
      let stopReason = job.reason as StopReason | null;
      if (stopReason === "lease_lost" || stopReason === "shutdown") {
        await stopHeartbeat();
        await observation?.catch(() => undefined);
        return;
      }

      // For timeout and converter failure, retain the lease until the active
      // process has actually terminated. This prevents redelivery overlap.
      await observation?.catch(() => undefined);
      await stopHeartbeat();
      stopReason = job.reason as StopReason | null;
      if (stopReason === "lease_lost" || stopReason === "shutdown") return;

      let result: Awaited<ReturnType<ShadowLifecycleStore["fail"]>>;
      try {
        result = await options.lifecycle.fail(envelope, options.workerId, now(), options.maxAttempts);
      } catch {
        // Ownership disappeared between the last successful renewal and the
        // state transition. The old worker has already stopped and must not
        // enqueue competing retry/DLQ work.
        return;
      }
      if (result.status === "dead_letter") await options.queue.deadLetter?.(envelope);
      else await options.queue.retry?.(envelope);
      options.emitMetric?.({
        type: result.status === "dead_letter" ? "worker_dead_letter" : "worker_retry",
        occurredAt: now().toISOString(),
        correlationId: envelope.correlationId,
        attempt: result.attempt,
        errorCode: stopReason === "timeout"
          ? "timeout"
          : error instanceof Error && error.message === "pointer_mismatch"
            ? "pointer_mismatch"
            : "stage0_failure",
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      await stopHeartbeat();
    }
  }

  return Object.freeze({
    async handle(envelope: ShadowEnvelope): Promise<void> {
      const job = createActiveJob();
      job.done = process(envelope, job);
      activeJobs.add(job);
      try {
        await job.done;
      } finally {
        activeJobs.delete(job);
      }
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const job of Array.from(activeJobs)) job.stop("shutdown");
      await Promise.allSettled(Array.from(activeJobs, (job) => job.done));
    },
  });
}
