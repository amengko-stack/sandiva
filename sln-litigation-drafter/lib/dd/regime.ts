import type {
  DDEntity,
  DDRegime,
  DDRegimeLayer,
  DDTransactionType,
} from "@/types/dd";

/**
 * Which legal regime binds a given entity.
 *
 * A PT Tertutup is bound by UUPT 40/2007 (jo. UU 6/2023) only. A PT Tbk carries
 * the capital-markets overlay (UUPM 8/1995 jo. UU 4/2023, POJK, IDX rules) on
 * top of that same baseline. The third case is the one most often got wrong: a
 * private company is itself unbound by POJK, but POJK 17/2020 reaches
 * transactions by a "Perusahaan Terbuka *atau perusahaan terkendali*" and
 * measures materiality against the *parent's* figures — so a private
 * subsidiary's deal can trigger obligations at the listed parent.
 *
 * Transaction type deliberately plays no part here: whether POJK binds you is a
 * function of listing status, not deal shape. Deal shape selects *which*
 * obligations inside a layer apply — see obligationsFor().
 */
export function resolveRegime(entity: DDEntity): DDRegime {
  const layers: DDRegimeLayer[] = ["uupt"];
  const isTbk = entity.listingStatus === "tbk";
  const parentName = (entity.ultimateParentTbk ?? "").trim();

  if (isTbk) {
    layers.push("pasar_modal_langsung");
  } else if (parentName !== "") {
    layers.push("pasar_modal_induk");
  }
  if (entity.isBumn === true) {
    layers.push("bumn");
  }

  return {
    layers,
    capitalMarkets: isTbk || (!isTbk && parentName !== ""),
    // Only meaningful for the via-parent case. A Tbk entity answers for itself,
    // so naming a parent there would invite the wrong threshold denominator.
    parentTbkName: !isTbk && parentName !== "" ? parentName : null,
  };
}

export const REGIME_LAYER_LABELS: Record<DDRegimeLayer, string> = {
  uupt: "Undang-Undang Perseroan Terbatas (berlaku bagi semua PT)",
  pasar_modal_langsung: "Rezim Pasar Modal — entitas berstatus Terbuka (Tbk)",
  pasar_modal_induk: "Rezim Pasar Modal — melalui induk berstatus Terbuka (Tbk)",
  bumn: "Lapisan Badan Usaha Milik Negara",
};

export const regimeLayerLabel = (layer: DDRegimeLayer): string =>
  REGIME_LAYER_LABELS[layer] ?? layer;

export function hasLayer(regime: DDRegime, layer: DDRegimeLayer): boolean {
  return regime.layers.indexOf(layer) !== -1;
}

// ---------------------------------------------------------------------------
// Obligation tables
// ---------------------------------------------------------------------------

export interface DDObligation {
  id: string;
  label: string;                     // the obligation itself
  basis: string;                     // statutory / regulatory basis
  timing: string;                    // deadline or quorum figure; "—" when none
  layer: DDRegimeLayer;
  appliesTo?: DDTransactionType[];   // omitted = every transaction type
  note?: string;                     // qualification the report must carry
}

const ALL_COMBINATIONS: DDTransactionType[] = [
  "akuisisi_saham",
  "akuisisi_aset",
  "merger",
  "divestasi",
  "streamlining",
];

