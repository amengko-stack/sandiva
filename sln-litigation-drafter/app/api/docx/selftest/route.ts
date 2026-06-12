import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { inflateRawSync, crc32 } from "zlib";
import { buildLitigationDocx } from "@/lib/docx-builder";

export const maxDuration = 60;

// TEMPORARY DEBUG ROUTE — builds a docx from CONSTANT text in the production
// runtime and validates the zip's integrity in-place: for every central-
// directory entry, decompress the local data and compare its CRC32 against
// both the local-header CRC and the central-directory CRC. A mismatch proves
// the corruption happens at build time in this runtime. Remove after diagnosis.
const SAMPLE = `SURAT GUGATAN
Kepada Yth. Ketua Pengadilan Negeri Jakarta Pusat

I. IDENTITAS PARA PIHAK
1. Bahwa Penggugat adalah **PT Contoh Sejahtera**, berkedudukan di Jakarta;

PETITUM
1. Mengabulkan gugatan Penggugat untuk seluruhnya;`;

interface EntryCheck {
  name: string;
  method: number;
  localCrc: string;
  centralCrc: string;
  dataCrc: string;
  ok: boolean;
}

function checkZip(buf: Buffer): { entries: EntryCheck[]; bad: number } {
  // Find End of Central Directory (EOCD)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries: EntryCheck[] = [];
  let bad = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central sig @${off}`);
    const method = buf.readUInt16LE(off + 10);
    const centralCrc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");

    // Local header
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local sig for ${name}`);
    const localCrc = buf.readUInt32LE(localOff + 14);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? inflateRawSync(compData) : compData;
    const dataCrc = crc32(raw) >>> 0;

    const ok = dataCrc === centralCrc && dataCrc === localCrc;
    if (!ok) bad++;
    entries.push({
      name, method,
      localCrc: localCrc.toString(16),
      centralCrc: centralCrc.toString(16),
      dataCrc: dataCrc.toString(16),
      ok,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, bad };
}

export async function GET() {
  try {
    const buf = await buildLitigationDocx(SAMPLE, {
      ref: "SLN/SELFTEST/2026",
      docType: "gugatan",
      claimType: "wanprestasi",
    });
    const { entries, bad } = checkZip(buf);
    const info = {
      size: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      node: process.version,
      badEntries: bad,
      entries: entries.filter((e) => !e.ok),
      allNames: entries.map((e) => `${e.name}:${e.ok ? "ok" : "BAD"}`),
    };
    console.log(`[docx-selftest] ${JSON.stringify({ size: info.size, sha256: info.sha256, node: info.node, badEntries: bad })}`);
    return NextResponse.json(info);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "selftest gagal";
    console.error("[docx-selftest] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
