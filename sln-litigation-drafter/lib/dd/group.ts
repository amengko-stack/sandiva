import type { DDClassifiedDoc, DDDocGroup } from "@/types/dd";

const MAX_GROUP_SIZE = 25;

// Strip amendment/addendum prefixes and ordinal noise so "Addendum I Perjanjian
// Kredit BCA" and "Perjanjian Kredit BCA" normalize to the same base label.
export function normalizeAgreementLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b(addendum|adendum|amandemen|amendment|perubahan|lampiran)\b/g, " ")
    .replace(/\b(ke-?\s*\d+|\d+|[ivxlcdm]+)\b/g, " ") // ordinals, bare numbers/years, roman numerals
    .replace(/\batas\b/g, " ")
    .replace(/\bno\.?\s*[\w/.-]*/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function groupAgreements(classified: DDClassifiedDoc[], entityId: string): DDDocGroup[] {
  const agreements = classified.filter((c) => c.aspectId === "perjanjian_penting");
  const byBase = new Map<string, DDClassifiedDoc[]>();
  for (const doc of agreements) {
    const base = normalizeAgreementLabel(doc.docLabel) || normalizeAgreementLabel(doc.fileName);
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(doc);
  }

  const groups: DDDocGroup[] = [];
  let n = 0;
  for (const docs of byBase.values()) {
    // Longest label first = base contract first; chunk if over the cap.
    const sorted = [...docs].sort((a, b) => a.docLabel.length - b.docLabel.length);
    for (let i = 0; i < sorted.length; i += MAX_GROUP_SIZE) {
      const chunk = sorted.slice(i, i + MAX_GROUP_SIZE);
      groups.push({
        groupId: `${entityId}-grp-${n++}`,
        label: chunk[0].docLabel,
        memberFiles: chunk.map((d) => d.fileName),
      });
    }
  }
  return groups;
}
