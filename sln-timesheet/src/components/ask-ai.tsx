"use client";

import { useState } from "react";

const EXAMPLES = [
  "Which matters have the most unbilled WIP?",
  "Who is under their target this week?",
  "How is realization looking?",
  "Matter mana yang margin-nya paling rendah?",
];

export function AskAI() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Ask-AI failed.");
    setAnswer(data.answer);
  }

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Ask AI about your data</h2>
        <span className="text-[10px] font-bold uppercase tracking-wide text-plum">partners &amp; admins</span>
      </header>
      <div className="p-4">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask(q)}
            placeholder="e.g. Which matters have the most unbilled time?"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--navy)]"
          />
          <button
            onClick={() => ask(q)}
            disabled={busy}
            className="flex-none rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
          >
            {busy ? "…" : "Ask"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => { setQ(e); ask(e); }}
              className="rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-2)] hover:border-[var(--navy)] hover:text-[var(--navy)]"
            >
              {e}
            </button>
          ))}
        </div>
        {error && <p className="mt-3 rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>}
        {answer && (
          <div className="mt-3 rounded-lg border border-plum/30 bg-gradient-to-b from-plum/5 to-transparent px-3.5 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-plum">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-plum text-[8px] text-white">AI</span>
              Sandiva Assistant
            </div>
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{answer}</p>
            <p className="mt-1.5 text-[10.5px] text-[var(--text-3)]">Answers from live aggregates — verify before acting.</p>
          </div>
        )}
      </div>
    </section>
  );
}
