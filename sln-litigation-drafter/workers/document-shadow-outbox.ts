import { loadStage1Config } from "@/lib/document-shadow-stage1/config";

/** Disabled-by-default outbox entrypoint. Deployment wiring supplies the durable dispatcher. */
export async function runShadowOutboxOnce(
  dispatcher: { runOnce(): Promise<number> },
  environment: Record<string, string | undefined> = process.env,
): Promise<number> {
  const config = loadStage1Config(environment);
  const explicitlyEnabled = environment.DOCUMENT_SHADOW_STAGE1_OUTBOX_ENABLED === "true";
  if (!explicitlyEnabled || config.killSwitch || !config.workerEnabled || config.sampleRate === 0) return 0;
  return dispatcher.runOnce();
}
