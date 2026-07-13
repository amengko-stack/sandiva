import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getFirmProfile, getSettings } from "@/lib/billing/firm";
import { SettingsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");

  const [firm, settings] = await Promise.all([getFirmProfile(), getSettings()]);
  return <SettingsScreen firm={firm} settings={settings} />;
}
