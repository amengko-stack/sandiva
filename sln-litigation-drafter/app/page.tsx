import Link from "next/link";

const card: React.CSSProperties = {
  display: "block", padding: 32, borderRadius: 12, border: "1px solid #e5e7eb",
  textDecoration: "none", color: "inherit", width: 320,
};

export default function Home() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}>
      <Link href="/drafter" style={card}>
        <h2 style={{ marginTop: 0 }}>Litigation Drafter</h2>
        <p>Analisis perkara & penyusunan dokumen litigasi dari data room SharePoint.</p>
      </Link>
      <Link href="/dd" style={card}>
        <h2 style={{ marginTop: 0 }}>Uji Tuntas (Due Diligence)</h2>
        <p>Pemetaan data room, analisis gap, tabel ketentuan kunci, dan temuan LDD.</p>
      </Link>
    </div>
  );
}
