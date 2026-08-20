import type { ShadowEnvelope } from "@/lib/document-shadow-stage1/contracts";

interface PendingAction { actionId: string; envelope: ShadowEnvelope; dueAt: Date | string; etag: string; tenantKey?: string; jobId?: string; }

export function createOutboxDispatcher(options: {
  lifecycle: {
    listPendingQueueActions(): Promise<PendingAction[]>;
    markQueueActionSent(input: { tenantKey: string; jobId: string; actionId: string; etag: string }): Promise<void>;
  };
  queue: { publishScheduled(envelope: ShadowEnvelope, dueAt: Date, actionId: string): Promise<void> };
}) {
  return Object.freeze({
    async runOnce(): Promise<number> {
      const actions = await options.lifecycle.listPendingQueueActions();
      for (const action of actions) {
        await options.queue.publishScheduled(action.envelope, new Date(action.dueAt), action.actionId);
        await options.lifecycle.markQueueActionSent({
          tenantKey: action.tenantKey ?? action.envelope.pointer.tenantKey,
          jobId: action.jobId ?? action.envelope.idempotencyKey,
          actionId: action.actionId,
          etag: action.etag,
        });
      }
      return actions.length;
    },
  });
}
