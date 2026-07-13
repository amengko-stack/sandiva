import { describe, it, expect } from "vitest";
import { groupAgreements, normalizeAgreementLabel } from "@/lib/dd/group";
import type { DDClassifiedDoc } from "@/types/dd";

const doc = (fileName: string, docLabel: string, aspectId: DDClassifiedDoc["aspectId"] = "perjanjian_penting"): DDClassifiedDoc => ({
  fileName, entityId: "e1", aspectId, expectedDocId: null, docLabel,
  docDate: null, parties: [], summary: "", confidence: "tinggi", reasoning: "",
});

describe("normalizeAgreementLabel", () => {
  it("strips amendment markers and numbering", () => {
    expect(normalizeAgreementLabel("Addendum I Perjanjian Kredit BCA"))
      .toBe(normalizeAgreementLabel("Perjanjian Kredit BCA"));
    expect(normalizeAgreementLabel("Amandemen ke-2 atas Perjanjian Sewa Gudang"))
      .toBe(normalizeAgreementLabel("Perjanjian Sewa Gudang"));
    expect(normalizeAgreementLabel("Perubahan Perjanjian Distribusi 2024"))
      .toBe(normalizeAgreementLabel("Perjanjian Distribusi 2024"));
  });
});

describe("groupAgreements", () => {
  it("groups a contract with its addenda into one group", () => {
    const groups = groupAgreements([
      doc("pk-bca.pdf", "Perjanjian Kredit BCA"),
      doc("addendum-1.pdf", "Addendum I Perjanjian Kredit BCA"),
      doc("addendum-2.pdf", "Addendum II Perjanjian Kredit BCA"),
      doc("sewa.pdf", "Perjanjian Sewa Gudang"),
    ], "e1");
    expect(groups).toHaveLength(2);
    const kredit = groups.find((g) => g.memberFiles.includes("pk-bca.pdf"))!;
    expect(kredit.memberFiles).toHaveLength(3);
    expect(kredit.groupId).toMatch(/^e1-grp-\d+$/);
  });

  it("ignores non-agreement aspects", () => {
    const groups = groupAgreements([doc("nib.pdf", "NIB", "perizinan")], "e1");
    expect(groups).toHaveLength(0);
  });

  it("caps a group at 25 files", () => {
    const docs = Array.from({ length: 30 }, (_, i) => doc(`a${i}.pdf`, `Addendum ${i} Perjanjian Kredit BCA`));
    docs.push(doc("base.pdf", "Perjanjian Kredit BCA"));
    const groups = groupAgreements(docs, "e1");
    const total = groups.reduce((n, g) => n + g.memberFiles.length, 0);
    expect(total).toBe(31);
    for (const g of groups) expect(g.memberFiles.length).toBeLessThanOrEqual(25);
  });
});
