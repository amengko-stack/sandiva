import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis } from "@/types";

const ANALYSIS_SYSTEM = `Kamu adalah senior litigator Indonesia dengan keahlian dalam hukum perdata dan kepailitan.
Tugasmu adalah membaca dokumen perkara dan menghasilkan analisis kasus yang akurat dan tajam.
Jangan mengarang fakta. Jika informasi tidak tersedia dalam dokumen, nyatakan sebagai [TIDAK DITEMUKAN].
Selalu tulis dalam Bahasa Indonesia formal.
Kembalikan HANYA JSON yang valid, tidak ada teks lain.`;

const ELEMENT_MAP: Record<string, string> = {
  pmh: `ELEMEN HUKUM (PMH — Pasal 1365 KUH Perdata):
1. Perbuatan melawan hukum: perbuatan konkret tergugat yang melanggar hukum/hak/kesusilaan
2. Kesalahan: disengaja atau karena kelalaian?
3. Kerugian: materiil dan/atau immateriil — dengan angka jika ada
4. Kausalitas: nexus langsung antara perbuatan dan kerugian`,

  wanprestasi: `ELEMEN HUKUM (Wanprestasi — Pasal 1243 KUH Perdata):
1. Perjanjian sah: nomor, tanggal, para pihak, objek, nilai
2. Kewajiban tergugat: kewajiban spesifik berdasarkan perjanjian
3. Wanprestasi: bagaimana tergugat gagal memenuhi kewajiban
4. Somasi: ada/tidaknya somasi, tanggal dan nomor jika ada
5. Kerugian: kerugian akibat wanprestasi — dengan angka jika ada`,

  pkpu: `ELEMEN HUKUM (PKPU — UU No. 37/2004 Pasal 222):
1. Identitas Debitor dan Kreditor
2. Nilai utang dan tanggal jatuh tempo
3. Kondisi keuangan Debitor (mampu/tidak memperkirakan membayar)
4. Prospek perdamaian
5. Jumlah Kreditor (lebih dari satu?)`,

  pailit: `ELEMEN HUKUM (Kepailitan — UU No. 37/2004 Pasal 2 ayat 1):
1. Jumlah Kreditor (minimal 2)
2. Utang yang jatuh waktu dan dapat ditagih
3. Fakta tidak terbayarnya utang
4. Pembuktian sederhana (Pasal 8 ayat 4)`,
};

const DOC_TYPE_CONTEXT: Record<string, string> = {
  gugatan: "Analisis untuk menyusun GUGATAN. Fokus pada kekuatan dalil penggugat.",
  jawaban: "Analisis untuk menyusun JAWABAN. Fokus pada kelemahan gugatan dan argumen bantahan.",
  replik: "Analisis untuk menyusun REPLIK. Fokus pada apa yang dibantah tergugat dan cara meresponsnya.",
  duplik: "Analisis untuk menyusun DUPLIK. Fokus pada kelemahan replik dan penguatan jawaban.",
  kesimpulan: "Analisis untuk menyusun KESIMPULAN. Fokus pada fakta yang terbukti vs yang tidak.",
  permohonan_pkpu: "Analisis untuk menyusun PERMOHONAN PKPU. Fokus pada kondisi keuangan Debitor dan prospek perdamaian.",
  permohonan_pailit: "Analisis untuk menyusun PERMOHONAN PAILIT. Fokus pada terpenuhinya syarat Pasal 2 ayat 1 UU 37/2004.",
  jawaban_pkpu: "Analisis untuk menyusun JAWABAN atas Permohonan PKPU/Pailit. Fokus pada kelemahan permohonan.",
  rencana_perdamaian: "Analisis untuk menyusun RENCANA PERDAMAIAN. Fokus pada kondisi keuangan dan kelayakan rencana restrukturisasi.",
  kesimpulan_pkpu: "Analisis untuk menyusun KESIMPULAN dalam perkara PKPU/Kepailitan.",
};

export async function analyzeCase(
  documentTexts: { name: string; content: string }[],
  docTypeId: string,
  claimType: string | null,
  memoryContext: string
): Promise<CaseAnalysis> {
  const combined = documentTexts
    .map((d) => `\n\n=== DOKUMEN: ${d.name} ===\n${d.content}`)
    .join("\n");

  const elementMap =
    ELEMENT_MAP[claimType || "pmh"] ||
    ELEMENT_MAP[docTypeId] ||
    ELEMENT_MAP.pmh;

  const context = DOC_TYPE_CONTEXT[docTypeId] || "";

  const prompt = `
${context}

DOKUMEN PERKARA:
${combined}

KONVENSI FIRMA (untuk referensi):
${memoryContext}

---

Berdasarkan dokumen di atas, buat analisis kasus dan kembalikan HANYA JSON berikut (tanpa markdown, tanpa penjelasan):

{
  "identitasPihak": "...",
  "hubunganHukum": "...",
  "kronologi": "...",
  "elemenHukum": "...",
  "analisisElemen": "...",
  "buktiKunci": "...",
  "kelemahanGaps": "...",
  "posisiHukum": "..."
}

Panduan per field:
- identitasPihak: Penggugat/Pemohon (nama, identitas) dan Tergugat/Termohon (nama, identitas)
- hubunganHukum: Hubungan hukum antar pihak — perjanjian, bisnis, dll
- kronologi: Timeline fakta material dari dokumen — tanggal, kejadian, pelaku
- elemenHukum: ${elementMap}
- analisisElemen: Per elemen: terbukti/tidak dari dokumen? Kuat atau lemah?
- buktiKunci: Dokumen mana yang paling krusial dan mengapa
- kelemahanGaps: Fakta/bukti yang tidak ada tapi seharusnya ada. Apa yang perlu dikonfirmasi?
- posisiHukum: Rekomendasi posisi hukum terkuat berdasarkan dokumen yang tersedia
`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: ANALYSIS_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content.find((b) => b.type === "text")?.text || "{}";

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        identitasPihak: parsed.identitasPihak || "",
        hubunganHukum: parsed.hubunganHukum || "",
        kronologi: parsed.kronologi || "",
        elemenHukum: parsed.elemenHukum || "",
        analisisElemen: parsed.analisisElemen || "",
        buktiKunci: parsed.buktiKunci || "",
        kelemahanGaps: parsed.kelemahanGaps || "",
        posisiHukum: parsed.posisiHukum || "",
      };
    }
  } catch {}

  return {
    identitasPihak: "[Tidak dapat diparsing]",
    hubunganHukum: raw.slice(0, 500),
    kronologi: "",
    elemenHukum: "",
    analisisElemen: "",
    buktiKunci: "",
    kelemahanGaps: "",
    posisiHukum: "",
  };
}
