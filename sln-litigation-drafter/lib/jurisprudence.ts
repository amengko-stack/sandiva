import type { JurisprudenceEntry, RelevantJurisprudence } from "@/types";
import { readSiteFileText, writeMatterFile } from "./graph-client";

export const JURIS_DIR = "SLN-AI/jurisprudence";

// Throws on any failure other than "the DB doesn't exist yet". Callers that
// save/delete do read-modify-write on the shared index.json — returning []
// on a transient error would wipe the firm's entire verified jurisprudence
// database on the next write.
export async function loadJurisprudenceDb(): Promise<JurisprudenceEntry[]> {
  const raw = await readSiteFileText(`${JURIS_DIR}/index.json`);
  if (raw === null) return [];
  try {
    return JSON.parse(raw) as JurisprudenceEntry[];
  } catch {
    throw new Error(
      "Database yurisprudensi (index.json) tidak dapat dibaca — periksa filenya di SharePoint sebelum menyimpan atau menghapus entri."
    );
  }
}

export async function saveJurisprudenceDb(entries: JurisprudenceEntry[]): Promise<void> {
  await writeMatterFile(JURIS_DIR, "index.json", JSON.stringify(entries, null, 2));
}

// Keyed by the claim-type IDs from config/documentTypes.ts (searchRelevant
// receives docType and claimType — the claim type carries the substance).
const CLAIM_TYPE_KEYWORDS: Record<string, string[]> = {
  wanprestasi: ["wanprestasi", "ingkar janji", "kontrak", "perjanjian"],
  pmh: ["perbuatan melawan hukum", "pmh", "ganti rugi"],
  pembatalan_perjanjian: ["pembatalan perjanjian", "batal demi hukum", "cacat kehendak"],
  pmh_penguasa: ["perbuatan melawan hukum", "penguasa", "onrechtmatige overheidsdaad"],
  kepemilikan: ["kepemilikan", "hak milik", "sertifikat", "tanah"],
  waris: ["waris", "warisan", "harta bersama", "ahli waris"],
  piercing: ["piercing", "tanggung jawab pemegang saham", "badan hukum"],
  pembatalan_rups: ["rups", "rapat umum pemegang saham"],
  tanggung_jawab_direksi: ["direksi", "tanggung jawab direksi", "fiduciary"],
  pembubaran_pt: ["pembubaran", "likuidasi", "perseroan"],
  gugatan_derivatif: ["gugatan derivatif", "pemegang saham", "atas nama perseroan"],
  pkpu: ["pkpu", "penundaan kewajiban pembayaran utang", "perdamaian"],
  pailit: ["pailit", "kepailitan", "kurator", "utang"],
  actio_pauliana: ["actio pauliana", "kurator", "merugikan kreditor"],
  pembatalan_perdamaian: ["pembatalan perdamaian", "homologasi", "pkpu"],
  merek: ["merek", "pendaftaran merek", "merek terkenal"],
  hak_cipta: ["hak cipta", "ciptaan", "royalti"],
  paten: ["paten", "invensi", "klaim paten"],
  pembatalan_ktun: ["keputusan tata usaha negara", "ktun", "pembatalan keputusan"],
  pmh_pemerintah: ["perbuatan melawan hukum", "pemerintah", "tindakan faktual"],
  bani: ["arbitrase", "bani"],
  siac: ["arbitrase", "siac"],
  icc: ["arbitrase", "icc"],
  adhoc: ["arbitrase", "ad hoc"],
  // PKPU/pailit doc types carry substance themselves when passed as docType.
  permohonan_pkpu: ["pkpu", "penundaan kewajiban pembayaran utang"],
  permohonan_pailit: ["kepailitan", "pailit", "utang jatuh tempo"],
  jawaban_pkpu: ["pkpu", "tangkisan", "utang"],
  rencana_perdamaian: ["perdamaian", "restrukturisasi", "pkpu"],
};

const THRESHOLD = 2;

export function searchRelevant(
  entries: JurisprudenceEntry[],
  docType: string,
  claimType: string | null | undefined,
  kronologiSummary: string
): RelevantJurisprudence[] {
  const lower = kronologiSummary.toLowerCase();
  const keywords = Array.from(new Set([
    ...(CLAIM_TYPE_KEYWORDS[docType] ?? []),
    ...(claimType ? (CLAIM_TYPE_KEYWORDS[claimType] ?? []) : []),
  ]));

  const scored = entries.map((e) => {
    let score = 0;
    const entryText = [...e.topik, e.kaidah].join(" ").toLowerCase();
    for (const kw of keywords) {
      if (entryText.includes(kw)) score += 2;
    }
    for (const topic of e.topik) {
      if (lower.includes(topic.toLowerCase())) score += 1;
    }
    return { ...e, score, preselect: score >= THRESHOLD };
  });

  return scored
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
