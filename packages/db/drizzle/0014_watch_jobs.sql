CREATE TABLE IF NOT EXISTS watch_state (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS watch_job (id uuid PRIMARY KEY, route text NOT NULL, episode text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(route,episode));
CREATE TABLE IF NOT EXISTS watch_event (route text NOT NULL, event_id text NOT NULL, job_id uuid NOT NULL REFERENCES watch_job(id), PRIMARY KEY(route,event_id));
