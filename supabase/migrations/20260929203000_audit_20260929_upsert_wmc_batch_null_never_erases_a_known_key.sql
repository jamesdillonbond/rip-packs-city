-- 2026-09-29: upsert_wmc_batch — a NULL edition_key / serial_number no longer ERASES a known one.
--
-- The ON CONFLICT set `edition_key = excluded.edition_key` and `serial_number = excluded.serial_number`
-- unconditionally, so a caller that did not know a moment's key or serial wrote NULL over the cached
-- value. Two live callers do exactly that:
--   · /api/wallet-cache — the collection page posts /api/wallet-search's live rows back to the cache.
--     A degraded row (Top Shot GraphQL has answered 530 since 09-13; every All Day row from that route
--     is degraded) carries editionKey null + serial null, so each page load could wipe the key and
--     serial of up to 50 cached rows.
--   · runIdOnlyBackfill (lib/chains/flow/wallet-backfill-helpers.ts) — the id-only runner for the
--     non-Top-Shot collections sends edition_key null by design.
-- The Top Shot wallet-search writer already split resolved/unresolved rows for this reason; this moves
-- the rule into the one writer every caller shares. An INSERT is unchanged: a held moment whose key is
-- not known yet still lands (NULL), so no holding is dropped.
-- Pinned: supabase/tests/upsert_wmc_batch.sql (new assertions for both NULL columns, both directions).
--
-- anon-exec: unchanged (upsert_wmc_batch) — CREATE OR REPLACE of an existing fn; ACL preserved; verified 2026-09-29 via has_function_privilege: anon=false, authenticated=false, service_role=true.
--
-- Revert: re-apply the body from 20260904062632_audit_20260904_upsert_wmc_batch_keys_a_resolved_parallel_at_write_time_and_a_oneshot_rekeys_the_67k_base_keyed_rows.sql
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
      -- Top Shot only: a base setID:playID key whose nft is on-chain-resolved to a parallel
      -- (topshot_moment_subeditions.subedition_id > 0) and whose base::N edition exists is
      -- written as base::N. Unresolved, Standard (0), or not-yet-cataloged → the key as sent.
      case
        when r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         and r.edition_key ~ '^[0-9]+:[0-9]+$'
        then coalesce(
          (select sub.base_external_id || '::' || sub.subedition_id::text
             from public.topshot_moment_subeditions sub
            where sub.nft_id = r.moment_id
              and sub.base_external_id = r.edition_key
              and coalesce(sub.subedition_id, 0) > 0
              and exists (select 1 from public.editions e
                           where e.collection_id = r.collection_id
                             and e.external_id = sub.base_external_id || '::' || sub.subedition_id::text)),
          r.edition_key)
        else r.edition_key
      end as edition_key,
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
      -- A NULL edition_key / serial_number means THIS CALLER DOES NOT KNOW IT, never "clear it".
      -- Writing it through erased a known key: /api/wallet-cache posts the collection page's live
      -- rows, and a degraded row (no key, no serial) wiped the cached key and serial (2026-09-29).
      set edition_key   = coalesce(excluded.edition_key, w.edition_key),
          serial_number = coalesce(excluded.serial_number, w.serial_number),
          last_seen_at  = excluded.last_seen_at
      where w.edition_key   is distinct from coalesce(excluded.edition_key, w.edition_key)
         or w.serial_number is distinct from coalesce(excluded.serial_number, w.serial_number)
         or w.last_seen_at  < now() - interval '24 hours'
    returning 1
  )
  select count(*)::int into v_written from upserted;

  return jsonb_build_object('total', v_total, 'written', coalesce(v_written, 0));
end;
$function$;
