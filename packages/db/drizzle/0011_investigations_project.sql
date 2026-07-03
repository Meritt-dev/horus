ALTER TABLE "investigations" ADD COLUMN "project" text;--> statement-breakpoint
UPDATE "investigations" SET "project" = incident_input->>'repo'
WHERE "project" IS NULL AND incident_input->>'repo' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "investigations_project_created_idx" ON "investigations" ("project","created_at");
