"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";
import type { DDEntity, DDTransaction, DDTransactionType } from "@/types/dd";

const input: React.CSSProperties = { padding: 8, border: "1px solid #d1d5db", borderRadius: 6, width: "100%" };

export default function DDStage1Setup() {
  const { state, dispatch } = useDD();
  const t = state.transaction;
  const [name, setName] = useState(t?.name ?? "");
  const [type, setType] = useState<DDTransactionType>(t?.type ?? "akuisisi_saham");
  const [clientRole, setClientRole] = useState(t?.clientRole ?? "pembeli");
  const [cutoff, setCutoff] = useState(t?.cutoffDateISO ?? new Date().toISOString().slice(0, 10));
  const [entities, setEntities] = useState<DDEntity[]>(t?.entities ?? []);
  const [busy, setBusy] = useState<string | null>(null);

  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "entitas";

  const addEntity = () =>
    setEntities((es) => [...es, { id: `${slug("e" + (es.length + 1))}`, name: "", role: "target", dataRoomPath: "", files: [] }]);

  const patchEntity = (i: number, patch: Partial<DDEntity>) =>
    setEntities((es) => es.map((e, j) => (j === i ? { ...e, ...patch, ...(patch.name ? { id: slug(patch.name) } : {}) } : e)));

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
    const transaction: DDTransaction = {
      id: state.sessionId, name: name.trim(), type, clientRole,
      cutoffDateISO: cutoff, entities, checklistVersion: "",
    };
    dispatch({ type: "SET_TRANSACTION", transaction });
    dispatch({ type: "SET_STAGE", stage: 2 });
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>1 — Transaksi & Entitas</h1>
      <label>Nama matter<input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Proyek Alpha — akuisisi PT Alpha Sentosa" /></label>
      <label>Jenis transaksi
        <select style={input} value={type} onChange={(e) => setType(e.target.value as DDTransactionType)}>
          {DD_TRANSACTION_TYPES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <label>Klien bertindak sebagai<input style={input} value={clientRole} onChange={(e) => setClientRole(e.target.value)} /></label>
      <label>Tanggal uji (cut-off)<input style={input} type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} /></label>

      <h2>Perusahaan target</h2>
      {entities.map((e, i) => (
        <div key={i} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <input style={input} placeholder="Nama PT" value={e.name} onChange={(ev) => patchEntity(i, { name: ev.target.value })} />
          <input style={input} placeholder="Peran (target/penjual/…)" value={e.role} onChange={(ev) => patchEntity(i, { role: ev.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...input, flex: 1 }} placeholder="Folder data room di SharePoint (path atau link)" value={e.dataRoomPath} onChange={(ev) => patchEntity(i, { dataRoomPath: ev.target.value })} />
            <button onClick={() => loadFiles(i)} disabled={busy === e.id}>{busy === e.id ? "Membaca…" : "Baca folder"}</button>
          </div>
          {e.files.length > 0 && <div style={{ fontSize: 13, color: "#059669" }}>{e.files.length} file ditemukan</div>}
        </div>
      ))}
      <button onClick={addEntity}>+ Tambah perusahaan</button>
      <button onClick={next} disabled={!canContinue} style={{ padding: 12, fontWeight: 600 }}>Lanjut ke Ekstraksi →</button>
    </div>
  );
}
