-- audit_20261113_candy_alias_editions_retired — 2026-11-13 ~5:10 PM PT (Claude Code cloud; #247, Trevor: "Keep going").
--
-- FINDING. #247 moves every holding / sale / listing / offer of a Candy card onto its canonical key, but the alias
-- `editions` rows stay — and every surface that lists editions from the table (get_set_editions' grid, set counts,
-- search) shows them as duplicate tiles with nothing held. 2,935 alias rows; besides the rows being moved, only 1
-- fmv_snapshots row and 14,157 candy_edition_market_daily rows reference them (measured 11-13 ~5:05 PM PT).
-- FIX.
--   1. candy_skip_alias_edition_insert(): a BEFORE INSERT trigger on editions (Candy only, WHEN clause) that skips an
--      insert whose external_id is an alias, so a writer computing the alias key (wallet refresh, editions ingest)
--      cannot re-create the row. Its holdings still land on the canonical (the wmc trigger), and the sales indexers
--      resolve an alias key through its canonical (commit 87080eea, deployed before this ran).
--   2. candy_delete_emptied_alias_editions(p_limit): deletes an alias edition that no holding, Candy sale, listing,
--      offer, wishlist, watchlist, pack pool or special-serial row names — one row per statement (the delete guard
--      is per statement), its candy_edition_market_daily and fmv_snapshots rows first; a NO ACTION reference raises
--      and is counted, never forced. Logged as pipeline 'candy-alias-editions-retired'. Cron every 15 min, 500 a run.
-- The alias URL keeps working: the edition page 308s an alias key to its canonical (lib/edition/alias-redirect.ts).
-- anon-exec: candy_skip_alias_edition_insert and candy_delete_emptied_alias_editions are NOT anon-executable.
-- Revert: drop trigger editions_candy_skip_alias_insert_trg; cron.unschedule('rpc-candy-alias-editions-retired').
--   Deleted rows are not restored (each was an empty duplicate of a card that lives on under its canonical key).

CREATE OR REPLACE FUNCTION public.candy_skip_alias_edition_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.external_id is not null
     and exists (select 1 from public.candy_edition_key_aliases a where a.alias_key = new.external_id) then
    return null;
  end if;
  return new;
end $fn$;

create trigger editions_candy_skip_alias_insert_trg
  before insert on public.editions
  for each row when (new.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
  execute function public.candy_skip_alias_edition_insert();

CREATE OR REPLACE FUNCTION public.candy_delete_emptied_alias_editions(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_candy constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_started timestamptz := clock_timestamp();
  v_candidates int := 0;
  v_deleted int := 0;
  v_referenced int := 0;
  v_daily int := 0;
  v_fmv int := 0;
  v_n int;
  r record;
begin
  for r in
    select e.id
      from public.editions e
      join public.candy_edition_key_aliases a on a.alias_key = e.external_id
     where e.collection_id = c_candy
       and not exists (select 1 from public.wallet_moments_cache w
                        where w.collection_id = c_candy and w.edition_key = e.external_id)
       and not exists (select 1 from public.sales s where s.collection_id = c_candy and s.edition_id = e.id)
       and not exists (select 1 from public.candy_listings x where x.edition_id = e.id)
       and not exists (select 1 from public.candy_offers x where x.edition_id = e.id)
       and not exists (select 1 from public.user_wishlists x where x.edition_id = e.id)
       and not exists (select 1 from public.watchlist_items x where x.edition_id = e.id)
       and not exists (select 1 from public.pack_drop_pool x where x.edition_id = e.id)
       and not exists (select 1 from public.special_serial_holders x where x.edition_id = e.id)
     order by e.id
     limit greatest(coalesce(p_limit, 500), 0)
  loop
    v_candidates := v_candidates + 1;
    begin
      delete from public.candy_edition_market_daily where edition_id = r.id;
      get diagnostics v_n = row_count;
      v_daily := v_daily + v_n;
      delete from public.fmv_snapshots where edition_id = r.id;
      get diagnostics v_n = row_count;
      v_fmv := v_fmv + v_n;
      delete from public.editions where id = r.id;
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      v_referenced := v_referenced + 1;
    end;
  end loop;

  perform public.log_pipeline_run(
    'candy-alias-editions-retired', v_started, v_candidates, v_deleted, v_referenced, true, null, 'candy_mlb', null, null,
    jsonb_build_object('candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced,
                       'market_daily_deleted', v_daily, 'fmv_deleted', v_fmv, 'limit', p_limit,
                       'alias_editions_left', (select count(*) from public.editions e
                                                 join public.candy_edition_key_aliases a on a.alias_key = e.external_id
                                                where e.collection_id = c_candy)));
  return jsonb_build_object('ok', true, 'candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced);
end $fn$;

revoke all on function public.candy_skip_alias_edition_insert() from public, anon, authenticated;
revoke all on function public.candy_delete_emptied_alias_editions(integer) from public, anon, authenticated;

select cron.schedule('rpc-candy-alias-editions-retired', '7,22,37,52 * * * *',
                     'SELECT public.candy_delete_emptied_alias_editions(500)');
