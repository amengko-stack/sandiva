import type { ShadowEnvelope } from "@/lib/document-shadow-stage1/contracts";

type State = "queued" | "processing" | "retry_pending" | "completed" | "dead_lettered" | "cancelled";
interface RecordShape {
  id: string; jobId: string; tenantKey: string; state: State; attempt: number; fencingToken: number;
  envelope: ShadowEnvelope; ownerId?: string; leaseExpiresAt?: string; pendingQueueAction?: PendingAction;
}
interface PendingAction { actionId: string; envelope: ShadowEnvelope; dueAt: string; sentAt?: string; }
interface CosmosResponse { resource?: RecordShape; etag?: string; code?: number; result?: Array<{ etag?: string }>; }
interface ContainerPort {
  item(id: string, partitionKey: string): {
    read(): Promise<CosmosResponse>;
    replace(record: RecordShape, options: unknown): Promise<CosmosResponse>;
  };
  items: {
    create(record: RecordShape): Promise<CosmosResponse>;
    batch(operations: unknown[], partitionKey: string): Promise<CosmosResponse>;
    query?(query: unknown): { fetchAll(): Promise<{ resources: Array<RecordShape & { _etag?: string }> }> };
  };
}

export interface CosmosLeaseAuthority { ownerId: string; fencingToken: number; etag: string; }
export type CosmosAcquireResult =
  | { status: "claimed"; attempt: number; fencingToken: number; etag: string }
  | { status: "duplicate"; terminal: boolean };

export class AzureCosmosLifecycleStore {
  constructor(private readonly options: { container: ContainerPort }) {}

  async createQueued(envelope: ShadowEnvelope): Promise<"created" | "duplicate"> {
    const record: RecordShape = { id: envelope.idempotencyKey, jobId: envelope.idempotencyKey, tenantKey: envelope.pointer.tenantKey,
      state: "queued", attempt: 0, fencingToken: 0, envelope };
    try { await this.options.container.items.create(record); return "created"; }
    catch (error) { if (isCode(error, 409)) return "duplicate"; throw error; }
  }

  async createQueuedWithOutbox(envelope: ShadowEnvelope, now: Date) {
    const action: PendingAction = { actionId: `${envelope.idempotencyKey}:publish:0`, envelope, dueAt: now.toISOString() };
    const record: RecordShape = { id: envelope.idempotencyKey, jobId: envelope.idempotencyKey,
      tenantKey: envelope.pointer.tenantKey, state: "queued", attempt: 0, fencingToken: 0, envelope,
      pendingQueueAction: action };
    try {
      const response = await this.options.container.items.create(record);
      return { status: "created" as const, actionId: action.actionId, etag: response.etag };
    } catch (error) {
      if (isCode(error, 409)) return { status: "duplicate" as const, actionId: action.actionId };
      throw error;
    }
  }

  async acquire(envelope: ShadowEnvelope, ownerId: string, now: Date, leaseMs: number): Promise<CosmosAcquireResult> {
    const current = await this.read(envelope);
    if (!current.record) { await this.createQueued(envelope); return this.acquire(envelope, ownerId, now, leaseMs); }
    if (current.record.state === "completed" || current.record.state === "dead_lettered" || current.record.state === "cancelled")
      return { status: "duplicate" as const, terminal: true };
    if (current.record.state === "processing" && Date.parse(current.record.leaseExpiresAt ?? "") > now.getTime())
      return { status: "duplicate" as const, terminal: false };
    const next: RecordShape = { ...current.record, state: "processing", attempt: current.record.attempt + 1,
      ownerId, fencingToken: current.record.fencingToken + 1, leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString() };
    const response = await this.replace(envelope, next, current.etag!);
    return { status: "claimed" as const, attempt: next.attempt, fencingToken: next.fencingToken, etag: response.etag! };
  }

  async renew(envelope: ShadowEnvelope, authority: CosmosLeaseAuthority, now: Date, leaseMs: number) {
    const current = await this.requireAuthority(envelope, authority);
    const next = { ...current.record, leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString() };
    const response = await this.replace(envelope, next, authority.etag);
    return { ...authority, etag: response.etag! };
  }

