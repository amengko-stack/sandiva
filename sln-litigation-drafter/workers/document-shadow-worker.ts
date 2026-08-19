import type {
  ShadowEnvelope,
  ShadowObjectStore,
  ShadowQueue,
} from "@/lib/document-shadow-stage1/contracts";
import { loadStage1Config } from "@/lib/document-shadow-stage1/config";
import type { ShadowLifecycleStore } from "@/lib/document-shadow-stage1/lifecycle";
import type { Stage1MetricEmitter } from "@/lib/document-shadow-stage1/metrics";
import { createShadowWorker } from "@/lib/document-shadow-stage1/worker";

/**
 * Provider-neutral worker entrypoint. Deployment wiring must supply durable
 * object, queue, and lifecycle adapters; none are created or activated here.
 */
export async function runShadowWorkerOnce(envelope: ShadowEnvelope, dependencies: {
  environment?: Record<string, string | undefined>;
  store: ShadowObjectStore;
  queue: ShadowQueue;
  lifecycle: ShadowLifecycleStore;
  workerId: string;
  emitMetric?: Stage1MetricEmitter;
}): Promise<void> {
  const config = loadStage1Config(dependencies.environment);
  const worker = createShadowWorker({
    enabled: config.workerEnabled,
    killSwitch: config.killSwitch,
    store: dependencies.store,
    queue: dependencies.queue,
    lifecycle: dependencies.lifecycle,
    workerId: dependencies.workerId,
    timeoutMs: config.workerTimeoutMs,
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    emitMetric: dependencies.emitMetric,
  });
  await worker.handle(envelope);
}
