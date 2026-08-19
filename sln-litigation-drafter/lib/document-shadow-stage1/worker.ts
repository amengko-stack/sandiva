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
  const now = options.now ?? (() => new Date());
  const converter = createMarkItDownConverter();
  const observe = options.observe ?? (async (input: Stage1ObservationInput) => {
    await converter(input.sourceBytes, input.fileClass, input.signal);
  });

  return Object.freeze({
    async handle(envelope: ShadowEnvelope): Promise<void> {
      if (!options.enabled || options.killSwitch) {
        await options.queue.acknowledge?.(envelope);
        return;
      }
      const claim = await options.lifecycle.claim(envelope, options.workerId, now(), options.leaseMs);
      if (claim.status === "duplicate") {
        await options.queue.acknowledge?.(envelope);
        options.emitMetric?.({ type: "worker_duplicate", occurredAt: now().toISOString(), correlationId: envelope.correlationId });
        return;
      }

      const cancellation = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        if (!hasValidEnvelopeIntegrity(envelope)) throw new Error("pointer_mismatch");
        if (Date.parse(envelope.pointer.expiresAt) <= now().getTime()) throw new Error("pointer_mismatch");
        const bytes = Buffer.from(await options.store.resolveImmutable(envelope.pointer));
        const actualDigest = createHash("sha256").update(bytes).digest("hex");
        if (actualDigest !== envelope.pointer.contentSha256 || bytes.byteLength !== envelope.pointer.sizeBytes) {
          throw new Error("pointer_mismatch");
        }
        await Promise.race([
          observe({ sourceBytes: bytes, fileClass: envelope.fileClass, signal: cancellation.signal }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              cancellation.abort();
              reject(new Error("shadow_worker_timeout"));
            }, options.timeoutMs);
          }),
        ]);
        await options.lifecycle.complete(envelope, options.workerId);
        await options.queue.acknowledge?.(envelope);
        options.emitMetric?.({ type: "worker_completed", occurredAt: now().toISOString(), correlationId: envelope.correlationId, attempt: claim.attempt });
      } catch (error) {
        const result = await options.lifecycle.fail(envelope, options.workerId, now(), options.maxAttempts);
        if (result.status === "dead_letter") await options.queue.deadLetter?.(envelope);
        else await options.queue.retry?.(envelope);
        options.emitMetric?.({
          type: result.status === "dead_letter" ? "worker_dead_letter" : "worker_retry",
          occurredAt: now().toISOString(),
          correlationId: envelope.correlationId,
          attempt: result.attempt,
          errorCode: timedOut ? "timeout" : error instanceof Error && error.message === "pointer_mismatch" ? "pointer_mismatch" : "stage0_failure",
        });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  });
}
