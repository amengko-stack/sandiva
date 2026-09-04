export const MISSING_LITIGATION_SESSION_ERROR =
  "Sesi matter tidak tersedia. Mulai ulang workflow Litigation sebelum menyetujui draf.";

export interface Stage5MemoryApprovalInput {
  sessionId: string;
  draftText: string;
  docType: string | null;
  claimType: string;
  ref: string;
}

export async function approveDraftForMemory(
  input: Stage5MemoryApprovalInput
): Promise<void> {
  if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    throw new Error(MISSING_LITIGATION_SESSION_ERROR);
  }

  const res = await fetch("/api/memory/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      draftText: input.draftText,
      docType: input.docType,
      claimType: input.claimType,
      ref: input.ref,
    }),
  });
  const data = await res.json() as { error?: string };
  if (!res.ok) throw new Error(data.error || "Gagal menyimpan ke memory library");
}
