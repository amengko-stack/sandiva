import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { ImportsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const user = (await getCurrentUser())!;
  if (user.role !== "admin") redirect("/");

  const batches = await db()
    .select()
    .from(tables.importBatches)
    .orderBy(desc(tables.importBatches.createdAt))
    .limit(20);

  return <ImportsScreen batches={batches as any} />;
}
