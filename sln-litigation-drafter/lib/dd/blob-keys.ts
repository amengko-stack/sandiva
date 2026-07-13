// Central layout for every DD Blob key. Entity ids are client-supplied and
// interpolated into keys — validate before use, same discipline as
// isValidSessionId in lib/blob.ts.
export function isValidEntityId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v);
}

const ent = (sid: string, eid: string) => `sessions/${sid}/dd/entities/${eid}`;

export const ddKeys = {
  transaction: (sid: string) => `sessions/${sid}/dd/transaction.json`,
  extracted: (sid: string, eid: string) => `${ent(sid, eid)}/extracted_text.json`,
  report: (sid: string, eid: string) => `${ent(sid, eid)}/report.json`,
  classified: (sid: string, eid: string) => `${ent(sid, eid)}/classified.json`,
  tailored: (sid: string, eid: string) => `${ent(sid, eid)}/tailored.json`,
  gaps: (sid: string, eid: string) => `${ent(sid, eid)}/gaps.json`,
  tables: (sid: string, eid: string) => `${ent(sid, eid)}/tables.json`,
  findings: (sid: string, eid: string) => `${ent(sid, eid)}/findings.json`,
  consolidated: (sid: string) => `sessions/${sid}/dd/consolidated.json`,
};