/** Baseline duties under UUPT — these survive regardless of listing status. */
export const UUPT_BASELINE: DDObligation[] = [
  {
    id: "uupt.rups_fundamental",
    label:
      "Persetujuan RUPS untuk tindakan fundamental (penggabungan, peleburan, pengambilalihan, pemisahan, perubahan anggaran dasar, pengalihan lebih dari 50% kekayaan bersih, pembubaran)",
    basis: "Pasal 86–89 UUPT",
    timing: "kuorum 3/4 bagian dan disetujui 3/4 bagian dari suara yang dikeluarkan",
    layer: "uupt",
  },
  {
    id: "uupt.prosedur_penggabungan",
    label:
      "Penyusunan rancangan oleh Direksi, persetujuan Dewan Komisaris, dan pelaksanaan prosedur penggabungan/pengambilalihan",
    basis: "Pasal 122–137 UUPT, khususnya Pasal 125–126",
    timing: "—",
    layer: "uupt",
    appliesTo: ALL_COMBINATIONS,
    note:
      "Pengambilalihan saham yang dilakukan langsung dari pemegang saham (jalur Pasal 125 ayat (7) UUPT, sebelumnya Pasal 103 ayat (6) UU 1/1995) tidak melalui prosedur rancangan pengambilalihan yang lengkap. Bila jalur ini dipakai, dasar penggunaannya wajib diungkapkan.",
  },
  {
    id: "uupt.pengumuman_dan_karyawan",
    label:
      "Pengumuman ringkasan rancangan dalam sekurang-kurangnya 1 (satu) surat kabar DAN pemberitahuan tertulis kepada karyawan Perseroan",
    basis: "Pasal 127 ayat (2) UUPT",
    timing: "paling lambat 30 (tiga puluh) hari sebelum pemanggilan RUPS",
    layer: "uupt",
    appliesTo: ALL_COMBINATIONS,
  },
  {
    id: "uupt.keberatan_kreditor",
    label: "Kesempatan bagi kreditor untuk mengajukan keberatan kepada Perseroan",
    basis: "Pasal 127 ayat (4) UUPT",
    timing: "paling lambat 14 (empat belas) hari setelah pengumuman ringkasan rancangan",
    layer: "uupt",
    appliesTo: ALL_COMBINATIONS,
    note:
      "Selama keberatan kreditor belum diselesaikan, keberatan tersebut wajib diajukan dalam RUPS untuk diselesaikan; tanpa penyelesaian, penggabungan/pengambilalihan tidak dapat dilaksanakan.",
  },
  {
    id: "uupt.akta_dan_menkumham",
    label:
      "Akta notaris dalam bahasa Indonesia, serta persetujuan atau pemberitahuan kepada Menteri Hukum dan HAM dan pengumuman hasilnya",
    basis: "UUPT jo. peraturan pelaksanaannya (AHU-online)",
    timing: "—",
    layer: "uupt",
  },
  {
    id: "uupt.hak_keluar",
    label:
      "Hak pemegang saham yang tidak menyetujui tindakan Perseroan untuk meminta sahamnya dibeli dengan harga wajar (appraisal right)",
    basis: "Pasal 62 UUPT",
    timing: "—",
    layer: "uupt",
    appliesTo: ["akuisisi_saham", "merger", "divestasi", "streamlining"],
  },
  {
    id: "uupt.kepentingan_pihak",
    label:
      "Kewajiban memperhatikan kepentingan Perseroan, pemegang saham minoritas, karyawan, kreditor dan mitra usaha lainnya, serta masyarakat dan persaingan sehat",
    basis: "Pasal 126 ayat (1) UUPT",
    timing: "—",
    layer: "uupt",
  },
  {
    id: "kppu.notifikasi",
    label:
      "Notifikasi penggabungan, peleburan, atau pengambilalihan saham kepada Komisi Pengawas Persaingan Usaha bila ambang nilai aset/penjualan terlampaui",
    basis: "PP 57/2010 jo. peraturan KPPU",
    timing: "wajib, paling lama 30 (tiga puluh) hari kerja setelah tanggal berlaku efektif secara yuridis (pasca-closing)",
    layer: "uupt",
    appliesTo: ["akuisisi_saham", "akuisisi_aset", "merger", "joint_venture"],
    note:
      "Notifikasi bersifat wajib dan pasca-closing; keterlambatan dikenakan sanksi denda administratif per hari keterlambatan.",
  },
  {
    id: "uupt.likuidasi_pengumuman",
    label:
      "Pengumuman pembubaran oleh likuidator dalam surat kabar dan Berita Negara, serta pemberitahuan kepada Menteri",
    basis: "Pasal 147 ayat (1) UUPT",
    timing: "paling lambat 30 (tiga puluh) hari sejak tanggal pembubaran",
    layer: "uupt",
    appliesTo: ["likuidasi"],
  },
  {
    id: "uupt.likuidasi_klaim_kreditor",
    label: "Jangka waktu pengajuan tagihan oleh kreditor kepada likuidator",
    basis: "Pasal 147 ayat (3) UUPT",
    timing: "60 (enam puluh) hari terhitung sejak tanggal pengumuman",
    layer: "uupt",
    appliesTo: ["likuidasi"],
  },
];

