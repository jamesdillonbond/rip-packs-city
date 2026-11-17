-- audit_20260812_snapshot_upsert_wmc_batch
--
-- SNAPSHOT migration — commits the VERBATIM live definition of
-- public.upsert_wmc_batch(jsonb) so it becomes PINNABLE by the DB-invariant
-- layer. Applied via the Supabase MCP with no committed DDL, so the drift guard
-- had no comparison target.
--
-- Byte-identical to live `pg_get_functiondef` as of 2026-08-12 — applying it is
-- a NO-OP.
--
-- Why it is worth pinning: this is the batch write path into
-- wallet_moments_cache, the platform's largest table (~2.2M rows) and the
-- substrate for wallet portfolios, /share, the Set Tracker and every wallet
-- rollup. Two behaviours in here are load-bearing and easy to "simplify" away:
--
--   1. The conditional `DO UPDATE ... WHERE` clause. A row whose edition_key,
--      serial_number and freshness are all unchanged is deliberately NOT
--      rewritten. Dropping that predicate turns every wallet re-walk into a
--      full rewrite of the wallet's rows, which on a 2.2M-row table means
--      sustained HOT-update and index churn on an instance already documented
--      as disk-IO-bound. The guard is a cost control, not a style choice.
--   2. The 24-hour clause (`w.last_seen_at < now() - interval '24 hours'`) is
--      what still refreshes the freshness stamp for an otherwise-identical row,
--      so "unchanged" never means "never touched again". Removing it would
--      freeze last_seen_at and make staleness checks read wrong.
--
-- Revert: none needed (no-op snapshot).

CREATE OR REPLACE FUNCTION public.upsert_wmc_batch(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_total   int;
  v_written int;
begin
  v_total := coalesce(jsonb_array_length(p_rows), 0);
  if v_total = 0 then
    return jsonb_build_object('total', 0, 'written', 0);
  end if;

  with input as (
    select
      r.wallet_address,
      r.collection_id,
      r.moment_id,
      r.edition_key,
      r.serial_number,
      r.last_seen_at
    from jsonb_to_recordset(p_rows) as r(
      wallet_address text,
      collection_id  uuid,
      moment_id      text,
      edition_key    text,
      serial_number  integer,
      last_seen_at   timestamptz
    )
  ),
  upserted as (
    insert into public.wallet_moments_cache as w (
      wallet_address, collection_id, moment_id,
      edition_key, serial_number, last_seen_at
    )
    select
      wallet_address, collection_id, moment_id,
      edition_key, serial_number, coalesce(last_seen_at, now())
    from input
    on conflict (wallet_address, collection_id, moment_id) do update
      set edition_key   = excluded.edition_key,
          serial_number = excluded.serial_number,
          last_seen_at  = excluded.last_seen_at
      where w.edition_key   is distinct from excluded.edition_key
         or w.serial_number is distinct from excluded.serial_number
         or w.last_seen_at  < now() - interval '24 hours'
    returning 1
  )
  select count(*)::int into v_written from upserted;

  return jsonb_build_object('total', v_total, 'written', coalesce(v_written, 0));
end;
$function$;
