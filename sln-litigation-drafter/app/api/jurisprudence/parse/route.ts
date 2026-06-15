import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { loadJurisprudenceDb } from "@/lib/jurisprudence";
import type { JurisprudenceEntry } from "@/types";
import { randomUUID } from "crypto";

export const maxDuration = 300;

const CHUNK_SIZE = 40_000;
const CHUNK_OVERLAP = 2_000;

// Split text into sections by MA index headers, then cap each section at CHUNK_SIZE.
function chunkText(text: string): string[] {
  const SECTION_RE = /\n(?=HUKUM PERDATA|HUKUM PIDANA|HUKUM TATA NEGARA|HUKUM ADMINISTRASI|HUKUM NIAGA|HUKUM PERDATA KHUSUS|HUKUM ACARA)/i;
  const sections = text.split(SECTION_RE).filter((s) => s.trim().length > 0);

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section);
    } else {
      // Section too large — split into fixed-size chunks with overlap.
      let offset = 0;
      while (offset < section.length) {
        chunks.push(section.slice(offset, offset + CHUNK_SIZE));
        offset += CHUNK_SIZE - CHUNK_OVERLAP;
      }
    }
  }

  // If no section headers found, fall back to fixed-size chunks on the whole text.
  if (chunks.length === 0) {
    let offset = 0;
    while (offset < text.length) {
      chunks.push(text.slice(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  }

  return chunks;
}

const SYSTEM = `Kamu adalah ahli hukum Indonesia yang menganalisis dokumen yurisprudensi Mahkamah Agung. Ekstrak HANYA putusan yang relevan untuk praktik hukum perdata komersial dan kepailitan berikut: perbuatan melawan hukum (PMH), wanprestasi, pembatalan perjanjian, kepailitan/pailit, PKPU, actio pauliana, pembatalan perdamaian/homologasi, tanggung jawab direksi/komisaris, gadai saham, fidusia, cessie, ganti rugi, dan sita jaminan. Perluas kategori yang diekstrak.  Selain hukum perdata komersial dan kepailitan yang sudah disebut, JUGA ekstrak putusan tentang HUKUM ACARA PERDATA yang relevan untuk litigasi: sita jaminan (conservatoir/revindicatoir beslag), eksekusi putusan, uitvoerbaar bij voorraad, kompetensi absolut dan relatif, eksepsi (obscuur libel, error in persona, ne bis in idem, nebis), kualifikasi gugatan, daluwarsa, pembuktian, dan putusan verstek.  ABAIKAN: hukum pidana, hukum adat, hukum perkawinan/waris keluarga, pertanahan (non-komersial), dan hukum TUN. Untuk setiap putusan yang relevan, ekstrak: nomor putusan MA lengkap, tahun, kaidah hukum utama (verbatim jika tersedia, ringkasan jika tidak), topik-topik yang dicakup (dari daftar di atas), dan pasal-pasal yang dikutip. Return ONLY a valid JSON array of entries matching the schema provided. No prose, no markdown fences.`;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) {
      return NextResponse.json({ error: "Tidak ada file yang diunggah" }, { status: 400 });
    }

    const existing = await loadJurisprudenceDb();
    const existingNomor = new Set(existing.map((e) => e.nomor));
    const allEntries: JurisprudenceEntry[] = [];
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      let text = "";

      if (file.name.endsWith(".pdf")) {
        try {
          const { getDocumentProxy, extractText } = await import("unpdf");
          const pdf = await getDocumentProxy(new Uint8Array(buf));
          const { text: extracted } = await extractText(pdf, { mergePages: true });
          text = extracted;
        } catch {
          text = "(gagal ekstrak PDF)";
        }
      } else if (file.name.endsWith(".docx") || file.name.endsWith(".doc")) {
        try {
          const mammoth = await import("mammoth");
          const result = await mammoth.extractRawText({ buffer: buf });
          text = result.value;
        } catch {
          text = "(gagal ekstrak DOCX)";
        }
      }

      if (!text.trim()) continue;

      const tipe = file.name.endsWith(".pdf") ? "pdf" : file.name.endsWith(".doc") ? "doc" : "docx";
      const chunks = chunkText(text);
      console.log(`[parse-juris] file=${file.name} totalChars=${text.length} chunks=${chunks.length}`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prompt = `Ekstrak semua putusan Mahkamah Agung yang relevan dari dokumen berikut.

DOKUMEN (bagian ${i + 1}/${chunks.length}):
${chunk}

Kembalikan HANYA JSON array:
[
  {
    "nomor": "nomor putusan lengkap",
    "tahun": 2020,
    "topik": ["kepailitan"],
    "kaidah": "kaidah hukum 1-3 kalimat",
    "pasal_terkait": ["Pasal 1243 KUHPerdata"],
    "forum": "Mahkamah Agung — Kasasi"
  }
]

Jika tidak ada putusan yang relevan di bagian ini, kembalikan array kosong: []`;

        console.log(`[model] stage=parse-yurisprudensi model=${MODELS.extraction} chunk=${i + 1}/${chunks.length}`);
        let response;
        try {
          response = await client.messages.create({
            model: MODELS.extraction,
            max_tokens: 16000,
            system: SYSTEM,
            messages: [{ role: "user", content: prompt }],
          });
        } catch (e) {
          console.error(`[parse-juris] Claude error chunk=${i + 1}/${chunks.length} file=${file.name}:`, e instanceof Error ? e.message : e);
          continue;
        }

        const raw = response.content.find((b) => b.type === "text")?.text ?? "";
        console.log(`[parse-juris] chunk=${i + 1}/${chunks.length} file=${file.name} stop_reason=${response.stop_reason} rawLen=${raw.length}`);

        let chunkCount = 0;
        try {
          const clean = raw.replace(/```json|```/g, "").trim();
          // Accept either a bare array or { "entries": [...] }
          const arrayMatch = clean.match(/\[[\s\S]*\]/);
          const objectMatch = clean.match(/\{[\s\S]*\}/);
          let parsed: unknown[] | null = null;
          if (arrayMatch) {
            const candidate = JSON.parse(arrayMatch[0]) as unknown;
            if (Array.isArray(candidate)) parsed = candidate;
          } else if (objectMatch) {
            const candidate = JSON.parse(objectMatch[0]) as { entries?: unknown[] };
            if (Array.isArray(candidate.entries)) parsed = candidate.entries;
          }

          if (parsed) {
            for (const e of parsed) {
              const entry = e as Partial<JurisprudenceEntry>;
              if (!entry.nomor || existingNomor.has(entry.nomor)) continue;
              allEntries.push({
                id: randomUUID(),
                nomor: entry.nomor,
                tahun: typeof entry.tahun === "number" ? entry.tahun : new Date().getFullYear(),
                topik: Array.isArray(entry.topik) ? entry.topik : [],
                kaidah: typeof entry.kaidah === "string" ? entry.kaidah : "",
                pasal_terkait: Array.isArray(entry.pasal_terkait) ? entry.pasal_terkait : [],
                forum: typeof entry.forum === "string" ? entry.forum : "Mahkamah Agung",
                sumber_file: file.name,
                tipe_sumber: tipe as "pdf" | "docx" | "doc",
                verified: false,
                addedAt: new Date().toISOString(),
              });
              existingNomor.add(entry.nomor);
              chunkCount++;
            }
          }
        } catch {
          console.error(`[parse-juris] JSON parse failed chunk=${i + 1}/${chunks.length} file=${file.name} raw=${raw.slice(0, 200)}`);
        }
        console.log(`[parse-juris] chunk=${i + 1}/${chunks.length} file=${file.name} entriesFound=${chunkCount} totalSoFar=${allEntries.length}`);
      }
    }

    return NextResponse.json({ entries: allEntries });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error";
    console.error("[parse-juris] fatal error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
