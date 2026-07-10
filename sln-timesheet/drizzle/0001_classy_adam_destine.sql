ALTER TABLE "time_entries" ADD COLUMN "sendback_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;