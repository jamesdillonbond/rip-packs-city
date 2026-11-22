-- audit_20261122_portfolio_snapshot_pack_value_backfill
--
-- Trevor 2026-11-22 ~3:09 PM PT: "We should have ufc, along with backfilled fmv data"
-- (on the stacked Value / 30D chart, whose sealed-pack band started on 11-22 because
-- pack values were only recorded from that night — 20261122023120).
--
-- Fills portfolio_snapshots.pack_low_ask_usd / pack_held_count / pack_listed_count for
-- PAST nights (NULL rows in the last p_days, today excluded — the nightly fill owns today),
-- reconstructed per owner:
--   * held on night D = packs whose acquisition (bought / minted-to / first event) is at or
--     before that row's created_at (the snapshot moment, ~11:01 PM PT) and whose departure
--     (ripped / sold / last event of a non-held row) is after it — every row of
--     get_wallet_pack_history across the owner's saved Flow wallets, all statuses.
--   * ask = that night's lowest ask from pack_ask_hourly_low (last bucket in the 24 h before
--     the snapshot) — basis 'hourly_ask'. pack_ask_hourly_low starts 2026-11-15 4 PM PT;
--     for earlier nights the drop's EARLIEST observed hourly ask is carried back — basis
--     'carried_back_ask' (an estimate; measured 2026-11-22 on the largest wallet: a week of
--     ask drift moved its pack total 1.6 % net, 2.3 % gross).
--   * cap = the live rule (v33, "Cap by references"): LEAST(ask, 3 x GREATEST(last secondary
--     sale at or before the night, rip EV at or before the night, opened average)); a pack
--     with an ask and no reference is not valued, as live.
-- Control (2026-11-22, largest wallet, night of 11-22): reconstructed $16,483.71 / 483 held
-- vs measured $16,396.57 / 488 held (0.5 %).
--
-- NULL stays NULL where an owner's history read fails (never a partial sum).
-- pack_value_basis: NULL = measured live by the nightly fill; else how a backfill got it.
--
-- Revert:
--   UPDATE public.portfolio_snapshots SET pack_low_ask_usd = NULL, pack_held_count = NULL,
--     pack_listed_count = NULL WHERE pack_value_basis IS NOT NULL;
--   ALTER TABLE public.portfolio_snapshots DROP COLUMN pack_value_basis;
--   DROP PROCEDURE public.backfill_portfolio_snapshot_pack_values(integer, integer);
--   DROP FUNCTION public.portfolio_owner_pack_rows(text);

ALTER TABLE public.portfolio_snapshots
  ADD COLUMN IF NOT EXISTS pack_value_basis text;

COMMENT ON COLUMN public.portfolio_snapshots.pack_value_basis IS
  'NULL = pack_low_ask_usd measured live by fill_portfolio_snapshot_pack_values(). hourly_ask / carried_back_ask = reconstructed by backfill_portfolio_snapshot_pack_values() (2026-11-22) from that night''s (or the earliest observed) lowest ask.';

-- Every pack row (all statuses) across one owner's saved Flow wallets, with the times
-- that decide whether it was held at a given moment. NULL on ANY failed wallet read.
CREATE OR REPLACE FUNCTION public.portfolio_owner_pack_rows(p_owner_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  w text;
  j jsonb;
  v_off integer;
  v_total integer;
  v_out jsonb := '[]'::jsonb;
BEGIN
  FOR w IN
    SELECT DISTINCT lower(sw.wallet_addr)
    FROM saved_wallets sw
    WHERE sw.user_id::text = p_owner_key
      AND sw.wallet_addr ~* '^0x[0-9a-f]{16}$'
  LOOP
    v_off := 0;
    LOOP
      BEGIN
        j := public.get_wallet_pack_history(w, NULL, NULL, 200, v_off);
      EXCEPTION WHEN OTHERS THEN  -- when-others-timeout-blind: intentional — a timeout kill should end the run; any other error is this owner's failed read
        RETURN NULL;
      END;
      IF j IS NULL OR j ? 'error' THEN
        RETURN NULL;
      END IF;
      v_total := COALESCE((j->>'total_count')::int, 0);
      v_out := v_out || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'cid',  x->>'collection_id',
          'slug', replace(x->>'collection_slug', '_', '-'),
          'dist', x->>'dist_id',
          'acq',  COALESCE(x->>'bought_at', x->>'minted_to_wallet_at', x->>'first_event_at'),
          'dep',  COALESCE(x->>'ripped_at', x->>'sold_at',
                           CASE WHEN x->>'status' <> 'held' THEN x->>'latest_event_at' END)))
        FROM jsonb_array_elements(j->'packs') x), '[]'::jsonb);
      v_off := v_off + 200;
      EXIT WHEN v_off >= v_total OR jsonb_array_length(COALESCE(j->'packs', '[]'::jsonb)) = 0;
    END LOOP;
  END LOOP;
  RETURN v_out;
END
$fn$;

