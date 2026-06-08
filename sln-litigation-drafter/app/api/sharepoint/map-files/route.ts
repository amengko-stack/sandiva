import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType } from "@/types";

export const maxDuration = 60;

const DOC_TYPE_CONTEXT: Record<string, string> = {
  gugatan: `Kami sedang menyusun GUGATAN (permohonan awal ke pengadilan). Drafter telah memilih file yang relevan. File KRITIS: perjanjian/kontrak yang dilanggar, somasi, bukti transaksi pembayaran, surat keberatan, korespondensi pra-litigasi. File PENDUKUNG: akta pendirian, laporan keuangan, dokumen pengiriman. File REFERENSI: putusan yang serupa.`,
  jawaban: `Kami sedang menyusun JAWABAN (respons tergugat). Drafter telah memilih file yang relevan. File KRITIS: gugatan penggugat, perjanjian yang dipersengketakan, bukti pelaksanaan kewajiban, korespondensi yang membantah dalil gugatan. File PENDUKUNG: laporan keuangan, dokumen internal. File REFERENSI: putusan serupa. Somasi hanya PENDUKUNG kecuali menjadi dasar eksepsi.`,
  replik: `Kami sedang menyusun REPLIK (respons penggugat atas jawaban). Drafter telah memilih file yang relevan. File KRITIS: gugatan asli, jawaban tergugat, bukti baru yang merespons bantahan jawaban. File PENDUKUNG: korespondensi yang tidak disertakan di gugatan. File REFERENSI: putusan. Somasi hanya REFERENSI di tahap ini.`,
  duplik: `Kami sedang menyusun DUPLIK (respons tergugat atas replik). Drafter telah memilih file yang relevan. File KRITIS: jawaban tergugat, replik penggugat, bukti baru yang merespons replik. File PENDUKUNG: dokumen yang memperkuat bantahan. File REFERENSI: putusan. Kontrak sudah didalilkan, statusnya PENDUKUNG.`,
  kesimpulan: `Kami sedang menyusun KESIMPULAN (kesimpulan akhir). Drafter telah memilih file yang relevan. File KRITIS: semua putusan/penetapan yang diajukan selama persidangan, rangkuman bukti yang telah diverifikasi. File PENDUKUNG: dokumen yang sudah diverifikasi hakim. File REFERENSI: segala dokumen yang sudah ada di berkas perkara.`,
  permohonan_pkpu: `Kami sedang menyusun PERMOHONAN PKPU. Drafter telah memilih file yang relevan. File KRITIS: perjanjian kredit/utang, bukti jumlah utang, bukti jatuh tempo, daftar kreditur lain (untuk 2-creditor test), neraca/laporan keuangan terkini. File PENDUKUNG: korespondensi dengan kreditur, dokumen jaminan. File REFERENSI: akta pendirian, izin usaha.`,
  permohonan_pailit: `Kami sedang menyusun PERMOHONAN PAILIT. Drafter telah memilih file yang relevan. File KRITIS: bukti utang yang telah jatuh tempo dan dapat ditagih, bukti minimal 2 kreditur (atau satu dengan bukti insolvency), putusan pengadilan yang menguatkan tagihan. File PENDUKUNG: laporan keuangan, aset-aset debitur. File REFERENSI: akta pendirian.`,
  jawaban_pkpu: `Kami sedang menyusun JAWABAN PKPU/PAILIT. Drafter telah memilih file yang relevan. File KRITIS: permohonan PKPU/pailit, bukti pelunasan atau dispute atas utang, bukti solvabilitas. File PENDUKUNG: laporan keuangan yang menunjukkan kemampuan bayar, rencana restrukturisasi awal. File REFERENSI: akta pendirian, perjanjian kredit.`,
  rencana_perdamaian: `Kami sedang menyusun RENCANA PERDAMAIAN. Drafter telah memilih file yang relevan. File KRITIS: daftar kreditur terverifikasi, jumlah tagihan masing-masing, proyeksi arus kas, aset yang tersedia. File PENDUKUNG: laporan keuangan historis, perjanjian dengan kreditur utama. File REFERENSI: permohonan PKPU, penetapan pengurus.`,
  kesimpulan_pkpu: `Kami sedang menyusun KESIMPULAN PKPU/PAILIT. Drafter telah memilih file yang relevan. File KRITIS: semua penetapan hakim pengawas, tagihan yang diverifikasi/dibantah, putusan pengesahan/penolakan perdamaian. File PENDUKUNG: laporan pengurus/kurator. File REFERENSI: semua dokumen yang sudah ada di berkas.`,
  surat_tuntutan: `Kami sedang menyusun SURAT TUNTUTAN dalam arbitrase. File KRITIS: perjanjian/kontrak yang mengandung klausul arbitrase, bukti pelanggaran kontrak, bukti kerugian yang dikuantifikasi, korespondensi pre-arbitrase. File PENDUKUNG: faktur, laporan keuangan, bukti transaksi terkait. File REFERENSI: akta pendirian, putusan arbitrase sejenis.`,
  statement_of_defense: `Kami sedang menyusun STATEMENT OF DEFENSE dalam arbitrase. File KRITIS: Surat Tuntutan (Request for Arbitration), perjanjian yang dipersengketakan, bukti pelaksanaan kewajiban oleh Respondent, korespondensi yang membantah klaim. File PENDUKUNG: laporan internal, dokumen teknis. File REFERENSI: putusan arbitrase sejenis.`,
  reply_arb: `Kami sedang menyusun REPLY dalam arbitrase. File KRITIS: Statement of Defense, bukti baru yang merespons bantahan Respondent, klarifikasi atas klaim yang dipermasalahkan. File PENDUKUNG: korespondensi tambahan. File REFERENSI: putusan yang mendukung posisi Claimant.`,
  rejoinder: `Kami sedang menyusun REJOINDER dalam arbitrase. File KRITIS: Reply Claimant, bukti baru yang merespons Reply, dokumen yang memperkuat pertahanan Respondent. File PENDUKUNG: dokumen teknis atau ahli. File REFERENSI: putusan arbitrase yang mendukung Respondent.`,
  closing_submission: `Kami sedang menyusun CLOSING SUBMISSION dalam arbitrase. File KRITIS: seluruh transcript sidang, semua bukti yang telah diajukan, laporan ahli yang diverifikasi, ringkasan fakta terbukti. File PENDUKUNG: dokumen yang sudah ada di berkas perkara. File REFERENSI: putusan arbitrase internasional yang relevan.`,
};

