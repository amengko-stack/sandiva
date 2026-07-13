import { describe, expect, it } from "vitest";
import {
  excelSerialToISO,
  fixMojibake,
  parseClients,
  parseMatters,
  parseMoney,
  parseTimesheetRows,
  stripCode,
} from "./prohukum";

// Fixtures replicate the REAL export quirks (HTML-as-.xls, ragged rows,
// leading apostrophes, mojibake, <br> line breaks) with synthetic data.

const CLIENTS_HTML = `﻿<table border=1>
<tr><td>CLIENT</td></tr>
<tr><td>No.</td><td>Client Code</td><td>Join Date</td><td>Client Name</td><td>Npwp</td><td>Industry Type</td><td>Country</td><td>Province</td><td>City</td><td>Address</td><td>Postal Code</td><td>Contact Person</td><td>Email</td></tr>
<tr><td>1</td><td>'90180</td><td>18/06/2026</td><td>Mrs. Test GÃ¶bel</td><td>---</td><td>---</td><td>---</td><td>---</td><td>---</td><td>Jl. Test No. 1,<br>Jakarta</td><td>---</td><td>-</td><td>---</td></tr>
<tr><td>2</td><td>'90179</td><td>15/06/2026</td><td>PT Contoh Sejahtera</td><td>01.234</td><td>---</td><td>---</td><td>---</td><td>---</td><td>---</td><td>---</td><td>Budi</td><td>budi@contoh.co.id</td></tr>
<tr><td>3</td><td>'90178</td><td>03/06/2026</td><td></td><td>---</td></tr>
</table>`;

// Partner columns run Handling → Originating → Responsible → Associate; the
// engagement partner must come from RESPONSIBLE, not Handling.
const MATTERS_HTML = `﻿<table border=1>
<tr><td>MATTER</td></tr>
<tr><td>No</td><td>Matter</td><td>Task</td><td>Active Date</td><td>Practice Area</td><td>Client</td><td>Company</td><td>Disbursements Estimate</td><td>Fees Estimate</td><td>Marketing Fee</td><td>Billing Type</td><td>Currency</td><td>Use Fixed Conversion Rate</td><td>Handling Partner</td><td>Originating Partner</td><td>Responsible Partner</td><td>Associate</td></tr>
<tr><td>1</td><td>'90180-01</td><td>Divorce Assistance</td><td>18/06/2026</td><td>FAMILY LAW</td><td>Mrs. Test GÃ¶bel</td><td>-</td><td>0.00</td><td>75,000,000.00</td><td>0.00</td><td>Lump Sum</td><td>IDR</td><td>No</td><td>AHM</td><td>DPM</td><td>FAS</td><td>JNP,AWS</td></tr>
<tr><td>2</td><td>'90179-02</td><td>Legal Opinion</td><td>16/06/2026</td><td>GENERAL CORPORATE</td><td>PT Contoh Sejahtera</td><td>-</td><td>0.00</td><td>4,000.00</td><td>0.00</td><td>Hourly</td><td>USD</td><td>RJP</td><td>MNI</td><td>ELW</td></tr>
<tr><td>3</td><td>'7005-06 AHM</td><td>Marketing AHM</td><td>01/01/2026</td><td></td><td>SANDIVA GROUP</td><td>-</td><td>Lump Sum</td><td>IDR</td><td>AHM</td></tr>
<tr><td>4</td><td>garbage</td><td>No code here</td></tr>
</table>`;

describe("helpers", () => {
  it("strips leading apostrophes from codes", () => {
    expect(stripCode("'50180-01")).toBe("50180-01");
  });
  it("repairs mojibake", () => {
    expect(fixMojibake("GÃ¶bel")).toBe("Göbel");
    expect(fixMojibake("plain ascii")).toBe("plain ascii");
  });
  it("parses money and rejects non-money", () => {
    expect(parseMoney("75,000,000.00")).toBe(75000000);
    expect(parseMoney("4,000.00")).toBe(4000);
    expect(parseMoney("hello")).toBeNull();
    expect(parseMoney("18/06/2026")).toBeNull();
  });
  it("converts Excel serials (matches the real export: 46188 -> 2026-06-15ish)", () => {
    expect(excelSerialToISO(45658)).toBe("2025-01-01");
    expect(excelSerialToISO(46188.61787037037)).toBe("2026-06-15");
  });
});

