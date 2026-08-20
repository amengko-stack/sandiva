import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AzureBlobShadowObjectStore } from "@/lib/document-shadow-stage1/azure/blob";
import { AzureCosmosLifecycleStore } from "@/lib/document-shadow-stage1/azure/cosmos";
import { AzureServiceBusShadowQueue } from "@/lib/document-shadow-stage1/azure/service-bus";
import { createOutboxDispatcher } from "@/lib/document-shadow-stage1/outbox-dispatcher";
import { loadAzureProviderConfig, selectStage1Providers } from "@/lib/document-shadow-stage1/provider-factory";
import { createPrivacySafeTelemetry } from "@/lib/document-shadow-stage1/telemetry";
import { createAzureProviderAdapters } from "@/lib/document-shadow-stage1/azure/sdk-provider";
import { createShadowEnvelope, type ShadowSourcePointer } from "@/lib/document-shadow-stage1/contracts";
import { createShadowPublisher } from "@/lib/document-shadow-stage1/publisher";
import { createDurableShadowPublisher } from "@/lib/document-shadow-stage1/durable-publisher";
import { loadStage1Config } from "@/lib/document-shadow-stage1/config";
import deployment from "@/deploy/document-shadow-azure.disabled.json";
import { runShadowOutboxOnce } from "@/workers/document-shadow-outbox";

const bytes = Buffer.from("synthetic immutable document");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function pointer(overrides: Partial<ShadowSourcePointer> = {}): ShadowSourcePointer {
  return {
    version: 1,
    tenantKey: "opaque-tenant-a",
    objectKey: `shadow/opaque-tenant-a/sha256/${sha256}`,
    sourceRevisionKey: "opaque-revision-a",
    contentSha256: sha256,
    sizeBytes: bytes.byteLength,
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-21T00:00:00.000Z",
    storageAccountAlias: "shadow-nonprod",
    container: "shadow-input",
    blobName: `opaque-tenant-a/${sha256}`,
    versionId: "2026-08-20T00:00:00.0000000Z",
    ...overrides,
  };
}

function envelope() {
  return createShadowEnvelope({
    pointer: pointer(),
    fileClass: "txt",
    converterVersion: "0.1.7",
    correlationId: "trace-safe",
  });
}

describe("Azure Service Bus adapter", () => {
  it("publishes a deterministic pointer-only message without sessions", async () => {
    const sendMessages = vi.fn(async (_message: unknown) => undefined);
    const queue = new AzureServiceBusShadowQueue({
      sender: { sendMessages, scheduleMessages: vi.fn() },
      receiver: {} as never,
    });

    await queue.publish(envelope());

    expect(sendMessages).toHaveBeenCalledWith(expect.objectContaining({
      messageId: createHash("sha256").update(envelope().idempotencyKey).digest("hex"),
      contentType: "application/vnd.sandiva.shadow-envelope+json;version=1",
    }));
    const sent = sendMessages.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(String(sent.messageId).length).toBeLessThanOrEqual(128);
    expect(sent).not.toHaveProperty("sessionId");
    expect(JSON.stringify(sent)).not.toContain(bytes.toString("utf8"));
  });

  it("rejects unknown schema versions and envelopes over 32 KiB before retrieval", async () => {
    const queue = new AzureServiceBusShadowQueue({ sender: {} as never, receiver: {} as never });
    expect(() => queue.decode({ body: { ...envelope(), version: 2 } })).toThrow("shadow_envelope_schema_unsupported");
    expect(() => queue.decode({ body: { ...envelope(), padding: "x".repeat(33 * 1024) } })).toThrow("shadow_envelope_too_large");
  });

  it("supports renew, complete, abandon, scheduled retry and native dead-letter", async () => {
    const receiver = {
      renewMessageLock: vi.fn(async () => new Date()),
      completeMessage: vi.fn(async () => undefined),
      abandonMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
    };
    const sender = { sendMessages: vi.fn(), scheduleMessages: vi.fn(async () => ["sequence-1"]) };
    const queue = new AzureServiceBusShadowQueue({ sender, receiver: receiver as never });
    const received = { body: envelope(), messageId: "message-1" } as never;

    await queue.renewReceived(received);
    await queue.completeReceived(received);
    await queue.abandonReceived(received);
    await queue.deadLetterReceived(received, "permanent_failure");
    await queue.publishScheduled(envelope(), new Date("2026-08-20T00:01:00Z"), "action-1");

    expect(receiver.renewMessageLock).toHaveBeenCalledOnce();
    expect(receiver.completeMessage).toHaveBeenCalledOnce();
    expect(receiver.abandonMessage).toHaveBeenCalledOnce();
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(received, expect.objectContaining({ deadLetterReason: "permanent_failure" }));
    expect(sender.scheduleMessages).toHaveBeenCalledWith(expect.objectContaining({
      messageId: createHash("sha256").update("action-1").digest("hex"),
    }), expect.any(Date));
  });

  it("settles the exact received delivery through the provider-neutral envelope contract", async () => {
    const received = { body: envelope(), messageId: "message-1" };
    const receiver = { completeMessage: vi.fn(async () => undefined) };
    const queue = new AzureServiceBusShadowQueue({ sender: {} as never, receiver: receiver as never });
    const decoded = queue.decode(received);
    await queue.acknowledge(decoded);
    expect(receiver.completeMessage).toHaveBeenCalledWith(received);
  });
});

