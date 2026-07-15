import Link from "next/link";

const card: React.CSSProperties = {
  display: "block", padding: 32, borderRadius: 12, border: "1px solid var(--border-color)",
  background: "var(--bg-surface)",
  textDecoration: "none", color: "inherit", width: 320,
};

export default function Home() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}>
      <Link href="/drafter" style={card}>
        <h2 style={{ marginTop: 0, color: "var(--accent-gold)" }}>Litigation Drafter</h2>
        <p style={{ color: "var(--text-muted)" }}>Analisis perkara & penyusunan dokumen litigasi dari data room SharePoint.</p>
      </Link>
      <Link href="/dd" style={card}>
        <h2 style={{ marginTop: 0, color: "var(--accent-gold)" }}>Uji Tuntas (Due Diligence)</h2>
        <p style={{ color: "var(--text-muted)" }}>Pemetaan data room, analisis gap, tabel ketentuan kunci, dan temuan LDD.</p>
      </Link>
    </div>
  );
}
