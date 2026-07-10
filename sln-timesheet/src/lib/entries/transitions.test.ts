import { describe, expect, it } from "vitest";
import { canCreateEntry, canEditEntry, canTransition, type TransitionContext } from "./transitions";

const MEMBER = { id: 10, role: "member" as const };
const ENGAGEMENT_PARTNER = { id: 1, role: "partner" as const };
const OTHER_PARTNER = { id: 2, role: "partner" as const };
const ADMIN = { id: 99, role: "admin" as const };

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    actor: MEMBER,
    entry: { userId: MEMBER.id, status: "draft" },
    matter: { engagementPartnerId: ENGAGEMENT_PARTNER.id, status: "active" },
    ...overrides,
  };
}

describe("create / edit drafts", () => {
  it("cannot log time to a closed matter", () => {
    const r = canCreateEntry({ actor: MEMBER, matter: { status: "closed" }, forUserId: MEMBER.id });
    expect(r.ok).toBe(false);
  });
  it("cannot log time for someone else", () => {
    const r = canCreateEntry({ actor: MEMBER, matter: { status: "active" }, forUserId: 11 });
    expect(r.ok).toBe(false);
  });
  it("owner edits own draft; nobody edits non-drafts", () => {
    expect(canEditEntry(ctx()).ok).toBe(true);
    expect(canEditEntry(ctx({ actor: ADMIN })).ok).toBe(false);
    expect(canEditEntry(ctx({ entry: { userId: MEMBER.id, status: "submitted" } })).ok).toBe(false);
  });
});

describe("submit", () => {
  it("owner submits own draft", () => {
    expect(canTransition("draft", "submitted", ctx()).ok).toBe(true);
  });
  it("cannot submit on a closed matter", () => {
    const r = canTransition(
      "draft",
      "submitted",
      ctx({ matter: { engagementPartnerId: 1, status: "closed" } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("approve — engagement partner ONLY", () => {
  const submitted = { userId: MEMBER.id, status: "submitted" as const };

  it("engagement partner approves", () => {
    expect(canTransition("submitted", "approved", ctx({ actor: ENGAGEMENT_PARTNER, entry: submitted })).ok).toBe(true);
  });
  it("another partner cannot approve", () => {
    const r = canTransition("submitted", "approved", ctx({ actor: OTHER_PARTNER, entry: submitted }));
    expect(r.ok).toBe(false);
  });
  it("ADMIN cannot approve (admin is operations, never approval)", () => {
    const r = canTransition("submitted", "approved", ctx({ actor: ADMIN, entry: submitted }));
    expect(r.ok).toBe(false);
  });
  it("engagement partner can send back", () => {
    expect(canTransition("submitted", "draft", ctx({ actor: ENGAGEMENT_PARTNER, entry: submitted })).ok).toBe(true);
    expect(canTransition("submitted", "draft", ctx({ actor: OTHER_PARTNER, entry: submitted })).ok).toBe(false);
  });
});

describe("billing", () => {
  const approved = { userId: MEMBER.id, status: "approved" as const };
  const billed = { userId: MEMBER.id, status: "billed" as const };

  it("approved -> billed only via invoice issue, by partner/admin", () => {
    expect(canTransition("approved", "billed", ctx({ actor: ADMIN, entry: approved, viaInvoice: true })).ok).toBe(true);
    expect(canTransition("approved", "billed", ctx({ actor: ENGAGEMENT_PARTNER, entry: approved, viaInvoice: true })).ok).toBe(true);
    expect(canTransition("approved", "billed", ctx({ actor: ADMIN, entry: approved })).ok).toBe(false);
    expect(canTransition("approved", "billed", ctx({ actor: MEMBER, entry: approved, viaInvoice: true })).ok).toBe(false);
  });
  it("billed -> approved only via void, admin only", () => {
    expect(canTransition("billed", "approved", ctx({ actor: ADMIN, entry: billed, viaInvoice: true })).ok).toBe(true);
    expect(canTransition("billed", "approved", ctx({ actor: ENGAGEMENT_PARTNER, entry: billed, viaInvoice: true })).ok).toBe(false);
    expect(canTransition("billed", "approved", ctx({ actor: ADMIN, entry: billed })).ok).toBe(false);
  });
  it("rejects illegal jumps and stale reads", () => {
    expect(canTransition("draft", "approved", ctx()).ok).toBe(false);
    expect(canTransition("draft", "billed", ctx({ viaInvoice: true, actor: ADMIN })).ok).toBe(false);
    // status changed underneath the actor
    expect(canTransition("submitted", "approved", ctx({ actor: ENGAGEMENT_PARTNER, entry: { userId: 10, status: "draft" } })).ok).toBe(false);
  });
});
