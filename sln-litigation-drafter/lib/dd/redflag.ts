import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { redflagSystem } from "@/lib/dd/prompts";
import type { DDAspectId, DDExtractionRow, DDFinding, DDRegime, DDSeverity, DDTransactionType } from "@/types/dd";

const ASPECT_CHAR_CAP = 40_000;
const SEVERITIES = new Set(["kritis", "material", "minor"]);

/**
 * Where sanctions for each aspect typically live. This grounds the
 * legalConsequence field: without it the model either omitted the consequence
 * or would have had to guess at an instrument. Instruments only — the model is
 * told to cite an article only where it actually knows it, because a wrong
 * article in a client report is worse than a general citation.
 */
const ASPECT_SANCTION_HINTS: Record<DDAspectId, string> = {
  pendirian_ad:
    "Pelanggaran anggaran dasar umumnya TIDAK diancam sanksi pidana atau administratif; konsekuensinya keperdataan/korporasi — keabsahan tindakan korporasi, dan tanggung jawab pribadi anggota Direksi (UUPT Pasal 97) atau Dewan Komisaris (UUPT Pasal 114) atas kesalahan/kelalaian.",
  permodalan_saham:
    "Kekurangan penyetoran modal dan cacat pengalihan saham umumnya berkonsekuensi keperdataan — keabsahan kepemilikan, tanggung jawab pemegang saham atas kekurangan setoran — bukan sanksi pidana.",
  pengurus:
    "Cacat pengangkatan/kewenangan pengurus umumnya berkonsekuensi keperdataan atas keabsahan tindakan korporasi, disertai tanggung jawab pribadi pengurus (UUPT Pasal 97 dan Pasal 114).",
  perizinan:
    "Ketiadaan atau kedaluwarsanya perizinan berusaha umumnya diancam SANKSI ADMINISTRATIF bertingkat (teguran tertulis, denda, penghentian sementara kegiatan, pencabutan izin) menurut PP 5/2021 dan peraturan sektoral terkait.",
  harta_kekayaan:
    "Jaminan fidusia yang tidak didaftarkan tidak melahirkan hak kebendaan (UU 42/1999 Pasal 14 ayat (3)); hak tanggungan lahir pada saat pendaftaran (UU 4/1996). Konsekuensinya kebendaan/keperdataan.",
  perjanjian_penting:
    "Pelanggaran ketentuan perjanjian berkonsekuensi WANPRESTASI: ganti rugi (KUHPerdata Pasal 1243), percepatan pelunasan, atau pengakhiran perjanjian — bukan sanksi publik.",
  ketenagakerjaan:
    "Pelanggaran ketenagakerjaan dapat diancam sanksi administratif maupun pidana menurut UU 13/2003 (sebagaimana diubah oleh UU 6/2023) dan peraturan pelaksananya.",
  perpajakan:
    "Pelanggaran kewajiban perpajakan umumnya diancam SANKSI ADMINISTRASI berupa bunga, denda, atau kenaikan menurut UU 28/2007 (KUP) sebagaimana telah diubah, terakhir oleh UU 7/2021 (Harmonisasi Peraturan Perpajakan). PENTING: UU 7/2021 mengubah tarif dan rumusan sanksi dalam KUP (antara lain menggantikan beberapa sanksi kenaikan dengan sanksi bunga berdasarkan suku bunga acuan). JANGAN menyebutkan persentase sanksi tertentu kecuali kamu yakin persentase itu masih berlaku setelah UU 7/2021; bila tidak yakin, sebut jenis sanksinya tanpa angka dan tambahkan \"[PERLU VERIFIKASI — tarif sanksi setelah UU 7/2021]\".",
  asuransi:
    "Premi yang tidak dilunasi atau perubahan tertanggung yang tidak dilaporkan berkonsekuensi batalnya/berakhirnya pertanggungan — konsekuensi kontraktual, bukan sanksi publik.",
  perkara:
    "Perkara berjalan umumnya tidak menimbulkan sanksi tersendiri; konsekuensinya risiko eksekusi putusan, sita jaminan, dan kewajiban pengungkapan kepada pembeli.",
};

