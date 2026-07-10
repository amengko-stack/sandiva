import * as schema from "./schema";

// Dual-driver DB:
// - Production/staging: Neon over HTTP (DATABASE_URL=postgres://...)
// - Local dev without a cloud DB: embedded PGlite persisted in ./.pglite
//   (dev-only; run `npm run dev:setup` once to migrate + seed).
// The instance is cached on globalThis to survive Next dev hot reloads.

type Db = any;

const g = globalThis as unknown as { __slntsDb?: Db };

export function db(): Db {
  if (g.__slntsDb) return g.__slntsDb;

  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgres")) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { neon } = require("@neondatabase/serverless");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { drizzle } = require("drizzle-orm/neon-http");
    g.__slntsDb = drizzle(neon(url), { schema });
    return g.__slntsDb;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is not set");
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PGlite } = require("@electric-sql/pglite");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { drizzle } = require("drizzle-orm/pglite");
  const client = new PGlite(process.env.PGLITE_DIR ?? "./.pglite");
  g.__slntsDb = drizzle(client, { schema });
  return g.__slntsDb;
}

export * as tables from "./schema";
