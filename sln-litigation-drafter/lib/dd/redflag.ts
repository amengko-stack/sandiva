import Anthropic from "@anthropic-ai/sdk";
import { assignModelFindingIds } from "@/lib/dd/finding-identity";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { redflagSystem, transactionAnalysisSystem } from "@/lib/dd/prompts";
import { transactionLabel } from "@/config/ddTransactionTypes";
import type {
  DDAspectId, DDExtractionRow, DDFinding, DDRegime, DDSeverity, DDSubsectionAnalysis, DDTransactionType,
} from "@/types/dd";

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
  /** Sub-section titles of the analysis chapter this aspect belongs to. */
  subsections?: string[];
}): string {
  // The analysis chapters previously rendered as hollow scaffolding: each
  // sub-section repeated one templated sentence and every finding piled into a
  // single "Temuan" sub-section. The reference report puts real legal analysis
  // under each numbered topic, so the same call now produces that analysis too —
  // no extra model round-trip, just a longer response.
  const subs = args.subsections ?? [];
  const analysisBlock =
    subs.length === 0
      ? ""
      : `
=== SUB-BAGIAN ANALISIS YANG HARUS DIISI ===
${subs.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Untuk SETIAP sub-bagian di atas, tulis analisis hukum yang sesungguhnya — bukan kalimat pengantar. Pola yang wajib diikuti:
(a) sebutkan ketentuan yang berlaku beserta pasalnya bila kamu yakin;
(b) terapkan ketentuan itu pada FAKTA dari dokumen, dengan menyebut nomor dan tanggal akta/dokumennya;
(c) simpulkan apakah fakta tersebut memenuhi ketentuan, dan bila tidak, sebutkan letak ketidaksesuaiannya.
Contoh mutu yang dituju: "Pendirian Perseroan dilakukan sesuai Pasal 7 ayat (1) UUPT yang mensyaratkan paling sedikit dua pendiri. Para pendiri adalah A dan B, keduanya badan hukum Perseroan Terbatas. Akta Pendirian No. 08 tanggal 7 Juli 2017 telah disahkan Menkumham melalui SK AHU-… sebagaimana disyaratkan Pasal 7 ayat (4) UUPT, sehingga Perseroan memperoleh status badan hukum yang sah."
Bila sebuah sub-bagian tidak dapat dianalisis karena dokumennya tidak ada, katakan hal itu secara tegas dan sebutkan dokumen apa yang dibutuhkan — JANGAN menulis kalimat pengantar kosong.
Isi "verification" dengan hal yang belum dapat dipastikan pada sub-bagian itu (boleh kosong).
Sertakan "table" HANYA bila daftar/register lebih mudah dibaca sebagai tabel daripada prosa (mis. daftar RUPS: Tanggal, Jenis, Agenda, Kuorum, Sah?).
Pada setiap temuan, isi "subsection" dengan judul sub-bagian yang paling tepat dari daftar di atas.
`;
  return `Entitas: ${args.entityName}. Aspek: ${args.aspectId.replace(/_/g, " ")}. Transaksi: ${args.transactionType.replace(/_/g, " ")}.
${analysisBlock}

=== DOKUMEN ASPEK INI ===
${args.docsText.slice(0, ASPECT_CHAR_CAP)}
=== AKHIR DOKUMEN ===

Identifikasi red flag hukum yang NYATA dari dokumen di atas untuk transaksi ini (mis. izin kedaluwarsa, modal belum disetor penuh, aset dibebani jaminan, perkara berjalan, ketidaksesuaian anggaran dasar).

PETUNJUK KONSEKUENSI HUKUM UNTUK ASPEK INI: ${ASPECT_SANCTION_HINTS[args.aspectId]}
Isi "legalConsequence" pada SETIAP temuan. Bila ada sanksi, sebutkan sanksinya beserta pasal yang mengaturnya — kutip nomor pasal HANYA bila kamu yakin; bila tidak yakin, sebut peraturannya saja. Bila tidak ada sanksi pidana/administratif, nyatakan hal itu secara tegas lalu sebutkan konsekuensi keperdataan/korporasinya. Kolom ini TIDAK BOLEH kosong dan TIDAK BOLEH diisi sanksi yang kamu karang.

Kembalikan HANYA JSON:
{"findings":[{"severity":"kritis|material|minor","anchor":"kutipan verbatim (maks 40 kata)","sourceFile":"nama file","problem":"masalahnya","whyItMatters":"dampaknya bagi transaksi","legalConsequence":"sanksi beserta pasalnya, ATAU pernyataan tegas bahwa tidak ada sanksi + konsekuensi keperdataannya","suggestedFix":"tindak lanjut","subsection":"judul sub-bagian","regulationRefs":["UU 40/2007 Pasal 94 ayat (1)"]}],
 "analisis":[{"subsection":"judul sub-bagian persis seperti daftar","analysis":["paragraf 1","paragraf 2"],"verification":["hal yang perlu diverifikasi"],"table":{"headers":["..."],"rows":[["..."]]}}]}
Bila tidak ada red flag, kembalikan {"findings":[]} namun TETAP isi "analisis".`;
}

