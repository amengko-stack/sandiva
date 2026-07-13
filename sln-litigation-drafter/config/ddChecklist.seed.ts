import type { DDChecklist } from "@/types/dd";

// Starter checklist from standard Indonesian LDD practice. The firm's
// MPDB-315 / Attachment-A content extends `base`/`overlays` — shape is fixed.
export const SEED_CHECKLIST: DDChecklist = {
  version: "seed-1",
  updatedAt: "2026-07-08T00:00:00.000Z",
  base: [
    // --- pendirian_ad ---
    { id: "pendirian_ad.akta_pendirian", aspectId: "pendirian_ad", label: "Akta Pendirian + SK Menkumham", importance: "wajib", keywords: ["akta pendirian", "sk menkumham", "pengesahan"], source: "base" },
    { id: "pendirian_ad.anggaran_dasar_terkini", aspectId: "pendirian_ad", label: "Anggaran Dasar terkini (seluruh perubahan)", importance: "wajib", keywords: ["anggaran dasar", "perubahan anggaran dasar", "akta perubahan"], source: "base" },
    { id: "pendirian_ad.profil_ahu", aspectId: "pendirian_ad", label: "Profil Perusahaan AHU Online", importance: "penting", keywords: ["ahu", "profil perusahaan", "ditjen ahu"], source: "base" },
    // --- permodalan_saham ---
    { id: "permodalan_saham.struktur_saham", aspectId: "permodalan_saham", label: "Daftar Pemegang Saham & struktur permodalan", importance: "wajib", keywords: ["daftar pemegang saham", "dps", "struktur permodalan"], source: "base" },
    { id: "permodalan_saham.akta_perubahan_modal", aspectId: "permodalan_saham", label: "Akta perubahan modal / pengalihan saham", importance: "wajib", keywords: ["pengalihan saham", "jual beli saham", "peningkatan modal"], source: "base" },
    { id: "permodalan_saham.bukti_setor", aspectId: "permodalan_saham", label: "Bukti penyetoran modal", importance: "penting", keywords: ["bukti setor", "penyetoran modal"], source: "base" },
    // --- pengurus ---
    { id: "pengurus.akta_pengurus", aspectId: "pengurus", label: "Akta pengangkatan Direksi & Komisaris terkini", importance: "wajib", keywords: ["pengangkatan direksi", "komisaris", "susunan pengurus"], source: "base" },
    { id: "pengurus.rups_terakhir", aspectId: "pengurus", label: "Risalah RUPS Tahunan 3 tahun terakhir", importance: "penting", keywords: ["rups", "risalah rapat", "keputusan sirkuler"], source: "base" },
    // --- perizinan ---
    { id: "perizinan.nib", aspectId: "perizinan", label: "NIB (Nomor Induk Berusaha) / OSS", importance: "wajib", keywords: ["nib", "nomor induk berusaha", "oss"], source: "base" },
    { id: "perizinan.izin_usaha_sektoral", aspectId: "perizinan", label: "Izin usaha sektoral sesuai KBLI", importance: "wajib", keywords: ["izin usaha", "sertifikat standar", "kbli"], source: "base" },
    { id: "perizinan.domisili_npwp", aspectId: "perizinan", label: "NPWP perusahaan & keterangan domisili", importance: "wajib", keywords: ["npwp", "domisili"], source: "base" },
    // --- harta_kekayaan ---
    { id: "harta_kekayaan.sertifikat_tanah", aspectId: "harta_kekayaan", label: "Sertifikat tanah/bangunan (HGB/HM/HGU)", importance: "penting", keywords: ["sertifikat", "hgb", "hak milik", "hgu", "shgb"], source: "base" },
    { id: "harta_kekayaan.daftar_aset", aspectId: "harta_kekayaan", label: "Daftar aset tetap & kendaraan", importance: "penting", keywords: ["daftar aset", "aset tetap", "bpkb"], source: "base" },
    { id: "harta_kekayaan.jaminan", aspectId: "harta_kekayaan", label: "Dokumen pembebanan jaminan (HT/fidusia/gadai)", importance: "wajib", keywords: ["hak tanggungan", "fidusia", "gadai", "jaminan"], source: "base" },
    // --- perjanjian_penting ---
    { id: "perjanjian_penting.perjanjian_kredit", aspectId: "perjanjian_penting", label: "Perjanjian kredit / pembiayaan", importance: "wajib", keywords: ["perjanjian kredit", "fasilitas", "pembiayaan", "loan"], source: "base" },
    { id: "perjanjian_penting.perjanjian_material", aspectId: "perjanjian_penting", label: "Perjanjian material dengan pihak ketiga", importance: "wajib", keywords: ["perjanjian kerja sama", "pks", "supply", "distribusi", "sewa"], source: "base" },
    { id: "perjanjian_penting.perjanjian_afiliasi", aspectId: "perjanjian_penting", label: "Perjanjian dengan pihak terafiliasi", importance: "penting", keywords: ["afiliasi", "pihak berelasi", "intercompany"], source: "base" },
    // --- ketenagakerjaan ---
    { id: "ketenagakerjaan.pp_pkb", aspectId: "ketenagakerjaan", label: "Peraturan Perusahaan / PKB yang disahkan", importance: "wajib", keywords: ["peraturan perusahaan", "pkb", "perjanjian kerja bersama"], expiryRule: { kind: "fixed_years", years: 2 }, source: "base" },
    { id: "ketenagakerjaan.wlkp", aspectId: "ketenagakerjaan", label: "Wajib Lapor Ketenagakerjaan (WLKP)", importance: "penting", keywords: ["wajib lapor", "wlkp"], expiryRule: { kind: "fixed_years", years: 1 }, source: "base" },
    { id: "ketenagakerjaan.bpjs", aspectId: "ketenagakerjaan", label: "Bukti kepesertaan & pembayaran BPJS", importance: "penting", keywords: ["bpjs", "jamsostek"], source: "base" },
    // --- perpajakan ---
    { id: "perpajakan.spt_tahunan", aspectId: "perpajakan", label: "SPT Tahunan PPh Badan 3 tahun terakhir", importance: "wajib", keywords: ["spt", "pph badan", "pajak tahunan"], source: "base" },
    { id: "perpajakan.skf", aspectId: "perpajakan", label: "Surat Keterangan Fiskal / bukti tidak ada tunggakan", importance: "penting", keywords: ["keterangan fiskal", "tunggakan pajak"], source: "base" },
    // --- asuransi ---
    { id: "asuransi.polis", aspectId: "asuransi", label: "Polis asuransi aset & usaha yang berlaku", importance: "penting", keywords: ["polis", "asuransi"], expiryRule: { kind: "fixed_years", years: 1 }, source: "base" },
    // --- perkara ---
    { id: "perkara.daftar_perkara", aspectId: "perkara", label: "Daftar perkara / surat pernyataan tidak ada sengketa", importance: "wajib", keywords: ["perkara", "gugatan", "sengketa", "somasi", "pernyataan"], source: "base" },
  ],
  overlays: {
    merger: [
      { id: "pengurus.rups_merger", aspectId: "pengurus", label: "Persetujuan RUPS atas rencana Penggabungan", importance: "wajib", keywords: ["rups", "penggabungan", "merger"], appliesTo: ["merger"], source: "overlay" },
      { id: "perjanjian_penting.rancangan_merger", aspectId: "perjanjian_penting", label: "Rancangan Penggabungan (merger plan)", importance: "wajib", keywords: ["rancangan penggabungan", "merger plan"], appliesTo: ["merger"], source: "overlay" },
    ],
    likuidasi: [
      { id: "pengurus.rups_pembubaran", aspectId: "pengurus", label: "Keputusan RUPS pembubaran & penunjukan likuidator", importance: "wajib", keywords: ["pembubaran", "likuidator", "rups"], appliesTo: ["likuidasi"], source: "overlay" },
      { id: "perpajakan.pencabutan_npwp", aspectId: "perpajakan", label: "Status kewajiban pajak untuk penutupan (pemeriksaan/pencabutan NPWP)", importance: "penting", keywords: ["pencabutan npwp", "pemeriksaan pajak"], appliesTo: ["likuidasi"], source: "overlay" },
    ],
    akuisisi_saham: [
      { id: "permodalan_saham.persetujuan_coc", aspectId: "permodalan_saham", label: "Persetujuan pihak ketiga atas perubahan pengendalian (jika dipersyaratkan)", importance: "penting", keywords: ["change of control", "persetujuan kreditur", "konsen"], appliesTo: ["akuisisi_saham"], source: "overlay" },
    ],
  },
  extractionFields: [
    { id: "para_pihak", label: "Para Pihak", type: "text", prompt: "Sebutkan seluruh pihak dalam perjanjian ini.", appliesToKeywords: [] },
    { id: "tanggal_efektif", label: "Tanggal Efektif", type: "date", prompt: "Tanggal penandatanganan/efektif perjanjian (format YYYY-MM-DD bila mungkin).", appliesToKeywords: [] },
    { id: "jangka_waktu", label: "Jangka Waktu / Berakhir", type: "text", prompt: "Jangka waktu perjanjian dan tanggal berakhirnya.", appliesToKeywords: [] },
    { id: "nilai", label: "Nilai", type: "currency", prompt: "Nilai/harga/plafon dalam perjanjian (dengan mata uang).", appliesToKeywords: [] },
    { id: "hukum_yang_berlaku", label: "Hukum yang Berlaku & Forum", type: "text", prompt: "Pilihan hukum dan forum penyelesaian sengketa.", appliesToKeywords: [] },
    { id: "change_of_control", label: "Change of Control", type: "verbatim", prompt: "Kutip klausul yang mensyaratkan persetujuan/pemberitahuan bila terjadi perubahan pengendalian atau pemegang saham.", appliesToKeywords: [], dealTriggerFor: ["akuisisi_saham", "merger", "divestasi", "streamlining"] },
    { id: "larangan_pengalihan", label: "Larangan Pengalihan / Assignment", type: "verbatim", prompt: "Kutip klausul pembatasan pengalihan hak/kewajiban atau saham.", appliesToKeywords: [], dealTriggerFor: ["akuisisi_saham", "akuisisi_aset", "merger", "divestasi"] },
    { id: "pengakhiran", label: "Pengakhiran", type: "verbatim", prompt: "Kutip ketentuan pengakhiran sepihak / events of default.", appliesToKeywords: [] },
    { id: "jaminan_agunan", label: "Jaminan / Agunan", type: "verbatim", prompt: "Kutip ketentuan jaminan, agunan, atau negative covenant atas aset.", appliesToKeywords: ["kredit", "pembiayaan", "fasilitas", "loan"], dealTriggerFor: ["akuisisi_aset", "likuidasi"] },
    { id: "non_compete", label: "Non-Compete / Eksklusivitas", type: "verbatim", prompt: "Kutip klausul non-compete atau eksklusivitas.", appliesToKeywords: [] },
  ],
};
