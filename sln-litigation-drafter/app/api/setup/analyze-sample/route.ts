import { NextRequest, NextResponse } from "next/server";
import { readFileContent } from "@/lib/sharepoint";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { readBlobText, writeBlobText } from "@/lib/blob";

export const maxDuration = 120;

interface StyleIndexEntry {
  path: string;
  type: string;
  claimType: string;
  label: string;
  source?: "setup" | "approved";
}

// Persist the COMPLETE sample text as a style example so loadDraftMemory can
// serve the firm's real document as the full best-match example. Re-runnable:
// a new setup sample for the same docType+claimType replaces the previous
// setup entry; entries for other types and Stage-5-approved drafts are kept.
async function persistSetupSample(
  docType: string,
  claimType: string,
  content: string
): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 10);
  const ct = claimType || "umum";
  const filename = `setup_${docType}_${ct}_${timestamp}.txt`;

  await writeBlobText(`style_examples/${filename}`, content);

  const indexRaw = await readBlobText("style_examples/index.json");
  let index: StyleIndexEntry[] = [];
  if (indexRaw) {
    try {
      index = JSON.parse(indexRaw);
    } catch (e) {
      console.error("[analyze-sample] index.json parse failed, rebuilding:", e instanceof Error ? e.message : e);
    }
  }

  // Replace any prior SETUP entry for the same docType+claimType (re-run =
  // update that sample); never touch approved entries or other types.
  index = index.filter(
    (en) => !(en.source === "setup" && en.type === docType && en.claimType === ct)
  );
  index.push({
    path: `style_examples/${filename}`,
    type: docType,
    claimType: ct,
    label: `Sampel firma — ${docType}/${ct} (${timestamp})`,
    source: "setup",
  });
  await writeBlobText("style_examples/index.json", JSON.stringify(index, null, 2));
  console.log(`[analyze-sample] stored setup sample ${filename} (${content.length} chars), index now ${index.length} entries`);
}

const ANALYSIS_SYSTEM = `Anda adalah analis dokumen hukum senior.
Tugas: Baca dokumen litigasi yang diberikan dan identifikasi pola gaya penulisan firma hukum ini.
Analisis meliputi: struktur dokumen, pilihan bahasa formal, cara pengorganisasian argumen, format petitum, dan konvensi penulisan yang konsisten.
Tulis dalam Bahasa Indonesia formal. Maksimum 1000 kata.`;

export async function POST(req: NextRequest) {
  let step = "parse";
  try {
    const { sharePointPath, docType, claimType } = await req.json();

    if (!sharePointPath) {
      return NextResponse.json({ error: "sharePointPath wajib diisi" }, { status: 400 });
    }

    step = "readFile";
    const fileContent = await readFileContent(sharePointPath);
    if (!fileContent || fileContent.length < 100) {
      return NextResponse.json({ error: "Tidak dapat membaca file atau file kosong" }, { status: 400 });
    }

    // Persist the FULL document as a setup style example before analysis —
    // this is the firm's real sample that drafting will imitate.
    step = "persistSample";
    await persistSetupSample(docType, claimType ?? "", fileContent);

    step = "claude";
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODELS.patterns,
      max_tokens: 1500,
      system: ANALYSIS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Analisis pola gaya penulisan dokumen ${docType} berikut ini:\n\n${fileContent.slice(0, 5000)}`,
        },
      ],
    });

    const analysis = response.content.find((b) => b.type === "text")?.text || "";

    return NextResponse.json({
      analysis,
      previewText: fileContent.slice(0, 1000),
      storedChars: fileContent.length,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error(`[analyze-sample][step=${step}]`, message, stack);
    return NextResponse.json({ error: message, step, stack }, { status: 500 });
  }
}
