import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { DD_DATA_FRAMING } from "@/lib/dd/prompts";
import type {
  DDCapitalEntry,
  DDClassifiedDoc,
  DDDeedRef,
  DDNarrativeNote,
  DDNarrativeSectionI,
  DDOfficerEntry,
  DDShareholderEntry,
} from "@/types/dd";

const NARRATIVE_CHAR_CAP = 100_000; // Bagian I aspects only, but includes full deed text — generous cap

const SECTION_I_ASPECTS = new Set(["pendirian_ad", "permodalan_saham", "pengurus"]);

const NOTE_ANCHORS = new Set([
  "pendirian",
  "anggaran_dasar",
  "kegiatan_usaha",
  "permodalan",
  "lainnya",
  "pemegang_saham",
  "pengurus",
]);

export function narrativeSystem(): string {
  return `Kamu adalah associate senior yang menyusun Bagian I (Pendirian, Anggaran Dasar, Kegiatan Usaha, Permodalan, Pemegang Saham, Direksi dan Dewan Komisaris) dari laporan uji tuntas hukum untuk perusahaan Indonesia.
Tugasmu BUKAN mendaftar dokumen, melainkan mengekstrak fakta dan rantai kutipan yang akan dirangkai menjadi narasi deskriptif oleh proses lain. Setiap akta HARUS disertai kutipan verbatim untuk atribusi.
JANGAN mengarang nomor akta, nomor keputusan Menkumham, nomor pendaftaran, atau nomor BNRI. Bila dokumen tidak menyebutkan suatu rujukan, kembalikan string kosong "" untuk field itu — JANGAN menyimpulkan atau menerka.
Bahasa Indonesia formal. Nama dokumen dan nama pihak TIDAK diterjemahkan.
${DD_DATA_FRAMING}`;
}

export function buildNarrativePrompt(args: {
  entityName: string;
  docsText: string;
}): string {
  return `Entitas: ${args.entityName}.

=== DOKUMEN BAGIAN I (Pendirian, Anggaran Dasar, Permodalan, Pemegang Saham, Direksi & Dewan Komisaris) ===
${args.docsText.slice(0, NARRATIVE_CHAR_CAP)}
=== AKHIR DOKUMEN ===

Ekstrak fakta berikut dari dokumen di atas.

1. PENDIRIAN: akta pendirian (jika ada dalam dokumen yang diperiksa).
2. PERUBAHAN ANGGARAN DASAR: SEMUA akta perubahan yang termuat dalam dokumen, diurutkan KRONOLOGIS (dari yang paling lama ke paling baru berdasarkan tanggal akta). Untuk setiap akta, sebutkan SECARA SPESIFIK apa yang diubah oleh akta itu (mis. "perubahan Pasal 3 mengenai maksud dan tujuan; pengangkatan Dewan Komisaris") — bukan sekadar "perubahan anggaran dasar".
3. MAKSUD DAN TUJUAN serta KEGIATAN USAHA sebagaimana dinyatakan dalam anggaran dasar yang berlaku (terbaru), beserta akta/pasal yang menjadi dasarnya.
4. RIWAYAT PERMODALAN: setiap struktur permodalan (modal dasar, modal ditempatkan, modal disetor, jumlah saham, nilai nominal per saham) sebagaimana tertulis di setiap akta yang relevan, diurutkan kronologis. Tuliskan nilai APA ADANYA seperti tertulis di dokumen — JANGAN menghitung ulang atau menormalisasi.
5. PEMEGANG SAHAM: susunan pemegang saham TERKINI (posisi terakhir menurut dokumen), dengan jumlah saham, nilai, dan persentase sebagaimana tertulis, masing-masing disertai akta yang menjadi dasarnya.
6. DIREKSI DAN DEWAN KOMISARIS: susunan TERKINI, masing-masing dengan akta pengangkatan dan masa jabatan (jika disebutkan).
7. CATATAN: identifikasi setiap KESENJANGAN dalam narasi itu sendiri — bukan risiko hukum, tetapi hal yang membuat narasi ini tidak lengkap atau tidak dapat direkonsiliasi: rantai kutipan yang terputus (mis. akta tanpa nomor keputusan Menkumham), ketidaksesuaian angka antar dokumen, atau bukti yang belum tersedia dalam dokumen yang diperiksa (mis. bukti penyetoran modal). Setiap catatan HARUS diberi "anchor" salah satu dari: pendirian, anggaran_dasar, kegiatan_usaha, permodalan, pemegang_saham, pengurus. JANGAN memberi label tingkat keparahan (kritis/material/minor) — itu bukan urusan bagian ini.

ATURAN TAMBAHAN YANG WAJIB DIPATUHI:
(i) SATU AKTA = SATU ENTRI. Bila akta yang sama muncul dalam lebih dari satu berkas sumber (mis. versi "BN" dan versi "SP"), gabungkan menjadi SATU entri dengan rantai kutipan yang paling lengkap dari kedua berkas. JANGAN membuat entri terpisah untuk berkas sumber yang berbeda. Bila kedua berkas berbeda isinya, catat perbedaan itu sebagai "notes" dengan anchor "anggaran_dasar".
(ii) "basis" pada capitalHistory harus berupa RUJUKAN SINGKAT saja, mis. "Akta No. 2/2017" — bukan satu paragraf. Nomor Menkumham dan nama notaris sudah ada di tabel riwayat akta, jadi jangan diulang di sini.
(iii) PENANDA: gunakan HANYA "[DOKUMEN TIDAK TERSEDIA]" bila dokumennya tidak ada, atau "[PERLU VERIFIKASI]" bila ada tetapi belum dapat dipastikan. JANGAN mengarang penanda lain seperti "[TIDAK DITEMUKAN]".

Kembalikan HANYA JSON dengan bentuk berikut. Gunakan "" untuk string yang tidak diketahui dan [] untuk daftar yang kosong. Gunakan null untuk "establishment" bila akta pendirian tidak ada dalam dokumen yang diperiksa.

{
  "establishment": {
    "number": "", "dateISO": "", "notary": "", "purpose": "Pendirian",
    "menkumhamRef": "", "registrationRef": "", "bnriRef": "",
    "sourceFile": "", "verbatim": ""
  } | null,
  "amendments": [
    {
      "number": "", "dateISO": "", "notary": "", "purpose": "apa yang diubah akta ini, spesifik",
      "menkumhamRef": "", "registrationRef": "", "bnriRef": "",
      "sourceFile": "", "verbatim": ""
    }
  ],
  "businessPurpose": "",
  "businessActivities": [""],
  "businessBasis": "",
  "capitalHistory": [
    { "basis": "rujukan singkat, mis. Akta No. 2/2017", "authorized": "", "issued": "", "paidUp": "", "shareCount": "", "nominalPerShare": "", "sourceFile": "" }
  ],
  "shareholders": [
    { "name": "", "shares": "", "amount": "", "percentage": "", "sourceFile": "" }
  ],
  "directors": [
    { "role": "Direktur Utama", "name": "", "appointedBy": "", "termUntil": "", "sourceFile": "" }
  ],
  "commissioners": [
    { "role": "Komisaris", "name": "", "appointedBy": "", "termUntil": "", "sourceFile": "" }
  ],
  "notes": [
    { "anchor": "permodalan", "text": "", "sourceFile": "" }
  ]
}`;
}

