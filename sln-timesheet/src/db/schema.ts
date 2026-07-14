import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// "accounting" = billing/AR staff, NOT fee earners: can issue invoices, mark
// paid, view reports (no margin/cost — that stays admin+partner only), but
// no access to Users & rates (confidential cost rates), Matters/Clients,
// imports, settings, audit, or Ask-AI.
export const userRole = pgEnum("user_role", ["member", "partner", "admin", "accounting"]);

export const matterStatus = pgEnum("matter_status", ["active", "closed"]);

// Matches Prohukum "Billing Type" (real mix: Lump Sum 233, Hourly 63,
// Retainer 2, Success Fee 1) plus internal matters (e.g. SANDIVA GROUP BD).
export const feeType = pgEnum("fee_type", [
  "hourly",
  "lump_sum",
  "retainer",
  "success_fee",
  "internal",
]);

export const currency = pgEnum("currency", ["IDR", "USD"]);

// Entry lifecycle — transitions are enforced in src/lib/entries/transitions.ts.
export const entryStatus = pgEnum("entry_status", [
  "draft",
  "submitted",
  "approved",
  "billed",
]);

export const invoiceStatus = pgEnum("invoice_status", ["issued", "void"]);

export const importKind = pgEnum("import_kind", ["clients", "matters", "time"]);

// ---------------------------------------------------------------------------
// Users & rates
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    // Fee-earner initials as used firm-wide (AHM, FAS, ...); shown on entry rows.
    initials: text("initials").notNull(),
    email: text("email").notNull(),
    // Null until the user activates their invite link and sets their own
    // password — a "pending invite" has no usable credential at all.
    passwordHash: text("password_hash"),
    role: userRole("role").notNull().default("member"),
    // Signature block on invoices, e.g. "Partner".
    title: text("title"),
    signatureImage: text("signature_image"),
    weeklyTargetUnits: numeric("weekly_target_units", { precision: 5, scale: 2 })
      .notNull()
      .default("40"),
    active: boolean("active").notNull().default(true),
    // Admin-created accounts must set their own password on first login.
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    accurateItemNo: text("accurate_item_no"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
    initialsUnique: uniqueIndex("users_initials_unique").on(t.initials),
  }),
);

// Rate history: the rate in effect for a date is the row with the latest
// effective_from <= that date. Billing rates exist per currency — a matter
// bills in its own currency and a missing rate is "unresolved", never FX'd.
export const userRates = pgTable("user_rates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  billingRateIdr: numeric("billing_rate_idr", { precision: 14, scale: 0 }),
  billingRateUsd: numeric("billing_rate_usd", { precision: 10, scale: 2 }),
  // Confidential — margin only; visible to admins (and partner reports in aggregate).
  costRateIdr: numeric("cost_rate_idr", { precision: 14, scale: 0 }),
  effectiveFrom: date("effective_from").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Clients & matters
// ---------------------------------------------------------------------------

export const clients = pgTable(
  "clients",
  {
    id: serial("id").primaryKey(),
    // Prohukum client code with the leading apostrophe stripped, e.g. "50158".
    clientCode: text("client_code").notNull(),
    name: text("name").notNull(),
    npwp: text("npwp"),
    billingAddress: text("billing_address"),
    contactPerson: text("contact_person"),
    email: text("email"),
    accurateCustomerNo: text("accurate_customer_no"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex("clients_code_unique").on(t.clientCode),
  }),
);

export const matters = pgTable(
  "matters",
  {
    id: serial("id").primaryKey(),
    // "ClientCode-Seq" (e.g. 50158-01) = the invoice "Project Number".
    matterCode: text("matter_code").notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    // Prohukum "Task" column.
    title: text("title").notNull(),
    practiceArea: text("practice_area"),
    feeType: feeType("fee_type").notNull(),
    // Minor units of `currency` (IDR rupiah, USD cents).
    feeAmount: numeric("fee_amount", { precision: 16, scale: 0 }),
    currency: currency("currency").notNull().default("IDR"),
    disbursementsEstimate: numeric("disbursements_estimate", { precision: 16, scale: 0 }),
    retainerUnits: numeric("retainer_units", { precision: 8, scale: 2 }),
    retainerAmount: numeric("retainer_amount", { precision: 16, scale: 0 }),
    // "UP" (attention) contact printed on the invoice.
    up: text("up"),
    // Exactly one engagement partner per matter: approves its time and signs
    // its invoices. Import default = Prohukum "Handling Partner"; admin can
    // reassign. Admin never approves timesheets.
    engagementPartnerId: integer("engagement_partner_id")
      .notNull()
      .references(() => users.id),
    // Closed matters are hidden from the log-time picker; history retained.
    status: matterStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex("matters_code_unique").on(t.matterCode),
  }),
);

