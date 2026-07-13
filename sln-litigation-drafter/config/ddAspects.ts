import type { DDAspectId } from "@/types/dd";

export const DD_ASPECTS: { id: DDAspectId; label: string }[] = [
  { id: "pendirian_ad", label: "Pendirian & Anggaran Dasar" },
  { id: "permodalan_saham", label: "Permodalan & Saham" },
  { id: "pengurus", label: "Direksi, Komisaris & RUPS" },
  { id: "perizinan", label: "Perizinan (NIB/OSS & Sektoral)" },
  { id: "harta_kekayaan", label: "Harta Kekayaan & Aset" },
  { id: "perjanjian_penting", label: "Perjanjian-Perjanjian Penting" },
  { id: "ketenagakerjaan", label: "Ketenagakerjaan" },
  { id: "perpajakan", label: "Perpajakan" },
  { id: "asuransi", label: "Asuransi" },
  { id: "perkara", label: "Perkara & Sengketa" },
];

export const aspectLabel = (id: DDAspectId): string =>
  DD_ASPECTS.find((a) => a.id === id)?.label ?? id;
