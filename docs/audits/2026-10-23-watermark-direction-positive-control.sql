-- Positive control for 20261023050947 (run 2026-10-22 ~10:05 PM PT on a scratch Postgres via scripts/lib/local-postgres.mjs; from the repo root: psql $URL -v ON_ERROR_STOP=1 -f docs/audits/2026-10-23-watermark-direction-positive-control.sql).
-- Expected final rows: down 1/4 rewind_count 1 (80 -> 95); up 4/1 rewind_count 0 (120 -> 50 re-seed, then 60, 70); static 0/0 unarmed. Everything ROLLS BACK.
BEGIN;
CREATE SCHEMA IF NOT EXISTS public;
CREATE TABLE public.event_cursor (id text primary key, last_processed_block bigint, updated_at timestamptz default now());
CREATE TABLE public.event_cursor_watermarks (
  cursor_id text PRIMARY KEY, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_block bigint NOT NULL,
  last_seen_cursor_updated_at timestamptz, low_water bigint NOT NULL, high_water bigint NOT NULL,
  ever_decreased boolean NOT NULL DEFAULT false, observations integer NOT NULL DEFAULT 1, rewind_count integer NOT NULL DEFAULT 0,
  last_rewind_at timestamptz, last_rewind_from bigint, last_rewind_to bigint, observed_at timestamptz NOT NULL DEFAULT now(),
  changes_observed integer NOT NULL DEFAULT 0);
\i supabase/migrations/20261023050947_audit_20261023_watermark_observer_infers_direction_from_the_majority_of_moves.sql
INSERT INTO public.event_cursor VALUES ('down',100,now()),('up',100,now()),('static',100,now());
SELECT observe_event_cursor_watermarks();
UPDATE event_cursor SET last_processed_block = CASE id WHEN 'down' THEN 90 WHEN 'up' THEN 110 ELSE 100 END; SELECT observe_event_cursor_watermarks();
UPDATE event_cursor SET last_processed_block = CASE id WHEN 'down' THEN 80 WHEN 'up' THEN 120 ELSE 100 END; SELECT observe_event_cursor_watermarks();
UPDATE event_cursor SET last_processed_block = CASE id WHEN 'down' THEN 95 WHEN 'up' THEN 50 ELSE 100 END; SELECT observe_event_cursor_watermarks();
UPDATE event_cursor SET last_processed_block = CASE id WHEN 'down' THEN 85 WHEN 'up' THEN 60 ELSE 100 END; SELECT observe_event_cursor_watermarks();
UPDATE event_cursor SET last_processed_block = CASE id WHEN 'down' THEN 75 WHEN 'up' THEN 70 ELSE 100 END; SELECT observe_event_cursor_watermarks();
SELECT cursor_id, last_seen_block, increases, decreases, ever_decreased, rewind_count, last_rewind_from, last_rewind_to, changes_observed FROM event_cursor_watermarks ORDER BY 1;
ROLLBACK;