// Informational team roster from Prohukum (handling/originating/responsible/
// associate) — drives "my matters first" sorting in the picker.
export const matterTeam = pgTable(
  "matter_team",
  {
    id: serial("id").primaryKey(),
    matterId: integer("matter_id")
      .notNull()
      .references(() => matters.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    teamRole: text("team_role").notNull(),
  },
  (t) => ({
    memberUnique: uniqueIndex("matter_team_unique").on(t.matterId, t.userId, t.teamRole),
  }),
);

// Delegation: `delegate` may enter/manage time ON BEHALF OF `principal`
// (e.g. a secretary logging a partner's time). Entries still belong to the
// principal and route to the engagement partner; entered_by records the typist.
export const delegates = pgTable(
  "delegates",
  {
    id: serial("id").primaryKey(),
    delegateId: integer("delegate_id")
      .notNull()
      .references(() => users.id),
    principalId: integer("principal_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pairUnique: uniqueIndex("delegates_pair_unique").on(t.delegateId, t.principalId),
  }),
);

// Per-matter negotiated rate override, in the matter's currency.
export const matterRates = pgTable("matter_rates", {
  id: serial("id").primaryKey(),
  matterId: integer("matter_id")
    .notNull()
    .references(() => matters.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------

export const timeEntries = pgTable(
  "time_entries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    matterId: integer("matter_id")
      .notNull()
      .references(() => matters.id),
    date: date("date").notNull(),
    // Quantity is "Units" (1 unit = 1 hour) to 2 decimals — the firm's billing
    // format (0.17, 0.08, ...). NEVER minutes: 0.17 unit = 10.2 min and integer
    // minutes corrupt the data.
    units: numeric("units", { precision: 6, scale: 2 }).notNull(),
    // Write-down by the engagement partner at approval; actual `units` are
    // preserved for realization/margin.
    billedUnits: numeric("billed_units", { precision: 6, scale: 2 }),
    noCharge: boolean("no_charge").notNull().default(false),
    workcode: text("workcode").notNull(),
    description: text("description").notNull(),
    status: entryStatus("status").notNull().default("draft"),
    // Engagement partner's reason when sending an entry back; shown to the
    // owner while draft, cleared on resubmit.
    sendbackNote: text("sendback_note"),
    // Historical rows imported from Prohukum keep their original pricing and
    // are never re-resolved against today's rates.
    isHistorical: boolean("is_historical").notNull().default(false),
    importedRate: numeric("imported_rate", { precision: 14, scale: 2 }),
    importedAmount: numeric("imported_amount", { precision: 16, scale: 2 }),
    // Prohukum "Transaction ID" — idempotent import dedup.
    prohukumTimeId: text("prohukum_time_id"),
    invoiceId: integer("invoice_id"),
    // Who actually typed the entry when a delegate logged it (null = the owner).
    enteredBy: integer("entered_by"),
    updatedBy: integer("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    prohukumUnique: uniqueIndex("time_entries_prohukum_unique").on(t.prohukumTimeId),
  }),
);

// ---------------------------------------------------------------------------
// Disbursements & invoices
// ---------------------------------------------------------------------------

export const disbursements = pgTable("disbursements", {
  id: serial("id").primaryKey(),
  matterId: integer("matter_id")
    .notNull()
    .references(() => matters.id),
  date: date("date").notNull(),
  description: text("description").notNull(),
  // Minor units; currency must equal the matter's currency (enforced in app code).
  amount: numeric("amount", { precision: 16, scale: 0 }).notNull(),
  currency: currency("currency").notNull(),
  invoiceId: integer("invoice_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Invoices snapshot everything at issue time (immutable). Reopening billed
// entries requires voiding the invoice (admin, audited).
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  // Single-matter invoice: matterId set. Combined invoice (several matters of
  // one client, same currency + same engagement partner): matterId null,
  // clientId set, per-line matter codes on invoice_lines.
  matterId: integer("matter_id").references(() => matters.id),
  clientId: integer("client_id").references(() => clients.id),
  // Accurate owns the official number; required before "Issue & mark billed".
  accurateInvoiceNo: text("accurate_invoice_no").notNull(),
  invoiceDate: date("invoice_date").notNull(),
  dueDate: date("due_date").notNull(),
  // Snapshot of the client billing block (name/address/UP/NPWP) at issue.
  clientBlock: jsonb("client_block").notNull(),
  currency: currency("currency").notNull(),
  subtotal: numeric("subtotal", { precision: 16, scale: 2 }).notNull(),
  // Per-invoice PPN override (default from settings; USD/export cases differ).
  ppnRate: numeric("ppn_rate", { precision: 5, scale: 2 }).notNull(),
  ppnAmount: numeric("ppn_amount", { precision: 16, scale: 2 }).notNull(),
  total: numeric("total", { precision: 16, scale: 2 }).notNull(),
  // Signatory snapshot = the matter's engagement partner at issue.
  signatory: jsonb("signatory").notNull(),
  // Remit-to bank account chosen at issue (snapshot; nullable for legacy rows).
  bankAccount: jsonb("bank_account"),
  status: invoiceStatus("status").notNull().default("issued"),
  // Light AR: when finance confirms collection (Accurate remains the ledger).
  paidAt: date("paid_at"),
  issuedBy: integer("issued_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invoiceLines = pgTable("invoice_lines", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoices.id),
  kind: text("kind").notNull(), // "fee" | "disbursement"
  // Snapshot of the matter code — needed to group lines on combined invoices.
  matterCode: text("matter_code"),
  date: date("date").notNull(),
  description: text("description").notNull(),
  lawyerName: text("lawyer_name"),
  rate: numeric("rate", { precision: 14, scale: 2 }),
  units: numeric("units", { precision: 6, scale: 2 }),
  amount: numeric("amount", { precision: 16, scale: 2 }).notNull(),
  timeEntryId: integer("time_entry_id"),
  disbursementId: integer("disbursement_id"),
});

// ---------------------------------------------------------------------------
// Settings, imports, audit
// ---------------------------------------------------------------------------

// Singleton row (id = 1).
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  // "2dp" (units to 0.01) or "6min" (round up to 0.1).
  roundingRule: text("rounding_rule").notNull().default("2dp"),
  defaultPpnRate: numeric("default_ppn_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("11"),
  // Reports-only conversion for firm-wide totals; never used for billing.
  fxRateUsdIdr: numeric("fx_rate_usd_idr", { precision: 12, scale: 2 }),
  weekStart: text("week_start").notNull().default("monday"),
  firmProfile: jsonb("firm_profile"),
});

export const importBatches = pgTable("import_batches", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  kind: importKind("kind").notNull(),
  importedBy: integer("imported_by").notNull(),
  // { new, updated, unchanged, errors: [{row, reason, raw}] }
  summary: jsonb("summary").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actorId: integer("actor_id").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
