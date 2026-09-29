-- 2026-09-29: a ban-at-threshold guard on wallet_moments_cache rows with edition_key IS NULL, wired into
-- rpc_ops_snapshot() as 'wmc_null_edition_key'.
--
-- WHY. From 2026-09-07 /api/wallet-search wrote each All Day page load's 50 ids into the TOP SHOT cache as
-- nameless NULL-key rows; 1,681 accrued over three weeks and only a weekly Cowork sweep noticed. Nothing
-- in the estate counted them. The code and the rows were fixed the same day ("wallet-search: All Day ids
-- never touch Top Shot"; audit_20260929_delete_wmc_allday_ids_in_topshot_cache); this makes a recurrence
-- visible in the read every session and the nightly pass take first.
--
-- ⛔ NOT A BAN-AT-ZERO. A NULL key is sometimes TRUE: a held moment whose metadata read failed is inserted
-- key-less and named later (0xbd94…: 2 real Top Shot rows; one new genuine row landed 12:30 PM PT today).
-- Thresholds are sized from the measured background, per collection:
--   new_7d  > 25   — background was 1–2 per week before 09-07; the defect wrote 50 per page load, so one
--                    bad page trips it.
--   total   > 100  — catches a slow leak that stays under 25 a week. Live at install: TS 3, All Day 7,
--                    UFC 2, every other collection 0.
-- created_at counts INSERTS only. A WIPE of an existing key (the other shape this class took) is closed at
-- the writer instead: 20260929203000_audit_20260929_upsert_wmc_batch_null_never_erases_a_known_key.
--
-- Cost: served by the partial index idx_wmc_edition_key_null — 96 buffers, 9 ms measured.
--
-- Revert: drop the 'wmc_null_edition_key' line from rpc_ops_snapshot() (the same guarded transform in
--         reverse), then DROP FUNCTION IF EXISTS public.check_wmc_null_edition_key(integer, integer);

CREATE OR REPLACE FUNCTION public.check_wmc_null_edition_key(p_max_new_7d integer DEFAULT 25, p_max_total integer DEFAULT 100)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind',        'wmc_null_edition_key',
           'collection',  c.slug,
           'new_7d',      q.new_7d,
           'wallets_7d',  q.wallets_7d,
           'total',       q.total,
           'max_new_7d',  p_max_new_7d,
           'max_total',   p_max_total
         ) ORDER BY q.new_7d DESC, q.total DESC), '[]'::jsonb)
  FROM (
    SELECT w.collection_id,
           count(*) FILTER (WHERE w.created_at > now() - interval '7 days')                               AS new_7d,
           count(DISTINCT w.wallet_address) FILTER (WHERE w.created_at > now() - interval '7 days')       AS wallets_7d,
           count(*)                                                                                        AS total
      FROM public.wallet_moments_cache w
     WHERE w.edition_key IS NULL
     GROUP BY w.collection_id
  ) q
  JOIN public.collections c ON c.id = q.collection_id
  WHERE q.new_7d > p_max_new_7d OR q.total > p_max_total;
$fn$;

COMMENT ON FUNCTION public.check_wmc_null_edition_key(integer, integer) IS
  'Guard on wallet_moments_cache rows with edition_key IS NULL, per collection. Returns a jsonb ARRAY: '
  'clean is jsonb_array_length() = 0, NEVER count(*) = 1. NOT ban-at-zero: a held moment whose metadata '
  'read failed is legitimately inserted key-less. Trips on > p_max_new_7d inserted in 7 days (default 25; '
  'the 09-07..09-29 All Day-ids-in-Top-Shot defect wrote 50 per page load, background was 1-2/week) or '
  '> p_max_total standing (default 100). Wired into rpc_ops_snapshot() as wmc_null_edition_key.';

REVOKE ALL ON FUNCTION public.check_wmc_null_edition_key(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_wmc_null_edition_key(integer, integer) TO postgres, service_role;

-- ── wire it into the reader ──────────────────────────────────────────────────
-- GUARDED TRANSFORM of the LIVE definition, not a retyped body (the 20260920014812 pattern): it RAISEs
-- unless the anchor matches EXACTLY ONCE, so it cannot revert a concurrent edit or mis-transcribe 6 KB.
-- Live at authoring time: prosrc 6447 chars, normalized md5 51e3aaaff1ff2b37160b94f5f788d090.
--
-- anon-exec: unchanged for rpc_ops_snapshot — a REPLACE of an existing function; CREATE OR REPLACE keeps the ACL; verified 2026-09-29 via has_function_privilege: anon=false, authenticated=false, service_role=true.
DO $mig$
DECLARE
  v_def     text;
  v_anchor  text := $a$    'cross_collection_mat_staleness', public.check_cross_collection_mat_staleness(),$a$;
  v_add     text := $a$    -- Added 2026-09-29. jsonb ARRAY, clean at length 0 -- but a THRESHOLD guard, not ban-at-zero:
    -- a held moment whose metadata read failed is legitimately inserted key-less. One entry per
    -- collection over 25 NULL-key rows inserted in 7 days or 100 standing. 09-07..09-29 the Top Shot
    -- cache took 1,681 All Day ids this way and nothing here counted them.
    'wmc_null_edition_key', public.check_wmc_null_edition_key(),$a$;
  v_hits    int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'rpc_ops_snapshot' AND p.pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'rpc_ops_snapshot() not found — refusing to guess at its body';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'anchor matched % times, expected exactly 1 — the live body moved; re-read it', v_hits;
  END IF;
  IF position('wmc_null_edition_key' in v_def) > 0 THEN
    RAISE EXCEPTION 'rpc_ops_snapshot() already carries the key — refusing to double-wire';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_anchor || E'\n' || v_add);
END
$mig$;

-- ── verification, same migration ─────────────────────────────────────────────
DO $verify$
DECLARE
  v jsonb;
BEGIN
  -- Clean at the defaults today (TS 3 total / 1 new, All Day 7 / 0, UFC 2 / 0).
  v := public.check_wmc_null_edition_key();
  IF jsonb_typeof(v) <> 'array' THEN
    RAISE EXCEPTION 'guard returned %, expected a jsonb array', jsonb_typeof(v);
  END IF;
  IF jsonb_array_length(v) <> 0 THEN
    RAISE EXCEPTION 'guard is non-empty at the defaults on install: %', v;
  END IF;
  -- Positive control: at zero thresholds it must SEE the rows that exist, or it is vacuous.
  v := public.check_wmc_null_edition_key(0, 0);
  IF jsonb_array_length(v) < 1 THEN
    RAISE EXCEPTION 'guard saw nothing at (0, 0) though NULL-key rows exist — it cannot see the property';
  END IF;
  -- Wired exactly once, and the ACL is what the marker states.
  IF (SELECT (length(prosrc) - length(replace(prosrc, '''wmc_null_edition_key''', ''))) / length('''wmc_null_edition_key''')
        FROM pg_proc WHERE proname = 'rpc_ops_snapshot' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'rpc_ops_snapshot() does not carry the key exactly once';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_ops_snapshot()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_wmc_null_edition_key(integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_wmc_null_edition_key(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated can EXECUTE a snapshot function';
  END IF;
END
$verify$;
