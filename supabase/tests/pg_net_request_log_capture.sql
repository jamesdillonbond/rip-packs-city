-- DB invariant: public.pg_net_request_log_capture() — the AFTER INSERT trigger on net.http_request_queue that logs
-- every pg_net dispatch's endpoint for check_edge_fn_http_failures' unknown-lane arm (#241). Pinned 2026-11-13.
-- What must hold:
--   1. host + path are kept (an edge-function route name intact), the query string is never stored;
--   2. a path segment that looks like a key (20+ chars with a digit) is masked as :token; userinfo is dropped;
--   3. garbage or NULL urls never fail the dispatch (the row is still queued);
--   4. a failure INSIDE the trigger (the log table gone) never fails the dispatch.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261114032433_audit_20261113_pg_net_request_log_names_the_unknown_4xx.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, method text, url text, headers jsonb, body bytea, timeout_milliseconds int);
CREATE TABLE public.pg_net_request_log (request_id bigint primary key, method text, host text, path text, dispatched_at timestamptz not null default now());

-- >>> BEGIN verbatim pg_net_request_log_capture >>>
CREATE OR REPLACE FUNCTION public.pg_net_request_log_capture()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_rest text;
  v_head text;
  v_path text;
begin
  begin
    v_rest := split_part(split_part(coalesce(new.url, ''), '?', 1), '#', 1);
    v_rest := regexp_replace(v_rest, '^[A-Za-z][A-Za-z0-9+.-]*://', '');
    v_head := split_part(v_rest, '/', 1);
    v_path := substr(v_rest, length(v_head) + 1);
    -- a path segment that looks like a key (an API key in /v2/<key>) is masked; route names have no digits or are short
    v_path := regexp_replace(v_path, '/(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}', '/:token', 'g');
    insert into public.pg_net_request_log (request_id, method, host, path)
    values (new.id, left(new.method, 10), left(lower(regexp_replace(v_head, '^.*@', '')), 120), left(v_path, 200))
    on conflict (request_id) do nothing;
  exception when others then
    null;  -- never fail a pg_net dispatch
  end;
  return null;
end $fn$;
-- <<< END verbatim pg_net_request_log_capture <<<

CREATE TRIGGER pg_net_request_log_capture_trg AFTER INSERT ON net.http_request_queue
  FOR EACH ROW EXECUTE FUNCTION public.pg_net_request_log_capture();

INSERT INTO net.http_request_queue (method, url) VALUES
  ('POST', 'https://bxcq.supabase.co/functions/v1/topshot-active-listings-ingest?key=SECRET123456789'),
  ('GET',  'https://eth-mainnet.g.alchemy.com/v2/abcDEF1234567890ghijKLMNop'),
  ('GET',  'https://user:pass@api.coingecko.com/api/v3/simple/price?ids=flow&x_cg_demo_api_key=CG-abc'),
  ('GET',  'not a url at all'),
  ('GET',  NULL);

DO $$
BEGIN
  PERFORM _assert_eq((SELECT host || path FROM public.pg_net_request_log WHERE request_id = 1),
    'bxcq.supabase.co/functions/v1/topshot-active-listings-ingest', 'route kept, query string never stored');
  PERFORM _assert_eq((SELECT path FROM public.pg_net_request_log WHERE request_id = 2), '/v2/:token', 'a key-like path segment is masked');
  PERFORM _assert_eq((SELECT host || path FROM public.pg_net_request_log WHERE request_id = 3),
    'api.coingecko.com/api/v3/simple/price', 'userinfo and query dropped');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.pg_net_request_log WHERE strpos(coalesce(path, '') || coalesce(host, ''), 'SECRET') > 0
                       OR strpos(coalesce(path, '') || coalesce(host, ''), 'pass') > 0), '0', 'no secret survives');
  PERFORM _assert_eq((SELECT count(*)::text FROM net.http_request_queue), '5', 'every dispatch queued, garbage included');
END $$;

-- a failure inside the trigger (the log table gone) never fails the dispatch
ALTER TABLE public.pg_net_request_log RENAME TO pg_net_request_log_gone;
INSERT INTO net.http_request_queue (method, url) VALUES ('GET', 'https://example.com/x');
DO $$
BEGIN
  PERFORM _assert_eq((SELECT count(*)::text FROM net.http_request_queue), '6', 'the dispatch still queued');
  RAISE NOTICE '✓ pg_net_request_log_capture: endpoints logged, secrets never, dispatch never failed';
END $$;

ROLLBACK;
