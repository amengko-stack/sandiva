import type { DDFinding } from "@/types/dd";

export type ReviewSaveStatus = "idle" | "pending" | "saved" | "failed" | "conflict";
export interface ReviewDraft {
  findings: DDFinding[]; revision: string | null; status: ReviewSaveStatus;
  dirty: boolean; loading: boolean; analyzing: boolean; message?: string;
}
interface Entry extends ReviewDraft {
  version: number; load: number; timer?: ReturnType<typeof setTimeout>; saving?: Promise<void>;
}
type Snapshot = { findings: DDFinding[]; revision: string | null };
const reviewsOf = (findings: DDFinding[]) => findings.map(({ id, status, editedProblem }) => ({ id, status, editedProblem }));
const revisionValid = (v: unknown) => typeof v === "string" && /^"[\x21\x23-\x7e]{1,256}"$/.test(v);

function snapshot(value: unknown, eid: string): Snapshot {
  if (!value || typeof value !== "object") throw new Error("Hasil temuan tidak valid");
  const v = value as Snapshot;
  if ((v.revision !== null && !revisionValid(v.revision)) || !Array.isArray(v.findings) ||
      (v.revision === null && v.findings.length !== 0) ||
      new Set(v.findings.map(f => f?.id)).size !== v.findings.length ||
      v.findings.some(f => !f || typeof f.id !== "string" || !f.id || f.entityId !== eid ||
        !["open", "accepted", "dismissed", "edited"].includes(f.status) ||
        (f.editedProblem !== undefined && typeof f.editedProblem !== "string"))) throw new Error("Hasil temuan tidak valid");
  return v;
}