describe("Azure Blob exact-version adapter", () => {
  function immutableBlobHarness() {
    let stored: { bytes: Buffer; metadata: Record<string, string>; versionId: string } | undefined;
    let versionSequence = 0;
    const blobNames: string[] = [];
    const uploadOptions: unknown[] = [];
    const requestedVersions: string[] = [];
    const getBlockBlobClient = vi.fn((name: string) => {
      blobNames.push(name);
      return {
        uploadData: async (value: Buffer, options: unknown) => {
          await Promise.resolve();
          if (stored) throw Object.assign(new Error("condition not met"), { statusCode: 412, code: "ConditionNotMet" });
          versionSequence += 1;
          const metadata = (options as { metadata: Record<string, string> }).metadata;
          uploadOptions.push(options);
          stored = { bytes: Buffer.from(value), metadata: { ...metadata }, versionId: `provider-version-${versionSequence}` };
          return { versionId: stored.versionId };
        },
        getProperties: async () => {
          if (!stored) throw Object.assign(new Error("not found"), { statusCode: 404, code: "BlobNotFound" });
          return { versionId: stored.versionId, metadata: { ...stored.metadata }, contentLength: stored.bytes.byteLength };
        },
        withVersion: (versionId: string) => ({
          downloadToBuffer: async () => {
            requestedVersions.push(versionId);
            if (!stored || versionId !== stored.versionId) throw new Error("version not found");
            return Buffer.from(stored.bytes);
          },
        }),
      };
    });
    return {
      containerClient: { getBlockBlobClient },
      blobNames,
      uploadOptions,
      requestedVersions,
    };
  }

  it("reads the exact version and verifies account, tenant, length and SHA-256", async () => {
    const downloadToBuffer = vi.fn(async () => Buffer.from(bytes));
    const withVersion = vi.fn(() => ({ downloadToBuffer }));
    const getBlobClient = vi.fn(() => ({ withVersion }));
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod",
      containerName: "shadow-input",
      containerClient: { getBlockBlobClient: getBlobClient } as never,
    });

    await expect(store.resolveImmutable(pointer())).resolves.toEqual(bytes);
    expect(withVersion).toHaveBeenCalledWith("2026-08-20T00:00:00.0000000Z");
    expect(downloadToBuffer).toHaveBeenCalledOnce();
  });

  it("returns the provider-issued immutable version pointer before publication", async () => {
    const uploadData = vi.fn(async () => ({ versionId: "provider-version-1" }));
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod", containerName: "shadow-input",
      containerClient: { getBlockBlobClient: () => ({ uploadData }) } as never,
    });
    const persisted = await store.putImmutable(pointer({ blobName: undefined, versionId: undefined }), bytes);
    expect(persisted).toMatchObject({ storageAccountAlias: "shadow-nonprod", container: "shadow-input", versionId: "provider-version-1" });
  });

  it("reuses the exact immutable version when identical bytes are published again", async () => {
    const harness = immutableBlobHarness();
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod", containerName: "shadow-input", containerClient: harness.containerClient,
    });
    const input = pointer({ blobName: undefined, versionId: undefined });

    const first = await store.putImmutable(input, bytes);
    const duplicate = await store.putImmutable(input, bytes);

    expect(duplicate).toEqual(first);
    expect(first.blobName).toBe("opaque-tenant-a/opaque-revision-a");
    expect(first.versionId).toBe("provider-version-1");
    expect(harness.requestedVersions).toEqual(["provider-version-1"]);
  });

  it("converges concurrent duplicate publishers on one exact immutable version", async () => {
    const harness = immutableBlobHarness();
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod", containerName: "shadow-input", containerClient: harness.containerClient,
    });
    const input = pointer({ blobName: undefined, versionId: undefined });

    const [first, duplicate] = await Promise.all([
      store.putImmutable(input, Buffer.from(bytes)),
      store.putImmutable(input, Buffer.from(bytes)),
    ]);

    expect(duplicate).toEqual(first);
    expect(first.versionId).toBe("provider-version-1");
  });

  it("fails closed when the same deterministic identity is republished with different content, hash and size", async () => {
    const harness = immutableBlobHarness();
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod", containerName: "shadow-input", containerClient: harness.containerClient,
    });
    const input = pointer({ blobName: undefined, versionId: undefined });
    await store.putImmutable(input, bytes);
    const changedBytes = Buffer.from("different synthetic immutable document");
    const changedSha256 = createHash("sha256").update(changedBytes).digest("hex");
    const changedPointer = {
      ...input,
      objectKey: `shadow/${input.tenantKey}/sha256/${changedSha256}`,
      contentSha256: changedSha256,
      sizeBytes: changedBytes.byteLength,
    };

    await expect(store.putImmutable(changedPointer, changedBytes)).rejects.toThrow("shadow_blob_existing_integrity_mismatch");
  });

  it("keeps durable publication and outbox recovery duplicate-safe on the first accepted pointer", async () => {
    const harness = immutableBlobHarness();
    let pending: { actionId: string; envelope: ReturnType<typeof envelope>; dueAt: Date; etag: string } | undefined;
    const lifecycle = {
      createQueuedWithOutbox: vi.fn(async (accepted: ReturnType<typeof envelope>, now: Date) => {
        const actionId = `${accepted.idempotencyKey}:publish:0`;
        if (pending) return { status: "duplicate" as const, actionId };
        pending = { actionId, envelope: accepted, dueAt: now, etag: "etag-1" };
        return { status: "created" as const, actionId, etag: "etag-1" };
      }),
      listPendingQueueActions: vi.fn(async () => pending ? [pending] : []),
      markQueueActionSent: vi.fn(async () => { pending = undefined; }),
    };
    let tick = 0;
    const publisher = createDurableShadowPublisher({
      config: { ...loadStage1Config({}), publisherEnabled: true, sampleRate: 1, killSwitch: false },
      tenantSalt: "test-salt", random: () => 0,
      now: () => new Date(Date.UTC(2026, 7, 20, 0, 0, tick++)),
      store: new AzureBlobShadowObjectStore({
        accountAlias: "shadow-nonprod", containerName: "shadow-input", containerClient: harness.containerClient,
      }),
      lifecycle,
      queue: { publish: vi.fn() },
    });
    const input = { tenantId: "raw-tenant", sourceRevision: "raw-revision", sourceBytes: bytes, fileClass: "txt" as const };

    const first = await publisher.publish(input);
    const duplicate = await publisher.publish(input);

    expect(first.status).toBe("published");
    expect(duplicate.status).toBe("published");
    if (first.status !== "published" || duplicate.status !== "published") throw new Error("test publication disabled");
    expect(duplicate.envelope.pointer).toEqual(first.envelope.pointer);
    expect(duplicate.envelope.idempotencyKey).toBe(first.envelope.idempotencyKey);
    expect(lifecycle.createQueuedWithOutbox).toHaveBeenCalledTimes(2);

    const publishScheduled = vi.fn(async () => undefined);
    const dispatcher = createOutboxDispatcher({ lifecycle, queue: { publishScheduled } });
    await expect(dispatcher.runOnce()).resolves.toBe(1);
    await expect(dispatcher.runOnce()).resolves.toBe(0);
    expect(publishScheduled).toHaveBeenCalledOnce();
    expect(lifecycle.markQueueActionSent).toHaveBeenCalledOnce();
  });

  it("rejects changed bytes before immutable upload", async () => {
    const uploadData = vi.fn();
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod", containerName: "shadow-input",
      containerClient: { getBlockBlobClient: () => ({ uploadData }) } as never,
    });
    await expect(store.putImmutable(pointer(), Buffer.alloc(bytes.byteLength, 0x78))).rejects.toThrow("shadow_pointer_digest_mismatch");
    expect(uploadData).not.toHaveBeenCalled();
  });

  it("publishes the versioned pointer returned by durable storage", async () => {
    const versioned = pointer({ versionId: "provider-version-2" });
    const queue = { publish: vi.fn(async () => undefined) };
    const publisher = createShadowPublisher({
      config: { ...loadStage1Config({}), publisherEnabled: true, sampleRate: 1, killSwitch: false },
      tenantSalt: "salt", random: () => 0,
      store: { putImmutable: vi.fn(async () => versioned), resolveImmutable: vi.fn() },
      queue,
    });
    await publisher.publish({ tenantId: "raw-tenant", sourceRevision: "raw-revision", sourceBytes: bytes, fileClass: "txt" });
    expect(queue.publish).toHaveBeenCalledWith(expect.objectContaining({ pointer: versioned }));
  });

  it("keeps raw identity and content out of object names, metadata, envelopes and telemetry", async () => {
    const harness = immutableBlobHarness();
    const emitted: unknown[] = [];
    const telemetry = createPrivacySafeTelemetry((event) => emitted.push(event));
    const lifecycle = { createQueuedWithOutbox: vi.fn(async () => ({ status: "created" as const })) };
    const publisher = createDurableShadowPublisher({
      config: { ...loadStage1Config({}), publisherEnabled: true, sampleRate: 1, killSwitch: false },
      tenantSalt: "test-salt", random: () => 0, now: () => new Date("2026-08-20T00:00:00Z"),
      store: new AzureBlobShadowObjectStore({
        accountAlias: "shadow-nonprod", containerName: "shadow-input", containerClient: harness.containerClient,
      }),
      lifecycle,
      queue: { publish: vi.fn() },
    });
    const rawIdentifiers = ["Bank Rahasia", "Matter Merger", "client-secret.docx", "https://sharepoint/raw-revision"];
    const result = await publisher.publish({
      tenantId: rawIdentifiers[0]!,
      sourceRevision: `${rawIdentifiers[1]}:${rawIdentifiers[2]}:${rawIdentifiers[3]}`,
      sourceBytes: bytes,
      fileClass: "txt",
    });
    telemetry.emit("worker_failed", {
      traceId: "trace-safe", jobId: "job-safe", tenantHash: "opaque-tenant", attempt: 1, errorCode: "timeout",
      filename: rawIdentifiers[2], rawTenantId: rawIdentifiers[0], providerPayload: { url: rawIdentifiers[3] },
    } as never);

    const serialized = JSON.stringify({
      blobNames: harness.blobNames,
      uploadOptions: harness.uploadOptions,
      envelope: result.status === "published" ? result.envelope : undefined,
      telemetry: emitted,
    });
    for (const identifier of rawIdentifiers) expect(serialized).not.toContain(identifier);
    expect(serialized).not.toContain(bytes.toString("utf8"));
  });

  it.each([
    ["cross account", { storageAccountAlias: "other" }, "shadow_pointer_account_mismatch"],
    ["cross tenant", { blobName: `other/${sha256}` }, "shadow_pointer_tenant_mismatch"],
    ["missing version", { versionId: "" }, "shadow_pointer_version_required"],
    ["wrong length", { sizeBytes: bytes.byteLength + 1 }, "shadow_pointer_size_mismatch"],
    ["wrong digest", { contentSha256: "0".repeat(64) }, "shadow_pointer_digest_mismatch"],
  ])("rejects %s pointers", async (_label, overrides, error) => {
    const store = new AzureBlobShadowObjectStore({
      accountAlias: "shadow-nonprod",
      containerName: "shadow-input",
      containerClient: {
        getBlockBlobClient: () => ({ withVersion: () => ({ downloadToBuffer: async () => Buffer.from(bytes) }) }),
      } as never,
    });
    await expect(store.resolveImmutable(pointer(overrides))).rejects.toThrow(error);
  });
});

