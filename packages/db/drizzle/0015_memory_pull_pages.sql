ALTER TABLE memory_sync_state ADD COLUMN pull_progress jsonb;
--> statement-breakpoint
CREATE TABLE memory_sync_pull_page (
 scope text NOT NULL REFERENCES memory_sync_state(scope) ON DELETE CASCADE,
 memory_id text NOT NULL, revision text NOT NULL, stream text NOT NULL,
 page integer NOT NULL, rows jsonb NOT NULL,
 PRIMARY KEY(scope, memory_id, revision, stream, page)
);
