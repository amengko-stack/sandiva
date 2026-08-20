import { MARKITDOWN_VERSION } from "@/lib/markitdown-shadow";
import {
  acquireImmutableSource,
  createShadowEnvelope,
  type ShadowObjectStore,
  type ShadowPublishInput,
  type ShadowPublisher,
  type ShadowQueue,
} from "@/lib/document-shadow-stage1/contracts";
import type { Stage1Config } from "@/lib/document-shadow-stage1/config";
import type { Stage1MetricEmitter } from "@/lib/document-shadow-stage1/metrics";

export function publishShadowDetached(
  publisher: ShadowPublisher,
  input: Parameters<ShadowPublisher["publish"]>[0],
  onFailure?: () => void,
): void {
  const immutableInput = { ...input, sourceBytes: Buffer.from(input.sourceBytes) };
  queueMicrotask(() => {
    void publisher.publish(immutableInput).catch(() => onFailure?.());
  });
}

export function createDisabledShadowPublisher(): ShadowPublisher {
  return Object.freeze({ async publish() { return { status: "disabled" as const }; } });
}

export function createShadowPublisher(options: {
  config: Stage1Config;
  store: ShadowObjectStore;
  queue: ShadowQueue;
  tenantSalt: string;
  converterVersion?: string;
  random?: () => number;
  now?: () => Date;
  emitMetric?: Stage1MetricEmitter;
}): ShadowPublisher {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async publish(input: ShadowPublishInput) {
      if (!options.config.publisherEnabled || options.config.killSwitch) return { status: "disabled" as const };
      if (random() >= options.config.sampleRate) {
        options.emitMetric?.({ type: "publish_skipped", occurredAt: now().toISOString(), fileClass: input.fileClass });
        return { status: "not_sampled" as const };
      }
      const acquired = acquireImmutableSource({
        ...input,
        tenantSalt: options.tenantSalt,
        now: now(),
        retentionMs: options.config.retentionMs,
      });
      const persistedPointer = await options.store.putImmutable(acquired.pointer, acquired.bytes);
      const envelope = createShadowEnvelope({
        pointer: persistedPointer ?? acquired.pointer,
        fileClass: input.fileClass,
        converterVersion: options.converterVersion ?? MARKITDOWN_VERSION,
      });
      await options.queue.publish(envelope);
      options.emitMetric?.({
        type: "published",
        occurredAt: now().toISOString(),
        correlationId: envelope.correlationId,
        tenantKey: envelope.pointer.tenantKey,
        fileClass: input.fileClass,
      });
      return { status: "published" as const, envelope };
    },
  });
}
