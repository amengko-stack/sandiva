"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";
import type {
  DDEntity,
  DDReportFormat,
  DDReportMeta,
  DDReportOptions,
  DDTransaction,
  DDTransactionType,
} from "@/types/dd";
import { DD_DEFAULT_REPORT_OPTIONS } from "@/types/dd";
import { slugifyEntityName, uniqueEntityIds } from "@/lib/dd/entity-ids";
import { resolveRegime, regimeLayerLabel } from "@/lib/dd/regime";

const input: React.CSSProperties = { padding: 8, border: "1px solid var(--border-color)", borderRadius: 6, width: "100%", background: "var(--bg-surface)", color: "var(--text-primary)" };
const helpText: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 2 };
const fieldset: React.CSSProperties = { border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 10 };

const DEFAULT_REPORT_FORMAT: DDReportFormat = "pendahuluan_led";

const REPORT_FORMATS: { id: DDReportFormat; label: string; help: string }[] = [
  {
    id: "pendahuluan_led",
    label: "Pendahuluan → Profil → Analisis per aspek",
    help: "Pendahuluan, Profil Perseroan, lalu bab analisis per aspek. Bentuk laporan uji tuntas komprehensif.",
  },
  {
    id: "exec_summary_led",
    label: "Ringkasan Eksekutif → per kategori dokumen",
    help: "Dibuka Ringkasan Eksekutif, bab disusun per kategori dokumen dengan uraian dan analisis menyatu.",
  },
  {
    id: "lut_pasar_modal",
    label: "LUT Pasar Modal (HKHSK Annex VII / POJK 7/2017)",
    help: "Laporan Uji Tuntas pasar modal: sebelas area pemeriksaan wajib. Untuk target Perusahaan Terbuka yang laporannya menjadi bagian prospektus.",
  },
  {
    id: "findings_only",
    label: "Hanya temuan & rekomendasi",
    help: "Hanya temuan dan rekomendasi, tanpa bab profil. Untuk tinjauan cepat.",
  },
];

const warningBox: React.CSSProperties = {
  border: "1px solid var(--error)",
  borderRadius: 8,
  padding: 10,
  background: "var(--bg-critique)",
  color: "var(--text-primary)",
  fontSize: 13,
};

const DEFAULT_REPORT_META: DDReportMeta = {
  matterRef: "",
  clientName: "",
  addressee: "",
  relianceScope: "",
  clientRelease: false,
  ddStartDateISO: "",
  taxInScope: false,
  assumptionsVariant: "ringkas",
  // Interim until the lawyer says otherwise. A DD that has just been set up is by
  // definition unfinished, and the unsafe direction is claiming completeness.
  reportStage: "interim",
  signatoryName: "",
  signatoryTitle: "",
};

