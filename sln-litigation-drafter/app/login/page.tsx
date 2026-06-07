"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push("/drafter");
      } else {
        setError(data.error || "Kata sandi tidak valid");
      }
    } catch {
      setError("Terjadi kesalahan jaringan");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-sidebar)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          padding: 40,
          background: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: 6,
        }}
      >
        {/* Wordmark */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.2em",
              color: "var(--accent-gold)",
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            SANDIVA LEGAL NETWORK
          </div>
          <div style={{ fontSize: 17, color: "var(--text-primary)", fontWeight: 500 }}>
            Litigation Drafter
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: "block",
                fontSize: 12,
                color: "var(--text-muted)",
                marginBottom: 8,
                letterSpacing: "0.05em",
              }}
            >
              KATA SANDI
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Masukkan kata sandi"
              autoFocus
              required
            />
          </div>

          {error && (
            <div
              style={{
                padding: "10px 12px",
                background: "rgba(192, 57, 43, 0.1)",
                border: "1px solid var(--error)",
                borderRadius: 4,
                color: "var(--error)",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: "100%",
              padding: "11px 0",
              background: password && !loading ? "var(--accent-blue)" : "var(--border-color)",
              color: "white",
              border: "none",
              borderRadius: 4,
              fontSize: 14,
              fontWeight: 500,
              cursor: loading ? "wait" : "pointer",
              letterSpacing: "0.03em",
            }}
          >
            {loading ? "Memverifikasi..." : "Masuk"}
          </button>
        </form>
      </div>
    </div>
  );
}
