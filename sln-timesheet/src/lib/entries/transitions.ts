// Entry state machine — server-enforced. Every mutation of a time entry MUST
// go through canTransition/canEditEntry; API routes reject anything illegal.
//
// draft -> submitted -> approved -> billed
//   - create/edit/delete draft: owner, or a registered DELEGATE of the owner
//     (e.g. a secretary managing a partner's timesheet); the entry still
//     belongs to the owner and entered_by records the typist
//   - draft -> submitted: owner or delegate (matter must be active)
//   - submitted -> approved (with optional write-down): the matter's
//     ENGAGEMENT PARTNER only (admin never approves timesheets)
//   - submitted -> draft (send back): engagement partner
//   - approved -> billed: invoice issue (partner/admin) with Accurate number
//   - billed -> approved: ONLY via invoice void (admin, audited)

export type EntryStatus = "draft" | "submitted" | "approved" | "billed";
export type Role = "member" | "partner" | "admin";

export interface TransitionContext {
  actor: { id: number; role: Role };
  entry: { userId: number; status: EntryStatus };
  matter: { engagementPartnerId: number; status: "active" | "closed" };
  /** True only when the transition is part of an invoice issue/void flow. */
  viaInvoice?: boolean;
  /** True when the actor is a registered delegate of the entry's owner. */
  actorIsDelegateOfOwner?: boolean;
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

const ok: TransitionResult = { ok: true };
const no = (reason: string): TransitionResult => ({ ok: false, reason });

export function canCreateEntry(ctx: {
  actor: { id: number };
  matter: { status: "active" | "closed" };
  forUserId: number;
  actorIsDelegateOfOwner?: boolean;
}): TransitionResult {
  if (ctx.matter.status === "closed") return no("Matter is closed — no new time can be logged.");
  if (ctx.actor.id !== ctx.forUserId && !ctx.actorIsDelegateOfOwner)
    return no("You can only log time for yourself or someone you are a delegate for.");
  return ok;
}

function isOwnerOrDelegate(ctx: TransitionContext): boolean {
  return ctx.actor.id === ctx.entry.userId || ctx.actorIsDelegateOfOwner === true;
}

export function canEditEntry(ctx: TransitionContext): TransitionResult {
  if (ctx.entry.status !== "draft") return no("Only draft entries can be edited or deleted.");
  if (!isOwnerOrDelegate(ctx)) return no("Only the owner (or their delegate) can edit a draft.");
  return ok;
}

export function canTransition(
  from: EntryStatus,
  to: EntryStatus,
  ctx: TransitionContext,
): TransitionResult {
  if (from !== ctx.entry.status) return no("Entry changed underneath you — reload and retry.");

  if (from === "draft" && to === "submitted") {
    if (!isOwnerOrDelegate(ctx)) return no("Only the owner (or their delegate) can submit their time.");
    if (ctx.matter.status === "closed") return no("Matter is closed — cannot submit time to it.");
    return ok;
  }

  if (from === "submitted" && to === "approved") {
    if (ctx.actor.id !== ctx.matter.engagementPartnerId)
      return no("Only this matter's engagement partner can approve its time.");
    return ok;
  }

  if (from === "submitted" && to === "draft") {
    if (ctx.actor.id !== ctx.matter.engagementPartnerId)
      return no("Only this matter's engagement partner can send an entry back.");
    return ok;
  }

  if (from === "approved" && to === "billed") {
    if (!ctx.viaInvoice) return no("Entries become billed only by issuing an invoice.");
    if (ctx.actor.role === "member") return no("Only partners or admins issue invoices.");
    return ok;
  }

  if (from === "billed" && to === "approved") {
    if (!ctx.viaInvoice) return no("Billed entries reopen only by voiding their invoice.");
    if (ctx.actor.role !== "admin") return no("Only an admin can void an invoice.");
    return ok;
  }

  return no(`Illegal transition ${from} -> ${to}.`);
}