-- anon-exec: revoked (portfolio_owner_pack_rows) — new function; reads any owner's pack history, service-only.
REVOKE ALL ON FUNCTION public.portfolio_owner_pack_rows(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portfolio_owner_pack_rows(text) TO postgres, service_role;

-- One owner per transaction (COMMIT each), soft budget; owners left over are picked up by
-- the next call. No SET clause and no EXCEPTION block: both break COMMIT in a procedure.
CREATE OR REPLACE PROCEDURE public.backfill_portfolio_snapshot_pack_values(
  p_days integer DEFAULT 30, p_budget_seconds integer DEFAULT 240)
LANGUAGE plpgsql
AS $pr$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_owner text;
  v_rows jsonb;
  v_done integer := 0;
  v_failed integer := 0;
  v_left integer := 0;
  v_hourly_from timestamptz;
BEGIN
  SELECT min(hour_bucket) INTO v_hourly_from FROM public.pack_ask_hourly_low;

  FOR v_owner IN
    SELECT ps.owner_key
    FROM public.portfolio_snapshots ps
    WHERE ps.snapshot_date >= CURRENT_DATE - p_days
      AND ps.snapshot_date < CURRENT_DATE
      AND ps.pack_low_ask_usd IS NULL
    GROUP BY ps.owner_key
    ORDER BY ps.owner_key
  LOOP
    IF clock_timestamp() - v_started > make_interval(secs => p_budget_seconds) THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    v_rows := public.portfolio_owner_pack_rows(v_owner);
    IF v_rows IS NULL THEN
      v_failed := v_failed + 1;
      COMMIT;
      CONTINUE;
    END IF;

    WITH pk AS (
      SELECT (x->>'cid')::uuid AS cid, x->>'slug' AS slug, x->>'dist' AS dist,
             (x->>'acq')::timestamptz AS acq, (x->>'dep')::timestamptz AS dep
      FROM jsonb_array_elements(v_rows) x
    ),
    nights AS (
      SELECT ps.id, ps.created_at AS t
      FROM public.portfolio_snapshots ps
      WHERE ps.owner_key = v_owner
        AND ps.snapshot_date >= CURRENT_DATE - p_days
        AND ps.snapshot_date < CURRENT_DATE
        AND ps.pack_low_ask_usd IS NULL
    ),
    held AS (
      SELECT n.id, n.t, pk.cid, pk.slug, pk.dist, count(*)::int AS cnt
      FROM nights n
      JOIN pk ON pk.acq IS NOT NULL AND pk.acq <= n.t AND (pk.dep IS NULL OR pk.dep > n.t)
      GROUP BY 1, 2, 3, 4, 5
    ),
    valued AS (
      SELECT h.id, h.cnt, h.dist,
        CASE WHEN h.t >= v_hourly_from THEN a_then.low_ask ELSE a_first.low_ask END AS ask,
        GREATEST(ls.sale_price, ev.gross_ev, obs.avg_value_usd) AS ref
      FROM held h
      LEFT JOIN LATERAL (
        SELECT a.low_ask FROM public.pack_ask_hourly_low a
        WHERE h.t >= v_hourly_from AND h.dist IS NOT NULL
          AND a.collection_slug = h.slug AND a.dist_id = h.dist
          AND a.hour_bucket <= h.t AND a.hour_bucket > h.t - interval '24 hours'
        ORDER BY a.hour_bucket DESC LIMIT 1) a_then ON true
      LEFT JOIN LATERAL (
        SELECT a.low_ask FROM public.pack_ask_hourly_low a
        WHERE h.t < v_hourly_from AND h.dist IS NOT NULL
          AND a.collection_slug = h.slug AND a.dist_id = h.dist
        ORDER BY a.hour_bucket ASC LIMIT 1) a_first ON true
      LEFT JOIN LATERAL (
        SELECT pp.sale_price FROM public.pack_purchases pp
        WHERE h.dist IS NOT NULL AND pp.pack_dist_id = h.dist AND pp.collection_id = h.cid
          AND pp.event_kind = 'secondary_sale' AND pp.sale_price IS NOT NULL AND pp.sealed_at <= h.t
        ORDER BY pp.sealed_at DESC LIMIT 1) ls ON true
      LEFT JOIN LATERAL (
        SELECT e.gross_ev FROM public.pack_ev_history e
        WHERE h.dist IS NOT NULL AND e.collection_id = h.cid AND e.dist_id = h.dist
          AND e.snapshotted_at <= h.t
          AND NOT (e.gross_ev = 0 AND e.edition_count = 0)
          AND (e.fmv_coverage_pct IS NULL OR e.fmv_coverage_pct >= 25)
        ORDER BY e.snapshotted_at DESC LIMIT 1) ev ON true
      LEFT JOIN public.pack_observed_values obs
        ON obs.dist_id = h.dist AND obs.collection_id = h.cid AND obs.n_valued >= 5
    ),
    per_night AS (
      SELECT n.id, n.t,
        COALESCE(sum(v.cnt), 0)::int AS held_n,
        COALESCE(sum(v.cnt) FILTER (WHERE v.ask IS NOT NULL AND v.ref IS NOT NULL), 0)::int AS listed_n,
        round(COALESCE(sum(v.cnt * LEAST(v.ask, 3 * v.ref)) FILTER (WHERE v.ask IS NOT NULL AND v.ref IS NOT NULL), 0), 2) AS low_usd
      FROM nights n
      LEFT JOIN valued v ON v.id = n.id
      GROUP BY n.id, n.t
    )
    UPDATE public.portfolio_snapshots ps
       SET pack_low_ask_usd  = pn.low_usd,
           pack_held_count   = pn.held_n,
           pack_listed_count = pn.listed_n,
           pack_value_basis  = CASE WHEN pn.t >= v_hourly_from THEN 'hourly_ask' ELSE 'carried_back_ask' END
      FROM per_night pn
     WHERE ps.id = pn.id AND ps.pack_low_ask_usd IS NULL;

    v_done := v_done + 1;
    COMMIT;
  END LOOP;

  PERFORM public.log_pipeline_run('portfolio-snapshot-packs-backfill', v_started, v_done + v_failed + v_left,
    v_done, v_failed, v_failed = 0 AND v_left = 0, NULL, NULL, NULL, NULL,
    jsonb_build_object('owners_filled', v_done, 'owners_failed', v_failed, 'over_budget', v_left,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  COMMIT;
END
$pr$;

REVOKE ALL ON PROCEDURE public.backfill_portfolio_snapshot_pack_values(integer, integer) FROM PUBLIC, anon, authenticated;
