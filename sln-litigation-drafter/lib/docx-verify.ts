import { inflateRawSync, crc32 } from "zlib";

export interface EntryCheck {
  name: string;
  method: number;
  localCrc: string;
  centralCrc: string;
  dataCrc: string;
  ok: boolean;
  illegalChars: number;
}

export interface ZipVerdict {
  entries: EntryCheck[];
  bad: number;
  illegal: number;
}

// Codepoints illegal in XML 1.0: C0 controls except \t \n \r, and U+FFFE/U+FFFF.
// (Lone surrogates can't survive a UTF-8 decode round-trip; upstream sanitizer
// strips them before build.)
function countIllegalXmlChars(text: string): number {
  // eslint-disable-next-line no-control-regex
  const m = text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g);
  return m ? m.length : 0;
}

// Parse the zip via its central directory; for every entry, inflate the data
// and compare its CRC32 against both the local-header and central-directory
// CRCs; for *.xml/*.rels entries additionally scan for XML-illegal chars.
// Zip CRC consistency proves transport integrity; the illegal-char scan
// catches content-dependent defects a CRC can't see.
export function verifyDocx(buf: Buffer): ZipVerdict {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found — not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries: EntryCheck[] = [];
  let bad = 0;
  let illegal = 0;
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

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local sig for ${name}`);
    const localCrc = buf.readUInt32LE(localOff + 14);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    let raw: Buffer;
    let inflateError = false;
    try {
      raw = method === 8 ? inflateRawSync(compData) : Buffer.from(compData);
    } catch {
      raw = Buffer.alloc(0);
      inflateError = true;
    }
    const dataCrc = inflateError ? 0xdeadbeef : crc32(raw) >>> 0;

    const isXml = /\.(xml|rels)$/.test(name);
    const ill = isXml && !inflateError ? countIllegalXmlChars(raw.toString("utf8")) : 0;
    const ok = dataCrc === centralCrc && dataCrc === localCrc && ill === 0;
    if (dataCrc !== centralCrc || dataCrc !== localCrc) bad++;
    illegal += ill;
    entries.push({
      name, method,
      localCrc: localCrc.toString(16),
      centralCrc: centralCrc.toString(16),
      dataCrc: dataCrc.toString(16),
      ok,
      illegalChars: ill,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, bad, illegal };
}
