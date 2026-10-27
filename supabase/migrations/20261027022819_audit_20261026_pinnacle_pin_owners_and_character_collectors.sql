-- audit_20261026_pinnacle_pin_owners_and_character_collectors
--
-- Disney Pinnacle ↔ Top Shot parity, pass 2 (Cowork, 2026-10-26 evening PT; Trevor: "Keep going").
-- Top Shot shows Top Owners on an edition page and Top Collectors on a player page; Pinnacle had
-- neither, because the wallet cache holds only RPC-tracked wallets (2.7 % of minted copies).
--
-- THE SOURCE. Every Pinnacle mint since the spork floor (2025-12-29) is in pinnacle_mint_events
-- with its render_id (524k NFTs), and pinnacle_ownership_snapshots is a latest-owner map (485k
-- NFTs). Measured 2026-10-26 ~7:40 PM PT:
--   * 948 renders have mint events for >= 95 % of total_minted AND an owner for >= 95 % of those.
--   * The snapshot owner agrees with the latest sale's buyer on 93.8 % of NFTs sold in 30 days
--     (7,326 / 7,810). Every disagreement sampled was the snapshot lagging (owner = a holder
--     before the seller), so the current owner here is the latest sale's buyer when that sale is
--     newer than the snapshot, else the snapshot owner.
--   * System accounts in flowty_excluded_addresses (Pinnacle's custodian 0xedf9df96c92f4595 —
--     82k copies, unsold/undistributed stock — and the NFTLocker 0xb6f2481eba4df97b, 7.9k locked
--     copies whose depositor this map cannot see) are flagged is_system: they count toward
--     coverage (the copies exist) but are never shown as collectors.
--
-- OBJECTS
--   mv_pinnacle_render_owners (render_id, owner, copies, is_system) — 186,890 rows, built in ~4 s
--     (all buffer hits); refreshed every 3 h by refresh_pinnacle_render_owners() (pipeline
--     pinnacle-render-owners, ok=false on 0 rows) via pg_cron rpc-pinnacle-render-owners.
--   get_pinnacle_pin_top_owners(render_id, limit) — the pin page's Top Owners, with the coverage
--     the page gates on (seen copies vs total_minted).
--   get_pinnacle_character_top_collectors(character_name, limit) — the character page's Top
--     Collectors, ranked by FMV held (catalog fmv_usd x copies), over the same render set
--     get_player_detail uses for a character (the `characters` trait, never character_name).
--
-- anon-exec: revoked (refresh_pinnacle_render_owners) — new maintenance fn; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: revoked (get_pinnacle_pin_top_owners) — new read fn, service_role only (the page reads it server-side); REVOKE below.
-- anon-exec: revoked (get_pinnacle_character_top_collectors) — new read fn, service_role only; REVOKE below.
--
-- REVERT:
--   select cron.unschedule('rpc-pinnacle-render-owners');
--   drop function public.get_pinnacle_character_top_collectors(text, integer);
--   drop function public.get_pinnacle_pin_top_owners(text, integer);
--   drop function public.refresh_pinnacle_render_owners();
--   drop materialized view public.mv_pinnacle_render_owners;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_pinnacle_render_owners AS
WITH cur AS (
  SELECT me.render_id,
         lower(CASE WHEN ls.sold_at > os.observed_at THEN ls.buyer_address ELSE os.owner END) AS owner
    FROM public.pinnacle_mint_events me
    JOIN public.pinnacle_ownership_snapshots os ON os.nft_id = me.nft_id
    LEFT JOIN LATERAL (
      SELECT s.buyer_address, s.sold_at
        FROM public.pinnacle_sales s
       WHERE s.nft_id = me.nft_id AND s.buyer_address IS NOT NULL
       ORDER BY s.sold_at DESC
       LIMIT 1
    ) ls ON true
   WHERE me.render_id IS NOT NULL
)
SELECT cur.render_id,
       cur.owner,
       count(*)::int AS copies,
       EXISTS (SELECT 1 FROM public.flowty_excluded_addresses x WHERE lower(x.address) = cur.owner) AS is_system
  FROM cur
 WHERE cur.owner IS NOT NULL
 GROUP BY cur.render_id, cur.owner
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_pinnacle_render_owners_key
  ON public.mv_pinnacle_render_owners (render_id, owner);

REVOKE ALL ON public.mv_pinnacle_render_owners FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_pinnacle_render_owners TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_pinnacle_render_owners IS
  'Disney Pinnacle: current owner counts per render (pin), for mints since the spork floor (pinnacle_mint_events) — owner = latest sale buyer when newer than the ownership snapshot, else the snapshot owner. is_system = flowty_excluded_addresses (custodian stock, NFTLocker). Refreshed every 3 h (refresh_pinnacle_render_owners). 2026-10-26.';

