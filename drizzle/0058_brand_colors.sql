-- Brand colours: the palette a brand renders in, and the meter for the metered
-- endpoint that supplies it.
--
-- Hand-trimmed from `drizzle-kit generate`, which also re-emitted 0057's
-- brand_offers restructure: 0057 was hand-authored without regenerating the
-- meta snapshot, so the baseline diffed against 0056. The regenerated
-- 0058_snapshot.json IS true to schema.ts and repairs that baseline; only the
-- statements below belong to this migration.
--
-- Purely additive: two new tables, no existing table touched, nothing dropped.

CREATE TABLE IF NOT EXISTS "brand_colors" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"colors" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "brand_colors_status_check" CHECK ("brand_colors"."status" IN ('pending','resolved','unavailable'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "logo_dev_brand_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer,
	"detail" text,
	"called_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_colors_brand_id_fkey') THEN
		ALTER TABLE "brand_colors" ADD CONSTRAINT "brand_colors_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_colors_pending_idx" ON "brand_colors" USING btree ("status","attempts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logo_dev_brand_calls_called_at_idx" ON "logo_dev_brand_calls" USING btree ("called_at");