/**
 * Capital-markets duties where the entity under examination is itself Tbk.
 * None of these may be cited against a PT Tertutup.
 */
export const PASAR_MODAL_LANGSUNG: DDObligation[] = [
  {
    id: "pojk17.ambang",
    label:
      "Penetapan apakah transaksi merupakan Transaksi Material: nilai transaksi mencapai 20% atau lebih dari ekuitas Perusahaan Terbuka; untuk pengambilalihan/pelepasan perusahaan atau segmen usaha, ambang juga terpenuhi bila rasio total aset, laba bersih, atau pendapatan objek transaksi terhadap Perusahaan Terbuka mencapai 20% atau lebih. Bagi Perusahaan Terbuka dengan ekuitas negatif, ambang adalah 10% dari total aset.",
    basis: "POJK 17/POJK.04/2020",
    timing: "dihitung atas dasar laporan keuangan triwulanan terakhir yang direviu atau diaudit",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk17.penilai",
    label:
      "Penunjukan Penilai independen untuk menentukan nilai wajar objek transaksi dan/atau kewajaran transaksi",
    basis: "POJK 17/POJK.04/2020",
    timing: "—",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk17.keterbukaan",
    label:
      "Keterbukaan Informasi kepada masyarakat melalui situs web Perusahaan Terbuka dan situs web Bursa Efek, serta penyampaiannya kepada Otoritas Jasa Keuangan",
    basis: "POJK 17/POJK.04/2020",
    timing: "paling lambat 2 (dua) hari kerja setelah terjadinya transaksi",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk17.rups",
    label:
      "Persetujuan RUPS bila nilai transaksi melebihi 50% dari ekuitas (atau 25% dari total aset bagi ekuitas negatif), atau Penilai menyatakan transaksi tidak wajar, atau transaksi mengandung unsur Transaksi Afiliasi/Benturan Kepentingan, atau mengancam kelangsungan usaha. RUPS Independen diperlukan bila terdapat unsur afiliasi atau benturan kepentingan.",
    basis: "POJK 17/POJK.04/2020 jo. POJK 15/POJK.04/2020",
    timing:
      "kuorum mayoritas sederhana, kecuali pelepasan lebih dari 50% aset bersih yang memerlukan kuorum 3/4 dan persetujuan lebih dari 3/4 suara",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk17.pengecualian",
    label:
      "Pengujian apakah transaksi termasuk yang dikecualikan, antara lain: transaksi dengan atau antar perusahaan terkendali yang sahamnya dimiliki paling sedikit 99%; pinjaman langsung dari bank atau penjaminan kepada bank; penambahan penyertaan secara pro-rata setelah paling sedikit 1 tahun; pelaksanaan penetapan pengadilan; lelang di mana Perusahaan Terbuka menjadi penawar; dan restrukturisasi yang dikendalikan Pemerintah.",
    basis: "POJK 17/POJK.04/2020",
    timing: "—",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk17.laporan_tahunan",
    label: "Pelaporan hasil pelaksanaan Transaksi Material dalam laporan tahunan",
    basis: "POJK 17/POJK.04/2020",
    timing: "—",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk42.afiliasi",
    label:
      "Untuk Transaksi Afiliasi: penunjukan Penilai untuk nilai wajar dan/atau pendapatan kewajaran, Keterbukaan Informasi, dan pelaporan kepada Otoritas Jasa Keuangan",
    basis: "POJK 42/POJK.04/2020",
    timing: "paling lambat 2 (dua) hari kerja setelah terjadinya transaksi",
    layer: "pasar_modal_langsung",
  },
  {
    id: "pojk42.benturan",
    label:
      "Untuk Transaksi Benturan Kepentingan: Penilai, Keterbukaan Informasi, dan persetujuan Pemegang Saham Independen dalam RUPS",
    basis: "POJK 42/POJK.04/2020",
    timing: "—",
    layer: "pasar_modal_langsung",
    note:
      "Pemegang Saham Independen adalah pemegang saham yang tidak mempunyai kepentingan ekonomis pribadi dan bukan merupakan pihak terafiliasi dari pihak yang mempunyai benturan kepentingan.",
  },
  {
    id: "pojk9.ptw",
    label:
      "Penawaran Tender Wajib atas sisa saham publik oleh Pengendali baru, apabila terjadi Pengambilalihan yaitu tindakan langsung maupun tidak langsung yang mengakibatkan perubahan Pengendali Perusahaan Terbuka. Pengendali adalah pihak yang memiliki lebih dari 50% saham dengan hak suara yang telah disetor penuh, atau mempunyai kemampuan menentukan pengelolaan dan/atau kebijakan Perusahaan Terbuka.",
    basis: "POJK 9/POJK.04/2018, Pasal 1 angka 4 dan angka 5",
    timing:
      "harga dihitung dari rata-rata harga tertinggi perdagangan harian di Bursa Efek dalam 90 (sembilan puluh) hari sebelum pengumuman",
    layer: "pasar_modal_langsung",
    appliesTo: ["akuisisi_saham", "merger", "divestasi", "streamlining"],
  },
  {
    id: "pojk9.pengumuman",
    label:
      "Pengumuman Pengambilalihan dalam sekurang-kurangnya 1 (satu) surat kabar dan penyampaiannya kepada Otoritas Jasa Keuangan",
    basis: "POJK 9/POJK.04/2018, Pasal 7 ayat (1) huruf a",
    timing: "—",
    layer: "pasar_modal_langsung",
    appliesTo: ["akuisisi_saham", "merger", "divestasi", "streamlining"],
  },
  {
    id: "pojk9.refloat",
    label:
      "Kewajiban Pengendali baru mengalihkan kembali saham kepada masyarakat apabila kepemilikannya melebihi 80% dari modal disetor",
    basis: "POJK 9/POJK.04/2018",
    timing: "dalam jangka waktu 2 (dua) tahun dan tidak dapat diperpanjang",
    layer: "pasar_modal_langsung",
    appliesTo: ["akuisisi_saham", "merger", "divestasi", "streamlining"],
  },
];

