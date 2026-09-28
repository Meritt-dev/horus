ALTER TABLE memory_item ADD COLUMN sync_scope text, ADD COLUMN sync_generation integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE memory_sync_state (
 scope text PRIMARY KEY, repo text NOT NULL, cursor text NOT NULL DEFAULT '0', team_cursor text NOT NULL DEFAULT '0',
 last_pull timestamptz, last_push timestamptz, error text
);
--> statement-breakpoint
CREATE TABLE memory_sync_replica (
 scope text NOT NULL REFERENCES memory_sync_state(scope),
 memory_id text NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE,
 revision text NOT NULL DEFAULT '0', generation integer NOT NULL DEFAULT 0,
 PRIMARY KEY(scope, memory_id)
);
--> statement-breakpoint
CREATE TABLE memory_sync_outbox (
 id text PRIMARY KEY, scope text NOT NULL REFERENCES memory_sync_state(scope),
 memory_id text NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE,
 generation integer NOT NULL, request jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 error text, conflict jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scope, memory_id)
);
--> statement-breakpoint
CREATE FUNCTION horus_memory_changed() RETURNS trigger AS $$
BEGIN
 IF current_setting('horus.sync_pull', true) = '1' THEN RETURN NEW; END IF;
 NEW.sync_generation := OLD.sync_generation + 1;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memory_changed BEFORE UPDATE ON memory_item FOR EACH ROW EXECUTE FUNCTION horus_memory_changed();
--> statement-breakpoint
CREATE FUNCTION horus_memory_relation_changed() RETURNS trigger AS $$
DECLARE mid text;
BEGIN
 IF current_setting('horus.sync_pull', true) = '1' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME = 'memory_link' THEN
   IF TG_OP = 'DELETE' THEN mid := OLD.from_memory_id; ELSE mid := NEW.from_memory_id; END IF;
 ELSE mid := NEW.memory_id;
 END IF;
 UPDATE memory_item SET sync_generation = sync_generation + 1 WHERE id = mid;
 RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memory_link_changed AFTER INSERT OR UPDATE OR DELETE ON memory_link FOR EACH ROW EXECUTE FUNCTION horus_memory_relation_changed();
--> statement-breakpoint
CREATE TRIGGER memory_audit_changed AFTER INSERT ON memory_audit FOR EACH ROW EXECUTE FUNCTION horus_memory_relation_changed();

--> statement-breakpoint
CREATE FUNCTION horus_memory_feedback_changed() RETURNS trigger AS $$
BEGIN
 IF current_setting('horus.sync_pull', true) = '1' THEN RETURN NULL; END IF;
 UPDATE memory_item SET sync_generation = sync_generation + 1
 WHERE id IN (SELECT from_memory_id FROM memory_link WHERE to_kind = 'incident' AND to_ref = NEW.investigation_id::text);
 RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memory_feedback_changed AFTER INSERT ON outcome_label FOR EACH ROW EXECUTE FUNCTION horus_memory_feedback_changed();
