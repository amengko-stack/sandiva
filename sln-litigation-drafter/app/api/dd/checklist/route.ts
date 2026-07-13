import { NextRequest, NextResponse } from "next/server";
import { loadChecklist, resolveChecklist, generateChecklistTemplate } from "@/lib/dd/checklist-loader";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";
import type { DDTransactionType } from "@/types/dd";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const txn = new URL(req.url).searchParams.get("txn") ?? "";
    if (!DD_TRANSACTION_TYPES.some((t) => t.id === txn)) {
      return NextResponse.json({ error: "Parameter txn tidak valid" }, { status: 400 });
    }
    const cl = await loadChecklist();
    return NextResponse.json({
      checklist: resolveChecklist(cl, txn as DDTransactionType),
      source: cl.version === "seed-1" ? "seed" : "sharepoint",
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json();
    if (action !== "generate-template") {
      return NextResponse.json({ error: "action tidak dikenal" }, { status: 400 });
    }
    await generateChecklistTemplate();
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