const SYSTEM_PROMPT = `Anda adalah asisten hukum senior di firma hukum Indonesia. Tugas Anda: mengkategorikan daftar file berdasarkan nama file dan konteks perkara.

Drafter telah memilih file yang relevan — semua file yang dikirim dianggap relevan dengan perkara ini.

Untuk setiap file, tentukan:
1. category: "KRITIS" | "PENDUKUNG" | "REFERENSI"
2. documentType: "perjanjian_kontrak" | "putusan_penetapan" | "surat_menyurat" | "bukti_transaksi" | "dokumen_korporasi" | "tidak_dikenali"
3. reasoning: satu kalimat singkat dalam Bahasa Indonesia menjelaskan alasan kategorisasi

Aturan kategorisasi:
- KRITIS: harus dibaca untuk menyusun dokumen ini, tanpanya argumen utama tidak dapat dibuat
- PENDUKUNG: memperkuat argumen, baca jika waktu memungkinkan
- REFERENSI: latar belakang saja, tidak perlu dibaca penuh

Kembalikan HANYA array JSON tanpa markdown code fence, dengan format:
[{"fileId":"...","category":"...","documentType":"...","reasoning":"..."},...]`;

export async function POST(req: NextRequest) {
  try {
    const { files, docTypeId, claimType } = (await req.json()) as {
      files: FileEntry[];
      docTypeId: string;
      claimType: string | null;
    };

    if (!files?.length) {
      return NextResponse.json({ error: "files wajib diisi" }, { status: 400 });
    }

    const docContext = DOC_TYPE_CONTEXT[docTypeId] ?? `Kami sedang menyusun dokumen litigasi jenis: ${docTypeId}.`;
    const claimContext = claimType ? ` Jenis klaim: ${claimType}.` : "";

    const fileList = files
      .map((f) => `- id: "${f.id}" | nama: "${f.name}" | ukuran: ${f.size || "tidak diketahui"} | tipe: ${f.type}`)
      .join("\n");

    const userPrompt = `Konteks perkara:
${docContext}${claimContext}

Daftar file yang ditemukan di folder SharePoint:
${fileList}

Kategorikan setiap file. Kembalikan array JSON.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content.find((b) => b.type === "text")?.text ?? "[]";

    let parsed: DocMapEntry[];
    try {
      // Strip any accidental markdown fences
      const clean = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
      const arr = JSON.parse(clean) as {
        fileId: string;
        category: string;
        documentType: string;
        reasoning: string;
      }[];

      // Validate and coerce each entry; fill missing files with TIDAK_RELEVAN
      const mapped = new Map(arr.map((e) => [e.fileId, e]));
      parsed = files.map((f) => {
        const entry = mapped.get(f.id);
        return {
          fileId: f.id,
          category: (entry?.category as DocCategory) ?? "TIDAK_RELEVAN",
          documentType: (entry?.documentType as DocDocumentType) ?? "tidak_dikenali",
          reasoning: entry?.reasoning ?? "Tidak teridentifikasi oleh AI.",
        };
      });
    } catch {
      // Fallback: mark everything as PENDUKUNG if JSON parse fails
      parsed = files.map((f) => ({
        fileId: f.id,
        category: "PENDUKUNG" as DocCategory,
        documentType: "tidak_dikenali" as DocDocumentType,
        reasoning: "Gagal menganalisis — dikategorikan sebagai PENDUKUNG secara default.",
      }));
    }

    return NextResponse.json({ map: parsed });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