export function buildRedFlagPrompt(args: {
  entityName: string; aspectId: DDAspectId; docsText: string; transactionType: DDTransactionType;
}): string {
  return `Entitas: ${args.entityName}. Aspek: ${args.aspectId.replace(/_/g, " ")}. Transaksi: ${args.transactionType.replace(/_/g, " ")}.

=== DOKUMEN ASPEK INI ===
${args.docsText.slice(0, ASPECT_CHAR_CAP)}
=== AKHIR DOKUMEN ===

Identifikasi red flag hukum yang NYATA dari dokumen di atas untuk transaksi ini (mis. izin kedaluwarsa, modal belum disetor penuh, aset dibebani jaminan, perkara berjalan, ketidaksesuaian anggaran dasar).

PETUNJUK KONSEKUENSI HUKUM UNTUK ASPEK INI: ${ASPECT_SANCTION_HINTS[args.aspectId]}
Isi "legalConsequence" pada SETIAP temuan. Bila ada sanksi, sebutkan sanksinya beserta pasal yang mengaturnya — kutip nomor pasal HANYA bila kamu yakin; bila tidak yakin, sebut peraturannya saja. Bila tidak ada sanksi pidana/administratif, nyatakan hal itu secara tegas lalu sebutkan konsekuensi keperdataan/korporasinya. Kolom ini TIDAK BOLEH kosong dan TIDAK BOLEH diisi sanksi yang kamu karang.

Kembalikan HANYA JSON:
{"findings":[{"severity":"kritis|material|minor","anchor":"kutipan verbatim (maks 40 kata)","sourceFile":"nama file","problem":"masalahnya","whyItMatters":"dampaknya bagi transaksi","legalConsequence":"sanksi beserta pasalnya, ATAU pernyataan tegas bahwa tidak ada sanksi + konsekuensi keperdataannya","suggestedFix":"tindak lanjut","regulationRefs":["UU 40/2007 Pasal 94 ayat (1)"]}]}
Bila tidak ada red flag, kembalikan {"findings":[]}.`;
}

export function parseRedFlagResponse(
  raw: string,
  stopReason: string | null,
  args: { entityId: string; aspectId: DDAspectId }
): DDFinding[] {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error(`Hasil red-flag bukan JSON (${args.aspectId})`);
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: { findings?: unknown[] };
  try {
    p = JSON.parse(jsonStr);
  } catch {
    p = JSON.parse(repairTruncatedJson(jsonStr));
  }
  if (!Array.isArray(p.findings)) throw new Error(`Hasil red-flag tanpa "findings" (${args.aspectId})`);

  return p.findings.map((f, n) => {
    const o = f as Record<string, unknown>;
    const sev = String(o.severity ?? "");
    return {
      id: `${args.entityId}-risiko-${args.aspectId}-${n}`,
      entityId: args.entityId,
      aspectId: args.aspectId,
      dimension: "risiko" as const,
      severity: (SEVERITIES.has(sev) ? sev : "material") as DDSeverity,
      anchor: String(o.anchor ?? ""),
      sourceFile: o.sourceFile ? String(o.sourceFile) : null,
      problem: String(o.problem ?? ""),
      whyItMatters: String(o.whyItMatters ?? ""),
      suggestedFix: String(o.suggestedFix ?? ""),
      // Absence is recorded rather than silently tolerated, so a run that drops
      // the field is measurable instead of merely producing weaker findings.
      legalConsequence: o.legalConsequence ? String(o.legalConsequence) : undefined,
      regulationRefs: Array.isArray(o.regulationRefs) ? o.regulationRefs.map(String) : undefined,
      verified: false,
      status: "open" as const,
    };
  });
}

export async function analyzeAspect(
  client: Anthropic,
  args: {
    entityId: string; entityName: string; aspectId: DDAspectId;
    docsText: string; transactionType: DDTransactionType; regime: DDRegime;
  }
): Promise<DDFinding[]> {
  const response = await client.messages.create({
    model: MODELS.ddRedFlag,
    max_tokens: 3000,
    system: redflagSystem(args.regime, args.entityName),
    messages: [{ role: "user", content: buildRedFlagPrompt(args) }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseRedFlagResponse(raw, response.stop_reason, args);
}

// Every deal-triggered cell is already a risk — promote it without a model call.
export function promoteDealTriggeredCells(rows: DDExtractionRow[], entityId: string): DDFinding[] {
  const out: DDFinding[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.dealTriggered) continue;
      out.push({
        id: `${entityId}-risiko-cell-${row.groupId}-${cell.fieldId}`,
        entityId,
        aspectId: "perjanjian_penting",
        dimension: "risiko",
        severity: "material",
        anchor: cell.verbatim,
        sourceFile: cell.sourceFile || row.memberFiles[0] || null,
        problem: `Klausul "${cell.fieldId.replace(/_/g, " ")}" dalam ${row.agreementLabel} terpicu oleh transaksi ini: ${cell.value}`,
        whyItMatters: "Klausul ini dapat mensyaratkan persetujuan/pemberitahuan pihak ketiga atau memicu wanprestasi bila transaksi dilanjutkan tanpa penanganan.",
        legalConsequence:
          "Tidak terdapat sanksi pidana atau administratif; konsekuensinya bersifat kontraktual — wanprestasi yang dapat menimbulkan kewajiban ganti rugi (KUHPerdata Pasal 1243), percepatan pelunasan, atau pengakhiran perjanjian oleh pihak lawan.",
        suggestedFix: "Masukkan sebagai condition precedent: minta persetujuan/waiver tertulis sebelum closing.",
        verified: false,
        status: "open",
      });
    }
  }
  return out;
}