function asDeedRef(o: Record<string, unknown>, fallbackPurpose = ""): DDDeedRef {
  return {
    number: String(o.number ?? "").trim(),
    dateISO: String(o.dateISO ?? "").trim(),
    notary: String(o.notary ?? "").trim(),
    purpose: String(o.purpose ?? fallbackPurpose).trim(),
    menkumhamRef: String(o.menkumhamRef ?? "").trim(),
    registrationRef: String(o.registrationRef ?? "").trim(),
    bnriRef: String(o.bnriRef ?? "").trim(),
    sourceFile: String(o.sourceFile ?? "").trim(),
    verbatim: String(o.verbatim ?? "").trim(),
  };
}

function asCapitalEntry(o: Record<string, unknown>): DDCapitalEntry {
  return {
    basis: String(o.basis ?? "").trim(),
    authorized: String(o.authorized ?? "").trim(),
    issued: String(o.issued ?? "").trim(),
    paidUp: String(o.paidUp ?? "").trim(),
    shareCount: String(o.shareCount ?? "").trim(),
    nominalPerShare: String(o.nominalPerShare ?? "").trim(),
    sourceFile: String(o.sourceFile ?? "").trim(),
  };
}

function asShareholderEntry(o: Record<string, unknown>): DDShareholderEntry {
  return {
    name: String(o.name ?? "").trim(),
    shares: String(o.shares ?? "").trim(),
    amount: String(o.amount ?? "").trim(),
    percentage: String(o.percentage ?? "").trim(),
    sourceFile: String(o.sourceFile ?? "").trim(),
  };
}

function asOfficerEntry(o: Record<string, unknown>, fallbackRole: string): DDOfficerEntry {
  return {
    role: String(o.role ?? fallbackRole).trim(),
    name: String(o.name ?? "").trim(),
    appointedBy: String(o.appointedBy ?? "").trim(),
    termUntil: String(o.termUntil ?? "").trim(),
    sourceFile: String(o.sourceFile ?? "").trim(),
  };
}