describe("Cosmos lifecycle fencing and transactional outbox", () => {
  function cosmosHarness() {
    let record: Record<string, any> | undefined;
    let etag = 0;
    const item = (_id: string, _partition: string) => ({
      read: vi.fn(async () => ({ resource: record, etag: record ? `etag-${etag}` : undefined })),
      replace: vi.fn(async (next: Record<string, any>, options?: { accessCondition?: { condition?: string } }) => {
        if (options?.accessCondition?.condition !== `etag-${etag}`) throw Object.assign(new Error("precondition"), { code: 412 });
        record = { ...next };
        etag += 1;
        return { resource: record, etag: `etag-${etag}` };
      }),
    });
    const items = {
      create: vi.fn(async (next: Record<string, any>) => {
        if (record) throw Object.assign(new Error("conflict"), { code: 409 });
        record = { ...next }; etag = 1;
        return { resource: record, etag: "etag-1" };
      }),
      batch: vi.fn(async (operations: Array<Record<string, any>>) => {
        const replacement = operations.find((operation) => operation.operationType === "Replace")?.resource;
        record = { ...replacement }; etag += 1;
        return { code: 200, result: [{ etag: `etag-${etag}` }] };
      }),
    };
    return { container: { item, items } as never, get: () => record };
  }

  it("allows one lease owner and rejects every stale fencing token mutation", async () => {
    const harness = cosmosHarness();
    const lifecycle = new AzureCosmosLifecycleStore({ container: harness.container });
    await lifecycle.createQueued(envelope());
    const first = await lifecycle.acquire(envelope(), "worker-a", new Date("2026-08-20T00:00:00Z"), 180_000);
    const duplicate = await lifecycle.acquire(envelope(), "worker-b", new Date("2026-08-20T00:01:00Z"), 180_000);
    const recovered = await lifecycle.acquire(envelope(), "worker-b", new Date("2026-08-20T00:03:01Z"), 180_000);

    expect(first).toMatchObject({ status: "claimed", fencingToken: 1 });
    expect(duplicate).toMatchObject({ status: "duplicate", terminal: false });
    expect(recovered).toMatchObject({ status: "claimed", fencingToken: 2 });
    await expect(lifecycle.complete(envelope(), {
      ownerId: "worker-a", fencingToken: 1, etag: (first as any).etag,
    })).rejects.toThrow("shadow_lease_not_owned");
  });

  it("atomically persists retry state and a deterministic pending queue action", async () => {
    const harness = cosmosHarness();
    const lifecycle = new AzureCosmosLifecycleStore({ container: harness.container });
    await lifecycle.createQueued(envelope());
    const claim = await lifecycle.acquire(envelope(), "worker-a", new Date("2026-08-20T00:00:00Z"), 180_000) as any;
    const action = await lifecycle.recordRetry(envelope(), {
      ownerId: "worker-a", fencingToken: claim.fencingToken, etag: claim.etag,
      now: new Date("2026-08-20T00:00:01Z"), dueAt: new Date("2026-08-20T00:01:01Z"), errorCode: "transient",
    });

    expect(action.actionId).toBe(`${envelope().idempotencyKey}:retry:1`);
    expect(harness.get()).toMatchObject({ state: "retry_pending", pendingQueueAction: { actionId: action.actionId } });
    expect(harness.get()?.pendingQueueAction).not.toHaveProperty("sentAt");
  });

  it("persists initial queued state and publish action before Service Bus is contacted", async () => {
    const createQueuedWithOutbox = vi.fn(async () => ({ status: "created" as const, actionId: "publish-action" }));
    const directQueuePublish = vi.fn();
    const publisher = createDurableShadowPublisher({
      config: { ...loadStage1Config({}), publisherEnabled: true, sampleRate: 1, killSwitch: false },
      tenantSalt: "salt", random: () => 0,
      store: { putImmutable: vi.fn(async () => pointer()), resolveImmutable: vi.fn() },
      lifecycle: { createQueuedWithOutbox },
      queue: { publish: directQueuePublish },
    });

    await expect(publisher.publish({ tenantId: "raw-tenant", sourceRevision: "raw-revision", sourceBytes: bytes, fileClass: "txt" }))
      .resolves.toMatchObject({ status: "published" });
    expect(createQueuedWithOutbox).toHaveBeenCalledOnce();
    expect(directQueuePublish).not.toHaveBeenCalled();
  });
});