export default function DDStage1Setup() {
  const { state, dispatch } = useDD();
  const t = state.transaction;
  const [name, setName] = useState(t?.name ?? "");
  const [type, setType] = useState<DDTransactionType>(t?.type ?? "akuisisi_saham");
  const [clientRole, setClientRole] = useState(t?.clientRole ?? "pembeli");
  const [cutoff, setCutoff] = useState(t?.cutoffDateISO ?? new Date().toISOString().slice(0, 10));
  const [entities, setEntities] = useState<DDEntity[]>(t?.entities ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [reportMeta, setReportMeta] = useState<DDReportMeta>(t?.reportMeta ?? DEFAULT_REPORT_META);
  const [showReportMeta, setShowReportMeta] = useState(false);
  const [reportFormat, setReportFormat] = useState<DDReportFormat>(t?.reportFormat ?? DEFAULT_REPORT_FORMAT);
  const [reportOptions, setReportOptions] = useState<DDReportOptions>(t?.reportOptions ?? DD_DEFAULT_REPORT_OPTIONS);
  const [showReportOptions, setShowReportOptions] = useState(false);

  const patchReportMeta = (patch: Partial<DDReportMeta>) =>
    setReportMeta((rm) => ({ ...rm, ...patch }));

  const patchReportOptions = (patch: Partial<DDReportOptions>) =>
    setReportOptions((ro) => ({ ...ro, ...patch }));

  const anyEntityTbk = entities.some((e) => e.listingStatus === "tbk");
  const showTbkFormatWarning = anyEntityTbk && reportFormat !== "lut_pasar_modal";

  const addEntity = () =>
    setEntities((es) => [...es, { id: `e${es.length + 1}`, name: "", role: "target", dataRoomPath: "", files: [] }]);

  const patchEntity = (i: number, patch: Partial<DDEntity>) =>
    setEntities((es) => es.map((e, j) => (j === i ? { ...e, ...patch, ...(patch.name ? { id: slugifyEntityName(patch.name) } : {}) } : e)));

  const loadFiles = async (i: number) => {
    const e = entities[i];
    if (!e.dataRoomPath.trim()) return;
    setBusy(e.id);
    try {
      const res = await fetch("/api/sharepoint/list-files", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: e.dataRoomPath.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Gagal membaca folder");
      patchEntity(i, { files: data.files });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      setBusy(null);
    }
  };

  const canContinue = name.trim() && entities.length > 0 && entities.every((e) => e.name.trim() && e.files.length > 0);

  const next = () => {
    const ids = uniqueEntityIds(entities.map((e) => e.name));
    const uniqueEntities = entities.map((e, i) => ({ ...e, id: ids[i] }));
    const transaction: DDTransaction = {
      id: state.sessionId, name: name.trim(), type, clientRole,
      cutoffDateISO: cutoff, entities: uniqueEntities, checklistVersion: "",
      reportMeta,
      ...(reportFormat !== DEFAULT_REPORT_FORMAT ? { reportFormat } : {}),
      ...(JSON.stringify(reportOptions) !== JSON.stringify(DD_DEFAULT_REPORT_OPTIONS) ? { reportOptions } : {}),
    };
    dispatch({ type: "SET_TRANSACTION", transaction });
    dispatch({ type: "SET_STAGE", stage: 2 });
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>1 — Transaksi & Entitas</h1>
      <label>Nama matter<input style={input} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Proyek Alpha — akuisisi PT Alpha Sentosa" /></label>
      <label>Jenis transaksi
        <select style={input} value={type} onChange={(e) => setType(e.target.value as DDTransactionType)}>
          {DD_TRANSACTION_TYPES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      {/*
        A select, not free text. This value switches five chapters: planChapters
        matches it against /penjual|seller/i to emit the sell-side chapters instead
        of the buy-side one. Typed freely, "divestor" or "vendor" would silently
        produce a buy-side report for a seller — a wrong report with nothing on
        screen to show why.
      */}
      <label htmlFor="clientRole">Klien bertindak sebagai
        <select style={input} id="clientRole" value={clientRole} onChange={(e) => setClientRole(e.target.value)}>
          <option value="pembeli">Pembeli / pengambil alih</option>
          <option value="penjual">Penjual / pihak yang mendivestasi</option>
        </select>
      </label>

      {/*
        Out of the "optional metadata" panel deliberately. The stage decides what
        the report claims about itself — cover, qualifications, reliance — and gates
        the client export. Left inside a collapsed panel marked "opsional", a
        finished matter would go out stamped INTERIM with nothing in Stage 1 to say
        so, and no visible way to change it.
      */}
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Tahap laporan</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="radio"
              name="reportStage"
              id="reportStage-interim"
              checked={reportMeta.reportStage === "interim"}
              onChange={() => patchReportMeta({ reportStage: "interim" })}
            />
            Interim — penyerahan dokumen belum selesai
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="radio"
              name="reportStage"
              id="reportStage-final"
              checked={reportMeta.reportStage === "final"}
              onChange={() => patchReportMeta({ reportStage: "final" })}
            />
            Final — dokumen sudah lengkap
          </label>
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
          {reportMeta.reportStage === "interim"
            ? "Judul, sampul, dan pembatasan akan menyatakan laporan ini interim, dan Bab 1.4 akan menyebutkan dokumen yang belum tersedia."
            : "Ekspor final ke klien akan ditolak bila masih ada dokumen yang diminta namun belum tersedia atau belum lengkap."}
        </div>
      </div>
      <label>Tanggal uji (cut-off)<input style={input} type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} /></label>

      <h2>Perusahaan target</h2>
      {entities.map((e, i) => (
        <div key={i} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <input style={input} type="text" placeholder="Nama PT" value={e.name} onChange={(ev) => patchEntity(i, { name: ev.target.value })} />
          <input style={input} type="text" placeholder="Peran (target/penjual/…)" value={e.role} onChange={(ev) => patchEntity(i, { role: ev.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...input, flex: 1 }} type="text" placeholder="Folder data room di SharePoint (path atau link)" value={e.dataRoomPath} onChange={(ev) => patchEntity(i, { dataRoomPath: ev.target.value })} />
            <button onClick={() => loadFiles(i)} disabled={busy === e.id}>{busy === e.id ? "Membaca…" : "Baca folder"}</button>
          </div>
          {e.files.length > 0 && <div style={{ fontSize: 13, color: "var(--success)" }}>{e.files.length} file ditemukan</div>}

          <div style={fieldset}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Status pasar modal</div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name={`listingStatus-${i}`}
                  id={`listingStatus-nontbk-${i}`}
                  checked={(e.listingStatus ?? "non_tbk") === "non_tbk"}
                  onChange={() => patchEntity(i, { listingStatus: "non_tbk" })}
                />
                Perseroan Terbatas Tertutup (non-Tbk)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name={`listingStatus-${i}`}
                  id={`listingStatus-tbk-${i}`}
                  checked={e.listingStatus === "tbk"}
                  onChange={() => patchEntity(i, { listingStatus: "tbk" })}
                />
                Perusahaan Terbuka (Tbk)
              </label>
            </div>

            {(e.listingStatus ?? "non_tbk") === "non_tbk" && (
              <div>
                <label htmlFor={`parentTbk-${i}`}>Induk utama berstatus Tbk (bila ada)</label>
                <input
                  style={input}
                  id={`parentTbk-${i}`}
                  type="text"
                  placeholder="Nama PT Tbk induk, kosongkan bila tidak ada"
                  value={e.ultimateParentTbk ?? ""}
                  onChange={(ev) => patchEntity(i, { ultimateParentTbk: ev.target.value })}
                />
                <div style={helpText}>
                  Perusahaan tertutup ini tidak terikat langsung oleh POJK. Namun POJK 17/2020 mencakup
                  transaksi oleh "Perusahaan Terbuka atau perusahaan terkendali", diukur terhadap angka
                  keuangan induk — sehingga induk yang berstatus Tbk dapat memikul kewajiban keterbukaan,
                  penilai independen, atau RUPS akibat transaksi ini. Kosongkan bila tidak ada perusahaan
                  Tbk dalam rantai kepemilikan.
                </div>
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                id={`isBumn-${i}`}
                checked={e.isBumn ?? false}
                onChange={(ev) => patchEntity(i, { isBumn: ev.target.checked })}
              />
              Bagian dari grup BUMN
            </label>

            <div style={helpText}>
              Rezim yang berlaku: {resolveRegime(e).layers.map((l) => regimeLayerLabel(l)).join(" · ")}
            </div>
          </div>
        </div>
      ))}
      <button onClick={addEntity}>+ Tambah perusahaan</button>

      <div style={fieldset}>
        <button type="button" onClick={() => setShowReportMeta((v) => !v)} style={{ textAlign: "left", fontWeight: 600 }}>
          {showReportMeta ? "▾" : "▸"} Metadata laporan (opsional — untuk sampul & bagian A–E)
        </button>
        <div style={helpText}>
          Data ini tidak dapat disimpulkan dari data room; mengisinya melengkapi sampul dan bagian
          pembuka laporan. Lingkup keberlakuan (reliance scope) menentukan siapa yang boleh mengandalkan
          laporan. Membiarkan "rilis kepada klien" tidak dicentang menandai keluaran sebagai draf.
        </div>

        {showReportMeta && (
          <div style={{ display: "grid", gap: 10 }}>
            <label htmlFor="matterRef">Nomor referensi matter
              <input style={input} id="matterRef" type="text" value={reportMeta.matterRef} onChange={(ev) => patchReportMeta({ matterRef: ev.target.value })} />
            </label>
            <label htmlFor="clientName">Nama klien (pemberi instruksi)
              <input style={input} id="clientName" type="text" value={reportMeta.clientName} onChange={(ev) => patchReportMeta({ clientName: ev.target.value })} />
            </label>
            <label htmlFor="addressee">Ditujukan kepada
              <input style={input} id="addressee" type="text" value={reportMeta.addressee} onChange={(ev) => patchReportMeta({ addressee: ev.target.value })} />
            </label>
            <div>
              <label htmlFor="relianceScope">Lingkup keberlakuan (reliance scope)
                <input style={input} id="relianceScope" type="text" value={reportMeta.relianceScope} onChange={(ev) => patchReportMeta({ relianceScope: ev.target.value })} />
              </label>
              <div style={helpText}>Menentukan pihak mana yang boleh mengandalkan laporan ini.</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" id="clientRelease" checked={reportMeta.clientRelease} onChange={(ev) => patchReportMeta({ clientRelease: ev.target.checked })} />
              Rilis kepada klien (bila tidak dicentang, keluaran ditandai sebagai draf)
            </label>
            <label htmlFor="ddStartDateISO">Tanggal mulai pemeriksaan
              <input style={input} id="ddStartDateISO" type="date" value={reportMeta.ddStartDateISO} onChange={(ev) => patchReportMeta({ ddStartDateISO: ev.target.value })} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" id="taxInScope" checked={reportMeta.taxInScope} onChange={(ev) => patchReportMeta({ taxInScope: ev.target.checked })} />
              Aspek perpajakan termasuk dalam lingkup
            </label>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Bentuk asumsi & pembatasan</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="radio"
                    name="assumptionsVariant"
                    id="assumptionsVariant-ringkas"
                    checked={reportMeta.assumptionsVariant === "ringkas"}
                    onChange={() => patchReportMeta({ assumptionsVariant: "ringkas" })}
                  />
                  Ringkas (i)–(iv)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="radio"
                    name="assumptionsVariant"
                    id="assumptionsVariant-panjang"
                    checked={reportMeta.assumptionsVariant === "panjang"}
                    onChange={() => patchReportMeta({ assumptionsVariant: "panjang" })}
                  />
                  Panjang, 11 butir
                </label>
              </div>
            </div>
            <label htmlFor="signatoryName">Nama penandatangan
              <input style={input} id="signatoryName" type="text" value={reportMeta.signatoryName} onChange={(ev) => patchReportMeta({ signatoryName: ev.target.value })} />
            </label>
            <label htmlFor="signatoryTitle">Jabatan penandatangan
              <input style={input} id="signatoryTitle" type="text" value={reportMeta.signatoryTitle} onChange={(ev) => patchReportMeta({ signatoryTitle: ev.target.value })} />
            </label>
          </div>
        )}
      </div>

      <div style={fieldset}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Format laporan</div>
        <div style={{ display: "grid", gap: 8 }}>
          {REPORT_FORMATS.map((f) => (
            <div key={f.id}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                <input
                  type="radio"
                  name="reportFormat"
                  id={`reportFormat-${f.id}`}
                  checked={reportFormat === f.id}
                  onChange={() => setReportFormat(f.id)}
                />
                <span>{f.label}</span>
              </label>
              <div style={{ ...helpText, marginLeft: 22 }}>{f.help}</div>
            </div>
          ))}
        </div>

        {showTbkFormatWarning && (
          <div style={warningBox}>
            Setidaknya satu perusahaan berstatus Perusahaan Terbuka (Tbk). Standar profesi (HKHSK Annex
            VII / POJK 7/2017) mensyaratkan format LUT Pasar Modal bagi laporan uji tuntas atas Perusahaan
            Terbuka yang menjadi bagian prospektus. Bila laporan ini akan digunakan untuk prospektus,
            pilih format tersebut secara sengaja; bila ini merupakan tinjauan internal, format lain tetap
            dapat dipilih.
          </div>
        )}
      </div>

      <div style={fieldset}>
        <button type="button" onClick={() => setShowReportOptions((v) => !v)} style={{ textAlign: "left", fontWeight: 600 }}>
          {showReportOptions ? "▾" : "▸"} Opsi presentasi laporan
        </button>

        {showReportOptions && (
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  id="bilingualHeadings"
                  checked={reportOptions.bilingualHeadings}
                  onChange={(ev) => patchReportOptions({ bilingualHeadings: ev.target.checked })}
                />
                Judul bab bilingual, mis. IZIN-IZIN USAHA (LICENSES AND PERMITS)
              </label>
              <div style={helpText}>Hanya berlaku pada format Ringkasan Eksekutif, yang judul babnya memuat padanan bahasa Inggris.</div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                id="includeTimPemeriksa"
                checked={reportOptions.includeTimPemeriksa}
                onChange={(ev) => patchReportOptions({ includeTimPemeriksa: ev.target.checked })}
              />
              Tambahkan sub-bagian Tim Pemeriksa pada Pendahuluan
            </label>

            <div>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  id="transactionImplications"
                  checked={reportOptions.transactionImplications}
                  onChange={(ev) => patchReportOptions({ transactionImplications: ev.target.checked })}
                />
                Tambahkan sub-bagian Implikasi Transaksi pada setiap bab kategori
              </label>
              <div style={helpText}>Berlaku pada format Ringkasan Eksekutif.</div>
            </div>
          </div>
        )}
      </div>

      <button onClick={next} disabled={!canContinue} style={{ padding: 12, fontWeight: 600 }}>Lanjut ke Ekstraksi →</button>
    </div>
  );
}
