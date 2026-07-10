CREATE TYPE "public"."currency" AS ENUM('IDR', 'USD');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('draft', 'submitted', 'approved', 'billed');--> statement-breakpoint
CREATE TYPE "public"."fee_type" AS ENUM('hourly', 'lump_sum', 'retainer', 'success_fee', 'internal');--> statement-breakpoint
CREATE TYPE "public"."import_kind" AS ENUM('clients', 'matters', 'time');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('issued', 'void');--> statement-breakpoint
CREATE TYPE "public"."matter_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('member', 'partner', 'admin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" integer NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_code" text NOT NULL,
	"name" text NOT NULL,
	"npwp" text,
	"billing_address" text,
	"contact_person" text,
	"email" text,
	"accurate_customer_no" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disbursements" (
	"id" serial PRIMARY KEY NOT NULL,
	"matter_id" integer NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(16, 0) NOT NULL,
	"currency" "currency" NOT NULL,
	"invoice_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"kind" "import_kind" NOT NULL,
	"imported_by" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"lawyer_name" text,
	"rate" numeric(14, 2),
	"units" numeric(6, 2),
	"amount" numeric(16, 2) NOT NULL,
	"time_entry_id" integer,
	"disbursement_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"matter_id" integer NOT NULL,
	"accurate_invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"client_block" jsonb NOT NULL,
	"currency" "currency" NOT NULL,
	"subtotal" numeric(16, 2) NOT NULL,
	"ppn_rate" numeric(5, 2) NOT NULL,
	"ppn_amount" numeric(16, 2) NOT NULL,
	"total" numeric(16, 2) NOT NULL,
	"signatory" jsonb NOT NULL,
	"status" "invoice_status" DEFAULT 'issued' NOT NULL,
	"issued_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matter_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"matter_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matter_team" (
	"id" serial PRIMARY KEY NOT NULL,
	"matter_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"team_role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matters" (
	"id" serial PRIMARY KEY NOT NULL,
	"matter_code" text NOT NULL,
	"client_id" integer NOT NULL,
	"title" text NOT NULL,
	"practice_area" text,
	"fee_type" "fee_type" NOT NULL,
	"fee_amount" numeric(16, 0),
	"currency" "currency" DEFAULT 'IDR' NOT NULL,
	"disbursements_estimate" numeric(16, 0),
	"retainer_units" numeric(8, 2),
	"retainer_amount" numeric(16, 0),
	"up" text,
	"engagement_partner_id" integer NOT NULL,
	"status" "matter_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_resets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"rounding_rule" text DEFAULT '2dp' NOT NULL,
	"default_ppn_rate" numeric(5, 2) DEFAULT '11' NOT NULL,
	"fx_rate_usd_idr" numeric(12, 2),
	"week_start" text DEFAULT 'monday' NOT NULL,
	"firm_profile" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"matter_id" integer NOT NULL,
	"date" date NOT NULL,
	"units" numeric(6, 2) NOT NULL,
	"billed_units" numeric(6, 2),
	"no_charge" boolean DEFAULT false NOT NULL,
	"workcode" text NOT NULL,
	"description" text NOT NULL,
	"status" "entry_status" DEFAULT 'draft' NOT NULL,
	"is_historical" boolean DEFAULT false NOT NULL,
	"imported_rate" numeric(14, 2),
	"imported_amount" numeric(16, 2),
	"prohukum_time_id" text,
	"invoice_id" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"billing_rate_idr" numeric(14, 0),
	"billing_rate_usd" numeric(10, 2),
	"cost_rate_idr" numeric(14, 0),
	"effective_from" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"initials" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"title" text,
	"signature_image" text,
	"weekly_target_units" numeric(5, 2) DEFAULT '40' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"accurate_item_no" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matter_rates" ADD CONSTRAINT "matter_rates_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matter_rates" ADD CONSTRAINT "matter_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matter_team" ADD CONSTRAINT "matter_team_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matter_team" ADD CONSTRAINT "matter_team_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matters" ADD CONSTRAINT "matters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matters" ADD CONSTRAINT "matters_engagement_partner_id_users_id_fk" FOREIGN KEY ("engagement_partner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_rates" ADD CONSTRAINT "user_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_code_unique" ON "clients" USING btree ("client_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matter_team_unique" ON "matter_team" USING btree ("matter_id","user_id","team_role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matters_code_unique" ON "matters" USING btree ("matter_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_entries_prohukum_unique" ON "time_entries" USING btree ("prohukum_time_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_initials_unique" ON "users" USING btree ("initials");