CREATE OR REPLACE FUNCTION public.refresh_pinnacle_render_owners()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  IF (SELECT relispopulated FROM pg_class WHERE oid = 'public.mv_pinnacle_render_owners'::regclass) THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pinnacle_render_owners;
  ELSE
    REFRESH MATERIALIZED VIEW public.mv_pinnacle_render_owners;
  END IF;
  SELECT count(*) INTO v_rows FROM public.mv_pinnacle_render_owners;
  PERFORM public.log_pipeline_run('pinnacle-render-owners', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refresh produced no rows' END,
    'disney_pinnacle', NULL, NULL, jsonb_build_object('source', 'audit_20261026'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('pinnacle-render-owners', v_started, 0, 0, 0, false, SQLERRM,
    'disney_pinnacle', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_pinnacle_render_owners() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_pinnacle_render_owners() TO postgres, service_role;

-- Top Owners of one pin. `seen_copies` (system included) over `total_minted` is the coverage the
-- page gates on; `holders` and the rows exclude system accounts. NULL when the pin is unknown.
CREATE OR REPLACE FUNCTION public.get_pinnacle_pin_top_owners(p_render_id text, p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  WITH pin AS (
    SELECT pc.render_id, pc.total_minted FROM public.pinnacle_catalog pc WHERE pc.render_id = p_render_id
  ), o AS (
    SELECT m.owner, m.copies, m.is_system FROM public.mv_pinnacle_render_owners m WHERE m.render_id = p_render_id
  ), top AS (
    SELECT o.owner, o.copies FROM o WHERE NOT o.is_system
     ORDER BY o.copies DESC, o.owner
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pin) THEN NULL ELSE jsonb_build_object(
    'total_minted', (SELECT total_minted FROM pin),
    'seen_copies', COALESCE((SELECT sum(copies) FROM o), 0),
    'system_copies', COALESCE((SELECT sum(copies) FROM o WHERE is_system), 0),
    'holders', (SELECT count(*) FROM o WHERE NOT is_system),
    'owners', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('wallet', t.owner, 'username', wu.username, 'copies', t.copies)
                       ORDER BY t.copies DESC, t.owner)
        FROM top t LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = t.owner), '[]'::jsonb)
  ) END
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_pinnacle_pin_top_owners(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_pin_top_owners(text, integer) TO postgres, service_role;

-- Top Collectors of one character, ranked by the FMV of that character's pins held. Coverage =
-- seen copies of the character's renders over their total_minted (renders with no mint events —
-- pre-spork — count in the denominator, so an old character reads LOW coverage, never a full list).
CREATE OR REPLACE FUNCTION public.get_pinnacle_character_top_collectors(p_character text, p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  WITH r AS (
    SELECT pc.render_id, pc.total_minted, CASE WHEN pc.fmv_usd > 0 THEN pc.fmv_usd END AS fmv
      FROM public.pinnacle_catalog pc
     WHERE EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(p_character)))
        OR (cardinality(pc.characters) > 1
            AND lower(btrim(p_character)) IN (lower(array_to_string(pc.characters, ' & ')),
                                              lower(array_to_string(pc.characters, ' '))))
  ), o AS (
    SELECT m.owner, m.copies, m.is_system, r.fmv, m.render_id
      FROM public.mv_pinnacle_render_owners m JOIN r ON r.render_id = m.render_id
  ), agg AS (
    SELECT o.owner, sum(o.copies)::int AS copies, count(DISTINCT o.render_id)::int AS pins,
           round(sum(o.copies * o.fmv), 2) AS fmv_held_usd
      FROM o WHERE NOT o.is_system GROUP BY o.owner
  ), top AS (
    SELECT * FROM agg ORDER BY fmv_held_usd DESC NULLS LAST, copies DESC, owner
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM r) THEN NULL ELSE jsonb_build_object(
    'renders', (SELECT count(*) FROM r),
    'total_minted', (SELECT sum(total_minted) FROM r),
    'seen_copies', COALESCE((SELECT sum(copies) FROM o), 0),
    'holders', (SELECT count(*) FROM agg),
    'collectors', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('wallet', t.owner, 'username', wu.username, 'copies', t.copies,
                                          'pins', t.pins, 'fmv_held_usd', t.fmv_held_usd)
                       ORDER BY t.fmv_held_usd DESC NULLS LAST, t.copies DESC, t.owner)
        FROM top t LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = t.owner), '[]'::jsonb)
  ) END
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_pinnacle_character_top_collectors(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_character_top_collectors(text, integer) TO postgres, service_role;

-- Every 3 h at :04 on the hours the pack-pulls refresh skips (2:04, 5:04 … UTC; minute 4 is quiet).
SELECT cron.schedule('rpc-pinnacle-render-owners', '4 2-23/3 * * *',
  $$select public.refresh_pinnacle_render_owners()$$);