describe("outbox crash recovery", () => {
  it("replays an unsent deterministic action and marks it sent only after publish succeeds", async () => {
    const publishScheduled = vi.fn(async () => undefined);
    const markSent = vi.fn(async () => undefined);
    const dispatcher = createOutboxDispatcher({
      lifecycle: {
        listPendingQueueActions: vi.fn(async () => [{ actionId: "action-1", envelope: envelope(), dueAt: new Date(), etag: "e1" }]),
        markQueueActionSent: markSent,
      },
      queue: { publishScheduled },
    });

    await dispatcher.runOnce();
    expect(publishScheduled).toHaveBeenCalledWith(expect.anything(), expect.any(Date), "action-1");
    expect(markSent).toHaveBeenCalledAfter(publishScheduled);
  });

  it("keeps the outbox entrypoint inert under default production configuration", async () => {
    const dispatcher = { runOnce: vi.fn(async () => 1) };
    await expect(runShadowOutboxOnce(dispatcher, {})).resolves.toBe(0);
    expect(dispatcher.runOnce).not.toHaveBeenCalled();
  });

  it("does not mark an action sent when Service Bus is unavailable", async () => {
    const markSent = vi.fn();
    const dispatcher = createOutboxDispatcher({
      lifecycle: {
        listPendingQueueActions: vi.fn(async () => [{ actionId: "action-1", envelope: envelope(), dueAt: new Date(), etag: "e1" }]),
        markQueueActionSent: markSent,
      },
      queue: { publishScheduled: vi.fn(async () => { throw new Error("unavailable"); }) },
    });
    await expect(dispatcher.runOnce()).rejects.toThrow("unavailable");
    expect(markSent).not.toHaveBeenCalled();
  });
});

