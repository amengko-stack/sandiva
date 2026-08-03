/**
 * Per-checklist-item legal rationale for gap findings.
 *
 * Why this exists: gap findings are generated in code, not by the model, so
 * before this table every missing document produced the same three sentences
 * ("Dokumen wajib — ketiadaannya menghambat penilaian aspek ini…"). On a
 * document-poor data room that is most of the report body, and it tells the
 * client nothing about why the law wants that particular document.
 *
 * Keyed by DDExpectedDoc.id. Items with no entry — notably AI-tailored ones —
 * fall back to the generic wording in gap-engine.ts, so this table can be
 * filled in incrementally without breaking anything.
 *
 * CITATION DISCIPLINE: cite an article only where the article is actually
 * known. Where it is not, cite at regulation level and say so. Never invent an
 * article number — a wrong citation in a client-facing report is worse than a
 * general one. `legalRefs` flows into DDFinding.regulationRefs, which the
 * existing Perplexity currency check verifies, so a superseded citation gets
 * flagged automatically rather than silently shipping.
 */
export interface DDGapRationale {
  /** Why the law or professional standard requires this document. One sentence. */
  legalBasis: string;
  /** Citations, checked for currency downstream. Article-level only where certain. */
  legalRefs: string[];
  /** What its absence means for THIS transaction — the consequence, not a restatement. */
  absenceImpact: string;
  /** Where/how the document is obtained, when that is more specific than "ask the target". */
  remediation?: string;
}

