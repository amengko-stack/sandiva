CREATE TABLE IF NOT EXISTS "delegates" (
	"id" serial PRIMARY KEY NOT NULL,
	"delegate_id" integer NOT NULL,
	"principal_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "matter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "matter_code" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "client_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_at" date;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "entered_by" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delegates" ADD CONSTRAINT "delegates_delegate_id_users_id_fk" FOREIGN KEY ("delegate_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delegates" ADD CONSTRAINT "delegates_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delegates_pair_unique" ON "delegates" USING btree ("delegate_id","principal_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
