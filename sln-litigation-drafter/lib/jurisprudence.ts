import { readSiteFileText, writeMatterFile } from "./graph-client";
import type { JurisprudenceEntry, RelevantJurisprudence } from "@/types";

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
  permohonan_pailit: ["kepailitan", "pailit", "pkpu", "penundaan kewajiban pembayaran utang"],
  pmh: ["perbuatan melawan hukum", "pmh", "ganti rugi", "onrechtmatige daad"],
  wanprestasi: ["wanprestasi", "ingkar janji", "cidera janji", "kontrak", "perjanjian"],
  perceraian: ["cerai", "perceraian", "perkawinan", "rumah tangga"],
  warisan: ["waris", "warisan", "harta bersama", "testamen"],
  sengketa_tanah: ["tanah", "hak milik", "sertifikat", "agraria", "shm", "shgb"],
  phk: ["phk", "pemutusan hubungan kerja", "tenaga kerja", "buruh"],
};

const THRESHOLD = 2;

export function searchRelevant(
  entries: JurisprudenceEntry[],
  docType: string,
  claimType: string | null | undefined,
  kronologiSummary: string
): RelevantJurisprudence[] {
  const lower = kronologiSummary.toLowerCase();
  const keywordsArray = [
    ...(DOC_TYPE_KEYWORDS[docType] ?? []),
    ...(claimType ? DOC_TYPE_KEYWORDS[claimType] ?? [] : []),
  ];
  const keywords = keywordsArray;

  const scored = entries.map((e) => {
    let score = 0;
    const entryText = [...e.topik, e.kaidah].join(" ").toLowerCase();
    for (const kw of keywords) {
      if (entryText.includes(kw)) score += 2;
    }
    for (const topic of e.topik) {
      if (lower.includes(topic.toLowerCase())) score += 1;
    }
    const kaidahWords = e.kaidah.toLowerCase().split(/\s+/).filter((w) => w.length > 5);
    for (const w of kaidahWords) {
      if (lower.includes(w)) score += 0.5;
    }
    return { ...e, score, preselect: score >= THRESHOLD };
  });

  return scored
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
