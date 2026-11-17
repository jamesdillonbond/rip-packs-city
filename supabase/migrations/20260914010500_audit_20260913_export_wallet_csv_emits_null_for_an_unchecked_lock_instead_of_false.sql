-- The SECOND downloadable CSV carrying register #112's false claim.
--
-- `export_wallet_csv` (behind /api/profile/export-csv) ended its SELECT with
-- `coalesce(w.is_locked, false) as is_locked` -- the `?? 0` shape in SQL -- and
-- the route wrote `r.is_locked ? "true" : "false"` into an "is_locked" column.
-- So a moment nobody had ever checked was exported as a definite `false` into a
-- file the user downloads and KEEPS. Measured on a real wallet after this
-- change: 19 rows -> 10 unknown, 5 locked, 4 verified unlocked. Those 10 used to
-- read "false".
--
-- ⭐ WHY NULL AND NOT A NEW COLUMN. Every other surface fixed today gained a
-- `lock_known` companion, but this function's signature is `RETURNS TABLE(...)`,
-- and Postgres cannot add a column to that with CREATE OR REPLACE (42P13) -- it
-- needs DROP + CREATE, which drops the grants with it and opens a window where
-- the function does not exist. Emitting NULL for "never checked" is equally
-- honest, needs no signature change, and no grant is touched. The route renders
-- NULL as the string `unknown`, a third token in a column that already carried
-- strings.
--
-- Applied as a guarded transform of the live definition; the replacement RAISEs
-- unless it matches exactly once, and a post-condition block asserts the
-- provenance gate is present and the bare coalesce is gone.
--
-- anon-exec: intentional -- export_wallet_csv backs the signed-in profile export
-- and keeps its existing ACL. ⚠ This is a RECORD of a transform applied via MCP;
-- re-running it RAISEs (0 occurrences) rather than silently re-applying against a
-- body someone else has since changed.
--
-- REVERT: restore `coalesce(w.is_locked, false)                         as is_locked`.
-- No data is written.

DO $mig$
DECLARE
  v_def text; v_hits int;
  c_from CONSTANT text := 'coalesce(w.is_locked, false)                         as is_locked';
  c_to   CONSTANT text := 'case when w.lock_checked_at is not null then coalesce(w.is_locked, false) end as is_locked';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='export_wallet_csv';
  IF v_def IS NULL THEN RAISE EXCEPTION 'export_wallet_csv() not found'; END IF;

  v_hits := (length(v_def)-length(replace(v_def,c_from,'')))/length(c_from);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'is_locked coalesce: expected 1, found %', v_hits; END IF;
  v_def := replace(v_def, c_from, c_to);

  EXECUTE v_def;
END $mig$;

DO $check$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='export_wallet_csv';
  IF position('lock_checked_at' in v_def)=0 THEN RAISE EXCEPTION 'post-check: provenance gate absent'; END IF;
  IF position('coalesce(w.is_locked, false)                         as is_locked' in v_def)>0
    THEN RAISE EXCEPTION 'post-check: the bare coalesce survives'; END IF;
END $check$;
