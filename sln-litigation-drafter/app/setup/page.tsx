"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SetupStep = 1 | 2 | 3 | 4;

interface DocSample {
  path: string;
  analysis: string;
  refinements: string;
  loading: boolean;
}

const DOC_TYPES: { key: string; label: string; group: string; placeholder?: string }[] = [
  { key: "gugatan",            label: "Gugatan",                    group: "Litigasi Perdata" },
  { key: "jawaban",            label: "Jawaban",                    group: "Litigasi Perdata" },
  { key: "replik",             label: "Replik",                     group: "Litigasi Perdata" },
  { key: "duplik",             label: "Duplik",                     group: "Litigasi Perdata" },
  { key: "kesimpulan",         label: "Kesimpulan Perdata",         group: "Litigasi Perdata" },
  { key: "permohonan_pkpu",    label: "Permohonan PKPU",            group: "PKPU & Kepailitan" },
  { key: "permohonan_pailit",  label: "Permohonan Pailit",          group: "PKPU & Kepailitan" },
  { key: "jawaban_pkpu",       label: "Jawaban PKPU / Pailit",      group: "PKPU & Kepailitan" },
  { key: "rencana_perdamaian", label: "Rencana Perdamaian",         group: "PKPU & Kepailitan" },
  { key: "kesimpulan_pkpu",    label: "Kesimpulan PKPU / Pailit",   group: "PKPU & Kepailitan" },
];

type Samples = Record<string, DocSample>;

