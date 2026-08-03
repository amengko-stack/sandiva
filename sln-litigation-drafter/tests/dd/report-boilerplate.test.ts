import { describe, it, expect } from "vitest";
import {
  deriveVerdict,
  openingAssumptions,
  openingBlocks,
  openingQualifications,
  openingScope,
  formatIndonesianDate,
  verdictLabel,
  type DDVerdictInput,
} from "@/lib/dd/report-boilerplate";
import type { DDEntity, DDRegime, DDTransaction } from "@/types/dd";

describe("deriveVerdict", () => {
  it("empty findings -> memenuhi", () => {
    expect(deriveVerdict([])).toBe("memenuhi");
  });

  it("all-dismissed findings (including kritis) -> memenuhi", () => {
    const findings: DDVerdictInput[] = [
      { severity: "kritis", status: "dismissed" },
      { severity: "material", status: "dismissed" },
    ];
    expect(deriveVerdict(findings)).toBe("memenuhi");
  });

  it("any live kritis -> tidak_memenuhi", () => {
    const findings: DDVerdictInput[] = [
      { severity: "kritis", status: "open" },
      { severity: "minor", status: "open" },
    ];
    expect(deriveVerdict(findings)).toBe("tidak_memenuhi");
  });

  it("a dismissed kritis plus a live minor -> memenuhi_dengan_catatan", () => {
    const findings: DDVerdictInput[] = [
      { severity: "kritis", status: "dismissed" },
      { severity: "minor", status: "open" },
    ];
    expect(deriveVerdict(findings)).toBe("memenuhi_dengan_catatan");
  });

  it("live material only -> memenuhi_dengan_catatan", () => {
    const findings: DDVerdictInput[] = [{ severity: "material", status: "open" }];
    expect(deriveVerdict(findings)).toBe("memenuhi_dengan_catatan");
  });
});

describe("verdictLabel", () => {
  it("returns human labels for known verdicts", () => {
    expect(verdictLabel("memenuhi")).toBe("memenuhi ketentuan");
    expect(verdictLabel("tidak_memenuhi")).toBe("tidak memenuhi ketentuan");
  });
});

describe("openingAssumptions", () => {
  it("ringkas has 4 entries marked (i)-(iv)", () => {
    const block = openingAssumptions("ringkas");
    expect(block.body.length).toBe(4);
    expect(block.body[0].startsWith("(i)")).toBe(true);
    expect(block.body[1].startsWith("(ii)")).toBe(true);
    expect(block.body[2].startsWith("(iii)")).toBe(true);
    expect(block.body[3].startsWith("(iv)")).toBe(true);
  });

  it("panjang has 11 entries marked (a)-(k)", () => {
    const block = openingAssumptions("panjang");
    expect(block.body.length).toBe(11);
    expect(block.body[0].startsWith("(a)")).toBe(true);
    expect(block.body[10].startsWith("(k)")).toBe(true);
  });
});

describe("openingBlocks", () => {
  it("returns exactly 5 blocks lettered A-E in order", () => {
    const transaction: DDTransaction = {
      id: "t1",
      name: "Matter",
      type: "akuisisi_saham",
      clientRole: "pembeli",
      cutoffDateISO: "2026-07-22",
      entities: [],
      checklistVersion: "1",
    };
    const entity: DDEntity = {
      id: "e1",
      name: "PT Contoh",
      role: "target",
      dataRoomPath: "/x",
      files: [],
    };
    const regime: DDRegime = { layers: ["uupt"], capitalMarkets: false, parentTbkName: null };
    const meta = {
      matterRef: "REF-1",
      clientName: "Klien",
      addressee: "Pihak",
      relianceScope: "Klien",
      clientRelease: true,
      ddStartDateISO: "2026-06-01",
      taxInScope: true,
      assumptionsVariant: "ringkas" as const,
      signatoryName: "Nama",
      signatoryTitle: "Partner",
    };
    const blocks = openingBlocks({ transaction, entity, regime, meta });
    expect(blocks.length).toBe(5);
    expect(blocks.map((b) => b.letter)).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("openingQualifications", () => {
  it("states the financial/technical/commercial-fairness exclusion and the formal-vs-material assumption", () => {
    const block = openingQualifications();
    const full = block.body.join(" ");
    expect(full).toContain("kebenaran data keuangan, teknis, atau komersial");
    expect(full).toContain("kewajaran (fairness) komersial");
    expect(full).toContain("aspek yuridis formal dan aspek yuridis material");
  });
});

describe("formatIndonesianDate", () => {
  it("formats a valid ISO date", () => {
    expect(formatIndonesianDate("2026-07-22")).toBe("22 Juli 2026");
  });

  it("returns malformed input unchanged without throwing", () => {
    expect(() => formatIndonesianDate("not-a-date")).not.toThrow();
    expect(formatIndonesianDate("not-a-date")).toBe("not-a-date");
  });
});

describe("missing reportMeta", () => {
  it("yields visible placeholder markers, not empty strings", () => {
    const transaction: DDTransaction = {
      id: "t1",
      name: "Matter",
      type: "akuisisi_saham",
      clientRole: "pembeli",
      cutoffDateISO: "2026-07-22",
      entities: [],
      checklistVersion: "1",
    };
    const entity: DDEntity = {
      id: "e1",
      name: "PT Contoh",
      role: "target",
      dataRoomPath: "/x",
      files: [],
    };
    const block = openingScope({ transaction, entity }); // meta omitted entirely
    const full = block.body.join(" ");
    expect(full).toContain("[NAMA KLIEN]");
    expect(full).toContain("[NOMOR REFERENSI]");
    expect(full).not.toBe("");
  });
});
