-- PANINI — name the editions whose price is frozen because `getCardMarketStats` never lands for
-- them, while their serials refresh every walk. 2026-09-20 ~10:0x AM PT (Claude Code cloud).
--
-- ── THE DEFECT, and it is NOT the mechanism R120 records ──────────────────────────────────────
-- R120 (filed this morning) says: "`panini_editions.last_seen_at` is never written for the three
-- rows where `id = external_id`, so the freshness metric reads 66 days", and proposes fixing it by
-- "repairing the three `id`s to the `__<span>_<cap>` convention or keying the `last_seen_at` write
-- on `external_id`".
--
-- ⛔ BOTH PROPOSED FIXES ARE NO-OPS, and one of them would rewrite the primary key of the table's
-- three oldest rows for nothing. Read from the code, not inferred:
--   * The upsert ALREADY keys on external_id:
--       app/api/cron/panini-ingest/route.ts:131
--       .upsert(editionRows, { onConflict: "external_id,collection_id" })
--     backed by UNIQUE INDEX panini_editions_external_id_collection_id_key. `id` does not gate the
--     match at all, so re-keying the write is a no-op and repairing `id` changes nothing.
--   * There is NO `__<span>_<cap>` EDITION convention. Measured from the site's own serial payloads
--     (`panini_card_serials.raw`): `psku` IS the unsuffixed id, and `__<serial>_<cap>` is the
--     PER-SERIAL suffix (`..._393__43_259`, `..._393__75_259`, `..._393__210_259` — same edition).
--     A healthy control row's payload has the identical shape. So the three seed rows' external_id
--     is CORRECT and canonical; there is nothing to repair.
--
-- ✅ THE MARKER (the mechanism itself is below, and I got it wrong first). `toEditionRow` sets
-- `id: String(c?.sku ?? c?.psku)`
-- (lib/chains/panini/ingest-normalize.ts:26). A `getCardMarketStats` payload always carries `sku`
-- (a representative serial sku); a GRID item from `getMarketPlaceList` carries only `psku`. So
-- `id = external_id` means exactly: **no successful card-stats payload has ever written this row.**
-- 📏 Verified as a clean partition over all 5,074 rows, with no exceptions:
--       3 rows  id = external_id
--   5,071 rows  id matches '^<external_id>__\d+_\d+$' (a serial sku of that same edition)
--       0 rows  neither
--
-- 🚨 WHY IT MATTERS MORE THAN A FRESHNESS METRIC. `last_seen_at` and the FMV write come from the
-- SAME `cards` array in the same request, so a card-stats miss freezes the PRICE too. All three
-- have exactly ONE `panini_fmv_snapshots` row, computed 2026-07-16 — and all three are LIVE on the
-- public board `/insights/panini-squeeze` today, carrying a 66-day-old price labelled **MEDIUM**
-- confidence (Khuliso Mudau $5.22, Scott McTominay $6.41, Nico Williams $27.50). R120 classifies
-- this P2 "a metric cannot reach zero"; the sharper statement is that a public price board is
-- publishing a two-month-old price as a current one, per-row, with no per-row age disclosure.
--
-- ⛔ CORRECTION TO MY OWN FIRST READING OF THE ROOT CAUSE, before this migration was committed.
-- I attributed it to scripts/ingest-panini-runner.mjs:543-545 —
--     got = cards.length + serials.length > before;
-- which counts cards OR serials as walk success, so a card-stats miss reads as a completed walk.
-- **That is NOT what is happening here**, and a concurrent session's measurement refutes it: the
-- cards DO arrive. 12 of 459 `panini-ingest` runs in 24 h wrote `editions: 0` while serials landed,
-- exactly two per walk across all five walks, their start times matching the three rows' serial
-- captured_at to a tenth of a second.
--
-- ✅ THE CONFIRMED MECHANISM (register R120, measured 09-20 ~9:4x AM PT) is a DB write that aborts:
-- the `DO UPDATE` arm rewrites the PRIMARY KEY (`id` -> the payload's serial `sku`), and
-- `panini_fmv_snapshots_edition_id_fkey` is NO ACTION on update (`confupdtype = 'a'`) with exactly
-- one child per seed row, so the update is REJECTED and the whole 500-row chunk aborts.
-- `app/api/cron/panini-ingest/route.ts:132` only `console.log`s the error, so `ok` stays true and
-- `rows_written` silently under-counts — a failed WRITE rendering as a success. 💥 The cost is 30x
-- the three rows: ~93 edition-walk records discarded in 24 h, ~4.8% of that day's edition writes.
--
-- So this marker still selects exactly the right rows, but it means "every attempt to update this
-- row has been rejected", not "card-stats never arrived". The runner's OR is a separate, lesser
-- observability gap — real, but not this bug. R120 carries the fix order (stop swallowing the
-- error; ON UPDATE CASCADE on the FK; only then repair the 3 rows). None of that is shipped here.
--
-- ── WHY THIS DETECTOR AND NOT THE OBVIOUS ONE ─────────────────────────────────────────────────
-- The intuitive query — "editions whose newest serial capture is newer than last_seen_at" — was
-- measured and REJECTED on cost, twice, on this IO-budgeted instance:
--     group-by over panini_card_serials  : 22,095 buffers (~177 MB), 11.6 s
--     bounded LATERAL max() per edition  : 15,814 buffers, 43.8 s  (index probe + heap fetch for
--                                          captured_at, 18 rows x 790 editions, all cold)
-- This form reads panini_editions alone: **330 buffers**, no serials table, no new index on a hot
-- ingest table. ⭐ Same lesson as R115/R107 in reverse — a per-key probe is not automatically
-- cheaper when the payload column is not in the index.
--
-- ⚠ WHAT IT IS BLIND TO, stated because the marker is narrower than the class: it detects
-- "card-stats has NEVER landed". An edition that WAS card-statted and then stopped keeps its
-- serial-sku `id` and is invisible here. That case exists and is normally transient — measured
-- today, 7 editions sit 4.5-56 h behind and self-heal on the next successful walk, against the 3
-- chronic ones at 1,581 h. If a permanent instance of the "stopped" kind is ever suspected, the
-- expensive query above is the one to run, ONCE, with its cost known.
--
-- ⚠ RETURN SHAPE IS A JSONB ARRAY: read its LENGTH, never `count(*)` (which is 1 for `[]` too).
-- Clean is `[]`. Today it returns 3.
--
-- ⚠ CHECKED AND CLEAN, recorded so it is not re-chased: FMV history is NOT fragmented by the
-- serial-sku `id`. 5,074 distinct `panini_fmv_snapshots.edition_id` map to 5,074 distinct base
-- pskus, 0 surplus — the representative sku the site returns is stable per edition.
--
-- anon-exec: REVOKED — check_panini_editions_missing_card_stats is an operator instrument reading
-- a service-role table; it has no anon caller and must never acquire one. This is a NEW function
-- (not a CREATE OR REPLACE snapshot), so the revoke is correct here rather than a marker, and it
-- names all three roles because ALTER DEFAULT PRIVILEGES on this DB grants anon/authenticated rows
-- that a PUBLIC-only revoke would leave behind.
--
-- REVERT (exact): DROP FUNCTION public.check_panini_editions_missing_card_stats();

create or replace function public.check_panini_editions_missing_card_stats()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'external_id',  external_id,
        'player_name',  player_name,
        'set_name',     set_name,
        'last_seen_at', last_seen_at,
        'frozen_hours', round(extract(epoch from (now() - last_seen_at)) / 3600.0, 1)
      )
      order by last_seen_at
    ),
    '[]'::jsonb
  )
  from public.panini_editions
  where id = external_id;
