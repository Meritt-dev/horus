ALTER TABLE "memory_item" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "cloud_id" text;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "pulled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_item_origin_idx" ON "memory_item" ("repo","origin");
