// One-shot local dev setup: migrate the embedded PGlite DB and seed demo data
// mirroring the approved mockup (3 personas + real-looking matters).
//   npm run dev:setup
// Dev credentials (local only):
//   admin@sandiva.co / admin-dev-123   (Operations Admin)
//   allova@sandiva.co / partner-dev-123 (AHM, partner)
//   fadya@sandiva.co / member-dev-123   (FAD, member)
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import bcrypt from "bcryptjs";
import * as schema from "../src/db/schema";

async function main() {
  const client = new PGlite(process.env.PGLITE_DIR ?? "./.pglite");
  const db = drizzle(client, { schema });

  console.log("Running migrations…");
  await migrate(db, { migrationsFolder: "./drizzle" });

  const existing = await db.select().from(schema.users);
  if (existing.length > 0) {
    console.log(`DB already has ${existing.length} users — leaving data as-is.`);
    return;
  }

  console.log("Seeding demo data…");
  const hash = (pw: string) => bcrypt.hashSync(pw, 10);
  const [admin, ahm, aws, fas, fad] = await db
    .insert(schema.users)
    .values([
      { name: "Operations Admin", initials: "OA", email: "admin@sandiva.co", passwordHash: hash("admin-dev-123"), role: "admin", title: "Administrator", weeklyTargetUnits: "0" },
      { name: "Allova Herling Mengko", initials: "AHM", email: "allova@sandiva.co", passwordHash: hash("partner-dev-123"), role: "partner", title: "Partner", weeklyTargetUnits: "30" },
      { name: "A. W. Santoso", initials: "AWS", email: "aws@sandiva.co", passwordHash: hash("partner-dev-123"), role: "partner", title: "Partner", weeklyTargetUnits: "30" },
      { name: "F. A. Sanjaya", initials: "FAS", email: "fas@sandiva.co", passwordHash: hash("partner-dev-123"), role: "partner", title: "Partner", weeklyTargetUnits: "30" },
      { name: "Fadya Arsita", initials: "FAD", email: "fadya@sandiva.co", passwordHash: hash("member-dev-123"), role: "member", title: "Associate", weeklyTargetUnits: "40" },
    ])
    .returning();

  await db.insert(schema.userRates).values([
    { userId: ahm.id, billingRateIdr: "4450000", billingRateUsd: "275.00", costRateIdr: "1800000", effectiveFrom: "2026-01-01" },
    { userId: aws.id, billingRateIdr: "4200000", billingRateUsd: "260.00", costRateIdr: "1700000", effectiveFrom: "2026-01-01" },
    { userId: fas.id, billingRateIdr: "4200000", billingRateUsd: "255.00", costRateIdr: "1650000", effectiveFrom: "2026-01-01" },
    { userId: fad.id, billingRateIdr: "1000000", billingRateUsd: "65.00", costRateIdr: "400000", effectiveFrom: "2026-01-01" },
  ]);

  const [semen, solusi, victoria, fadim, sandiva] = await db
    .insert(schema.clients)
    .values([
      { clientCode: "50160", name: "PT Semen Indonesia (Persero) Tbk" },
      { clientCode: "50158", name: "PT Solusi Makanan Indonesia", billingAddress: "Bintaro Avenue Lt. 2, Jl. MH. Thamrin, Bintaro Sektor 7, Tangerang Selatan, Banten 15220", contactPerson: "Ibu Chandra" },
      { clientCode: "5018", name: "PT Bank Victoria International" },
      { clientCode: "50176", name: "PT Fadim Pratama Energi" },
      { clientCode: "7005", name: "SANDIVA GROUP" },
    ])
    .returning();

  await db.insert(schema.matters).values([
    { matterCode: "50160-05", clientId: semen.id, title: "Rightsizing SIG", practiceArea: "GENERAL CORPORATE & LEGAL COUNSEL", feeType: "hourly", currency: "IDR", engagementPartnerId: ahm.id, status: "active" },
    { matterCode: "50158-01", clientId: solusi.id, title: "Pendampingan RUPS dan Proses Likuidasi", practiceArea: "GENERAL CORPORATE & LEGAL COUNSEL", feeType: "lump_sum", feeAmount: "50000000", currency: "IDR", up: "Ibu Chandra", engagementPartnerId: ahm.id, status: "active" },
    { matterCode: "5018-12", clientId: victoria.id, title: "Kontra Memori Banding — PT Iswara Dewata", practiceArea: "DISPUTE RELATION & ARBITRATION", feeType: "hourly", currency: "IDR", engagementPartnerId: aws.id, status: "active" },
    { matterCode: "50176-02", clientId: fadim.id, title: "Legal Opinion", practiceArea: "GENERAL CORPORATE & LEGAL COUNSEL", feeType: "lump_sum", feeAmount: "400000", currency: "USD", engagementPartnerId: ahm.id, status: "active" },
    { matterCode: "7005-06", clientId: sandiva.id, title: "Marketing (internal)", feeType: "internal", currency: "IDR", engagementPartnerId: ahm.id, status: "active" },
  ]);

  await db.insert(schema.settings).values({ id: 1 }).onConflictDoNothing();
  console.log("Done. Dev logins:");
  console.log("  admin@sandiva.co / admin-dev-123");
  console.log("  allova@sandiva.co / partner-dev-123");
  console.log("  fadya@sandiva.co / member-dev-123");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
