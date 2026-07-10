import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

export interface FirmProfile {
  name: string;
  addressLines: string[];
  npwp: string;
  email: string;
  phone: string;
  bank: { accountName: string; accountNo: string; bankName: string; swift: string };
}

// Defaults from the firm's real invoice letterhead; editable in Settings.
export const DEFAULT_FIRM: FirmProfile = {
  name: "Pers Perdata Sandiva Lawyer Network",
  addressLines: [
    "Menara Rajawali 12th Floor, Mega Kuningan Lot #5.1",
    "Jl. DR. Ide Anak Agung Gde Agung Str., East Kuningan, Setiabudi",
    "(12950), South Jakarta, DKI Jakarta - Indonesia",
  ],
  npwp: "000000000000",
  email: "Accounting@legal.sandiva.co",
  phone: "(021) 57950593",
  bank: {
    accountName: "Pers Perdata Sandiva Lawyer Network",
    accountNo: "1260060600607 (IDR Account)",
    bankName: "PT Bank Mandiri Persero Tbk",
    swift: "BMRIIDJA",
  },
};

export async function getFirmProfile(): Promise<FirmProfile> {
  const row = await db().query.settings.findFirst({ where: eq(tables.settings.id, 1) });
  const stored = (row?.firmProfile ?? null) as Partial<FirmProfile> | null;
  return { ...DEFAULT_FIRM, ...(stored ?? {}), bank: { ...DEFAULT_FIRM.bank, ...(stored?.bank ?? {}) } };
}

export async function getSettings() {
  const row = await db().query.settings.findFirst({ where: eq(tables.settings.id, 1) });
  return {
    defaultPpnRate: row ? Number(row.defaultPpnRate) : 11,
    fxRateUsdIdr: row?.fxRateUsdIdr ? Number(row.fxRateUsdIdr) : null,
    roundingRule: row?.roundingRule ?? "2dp",
  };
}

export function fmtMoney(n: number, currency: "IDR" | "USD"): string {
  return currency === "USD"
    ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "Rp " + Math.round(n).toLocaleString("en-US");
}
