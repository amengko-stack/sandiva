/**
 * Canonical Indonesian regulation references for the currency check.
 *
 * Found by a live run on 2026-08-03: the same provision returned opposite
 * verdicts depending purely on how it was written.
 *
 *   "UUPT Pasal 94"              -> current
 *   "UU 40/2007 Pasal 94 ayat (1)" -> superseded
 *
 * and bare regulation numbers came back unknown, with sonar replying
 * "nomor ini perlu verifikasi judulnya" — it cannot resolve a number without a
 * title. So eight perfectly valid UUPT articles were reported to the lawyer as
 * superseded, which is worse than no check at all: spurious warnings on good
 * law erode trust in the genuine ones.
 *
 * Fix: expand every ref to a fully-qualified form (number, year AND title)
 * before querying, while keeping the lawyer's short form for display. Verdicts
 * are mapped back to the original string, so nothing downstream changes.
 */

/** Short instrument key -> fully-qualified name including the title. */
const INSTRUMENTS: { pattern: RegExp; canonical: string }[] = [
  // Aliases first: "UUPT" must not be caught by a looser "UU" rule.
  { pattern: /^UUPT\b/i, canonical: "UU No. 40 Tahun 2007 tentang Perseroan Terbatas" },
  { pattern: /^UUPM\b/i, canonical: "UU No. 8 Tahun 1995 tentang Pasar Modal" },
  { pattern: /^UUWDP\s*(?:No\.?\s*)?3[\/\s]*1982\b/i, canonical: "UU No. 3 Tahun 1982 tentang Wajib Daftar Perusahaan" },
  { pattern: /^UUWDP\b/i, canonical: "UU No. 3 Tahun 1982 tentang Wajib Daftar Perusahaan" },

  { pattern: /^UU\s*(?:No\.?\s*)?40[\/\s]*2007\b/i, canonical: "UU No. 40 Tahun 2007 tentang Perseroan Terbatas" },
  { pattern: /^UU\s*(?:No\.?\s*)?8[\/\s]*1995\b/i, canonical: "UU No. 8 Tahun 1995 tentang Pasar Modal" },
  { pattern: /^UU\s*(?:No\.?\s*)?6[\/\s]*2023\b/i, canonical: "UU No. 6 Tahun 2023 tentang Cipta Kerja" },
  { pattern: /^UU\s*(?:No\.?\s*)?4[\/\s]*2023\b/i, canonical: "UU No. 4 Tahun 2023 tentang Pengembangan dan Penguatan Sektor Keuangan (P2SK)" },
  { pattern: /^UU\s*(?:No\.?\s*)?13[\/\s]*2003\b/i, canonical: "UU No. 13 Tahun 2003 tentang Ketenagakerjaan" },
  { pattern: /^UU\s*(?:No\.?\s*)?42[\/\s]*1999\b/i, canonical: "UU No. 42 Tahun 1999 tentang Jaminan Fidusia" },
  { pattern: /^UU\s*(?:No\.?\s*)?4[\/\s]*1996\b/i, canonical: "UU No. 4 Tahun 1996 tentang Hak Tanggungan atas Tanah" },
  { pattern: /^UU\s*(?:No\.?\s*)?24[\/\s]*2011\b/i, canonical: "UU No. 24 Tahun 2011 tentang Badan Penyelenggara Jaminan Sosial" },
  { pattern: /^UU\s*(?:No\.?\s*)?40[\/\s]*2004\b/i, canonical: "UU No. 40 Tahun 2004 tentang Sistem Jaminan Sosial Nasional" },
  { pattern: /^UU\s*(?:No\.?\s*)?40[\/\s]*2014\b/i, canonical: "UU No. 40 Tahun 2014 tentang Perasuransian" },
  { pattern: /^UU\s*(?:No\.?\s*)?28[\/\s]*2007\b/i, canonical: "UU No. 28 Tahun 2007 tentang Ketentuan Umum dan Tata Cara Perpajakan" },
  { pattern: /^UU\s*(?:No\.?\s*)?5[\/\s]*1960\b/i, canonical: "UU No. 5 Tahun 1960 tentang Peraturan Dasar Pokok-Pokok Agraria" },
  { pattern: /^UU\s*(?:No\.?\s*)?5[\/\s]*1999\b/i, canonical: "UU No. 5 Tahun 1999 tentang Larangan Praktek Monopoli dan Persaingan Usaha Tidak Sehat" },

  { pattern: /^PP\s*(?:No\.?\s*)?57[\/\s]*2010\b/i, canonical: "PP No. 57 Tahun 2010 tentang Penggabungan atau Peleburan Badan Usaha dan Pengambilalihan Saham Perusahaan" },
  { pattern: /^PP\s*(?:No\.?\s*)?5[\/\s]*2021\b/i, canonical: "PP No. 5 Tahun 2021 tentang Penyelenggaraan Perizinan Berusaha Berbasis Risiko" },
  { pattern: /^PP\s*(?:No\.?\s*)?35[\/\s]*2021\b/i, canonical: "PP No. 35 Tahun 2021 tentang PKWT, Alih Daya, Waktu Kerja dan PHK" },
  { pattern: /^PP\s*(?:No\.?\s*)?24[\/\s]*2018\b/i, canonical: "PP No. 24 Tahun 2018 tentang Pelayanan Perizinan Berusaha Terintegrasi Secara Elektronik" },
  { pattern: /^PP\s*(?:No\.?\s*)?18[\/\s]*2021\b/i, canonical: "PP No. 18 Tahun 2021 tentang Hak Pengelolaan, Hak Atas Tanah, Satuan Rumah Susun dan Pendaftaran Tanah" },

  { pattern: /^POJK\s*(?:No\.?\s*)?17[\/\s]*(?:POJK\.04[\/\s]*)?2020\b/i, canonical: "POJK No. 17/POJK.04/2020 tentang Transaksi Material dan Perubahan Kegiatan Usaha" },
  { pattern: /^POJK\s*(?:No\.?\s*)?42[\/\s]*(?:POJK\.04[\/\s]*)?2020\b/i, canonical: "POJK No. 42/POJK.04/2020 tentang Transaksi Afiliasi dan Transaksi Benturan Kepentingan" },
  { pattern: /^POJK\s*(?:No\.?\s*)?15[\/\s]*(?:POJK\.04[\/\s]*)?2020\b/i, canonical: "POJK No. 15/POJK.04/2020 tentang Rencana dan Penyelenggaraan RUPS Perusahaan Terbuka" },
  { pattern: /^POJK\s*(?:No\.?\s*)?9[\/\s]*(?:POJK\.04[\/\s]*)?2018\b/i, canonical: "POJK No. 9/POJK.04/2018 tentang Pengambilalihan Perusahaan Terbuka" },
  { pattern: /^POJK\s*(?:No\.?\s*)?7[\/\s]*(?:POJK\.04[\/\s]*)?2017\b/i, canonical: "POJK No. 7/POJK.04/2017 tentang Dokumen Pernyataan Pendaftaran dalam rangka Penawaran Umum Efek Bersifat Ekuitas" },
  { pattern: /^POJK\s*(?:No\.?\s*)?8[\/\s]*(?:POJK\.04[\/\s]*)?2017\b/i, canonical: "POJK No. 8/POJK.04/2017 tentang Bentuk dan Isi Prospektus dan Prospektus Ringkas" },
];

/** The article/paragraph tail of a reference, e.g. "Pasal 94 ayat (1)". */
function articleTail(ref: string): string {
  const m = ref.match(/\b(Pasal\s+\d+[A-Za-z]?(?:\s*[-–]\s*\d+)?(?:\s*ayat\s*\(\d+\))?(?:\s*huruf\s*[a-z])?)/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Expand a reference into a form the research call can actually resolve:
 * instrument number + year + title, plus the article if one was cited.
 * Unknown instruments are returned trimmed but otherwise untouched — better an
 * honest "unknown" than a guessed title.
 */
export function expandRefForQuery(ref: string): string {
  const trimmed = ref.trim();
  for (const inst of INSTRUMENTS) {
    if (inst.pattern.test(trimmed)) {
      const tail = articleTail(trimmed);
      return tail ? `${inst.canonical}, ${tail}` : inst.canonical;
    }
  }
  return trimmed;
}

/** True when the ref maps to a known instrument (so an "unknown" verdict is informative). */
export function isKnownInstrument(ref: string): boolean {
  return INSTRUMENTS.some((i) => i.pattern.test(ref.trim()));
}
