import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { list } from "@vercel/blob";
import { buildLitigationDocx } from "@/lib/docx-builder";
import { verifyDocx, type EntryCheck } from "@/lib/docx-verify";
import { writeMatterFile, listAiFolder } from "@/lib/graph-client";

export const maxDuration = 120;

// TEMPORARY DEBUG ROUTE — phases:
//   built:     build SAMPLE docx in this runtime, CRC+XML verify in memory
//   transport: POST our own /api/docx over real HTTP, verify received bytes
//   upload:    writeMatterFile to the most recent matter's AI/ folder, fetch
//              it back via Graph downloadUrl, verify the round-tripped bytes
// Remove after diagnosis.
const SAMPLE = `SURAT GUGATAN
Kepada Yth. Ketua Pengadilan Negeri Jakarta Pusat

I. IDENTITAS PARA PIHAK
1. Bahwa Penggugat adalah **PT Contoh Sejahtera**, berkedudukan di Jakarta;

PETITUM
1. Mengabulkan gugatan Penggugat untuk seluruhnya;`;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function findRecentFolderPath(): Promise<string | null> {
  const { blobs } = await list({
    prefix: "litigation-memory/sessions/",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  const reports = blobs
    .filter((b) => b.pathname.endsWith("/report.json"))
    .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt));
  for (const r of reports) {
    try {
      const res = await fetch(r.downloadUrl ?? r.url);
      if (!res.ok) continue;
      const data = (await res.json()) as { folderPath?: string };
      if (data.folderPath) return data.folderPath;
    } catch { /* try next */ }
  }
  return null;
}

function summarize(buf: Buffer) {
  const v = verifyDocx(buf);
  return {
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    bad: v.bad,
    illegal: v.illegal,
    badEntries: v.entries.filter((e: EntryCheck) => !e.ok),
  };
}

export async function GET(req: NextRequest) {
  try {
    const buf = await buildLitigationDocx(SAMPLE, {
      ref: "SLN/SELFTEST/2026",
      docType: "gugatan",
      claimType: "wanprestasi",
    });
    const built = summarize(buf);

    // Phase B: download transport round-trip
    let transport: Record<string, unknown>;
    try {
      const res = await fetch(`${req.nextUrl.origin}/api/docx`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: req.headers.get("cookie") ?? "",
        },
        body: JSON.stringify({
          draftText: SAMPLE, ref: "SLN/SELFTEST/2026",
          docType: "gugatan", claimType: "wanprestasi",
        }),
      });
      const ab = Buffer.from(await res.arrayBuffer());
      transport = { status: res.status, ...summarize(ab) };
    } catch (te) {
      transport = { error: te instanceof Error ? te.message : String(te) };
    }

    // Phase C: SharePoint upload round-trip
    let upload: Record<string, unknown>;
    try {
      const folderPath = await findRecentFolderPath();
      if (!folderPath) {
        upload = { error: "no recent folderPath found in session reports" };
      } else {
        await writeMatterFile(folderPath, "AI/docx_selftest.docx", buf, DOCX_MIME);
        const files = await listAiFolder(folderPath);
        const f = files.find((x) => x.name === "docx_selftest.docx");
        if (!f?.downloadUrl) {
          upload = { error: "uploaded file not found in AI folder listing" };
        } else {
          const res = await fetch(f.downloadUrl);
          const rt = Buffer.from(await res.arrayBuffer());
          upload = {
            uploadedSize: buf.length,
            uploadedSha256: built.sha256,
            roundtrip: summarize(rt),
            identicalToUploaded: rt.equals(buf),
          };
        }
      }
    } catch (ue) {
      upload = { error: ue instanceof Error ? ue.message : String(ue) };
    }

    const info = { node: process.version, built, transport, upload };
    console.log(`[docx-selftest] ${JSON.stringify(info)}`);
    return NextResponse.json(info);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "selftest gagal";
    console.error("[docx-selftest] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
