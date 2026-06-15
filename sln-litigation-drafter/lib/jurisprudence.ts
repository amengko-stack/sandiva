import type { JurisprudenceEntry, RelevantJurisprudence } from "@/types";
import { readSiteFileText, writeMatterFile } from "./graph-client";

export const JURIS_DIR = "SLN-AI/jurisprudence";

export async function loadJurisprudenceDb(): Promise<JurisprudenceEntry[]> {
  try {
    const raw = await readSiteFileText(`${JURIS_DIR}/index.json`);
    if (!raw) return [];
    return JSON.parse(raw) as JurisprudenceEntry[];
  } catch {
    return [];
  }
}

export async function saveJurisprudenceDb(entries: JurisprudenceEntry[]): Promise<void> {
  await writeMatterFile(JURIS_DIR, "index.json", JSON.stringify(entries, null, 2));
}

const DOC_TYPE_KEYWORDS: Record<string, string[]> = {
  permohonan_pailit: ["kepailitan", "pailit", "pkpu"],
  pmh: ["perbuatan melawan hukum", "pmh", "ganti rugi"],
  wanprestasi: ["wanprestasi", "ingkar janji", "kontrak", "perjanjian"],
  perceraian: ["cerai", "perceraian", "perkawinan"],
  warisan: ["waris", "warisan", "harta bersama"],
  sengketa_tanah: ["tanah", "hak milik", "sertifikat", "agraria"],
  phk: ["phk", "pemutusan hubungan kerja", "tenaga kerja"],
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
    ...(DOC_TYPE_KEYWORDS[docType] ?? []),
    ...(claimType ? (DOC_TYPE_KEYWORDS[claimType] ?? []) : []),
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
