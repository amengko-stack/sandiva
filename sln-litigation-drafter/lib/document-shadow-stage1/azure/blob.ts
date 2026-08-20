import { createHash } from "node:crypto";
import type { ShadowObjectStore, ShadowSourcePointer } from "@/lib/document-shadow-stage1/contracts";

interface VersionBlobPort { downloadToBuffer(): Promise<Buffer>; }
interface BlockBlobPort {
  withVersion(versionId: string): VersionBlobPort;
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
    const blobName = pointer.blobName ?? `${pointer.tenantKey}/${pointer.contentSha256}`;
    if (!blobName.startsWith(`${pointer.tenantKey}/`)) throw new Error("shadow_pointer_tenant_mismatch");
    const blob = this.options.containerClient.getBlockBlobClient(blobName);
    if (!blob.uploadData) throw new Error("shadow_blob_upload_unavailable");
    const result = await blob.uploadData(Buffer.from(bytes), {
      conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      metadata: { sha256: pointer.contentSha256, tenant: pointer.tenantKey },
    });
    if (!result.versionId) throw new Error("shadow_blob_version_missing");
    return Object.freeze({ ...pointer, storageAccountAlias: this.options.accountAlias,
      container: this.options.containerName, blobName, versionId: result.versionId });
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
}
