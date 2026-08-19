import type { ShadowEnvelope } from "@/lib/document-shadow-stage1/contracts";

type LifecycleStatus = "leased" | "retry" | "completed" | "dead_letter";

interface LifecycleRecord {
  status: LifecycleStatus;
  attempt: number;
  workerId: string;
  leaseExpiresAt: number;
}

export type ClaimResult =
  | { status: "claimed"; attempt: number }
  | { status: "duplicate"; terminal: boolean };

export interface ShadowLifecycleStore {
  claim(envelope: ShadowEnvelope, workerId: string, now: Date, leaseMs: number): Promise<ClaimResult>;
  renew(envelope: ShadowEnvelope, workerId: string, now: Date, leaseMs: number): Promise<void>;
  complete(envelope: ShadowEnvelope, workerId: string): Promise<void>;
  fail(envelope: ShadowEnvelope, workerId: string, now: Date, maxAttempts: number): Promise<{ status: "retry" | "dead_letter"; attempt: number }>;
}

export class InMemoryShadowLifecycleStore implements ShadowLifecycleStore {
  private readonly records = new Map<string, LifecycleRecord>();

  async claim(envelope: ShadowEnvelope, workerId: string, now: Date, leaseMs: number): Promise<ClaimResult> {
    const existing = this.records.get(envelope.idempotencyKey);
    if (existing && (existing.status === "completed" || existing.status === "dead_letter")) {
      return { status: "duplicate", terminal: true };
    }
    if (existing?.status === "leased" && existing.leaseExpiresAt > now.getTime()) {
      return { status: "duplicate", terminal: false };
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    this.records.set(envelope.idempotencyKey, {
      status: "leased",
      attempt,
      workerId,
      leaseExpiresAt: now.getTime() + leaseMs,
    });
    return { status: "claimed", attempt };
  }

  async complete(envelope: ShadowEnvelope, workerId: string): Promise<void> {
    const record = this.requireLease(envelope, workerId);
    this.records.set(envelope.idempotencyKey, { ...record, status: "completed", leaseExpiresAt: 0 });
  }

  async renew(envelope: ShadowEnvelope, workerId: string, now: Date, leaseMs: number): Promise<void> {
    const record = this.requireLease(envelope, workerId);
    if (record.leaseExpiresAt <= now.getTime()) throw new Error("shadow_lease_expired");
    this.records.set(envelope.idempotencyKey, { ...record, leaseExpiresAt: now.getTime() + leaseMs });
  }

  async fail(envelope: ShadowEnvelope, workerId: string, _now: Date, maxAttempts: number) {
    const record = this.requireLease(envelope, workerId);
    const status = record.attempt >= maxAttempts ? "dead_letter" as const : "retry" as const;
    this.records.set(envelope.idempotencyKey, { ...record, status, leaseExpiresAt: 0 });
    return { status, attempt: record.attempt };
  }

  private requireLease(envelope: ShadowEnvelope, workerId: string): LifecycleRecord {
    const record = this.records.get(envelope.idempotencyKey);
    if (!record || record.status !== "leased" || record.workerId !== workerId) throw new Error("shadow_lease_not_owned");
    return record;
  }
}