describe("parseClients", () => {
  it("parses codes, repairs mojibake, joins <br> cells, reports bad rows", () => {
    const { rows, errors } = parseClients(CLIENTS_HTML);
    expect(rows).toHaveLength(2);
    expect(rows[0].clientCode).toBe("90180");
    expect(rows[0].name).toBe("Mrs. Test Göbel");
    expect(rows[0].billingAddress).toBe("Jl. Test No. 1, Jakarta");
    expect(rows[0].npwp).toBeNull(); // "---" is empty-ish
    expect(rows[1].email).toBe("budi@contoh.co.id");
    expect(errors).toHaveLength(1); // row 3 missing name
  });
});

describe("parseMatters", () => {
  it("extracts code/title/fee/currency/partner from ragged rows", () => {
    const { rows, errors } = parseMatters(MATTERS_HTML);
    expect(rows).toHaveLength(3);

    const [a, b, c] = rows;
    expect(a.matterCode).toBe("90180-01");
    expect(a.clientCode).toBe("90180");
    expect(a.feeType).toBe("lump_sum");
    expect(a.currency).toBe("IDR");
    expect(a.feeAmount).toBe(75000000); // second money cell = Fees Estimate
    // Engagement partner = Responsible (FAS), NOT Handling (AHM), by header column.
    expect(a.responsibleInitials).toBe("FAS");
    expect(a.teamInitials).toEqual(expect.arrayContaining(["AHM", "DPM", "FAS", "AWS", "JNP"]));

    // Ragged row (no cell at the header's Responsible index) → fall back to the
    // 3rd ordered initials group (Handling RJP, Originating MNI, Responsible ELW).
    expect(b.feeType).toBe("hourly");
    expect(b.currency).toBe("USD");
    expect(b.responsibleInitials).toBe("ELW");

    // internal matter: code with suffix token, SANDIVA GROUP -> internal;
    // single partner → falls back to the only initials group.
    expect(c.matterCode).toBe("7005-06");
    expect(c.feeType).toBe("internal");
    expect(c.responsibleInitials).toBe("AHM");

    expect(errors).toHaveLength(1); // "garbage" row
  });
});

describe("parseTimesheetRows", () => {
  const matrix: (string | number | null)[][] = [
    ["TIMESHEET ACTIVITY REPORT"],
    ["Generate Date", null, ":", "08/07/2026"],
    ["No", "Transaction ID", "Input", "Modify", "Timesheet Date", "Fee Earners", "Client", "Matter", "Task Name", "Workcode", "Description", "Actual Length", "Hour", "Unit", "Rate USD", "Amount (USD)"],
    [1, 14935, "16/06/2026", "16/06/2026", 46188.61787037037, "Test Lawyer", "PT Contoh", "'90179-02", "Legal Opinion", "Meeting", "Attend strategic\ndiscussion", 0.0833, 0.0833, 2, 267.80931976, 535.61863952],
    [2, 14934, "x", "x", 46188.61787037037, "Test Lawyer", "PT Contoh", "90179-02", "Legal Opinion", "Review", "Quick check", 0.01, 0.01, 0.25, 267.80931976, 66.95232994],
    [3, 14933, "x", "x", 46188.61787037037, "", "PT Contoh", "90179-02", "t", "Review", "no earner", 0.1, 0.1, 1, 100, 100],
    ["Total", null, null, null, null, null, null, null, null, null, null, "161:46", "161:46", 161.77, null, 44216.74],
  ];

  it("parses tx id, serial dates, units, rate/amount; flags bad rows; skips Total", () => {
    const { rows, errors } = parseTimesheetRows(matrix);
    expect(rows).toHaveLength(2);
    expect(rows[0].prohukumTimeId).toBe("14935");
    expect(rows[0].date).toBe("2026-06-15");
    expect(rows[0].matterCode).toBe("90179-02");
    expect(rows[0].units).toBe(2);
    expect(rows[0].importedRate).toBe(267.81);
    expect(rows[0].importedAmount).toBe(535.62);
    expect(rows[0].description).toBe("Attend strategic discussion"); // newline collapsed
    expect(rows[1].units).toBe(0.25);
    expect(errors).toHaveLength(1); // missing fee earner
  });
});
