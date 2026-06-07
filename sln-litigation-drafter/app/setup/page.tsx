"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SetupStep = 1 | 2 | 3 | 4 | 5;

interface SetupState {
  gugatanPath: string;
  gugatanAnalysis: string;
  gugatanRefinements: string;
  jawabanPath: string;
  jawabanAnalysis: string;
  jawabanRefinements: string;
  generalRefinements: string;
  generatedConventions: string;
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<SetupStep>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<SetupState>({
    gugatanPath: "",
    gugatanAnalysis: "",
    gugatanRefinements: "",
    jawabanPath: "",
    jawabanAnalysis: "",
    jawabanRefinements: "",
    generalRefinements: "",
    generatedConventions: "",
  });

  async function analyzeSample(type: "gugatan" | "jawaban") {
    const path = type === "gugatan" ? data.gugatanPath : data.jawabanPath;
    if (!path.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/setup/analyze-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharePointPath: path.trim(), docType: type }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);

      if (type === "gugatan") {
        setData((d) => ({ ...d, gugatanAnalysis: result.analysis }));
      } else {
        setData((d) => ({ ...d, jawabanAnalysis: result.analysis }));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setLoading(false);
    }
  }

  async function generateConventions() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/setup/save-conventions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gugatanAnalysis: data.gugatanAnalysis,
          gugatanRefinements: data.gugatanRefinements,
          jawabanAnalysis: data.jawabanAnalysis,
          jawabanRefinements: data.jawabanRefinements,
          generalRefinements: data.generalRefinements,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);

      setData((d) => ({ ...d, generatedConventions: result.conventions }));
      setStep(5);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setLoading(false);
    }
  }

  const steps = [
    "Sampel Gugatan",
    "Catatan Gugatan",
    "Sampel Jawaban",
    "Catatan Umum",
    "Konfirmasi",
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-primary)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "20px 40px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--bg-sidebar)",
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.15em", color: "var(--accent-gold)", fontWeight: 600 }}>
            SANDIVA LEGAL NETWORK
          </div>
          <div style={{ fontSize: 14, color: "var(--text-primary)", marginTop: 2 }}>
            Pengaturan Awal — Litigation Drafter
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 700, margin: "0 auto", padding: "40px 40px", width: "100%" }}>
        {/* Step indicator */}
        <div style={{ display: "flex", gap: 0, marginBottom: 40 }}>
          {steps.map((label, i) => {
            const num = (i + 1) as SetupStep;
            const isCompleted = step > num;
            const isActive = step === num;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  textAlign: "center",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    margin: "0 auto 8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    background: isCompleted
                      ? "var(--accent-blue)"
                      : isActive
                      ? "transparent"
                      : "transparent",
                    border: isCompleted
                      ? "none"
                      : isActive
                      ? "2px solid var(--accent-blue)"
                      : "2px solid var(--border-color)",
                    color: isCompleted
                      ? "white"
                      : isActive
                      ? "var(--accent-blue)"
                      : "var(--text-muted)",
                  }}
                >
                  {isCompleted ? "✓" : num}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </div>
                {i < steps.length - 1 && (
                  <div
                    style={{
                      position: "absolute",
                      top: 14,
                      left: "60%",
                      right: "-40%",
                      height: 1,
                      background: isCompleted ? "var(--accent-blue)" : "var(--border-color)",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <div style={{ padding: 14, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 20 }}>
            {error}
          </div>
        )}

        {/* Step 1: Gugatan sample */}
        {step === 1 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Sampel Gugatan
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Tunjukkan sebuah gugatan yang telah disetujui dan dianggap sebagai standar kualitas firma. Aplikasi akan menganalisis gaya penulisannya.
            </p>
            <label style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
              Path SharePoint file gugatan
            </label>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <input
                type="text"
                value={data.gugatanPath}
                onChange={(e) => setData((d) => ({ ...d, gugatanPath: e.target.value }))}
                placeholder="Matters/SLN-2024-001/Documents/Gugatan_Final.docx"
                style={{ flex: 1 }}
              />
              <button
                onClick={() => analyzeSample("gugatan")}
                disabled={loading || !data.gugatanPath.trim()}
                style={{ padding: "8px 16px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {loading ? "Menganalisis..." : "Analisis"}
              </button>
            </div>
            {data.gugatanAnalysis && (
              <div style={{ padding: 16, background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: "var(--accent-gold)", fontWeight: 600, marginBottom: 8 }}>HASIL ANALISIS:</div>
                <pre style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.6, fontFamily: "var(--font-inter), sans-serif" }}>
                  {data.gugatanAnalysis}
                </pre>
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setStep(2)}
                disabled={!data.gugatanAnalysis}
                style={{ padding: "10px 24px", background: data.gugatanAnalysis ? "var(--accent-blue)" : "var(--border-color)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: data.gugatanAnalysis ? "pointer" : "not-allowed" }}
              >
                Lanjut →
              </button>
              <button
                onClick={() => setStep(2)}
                style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
              >
                Lewati
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Gugatan refinements */}
        {step === 2 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Catatan untuk Gugatan
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Tambahkan konvensi atau preferensi khusus yang tidak terlihat dari sampel — misalnya format petitum, cara sitasi, atau gaya paragraf.
            </p>
            <textarea
              value={data.gugatanRefinements}
              onChange={(e) => setData((d) => ({ ...d, gugatanRefinements: e.target.value }))}
              rows={8}
              placeholder="Contoh: Kami selalu menyertakan klausul dwangsom Rp 1.000.000/hari. Petitum primair selalu didahulukan sebelum subsidiair. ..."
            />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => setStep(1)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>← Kembali</button>
              <button onClick={() => setStep(3)} style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Lanjut →</button>
            </div>
          </div>
        )}

        {/* Step 3: Jawaban sample */}
        {step === 3 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Sampel Jawaban
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Tunjukkan sebuah jawaban tergugat yang menjadi standar firma.
            </p>
            <label style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
              Path SharePoint file jawaban
            </label>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <input
                type="text"
                value={data.jawabanPath}
                onChange={(e) => setData((d) => ({ ...d, jawabanPath: e.target.value }))}
                placeholder="Matters/SLN-2024-002/Documents/Jawaban_Final.docx"
                style={{ flex: 1 }}
              />
              <button
                onClick={() => analyzeSample("jawaban")}
                disabled={loading || !data.jawabanPath.trim()}
                style={{ padding: "8px 16px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {loading ? "Menganalisis..." : "Analisis"}
              </button>
            </div>
            {data.jawabanAnalysis && (
              <div style={{ padding: 16, background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: "var(--accent-gold)", fontWeight: 600, marginBottom: 8 }}>HASIL ANALISIS:</div>
                <pre style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.6, fontFamily: "var(--font-inter), sans-serif" }}>
                  {data.jawabanAnalysis}
                </pre>
              </div>
            )}
            <label style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 8, marginTop: 16 }}>
              Catatan khusus untuk Jawaban
            </label>
            <textarea
              value={data.jawabanRefinements}
              onChange={(e) => setData((d) => ({ ...d, jawabanRefinements: e.target.value }))}
              rows={4}
              placeholder="Konvensi khusus untuk dokumen jawaban..."
            />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => setStep(2)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>← Kembali</button>
              <button onClick={() => setStep(4)} style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Lanjut →</button>
            </div>
          </div>
        )}

        {/* Step 4: General refinements */}
        {step === 4 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Catatan Umum
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Tambahkan instruksi umum yang berlaku untuk semua jenis dokumen litigasi firma ini.
            </p>
            <textarea
              value={data.generalRefinements}
              onChange={(e) => setData((d) => ({ ...d, generalRefinements: e.target.value }))}
              rows={10}
              placeholder="Contoh: Selalu gunakan sapaan 'Yang Mulia Majelis Hakim' di awal surat. Gunakan angka dalam kata untuk nilai di bawah satu miliar. Hindari penggunaan kata 'Bahwa' berulang sebagai pembuka kalimat. ..."
            />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => setStep(3)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>← Kembali</button>
              <button
                onClick={generateConventions}
                disabled={loading}
                style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: loading ? "wait" : "pointer" }}
              >
                {loading ? "Membuat konvensi..." : "Buat & Simpan Konvensi →"}
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Confirmation */}
        {step === 5 && (
          <div>
            <div style={{ padding: "12px 16px", background: "rgba(39,174,96,0.1)", border: "1px solid var(--success)", borderRadius: 4, color: "var(--success)", fontSize: 13, marginBottom: 24, display: "flex", alignItems: "center", gap: 8 }}>
              ✓ Konvensi firma berhasil disimpan ke Vercel Blob
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Pratinjau Konvensi Firma
            </h2>
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-color)",
                borderRadius: 4,
                padding: "20px 24px",
                maxHeight: 400,
                overflowY: "auto",
                marginBottom: 24,
              }}
            >
              <pre style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.7, fontFamily: "var(--font-inter), sans-serif" }}>
                {data.generatedConventions}
              </pre>
            </div>
            <button
              onClick={() => router.push("/drafter")}
              style={{ padding: "12px 32px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 15, fontWeight: 500, cursor: "pointer" }}
            >
              Mulai Menggunakan Drafter →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