export interface DDAspectAnalysisResult {
  findings: DDFinding[];
  analyses: DDSubsectionAnalysis[];
}

/** Parse the sub-section analyses. Unknown sub-section titles are dropped rather
 *  than guessed into a section they may not belong to. */
function parseAnalyses(
  raw: unknown,
  aspectId: DDAspectId,
  allowed: string[]
): DDSubsectionAnalysis[] {
  if (!Array.isArray(raw)) return [];
  const ok = new Set(allowed);
  const out: DDSubsectionAnalysis[] = [];
  for (const item of raw) {
    const o = item as Record<string, unknown>;
    const title = String(o.subsection ?? "").trim();
    if (!title || (allowed.length > 0 && !ok.has(title))) continue;
    const analysis = Array.isArray(o.analysis)
      ? o.analysis.map(String).map((x) => x.trim()).filter(Boolean)
      : [];
    if (analysis.length === 0) continue;
    const verification = Array.isArray(o.verification)
      ? o.verification.map(String).map((x) => x.trim()).filter(Boolean)
      : [];
    const tbl = o.table as Record<string, unknown> | undefined;
    const headers = tbl && Array.isArray(tbl.headers) ? tbl.headers.map(String) : [];
    const rows = tbl && Array.isArray(tbl.rows)
      ? (tbl.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map(String))
      : [];
    out.push({
      aspectId,
      subsectionTitle: title,
      analysis,
      verification,
      table: headers.length > 0 && rows.length > 0 ? { headers, rows } : undefined,
    });
  }
  return out;
}

export function parseRedFlagResponse(
  raw: string,
  stopReason: string | null,
  args: { entityId: string; aspectId: DDAspectId; subsections?: string[] }
): DDAspectAnalysisResult {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error(`Hasil red-flag bukan JSON (${args.aspectId})`);
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: { findings?: unknown[]; analisis?: unknown[] };
  try {
    p = JSON.parse(jsonStr);
  } catch {
    p = JSON.parse(repairTruncatedJson(jsonStr));
  }
  if (!Array.isArray(p.findings)) throw new Error(`Hasil red-flag tanpa "findings" (${args.aspectId})`);

  // Ids are assigned after mapping, from each finding's own content, so a re-run
  // of the same issue keeps the same id and the lawyer's review survives it. See
  // lib/dd/finding-identity.ts.
  const parsed = p.findings.map((f) => {
    const o = f as Record<string, unknown>;
    const sev = String(o.severity ?? "");
    return {
      id: "",
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
      subsectionTitle: o.subsection ? String(o.subsection) : undefined,
      regulationRefs: Array.isArray(o.regulationRefs) ? o.regulationRefs.map(String) : undefined,
      verified: false,
      status: "open" as const,
    };
  });

  const ids = assignModelFindingIds(parsed);
  const findings = parsed.map((f, i) => ({ ...f, id: ids[i] }));

  return {
    findings,
    analyses: parseAnalyses(p.analisis, args.aspectId, args.subsections ?? []),
  };
}

