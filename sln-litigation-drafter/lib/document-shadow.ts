import { createHash, createHmac, randomUUID } from "node:crypto";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export type ShadowEventType =
  | "shadow_eligible"
  | "shadow_sampled"
  | "shadow_started"
  | "shadow_completed"
  | "shadow_skipped"
  | "shadow_failed"
  | "comparison_completed";

export interface ShadowEvent {
  type: ShadowEventType;
  correlationId: string;
  occurredAt: string;
  fileClass: "docx" | "txt";
  sizeBand: "small" | "medium" | "large";
  tenantDocumentKey: string;
  sourceRevisionKey: string;
  sourceContentKey: string;
  converter: "markitdown";
  converterVersion: string;
  durationMs?: number;
  errorCode?: "converter_error" | "timeout";
  metrics?: ShadowComparison;
}

export interface ShadowComparison {
  primaryCharacters: number;
  shadowCharacters: number;
  normalizedCharacterRatio: number;
  highRiskLiteralRecall: number;
  primaryOutputHash: string;
  shadowOutputHash: string;
}

export interface ShadowEligibilityInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ShadowObservationInput {
  sourceBytes: Buffer;
  fileName: string;
  mimeType: string;
  sourceRevision: string;
  tenantId: string;
  matterId: string;
  documentId: string;
  primaryText: string;
}

interface ShadowObserverOptions {
  enabled: boolean;
  sampleRate: number;
  random?: () => number;
  convert: (sourceBytes: Buffer, fileClass: "docx" | "txt") => Promise<string>;
  emit: (event: ShadowEvent) => void;
  tenantSalt: string;
  converterVersion?: string;
  timeoutMs?: number;
}

function fileClassFor(fileName: string): "docx" | "txt" | null {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension === "docx" || extension === "txt" ? extension : null;
}

export function isShadowEligible(input: ShadowEligibilityInput): boolean {
  const fileClass = fileClassFor(input.fileName);
  if (!fileClass || input.sizeBytes > MAX_SOURCE_BYTES || input.sizeBytes < 0) return false;
  return fileClass === "docx" ? input.mimeType === DOCX_MIME : input.mimeType === "text/plain";
}

function canonicalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[`*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function outputHash(text: string, hashKey: string): string {
  return createHmac("sha256", hashKey).update(text, "utf8").digest("hex");
}

function highRiskLiterals(text: string): Set<string> {
  const matches = text.match(/(?:Rp\s*)?\d[\d.,/%-]*(?:\s+[A-Za-z]+\s+\d{4})?/gi) ?? [];
  return new Set(matches.map((value) => value.toLocaleLowerCase("id-ID").replace(/\s+/g, " ")));
}

export function compareShadowOutputs(primaryText: string, shadowText: string, hashKey: string): ShadowComparison {
  const primary = canonicalize(primaryText);
  const shadow = canonicalize(shadowText);
  const primaryLiterals = highRiskLiterals(primary);
  const shadowLiterals = highRiskLiterals(shadow);
  const retained = Array.from(primaryLiterals).filter((literal) => shadowLiterals.has(literal)).length;

  return {
    primaryCharacters: primaryText.length,
    shadowCharacters: shadowText.length,
    normalizedCharacterRatio: primary.length === 0 ? (shadow.length === 0 ? 1 : 0) : shadow.length / primary.length,
    highRiskLiteralRecall: primaryLiterals.size === 0 ? 1 : retained / primaryLiterals.size,
    primaryOutputHash: outputHash(primary, hashKey),
    shadowOutputHash: outputHash(shadow, hashKey),
  };
}

function sizeBand(bytes: number): ShadowEvent["sizeBand"] {
  if (bytes <= 1024 * 1024) return "small";
  if (bytes <= 10 * 1024 * 1024) return "medium";
  return "large";
}

function scopedKey(salt: string, ...parts: string[]): string {
  return createHmac("sha256", salt).update(parts.join("\u0000"), "utf8").digest("hex");
}

export function createShadowObserver(options: ShadowObserverOptions) {
  const random = options.random ?? Math.random;
  const converterVersion = options.converterVersion ?? "0.1.0";
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async observe(input: ShadowObservationInput): Promise<void> {
      const fileClass = fileClassFor(input.fileName);
      if (!options.enabled || !fileClass || !isShadowEligible({
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sourceBytes.byteLength,
      })) return;

      const correlationId = randomUUID();
      const started = Date.now();
      const baseEvent = {
        correlationId,
        fileClass,
        sizeBand: sizeBand(input.sourceBytes.byteLength),
        tenantDocumentKey: scopedKey(options.tenantSalt, input.tenantId, input.matterId, input.documentId),
        sourceRevisionKey: scopedKey(options.tenantSalt, input.tenantId, input.sourceRevision),
        sourceContentKey: scopedKey(
          options.tenantSalt,
          input.tenantId,
          createHash("sha256").update(input.sourceBytes).digest("hex"),
        ),
        converter: "markitdown" as const,
        converterVersion,
      };
      const emit = (event: Omit<ShadowEvent, keyof typeof baseEvent | "occurredAt">) => {
        options.emit({ ...baseEvent, ...event, occurredAt: new Date().toISOString() });
      };

      emit({ type: "shadow_eligible" });
      if (random() >= options.sampleRate) {
        emit({ type: "shadow_skipped" });
        return;
      }
      emit({ type: "shadow_sampled" });
      emit({ type: "shadow_started" });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const shadowText = await Promise.race([
          options.convert(input.sourceBytes, fileClass),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("shadow_timeout")), timeoutMs);
          }),
        ]);
        emit({ type: "shadow_completed", durationMs: Date.now() - started });
        emit({
          type: "comparison_completed",
          durationMs: Date.now() - started,
          metrics: compareShadowOutputs(
            input.primaryText,
            shadowText,
            scopedKey(options.tenantSalt, input.tenantId, "output-hashes"),
          ),
        });
      } catch (error) {
        emit({
          type: "shadow_failed",
          durationMs: Date.now() - started,
          errorCode: error instanceof Error && error.message === "shadow_timeout" ? "timeout" : "converter_error",
        });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}
