"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)]"
    >
      Sign out
    </button>
  );
}