/**
 * Where the entity is private but its ultimate parent is Tbk. The obligations
 * land on the parent, not on the entity examined — the report must say so, and
 * must not imply the private target is itself a POJK subject.
 */
export const PASAR_MODAL_INDUK: DDObligation[] = [
  {
    id: "induk.uji_ambang",
    label:
      "Pengujian ambang Transaksi Material di tingkat induk berstatus Terbuka. POJK 17/2020 mencakup setiap transaksi yang dilakukan oleh Perusahaan Terbuka ATAU perusahaan terkendali, sehingga transaksi atas saham/aset Perseroan dapat merupakan Transaksi Material bagi induk. Empat rasio diuji terhadap angka induk: (i) nilai transaksi terhadap ekuitas induk; (ii) total aset objek terhadap total aset induk; (iii) laba bersih objek terhadap laba bersih induk; dan (iv) pendapatan objek terhadap pendapatan induk. Ambang: 20% (atau 10% dari total aset bila ekuitas induk negatif).",
    basis: "POJK 17/POJK.04/2020",
    timing: "dihitung atas dasar laporan keuangan triwulanan terakhir induk yang direviu atau diaudit",
    layer: "pasar_modal_induk",
    note:
      "Angka keuangan induk berada di luar lingkup uji tuntas dari segi hukum. Hasil pengujian rasio hanya dapat dipastikan setelah data keuangan induk disediakan dan diverifikasi oleh pihak yang berkompeten.",
  },
  {
    id: "induk.kewajiban_terpicu",
    label:
      "Apabila ambang terlampaui, kewajiban berikut timbul pada tingkat induk berstatus Terbuka, bukan pada Perseroan: penunjukan Penilai independen; Keterbukaan Informasi melalui situs web induk dan Bursa Efek; penyampaian kepada Otoritas Jasa Keuangan; persetujuan RUPS (atau RUPS Independen) bila tingkatan nilainya tercapai; dan pelaporan dalam laporan tahunan induk.",
    basis: "POJK 17/POJK.04/2020; POJK 42/POJK.04/2020 bila terdapat unsur afiliasi atau benturan kepentingan",
    timing: "penyampaian kepada Otoritas Jasa Keuangan paling lambat 2 (dua) hari kerja setelah terjadinya transaksi",
    layer: "pasar_modal_induk",
  },
  {
    id: "induk.pengecualian_99",
    label:
      "Pengujian pengecualian transaksi dengan atau antar perusahaan terkendali yang sahamnya dimiliki paling sedikit 99%. Bila struktur kepemilikan memenuhi ambang ini, transaksi dapat dikecualikan dari kewajiban Transaksi Material.",
    basis: "POJK 17/POJK.04/2020",
    timing: "—",
    layer: "pasar_modal_induk",
  },
  {
    id: "induk.kedalaman_rantai",
    label:
      "ISU TERBUKA — kedalaman rantai kepemilikan. Sejauh mana pengertian “perusahaan terkendali” menjangkau anak perusahaan tingkat kedua atau lebih rendah dalam struktur grup tidak dijawab secara tegas oleh rumusan POJK 17/2020 dan tidak dapat disimpulkan dari dokumen yang diperiksa.",
    basis: "POJK 17/POJK.04/2020 — memerlukan penafsiran",
    timing: "—",
    layer: "pasar_modal_induk",
    note:
      "Butir ini sengaja disajikan sebagai isu yang wajib diputuskan oleh konsultan hukum penanggung jawab, dan bila diperlukan dikonfirmasi kepada Otoritas Jasa Keuangan. Laporan ini tidak menyimpulkannya.",
  },
];

