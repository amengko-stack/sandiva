import type { ShadowEnvelope } from "@/lib/document-shadow-stage1/contracts";
import { createHash } from "node:crypto";

const MAX_ENVELOPE_BYTES = 32 * 1024;
const CONTENT_TYPE = "application/vnd.sandiva.shadow-envelope+json;version=1";

interface SenderPort {
  sendMessages(message: unknown): Promise<unknown>;
  scheduleMessages(message: unknown, scheduledFor: Date): Promise<unknown>;
}

interface ReceiverPort {
  renewMessageLock(message: unknown): Promise<unknown>;
  completeMessage(message: unknown): Promise<unknown>;
  abandonMessage(message: unknown): Promise<unknown>;
  deadLetterMessage(message: unknown, options: unknown): Promise<unknown>;
}

export class AzureServiceBusShadowQueue {
  private readonly deliveries = new WeakMap<object, unknown>();
  constructor(private readonly ports: { sender: SenderPort; receiver: ReceiverPort }) {}

  private message(envelope: ShadowEnvelope, messageId = envelope.idempotencyKey) {
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body, "utf8") > MAX_ENVELOPE_BYTES) throw new Error("shadow_envelope_too_large");
    const deterministicMessageId = createHash("sha256").update(messageId, "utf8").digest("hex");
    return { body: envelope, messageId: deterministicMessageId, contentType: CONTENT_TYPE };
  }

  async publish(envelope: ShadowEnvelope): Promise<void> {
    await this.ports.sender.sendMessages(this.message(envelope));
  }

  async publishScheduled(envelope: ShadowEnvelope, scheduledFor: Date, actionId: string): Promise<void> {
    await this.ports.sender.scheduleMessages(this.message(envelope, actionId), scheduledFor);
  }

  decode(message: { body: unknown }): ShadowEnvelope {
    const size = Buffer.byteLength(JSON.stringify(message.body), "utf8");
    if (size > MAX_ENVELOPE_BYTES) throw new Error("shadow_envelope_too_large");
    const envelope = message.body as Partial<ShadowEnvelope>;
    if (envelope.version !== 1 || envelope.pointer?.version !== 1) throw new Error("shadow_envelope_schema_unsupported");
    const decoded = envelope as ShadowEnvelope;
    this.deliveries.set(decoded, message);
    return decoded;
  }

  async acknowledge(envelope: ShadowEnvelope): Promise<void> {
    await this.ports.receiver.completeMessage(this.requireDelivery(envelope));
  }
  async retry(envelope: ShadowEnvelope): Promise<void> {
    await this.ports.receiver.abandonMessage(this.requireDelivery(envelope));
  }
  async deadLetter(envelope: ShadowEnvelope): Promise<void> {
    await this.ports.receiver.deadLetterMessage(this.requireDelivery(envelope), {
      deadLetterReason: "stage1_permanent_failure", deadLetterErrorDescription: "redacted",
    });
  }

  async renewReceived(message: unknown): Promise<void> { await this.ports.receiver.renewMessageLock(message); }
  async completeReceived(message: unknown): Promise<void> { await this.ports.receiver.completeMessage(message); }
  async abandonReceived(message: unknown): Promise<void> { await this.ports.receiver.abandonMessage(message); }
  async deadLetterReceived(message: unknown, reason: string): Promise<void> {
    await this.ports.receiver.deadLetterMessage(message, { deadLetterReason: reason, deadLetterErrorDescription: "redacted" });
  }
  private requireDelivery(envelope: ShadowEnvelope): unknown {
    const delivery = this.deliveries.get(envelope);
    if (!delivery) throw new Error("shadow_queue_delivery_not_bound");
    return delivery;
  }
}
