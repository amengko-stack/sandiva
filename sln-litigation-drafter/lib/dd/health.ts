import { ddSessionTtlMs } from "@/lib/retention";

/**
 * Which configuration the DD workflow needs, and what happens without each.
 *
 * Written after the branch landed in production with the environment unverified.
 * The reason it needed an endpoint rather than a one-off check is the failure mode:
 * a missing PERPLEXITY_API_KEY does not break anything. checkCurrency soft-fails to
 * "unknown" by design, so Stage 5 runs to completion and the regulation-currency
 * column simply comes back blank on every reference — the kind of failure that goes
 * unnoticed for months because nothing looks wrong.
 *
 * Presence only, never values. This is behind the app's auth, and a boolean is all
 * anyone needs to answer "is this deployment configured".
 */

export interface DDEnvRequirement {
  name: string;
  /** false = the workflow still runs, but something silently degrades. */
  required: boolean;
  /** What the lawyer will see if it is missing. */
  consequence: string;
}

export const DD_ENV_REQUIREMENTS: DDEnvRequirement[] = [
  {
    name: "ANTHROPIC_API_KEY",
    required: true,
    consequence:
      "Tahap 3 (klasifikasi), Tahap 4 (tabel), dan Tahap 5 (analisis) gagal seluruhnya.",
  },
  {
    name: "BLOB_READ_WRITE_TOKEN",
    required: true,
    consequence: "Tidak ada sesi yang dapat dibuat atau dibaca; seluruh alur berhenti.",
  },
  {
    name: "PERPLEXITY_API_KEY",
    required: false,
    consequence:
      "Pemeriksaan keberlakuan peraturan TIDAK error, melainkan mengembalikan \"unknown\" untuk setiap rujukan. " +
      "Laporan tetap terbit dengan kolom keberlakuan kosong, tanpa peringatan apa pun.",
  },
  {
    name: "CRON_SECRET",
    required: false,
    consequence:
      "Cron pembersihan selalu ditolak 401, sehingga dokumen ruang data klien tidak pernah dihapus dan " +
      "menumpuk melewati masa retensi.",
  },
];

export interface DDHealth {
  env: { name: string; present: boolean; required: boolean; consequence: string }[];
  /** True when every required item is present. */
  ready: boolean;
  /** Optional items that are missing, i.e. what is silently degraded. */
  degraded: string[];
  /** Missing required items. */
  blocking: string[];
  retentionDays: number;
}

export function ddHealth(env: Record<string, string | undefined> = process.env): DDHealth {
  const rows = DD_ENV_REQUIREMENTS.map((r) => ({
    name: r.name,
    // Trimmed: an env var set to an empty string is not configured, and Vercel
    // makes that easy to do by accident.
    present: (env[r.name] ?? "").trim() !== "",
    required: r.required,
    consequence: r.consequence,
  }));
  return {
    env: rows,
    ready: rows.filter((r) => r.required).every((r) => r.present),
    degraded: rows.filter((r) => !r.required && !r.present).map((r) => r.name),
    blocking: rows.filter((r) => r.required && !r.present).map((r) => r.name),
    retentionDays: Math.round(ddSessionTtlMs(env) / (24 * 60 * 60 * 1000)),
  };
}
