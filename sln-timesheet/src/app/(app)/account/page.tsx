import { getCurrentUser } from "@/lib/auth/current-user";
import { AccountScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = (await getCurrentUser())!;
  return (
    <AccountScreen
      name={user.name}
      email={user.email}
      role={user.title ?? user.role}
      forced={user.mustChangePassword}
    />
  );
}