function emptySample(): DocSample {
  return { path: "", analysis: "", refinements: "", loading: false };
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<SetupStep>(1);
  const [globalError, setGlobalError] = useState("");
  const [saving, setSaving] = useState(false);
  const [generalRefinements, setGeneralRefinements] = useState("");
  const [generatedConventions, setGeneratedConventions] = useState("");
  const [isRerun, setIsRerun] = useState(false);
  const [samples, setSamples] = useState<Samples>(
    Object.fromEntries(DOC_TYPES.map((d) => [d.key, emptySample()]))
  );

  function setSample(key: string, patch: Partial<DocSample>) {
    setSamples((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  }

  async function analyzeSample(key: string) {
    const path = samples[key].path.trim();
    if (!path) return;
    setSample(key, { loading: true });
    setGlobalError("");
    try {
      const res = await fetch("/api/setup/analyze-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharePointPath: path, docType: key }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setSample(key, { analysis: result.analysis, loading: false });
    } catch (e: unknown) {
      setSample(key, { loading: false });
      setGlobalError(e instanceof Error ? e.message : "Terjadi kesalahan");
    }
  }

  async function saveConventions() {
    setSaving(true);
    setGlobalError("");
    try {
      const samplePayload: Record<string, { analysis: string; refinements: string }> = {};
      for (const d of DOC_TYPES) {
        const s = samples[d.key];
        if (s.analysis || s.refinements) {
          samplePayload[d.key] = { analysis: s.analysis, refinements: s.refinements };
        }
      }
      const res = await fetch("/api/setup/save-conventions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ samples: samplePayload, generalRefinements }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setGeneratedConventions(result.conventions);
      setIsRerun(result.isRerun ?? false);
      setStep(4);
    } catch (e: unknown) {
      setGlobalError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setSaving(false);
    }
  }

  const anyAnalyzed = DOC_TYPES.some((d) => samples[d.key].analysis);
  const groups = DOC_TYPES.reduce<string[]>((acc, d) => acc.includes(d.group) ? acc : [...acc, d.group], []);

  const stepLabels = ["Sampel Dokumen", "Catatan per Jenis", "Catatan Umum", "Konfirmasi"];

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "20px 40px", borderBottom: "1px solid var(--border-color)", background: "var(--bg-sidebar)", display: "flex", alignItems: "center", gap: 20 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.15em", color: "var(--accent-gold)", fontWeight: 600 }}>
            SANDIVA LEGAL NETWORK
          </div>
          <div style={{ fontSize: 14, color: "var(--text-primary)", marginTop: 2 }}>
            Pengaturan — Litigation Drafter
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 40px", width: "100%" }}>
        {/* Step indicator */}
        <div style={{ display: "flex", gap: 0, marginBottom: 40 }}>
          {stepLabels.map((label, i) => {
            const num = (i + 1) as SetupStep;
            const isCompleted = step > num;
            const isActive = step === num;
            return (
              <div key={i} style={{ flex: 1, textAlign: "center", position: "relative" }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%", margin: "0 auto 8px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 600,
                  background: isCompleted ? "var(--accent-blue)" : "transparent",
                  border: isCompleted ? "none" : isActive ? "2px solid var(--accent-blue)" : "2px solid var(--border-color)",
                  color: isCompleted ? "white" : isActive ? "var(--accent-blue)" : "var(--text-muted)",
                }}>
                  {isCompleted ? "✓" : num}
                </div>
                <div style={{ fontSize: 11, color: isActive ? "var(--text-primary)" : "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {label}
                </div>
                {i < stepLabels.length - 1 && (
                  <div style={{
                    position: "absolute", top: 14, left: "60%", right: "-40%",
                    height: 1, background: isCompleted ? "var(--accent-blue)" : "var(--border-color)",
                  }} />
                )}
              </div>
            );
          })}
        </div>

        {globalError && (
          <div style={{ padding: 14, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 20 }}>
            {globalError}
          </div>
        )}

        {/* Step 1: All samples */}
        {step === 1 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Sampel Dokumen
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 28 }}>
              Tempelkan sharing link SharePoint untuk setiap jenis dokumen yang ingin dijadikan referensi gaya penulisan. Semua opsional — lewati yang tidak ada sampelnya.
            </p>

            {groups.map((group) => (
              <div key={group} style={{ marginBottom: 32 }}>
                <div style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--accent-gold)", fontWeight: 600, marginBottom: 14 }}>
                  {group.toUpperCase()}
                </div>
                {DOC_TYPES.filter((d) => d.group === group).map((docType) => {
                  const s = samples[docType.key];
                  return (
                    <div key={docType.key} style={{ marginBottom: 16, border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ padding: "10px 16px", background: "var(--bg-sidebar)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{docType.label}</span>
                        {s.analysis && (
                          <span style={{ fontSize: 11, color: "var(--success)", fontWeight: 600 }}>✓ Teranalisis</span>
                        )}
                      </div>
                      <div style={{ padding: "12px 16px", background: "var(--bg-primary)" }}>
                        <div style={{ display: "flex", gap: 8, marginBottom: s.analysis ? 12 : 0 }}>
                          <input
                            type="text"
                            value={s.path}
                            onChange={(e) => setSample(docType.key, { path: e.target.value })}
                            placeholder="https://sandiva.sharepoint.com/:w:/s/..."
                            style={{ flex: 1, fontSize: 12 }}
                          />
                          <button
                            onClick={() => analyzeSample(docType.key)}
                            disabled={s.loading || !s.path.trim()}
                            style={{ padding: "6px 14px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 12, cursor: s.loading || !s.path.trim() ? "not-allowed" : "pointer", whiteSpace: "nowrap", opacity: s.loading || !s.path.trim() ? 0.6 : 1 }}
                          >
                            {s.loading ? "..." : "Analisis"}
                          </button>
                        </div>
                        {s.analysis && (
                          <div style={{ padding: 12, background: "var(--bg-surface)", borderRadius: 4, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                            <div style={{ fontSize: 11, color: "var(--accent-gold)", fontWeight: 600, marginBottom: 6 }}>HASIL ANALISIS</div>
                            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-inter), sans-serif", fontSize: 12, color: "var(--text-primary)" }}>
                              {s.analysis}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button
                onClick={() => setStep(2)}
                style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}
              >
                Lanjut →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Per-type refinements */}
        {step === 2 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Catatan per Jenis Dokumen
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Untuk setiap jenis dokumen, tambahkan konvensi atau preferensi khusus yang tidak terlihat dari sampel. Semua opsional.
            </p>

            {DOC_TYPES.map((docType) => (
              <div key={docType.key} style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: 13, color: samples[docType.key].analysis ? "var(--text-primary)" : "var(--text-muted)", marginBottom: 6, fontWeight: samples[docType.key].analysis ? 500 : 400 }}>
                  {docType.label}
                  {samples[docType.key].analysis && <span style={{ fontSize: 11, color: "var(--success)", marginLeft: 8 }}>✓ ada sampel</span>}
                </label>
                <textarea
                  value={samples[docType.key].refinements}
                  onChange={(e) => setSample(docType.key, { refinements: e.target.value })}
                  rows={3}
                  placeholder={`Catatan khusus untuk ${docType.label} (opsional)...`}
                  style={{ fontSize: 13 }}
                />
              </div>
            ))}

            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={() => setStep(1)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>← Kembali</button>
              <button onClick={() => setStep(3)} style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Lanjut →</button>
            </div>
          </div>
        )}

        {/* Step 3: General refinements */}
        {step === 3 && (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Catatan Umum
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Instruksi umum yang berlaku untuk semua jenis dokumen litigasi. Akan digabungkan dengan konvensi yang sudah ada jika setup dijalankan ulang.
            </p>
            <textarea
              value={generalRefinements}
              onChange={(e) => setGeneralRefinements(e.target.value)}
              rows={10}
              placeholder="Contoh: Selalu gunakan sapaan 'Yang Mulia Majelis Hakim'. Gunakan angka dalam kata untuk nilai di bawah satu miliar. Hindari penggunaan kata 'Bahwa' berulang sebagai pembuka kalimat. ..."
            />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => setStep(2)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>← Kembali</button>
              <button
                onClick={saveConventions}
                disabled={saving || (!anyAnalyzed && !generalRefinements.trim())}
                style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: saving ? "wait" : "pointer", opacity: (!anyAnalyzed && !generalRefinements.trim()) ? 0.5 : 1 }}
              >
                {saving ? "Menyimpan..." : "Buat & Simpan Konvensi →"}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Confirmation */}
        {step === 4 && (
          <div>
            <div style={{ padding: "12px 16px", background: "rgba(39,174,96,0.1)", border: "1px solid var(--success)", borderRadius: 4, color: "var(--success)", fontSize: 13, marginBottom: 24, display: "flex", alignItems: "center", gap: 8 }}>
              ✓ Konvensi firma berhasil {isRerun ? "diperbarui dan digabungkan" : "disimpan"} ke Vercel Blob
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
              Pratinjau Konvensi Firma
            </h2>
            <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, padding: "20px 24px", maxHeight: 420, overflowY: "auto", marginBottom: 24 }}>
              <pre style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.7, fontFamily: "var(--font-inter), sans-serif" }}>
                {generatedConventions}
              </pre>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={() => router.push("/drafter")}
                style={{ padding: "12px 32px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 15, fontWeight: 500, cursor: "pointer" }}
              >
                Mulai Menggunakan Drafter →
              </button>
              <button
                onClick={() => { setStep(1); setGeneratedConventions(""); setGlobalError(""); }}
                style={{ padding: "12px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
              >
                Jalankan Setup Lagi
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
