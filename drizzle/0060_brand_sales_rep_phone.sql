CREATE TABLE IF NOT EXISTS "brand_sales_rep_phones" (
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_sales_rep_phones_org_id_brand_id_pk" PRIMARY KEY("org_id","brand_id")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_sales_rep_phones_brand_id_fkey') THEN
		ALTER TABLE "brand_sales_rep_phones" ADD CONSTRAINT "brand_sales_rep_phones_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;