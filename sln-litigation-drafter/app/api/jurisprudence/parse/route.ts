import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { loadJurisprudenceDb } from "@/lib/jurisprudence";
import type { JurisprudenceEntry } from "@/types";
import { randomUUID } from "crypto";

export const maxDuration = 120;

const SYSTEM = `Anda adalah asisten hukum yang mengekstrak entri yurisprudensi dari dokumen putusan Mahkamah Agung Indonesia.
Tugas: identifikasi SETIAP putusan MA dalam dokumen dan ekstrak informasinya.
Kembalikan HANYA JSON yang valid tanpa markdown.`;

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

      const tipe: "pdf" | "docx" | "doc" = file.name.endsWith(".pdf")
        ? "pdf"
        : file.name.endsWith(".doc")
        ? "doc"
        : "docx";

      const prompt = `Ekstrak semua putusan Mahkamah Agung dari dokumen berikut dan kembalikan JSON:

DOKUMEN:
${text.slice(0, 80000)}

Kembalikan HANYA JSON:
{
  "entries": [
    {
      "nomor": "nomor putusan lengkap",
      "tahun": 2020,
      "topik": ["kepailitan"],
      "kaidah": "kaidah hukum 1-3 kalimat",
      "pasal_terkait": ["Pasal 1243 KUHPerdata"],
      "forum": "MA"
    }
  ]
}

Jika tidak ada putusan MA, kembalikan { "entries": [] }`;

      console.log(`[model] stage=parse-yurisprudensi model=${MODELS.extraction}`);
      const response = await client.messages.create({
        model: MODELS.extraction,
        max_tokens: 8192,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });

      const raw = response.content.find((b) => b.type === "text")?.text ?? "";
      console.log(`[parse-juris] file=${file.name} stop_reason=${response.stop_reason} rawLen=${raw.length}`);

      try {
        const clean = raw.replace(/```json|```/g, "").trim();
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { entries?: unknown[] };
          if (Array.isArray(parsed.entries)) {
            for (const e of parsed.entries) {
              const entry = e as Partial<JurisprudenceEntry>;
              if (!entry.nomor || existingNomor.has(entry.nomor)) continue;
              allEntries.push({
                id: randomUUID(),
                nomor: entry.nomor,
                tahun: typeof entry.tahun === "number" ? entry.tahun : new Date().getFullYear(),
                topik: Array.isArray(entry.topik) ? entry.topik : [],
                kaidah: typeof entry.kaidah === "string" ? entry.kaidah : "",
                pasal_terkait: Array.isArray(entry.pasal_terkait) ? entry.pasal_terkait : [],
                forum: typeof entry.forum === "string" ? entry.forum : "MA",
                sumber_file: file.name,
                tipe_sumber: tipe,
                verified: false,
                addedAt: new Date().toISOString(),
              });
              existingNomor.add(entry.nomor);
            }
          }
        }
      } catch {
        console.error(`[parse-juris] JSON parse failed for ${file.name}`);
      }
    }

    return NextResponse.json({ entries: allEntries });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error";
    console.error("[parse-juris] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
