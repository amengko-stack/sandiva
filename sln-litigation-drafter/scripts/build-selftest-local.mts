import { buildLitigationDocx } from "../lib/docx-builder";
import fs from "fs";
import { createHash } from "crypto";
const SAMPLE = `SURAT GUGATAN
Kepada Yth. Ketua Pengadilan Negeri Jakarta Pusat

I. IDENTITAS PARA PIHAK
1. Bahwa Penggugat adalah **PT Contoh Sejahtera**, berkedudukan di Jakarta;

PETITUM
1. Mengabulkan gugatan Penggugat untuk seluruhnya;`;
buildLitigationDocx(SAMPLE, { ref: "SLN/SELFTEST/2026", docType: "gugatan", claimType: "wanprestasi" }).then((buf) => {
  fs.writeFileSync("/tmp/local-selftest.docx", buf);
  console.log("size:", buf.length, "sha256:", createHash("sha256").update(buf).digest("hex"), "node:", process.version);
});
