import { buildLitigationDocx } from "../lib/docx-builder";
import fs from "fs";
const draft = `SURAT GUGATAN
Kepada Yth. Ketua Pengadilan Negeri Jakarta Pusat

I. IDENTITAS PARA PIHAK
1. Bahwa Penggugat adalah **PT Contoh Sejahtera**, berkedudukan di Jakarta;
2. Bahwa Tergugat adalah *PT Lalai Abadi*;

DALAM POKOK PERKARA
A. Dasar Hukum
- Pasal 1365 KUH Perdata

PETITUM
1. Mengabulkan gugatan Penggugat untuk seluruhnya;`;
buildLitigationDocx(draft, { ref: "SLN/TEST/2026", docType: "gugatan", claimType: "pmh" }).then((buf) => {
  fs.writeFileSync("/tmp/real.docx", buf);
  console.log("bytes:", buf.length);
});
