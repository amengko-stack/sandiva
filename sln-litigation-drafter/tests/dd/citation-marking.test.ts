import { describe, it, expect } from "vitest";
import { citationIssueNote, renderFindingsTable } from "@/lib/dd/findings-render";
import type { DDFinding } from "@/types/dd";

// A citation to an article that does not exist is the one error class a reader cannot
// catch unaided: "Pasal 93 ayat (1) huruf e" is indistinguishable from a real
// provision unless you open the statute. The check that finds them reported only into
// the operator's run log, which nobody reading the Word file ever sees.

const finding = (over: Partial<DDFinding> = {}): DDFinding =>
  ({
    id: "f1",
    severity: "material",
    status: "open",
    problem: "Direksi diangkat tanpa memenuhi syarat.",
    whyItMatters: "Pengangkatan dapat batal.",
    suggestedFix: "Periksa keabsahan pengangkatan.",
    regulationRefs: ["Pasal 93 ayat (1) huruf e UU 40/2007"],
    subsectionTitle: "Pengurus",
    ...over,
  }) as unknown as DDFinding;

const flat = (blocks: ReturnType<typeof renderFindingsTable>) =>
  blocks
    .map((b) => (b.kind === "table" ? b.rows.map((r) => r.join(" | ")).join("\n") : b.text))
    .join("\n");

describe("citation marking in the findings table", () => {
  it("marks the reference cell of a finding whose citation does not exist", () => {
    const out = flat(renderFindingsTable([finding({ citationIssues: ["Pasal 93 ayat (1) huruf e"] })]));
    expect(out).toContain("[PASAL TIDAK DITEMUKAN]");
    expect(out).toContain("Pasal 93 ayat (1) huruf e");
  });

  it("explains the mark once below the table", () => {
    const out = flat(renderFindingsTable([finding({ citationIssues: ["Pasal 110 ayat (1) huruf e"] })]));
    expect(out).toContain("tidak menemukan rujukan berikut");
    expect(out).toContain("wajib diperiksa dan diperbaiki");
  });

  it("leaves a sound citation untouched", () => {
    const out = flat(renderFindingsTable([finding()]));
    expect(out).not.toContain("[PASAL TIDAK DITEMUKAN]");
    expect(out).not.toContain("tidak menemukan rujukan berikut");
  });

  // Two findings citing the same invented provision should not print it twice.
  it("lists each bad reference once", () => {
    const issues = ["Pasal 93 ayat (1) huruf e"];
    const out = flat(
      renderFindingsTable([
        finding({ id: "a", citationIssues: issues }),
        finding({ id: "b", citationIssues: issues }),
      ])
    );
    const note = out.split("\n").find((l) => l.includes("tidak menemukan rujukan berikut")) ?? "";
    expect(note.match(/Pasal 93 ayat \(1\) huruf e/g)).toHaveLength(1);
  });

  // A dismissed finding is not rendered, so its citation must not be reported either.
  it("ignores dismissed findings", () => {
    const out = flat(
      renderFindingsTable([
        finding({ id: "a" }),
        finding({ id: "b", status: "dismissed", citationIssues: ["Pasal 999"] }),
      ])
    );
    expect(out).not.toContain("Pasal 999");
  });

  it("names every offending reference in the note", () => {
    expect(citationIssueNote(["Pasal 93 ayat (1) huruf e", "Pasal 110 ayat (1) huruf e"])).toContain(
      "Pasal 93 ayat (1) huruf e; Pasal 110 ayat (1) huruf e"
    );
  });
});