describe("provider selection, identity and privacy", () => {
  const identifiers = {
    DOCUMENT_SHADOW_STAGE1_PROVIDER: "azure",
    DOCUMENT_SHADOW_AZURE_SERVICE_BUS_NAMESPACE: "sb-nonprod.servicebus.windows.net",
    DOCUMENT_SHADOW_AZURE_SERVICE_BUS_QUEUE: "document-shadow-stage1",
    DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_URL: "https://stnonprod.blob.core.windows.net",
    DOCUMENT_SHADOW_AZURE_STORAGE_ACCOUNT_ALIAS: "shadow-nonprod",
    DOCUMENT_SHADOW_AZURE_STORAGE_CONTAINER: "shadow-input",
    DOCUMENT_SHADOW_AZURE_COSMOS_ENDPOINT: "https://cosmos-nonprod.documents.azure.com:443/",
    DOCUMENT_SHADOW_AZURE_COSMOS_DATABASE: "sandiva-ai02",
    DOCUMENT_SHADOW_AZURE_COSMOS_CONTAINER: "shadow-lifecycle",
    DOCUMENT_SHADOW_AZURE_MANAGED_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
  };

  it("accepts resource and identity identifiers without accepting provider secrets", () => {
    expect(loadAzureProviderConfig(identifiers)).toMatchObject({ enabled: true, authentication: "entra" });
    expect(() => loadAzureProviderConfig({ ...identifiers, AZURE_STORAGE_CONNECTION_STRING: "secret" }))
      .toThrow("shadow_azure_secret_configuration_forbidden");
  });

  it("fails closed for Stage 1 when Azure is selected without complete configuration", () => {
    expect(() => selectStage1Providers({ DOCUMENT_SHADOW_STAGE1_PROVIDER: "azure" })).toThrow("shadow_azure_configuration_incomplete");
    expect(selectStage1Providers({})).toEqual({ provider: "memory", enabled: false });
  });

  it("constructs all Azure clients with Entra credentials and no shared keys", () => {
    const credential = { getToken: vi.fn() };
    const adapters = createAzureProviderAdapters(loadAzureProviderConfig(identifiers), {
      credential: credential as never,
      serviceBusClient: { createSender: () => ({}), createReceiver: () => ({}) } as never,
      blobServiceClient: { getContainerClient: () => ({}) } as never,
      cosmosClient: { database: () => ({ container: () => ({}) }) } as never,
    });
    expect(adapters).toMatchObject({ queue: expect.any(AzureServiceBusShadowQueue), store: expect.any(AzureBlobShadowObjectStore), lifecycle: expect.any(AzureCosmosLifecycleStore) });
  });

  it("emits only allowlisted telemetry attributes", () => {
    const emitted: unknown[] = [];
    const telemetry = createPrivacySafeTelemetry((event) => emitted.push(event));
    telemetry.emit("worker_failed", {
      traceId: "trace-safe", jobId: "job-safe", tenantHash: "opaque-tenant",
      attempt: 2, errorCode: "timeout",
      filename: "client-secret.docx", rawTenantId: "Client Name", providerPayload: { url: "https://sharepoint" },
    } as never);
    const serialized = JSON.stringify(emitted);
    expect(serialized).toContain("trace-safe");
    expect(serialized).not.toContain("client-secret.docx");
    expect(serialized).not.toContain("Client Name");
    expect(serialized).not.toContain("sharepoint");
  });
});

