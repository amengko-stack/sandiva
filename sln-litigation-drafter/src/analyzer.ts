import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis } from "@/types";

const ANALYSIS_SYSTEM = `Kamu adalah senior litigator Indonesia dengan keahlian dalam hukum perdata dan kepailitan.
Tugasmu adalah membaca dokumen perkara dan menghasilkan analisis kasus yang akurat dan tajam.
Jangan mengarang fakta. Jika informasi tidak tersedia dalam dokumen, nyatakan sebagai [TIDAK DITEMUKAN].
Selalu tulis dalam Bahasa Indonesia formal.
Kembalikan HANYA JSON yang valid, tidak ada teks lain.`;

const ELEMENT_MAP: Record<string, string> = {
  // ── Perdata Umum ────────────────────────────────────────────────────────────
  pmh: `ELEMEN HUKUM (PMH — Pasal 1365 KUH Perdata):
1. Perbuatan melawan hukum: perbuatan konkret tergugat yang melanggar hukum/hak/kesusilaan
2. Kesalahan: disengaja atau karena kelalaian?
3. Kerugian: materiil dan/atau immateriil — dengan angka jika ada
4. Kausalitas: nexus langsung antara perbuatan dan kerugian`,

  pmh_penguasa: `ELEMEN HUKUM (PMH oleh Penguasa / OOD — Pasal 1365 KUH Perdata jo. SEMA):
1. Tindakan pejabat/badan pemerintah yang melanggar hukum
2. Kewenangan yang dilampaui atau disalahgunakan (ultra vires / detournement de pouvoir)
3. Kerugian yang diderita warga/pihak swasta — materiil dan immateriil
4. Kausalitas antara tindakan penguasa dan kerugian`,

  wanprestasi: `ELEMEN HUKUM (Wanprestasi — Pasal 1243 KUH Perdata):
1. Perjanjian sah: nomor, tanggal, para pihak, objek, nilai
2. Kewajiban tergugat: kewajiban spesifik berdasarkan perjanjian
3. Wanprestasi: bagaimana tergugat gagal memenuhi kewajiban
4. Somasi: ada/tidaknya somasi, tanggal dan nomor jika ada
5. Kerugian: kerugian akibat wanprestasi — dengan angka jika ada`,

  pembatalan_perjanjian: `ELEMEN HUKUM (Pembatalan Perjanjian — Pasal 1320 jo. 1449 KUH Perdata):
1. Perjanjian yang dipermasalahkan: nomor, tanggal, objek, nilai
2. Syarat sah perjanjian yang dilanggar (Pasal 1320): sepakat, cakap, hal tertentu, sebab halal
3. Jenis cacat: error, paksaan (dwang), penipuan (bedrog), penyalahgunaan keadaan
4. Akibat hukum yang dimohonkan: batal demi hukum atau dapat dibatalkan`,

  kepemilikan: `ELEMEN HUKUM (Gugatan Kepemilikan / Bezit — Pasal 570 KUH Perdata):
1. Alas hak penggugat atas objek sengketa (sertifikat, akta, warisan)
2. Identifikasi objek: lokasi, luas, batas-batas, nomor sertifikat
3. Tindakan tergugat yang mengganggu kepemilikan / penguasaan
4. Kerugian akibat gangguan kepemilikan`,

  waris: `ELEMEN HUKUM (Gugatan Waris — KUH Perdata Buku II):
1. Hubungan kekeluargaan penggugat dengan pewaris (akta lahir, akta nikah)
2. Identitas pewaris: nama, tanggal meninggal, harta peninggalan
3. Surat keterangan ahli waris atau penetapan pengadilan
4. Harta warisan yang disengketakan: jenis, nilai, penguasaan saat ini
5. Dasar pembagian yang dituntut: KUH Perdata, hukum adat, atau wasiat`,

  piercing: `ELEMEN HUKUM (Tanggung Jawab Korporasi / Piercing the Corporate Veil — Pasal 3 jo. 97 UUPT):
1. Penyalahgunaan badan hukum PT oleh pemegang saham/direksi (alter ego)
2. Tidak dipenuhinya formalities korporasi
3. Kerugian pihak ketiga yang tidak dapat dipulihkan dari aset PT
4. Keterkaitan langsung antara tindakan pribadi dan kerugian`,

  // ── Korporasi ───────────────────────────────────────────────────────────────
  pembatalan_rups: `ELEMEN HUKUM (Pembatalan RUPS — Pasal 61 UUPT):
1. Cacat prosedural penyelenggaraan RUPS (undangan, kuorum, mekanisme)
2. Pelanggaran hak pemegang saham yang dirugikan
3. Keputusan RUPS yang bertentangan dengan anggaran dasar atau UU
4. Kedudukan hukum penggugat sebagai pemegang saham`,

  tanggung_jawab_direksi: `ELEMEN HUKUM (Tanggung Jawab Direksi/Komisaris — Pasal 97 UUPT):
1. Tindakan direksi/komisaris yang melanggar kewajiban fiduciary duty
2. Kerugian perseroan akibat tindakan tersebut
3. Kesalahan atau kelalaian yang tidak dapat dikecualikan business judgment rule
4. Hubungan kausal antara tindakan dan kerugian perseroan`,

  pembubaran_pt: `ELEMEN HUKUM (Pembubaran PT — Pasal 146 UUPT):
1. Dasar permohonan (keputusan RUPS, jangka waktu habis, penetapan pengadilan)
2. Kondisi yang mensyaratkan pembubaran (deadlock, pelanggaran UU, dll)
3. Prosedur dan kewenangan pengadilan untuk membubarkan PT
4. Hak-hak pihak dalam proses likuidasi`,

  gugatan_derivatif: `ELEMEN HUKUM (Gugatan Derivatif — Pasal 61 UUPT):
1. Kedudukan penggugat sebagai pemegang saham (minimal 1/10 saham)
2. Kerugian yang diderita perseroan akibat tindakan direksi/komisaris
3. Upaya yang telah dilakukan melalui mekanisme internal RUPS
4. Dasar hukum tindakan atau kelalaian yang merugikan perseroan`,

  // ── Insolvency ─────────────────────────────────────────────────────────────
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

  actio_pauliana: `ELEMEN HUKUM (Actio Pauliana — Pasal 41 UU 37/2004):
1. Perbuatan hukum Debitor pailit yang merugikan Kreditor (alienasi aset, pembebanan jaminan)
2. Debitor mengetahui atau seharusnya mengetahui kerugian Kreditor
3. Pihak ketiga yang menerima manfaat juga mengetahui kerugian Kreditor
4. Kerugian nyata yang diderita Kreditor akibat perbuatan hukum tersebut`,

  pembatalan_perdamaian: `ELEMEN HUKUM (Pembatalan Perdamaian — Pasal 291 UU 37/2004):
1. Adanya rencana perdamaian yang telah disahkan
2. Kegagalan Debitor memenuhi isi perdamaian (lalai atau wanprestasi)
3. Pembuktian kegagalan pemenuhan kewajiban perdamaian
4. Kondisi yang mengakibatkan status pailit kembali berlaku`,

  // ── HKI ────────────────────────────────────────────────────────────────────
  merek: `ELEMEN HUKUM (Pelanggaran Merek — UU No. 20/2016):
1. Kepemilikan merek terdaftar penggugat (nomor registrasi, tanggal, kelas)
2. Kesamaan pada pokoknya atau keseluruhannya dengan merek tergugat
3. Penggunaan tanpa izin di kelas barang/jasa yang sama/sejenis
4. Kerugian materiil dan immateriil yang diderita pemilik merek`,

  hak_cipta: `ELEMEN HUKUM (Pelanggaran Hak Cipta — UU No. 28/2014):
1. Kepemilikan hak cipta: karya original, penciptaan, identitas pencipta
2. Tindakan reproduksi/distribusi/adaptasi tanpa izin oleh tergugat
3. Tidak ada lisensi atau pengecualian fair use yang berlaku
4. Kerugian ekonomi pencipta/pemegang hak`,

  paten: `ELEMEN HUKUM (Pelanggaran Paten — UU No. 13/2016):
1. Kepemilikan paten terdaftar (nomor, tanggal, lingkup klaim)
2. Klaim paten yang dilanggar: identifikasi klaim spesifik
3. Produk/proses tergugat yang masuk dalam lingkup klaim
4. Penggunaan komersial tanpa lisensi selama masa perlindungan`,

  // ── PTUN ───────────────────────────────────────────────────────────────────
  pembatalan_ktun: `ELEMEN HUKUM (Pembatalan KTUN — UU No. 51/2009):
1. Keputusan TUN yang digugat: nomor, tanggal, penerbit, isi
2. Kedudukan hukum penggugat yang dirugikan (legal standing)
3. Cacat wewenang, prosedur, atau substansi KTUN
4. Tenggang waktu pengajuan gugatan (90 hari sejak diterimanya KTUN)`,

  pmh_pemerintah: `ELEMEN HUKUM (PMH Pemerintah — PERMA 2/2019 jo. Pasal 1365 KUH Perdata):
1. Tindakan pemerintah/badan administrasi yang bersifat faktual (bukan KTUN)
2. Melanggar ketentuan hukum yang berlaku atau asas umum pemerintahan yang baik
3. Kerugian konkret yang diderita warga negara
4. Kausalitas tindakan pemerintah dengan kerugian`,

  // ── Arbitrase ──────────────────────────────────────────────────────────────
  bani: `ELEMEN KLAIM (Arbitrase BANI — UU No. 30/1999):
1. Klausul arbitrase dalam perjanjian yang sah dan mengikat
2. Lingkup sengketa yang masuk yurisdiksi BANI
3. Pelanggaran kontraktual atau dalil klaim yang spesifik
4. Kerugian yang dapat dikuantifikasi dan dimintakan remedy`,

  siac: `ELEMEN KLAIM (Arbitrase SIAC — SIAC Rules 2016):
1. Arbitration agreement referring disputes to SIAC
2. Seat of arbitration and governing law
3. Specific breaches or claims with supporting facts
4. Quantified damages and remedies sought`,

  icc: `ELEMEN KLAIM (Arbitrase ICC — ICC Rules 2021):
1. ICC arbitration clause and agreement to arbitrate
2. Description of the dispute and relevant facts
3. Legal basis of claim: contractual, tortious, or statutory
4. Relief sought: damages, declaration, specific performance`,

  adhoc: `ELEMEN KLAIM (Arbitrase Ad Hoc — UU No. 30/1999):
1. Klausul arbitrase ad hoc dalam perjanjian
2. Komposisi majelis arbitrase yang disepakati
3. Pokok sengketa dan dalil klaim
4. Kerugian dan remedy yang dimintakan`,
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
  surat_tuntutan: "Analisis untuk menyusun SURAT TUNTUTAN dalam arbitrase. Fokus pada kekuatan klaim, dasar kontraktual, dan remedies yang diminta.",
  statement_of_defense: "Analisis untuk menyusun STATEMENT OF DEFENSE dalam arbitrase. Fokus pada kelemahan klaim Claimant dan argumen pertahanan.",
  reply_arb: "Analisis untuk menyusun REPLY dalam arbitrase. Fokus pada bantahan Respondent dan penguatan posisi Claimant.",
  rejoinder: "Analisis untuk menyusun REJOINDER dalam arbitrase. Fokus pada kelemahan Reply dan penguatan pertahanan Respondent.",
  closing_submission: "Analisis untuk menyusun CLOSING SUBMISSION dalam arbitrase. Fokus pada fakta terbukti, argumen hukum terkuat, dan relief yang diminta.",
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
    model: "claude-sonnet-4-6",
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
