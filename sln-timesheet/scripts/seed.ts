// Seed the first admin account + settings row.
// Usage: DATABASE_URL=... npx tsx scripts/seed.ts admin@sandiva.co "Password123!" "Operations Admin" OA
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import * as schema from "../src/db/schema";

async function main() {
  const [email, password, name = "Operations Admin", initials = "OA"] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npx tsx scripts/seed.ts <email> <password> [name] [initials]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = drizzle(neon(url), { schema });

  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email.toLowerCase()) });
  if (existing) {
    console.log(`User ${email} already exists (id ${existing.id}) — nothing to do.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(schema.users)
      .values({ name, initials, email: email.toLowerCase(), passwordHash, role: "admin", title: "Administrator" })
      .returning();
    console.log(`Created admin ${user.email} (id ${user.id}).`);
  }

  await db
    .insert(schema.settings)
    .values({ id: 1 })
    .onConflictDoNothing();
  console.log("Settings row ensured. Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
