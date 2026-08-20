import { MARKITDOWN_VERSION } from "@/lib/markitdown-shadow";
import { acquireImmutableSource, createShadowEnvelope, type ShadowObjectStore, type ShadowPublishInput, type ShadowPublisher } from "@/lib/document-shadow-stage1/contracts";
import type { Stage1Config } from "@/lib/document-shadow-stage1/config";

/** Durable provider publisher. Initial queue publication is always performed by the outbox dispatcher. */
export function createDurableShadowPublisher(options: {
  config: Stage1Config;
  store: ShadowObjectStore;
  lifecycle: { createQueuedWithOutbox(envelope: ReturnType<typeof createShadowEnvelope>, now: Date): Promise<unknown> };
  queue: { publish(envelope: ReturnType<typeof createShadowEnvelope>): Promise<unknown> };
  tenantSalt: string;
  converterVersion?: string;
  random?: () => number;
  now?: () => Date;
}): ShadowPublisher {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async publish(input: ShadowPublishInput) {
      if (!options.config.publisherEnabled || options.config.killSwitch) return { status: "disabled" as const };
      if (random() >= options.config.sampleRate) return { status: "not_sampled" as const };
      const acquired = acquireImmutableSource({ ...input, tenantSalt: options.tenantSalt, now: now(), retentionMs: options.config.retentionMs });
      const persisted = await options.store.putImmutable(acquired.pointer, acquired.bytes);
      const envelope = createShadowEnvelope({ pointer: persisted ?? acquired.pointer, fileClass: input.fileClass,
        converterVersion: options.converterVersion ?? MARKITDOWN_VERSION });
      await options.lifecycle.createQueuedWithOutbox(envelope, now());
      // Deliberately do not call queue.publish here. The dispatcher owns the send
      // so a crash after the lifecycle commit remains recoverable.
      return { status: "published" as const, envelope };
    },
  });
}