// ---------------------------------------------------------------------------
// Post-parse normalisation
//
// A live run showed three defects that a prompt instruction alone cannot be
// relied on to prevent — the same lesson as legalConsequence: an instruction
// inside free text is droppable, a normalisation step is not.
// ---------------------------------------------------------------------------

/** The only two markers the report uses. Anything else the model invents is mapped. */
const MARKER_ALIASES: [RegExp, string][] = [
  [/\[\s*TIDAK DITEMUKAN[^\]]*\]/gi, "[DOKUMEN TIDAK TERSEDIA]"],
  [/\[\s*TIDAK ADA DOKUMEN[^\]]*\]/gi, "[DOKUMEN TIDAK TERSEDIA]"],
  [/\[\s*DOKUMEN TIDAK ADA[^\]]*\]/gi, "[DOKUMEN TIDAK TERSEDIA]"],
  [/\[\s*BELUM DIVERIFIKASI[^\]]*\]/gi, "[PERLU VERIFIKASI]"],
  [/\[\s*PERLU DIVERIFIKASI[^\]]*\]/gi, "[PERLU VERIFIKASI]"],
];

export function normaliseMarkers(text: string): string {
  let out = text;
  for (const [re, canonical] of MARKER_ALIASES) out = out.replace(re, canonical);
  return out;
}

/**
 * Shorten a capital-history basis to a deed reference.
 *
 * The model returned a whole paragraph here ("Akta No. 2 tanggal 07 Februari
 * 2017 (Devi Yunanda, SH., M.Kn.), disetujui Kemenkumham No. AHU-…"), which
 * makes the capital table unreadable. The notary and Menkumham chain already
 * appear in the deed-history table, so only the reference belongs in this cell.
 */
export function shortenCapitalBasis(basis: string): string {
  const trimmed = basis.trim();
  if (trimmed.length <= 40) return trimmed;
  const m = trimmed.match(/Akta\s+No\.?\s*(\d+)[^\d]{0,20}?(?:tanggal\s+)?(?:\d{1,2}\s+\w+\s+)?(\d{4})/i);
  if (m) return `Akta No. ${m[1]}/${m[2]}`;
  const m2 = trimmed.match(/Akta\s+No\.?\s*[\d/]+/i);
  if (m2) return m2[0].replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 40).trim();
}

/** How many links of the citation chain a deed entry actually carries. */
function chainScore(d: DDDeedRef): number {
  return [d.notary, d.menkumhamRef, d.registrationRef, d.bnriRef, d.verbatim]
    .filter((x) => Boolean(x && x.trim())).length;
}

/**
 * One corporate action = one row.
 *
 * The data room keeps some deeds twice (a "BN" copy and an "SP" copy), and the
 * model emitted a row per source file — so Akta No. 17 appeared twice and the
 * lead-in counted 12 corporate actions where there were 11. Entries sharing a
 * deed number and date are merged, keeping the richest citation chain and the
 * longer description.
 */
