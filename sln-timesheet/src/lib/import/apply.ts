// Diff + upsert for the one-time Prohukum setup import. Idempotent: re-running
// the same files is a no-op (match on client_code / matter_code / Transaction ID).
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import type { ClientRow, MatterRow, TimeRow } from "./prohukum";

export interface DiffSummary {
  new: number;
  updated: number;
  unchanged: number;
  skipped: { reason: string; ref: string }[];
}

function changed(existing: object, incoming: object, keys: string[]): boolean {
  const from = existing as Record<string, unknown>;
  const to = incoming as Record<string, unknown>;
  return keys.some((k) => (to[k] ?? null) !== null && String(to[k]) !== String(from[k] ?? ""));
}

// --- Clients ---------------------------------------------------------------

export async function applyClients(rows: ClientRow[], dryRun: boolean): Promise<DiffSummary> {
  const summary: DiffSummary = { new: 0, updated: 0, unchanged: 0, skipped: [] };
  const existing = await db().select().from(tables.clients);
  const byCode = new Map(existing.map((c: any) => [c.clientCode, c]));

  for (const row of rows) {
    const found = byCode.get(row.clientCode) as any;
    if (!found) {
      summary.new++;
      if (!dryRun) await db().insert(tables.clients).values(row);
    } else if (changed(found, row, ["name", "npwp", "billingAddress", "contactPerson", "email"])) {
      summary.updated++;
      if (!dryRun)
        await db()
          .update(tables.clients)
          .set({
            name: row.name,
            npwp: row.npwp ?? found.npwp,
            billingAddress: row.billingAddress ?? found.billingAddress,
            contactPerson: row.contactPerson ?? found.contactPerson,
            email: row.email ?? found.email,
          })
          .where(eq(tables.clients.id, found.id));
    } else summary.unchanged++;
  }
  return summary;
}

// --- Matters -----------------------------------------------------------------

export async function applyMatters(rows: MatterRow[], dryRun: boolean): Promise<DiffSummary> {
  const summary: DiffSummary = { new: 0, updated: 0, unchanged: 0, skipped: [] };
  const clients = await db().select().from(tables.clients);
  const clientByCode = new Map(clients.map((c: any) => [c.clientCode, c]));
  const users = await db().select().from(tables.users);
  const userByInitials = new Map(users.map((u: any) => [u.initials, u]));
  const existing = await db().select().from(tables.matters);
  const byCode = new Map(existing.map((m: any) => [m.matterCode, m]));

  for (const row of rows) {
    const client = clientByCode.get(row.clientCode) as any;
    if (!client) {
      summary.skipped.push({ reason: `Client ${row.clientCode} not found — import Clients first`, ref: row.matterCode });
      continue;
    }
    const partner = row.responsibleInitials ? (userByInitials.get(row.responsibleInitials) as any) : null;
    const found = byCode.get(row.matterCode) as any;

    if (!found) {
      if (!partner) {
        summary.skipped.push({
          reason: `No engagement partner (responsible "${row.responsibleInitials ?? "—"}" not a user) — create the user, then re-import`,
          ref: row.matterCode,
        });
        continue;
      }
      summary.new++;
      if (!dryRun) {
        const [matter] = await db()
          .insert(tables.matters)
          .values({
            matterCode: row.matterCode,
            clientId: client.id,
            title: row.title,
            practiceArea: row.practiceArea,
            feeType: row.feeType,
            feeAmount: row.feeAmount !== null ? String(row.feeAmount) : null,
            currency: row.currency,
            engagementPartnerId: partner.id,
            status: "active",
          })
          .returning();
        for (const ini of row.teamInitials) {
          const member = userByInitials.get(ini) as any;
          if (member)
            await db()
              .insert(tables.matterTeam)
              .values({ matterId: matter.id, userId: member.id, teamRole: "team" })
              .onConflictDoNothing();
        }
      }
    } else if (changed(found, { title: row.title, feeAmount: row.feeAmount }, ["title", "feeAmount"])) {
      summary.updated++;
      if (!dryRun)
        await db()
          .update(tables.matters)
          .set({ title: row.title, feeAmount: row.feeAmount !== null ? String(row.feeAmount) : found.feeAmount })
          .where(eq(tables.matters.id, found.id));
    } else summary.unchanged++;
  }
  return summary;
}

// --- Historical time ---------------------------------------------------------

export async function applyTime(rows: TimeRow[], dryRun: boolean): Promise<DiffSummary> {
  const summary: DiffSummary = { new: 0, updated: 0, unchanged: 0, skipped: [] };
  const users = await db().select().from(tables.users);
  const userByName = new Map(users.map((u: any) => [u.name.toLowerCase(), u]));
  const matters = await db().select().from(tables.matters);
  const matterByCode = new Map(matters.map((m: any) => [m.matterCode, m]));
  const existing = await db().select({ tx: tables.timeEntries.prohukumTimeId }).from(tables.timeEntries);
  const seen = new Set(existing.map((e: any) => e.tx).filter(Boolean));

  for (const row of rows) {
    if (seen.has(row.prohukumTimeId)) {
      summary.unchanged++;
      continue;
    }
    const user = userByName.get(row.feeEarnerName.toLowerCase()) as any;
    if (!user) {
      summary.skipped.push({
        reason: `Fee earner "${row.feeEarnerName}" is not a user — create them, then re-import`,
        ref: `Tx ${row.prohukumTimeId}`,
      });
      continue;
    }
    const matter = matterByCode.get(row.matterCode) as any;
    if (!matter) {
      summary.skipped.push({ reason: `Matter ${row.matterCode} not found — import Matters first`, ref: `Tx ${row.prohukumTimeId}` });
      continue;
    }
    summary.new++;
    if (!dryRun)
      await db().insert(tables.timeEntries).values({
        userId: user.id,
        matterId: matter.id,
        date: row.date,
        units: row.units.toFixed(2),
        workcode: row.workcode,
        description: row.description,
        // Historical rows: already billed in the old world; keep imported
        // pricing, never re-resolve, never re-bill.
        status: "billed",
        isHistorical: true,
        importedRate: row.importedRate !== null ? row.importedRate.toFixed(2) : null,
        importedAmount: row.importedAmount !== null ? row.importedAmount.toFixed(2) : null,
        prohukumTimeId: row.prohukumTimeId,
      });
  }
  return summary;
}