  async complete(envelope: ShadowEnvelope, authority: CosmosLeaseAuthority): Promise<void> {
    const current = await this.requireAuthority(envelope, authority);
    await this.replace(envelope, { ...current.record, state: "completed", leaseExpiresAt: undefined }, authority.etag);
  }

  async recordRetry(envelope: ShadowEnvelope, input: CosmosLeaseAuthority & { now: Date; dueAt: Date; errorCode: string }) {
    const current = await this.requireAuthority(envelope, input);
    const action: PendingAction = { actionId: `${envelope.idempotencyKey}:retry:${current.record.attempt}`,
      envelope, dueAt: input.dueAt.toISOString() };
    const next = { ...current.record, state: "retry_pending" as const, leaseExpiresAt: undefined, pendingQueueAction: action };
    const response = await this.options.container.items.batch([{ operationType: "Replace", id: next.id, resource: next,
      ifMatch: input.etag }], next.tenantKey);
    if (response.code && response.code >= 300) throw new Error("shadow_cosmos_batch_failed");
    return { ...action, etag: response.result?.[0]?.etag };
  }

  async recordDeadLetter(envelope: ShadowEnvelope, input: CosmosLeaseAuthority & { now: Date; errorCode: string }) {
    const current = await this.requireAuthority(envelope, input);
    const action: PendingAction = { actionId: `${envelope.idempotencyKey}:dead-letter:${current.record.attempt}`, envelope, dueAt: input.now.toISOString() };
    const next = { ...current.record, state: "dead_lettered" as const, leaseExpiresAt: undefined, pendingQueueAction: action };
    await this.options.container.items.batch([{ operationType: "Replace", id: next.id, resource: next, ifMatch: input.etag }], next.tenantKey);
    return action;
  }

  async listPendingQueueActions() {
    if (!this.options.container.items.query) return [];
    const { resources } = await this.options.container.items.query({
      query: "SELECT * FROM c WHERE IS_DEFINED(c.pendingQueueAction) AND NOT IS_DEFINED(c.pendingQueueAction.sentAt)",
    }).fetchAll();
    return resources.map((resource) => ({ ...resource.pendingQueueAction!, etag: resource._etag ?? "" }));
  }

  async markQueueActionSent(input: { tenantKey: string; jobId: string; actionId: string; etag: string }): Promise<void> {
    const item = this.options.container.item(input.jobId, input.tenantKey);
    const response = await item.read();
    const record = response.resource;
    if (!record || record.pendingQueueAction?.actionId !== input.actionId) throw new Error("shadow_outbox_action_not_found");
    await item.replace({ ...record, pendingQueueAction: { ...record.pendingQueueAction, sentAt: new Date().toISOString() } },
      { accessCondition: { type: "IfMatch", condition: input.etag } });
  }

  private async read(envelope: ShadowEnvelope) {
    const response = await this.options.container.item(envelope.idempotencyKey, envelope.pointer.tenantKey).read();
    return { record: response.resource, etag: response.etag };
  }
  private async replace(envelope: ShadowEnvelope, record: RecordShape, etag: string) {
    try { return await this.options.container.item(envelope.idempotencyKey, envelope.pointer.tenantKey)
      .replace(record, { accessCondition: { type: "IfMatch", condition: etag } }); }
    catch (error) { if (isCode(error, 412)) throw new Error("shadow_lease_not_owned"); throw error; }
  }
  private async requireAuthority(envelope: ShadowEnvelope, authority: CosmosLeaseAuthority) {
    const current = await this.read(envelope);
    if (!current.record || current.record.state !== "processing" || current.record.ownerId !== authority.ownerId
      || current.record.fencingToken !== authority.fencingToken || current.etag !== authority.etag) throw new Error("shadow_lease_not_owned");
    return current as { record: RecordShape; etag: string };
  }
}

function isCode(error: unknown, code: number): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code; }
