import {
  createShadowObserver,
  type ShadowEvent,
  type ShadowObservationInput,
} from "@/lib/document-shadow";
import { createMarkItDownConverter, MARKITDOWN_VERSION } from "@/lib/markitdown-shadow";

function samplingRate(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

function emitShadowEvent(event: ShadowEvent): void {
  // ShadowEvent is an allowlisted, content-free schema. Never pass exceptions,
  // filenames, paths, extracted text, or raw identifiers to this emitter.
  console.log(JSON.stringify({ scope: "document_shadow", ...event }));
}

export async function observeDocumentShadow(input: ShadowObservationInput): Promise<void> {
  const salt = process.env.DOCUMENT_SHADOW_TENANT_SALT;
  const observer = createShadowObserver({
    enabled: process.env.DOCUMENT_SHADOW_ENABLED === "true" && Boolean(salt),
    sampleRate: samplingRate(process.env.DOCUMENT_SHADOW_SAMPLE_RATE),
    convert: createMarkItDownConverter(),
    emit: emitShadowEvent,
    tenantSalt: salt ?? "disabled",
    converterVersion: MARKITDOWN_VERSION,
    timeoutMs: 60_000,
  });
  await observer.observe(input);
}
