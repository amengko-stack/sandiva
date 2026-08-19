import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acquireImmutableSource,
  createShadowEnvelope,
  type ShadowEnvelope,
  type ShadowObjectStore,
  type ShadowQueue,
} from "@/lib/document-shadow-stage1/contracts";
import { loadStage1Config } from "@/lib/document-shadow-stage1/config";
import {
  createDisabledShadowPublisher,
  publishShadowDetached,
  createShadowPublisher,
} from "@/lib/document-shadow-stage1/publisher";
import { InMemoryShadowLifecycleStore } from "@/lib/document-shadow-stage1/lifecycle";
import { createShadowWorker, type Stage1ObservationInput } from "@/lib/document-shadow-stage1/worker";
import { runShadowWorkerOnce } from "@/workers/document-shadow-worker";
import deployment from "@/deploy/document-shadow-worker.disabled.json";

const tenantId = "tenant-a";
const sourceRevision = "rev-2026-08-19T10:00:00Z";
const sourceBytes = Buffer.from("immutable source bytes");
const digest = createHash("sha256").update(sourceBytes).digest("hex");

function pointer(overrides = {}) {
  return {
    version: 1 as const,
    tenantKey: "tenant-key-a",
    objectKey: "shadow/tenant-key-a/sha256/" + digest,
    sourceRevisionKey: "revision-key-a",
    contentSha256: digest,
    sizeBytes: sourceBytes.byteLength,
    createdAt: "2026-08-19T10:00:00.000Z",
    expiresAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

function envelope(overrides: Partial<ShadowEnvelope> = {}): ShadowEnvelope {
  return createShadowEnvelope({
    pointer: pointer(),
    fileClass: "txt",
    converterVersion: "0.1.7",
    correlationId: "correlation-safe",
    ...overrides,
  });
}

describe("Stage 1 immutable contracts", () => {
  it("copies acquired bytes and binds the pointer to the exact tenant revision and digest", () => {
    const original = Buffer.from(sourceBytes);
    const acquired = acquireImmutableSource({
      tenantId,
      sourceRevision,
      sourceBytes: original,
      tenantSalt: "test-salt",
      now: new Date("2026-08-19T10:00:00.000Z"),
      retentionMs: 86_400_000,
    });
    original.fill(0);

    expect(acquired.bytes.equals(sourceBytes)).toBe(true);
    expect(acquired.pointer).toMatchObject({
      contentSha256: digest,
      sizeBytes: sourceBytes.byteLength,
      createdAt: "2026-08-19T10:00:00.000Z",
      expiresAt: "2026-08-20T10:00:00.000Z",
    });
    expect(acquired.pointer.tenantKey).not.toContain(tenantId);
    expect(acquired.pointer.sourceRevisionKey).not.toContain(sourceRevision);
  });

  it("serializes a pointer-only queue envelope without bytes or source identifiers", () => {
    const message = envelope();
    const serialized = JSON.stringify(message);

    expect(message.idempotencyKey).toBe("tenant-key-a:revision-key-a:0.1.7");
    expect(serialized).not.toContain(sourceBytes.toString("utf8"));
    expect(serialized).not.toContain(tenantId);
    expect(serialized).not.toContain(sourceRevision);
    expect(Object.keys(message).sort()).toEqual([
      "converterVersion", "correlationId", "fileClass", "idempotencyKey", "pointer", "version",
    ]);
  });
});

describe("Stage 1 disabled publisher and configuration", () => {
  it("defaults to disabled with zero sampling and an engaged kill switch", () => {
    expect(loadStage1Config({})).toMatchObject({
      publisherEnabled: false,
      workerEnabled: false,
      sampleRate: 0,
      killSwitch: true,
    });
  });

  it("performs no storage or queue work when disabled or killed", async () => {
    const store = { putImmutable: vi.fn() };
    const queue = { publish: vi.fn() };
    const disabled = createDisabledShadowPublisher();
    const killed = createShadowPublisher({
      config: { ...loadStage1Config({}), publisherEnabled: true, sampleRate: 1, killSwitch: true },
      store: store as never,
      queue: queue as never,
      tenantSalt: "test-salt",
      random: () => 0,
    });
    const input = { tenantId, sourceRevision, sourceBytes, fileClass: "txt" as const };

    await expect(disabled.publish(input)).resolves.toEqual({ status: "disabled" });
    await expect(killed.publish(input)).resolves.toEqual({ status: "disabled" });
    expect(store.putImmutable).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it("stores immutable bytes before publishing only the pointer envelope", async () => {
    const store = { putImmutable: vi.fn(async () => undefined) };
    const queue = { publish: vi.fn(async () => undefined) };
    const metrics: unknown[] = [];
    const publisher = createShadowPublisher({
      config: { ...loadStage1Config({}), publisherEnabled: true, sampleRate: 1, killSwitch: false },
      store: store as never,
      queue: queue as never,
      tenantSalt: "test-salt",
      random: () => 0,
      emitMetric: (metric) => metrics.push(metric),
    });

    await expect(publisher.publish({ tenantId, sourceRevision, sourceBytes, fileClass: "txt" }))
      .resolves.toMatchObject({ status: "published" });
    expect(store.putImmutable).toHaveBeenCalledOnce();
    expect(queue.publish).toHaveBeenCalledOnce();
    expect(JSON.stringify(queue.publish.mock.calls[0])).not.toContain(sourceBytes.toString("utf8"));
    expect(JSON.stringify(metrics)).not.toContain(tenantId);
    expect(JSON.stringify(metrics)).not.toContain(sourceRevision);
  });

  it("detaches publication failures from the authoritative caller", async () => {
    let rejectPublish!: (error: Error) => void;
    const publisher = { publish: vi.fn(() => new Promise<never>((_resolve, reject) => { rejectPublish = reject; })) };
    const failures: unknown[] = [];

    expect(publishShadowDetached(publisher, {
      tenantId, sourceRevision, sourceBytes, fileClass: "txt",
    }, () => { failures.push("failed"); })).toBeUndefined();
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalledOnce());
    rejectPublish(new Error("queue unavailable"));
    await vi.waitFor(() => expect(failures).toHaveLength(1));
  });
});

describe("Stage 1 lifecycle", () => {
  it("suppresses duplicate delivery while permitting expired-lease recovery", async () => {
    const lifecycle = new InMemoryShadowLifecycleStore();
    const message = envelope();
    const first = await lifecycle.claim(message, "worker-a", new Date("2026-08-19T10:00:00Z"), 60_000);
    const duplicate = await lifecycle.claim(message, "worker-b", new Date("2026-08-19T10:00:30Z"), 60_000);
    const recovered = await lifecycle.claim(message, "worker-b", new Date("2026-08-19T10:01:01Z"), 60_000);

    expect(first.status).toBe("claimed");
    expect(duplicate.status).toBe("duplicate");
    expect(recovered).toMatchObject({ status: "claimed", attempt: 2 });
  });

  it("keeps identical revisions isolated by tenant key", async () => {
    const lifecycle = new InMemoryShadowLifecycleStore();
    const first = envelope();
    const second = envelope({ pointer: pointer({ tenantKey: "tenant-key-b" }) });

    await expect(lifecycle.claim(first, "worker", new Date(), 60_000)).resolves.toMatchObject({ status: "claimed" });
    await expect(lifecycle.claim(second, "worker", new Date(), 60_000)).resolves.toMatchObject({ status: "claimed" });
  });

  it("moves failures through retry and then dead-letter state", async () => {
    const lifecycle = new InMemoryShadowLifecycleStore();
    const message = envelope();
    const now = new Date("2026-08-19T10:00:00Z");
    await lifecycle.claim(message, "worker", now, 60_000);

    await expect(lifecycle.fail(message, "worker", now, 2)).resolves.toMatchObject({ status: "retry" });
    await lifecycle.claim(message, "worker", new Date("2026-08-19T10:01:01Z"), 60_000);
    await expect(lifecycle.fail(message, "worker", now, 2)).resolves.toMatchObject({ status: "dead_letter" });
  });

  it("renews only the current owner's active lease", async () => {
    const lifecycle = new InMemoryShadowLifecycleStore();
    const message = envelope();
    await lifecycle.claim(message, "worker-a", new Date("2026-08-19T10:00:00Z"), 60_000);

    await expect(lifecycle.renew(message, "worker-b", new Date("2026-08-19T10:00:30Z"), 60_000))
      .rejects.toThrow("shadow_lease_not_owned");
    await expect(lifecycle.renew(message, "worker-a", new Date("2026-08-19T10:00:30Z"), 60_000))
      .resolves.toBeUndefined();
    await expect(lifecycle.claim(message, "worker-b", new Date("2026-08-19T10:01:01Z"), 60_000))
      .resolves.toMatchObject({ status: "duplicate" });
  });
});

describe("Stage 1 worker containment", () => {
  function dependencies(options: { resolved?: Buffer; observe?: (input: Stage1ObservationInput) => Promise<void> } = {}) {
    const store: ShadowObjectStore = {
      putImmutable: vi.fn(async () => undefined),
      resolveImmutable: vi.fn(async () => options.resolved ?? Buffer.from(sourceBytes)),
    };
    const queue: ShadowQueue = {
      publish: vi.fn(async () => undefined),
      acknowledge: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      deadLetter: vi.fn(async () => undefined),
    };
    return { store, queue, observe: vi.fn(options.observe ?? (async () => undefined)) };
  }

  it("processes one exact pointer revision once and acknowledges duplicate delivery", async () => {
    const deps = dependencies();
    const worker = createShadowWorker({
      enabled: true, killSwitch: false, lifecycle: new InMemoryShadowLifecycleStore(),
      ...deps, workerId: "worker-a", timeoutMs: 1_000, leaseMs: 60_000, maxAttempts: 3,
    });
    const message = envelope();

    await worker.handle(message);
    await worker.handle(message);

    expect(deps.observe).toHaveBeenCalledOnce();
    expect(deps.queue.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched immutable content and retries without invoking Stage 0", async () => {
    const deps = dependencies({ resolved: Buffer.from("different revision bytes") });
    const worker = createShadowWorker({
      enabled: true, killSwitch: false, lifecycle: new InMemoryShadowLifecycleStore(),
      ...deps, workerId: "worker-a", timeoutMs: 1_000, leaseMs: 60_000, maxAttempts: 3,
    });

    await worker.handle(envelope());

    expect(deps.observe).not.toHaveBeenCalled();
    expect(deps.queue.retry).toHaveBeenCalledOnce();
  });

  it("rejects an expired pointer before resolving document bytes", async () => {
    const deps = dependencies();
    const worker = createShadowWorker({
      enabled: true, killSwitch: false, lifecycle: new InMemoryShadowLifecycleStore(),
      ...deps, workerId: "worker-a", timeoutMs: 1_000, leaseMs: 60_000, maxAttempts: 3,
      now: () => new Date("2026-08-20T10:00:00.001Z"),
    });

    await worker.handle(envelope());

    expect(deps.store.resolveImmutable).not.toHaveBeenCalled();
    expect(deps.queue.retry).toHaveBeenCalledOnce();
  });

  it("rejects a cross-tenant or revision-tampered envelope before pointer resolution", async () => {
    const deps = dependencies();
    const worker = createShadowWorker({
      enabled: true, killSwitch: false, lifecycle: new InMemoryShadowLifecycleStore(),
      ...deps, workerId: "worker-a", timeoutMs: 1_000, leaseMs: 60_000, maxAttempts: 3,
    });
    const tampered = { ...envelope(), pointer: pointer({ tenantKey: "tenant-key-b" }) };

    await worker.handle(tampered);

    expect(deps.store.resolveImmutable).not.toHaveBeenCalled();
    expect(deps.observe).not.toHaveBeenCalled();
    expect(deps.queue.retry).toHaveBeenCalledOnce();
  });

  it("acknowledges without resolving pointers when disabled by the kill switch", async () => {
    const deps = dependencies();
    const worker = createShadowWorker({
      enabled: true, killSwitch: true, lifecycle: new InMemoryShadowLifecycleStore(),
      ...deps, workerId: "worker-a", timeoutMs: 1_000, leaseMs: 60_000, maxAttempts: 3,
    });

    await worker.handle(envelope());

    expect(deps.store.resolveImmutable).not.toHaveBeenCalled();
    expect(deps.queue.acknowledge).toHaveBeenCalledOnce();
  });

  it("aborts timed-out Stage 0 work and schedules a retry", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const deps = dependencies({
        observe: ((input: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("cancelled"));
          }, { once: true });
        })) as never,
      });
      const worker = createShadowWorker({
        enabled: true, killSwitch: false, lifecycle: new InMemoryShadowLifecycleStore(),
        ...deps, workerId: "worker-a", timeoutMs: 10, leaseMs: 60_000, maxAttempts: 3,
      });
      const pending = worker.handle(envelope());
      await vi.advanceTimersByTimeAsync(10);
      await pending;

      expect(aborted).toBe(true);
      expect(deps.queue.retry).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters at the configured attempt limit", async () => {
    const deps = dependencies({ resolved: Buffer.from("wrong") });
    const lifecycle = new InMemoryShadowLifecycleStore();
    let clock = new Date("2026-08-19T10:00:00Z");
    const worker = createShadowWorker({
      enabled: true, killSwitch: false, lifecycle, ...deps,
      workerId: "worker-a", timeoutMs: 1_000, leaseMs: 60_000, maxAttempts: 2,
      now: () => clock,
    });
    const message = envelope();

    await worker.handle(message);
    clock = new Date("2026-08-19T10:01:01Z");
    await worker.handle(message);

    expect(deps.queue.retry).toHaveBeenCalledOnce();
    expect(deps.queue.deadLetter).toHaveBeenCalledOnce();
  });
});