/** The actual caller's per-session queue. No browser persistence or stale rebase. */
export class FindingsSaveQueue {
  private entries = new Map<string, Entry>();
  private active = true;
  private epoch = 0;
  constructor(readonly sessionId: string, private changed: (eid: string, draft: ReviewDraft) => void,
    private request: typeof fetch = fetch) {}
  private entry(eid: string): Entry {
    let e = this.entries.get(eid);
    if (!e) { e = { findings: [], revision: null, status: "idle", dirty: false, loading: false, analyzing: false, version: 0, load: 0 }; this.entries.set(eid, e); }
    return e;
  }
  private notify(eid: string, e: Entry) { if (this.active) this.changed(eid, { ...e }); }
  get(eid: string): ReviewDraft { return { ...this.entry(eid) }; }
  blocked(eid?: string): boolean {
    const blocked = (e: Entry) => e.dirty || !!e.saving || e.analyzing || e.loading;
    return eid ? blocked(this.entry(eid)) : Array.from(this.entries.values()).some(blocked);
  }
  async load(eid: string, discard = false): Promise<void> {
    const e = this.entry(eid);
    if (!this.active || e.saving || e.analyzing || (e.dirty && !discard)) return;
    clearTimeout(e.timer);
    const token = ++e.load, version = e.version;
    e.loading = true; this.notify(eid, e);
    try {
      const r = await this.request(`/api/dd/findings?sessionId=${encodeURIComponent(this.sessionId)}&entityId=${encodeURIComponent(eid)}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Temuan tersimpan belum dapat dimuat. Draft lokal dipertahankan.");
      const loaded = snapshot(await r.json(), eid);
      if (!this.active || token !== e.load || version !== e.version) return;
      Object.assign(e, loaded, { dirty: false, status: loaded.revision === null ? "idle" : "saved", message: undefined });
    } catch (err) {
      if (this.active && token === e.load && version === e.version) {
        e.status = "failed"; e.message = err instanceof Error ? err.message : "Gagal memuat temuan";
      }
    } finally {
      if (this.active && token === e.load) { e.loading = false; this.notify(eid, e); }
    }
  }
  edit(eid: string, id: string, patch: Pick<Partial<DDFinding>, "status" | "editedProblem">) {
    const e = this.entry(eid);
    if (!this.active || e.loading || e.analyzing || !e.revision || !e.findings.some(f => f.id === id)) return;
    e.findings = e.findings.map(f => f.id === id ? { ...f, ...patch } : f);
    e.version++; e.dirty = true;
    clearTimeout(e.timer);
    if (e.status !== "conflict" && e.status !== "failed") {
      e.status = "pending";
      e.timer = setTimeout(() => { void this.save(eid); }, 800);
    }
    this.notify(eid, e);
  }
  save(eid: string): Promise<void> {
    const e = this.entry(eid);
    const epoch = this.epoch;
    clearTimeout(e.timer);
    if (e.saving) return e.saving;
    if (!this.active || !e.dirty || e.status === "conflict" || e.loading || e.analyzing || !e.revision) return Promise.resolve();
    // Start in a microtask so the lock is installed before even a mocked fetch resolves.
    e.saving = Promise.resolve().then(async () => {
      while (this.active && epoch === this.epoch && e.dirty && e.status !== "conflict") {
        const version = e.version, reviews = reviewsOf(e.findings);
        e.status = "pending"; this.notify(eid, e);
        try {
          const r = await this.request("/api/dd/findings", { method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: this.sessionId, entityId: eid, revision: e.revision, reviews }) });
          if (!this.active || epoch !== this.epoch) return;
          if (!r.ok) {
            e.status = r.status === 409 ? "conflict" : "failed";
            e.message = r.status === 409 ? "Temuan berubah di proses lain. Draft lokal belum tersimpan; buang draft dan muat ulang untuk melanjutkan."
              : "Penyimpanan belum dapat dipastikan. Draft lokal dipertahankan; coba simpan atau muat ulang.";
            break;
          }
          const ack = snapshot(await r.json(), eid);
          if (!this.active || epoch !== this.epoch) return;
          if (!ack.revision || JSON.stringify(reviewsOf(ack.findings)) !== JSON.stringify(reviews)) throw new Error("Acknowledgement mismatch");
          e.revision = ack.revision;
          if (version === e.version) { e.findings = ack.findings; e.dirty = false; e.status = "saved"; e.message = undefined; }
          // Otherwise the next iteration saves the newer draft with this ACK's ETag.
        } catch {
          if (!this.active || epoch !== this.epoch) return;
          e.status = "failed"; e.message = "Penyimpanan belum dapat dipastikan. Draft lokal dipertahankan.";
          break;
        }
      }
    }).finally(() => { e.saving = undefined; if (epoch === this.epoch) this.notify(eid, e); });
    return e.saving;
  }
  beginAnalysis(eid: string): boolean {
    const e = this.entry(eid);
    if (!this.active || this.blocked() || e.status === "conflict" || e.status === "failed") return false;
    clearTimeout(e.timer); e.load++; e.analyzing = true; this.notify(eid, e); return true;
  }
  completeAnalysis(eid: string, value: unknown) {
    const e = this.entry(eid);
    if (!this.active || !e.analyzing || e.dirty || e.saving) throw new Error("Review lokal harus diselesaikan dahulu");
    const loaded = snapshot(value, eid);
    if (!loaded.revision) throw new Error("Analisis belum memiliki versi tersimpan");
    Object.assign(e, loaded, { status: "saved", message: undefined }); this.notify(eid, e);
  }
  endAnalysis(eid: string) { const e = this.entry(eid); e.analyzing = false; this.notify(eid, e); }
  failAnalysis(eid: string) {
    const e = this.entry(eid);
    if (!this.active) return;
    e.status = "failed";
    e.message = "Analisis belum selesai. Temuan tersimpan mungkin telah berubah; muat ulang sebelum melanjutkan. Tampilan lokal dipertahankan.";
    this.notify(eid, e);
  }
  /** React development StrictMode may replay the mount effect on the same queue. */
  activate() { if (!this.active) { this.entries.clear(); this.active = true; } }
  isActive() { return this.active; }
  dispose() { this.active = false; this.epoch++; for (const e of Array.from(this.entries.values())) { clearTimeout(e.timer); e.load++; } }
}