/**
 * Analysis for the transaction chapters, whose sub-sections belong to no aspect.
 *
 * One call for all of them: they share a subject — whether the steps this
 * transaction requires have been taken — so splitting them per sub-section would
 * ask the model the same question repeatedly against the same documents.
 */
export async function analyzeTransactionChapters(
  client: Anthropic,
  args: {
    entityId: string; entityName: string; docsText: string;
    transactionType: DDTransactionType; regime: DDRegime; subsections: string[];
  }
): Promise<DDSubsectionAnalysis[]> {
  if (args.subsections.length === 0) return [];
  const prompt = `PERSEROAN: ${args.entityName}
RENCANA TRANSAKSI: ${transactionLabel(args.transactionType)}

SUB-BAGIAN YANG HARUS DIISI (gunakan judul persis seperti tertulis):
${args.subsections.map((t, i) => `${i + 1}. ${t}`).join("\n")}

=== DOKUMEN ===
${args.docsText.slice(0, 220_000)}
=== AKHIR DOKUMEN ===

Kembalikan HANYA JSON:
{"analyses":[{"subsectionTitle":"judul persis","analysis":["paragraf 1","paragraf 2"],"verification":["hal yang belum dapat dipastikan"],"table":{"headers":["..."],"rows":[["..."]]}}]}
"table" bersifat opsional; sertakan hanya bila daftar lebih terbaca daripada prosa.`;

  const response = await client.messages.create({
    model: MODELS.ddRedFlag,
    max_tokens: 8000,
    system: transactionAnalysisSystem(args.regime, args.entityName),
    messages: [{ role: "user", content: prompt }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Analisis bab transaksi bukan JSON");
  let jsonStr = match[0];
  if (response.stop_reason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let parsed: { analyses?: unknown[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = JSON.parse(repairTruncatedJson(jsonStr));
  }
  const wanted = new Set(args.subsections);
  const out: DDSubsectionAnalysis[] = [];
  for (const a of parsed.analyses ?? []) {
    const o = a as Record<string, unknown>;
    const title = String(o.subsectionTitle ?? "");
    // Only titles the plan actually contains: an invented heading would be dropped
    // silently by the builder, which places analyses by title.
    if (!wanted.has(title)) continue;
    const analysis = Array.isArray(o.analysis) ? o.analysis.map((x) => String(x)).filter((x) => x.trim() !== "") : [];
    if (analysis.length === 0) continue;
    const verification = Array.isArray(o.verification) ? o.verification.map((x) => String(x)) : [];
    const t = o.table as { headers?: unknown[]; rows?: unknown[] } | undefined;
    const table =
      t && Array.isArray(t.headers) && Array.isArray(t.rows)
        ? {
            headers: t.headers.map((x) => String(x)),
            rows: (t.rows as unknown[][]).map((row) => (Array.isArray(row) ? row.map((c) => String(c)) : [])),
          }
        : undefined;
    out.push({ aspectId: "transaksi", subsectionTitle: title, analysis, verification, table });
  }
  return out;
}

export async function analyzeAspect(
  client: Anthropic,
  args: {
    entityId: string; entityName: string; aspectId: DDAspectId;
    docsText: string; transactionType: DDTransactionType; regime: DDRegime;
    subsections?: string[];
  }
): Promise<DDAspectAnalysisResult> {
  const response = await client.messages.create({
    model: MODELS.ddRedFlag,
    // Higher than before: the same call now returns per-sub-section analysis
    // alongside the findings, which is most of the report body.
    max_tokens: 8000,
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