/**
 * BUMN layer. Deliberately a question framework rather than an assertion of
 * rules: the underlying instruments (UU 19/2003, Peraturan Menteri BUMN,
 * internal holding approvals) have not been verified for this report.
 */
export const BUMN_LAYER: DDObligation[] = [
  {
    id: "bumn.uu19",
    label:
      "PERTANYAAN WAJIB — apakah dan sejauh mana Undang-Undang No. 19 Tahun 2003 tentang Badan Usaha Milik Negara beserta peraturan pelaksanaannya berlaku terhadap transaksi atas saham/aset Perseroan sebagai anak perusahaan BUMN",
    basis: "UU 19/2003 — memerlukan verifikasi",
    timing: "—",
    layer: "bumn",
    note: "Belum diverifikasi untuk laporan ini; wajib dijawab oleh konsultan hukum penanggung jawab.",
  },
  {
    id: "bumn.permen",
    label:
      "PERTANYAAN WAJIB — apakah Peraturan Menteri BUMN yang berlaku mensyaratkan persetujuan atau kajian tertentu untuk pengalihan penyertaan pada anak/cucu perusahaan BUMN",
    basis: "Peraturan Menteri BUMN — memerlukan verifikasi kekinian",
    timing: "—",
    layer: "bumn",
    note: "Belum diverifikasi untuk laporan ini; kekinian peraturan wajib diperiksa pada saat penggunaan.",
  },
  {
    id: "bumn.holding",
    label:
      "PERTANYAAN WAJIB — persetujuan korporasi internal apa yang disyaratkan oleh induk/holding BUMN dan pemegang saham negara sebelum transaksi dapat dilaksanakan",
    basis: "Anggaran dasar induk dan kebijakan internal grup — memerlukan verifikasi",
    timing: "—",
    layer: "bumn",
  },
];

const LAYER_TABLES: Record<DDRegimeLayer, DDObligation[]> = {
  uupt: UUPT_BASELINE,
  pasar_modal_langsung: PASAR_MODAL_LANGSUNG,
  pasar_modal_induk: PASAR_MODAL_INDUK,
  bumn: BUMN_LAYER,
};

/** Obligations applicable to this regime and deal shape, in layer order. */
export function obligationsFor(
  regime: DDRegime,
  txnType: DDTransactionType
): DDObligation[] {
  const out: DDObligation[] = [];
  for (const layer of regime.layers) {
    const table = LAYER_TABLES[layer] ?? [];
    for (const ob of table) {
      if (!ob.appliesTo || ob.appliesTo.indexOf(txnType) !== -1) {
        out.push(ob);
      }
    }
  }
  return out;
}

/** Obligations for one layer only — used to render VII.A / VII.B / VII.C. */
export function obligationsForLayer(
  layer: DDRegimeLayer,
  txnType: DDTransactionType
): DDObligation[] {
  const table = LAYER_TABLES[layer] ?? [];
  return table.filter(
    (ob) => !ob.appliesTo || ob.appliesTo.indexOf(txnType) !== -1
  );
}

