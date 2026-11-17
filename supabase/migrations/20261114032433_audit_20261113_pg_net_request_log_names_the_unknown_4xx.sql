-- audit_20261113_pg_net_request_log_names_the_unknown_4xx — 2026-11-13 ~6:30 PM PT (Claude Code cloud; Trevor:
-- "Keep going"; known-issues #241).
--
-- FINDING (#241). check_edge_fn_http_failures attributes a pg_net 4xx to a lane only by joining
-- net._http_response.id to a lane's own request-id table. A lane that NULLs its request_id when it collects (pinnacle
-- chain opens, the UFC bio tick), and any ad-hoc dispatch, falls into the ELSE arm: pg_net_http_<code>, "WHICH
-- ENDPOINT IS UNKNOWN", CRITICAL for 401/403. Three instances so far (11-08 ×2 lanes, 11-10 a session probe), each
-- diagnosed by hand from request-id adjacency. net._http_response has no url column; the URL lives in
-- net.http_request_queue, which the worker drains on completion.
-- FIX (the register's "cheaper" shape).
--   1. public.pg_net_request_log(request_id, method, host, path, dispatched_at) filled by ONE AFTER INSERT trigger on
--      net.http_request_queue — every lane, present and future, with no dispatcher touched. pg_net inserts there in
--      the CALLER's transaction, so the trigger function SWALLOWS its own errors (a raising trigger would fail every
--      dispatch on the estate). Stored: method, lower-cased host (userinfo removed), path without the query string or
--      fragment, and any path segment that looks like a key (20+ chars of [A-Za-z0-9_-] containing a digit)
--      masked as :token. Headers and bodies are never read. Kept to 24 h by the hourly prune job of the follow-up migration.
--   2. check_edge_fn_http_failures: resp carries r.id, grp carries array_agg(id), and the ELSE arm's detail names the
--      endpoint(s) from the log ("ENDPOINT per pg_net_request_log: GET api.example.com/v1/x; …", or "not logged").
--      Severity, pipeline name and every other arm are unchanged. Applied by an in-DB replace() of three exact
--      fragments, each asserted present once; base prosrc md5 ee067a51809a67d5225dfe6b060fcdab asserted; the result's
--      md5 is asserted too (see the guard below), so a drifted base refuses instead of half-applying.
-- ⚠ An extension upgrade may recreate net.http_request_queue without the trigger: the ELSE arm then reads
--   "not logged" again — the visible failure mode, not a wrong one.
-- anon-exec: pg_net_request_log_capture is NOT anon-executable; check_edge_fn_http_failures unchanged (ACL kept).
-- Revert: remove trigger pg_net_request_log_capture_trg from net.http_request_queue; re-create
--   check_edge_fn_http_failures from 20261109150000; then the log table may go.

create table if not exists public.pg_net_request_log (
  request_id    bigint primary key,
  method        text,
  host          text,
  path          text,
  dispatched_at timestamptz not null default now()
);
create index if not exists idx_pg_net_request_log_dispatched_at on public.pg_net_request_log (dispatched_at);
alter table public.pg_net_request_log enable row level security;
revoke all on table public.pg_net_request_log from public, anon, authenticated;
grant select on table public.pg_net_request_log to service_role;

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
revoke all on function public.pg_net_request_log_capture() from public, anon, authenticated;

create trigger pg_net_request_log_capture_trg
  after insert on net.http_request_queue
  for each row execute function public.pg_net_request_log_capture();

-- (2) the ELSE arm names the endpoint
DO $edit$
DECLARE
  v_src text;
  v_new text;
  v_def text;
  a1 constant text := E'  resp AS (\n    SELECT r.status_code,\n           r.content,\n';
  b1 constant text := E'  resp AS (\n    SELECT r.status_code,\n           r.content,\n           r.id AS rid,\n';
  a2 constant text := E'SELECT status_code, lane, count(*)::int AS n, left(min(content), 200) AS sample\n      FROM resp GROUP BY 1, 2';
  b2 constant text := E'SELECT status_code, lane, count(*)::int AS n, left(min(content), 200) AS sample, array_agg(rid) AS rids\n      FROM resp GROUP BY 1, 2';
  a3 constant text := E'|| ''WHICH ENDPOINT IS UNKNOWN: net._http_response has no url column (the URL lives in ''';
  b3 constant text := E'|| ''ENDPOINT per public.pg_net_request_log (#241): ''\n                      || COALESCE((SELECT string_agg(DISTINCT l.method || '' '' || l.host || l.path, ''; '')\n                                     FROM public.pg_net_request_log l WHERE l.request_id = ANY (g.rids)), ''not logged'')\n                      || ''. IF NOT LOGGED, WHICH ENDPOINT IS UNKNOWN: net._http_response has no url column (the URL lives in ''';
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.check_edge_fn_http_failures(interval)'::regprocedure;
  IF md5(v_src) <> 'ee067a51809a67d5225dfe6b060fcdab' THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures changed since 20261109150000 (md5 %); re-read before editing', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, a1, ''))) / length(a1) <> 1 THEN RAISE EXCEPTION 'fragment a1 not found exactly once'; END IF;
  IF (length(v_src) - length(replace(v_src, a2, ''))) / length(a2) <> 1 THEN RAISE EXCEPTION 'fragment a2 not found exactly once'; END IF;
  IF (length(v_src) - length(replace(v_src, a3, ''))) / length(a3) <> 1 THEN RAISE EXCEPTION 'fragment a3 not found exactly once'; END IF;
  v_new := replace(replace(replace(v_src, a1, b1), a2, b2), a3, b3);
  v_def := pg_get_functiondef('public.check_edge_fn_http_failures(interval)'::regprocedure);
  -- swap the body inside the definition (the body is the dollar-quoted prosrc, verbatim)
  IF position(v_src IN v_def) = 0 THEN RAISE EXCEPTION 'prosrc not found verbatim inside pg_get_functiondef'; END IF;
  EXECUTE replace(v_def, v_src, v_new);
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.check_edge_fn_http_failures(interval)'::regprocedure)) <> md5(v_new) THEN
    RAISE EXCEPTION 'post-edit body mismatch';
  END IF;
END $edit$;