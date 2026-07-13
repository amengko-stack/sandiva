import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { extractTableSystem } from "@/lib/dd/prompts";
import type {
  DDCell, DDDocGroup, DDExtractionField, DDExtractionRow, DDTransactionType,
} from "@/types/dd";

const GROUP_CHAR_CAP = 60_000; // grouped contract + amendments, KRITIS tier text

export function fieldsForGroup(fields: DDExtractionField[], groupLabel: string): DDExtractionField[] {
  const label = groupLabel.toLowerCase();
  return fields.filter(
    (f) => f.appliesToKeywords.length === 0 || f.appliesToKeywords.some((k) => label.includes(k.toLowerCase()))
  );
}

export function buildTablePrompt(args: {
  group: DDDocGroup;
  contents: string;
  fields: DDExtractionField[];
  transactionType: DDTransactionType;
}): string {
  const cols = args.fields
    .map((f) => `- ${f.id} (${f.type}): ${f.prompt}`)
    .join("\n");
  return `Perjanjian: ${args.group.label}
File (perjanjian induk + addendum, baca sebagai SATU kesatuan — addendum mengubah induknya): ${args.group.memberFiles.join(", ")}
Transaksi yang sedang diuji: ${args.transactionType.replace(/_/g, " ")}.

=== ISI DOKUMEN ===
${args.contents.slice(0, GROUP_CHAR_CAP)}
=== AKHIR ISI DOKUMEN ===

KOLOM YANG DIEKSTRAK:
${cols}

Kembalikan HANYA JSON:
{
  "cells": [
    {
      "fieldId": "<id kolom>",
      "value": "jawaban ringkas bertipe sesuai kolom (tanggal YYYY-MM-DD, nilai dengan mata uang), atau \\"[TIDAK DITEMUKAN]\\"",
      "verbatim": "kutipan verbatim singkat dari dokumen yang mendukung jawaban (maks 40 kata), atau \\"\\"",
      "sourceFile": "nama file sumber kutipan, atau \\"\\"",
      "found": true | false
    }
  ]
}
Sertakan SATU entri untuk SETIAP kolom di atas.`;
}

export function parseTableResponse(
  raw: string,
  stopReason: string | null,
  args: { group: DDDocGroup; entityId: string; fields: DDExtractionField[]; transactionType: DDTransactionType }
): DDExtractionRow {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error(`Hasil ekstraksi tabel bukan JSON (${args.group.label})`);
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: { cells?: unknown[] };
  try {
    p = JSON.parse(jsonStr);
  } catch {
    p = JSON.parse(repairTruncatedJson(jsonStr));
  }
  if (!Array.isArray(p.cells)) throw new Error(`Hasil ekstraksi tabel tanpa "cells" (${args.group.label})`);

  const byId = new Map(args.fields.map((f) => [f.id, f]));
  const cells: DDCell[] = [];
  for (const c of p.cells) {
    const o = c as Record<string, unknown>;
    const field = byId.get(String(o.fieldId ?? ""));
    if (!field) continue; // unknown column — model hallucination, drop
    const found = o.found === true && String(o.value ?? "").trim() !== "" && String(o.value) !== "[TIDAK DITEMUKAN]";
    // dealTriggered is OUR decision from config, never the model's claim.
    const dealTriggered = found && (field.dealTriggerFor ?? []).includes(args.transactionType);
    cells.push({
      fieldId: field.id,
      type: field.type,
      value: found ? String(o.value).trim() : "—",
      verbatim: found ? String(o.verbatim ?? "").trim() : "",
      sourceFile: String(o.sourceFile ?? "").trim(),
      dealTriggered,
    });
  }

  return {
    groupId: args.group.groupId,
    entityId: args.entityId,
    agreementLabel: args.group.label,
    memberFiles: args.group.memberFiles,
    cells,
    status: "selesai",
  };
}

export async function extractTableRow(
  client: Anthropic,
  args: {
    group: DDDocGroup; contents: string; entityId: string;
    fields: DDExtractionField[]; transactionType: DDTransactionType;
  }
): Promise<DDExtractionRow> {
  const applicable = fieldsForGroup(args.fields, args.group.label);
  const response = await client.messages.create({
    model: MODELS.ddExtraction,
    max_tokens: 3000,
    system: extractTableSystem(),
    messages: [{
      role: "user",
      content: buildTablePrompt({ group: args.group, contents: args.contents, fields: applicable, transactionType: args.transactionType }),
    }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseTableResponse(raw, response.stop_reason, {
    group: args.group, entityId: args.entityId, fields: applicable, transactionType: args.transactionType,
  });
}