// ---------------------------------------------------------------------------
// Prompt guard
// ---------------------------------------------------------------------------

/**
 * The single source of truth for the analysis prompts' regime constraint.
 *
 * Without this, the model will happily cite POJK 17/2020 against a PT Tertutup
 * that is not bound by it, or miss parent-level obligations entirely.
 */
export function regimeGuardText(regime: DDRegime, entityName: string): string {
  const lines: string[] = [];
  lines.push("BATASAN REZIM HUKUM — WAJIB DIPATUHI:");
  lines.push(
    `- ${entityName} tunduk pada Undang-Undang No. 40 Tahun 2007 tentang Perseroan Terbatas (sebagaimana diubah, antara lain oleh UU No. 6 Tahun 2023). Ketentuan UUPT selalu berlaku.`
  );

  if (hasLayer(regime, "pasar_modal_langsung")) {
    lines.push(
      `- ${entityName} adalah Perusahaan Terbuka (Tbk). Rezim pasar modal BERLAKU secara langsung: UU Pasar Modal, POJK 17/2020 (Transaksi Material), POJK 42/2020 (Transaksi Afiliasi dan Benturan Kepentingan), POJK 9/2018 (Pengambilalihan Perusahaan Terbuka), serta ketentuan keterbukaan berkelanjutan dan peraturan Bursa Efek. Analisis wajib menguji ambang Transaksi Material dan, bila terjadi perubahan Pengendali, kewajiban Penawaran Tender Wajib.`
    );
  } else if (hasLayer(regime, "pasar_modal_induk")) {
    lines.push(
      `- ${entityName} BUKAN Perusahaan Terbuka dan karena itu TIDAK terikat POJK mana pun secara langsung. JANGAN menyatakan bahwa ${entityName} wajib memenuhi POJK 17/2020, POJK 42/2020, POJK 9/2018, standar HKHPM/HKHSK, atau kewajiban keterbukaan pasar modal.`
    );
    lines.push(
      `- Namun induk utamanya, ${regime.parentTbkName}, adalah Perusahaan Terbuka. POJK 17/2020 mencakup transaksi yang dilakukan oleh Perusahaan Terbuka ATAU perusahaan terkendali, dengan ambang diukur terhadap angka induk. Analisis wajib mengangkat kemungkinan transaksi ini merupakan Transaksi Material BAGI INDUK, dan menempatkan kewajibannya di tingkat induk — bukan di tingkat ${entityName}.`
    );
    lines.push(
      `- Angka keuangan induk berada di luar lingkup uji tuntas hukum. Bila rasio tidak dapat dihitung dari dokumen yang diperiksa, tandai dengan "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]" dan JANGAN mengarang angka atau menyimpulkan ambang terlampaui/tidak terlampaui.`
    );
    lines.push(
      `- Kedalaman rantai "perusahaan terkendali" terhadap anak perusahaan tingkat kedua adalah isu terbuka. Sajikan sebagai isu yang wajib diputuskan konsultan hukum penanggung jawab; JANGAN menyimpulkannya.`
    );
  } else {
    lines.push(
      `- ${entityName} adalah Perseroan Terbatas Tertutup dan TIDAK ada Perusahaan Terbuka dalam rantai kepemilikannya. Rezim pasar modal TIDAK BERLAKU. JANGAN mengutip UU Pasar Modal, POJK apa pun (termasuk POJK 17/2020, 42/2020, 9/2018, 7/2017, 8/2017), standar profesi HKHPM/HKHSK, atau peraturan Bursa Efek terhadap entitas ini. Mengutip ketentuan yang tidak mengikat adalah kesalahan material dalam laporan.`
    );
  }

  if (hasLayer(regime, "bumn")) {
    lines.push(
      `- ${entityName} berada dalam lingkup grup BUMN. Angkat kebutuhan persetujuan Kementerian BUMN/induk sebagai PERTANYAAN yang wajib dijawab, bukan sebagai kesimpulan — peraturan BUMN yang relevan belum diverifikasi kekiniannya dalam laporan ini.`
    );
  }

  return lines.join("\n");
}
