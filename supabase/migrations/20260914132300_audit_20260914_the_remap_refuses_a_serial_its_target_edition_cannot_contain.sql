-- audit_20260914_the_remap_refuses_a_serial_its_target_edition_cannot_contain
--
-- WHY. `topshot_impossible_parallel_serials` (trust board, breach at 3) read 5 on
-- 09-11, 27-29 on 09-12 and 37 on 09-14. The register carried it as a static
-- residue of 4 awaiting a decision; it is not static, and the writer is this
-- function.
--
-- THE CHAIN, MEASURED 2026-09-14 (PT):
--   1. `wallet_moments_cache` carries a WRONG parallel `edition_key` for some
--      moments -- the wrong subedition id. Proven against the canonical
--      `moments.nft_id -> edition_id` map, which this repo already treats as
--      canonical for Top Shot:
--        nft 52670726  canonical 274:9068      (circ 149)  wmc 274:9068::22  ser 92
--        nft 52678108  canonical 274:9083      (circ 149)  wmc 274:9083::21  ser 110
--        nft 52682242  canonical 274:9073      (circ 149)  wmc 274:9073::22  ser 119
--        nft 52676459  canonical 274:9073::17  (circ  99)  wmc 274:9073::22  ser 47
--        nft 52682407  canonical 274:9080::18  (circ  50)  wmc 274:9080::22  ser 24
--      In every case the canonical edition's circulation comfortably contains the
--      serial and the wmc key's does not. So wmc is wrong and circulation is fine
--      -- which CONFIRMS #82's original conclusion ("a mis-keyed sale, not a stale
--      circulation") and now supplies the mechanism it was missing.
--   2. THIS FUNCTION copies wmc's (edition_key, serial) into `sales` VERBATIM.
--      8 of 8 sampled impossible rows matched wmc byte-for-byte on both fields.
--      Its existing guards are about AMBIGUITY (one distinct edition_key per
--      moment; no (ek, serial) pair mapping to >1 moment). Nothing checked that
--      the serial could exist in the target edition at all.
--   3. It runs as pg_cron jobid 62 `rpc-remap-misattributed-sales`, `23 star/6 * * *`.
--      The count moved 35 -> 37 between 10 PM and 5:30 AM with ZERO new sales
--      ingested in that window -- two runs, two more rows. That is what identified
--      this function rather than the ingest path.
--
-- WHAT THIS CHANGES. One predicate in `cand`. It is STRICTLY SUBTRACTIVE: it can
-- only REFUSE a re-key, never create one, so it cannot introduce a mis-key of its
-- own. The `is null` / `<= 0` escapes leave editions with unknown circulation
-- behaving exactly as before. Same guard shape the trophy path already adopted
-- ("refuse a serial that is above its own edition's circulation").
--
-- ⛔ WHAT THIS DOES NOT DO. It does not repair the 37 existing rows. That is
-- `remap_topshot_parallel_to_base_misattributed()`, which MUTATES `sales` and
-- remains Trevor's call per #82. This stops the INFLOW only. It also does not fix
-- the wrong wmc keys at the source -- that is upstream and still open.
--
-- anon-exec: unchanged — remap_misattributed_topshot_sales is ALREADY revoked in prod,
-- and this is a CREATE OR REPLACE of a pre-existing function, which does NOT reset a
-- function ACL. Verified on the live DB 2026-09-14 (PT), immediately before this edit:
--   has_function_privilege('anon', …)          = false
--   has_function_privilege('authenticated', …) = false
--   has_function_privilege('postgres', …)      = true   (the pg_cron caller, unchanged)
--
-- Live body re-read immediately before this replace (md5 6fb49e3aad5f1d067ffba7773d71bfa5,
-- length 3577). The body below, mechanically stripped of the added guard block, re-hashes
-- to that same md5 and length -- so this replace carries the live body plus exactly the
-- guard and nothing else.
--
-- REVERT: re-apply the body below with the PLAUSIBILITY GUARD block removed
--         (supabase/migrations/20260815161000_audit_20260815_snapshot_remap_misattributed_topshot_sales.sql
--          is the prior snapshot). Find this commit by MESSAGE (`git log --grep=`).

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
      -- PLAUSIBILITY GUARD (2026-09-14): never re-key a sale onto an edition whose
      -- circulation cannot contain the serial. wmc is the SOURCE of (ek, ser) here
      -- and this function copied it verbatim, so a wrong wmc subedition key became a
      -- wrong `sales` row with no check in between -- measured as 37 impossible rows,
      -- every one a byte-exact copy of wmc, all contradicted by the canonical
      -- moments -> editions map. Strictly SUBTRACTIVE: it can only REFUSE a re-key,
      -- never create one, so it cannot introduce a mis-key of its own. The null/<=0
      -- escapes keep editions with unknown circulation behaving exactly as before.
      -- Same guard shape as the trophy path (`refuse a serial that is above its own
      -- edition's circulation`).
      and (ew.circulation_count is null
           or ew.circulation_count <= 0
           or coalesce(nm.ser, 0) <= ew.circulation_count)
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