$function$;

revoke execute on function public.check_panini_editions_missing_card_stats() from public, anon, authenticated;
grant  execute on function public.check_panini_editions_missing_card_stats() to service_role;

comment on function public.check_panini_editions_missing_card_stats() is
  'Panini editions that NO getCardMarketStats payload has ever written: id = external_id, because toEditionRow sets id = sku ?? psku and only a card-stats payload carries sku. Their last_seen_at AND their FMV are both frozen at first sight, and they are live on /insights/panini-squeeze with that stale price. Returns a JSONB ARRAY - read its LENGTH, not count(*). Clean is []; today it is 3. Blind to an edition that was card-statted once and then stopped (that case is normally transient). Root cause (register R120) is the upsert DO UPDATE rewriting the primary key, rejected by panini_fmv_snapshots_edition_id_fkey (NO ACTION on update), aborting the whole chunk while route.ts:132 only console.logs it; not fixed here.';

-- ── post-apply assertions ─────────────────────────────────────────────────────────────────────
do $verify$
declare
  v_result jsonb;
  v_partition_ok int;
begin
  v_result := public.check_panini_editions_missing_card_stats();

  if jsonb_typeof(v_result) <> 'array' then
    raise exception 'post-apply: expected a jsonb ARRAY, got %', jsonb_typeof(v_result);
  end if;

  -- Positive control: the detector must actually NAME the known instances, not just return a
  -- well-formed empty array. A `[]` here today would mean the marker stopped matching.
  if jsonb_array_length(v_result) <> 3 then
    raise exception 'post-apply: expected the 3 known instances, got % -- re-derive before trusting this instrument', jsonb_array_length(v_result);
  end if;

  -- The marker must remain a clean partition, or its meaning has drifted.
  select count(*) into v_partition_ok
  from public.panini_editions
  where id <> external_id
    and id !~ ('^' || replace(external_id, '.', '\.') || '__\d+_\d+$');
  if v_partition_ok <> 0 then
    raise exception 'post-apply: % rows are neither id=external_id nor a serial sku of their edition -- the marker no longer partitions cleanly', v_partition_ok;
  end if;

  -- ACL: a new function is anon-EXECUTABLE BY DEFAULT on this database.
  if has_function_privilege('anon', 'public.check_panini_editions_missing_card_stats()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.check_panini_editions_missing_card_stats()', 'EXECUTE') then
    raise exception 'post-apply: anon/authenticated can EXECUTE the instrument -- the revoke did not take';
  end if;
  if not has_function_privilege('service_role', 'public.check_panini_editions_missing_card_stats()', 'EXECUTE') then
    raise exception 'post-apply: service_role cannot EXECUTE the instrument';
  end if;
end
$verify$;