export const DD_GAP_RATIONALE: Record<string, DDGapRationale> = {
  "pendirian_ad.akta_pendirian": {
    legalBasis:
      "Perseroan didirikan dengan akta notaris dalam bahasa Indonesia dan memperoleh status badan hukum pada tanggal diterbitkannya keputusan pengesahan oleh Menteri.",
    legalRefs: ["UUPT Pasal 7 ayat (1)", "UUPT Pasal 7 ayat (4)"],
    absenceImpact:
      "Tanpa akta pendirian beserta keputusan pengesahan Menteri, tanggal perolehan status badan hukum Perseroan tidak dapat dipastikan, sehingga keabsahan seluruh tindakan korporasi sejak pendirian — termasuk sahnya kepemilikan saham yang akan dialihkan dalam transaksi ini — tidak dapat disimpulkan.",
    remediation:
      "Minta salinan akta dari notaris yang membuatnya, dan salinan keputusan pengesahan Menteri dari Perseroan atau melalui AHU Online.",
  },

  "pendirian_ad.anggaran_dasar_terkini": {
    legalBasis:
      "Anggaran dasar memuat ketentuan yang mengikat Perseroan, dan setiap perubahannya ditetapkan oleh RUPS serta wajib memperoleh persetujuan atau diberitahukan kepada Menteri.",
    legalRefs: ["UUPT Pasal 15", "UUPT Pasal 21"],
    absenceImpact:
      "Tanpa anggaran dasar terkini beserta seluruh riwayat perubahannya, ketentuan yang berlaku mengenai kewenangan organ Perseroan, pembatasan pengalihan saham, dan persyaratan kuorum RUPS untuk menyetujui transaksi ini tidak dapat dipastikan.",
    remediation:
      "Minta akta perubahan anggaran dasar terakhir beserta bukti persetujuan/penerimaan pemberitahuan Menteri, dan lakukan rekonsiliasi terhadap Profil Perusahaan AHU Online.",
  },

  "pendirian_ad.profil_ahu": {
    legalBasis:
      "Profil Perusahaan yang tercatat dalam Sistem Administrasi Badan Hukum (AHU Online) merupakan basis data resmi Kementerian yang mencerminkan status hukum dan data korporasi Perseroan yang berlaku saat ini.",
    legalRefs: [],
    absenceImpact:
      "Tanpa profil AHU Online, data anggaran dasar dan susunan pengurus yang disampaikan oleh Perseroan tidak dapat direkonsiliasi terhadap basis data resmi Kementerian, sehingga terdapat risiko dokumen yang diserahkan telah kedaluwarsa atau belum mencerminkan perubahan yang tercatat.",
    remediation:
      "Unduh profil terkini dari AHU Online menggunakan nomor pengesahan/pendaftaran Perseroan.",
  },

  "permodalan_saham.struktur_saham": {
    legalBasis:
      "Direksi wajib menyelenggarakan dan menyimpan daftar pemegang saham serta daftar khusus yang memuat keterangan kepemilikan saham anggota Direksi dan Dewan Komisaris beserta keluarganya.",
    legalRefs: ["UUPT Pasal 50 ayat (1)", "UUPT Pasal 50 ayat (2)"],
    absenceImpact:
      "Tanpa daftar pemegang saham, susunan kepemilikan yang menjadi objek transaksi tidak dapat diverifikasi terhadap dokumen korporasi, sehingga kewenangan penjual untuk mengalihkan saham dan ada tidaknya kepemilikan pihak terafiliasi tidak dapat dipastikan.",
  },

  "permodalan_saham.akta_perubahan_modal": {
    legalBasis:
      "Pengalihan hak atas saham dilakukan dengan akta pemindahan hak, dan penambahan modal ditempatkan serta disetor ditetapkan oleh RUPS.",
    legalRefs: ["UUPT Pasal 56 ayat (1)", "UUPT Pasal 41"],
    absenceImpact:
      "Tanpa rangkaian akta pengalihan saham dan perubahan modal, mata rantai kepemilikan (chain of title) atas saham yang akan dialihkan tidak dapat ditelusuri sampai ke pendirian, sehingga terdapat risiko cacat kepemilikan yang tidak terdeteksi.",
    remediation:
      "Minta seluruh akta pemindahan hak atas saham dan akta perubahan modal secara berurutan sejak pendirian, beserta bukti pemberitahuan kepada Menteri.",
  },

  "permodalan_saham.bukti_setor": {
    legalBasis:
      "Modal yang ditempatkan wajib disetor penuh, dan bukti penyetoran yang sah wajib disampaikan.",
    legalRefs: ["UUPT Pasal 33"],
    absenceImpact:
      "Tanpa bukti penyetoran, tidak dapat dipastikan bahwa modal telah disetor penuh; kekurangan penyetoran dapat menimbulkan tanggung jawab pemegang saham atas kekurangan tersebut dan mempengaruhi nilai transaksi.",
  },

  "permodalan_saham.persetujuan_coc": {
    legalBasis:
      "Persetujuan pihak ketiga atas perubahan pengendalian merupakan kewajiban kontraktual, bukan kewajiban berdasarkan Undang-Undang, yang timbul apabila diperjanjikan secara tegas dalam perjanjian yang mengikat Perseroan.",
    legalRefs: [],
    absenceImpact:
      "Tanpa dokumen persetujuan tersebut, tidak dapat dipastikan apakah kreditor atau mitra kontraktual Perseroan mensyaratkan konsen atas perubahan pengendalian yang timbul dari transaksi ini, sehingga terdapat risiko wanprestasi kontraktual apabila persetujuan yang disyaratkan belum diperoleh sebelum closing.",
  },

  "pengurus.akta_pengurus": {
    legalBasis:
      "Anggota Direksi dan anggota Dewan Komisaris diangkat oleh RUPS, dan susunannya diberitahukan kepada Menteri.",
    legalRefs: ["UUPT Pasal 94", "UUPT Pasal 111"],
    absenceImpact:
      "Tanpa akta pengangkatan terkini, kewenangan pihak yang akan menandatangani dokumen transaksi atas nama Perseroan tidak dapat dipastikan, sehingga terdapat risiko dokumen transaksi ditandatangani oleh pihak yang tidak berwenang.",
  },

  "pengurus.rups_terakhir": {
    legalBasis:
      "Setiap penyelenggaraan RUPS wajib dibuatkan risalah yang ditandatangani oleh ketua rapat dan paling sedikit 1 (satu) pemegang saham yang ditunjuk dari dan oleh peserta RUPS.",
    legalRefs: ["UUPT Pasal 90 ayat (1)"],
    absenceImpact:
      "Tanpa risalah RUPS, keputusan korporasi yang menjadi dasar tindakan Perseroan — termasuk persetujuan laporan tahunan dan pengangkatan pengurus — tidak dapat diverifikasi keabsahannya, dan pemenuhan kuorum tidak dapat diuji.",
  },

  "pengurus.risalah_direksi_komisaris": {
    legalBasis:
      "Risalah rapat Direksi dan rapat Dewan Komisaris wajib dibuat dan disimpan oleh Perseroan sebagai dokumen Perseroan.",
    legalRefs: ["UUPT Pasal 100", "UUPT Pasal 116"],
    absenceImpact:
      "Tanpa risalah rapat Direksi dan Dewan Komisaris, keputusan pengurusan dan pengawasan yang material — termasuk persetujuan Dewan Komisaris yang disyaratkan anggaran dasar untuk tindakan tertentu — tidak dapat diverifikasi.",
  },

  "pengurus.rups_merger": {
    legalBasis:
      "Penggabungan Perseroan ditetapkan dengan keputusan RUPS masing-masing perseroan yang akan bergabung, dengan kuorum dan persyaratan persetujuan tertentu.",
    // Pasal 89 is the quorum/approval provision for a merger RUPS (3/4 and 3/4).
    // Not Pasal 127, which governs the newspaper announcement and employee notice.
    legalRefs: ["UUPT Pasal 89", "UUPT Pasal 123"],
    absenceImpact:
      "Tanpa risalah RUPS yang menyetujui rencana Penggabungan, keabsahan keputusan korporasi yang menjadi dasar pelaksanaan Penggabungan tidak dapat dipastikan, sehingga pemenuhan kuorum dan persyaratan persetujuan yang disyaratkan Undang-Undang tidak dapat diverifikasi.",
  },

  "pengurus.rups_pembubaran": {
    legalBasis:
      "Pembubaran Perseroan ditetapkan dengan keputusan RUPS yang sekaligus menunjuk likuidator untuk melaksanakan pemberesan harta kekayaan Perseroan.",
    legalRefs: ["UUPT Pasal 142", "UUPT Pasal 147"],
    absenceImpact:
      "Tanpa risalah RUPS pembubaran dan penunjukan likuidator, kewenangan pihak yang melaksanakan pemberesan harta kekayaan tidak dapat dipastikan, sehingga keabsahan tindakan likuidator dalam proses pembubaran tidak dapat diverifikasi.",
  },

  "perizinan.nib": {
    legalBasis:
      "Kegiatan usaha wajib memiliki Nomor Induk Berusaha yang diterbitkan melalui sistem Online Single Submission sebagai identitas dan legalitas dasar pelaku usaha untuk menjalankan kegiatan usahanya.",
    legalRefs: [],
    absenceImpact:
      "Tanpa NIB, legalitas dasar Perseroan untuk menjalankan kegiatan usahanya tidak dapat dipastikan, sehingga terdapat risiko kegiatan usaha yang telah dan akan dijalankan pasca transaksi tidak memiliki dasar perizinan yang sah.",
    remediation:
      "Periksa dan unduh NIB melalui sistem OSS (oss.go.id) menggunakan data Perseroan.",
  },

  "perizinan.izin_usaha_sektoral": {
    legalBasis:
      "Selain NIB, kegiatan usaha pada sektor tertentu memerlukan izin usaha atau sertifikat standar berbasis risiko sesuai klasifikasi baku lapangan usaha (KBLI) yang dijalankan.",
    legalRefs: [],
    absenceImpact:
      "Tanpa izin usaha sektoral yang sesuai KBLI yang dijalankan, tidak dapat dipastikan bahwa seluruh lini kegiatan usaha Perseroan telah memperoleh izin yang disyaratkan, sehingga terdapat risiko kegiatan usaha berjalan tanpa dasar perizinan yang sah atau terhentinya operasional pasca transaksi.",
    remediation:
      "Periksa status perizinan berbasis risiko yang bersangkutan pada sistem OSS sesuai KBLI yang berlaku.",
  },

  "perizinan.domisili_npwp": {
    legalBasis:
      "NPWP merupakan identitas perpajakan yang wajib dimiliki oleh setiap wajib pajak badan; keterangan domisili perusahaan secara historis turut menjadi salah satu dokumen legalitas kedudukan usaha, meskipun fungsinya di banyak daerah telah diserap ke dalam rezim NIB/OSS.",
    legalRefs: [],
    absenceImpact:
      "Tanpa NPWP yang berlaku, kepatuhan perpajakan dasar Perseroan tidak dapat dipastikan; adapun keterangan domisili yang telah kedaluwarsa perlu dinilai relevansinya berdasarkan wilayah dan periode yang diperiksa, mengingat persyaratan tersebut sebagian telah tergantikan oleh legalitas berbasis NIB.",
    remediation:
      "Konfirmasikan kepada notaris atau instansi setempat apakah keterangan domisili masih disyaratkan untuk wilayah dan jenis usaha Perseroan pasca berlakunya rezim OSS.",
  },

  "harta_kekayaan.sertifikat_tanah": {
    legalBasis:
      "Hak atas tanah yang dimiliki suatu badan hukum dibuktikan dengan sertipikat yang diterbitkan oleh kantor pertanahan, yang menjadi bukti kepemilikan dan dasar pendaftaran setiap peralihan atau pembebanan.",
    legalRefs: [],
    absenceImpact:
      "Tanpa sertipikat tanah/bangunan, kepemilikan aset tidak dapat diverifikasi terhadap data resmi kantor pertanahan, sehingga status bebas sengketa dan bebas pembebanan atas aset yang menjadi bagian dari nilai transaksi tidak dapat dipastikan.",
    remediation:
      "Lakukan pengecekan sertipikat pada kantor pertanahan setempat (BPN) untuk memastikan keabsahan dan status pembebanannya.",
  },

  "harta_kekayaan.daftar_aset": {
    legalBasis:
      "Perseroan wajib menyelenggarakan pembukuan yang mencatat seluruh harta kekayaannya, termasuk aset tetap dan kendaraan, sebagai bagian dari tertib administrasi korporasi.",
    legalRefs: [],
    absenceImpact:
      "Tanpa daftar aset tetap dan kendaraan, nilai serta kelengkapan aset yang menjadi bagian dari objek transaksi tidak dapat direkonsiliasi dengan laporan keuangan, sehingga terdapat risiko aset yang tidak tercatat atau telah dialihkan tanpa terdeteksi.",
  },

  "harta_kekayaan.jaminan": {
    legalBasis:
      "Jaminan fidusia lahir pada tanggal dicatatnya dalam Buku Daftar Fidusia, dan hak tanggungan atas tanah lahir pada saat pendaftarannya; pembebanan yang tidak didaftarkan tidak melahirkan hak kebendaan yang berlaku terhadap pihak ketiga.",
    legalRefs: ["UU 42/1999 Pasal 14 ayat (3)", "UU 4/1996"],
    absenceImpact:
      "Tanpa dokumen pembebanan, tidak dapat dipastikan aset mana yang telah dijaminkan kepada kreditor; agunan yang tidak terungkap dapat menghalangi pengalihan aset, memicu ketentuan larangan penjaminan lebih lanjut (negative pledge), dan mengurangi nilai yang sebenarnya diperoleh dalam transaksi.",
    remediation:
      "Minta seluruh akta pembebanan beserta sertifikat jaminan fidusia dan/atau sertifikat hak tanggungan, dan lakukan pemeriksaan pada pangkalan data fidusia serta kantor pertanahan.",
  },

  "perjanjian_penting.perjanjian_kredit": {
    legalBasis:
      "Perjanjian kredit atau pembiayaan yang mengikat Perseroan lazimnya memuat ketentuan mengenai jaminan, negative covenant, dan syarat yang harus dipenuhi debitur selama fasilitas berlangsung.",
    legalRefs: [],
    absenceImpact:
      "Tanpa perjanjian kredit/pembiayaan, klausul perubahan pengendalian (change of control), negative pledge, dan pembatasan pembagian dividen atau perubahan manajemen yang dapat terpicu atau dilanggar oleh pelaksanaan transaksi ini tidak dapat diperiksa, sehingga terdapat risiko wanprestasi atau percepatan pelunasan (acceleration) yang tidak terantisipasi.",
    remediation:
      "Minta salinan lengkap perjanjian kredit beserta seluruh perubahannya (amandemen) dari target atau kreditor.",
  },

  "perjanjian_penting.perjanjian_material": {
    legalBasis:
      "Perjanjian material dengan pihak ketiga — termasuk perjanjian kerja sama, pasokan, distribusi, dan sewa — mengikat Perseroan dan lazimnya memuat ketentuan mengenai keberlangsungan hubungan kontraktual apabila terjadi perubahan pengendalian.",
    legalRefs: [],
    absenceImpact:
      "Tanpa perjanjian material, klausul larangan pengalihan, persetujuan perubahan pengendalian, dan pembatasan perubahan manajemen yang dapat terpicu oleh transaksi ini tidak dapat diperiksa, sehingga terdapat risiko hubungan usaha yang material bagi Perseroan berakhir atau berubah akibat pelaksanaan transaksi.",
  },

  "perjanjian_penting.perjanjian_afiliasi": {
    legalBasis:
      "Perjanjian dengan pihak terafiliasi merupakan transaksi yang berpotensi menimbulkan benturan kepentingan dan perlu diperiksa kewajaran persyaratannya dibandingkan dengan transaksi dengan pihak independen (arm's length).",
    legalRefs: [],
    absenceImpact:
      "Tanpa perjanjian afiliasi, ketergantungan Perseroan pada pihak terafiliasi serta kewajaran ketentuan yang mengikat Perseroan dalam perjanjian tersebut tidak dapat dinilai, sehingga eksposur yang dapat timbul pasca transaksi apabila hubungan afiliasi tersebut berubah atau berakhir tidak dapat dipastikan.",
  },

  "perjanjian_penting.rancangan_merger": {
    legalBasis:
      "Direksi perseroan yang akan menggabungkan diri wajib menyusun rancangan Penggabungan yang memuat rincian persyaratan Penggabungan sebelum diajukan kepada RUPS masing-masing.",
    // Pasal 122-123 govern penggabungan. Pasal 125-126 govern pengambilalihan,
    // a different transaction, so they do not belong on a merger-plan item.
    legalRefs: ["UUPT Pasal 122", "UUPT Pasal 123"],
    absenceImpact:
      "Tanpa rancangan Penggabungan, syarat dan tata cara Penggabungan yang telah disepakati Direksi masing-masing pihak — termasuk tata cara konversi saham dan perlindungan kreditor — tidak dapat diperiksa, sehingga kesesuaian pelaksanaan Penggabungan dengan rancangan yang disetujui tidak dapat dipastikan.",
  },

  "ketenagakerjaan.pp_pkb": {
    legalBasis:
      "Pengusaha yang mempekerjakan paling sedikit 10 (sepuluh) orang pekerja wajib membuat peraturan perusahaan yang mulai berlaku setelah disahkan oleh instansi yang berwenang di bidang ketenagakerjaan.",
    legalRefs: ["UU 13/2003 Pasal 108 ayat (1)", "UU 6/2023"],
    absenceImpact:
      "Tanpa peraturan perusahaan atau perjanjian kerja bersama yang disahkan, syarat kerja yang berlaku bagi pekerja tidak dapat dipastikan, sehingga eksposur atas hak pekerja yang timbul akibat transaksi — termasuk hak yang berkaitan dengan peralihan pengendalian — tidak dapat dihitung.",
  },

  "ketenagakerjaan.wlkp": {
    legalBasis:
      "Setiap pengusaha wajib melaporkan keadaan ketenagakerjaan di perusahaannya (Wajib Lapor Ketenagakerjaan) secara berkala kepada instansi yang berwenang di bidang ketenagakerjaan.",
    legalRefs: [],
    absenceImpact:
      "Tanpa bukti WLKP yang berlaku, kepatuhan Perseroan terhadap kewajiban pelaporan ketenagakerjaan tidak dapat dipastikan, sehingga terdapat risiko sanksi administratif yang belum terungkap dalam pemeriksaan ini.",
  },

  "ketenagakerjaan.bpjs": {
    legalBasis:
      "Pemberi kerja wajib mendaftarkan pekerjanya sebagai peserta program jaminan sosial dan membayarkan iuran yang menjadi kewajibannya secara tertib.",
    legalRefs: ["UU 24/2011", "UU 40/2004"],
    absenceImpact:
      "Tanpa bukti kepesertaan dan pembayaran BPJS, tunggakan iuran yang menjadi tanggung jawab Perseroan tidak dapat dipastikan jumlahnya, sehingga terdapat eksposur kewajiban yang belum tercermin dalam laporan keuangan dan berpotensi beralih kepada pembeli pasca transaksi.",
  },

  "perpajakan.spt_tahunan": {
    legalBasis:
      "Wajib pajak badan wajib menyampaikan Surat Pemberitahuan Tahunan Pajak Penghasilan sebagai sarana pelaporan dan pertanggungjawaban penghitungan pajak yang terutang.",
    legalRefs: [],
    absenceImpact:
      "Tanpa SPT Tahunan 3 (tiga) tahun terakhir, kepatuhan perpajakan dan potensi kurang bayar Perseroan tidak dapat dinilai, sehingga eksposur pajak yang dapat beralih atau mempengaruhi nilai transaksi tidak dapat dihitung.",
  },

  "perpajakan.skf": {
    legalBasis:
      "Surat Keterangan Fiskal diterbitkan oleh otoritas pajak sebagai konfirmasi status kepatuhan wajib pajak, termasuk ada tidaknya tunggakan pajak.",
    legalRefs: [],
    absenceImpact:
      "Tanpa Surat Keterangan Fiskal, tidak dapat dipastikan bahwa Perseroan tidak memiliki tunggakan pajak yang tercatat pada otoritas pajak, sehingga terdapat risiko kewajiban pajak yang belum terungkap dalam pemeriksaan dokumen internal.",
    remediation:
      "Minta Surat Keterangan Fiskal yang diterbitkan Direktorat Jenderal Pajak (DJP) melalui target atau kuasanya.",
  },

  "perpajakan.laporan_keuangan_audit": {
    legalBasis:
      "Laporan Keuangan Auditan 3 (tiga) tahun terakhir merupakan salah satu bidang pemeriksaan wajib berdasarkan Standar Profesi Konsultan Hukum Pasar Modal untuk menilai kondisi keuangan dan kepatuhan pelaporan Perseroan.",
    legalRefs: ["Standar Profesi HKHPM/HKHSK Kep.02/HKHPM/VIII/2018 jo. Kep.03/HKHPM/XI/2021"],
    absenceImpact:
      "Tanpa laporan keuangan auditan, kondisi keuangan, opini akuntan, dan catatan atas laporan keuangan yang menjadi dasar penilaian nilai transaksi tidak dapat diverifikasi secara independen, sehingga representasi keuangan yang disampaikan target tidak dapat diuji.",
  },

  "perpajakan.pencabutan_npwp": {
    legalBasis:
      "Pembubaran Perseroan lazimnya diikuti dengan penyelesaian kewajiban perpajakan dan pencabutan NPWP sebagai bagian dari penutupan status wajib pajak.",
    legalRefs: [],
    absenceImpact:
      "Tanpa dokumen status pemeriksaan atau pencabutan NPWP, tidak dapat dipastikan bahwa seluruh kewajiban perpajakan Perseroan telah diselesaikan sebelum pembubaran, sehingga terdapat risiko kewajiban pajak yang timbul setelah proses likuidasi berjalan.",
  },

  "asuransi.polis": {
    legalBasis:
      "Kecukupan perlindungan asuransi atas aset material merupakan salah satu bidang pemeriksaan yang lazim dinilai untuk memastikan aset yang menjadi objek transaksi terlindungi dari risiko kerugian.",
    legalRefs: [],
    absenceImpact:
      "Tanpa polis asuransi yang berlaku, tidak dapat dipastikan bahwa aset material Perseroan memiliki perlindungan yang memadai, sehingga risiko kerugian atas aset tersebut sepenuhnya menjadi eksposur yang belum terukur bagi pembeli pasca transaksi.",
  },

  "asuransi.surat_pernyataan_direksi": {
    legalBasis:
      "Direksi lazimnya diminta menyatakan secara tertulis mengenai kecukupan nilai pertanggungan asuransi atas aset material Perseroan sebagai bagian dari standar pemeriksaan uji tuntas.",
    legalRefs: ["Standar Profesi HKHPM/HKHSK Kep.02/HKHPM/VIII/2018 jo. Kep.03/HKHPM/XI/2021"],
    absenceImpact:
      "Tanpa surat pernyataan Direksi, penilaian mengenai kecukupan nilai pertanggungan asuransi atas aset material sepenuhnya bergantung pada polis yang ada tanpa konfirmasi manajemen, sehingga kesimpulan atas kecukupan perlindungan aset bersifat tidak lengkap.",
  },

  "perkara.daftar_perkara": {
    legalBasis:
      "Keberadaan atau ketiadaan perkara yang melibatkan Perseroan merupakan bidang pemeriksaan pokok dalam uji tuntas hukum untuk menilai eksposur litigasi yang dapat mempengaruhi kelangsungan usaha dan nilai transaksi.",
    legalRefs: [],
    absenceImpact:
      "Tanpa daftar perkara atau surat pernyataan tidak ada sengketa, eksposur litigasi yang dihadapi Perseroan tidak dapat dipastikan, sehingga potensi kewajiban atau gangguan usaha akibat perkara yang belum terungkap tidak dapat dinilai.",
    remediation:
      "Lakukan pengecekan pada Sistem Informasi Penelusuran Perkara (SIPP) pengadilan yang relevan sebagai pelengkap pernyataan target.",
  },

  "perkara.pernyataan_direksi_komisaris": {
    legalBasis:
      "Direksi dan Dewan Komisaris lazimnya diminta menyatakan secara tertulis mengenai ada atau tidaknya perkara yang melibatkan Perseroan sebagai bagian dari standar pemeriksaan uji tuntas.",
    legalRefs: ["Standar Profesi HKHPM/HKHSK Kep.02/HKHPM/VIII/2018 jo. Kep.03/HKHPM/XI/2021"],
    absenceImpact:
      "Tanpa surat pernyataan Direksi dan Dewan Komisaris, konfirmasi manajemen mengenai keberadaan perkara yang belum tentu tercermin dalam pencarian basis data pengadilan tidak dapat diperoleh, sehingga kesimpulan atas aspek perkara bersifat tidak lengkap.",
  },

  "regime.pm_lk_triwulan_tbk": {
    legalBasis:
      "Perusahaan Terbuka wajib menyampaikan laporan keuangan triwulanan kepada Otoritas Jasa Keuangan dan bursa dalam jangka waktu yang ditentukan.",
    legalRefs: [],
    absenceImpact:
      "Tanpa laporan keuangan triwulanan terkini, kondisi keuangan Perseroan sebagai Perusahaan Terbuka tidak dapat dinilai berdasarkan laporan yang wajib disampaikan kepada OJK, sehingga representasi keuangan yang mendasari transaksi tidak dapat diverifikasi terhadap laporan resmi yang dipublikasikan.",
  },

  "regime.pm_keterbukaan_informasi": {
    legalBasis:
      "Perusahaan Terbuka wajib mengumumkan keterbukaan informasi kepada masyarakat atas setiap informasi atau fakta material yang dapat mempengaruhi harga efek atau keputusan investor.",
    legalRefs: ["UU 8/1995"],
    absenceImpact:
      "Tanpa bukti keterbukaan informasi terkait transaksi, tidak dapat dipastikan bahwa kewajiban pengungkapan kepada publik dan OJK telah dipenuhi, sehingga terdapat risiko transaksi ini dianggap belum sah secara prosedur pasar modal atau menimbulkan sanksi administratif.",
  },

  "regime.pm_penilai_independen": {
    legalBasis:
      "Transaksi material dan transaksi afiliasi tertentu yang melibatkan Perusahaan Terbuka wajib didukung oleh penilaian pihak independen untuk menentukan kewajaran nilai transaksi.",
    legalRefs: ["POJK 17/POJK.04/2020"],
    absenceImpact:
      "Tanpa laporan Penilai Independen, kewajaran nilai transaksi bagi Perusahaan Terbuka dan pemegang sahamnya tidak dapat dipastikan, sehingga terdapat risiko transaksi dianggap tidak memenuhi persyaratan prosedural yang diwajibkan sebelum pelaksanaannya.",
  },

  "regime.pm_rups_independen": {
    legalBasis:
      "Transaksi afiliasi atau benturan kepentingan tertentu yang melibatkan Perusahaan Terbuka memerlukan persetujuan pemegang saham independen dalam RUPS.",
    legalRefs: ["POJK 42/POJK.04/2020", "POJK 15/POJK.04/2020"],
    absenceImpact:
      "Tanpa risalah RUPS Independen, keabsahan persetujuan pemegang saham independen atas transaksi yang mengandung benturan kepentingan tidak dapat dipastikan, sehingga terdapat risiko transaksi dapat dibatalkan atau digugat oleh pemegang saham independen yang berkeberatan.",
  },

  "regime.pm_penawaran_tender_wajib": {
    legalBasis:
      "Pihak yang mengambil alih pengendalian atas Perusahaan Terbuka wajib melakukan Penawaran Tender Wajib kepada seluruh pemegang saham lainnya.",
    legalRefs: ["POJK 9/POJK.04/2018"],
    absenceImpact:
      "Tanpa dokumen Penawaran Tender Wajib, tidak dapat dipastikan bahwa kewajiban pengambilalih untuk menawar saham pemegang saham publik lainnya telah atau akan dipenuhi, sehingga terdapat risiko pelanggaran kewajiban prosedural pasar modal yang dapat menghambat penyelesaian transaksi ini.",
  },

  "regime.pm_keterbukaan_berkelanjutan": {
    legalBasis:
      "Perusahaan Terbuka wajib memenuhi kewajiban pelaporan dan keterbukaan berkelanjutan secara berkala kepada OJK dan bursa selama status keterbukaannya berlangsung.",
    legalRefs: [],
    absenceImpact:
      "Tanpa bukti pemenuhan keterbukaan berkelanjutan, kepatuhan Perseroan terhadap kewajiban pelaporan berkala kepada OJK dan bursa tidak dapat dipastikan, sehingga terdapat risiko sanksi administratif yang belum terungkap dalam pemeriksaan ini.",
  },

  "regime.pm_triwulan_induk_tbk": {
    legalBasis:
      "Induk Perusahaan Terbuka wajib menyampaikan laporan keuangan triwulanan kepada Otoritas Jasa Keuangan dan bursa, yang turut mencerminkan konsolidasi kinerja anak perusahaan yang menjadi target dalam transaksi ini.",
    legalRefs: [],
    absenceImpact:
      "Tanpa laporan keuangan triwulanan induk Tbk, dampak transaksi ini terhadap laporan keuangan konsolidasian induk — dan kewajiban pelaporannya kepada OJK — tidak dapat dinilai, meskipun kewajiban pelaporan tersebut melekat pada induk dan bukan pada target sebagai perusahaan tertutup.",
  },

  "regime.pm_keterbukaan_informasi_induk": {
    legalBasis:
      "Induk Perusahaan Terbuka wajib mengumumkan keterbukaan informasi atas transaksi material yang dilakukan oleh anak perusahaannya apabila transaksi tersebut memenuhi ambang batas materialitas bagi induk.",
    legalRefs: ["UU 8/1995"],
    absenceImpact:
      "Tanpa bukti keterbukaan informasi oleh induk Tbk, tidak dapat dipastikan bahwa kewajiban pengungkapan atas transaksi ini telah dipenuhi pada tingkat induk, sehingga terdapat risiko transaksi dianggap belum memenuhi prosedur keterbukaan yang wajib dipatuhi oleh induk, meskipun target sendiri bukan subjek POJK.",
  },

  "regime.pm_penilai_independen_induk": {
    legalBasis:
      "Transaksi material atau afiliasi yang dilakukan oleh anak perusahaan dapat mewajibkan induk Tbk untuk memperoleh penilaian pihak independen apabila transaksi tersebut memenuhi kriteria yang disyaratkan bagi induk.",
    legalRefs: ["POJK 17/POJK.04/2020"],
    absenceImpact:
      "Tanpa laporan Penilai Independen pada tingkat induk, kewajaran nilai transaksi ini dari perspektif kewajiban induk sebagai Perusahaan Terbuka tidak dapat dipastikan, meskipun kewajiban tersebut melekat pada induk dan tidak menjadikan target sendiri sebagai subjek POJK.",
  },

  "regime.pm_rups_independen_induk": {
    legalBasis:
      "Transaksi afiliasi atau benturan kepentingan yang dilakukan oleh anak perusahaan dapat mewajibkan persetujuan pemegang saham independen induk Tbk dalam RUPS apabila transaksi tersebut memenuhi kriteria yang disyaratkan.",
    legalRefs: ["POJK 42/POJK.04/2020", "POJK 15/POJK.04/2020"],
    absenceImpact:
      "Tanpa risalah RUPS Independen induk, keabsahan persetujuan pemegang saham independen induk atas transaksi ini tidak dapat dipastikan, meskipun kewajiban tersebut berada pada tingkat induk dan bukan pada target sebagai perusahaan tertutup.",
  },
};

export const gapRationaleFor = (expectedDocId: string): DDGapRationale | undefined =>
  DD_GAP_RATIONALE[expectedDocId];
