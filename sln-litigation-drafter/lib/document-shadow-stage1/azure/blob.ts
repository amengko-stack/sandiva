import { createHash } from "node:crypto";
import type { ShadowObjectStore, ShadowSourcePointer } from "@/lib/document-shadow-stage1/contracts";

interface BlobProperties {
  versionId?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}
interface VersionBlobPort { downloadToBuffer(): Promise<Buffer>; }
interface BlockBlobPort {
  withVersion(versionId: string): VersionBlobPort;
  getProperties?(): Promise<BlobProperties>;
  uploadData?(bytes: Buffer, options: unknown): Promise<{ versionId?: string }>;
}
interface ContainerPort { getBlockBlobClient(name: string): BlockBlobPort; }

export class AzureBlobShadowObjectStore implements ShadowObjectStore {
  constructor(private readonly options: {
    accountAlias: string;
    containerName: string;
    containerClient: ContainerPort;
  }) {}

  async putImmutable(pointer: ShadowSourcePointer, bytes: Buffer): Promise<ShadowSourcePointer> {
    if (bytes.byteLength !== pointer.sizeBytes) throw new Error("shadow_pointer_size_mismatch");
    if (createHash("sha256").update(bytes).digest("hex") !== pointer.contentSha256) throw new Error("shadow_pointer_digest_mismatch");
    const blobName = `${pointer.tenantKey}/${pointer.sourceRevisionKey}`;
    if (pointer.blobName && pointer.blobName !== blobName) throw new Error("shadow_pointer_identity_mismatch");
    const blob = this.options.containerClient.getBlockBlobClient(blobName);
    if (!blob.uploadData) throw new Error("shadow_blob_upload_unavailable");
    const metadata = {
      tenantkey: pointer.tenantKey,
      sourcerevisionkey: pointer.sourceRevisionKey,
      sha256: pointer.contentSha256,
      sizebytes: String(pointer.sizeBytes),
      createdat: pointer.createdAt,
      expiresat: pointer.expiresAt,
    };
    try {
      const result = await blob.uploadData(Buffer.from(bytes), {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
        metadata,
      });
      if (!result.versionId) throw new Error("shadow_blob_version_missing");
      return this.persistedPointer(pointer, blobName, result.versionId);
    } catch (error) {
      if (!isConditionalCreateConflict(error)) throw error;
      if (!blob.getProperties) throw new Error("shadow_blob_properties_unavailable");
      const existing = await blob.getProperties();
      if (!existing.versionId) throw new Error("shadow_blob_version_missing");
      const existingCreatedAt = existing.metadata?.createdat;
      const existingExpiresAt = existing.metadata?.expiresat;
      if (existing.contentLength !== pointer.sizeBytes
        || existing.metadata?.tenantkey !== metadata.tenantkey
        || existing.metadata?.sourcerevisionkey !== metadata.sourcerevisionkey
        || existing.metadata?.sha256 !== metadata.sha256
        || existing.metadata?.sizebytes !== metadata.sizebytes
        || !isValidTimestamp(existingCreatedAt)
        || !isValidTimestamp(existingExpiresAt)) {
        throw new Error("shadow_blob_existing_integrity_mismatch");
      }
      const existingBytes = Buffer.from(await blob.withVersion(existing.versionId).downloadToBuffer());
      if (existingBytes.byteLength !== pointer.sizeBytes
        || createHash("sha256").update(existingBytes).digest("hex") !== pointer.contentSha256) {
        throw new Error("shadow_blob_existing_integrity_mismatch");
      }
      return this.persistedPointer({ ...pointer, createdAt: existingCreatedAt!, expiresAt: existingExpiresAt! },
        blobName, existing.versionId);
    }
  }

  async resolveImmutable(pointer: ShadowSourcePointer): Promise<Buffer> {
    this.validate(pointer);
    const bytes = Buffer.from(await this.options.containerClient
      .getBlockBlobClient(pointer.blobName!)
      .withVersion(pointer.versionId!)
      .downloadToBuffer());
    if (bytes.byteLength !== pointer.sizeBytes) throw new Error("shadow_pointer_size_mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== pointer.contentSha256) throw new Error("shadow_pointer_digest_mismatch");
    return bytes;
  }

  private validate(pointer: ShadowSourcePointer): void {
    if (pointer.storageAccountAlias !== this.options.accountAlias) throw new Error("shadow_pointer_account_mismatch");
    if (pointer.container !== this.options.containerName) throw new Error("shadow_pointer_container_mismatch");
    if (!pointer.versionId) throw new Error("shadow_pointer_version_required");
    if (!pointer.blobName?.startsWith(`${pointer.tenantKey}/`)) throw new Error("shadow_pointer_tenant_mismatch");
  }

  private persistedPointer(pointer: ShadowSourcePointer, blobName: string, versionId: string): ShadowSourcePointer {
    return Object.freeze({ ...pointer, storageAccountAlias: this.options.accountAlias,
      container: this.options.containerName, blobName, versionId });
  }
}

function isConditionalCreateConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.statusCode === 412 || candidate.code === 412
    || (candidate.statusCode === 409 && candidate.code === "BlobAlreadyExists");
}

function isValidTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