describe("disabled Azure deployment", () => {
  it("uses zero-to-one replicas with no scaler, zero sampling, and every runtime disabled", () => {
    expect(deployment).toMatchObject({
      activation: "disabled",
      containerApps: {
        minReplicas: 0,
        maxReplicas: 1,
        serviceBusScaler: null,
        workerEnabled: false,
        outboxDispatcherEnabled: false,
      },
      publisherEnabled: false,
      sampleRate: 0,
      killSwitch: true,
      productionCredentialBinding: null,
      serviceBusSessionsEnabled: false,
      cosmos: { partitionKey: "/tenantKey", idField: "jobId", uniqueKeyPolicy: null },
      storage: { productionWormPolicyLocked: false },
    });
  });

  it("defaults the lifecycle lease to 180 seconds with one-third renewal", () => {
    expect(loadStage1Config({})).toMatchObject({ leaseMs: 180_000, leaseRenewalMs: 60_000, retentionMs: 1_209_600_000 });
  });

  it("defines reproducible Azure resources without a scaler, credentials, sessions, or locked WORM", () => {
    const bicep = readFileSync(new URL("../deploy/azure/document-shadow-stage1.disabled.bicep", import.meta.url), "utf8");
    expect(bicep).toContain("minReplicas: 0");
    expect(bicep).toContain("maxReplicas: 1");
    expect(bicep).toContain("requiresSession: false");
    expect(bicep).toContain("disableLocalAuth: true");
    expect(bicep).toContain("allowSharedKeyAccess: false");
    expect(bicep).not.toContain("custom: { type: 'azure-servicebus'");
    expect(bicep).not.toContain("immutabilityPolicy");
  });
});
