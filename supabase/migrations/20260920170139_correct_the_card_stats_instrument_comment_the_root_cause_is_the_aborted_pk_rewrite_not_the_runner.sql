-- COMMENT-ONLY correction. 2026-09-20 ~10:2x AM PT (Claude Code cloud).
--
-- Migration 20260920165032 shipped check_panini_editions_missing_card_stats() with a comment
-- attributing the root cause to scripts/ingest-panini-runner.mjs treating a serials-only response
-- as a successful walk. A concurrent session's measurement (register R120) REFUTES that: the cards
-- do arrive. 12 of 459 panini-ingest runs in 24 h wrote `editions: 0` while serials landed, exactly
-- two per walk across five walks, start times matching the three rows' serial captured_at to a
-- tenth of a second.
--
-- The confirmed mechanism is a DB write that aborts: the upsert's DO UPDATE rewrites the PRIMARY
-- KEY (id -> the payload's serial sku) and panini_fmv_snapshots_edition_id_fkey is NO ACTION on
-- update with one child per seed row, so the update is rejected and the whole 500-row chunk aborts;
-- app/api/cron/panini-ingest/route.ts:132 only console.logs it, so ok stays true. Cost is ~93
-- discarded edition-walk records in 24 h (~4.8% of that day's edition writes), not three rows.
--
-- The function body is UNCHANGED and the marker still selects exactly the right rows; only what the
-- comment claims about WHY is corrected. Leaving it would have left a refuted cause in the one place
-- an operator reads before acting.
--
-- anon-exec: unchanged — no function is created here, only COMMENT ON. The ACL set by
-- 20260920165032 (anon/authenticated revoked, service_role granted) is asserted below.
--
-- REVERT (exact): re-apply the previous comment text from migration 20260920165032.

comment on function public.check_panini_editions_missing_card_stats() is
  'Panini editions that every ingest walk fails to update: id = external_id, because toEditionRow sets id = sku ?? psku and the DO UPDATE would rewrite the PRIMARY KEY to the payload serial sku - which panini_fmv_snapshots_edition_id_fkey (NO ACTION on update) rejects, aborting the whole chunk while route.ts:132 only console.logs it. So last_seen_at AND FMV are both frozen at first sight, and these rows are live on /insights/panini-squeeze with that stale price. Returns a JSONB ARRAY - read its LENGTH, not count(*). Clean is []; today it is 3. Blind to an edition written once and then blocked later. See register R120 for the confirmed mechanism, the ~4.8%-of-writes cost, and the fix order (stop swallowing the error; ON UPDATE CASCADE; then repair the rows).';

do $verify$
declare
  v_comment text;
begin
  select obj_description(p.oid, 'pg_proc') into v_comment
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'check_panini_editions_missing_card_stats';

  if v_comment is null then
    raise exception 'post-apply: the function has no comment -- did it get dropped?';
  end if;
  if v_comment ilike '%ingest-panini-runner%' then
    raise exception 'post-apply: the refuted runner root-cause is still in the comment';
  end if;
  if v_comment not ilike '%edition_id_fkey%' then
    raise exception 'post-apply: the confirmed FK mechanism is absent from the comment';
  end if;

  -- The body and ACL must be untouched by a comment-only change.
  if jsonb_array_length(public.check_panini_editions_missing_card_stats()) <> 3 then
    raise exception 'post-apply: the detector no longer names the 3 known instances';
  end if;
  if has_function_privilege('anon', 'public.check_panini_editions_missing_card_stats()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.check_panini_editions_missing_card_stats()', 'EXECUTE') then
    raise exception 'post-apply: anon/authenticated gained EXECUTE';
  end if;
end
$verify$;
