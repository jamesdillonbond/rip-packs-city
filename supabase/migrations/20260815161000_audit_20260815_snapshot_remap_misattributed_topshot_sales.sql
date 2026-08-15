-- Snapshot migration: public.remap_misattributed_topshot_sales().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-15) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical), so
-- it is committed UNAPPLIED — every apply_migration costs a ~10-20s burst of
-- user-facing PGRST002 500s and this one would buy nothing.
--
-- The TopShot sales re-keying sweep: re-points a sale onto the edition its
-- moment actually belongs to, per wallet_moments_cache. It is the widest-blast
-- member of the conflation family — it rewrites BOTH edition_id and
-- serial_number on `sales`, and every edition-keyed FMV is derived from those.
--
-- Three properties carry the whole design and none of them is obvious:
--
--   • ROTATION. The sweep never scans all of `sales`. It always covers a fresh
--     4-day window, plus ONE rotating 2-day slice chosen by a cursor in
--     remap_sweep_state (14 slices → 32 days of coverage). The cursor advance is
--     the first statement, so a run that later throws still advances — that is
--     deliberate, it stops a poison slice wedging the rotation forever.
--   • AMBIGUITY IS DROPPED, NOT GUESSED. nft_map keeps a moment only when its wmc
--     rows agree on edition_key (`having count(distinct edition_key) = 1`).
--     Without it a moment with conflicting cache rows would be re-keyed on every
--     run, oscillating between editions and rewriting sale history each time.
--   • SERIAL COLLISIONS ARE DROPPED. dup_pairs removes any (edition_key, serial)
--     that maps to more than one moment. Re-keying those would attribute a sale
--     to a serial that is not uniquely identified.
--
-- Pinned by supabase/tests/remap_misattributed_topshot_sales.sql.

CREATE OR REPLACE FUNCTION public.remap_misattributed_topshot_sales()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  n integer;
  v_t_start    timestamptz := now();   -- captured BEFORE the scan
  v_slice      integer;
  v_fresh_from timestamptz;
  v_slice_from timestamptz;
  v_slice_to   timestamptz;
  c_fresh_days constant integer := 4;
  c_slice_days constant integer := 2;
  c_slices     constant integer := 14;  -- 4 + 14*2 = 32 days total coverage
begin
  -- claim this run's slice and advance the rotation cursor
  update public.remap_sweep_state
     set slice_no      = (slice_no + 1) % c_slices,
         last_run_at   = v_t_start,
         last_cycle_at = case when (slice_no + 1) % c_slices = 0
                              then v_t_start else last_cycle_at end
   returning slice_no into v_slice;

  v_slice := coalesce(v_slice, 0);

  v_fresh_from := v_t_start - make_interval(days => c_fresh_days);
  v_slice_from := v_t_start - make_interval(days => c_fresh_days + (v_slice + 1) * c_slice_days);
  v_slice_to   := v_t_start - make_interval(days => c_fresh_days + v_slice * c_slice_days);

  with win_sales as (
    -- always-fresh window
    select s.id as sale_id, s.nft_id, s.edition_id, s.sold_at
    from sales s
    where s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and s.nft_id is not null
      and s.sold_at >= v_fresh_from
    union all
    -- one rotating older slice (disjoint from the fresh window)
    select s.id as sale_id, s.nft_id, s.edition_id, s.sold_at
    from sales s
    where s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and s.nft_id is not null
      and s.sold_at >= v_slice_from and s.sold_at < v_slice_to
  ),
  -- one canonical (edition_key, serial) per moment, ONLY when wmc rows agree on
  -- edition_key (count distinct = 1). Ambiguous moments are dropped here so they
  -- never oscillate.
  nft_map as (
    select w.moment_id, min(w.edition_key) as ek, min(w.serial_number) as ser
    from wallet_moments_cache w
    join (select distinct nft_id from win_sales) ws on ws.nft_id = w.moment_id
    where w.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
      and w.edition_key ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    group by w.moment_id
    having count(distinct w.edition_key) = 1
  ),
  cand as materialized (
    select ws.sale_id, ws.sold_at, ew.id as new_ed, nm.ser as new_ser, nm.ek, nm.ser as ser
    from win_sales ws
    join nft_map nm on nm.moment_id = ws.nft_id
    join editions ew on ew.external_id = nm.ek and ew.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    where ew.id <> ws.edition_id
  ),
  cand_pairs as (select distinct ek, ser from cand),
  -- serial-collision guard scoped to candidate pairs (indexed, not a full scan):
  -- a (edition_key, serial) that maps to >1 moment is ambiguous — never re-key it.
  dup_pairs as materialized (
    select w2.edition_key, w2.serial_number
    from wallet_moments_cache w2
    join cand_pairs cp on cp.ek = w2.edition_key and cp.ser = w2.serial_number
    where w2.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    group by w2.edition_key, w2.serial_number
    having count(distinct w2.moment_id) > 1
  )
  update sales s
  set edition_id = c.new_ed,
      serial_number = coalesce(c.new_ser, s.serial_number)
  from cand c
  left join dup_pairs d on d.edition_key=c.ek and d.serial_number=c.ser
  where s.id=c.sale_id and s.sold_at = c.sold_at and d.edition_key is null;
  get diagnostics n = row_count;
  return n;
end$function$;
