CREATE TABLE IF NOT EXISTS "brand_sales_funnel_arrow_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"funnel_key" text NOT NULL,
	"from_step" text NOT NULL,
	"to_step" text NOT NULL,
	"rate_pct" numeric(7, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_sales_funnel_arrow_rates_brand_id_fkey') THEN
    ALTER TABLE "brand_sales_funnel_arrow_rates" ADD CONSTRAINT "brand_sales_funnel_arrow_rates_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_sales_funnel_arrow_rates_offer_id_fkey') THEN
    ALTER TABLE "brand_sales_funnel_arrow_rates" ADD CONSTRAINT "brand_sales_funnel_arrow_rates_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "public"."brand_offers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_sales_funnel_arrow_rates_offer_key" ON "brand_sales_funnel_arrow_rates" USING btree ("offer_id","funnel_key","from_step","to_step");