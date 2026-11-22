-- audit_20261122_portfolio_owner_pack_rows_windowed
--
-- Follow-up to 20261122231506 / 20261122232415 (same afternoon). Job 917's first run stalled
-- 8+ minutes on ONE owner: get_wallet_pack_history pages 200 rows and re-runs the wallet's whole
-- classification per page (~19 s a page on the largest rip wallet, ~15.6k rips — ~25 min to page
-- it all). The backfill only needs (a) every pack HELD now and (b) packs that LEFT during the
-- window. So the reader now pages status 'held' (all of it — held packs can have old events),
-- then pages every status newest-event-first (the function orders by latest_event_at DESC) and
-- STOPS once a page reaches events older than p_since: a non-held pack's departure is its
-- latest event, so anything older left before the window. Rows are de-duplicated by
-- collection + pack id.
--
-- Revert: re-apply 20261122231506 (one-argument reader) and 20261122232415 (step function).

DROP PROCEDURE IF EXISTS public.backfill_portfolio_snapshot_pack_values(integer, integer);
DROP FUNCTION IF EXISTS public.portfolio_owner_pack_rows(text);

CREATE OR REPLACE FUNCTION public.portfolio_owner_pack_rows(p_owner_key text, p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  w text;
  j jsonb;
  v_pass text;
  v_off integer;
  v_total integer;
  v_n integer;
  v_oldest timestamptz;
  v_out jsonb := '[]'::jsonb;
BEGIN
  FOR w IN
    SELECT DISTINCT lower(sw.wallet_addr)
    FROM saved_wallets sw
    WHERE sw.user_id::text = p_owner_key
      AND sw.wallet_addr ~* '^0x[0-9a-f]{16}$'
  LOOP
    FOREACH v_pass IN ARRAY ARRAY['held', 'recent'] LOOP
      v_off := 0;
      LOOP
        BEGIN
          j := public.get_wallet_pack_history(w, NULL, CASE WHEN v_pass = 'held' THEN 'held' END, 200, v_off);
        EXCEPTION WHEN OTHERS THEN  -- when-others-timeout-blind: intentional — a timeout kill should end the run; any other error is this owner's failed read
          RETURN NULL;
        END;
        IF j IS NULL OR j ? 'error' THEN
          RETURN NULL;
        END IF;
        v_total := COALESCE((j->>'total_count')::int, 0);
        v_n := jsonb_array_length(COALESCE(j->'packs', '[]'::jsonb));
        v_out := v_out || COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'key',  (x->>'collection_id') || ':' || (x->>'pack_nft_id'),
            'cid',  x->>'collection_id',
            'slug', replace(x->>'collection_slug', '_', '-'),
            'dist', x->>'dist_id',
            'acq',  COALESCE(x->>'bought_at', x->>'minted_to_wallet_at', x->>'first_event_at'),
            'dep',  COALESCE(x->>'ripped_at', x->>'sold_at',
                             CASE WHEN x->>'status' <> 'held' THEN x->>'latest_event_at' END)))
          FROM jsonb_array_elements(j->'packs') x), '[]'::jsonb);
        v_off := v_off + 200;
        EXIT WHEN v_n = 0 OR v_off >= v_total;
        IF v_pass = 'recent' THEN
          SELECT min((x->>'latest_event_at')::timestamptz) INTO v_oldest
          FROM jsonb_array_elements(j->'packs') x;
          EXIT WHEN v_oldest IS NOT NULL AND v_oldest < p_since;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  -- one row per pack
  RETURN COALESCE((
    SELECT jsonb_agg(r) FROM (
      SELECT DISTINCT ON (x->>'key') x AS r
      FROM jsonb_array_elements(v_out) x
      ORDER BY x->>'key') d), '[]'::jsonb);
END
$fn$;

-- anon-exec: revoked (portfolio_owner_pack_rows) — new signature; reads any owner's pack history, service-only.
REVOKE ALL ON FUNCTION public.portfolio_owner_pack_rows(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portfolio_owner_pack_rows(text, timestamptz) TO postgres, service_role;

-- The step function now calls the windowed reader (window start minus 2 days of slack).
CREATE OR REPLACE FUNCTION public.backfill_portfolio_snapshot_pack_values_step(
  p_days integer DEFAULT 30, p_budget_seconds integer DEFAULT 300)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
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
      AND ps.pack_value_basis IS NULL
    GROUP BY ps.owner_key
    ORDER BY ps.owner_key
  LOOP
    IF clock_timestamp() - v_started > make_interval(secs => p_budget_seconds) THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    v_rows := public.portfolio_owner_pack_rows(v_owner, (CURRENT_DATE - p_days)::timestamptz - interval '2 days');
    IF v_rows IS NULL THEN
      UPDATE public.portfolio_snapshots ps
         SET pack_value_basis = 'backfill_failed'
       WHERE ps.owner_key = v_owner
         AND ps.snapshot_date >= CURRENT_DATE - p_days
         AND ps.snapshot_date < CURRENT_DATE
         AND ps.pack_low_ask_usd IS NULL;
      v_failed := v_failed + 1;
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
  END LOOP;

  PERFORM public.log_pipeline_run('portfolio-snapshot-packs-backfill', v_started, v_done + v_failed + v_left,
    v_done, v_failed, v_failed = 0 AND v_left = 0, NULL, NULL, NULL, NULL,
    jsonb_build_object('owners_filled', v_done, 'owners_failed', v_failed, 'over_budget', v_left,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  RETURN jsonb_build_object('owners_filled', v_done, 'owners_failed', v_failed, 'over_budget', v_left);
END
$fn$;

-- anon-exec: unchanged (backfill_portfolio_snapshot_pack_values_step) — CREATE OR REPLACE of the fn from 20261122232415; ACL preserved, verified anon=false.
