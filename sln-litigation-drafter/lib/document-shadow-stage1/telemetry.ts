import { trace } from "@opentelemetry/api";

const ALLOWED = new Set(["traceId", "jobId", "tenantHash", "queueMessageId", "attempt", "ownerId", "fencingToken", "converterVersion", "errorClass", "errorCode"]);
export function createPrivacySafeTelemetry(sink: (event: { name: string; attributes: Record<string, string | number | boolean> }) => void) {
  return Object.freeze({ emit(name: string, attributes: Record<string, unknown>) {
    const safe = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => ALLOWED.has(key)
      && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")));
    const allowed = safe as Record<string, string | number | boolean>;
    trace.getTracer("sandiva.document-shadow-stage1").startActiveSpan(name, { attributes: allowed }, (span) => {
      sink({ name, attributes: allowed });
      span.end();
    });
  } });
}
