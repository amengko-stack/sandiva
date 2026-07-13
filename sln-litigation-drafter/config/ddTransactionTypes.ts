import type { DDTransactionType } from "@/types/dd";

export const DD_TRANSACTION_TYPES: { id: DDTransactionType; label: string }[] = [
  { id: "akuisisi_saham", label: "Akuisisi Saham" },
  { id: "akuisisi_aset", label: "Akuisisi Aset" },
  { id: "merger", label: "Penggabungan (Merger)" },
  { id: "likuidasi", label: "Likuidasi / Pembubaran" },
  { id: "divestasi", label: "Divestasi" },
  { id: "streamlining", label: "Streamlining / Reorganisasi Grup" },
  { id: "joint_venture", label: "Usaha Patungan (Joint Venture)" },
];

export const transactionLabel = (id: DDTransactionType): string =>
  DD_TRANSACTION_TYPES.find((t) => t.id === id)?.label ?? id;