describe("Stage 1 disabled deployment", () => {
  it("ships with no worker instances, no publisher, zero sampling, and the kill switch engaged", () => {
    expect(deployment).toMatchObject({
      activation: "disabled",
      instances: 0,
      environment: {
        DOCUMENT_SHADOW_STAGE1_PUBLISHER_ENABLED: "false",
        DOCUMENT_SHADOW_STAGE1_WORKER_ENABLED: "false",
        DOCUMENT_SHADOW_STAGE1_SAMPLE_RATE: "0",
        DOCUMENT_SHADOW_STAGE1_KILL_SWITCH: "true",
      },
    });
  });

  it("keeps the dedicated entrypoint inert under its default environment", async () => {
    const store: ShadowObjectStore = {
      putImmutable: vi.fn(async () => undefined),
      resolveImmutable: vi.fn(async () => sourceBytes),
    };
    const queue: ShadowQueue = {
      publish: vi.fn(async () => undefined),
      acknowledge: vi.fn(async () => undefined),
    };

    await runShadowWorkerOnce(envelope(), {
      environment: {}, store, queue, lifecycle: new InMemoryShadowLifecycleStore(), workerId: "disabled-worker",
    });

    expect(store.resolveImmutable).not.toHaveBeenCalled();
    expect(queue.acknowledge).toHaveBeenCalledOnce();
  });
});
