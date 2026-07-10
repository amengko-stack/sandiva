"use client";

import { useRouter } from "next/navigation";

export function PaidButton({ id, paid }: { id: number; paid: boolean }) {
  const router = useRouter();
  async function toggle() {
    const res = await fetch(`/api/invoices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paid: !paid }),
    });
    if (res.ok) router.refresh();
  }
  return (
    <button
      onClick={toggle}
      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
        paid
          ? "border-[var(--border-strong)] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
          : "border-good text-good hover:bg-good/10"
      }`}
      title={paid ? "Mark as unpaid" : "Mark as collected"}
    >
      {paid ? "Unmark paid" : "Mark paid"}
    </button>
  );
}
