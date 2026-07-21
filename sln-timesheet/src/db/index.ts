import * as schema from "./schema";

// Dual-driver DB:
// - Production/staging: standard Postgres over TCP via `pg` Pool with SSL
//   (Azure Database for PostgreSQL Flexible Server; DATABASE_URL=postgres://...)
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
    const { Pool } = require("pg");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { drizzle } = require("drizzle-orm/node-postgres");
    // Azure Database for PostgreSQL Flexible Server requires SSL. Its certificate
    // chains to DigiCert Global Root G2, which Node's bundled trust store already
    // includes, so verification works with the system roots. If a deployment ever
    // presents a cert Node doesn't trust, inject the PEM via DATABASE_CA_CERT —
    // never disable verification.
    const ca = process.env.DATABASE_CA_CERT;
    const pool = new Pool({
      connectionString: url,
      ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
    });
    // Azure recycles idle backend connections (maintenance/failover). Without an
    // 'error' listener, pg's emitted pool error is unhandled and crashes the whole
    // App Service process — not just the one request.
    pool.on("error", (err: unknown) => console.error("pg pool error:", err));
    g.__slntsDb = drizzle(pool, { schema });
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