export function dedupeDeeds(deeds: DDDeedRef[]): DDDeedRef[] {
  const byKey = new Map<string, DDDeedRef>();
  const order: string[] = [];
  for (const d of deeds) {
    const key = `${d.number.trim().replace(/^0+/, "")}|${d.dateISO.trim()}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, d);
      order.push(key);
      continue;
    }
    const better = chainScore(d) > chainScore(seen) ? d : seen;
    const other = better === d ? seen : d;
    byKey.set(key, {
      ...better,
      // Keep whichever description says more; a "(dokumen sumber kedua)" aside
      // is not worth preferring over the substantive one.
      purpose: better.purpose.length >= other.purpose.length ? better.purpose : other.purpose,
      notary: better.notary || other.notary,
      menkumhamRef: better.menkumhamRef || other.menkumhamRef,
      registrationRef: better.registrationRef || other.registrationRef,
      bnriRef: better.bnriRef || other.bnriRef,
    });
  }
  return order.map((k) => byKey.get(k) as DDDeedRef);
}

export function parseNarrativeResponse(
  raw: string,
  stopReason: string | null,
  args: { entityId: string }
): DDNarrativeSectionI {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error("Hasil ekstraksi narasi Bagian I bukan JSON");
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(jsonStr);
  } catch {
    p = JSON.parse(repairTruncatedJson(jsonStr));
  }

  const establishment =
    p.establishment && typeof p.establishment === "object"
      ? asDeedRef(p.establishment as Record<string, unknown>, "Pendirian")
      : null;

  const amendments = Array.isArray(p.amendments)
    ? (p.amendments as unknown[]).map((a) => asDeedRef(a as Record<string, unknown>))
    : [];
  // Enforce chronological order server-side — never trust model ordering.
  amendments.sort((a, b) => (a.dateISO || "9999").localeCompare(b.dateISO || "9999"));
  const dedupedAmendments = dedupeDeeds(amendments);

  const capitalHistory = Array.isArray(p.capitalHistory)
    ? (p.capitalHistory as unknown[])
        .map((c) => asCapitalEntry(c as Record<string, unknown>))
        .map((c) => ({ ...c, basis: shortenCapitalBasis(c.basis) }))
    : [];

  const shareholders = Array.isArray(p.shareholders)
    ? (p.shareholders as unknown[]).map((s) => asShareholderEntry(s as Record<string, unknown>))
    : [];

  // appointedBy is where an invented marker actually surfaced live
  // ("[TIDAK DITEMUKAN — tidak ada akta pengangkatan…]").
  const normaliseOfficer = (o: DDOfficerEntry): DDOfficerEntry => ({
    ...o,
    appointedBy: normaliseMarkers(o.appointedBy),
    termUntil: normaliseMarkers(o.termUntil),
  });

  const directors = Array.isArray(p.directors)
    ? (p.directors as unknown[])
        .map((d) => asOfficerEntry(d as Record<string, unknown>, "Direktur"))
        .map(normaliseOfficer)
    : [];

  const commissioners = Array.isArray(p.commissioners)
    ? (p.commissioners as unknown[])
        .map((c) => asOfficerEntry(c as Record<string, unknown>, "Komisaris"))
        .map(normaliseOfficer)
    : [];

  const notes: DDNarrativeNote[] = Array.isArray(p.notes)
    ? (p.notes as unknown[]).map((n) => {
        const o = n as Record<string, unknown>;
        const anchor = String(o.anchor ?? "");
        return {
          anchor: (NOTE_ANCHORS.has(anchor) ? anchor : "lainnya") as DDNarrativeNote["anchor"],
          text: normaliseMarkers(String(o.text ?? "").trim()),
          sourceFile: o.sourceFile ? String(o.sourceFile).trim() : null,
        };
      })
    : [];

  return {
    entityId: args.entityId,
    establishment,
    amendments: dedupedAmendments,
    businessPurpose: String(p.businessPurpose ?? "").trim(),
    businessActivities: Array.isArray(p.businessActivities)
      ? (p.businessActivities as unknown[]).map((s) => String(s).trim()).filter(Boolean)
      : [],
    businessBasis: String(p.businessBasis ?? "").trim(),
    capitalHistory,
    currentCapital: capitalHistory.length ? capitalHistory[capitalHistory.length - 1] : null,
    shareholders,
    directors,
    commissioners,
    notes,
    generatedAt: new Date().toISOString(),
  };
}

export async function extractNarrativeSectionI(
  client: Anthropic,
  args: {
    entityId: string;
    entityName: string;
    classified: DDClassifiedDoc[];
    contentByFile: Map<string, string>;
  }
): Promise<DDNarrativeSectionI> {
  const files = args.classified
    .filter((d) => d.entityId === args.entityId && SECTION_I_ASPECTS.has(d.aspectId))
    .map((d) => d.fileName);
  const uniqueFiles = Array.from(new Set(files));

  const docsText = uniqueFiles
    .map((f) => `=== ${f} ===\n${args.contentByFile.get(f) ?? "[TIDAK DITEMUKAN]"}`)
    .join("\n\n");

  if (!docsText.trim()) {
    // No Bagian I documents classified at all — tolerate, do not throw.
    return {
      entityId: args.entityId,
      establishment: null,
      amendments: [],
      businessPurpose: "",
      businessActivities: [],
      businessBasis: "",
      capitalHistory: [],
      currentCapital: null,
      shareholders: [],
      directors: [],
      commissioners: [],
      notes: [
        {
          anchor: "pendirian",
          text: "Tidak ada dokumen yang diklasifikasikan pada aspek pendirian, permodalan, atau pengurus dalam dokumen yang diperiksa.",
          sourceFile: null,
        },
      ],
      generatedAt: new Date().toISOString(),
    };
  }

  const response = await client.messages.create({
    model: MODELS.ddExtraction,
    max_tokens: 8000,
    system: narrativeSystem(),
    messages: [{ role: "user", content: buildNarrativePrompt({ entityName: args.entityName, docsText }) }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseNarrativeResponse(raw, response.stop_reason, { entityId: args.entityId });
}
