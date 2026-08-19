import { createHash, createHmac, randomUUID } from "node:crypto";

export type ShadowFileClass = "docx" | "txt";

export interface ShadowSourcePointer {
  version: 1;
  tenantKey: string;
  objectKey: string;
  sourceRevisionKey: string;
  contentSha256: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
}

export interface ImmutableSourceAcquisition {
  bytes: Buffer;
  pointer: ShadowSourcePointer;
}

export interface ShadowEnvelope {
  version: 1;
  pointer: ShadowSourcePointer;
  fileClass: ShadowFileClass;
  converterVersion: string;
  correlationId: string;
  idempotencyKey: string;
}

export interface ShadowPublishInput {
  tenantId: string;
  sourceRevision: string;
  sourceBytes: Buffer;
  fileClass: ShadowFileClass;
}

export type ShadowPublishResult =
  | { status: "disabled" | "not_sampled" }
  | { status: "published"; envelope: ShadowEnvelope };

export interface ShadowPublisher {
  publish(input: ShadowPublishInput): Promise<ShadowPublishResult>;
}

export interface ShadowObjectStore {
  putImmutable(pointer: ShadowSourcePointer, bytes: Buffer): Promise<void>;
  resolveImmutable(pointer: ShadowSourcePointer): Promise<Buffer>;
}

export interface ShadowQueue {
  publish(envelope: ShadowEnvelope): Promise<void>;
  acknowledge?(envelope: ShadowEnvelope): Promise<void>;
  retry?(envelope: ShadowEnvelope): Promise<void>;
  deadLetter?(envelope: ShadowEnvelope): Promise<void>;
}

function scopedKey(salt: string, scope: string, value: string): string {
  return createHmac("sha256", salt).update(`${scope}\u0000${value}`, "utf8").digest("hex");
}

export function acquireImmutableSource(input: {
  tenantId: string;
  sourceRevision: string;
  sourceBytes: Buffer;
  tenantSalt: string;
  now: Date;
  retentionMs: number;
}): ImmutableSourceAcquisition {
  const bytes = Buffer.from(input.sourceBytes);
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const tenantKey = scopedKey(input.tenantSalt, "tenant", input.tenantId);
  const sourceRevisionKey = scopedKey(input.tenantSalt, `revision:${tenantKey}`, input.sourceRevision);
  return {
    bytes,
    pointer: Object.freeze({
      version: 1,
      tenantKey,
      objectKey: `shadow/${tenantKey}/sha256/${contentSha256}`,
      sourceRevisionKey,
      contentSha256,
      sizeBytes: bytes.byteLength,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.retentionMs).toISOString(),
    }),
  };
}

export function createShadowEnvelope(input: {
  pointer: ShadowSourcePointer;
  fileClass: ShadowFileClass;
  converterVersion: string;
  correlationId?: string;
}): ShadowEnvelope {
  return Object.freeze({
    version: 1,
    pointer: Object.freeze({ ...input.pointer }),
    fileClass: input.fileClass,
    converterVersion: input.converterVersion,
    correlationId: input.correlationId ?? randomUUID(),
    idempotencyKey: `${input.pointer.tenantKey}:${input.pointer.sourceRevisionKey}:${input.converterVersion}`,
  });
}
