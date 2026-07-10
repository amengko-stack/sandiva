"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function VoidButton({ id }: { id: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  async function doVoid() {
    const res = await fetch(`/api/invoices/${id}/void`, { method: "POST" });
    if (res.ok) router.refresh();
    setConfirming(false);
  }

  return confirming ? (
    <span className="inline-flex gap-1.5">
      <button onClick={doVoid} className="rounded-lg bg-burgundy px-2.5 py-1 text-xs font-semibold text-white">
        Confirm void
      </button>
      <button onClick={() => setConfirming(false)} className="rounded-lg border border-[var(--border-strong)] px-2 py-1 text-xs">
        ✕
      </button>
    </span>
  ) : (
    <button
      onClick={() => setConfirming(true)}
      className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:border-burgundy hover:text-burgundy"
      title="Void: entries return to approved"
    >
      Void
    </button>
  );
}
