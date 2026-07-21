// Seed the first admin account + settings row.
// Usage: DATABASE_URL=... npx tsx scripts/seed.ts admin@sandiva.co "Operations Admin" OA
// No password to set — Entra ID is the only sign-in path; the account can sign
// in immediately once its email matches an Entra ID account in the tenant.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

async function main() {
  const [email, name = "Operations Admin", initials = "OA"] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: npx tsx scripts/seed.ts <email> [name] [initials]");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true } });
  const db = drizzle(pool, { schema });

  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email.toLowerCase()) });
  if (existing) {
    console.log(`User ${email} already exists (id ${existing.id}) — nothing to do.`);
  } else {
    const [user] = await db
      .insert(schema.users)
      .values({ name, initials, email: email.toLowerCase(), role: "admin", title: "Administrator" })
      .returning();
    console.log(`Created admin ${user.email} (id ${user.id}).`);
  }

  await db
    .insert(schema.settings)
    .values({ id: 1 })
    .onConflictDoNothing();
  console.log("Settings row ensured. Done.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
