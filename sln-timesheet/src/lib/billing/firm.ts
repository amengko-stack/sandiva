import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

export interface BankAccount {
  label: string; // e.g. "IDR Account", "USD Account"
  accountName: string;
  accountNo: string;
  bankName: string;
  swift: string;
}

export interface FirmProfile {
  name: string;
  addressLines: string[];
  npwp: string;
  email: string;
  phone: string;
  bankAccounts: BankAccount[];
}

const DEFAULT_BANK: BankAccount = {
  label: "IDR Account",
  accountName: "Pers Perdata Sandiva Lawyer Network",
  accountNo: "1260060600607",
  bankName: "PT Bank Mandiri Persero Tbk",
  swift: "BMRIIDJA",
};

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
  bankAccounts: [DEFAULT_BANK],
};

export async function getFirmProfile(): Promise<FirmProfile> {
  const row = await db().query.settings.findFirst({ where: eq(tables.settings.id, 1) });
  const stored = (row?.firmProfile ?? null) as
    | (Partial<FirmProfile> & { bank?: Omit<BankAccount, "label"> })
    | null;
  // Back-compat: migrate a legacy single `bank` object → one-element array.
  const bankAccounts =
    stored?.bankAccounts && stored.bankAccounts.length
      ? stored.bankAccounts
      : stored?.bank
        ? [{ ...stored.bank, label: "IDR Account" }]
        : DEFAULT_FIRM.bankAccounts;
  return {
    name: stored?.name ?? DEFAULT_FIRM.name,
    addressLines: stored?.addressLines ?? DEFAULT_FIRM.addressLines,
    npwp: stored?.npwp ?? DEFAULT_FIRM.npwp,
    email: stored?.email ?? DEFAULT_FIRM.email,
    phone: stored?.phone ?? DEFAULT_FIRM.phone,
    bankAccounts,
  };
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
