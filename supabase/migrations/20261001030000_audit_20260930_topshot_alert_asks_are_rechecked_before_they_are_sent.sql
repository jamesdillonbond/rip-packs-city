-- audit_20260930 — a Top Shot deal alert is built only from an ask confirmed in the last hour,
-- and the asks that could alert are re-checked on Atlas BEFORE they are sent.
--
-- 🚨 WHAT TREVOR SAW (2026-09-30, Telegram): "Greg Brown III Hustle and Show $0.25 ask — ask seen
-- 7h ago". Legal under the 12 h gate, but a $0.25 Common can sell in minutes. Measured ~7:37 PM PT:
-- 13,642 Top Shot asks, MEDIAN confirmation age 97.7 h, 1,798 (13 %) inside 12 h. The verify lane
-- (atlas_edition_verify_dispatch, 4 per 5 min) walks ALL editions oldest-first (~8-day wrap), with
-- no notion of which editions an alert is about to be built from.
--
-- 🚨 AND THE STAMP DID NOT MEAN "CONFIRMED" (two defects, opposite directions):
--   · TOO OLD: sync_edition_offers_from_atlas writes only a CHANGED floor, so an ask Atlas
--     re-observed unchanged kept the stamp of its last CHANGE (pinned as such 2026-09-13).
--   · TOO NEW: the same function's highest_offer arm, and raise_edition_offers_from_chain, bump
--     edition_offers.updated_at on an OFFER-only change — an old ask then reads freshly confirmed.
--     And a floor CHANGE stamped now() even when the new floor listing was last seen 23 h ago.
--     Measured: 1,203 asks whose updated_at sits >1 h AFTER their floor listing's last observation.
--
-- THE FIX, five parts:
--   1. edition_offers.low_ask_confirmed_at — WHEN the floor listing was last OBSERVED. Backfilled from
--      the floor listing's own last_seen_at (13,234 of 13,639 asks have one; the rest keep updated_at).
--      A BEFORE trigger keeps every other writer honest: no ask -> NULL; an ask changed by a writer
--      that names no observation time -> now() (the old contract); an offer-only write -> untouched.
--   2. sync_edition_offers_from_atlas stamps a changed floor with that listing's last_seen_at, and
--      a new step (a1) moves the stamp forward when the SAME listing (nft + price, still open) is
--      re-observed. Return gains 'reconfirmed'.
--   3. edition_current_ask and topshot_deals_vs_fmv publish low_ask_confirmed_at as ask_updated_at
--      (Top Shot arm only) — the alert gate, the "ask seen Nh ago" line and the boards read it.
--   4. ask_is_alertable: Top Shot EDITION asks must be confirmed inside 1 h (was 12 h; Trevor's call,
--      2026-09-30). The serial board passes 'nba_top_shot:serial' and keeps 12 h — its stamp comes from
--      a 3-hourly sweep (topshot-active-listings-ingest) the re-check lane cannot refresh, and 0 of 19
--      tight serial rows are inside 1 h today. Pinnacle and anything new keep 12 h.
--   5. alert_candidate_verify_dispatch() every 5 min: asks the preview (build_deal_alerts_for_subscription,
--      the sender's own filters) what each active sub WOULD be sent at any age — via a transaction-local
--      flag only ask_is_alertable reads — drops what this owner already got today, and probes Atlas for
--      up to 6 of those editions not confirmed or probed in 30 min. Same request shape and queue
--      (offset_at -4, '__edition__<id>') as the undercut lane, so the existing drain/settle/sync path
--      turns each answer into a fresh confirmation, a new floor, or NULL within ~5 min.
--   Net effect: an alert-worthy ask is held (not alertable) until a re-check confirms it, then sent
--   with "ask seen Nm ago"; one that sold is never sent. Cost: <= 6 Atlas requests / 5 min, on top of
--   ~1,700/day already spent by the edition-verify lanes (13 % 403 today — #65's burst limit is per
--   ~60-request burst; 6 spread requests are not a burst).
--
-- anon-exec: unchanged (ask_is_alertable) — CREATE OR REPLACE of an existing fn; ACL preserved (verified anon=false via has_function_privilege).
-- anon-exec: unchanged (dispatch_due_deal_alerts) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false service_role=true.
-- anon-exec: unchanged (build_deal_alerts_for_subscription) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false service_role=true.
-- anon-exec: sync_edition_offers_from_atlas (REVOKED below — already false live, restated because a snapshot must say so)
-- anon-exec: edition_offers_stamp_low_ask_confirmed (REVOKED below — a trigger function, never called directly)
-- anon-exec: alert_candidate_verify_dispatch (REVOKED from PUBLIC/anon/authenticated below; postgres via pg_cron, service_role)
--
-- REVERT (in this order):
--   SELECT cron.unschedule('rpc-ts-alert-candidate-verify');
--   re-apply ask_is_alertable from 20260913061500; dispatch_due_deal_alerts + build_deal_alerts_for_subscription
--   from 20261001021708; sync_edition_offers_from_atlas from 20260926192947 (it writes low_ask_confirmed_at,
--   so it must go back BEFORE the column is dropped); the two views with eo.updated_at AS ask_updated_at;
--   DROP TRIGGER trg_edition_offers_stamp_low_ask_confirmed ON public.edition_offers;
--   DROP FUNCTION public.edition_offers_stamp_low_ask_confirmed(), public.alert_candidate_verify_dispatch(integer);
--   ALTER TABLE public.edition_offers DROP COLUMN low_ask_confirmed_at;  re-point the drift-guard entries.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'ask_is_alertable' AND pronamespace = 'public'::regnamespace) <> 'e5333a889edf24e1d5731821e4ec79cf'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'dispatch_due_deal_alerts' AND pronamespace = 'public'::regnamespace) <> '6efaab1e6571d5e207683aed9ea79c4e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'build_deal_alerts_for_subscription' AND pronamespace = 'public'::regnamespace) <> '26cffec8dc8ea4bd4ab92b2e39f57c6c'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sync_edition_offers_from_atlas' AND pronamespace = 'public'::regnamespace) <> 'd759acc55180528cc9381e7387f8c598' THEN
    RAISE EXCEPTION 'a live alert-path body is not the one this migration was built from — re-read before a full-body write';
  END IF;
END $guard$;

-- ── 1. the confirmation column, backfilled, then kept honest by a trigger ─────────────────────────
ALTER TABLE public.edition_offers ADD COLUMN IF NOT EXISTS low_ask_confirmed_at timestamptz;
COMMENT ON COLUMN public.edition_offers.low_ask_confirmed_at IS
  'When the low_ask listing was last OBSERVED open at this price (Atlas last_seen_at), NULL when there is no ask. Not updated_at: that also moves on offer-only writes. audit_20260930.';

UPDATE public.edition_offers eo
   SET low_ask_confirmed_at = COALESCE(
         (SELECT max(ev.last_seen_at) FROM public.topshot_atlas_market_events ev
           WHERE ev.nft_id = eo.low_ask_nft_id AND ev.product = 'nba' AND ev.kind = 'listing'
             AND NOT ev.completed AND ev.price_cents = (eo.low_ask * 100)::bigint),
         eo.updated_at)
 WHERE eo.low_ask IS NOT NULL;

CREATE OR REPLACE FUNCTION public.edition_offers_stamp_low_ask_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- No ask, no confirmation.
  IF NEW.low_ask IS NULL THEN
    NEW.low_ask_confirmed_at := NULL;
  -- A writer that names no confirmation time is confirming the ask NOW (the
  -- old updated_at contract), so every other writer of low_ask keeps working.
  ELSIF TG_OP = 'INSERT' THEN
    NEW.low_ask_confirmed_at := COALESCE(NEW.low_ask_confirmed_at, now());
  -- The ask CHANGED and the writer did not say when it was observed: now().
  -- An offer-only write (highest_offer) never reaches this arm, so it can no
  -- longer make an old ask look freshly confirmed.
  ELSIF (NEW.low_ask IS DISTINCT FROM OLD.low_ask OR NEW.low_ask_nft_id IS DISTINCT FROM OLD.low_ask_nft_id)
        AND NEW.low_ask_confirmed_at IS NOT DISTINCT FROM OLD.low_ask_confirmed_at THEN
    NEW.low_ask_confirmed_at := now();
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.edition_offers_stamp_low_ask_confirmed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_edition_offers_stamp_low_ask_confirmed ON public.edition_offers;
CREATE TRIGGER trg_edition_offers_stamp_low_ask_confirmed
  BEFORE INSERT OR UPDATE ON public.edition_offers
  FOR EACH ROW EXECUTE FUNCTION public.edition_offers_stamp_low_ask_confirmed();

-- ── 2. the Atlas writer stamps observation time and re-confirms unchanged asks ───────────────────
CREATE OR REPLACE FUNCTION public.sync_edition_offers_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET work_mem TO '16MB'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_undercut int; v_stale int; v_nulled int; v_offers int; v_reconfirmed int;
BEGIN
  -- The floor: lowest open ask per edition. DELTA FIRST — the floor is compared against
  -- edition_offers in one join and only new/changed editions reach ON CONFLICT; the guard on
  -- the conflict arm is unchanged. Inside the tick the floor is read off the open book
  -- sync_ts_listings_from_atlas built (same raw rows — the floor never joined editions — same
  -- extra predicate, same ordering); standalone it reads the base tables as before.
  -- ⛔ AN UNDERCUT 24 h FLOOR IS NOT A FLOOR (2026-09-26). The 24 h window is a RE-OBSERVATION
  -- window, and the firehose only re-reports listings that CHANGE (known-issues #85): a quiet
  -- cheap listing ages out of it while newer, dearer ones stay in. So the 24 h minimum can sit
  -- 100x above the real floor — measured 2026-09-26: 241 of 2,713 floor editions had an older
  -- still-open listing under half their 24 h floor; Tre Jones 124:5108 published "lowest ask
  -- $20.00" over 69 open listings from $0.20 and 14 sales at ~$0.21 in 30 d. The older listing
  -- cannot be confirmed live either, so the honest value is UNKNOWN: when an open (not
  -- completed) listing seen within 30 d is under HALF the 24 h minimum, low_ask is written NULL
  -- (a verified-complete settle or a fresh re-observation restores it). Never the older price —
  -- that would publish an unconfirmed ask as the floor.
  IF to_regclass('pg_temp._open24') IS NOT NULL THEN
    WITH floor24 AS (
      SELECT DISTINCT ON (o.external_id)
             o.external_id, o.atlas_edition_id, o.price_cents, o.serial_number, o.nft_id, o.last_seen_at
        FROM _open24 o
       WHERE o.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY o.external_id, o.price_cents ASC, o.serial_number ASC NULLS LAST
    ), floor AS (
      SELECT f.external_id,
             CASE WHEN u.hit THEN NULL ELSE (f.price_cents::numeric / 100) END AS low_ask,
             CASE WHEN u.hit THEN NULL ELSE f.serial_number END AS serial_number,
             CASE WHEN u.hit THEN NULL ELSE f.nft_id END AS nft_id,
             -- audit_20260930: WHEN this floor listing was last OBSERVED -- the ask's
             -- confirmation time, never the write time (a 23 h-old listing is not news).
             CASE WHEN u.hit THEN NULL ELSE f.last_seen_at END AS seen_at,
             COALESCE(u.hit, false) AS undercut
        FROM floor24 f
        LEFT JOIN LATERAL (
          SELECT true AS hit FROM public.topshot_atlas_market_events ev
           WHERE ev.product = 'nba' AND ev.atlas_edition_id = f.atlas_edition_id
             AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
             AND ev.price_cents > 0 AND ev.price_cents < f.price_cents / 2
             AND ev.last_seen_at > now() - interval '30 days'
           LIMIT 1) u ON true
    ), cand AS (
      SELECT f.*
        FROM floor f
        LEFT JOIN public.edition_offers eo
               ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = f.external_id
       WHERE (eo.external_id IS NULL AND f.low_ask IS NOT NULL)
          OR (eo.external_id IS NOT NULL
              AND (eo.low_ask IS DISTINCT FROM f.low_ask::numeric
                   OR eo.low_ask_nft_id IS DISTINCT FROM f.nft_id))
    ), up AS (
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, low_ask_confirmed_at, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, f.seen_at, now()
        FROM cand f
      ON CONFLICT (collection_id, external_id) DO UPDATE
        SET low_ask = EXCLUDED.low_ask,
            low_ask_serial = EXCLUDED.low_ask_serial,
            low_ask_nft_id = EXCLUDED.low_ask_nft_id,
            low_ask_confirmed_at = EXCLUDED.low_ask_confirmed_at,
            updated_at = now()
        WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
           OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
      RETURNING (public.edition_offers.low_ask IS NULL) AS nulled
    )
    SELECT count(*), count(*) FILTER (WHERE nulled) INTO v_n, v_undercut FROM up;
  ELSE
    WITH floor24 AS (
      SELECT DISTINCT ON (m.external_id)
             m.external_id, ev.atlas_edition_id, ev.price_cents, ev.serial_number, ev.nft_id, ev.last_seen_at
        FROM public.topshot_atlas_market_events ev
        JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
       WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
         AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
         AND ev.last_seen_at > now() - interval '24 hours'
         AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY m.external_id, ev.price_cents ASC, ev.serial_number ASC NULLS LAST
    ), floor AS (
      SELECT f.external_id,
             CASE WHEN u.hit THEN NULL ELSE (f.price_cents::numeric / 100) END AS low_ask,
             CASE WHEN u.hit THEN NULL ELSE f.serial_number END AS serial_number,
             CASE WHEN u.hit THEN NULL ELSE f.nft_id END AS nft_id,
             -- audit_20260930: WHEN this floor listing was last OBSERVED -- the ask's
             -- confirmation time, never the write time (a 23 h-old listing is not news).
             CASE WHEN u.hit THEN NULL ELSE f.last_seen_at END AS seen_at,
             COALESCE(u.hit, false) AS undercut
        FROM floor24 f
        LEFT JOIN LATERAL (
          SELECT true AS hit FROM public.topshot_atlas_market_events ev
           WHERE ev.product = 'nba' AND ev.atlas_edition_id = f.atlas_edition_id
             AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
             AND ev.price_cents > 0 AND ev.price_cents < f.price_cents / 2
             AND ev.last_seen_at > now() - interval '30 days'
           LIMIT 1) u ON true
    ), cand AS (
      SELECT f.*
        FROM floor f
        LEFT JOIN public.edition_offers eo
               ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = f.external_id
       WHERE (eo.external_id IS NULL AND f.low_ask IS NOT NULL)
          OR (eo.external_id IS NOT NULL
              AND (eo.low_ask IS DISTINCT FROM f.low_ask::numeric
                   OR eo.low_ask_nft_id IS DISTINCT FROM f.nft_id))
    ), up AS (
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, low_ask_confirmed_at, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, f.seen_at, now()
        FROM cand f
      ON CONFLICT (collection_id, external_id) DO UPDATE
        SET low_ask = EXCLUDED.low_ask,
            low_ask_serial = EXCLUDED.low_ask_serial,
            low_ask_nft_id = EXCLUDED.low_ask_nft_id,
            low_ask_confirmed_at = EXCLUDED.low_ask_confirmed_at,
            updated_at = now()
        WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
           OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
      RETURNING (public.edition_offers.low_ask IS NULL) AS nulled
    )
    SELECT count(*), count(*) FILTER (WHERE nulled) INTO v_n, v_undercut FROM up;
  END IF;

  -- (a0) The same test on a STORED floor. An edition with no listing re-observed in 24 h never
  -- reaches the upsert above (Atlas is not a census), so its old floor stood however far an open
  -- listing had undercut it — measured 2026-09-26 after the step above shipped: 996 stored floors
  -- under an open listing below half (158 below a tenth), Tre Jones 124:5108 among them. Same rule:
  -- NULL (unknown), never the older price. Per-row LATERAL ... LIMIT 1 on idx_tame_open_by_edition
  -- (~120 ms / 42k hit buffers on prod); an EXISTS here hash-semi-joins 411k events (15 s).
  WITH hit AS (
    SELECT DISTINCT eo.external_id
      FROM public.edition_offers eo
      JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
     CROSS JOIN LATERAL (
       SELECT 1 FROM public.topshot_atlas_market_events ev
        WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
          AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
          AND ev.price_cents > 0 AND ev.price_cents < (eo.low_ask * 100)::bigint / 2
          AND ev.last_seen_at > now() - interval '30 days'
        LIMIT 1) u
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.low_ask IS NOT NULL
  ), stale AS (
    UPDATE public.edition_offers eo
       SET low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL, updated_at = now()
      FROM hit h
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = h.external_id
       AND eo.low_ask IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_stale FROM stale;

  -- (a) evidence-based NULL: verified COMPLETE within 24 h, and no open listing remains.
  WITH gone AS (
    SELECT m.external_id
      FROM public.topshot_atlas_edition_verified v
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = v.atlas_edition_id
     WHERE v.complete AND v.verified_at > now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = v.atlas_edition_id
                          AND ev.kind = 'listing' AND NOT ev.completed AND ev.price_cents > 0)
  ), nulled AS (
    UPDATE public.edition_offers eo
       SET low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL, updated_at = now()
      FROM gone g
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = g.external_id
       AND eo.low_ask IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_nulled FROM nulled;

  -- (a1) audit_20260930: RE-CONFIRMATION. The upsert above writes only a CHANGED floor, so an
  -- ask Atlas re-observed unchanged kept its old stamp, and the alert gate and every "ask seen
  -- Nh ago" read the age of the last CHANGE. When the exact floor listing (same nft, same price,
  -- still open) has been seen since the stored confirmation, move the confirmation forward to
  -- that observation. Reads a 30-min slice of idx_tame_open_listing_by_seen; a tick that misses
  -- a re-observation leaves the stamp OLDER (fail-closed), never newer.
  WITH seen AS (
    SELECT ev.nft_id, ev.price_cents, max(ev.last_seen_at) AS seen_at
      FROM public.topshot_atlas_market_events ev
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
       AND ev.last_seen_at > now() - interval '30 minutes'
     GROUP BY ev.nft_id, ev.price_cents
  ), re AS (
    UPDATE public.edition_offers eo
       SET low_ask_confirmed_at = s.seen_at
      FROM seen s
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND eo.low_ask IS NOT NULL
       AND eo.low_ask_nft_id = s.nft_id
       AND (eo.low_ask * 100)::bigint = s.price_cents
       AND (eo.low_ask_confirmed_at IS NULL OR eo.low_ask_confirmed_at < s.seen_at)
    RETURNING 1
  )
  SELECT count(*) INTO v_reconfirmed FROM re;

  -- (b) highest_offer for editions verified within 24 h: MAX open EDITION/PARALLEL offer, else NULL
  --     when the verification was complete. Serial offers are not an edition's offer.
  WITH ver AS (
    SELECT m.external_id, v.complete,
           (SELECT max(ev.price_cents) FROM public.topshot_atlas_market_events ev
             WHERE ev.product = 'nba' AND ev.atlas_edition_id = v.atlas_edition_id AND ev.kind = 'offer'
               AND NOT ev.completed AND ev.offer_type IN ('EDITION', 'PARALLEL') AND ev.price_cents > 0
               AND ev.last_seen_at > now() - interval '24 hours') AS best_cents
      FROM public.topshot_atlas_edition_verified v
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = v.atlas_edition_id
     WHERE v.verified_at > now() - interval '24 hours'
       AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ), off AS (
    INSERT INTO public.edition_offers (collection_id, external_id, highest_offer, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', ver.external_id, ver.best_cents::numeric / 100, now()
      FROM ver
     WHERE ver.best_cents IS NOT NULL
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET highest_offer = EXCLUDED.highest_offer, updated_at = now()
      WHERE public.edition_offers.highest_offer IS DISTINCT FROM EXCLUDED.highest_offer
    RETURNING 1
  ), off_null AS (
    UPDATE public.edition_offers eo
       SET highest_offer = NULL, updated_at = now()
      FROM ver
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = ver.external_id
       AND ver.complete AND ver.best_cents IS NULL AND eo.highest_offer IS NOT NULL
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM off) + (SELECT count(*) FROM off_null) INTO v_offers;

  RETURN jsonb_build_object('rows', v_n, 'undercut_nulled', v_undercut, 'stale_undercut_nulled', v_stale, 'nulled', v_nulled, 'offers', v_offers, 'reconfirmed', v_reconfirmed,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;
REVOKE ALL ON FUNCTION public.sync_edition_offers_from_atlas() FROM PUBLIC, anon, authenticated;

-- ── 3. the readers publish the confirmation, not the row's last write (Top Shot arm only) ────────
-- A mechanical one-token rewrite of the LIVE definitions, asserted to hit exactly one occurrence,
-- so the other 3 arms of edition_current_ask and every other column stay byte-for-byte as they are.
DO $views$
DECLARE v_def text; v_new text; v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['edition_current_ask', 'topshot_deals_vs_fmv'] LOOP
    v_def := pg_get_viewdef(('public.' || v_name)::regclass);
    v_new := replace(v_def, 'eo.updated_at AS ask_updated_at', 'eo.low_ask_confirmed_at AS ask_updated_at');
    IF (length(v_def) - length(replace(v_def, 'eo.updated_at AS ask_updated_at', ''))) / length('eo.updated_at AS ask_updated_at') <> 1 THEN
      RAISE EXCEPTION '% does not carry exactly one "eo.updated_at AS ask_updated_at"', v_name;
    END IF;
    EXECUTE format('CREATE OR REPLACE VIEW public.%I WITH (security_invoker = on) AS %s', v_name, v_new);
  END LOOP;
END $views$;

-- ── 4. the gate: 1 h for Top Shot edition asks; the serial board keeps 12 h under its own token ──
CREATE OR REPLACE FUNCTION public.ask_is_alertable(
  p_collection_slug text,
  p_ask_at          timestamptz,
  p_now             timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    -- CANDIDATE SCAN ONLY (audit_20260930): alert_candidate_verify_dispatch()
    -- sets this transaction-locally to ask the preview which asks WOULD match a
    -- subscription at any age, so it can re-check them on Atlas BEFORE they are
    -- sent. It never sends anything; the sender never sets it.
    WHEN current_setting('rpc.alert_candidate_scan', true) = 'on' THEN true
    -- EXEMPT: event-sourced open-listing books. The stamp is the seller's
    -- listing date, not a confirmation, and the row leaves the view when the
    -- listing closes. See the header -- gating these deletes correct rows.
    WHEN p_collection_slug IN ('nfl_all_day', 'laliga_golazos') THEN true
    -- Top Shot EDITION asks: confirmed within ALERT_TOPSHOT_ASK_MAX_AGE_HOURS
    -- (1 h, lib/market/ask-freshness.ts). The stamp is
    -- edition_offers.low_ask_confirmed_at, which the alert-candidate re-check
    -- lane refreshes. Both spellings, so a convention slip is STRICTER, not looser.
    WHEN p_collection_slug IN ('nba_top_shot', 'nba-top-shot') THEN
      p_ask_at IS NOT NULL AND p_ask_at > p_now - interval '1 hours'
    -- Everything else (Pinnacle, the Top Shot serial board 'nba_top_shot:serial',
    -- anything new) must have been CONFIRMED inside ASK_STALE_HOURS (12 h,
    -- lib/market/ask-freshness.ts). Unknown (NULL) is not alertable.
    ELSE p_ask_at IS NOT NULL AND p_ask_at > p_now - interval '12 hours'
  END
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_due_deal_alerts(p_max integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub record;
  v_deal jsonb;
  v_channel text;
  v_target text;
  v_subject text;
  v_bucket text := to_char(now(),'YYYY-MM-DD');
  v_enqueued int := 0;
  v_subs int := 0;
  v_serial_enqueued int := 0;
  v_slugs text[];
  v_deal_pool int := 0;
  v_serial_pool int := 0;
  v_price_pool int := 0;
  v_price_cap numeric;
  v_price_only boolean;
  -- How many of the rows we BUILT are barred from alerting because nobody has
  -- re-confirmed the ask. Reported so "quiet" and "quiet because the upstream
  -- ask lane is behind" are distinguishable from outside (audit_20260912).
  v_deal_pool_unconfirmed int := 0;
  v_price_pool_unconfirmed int := 0;
  v_serial_pool_unconfirmed int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.alert_subscriptions WHERE active = true) THEN
    RETURN jsonb_build_object(
      'subscriptions_scanned', 0,
      'enqueued', 0,
      'serial_enqueued', 0,
      'deal_pool_size', 0,
      'serial_pool_size', 0,
      'price_pool_size', 0,
      'deal_pool_unconfirmed', 0,
      'serial_pool_unconfirmed', 0,
      'price_pool_unconfirmed', 0,
      'bucket', v_bucket,
      'ran_at', now(),
      'skipped', 'no_active_subscriptions'
    );
  END IF;

  -- ⚠ `alertable` is computed ONCE here rather than in each per-subscription
  -- WHERE: the price pool can be thousands of rows and the loop runs per sub, and
  -- it also makes the unconfirmed counts exact rather than a second scan of a
  -- view whose Top Shot leg is the expensive one.
  DROP TABLE IF EXISTS tmp_deal_pool;
  CREATE TEMP TABLE tmp_deal_pool ON COMMIT DROP AS
    SELECT 'deals'::text AS pool, b.*,
           public.ask_is_alertable(b.collection_slug, b.ask_updated_at) AS alertable
    FROM public.cross_collection_deals_board b
    WHERE b.low_ask > 0 AND b.fmv_usd > 0;
  GET DIAGNOSTICS v_deal_pool = ROW_COUNT;

  -- Price-only rows are appended to the SAME temp table under a different tag,
  -- so pass 1 keeps one loop body and existing subs keep reading pool='deals'
  -- unchanged. Built only when a price-only sub exists, and bounded by the
  -- largest max_price in play -- with none, this costs one aggregate.
  SELECT max(max_price) INTO v_price_cap
  FROM public.alert_subscriptions
  WHERE active = true AND max_price IS NOT NULL AND COALESCE(min_discount, 25) = 0;

  IF v_price_cap IS NOT NULL THEN
    INSERT INTO tmp_deal_pool
    SELECT 'price'::text, a.*,
           public.ask_is_alertable(a.collection_slug, a.ask_updated_at)
    FROM public.edition_current_ask a
    WHERE a.low_ask > 0 AND a.low_ask <= v_price_cap;
    GET DIAGNOSTICS v_price_pool = ROW_COUNT;
  END IF;

  SELECT count(*) FILTER (WHERE pool = 'deals' AND NOT alertable),
         count(*) FILTER (WHERE pool = 'price' AND NOT alertable)
    INTO v_deal_pool_unconfirmed, v_price_pool_unconfirmed
  FROM tmp_deal_pool;

  DROP TABLE IF EXISTS tmp_serial_pool;
  -- audit_20260930: the serial pool passes 'nba_top_shot:serial', not
  -- 'nba_top_shot'. Its stamp is topshot_active_listings.last_seen_at, written by
  -- a 3-hourly sweep the edition re-check lane cannot refresh, so it keeps the
  -- 12 h window; the 1 h Top Shot window is for EDITION asks only.
  CREATE TEMP TABLE tmp_serial_pool ON COMMIT DROP AS
    SELECT s.*,
           public.ask_is_alertable('nba_top_shot:serial', s.last_seen_at) AS alertable
    FROM public.topshot_underpriced_serials_board s
    WHERE s.estimate_quality = 'tight' AND s.ask_usd > 0;
  GET DIAGNOSTICS v_serial_pool = ROW_COUNT;

  SELECT count(*) FILTER (WHERE NOT alertable)
    INTO v_serial_pool_unconfirmed
  FROM tmp_serial_pool;

  FOR v_sub IN SELECT * FROM public.alert_subscriptions WHERE active = true LOOP
    v_subs := v_subs + 1;

    IF v_sub.collection_ids IS NULL THEN
      v_slugs := ARRAY(SELECT slug FROM public.collections WHERE is_active = true);
    ELSE
      v_slugs := ARRAY(SELECT slug FROM public.collections WHERE id = ANY(v_sub.collection_ids));
    END IF;

    -- "Just a price, no FMV condition."
    v_price_only := (v_sub.max_price IS NOT NULL AND COALESCE(v_sub.min_discount, 25) = 0);

    -- Pass 1: edition-level deals (skipped entirely for serial-only subs).
    -- 2026-07-11: team_names + badges now filter pass 1 too (previously serial-
    -- pass-only, so a team/badge sub got unfiltered edition deals = spam).
    -- audit_20261001: every filter but badges runs before any truncation, and
    -- badges (the one per-row function) runs last, lazily, under LIMIT 25.
    IF NOT COALESCE(v_sub.serial_only, false) THEN
    FOR v_deal IN
      SELECT jsonb_build_object(
        'external_id', b.external_id, 'name', b.name,
        'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
        'collection_slug', b.collection_slug, 'collection_name', b.collection_name,
        'circulation_count', b.circulation_count, 'fmv_usd', b.fmv_usd, 'confidence', b.confidence,
        'low_ask', b.low_ask, 'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
        'detail_url', b.detail_url, 'thumbnail_url', b.thumbnail_url, 'ask_updated_at', b.ask_updated_at,
        'serial_number', b.low_ask_serial, 'nft_id', b.low_ask_nft_id,
        -- Tells the formatter this row carries no FMV BY DESIGN, so it omits
        -- the "below FMV" clause instead of rendering an em-dash for it.
        'price_only', (b.pool = 'price'),
        'parallel', COALESCE(
          (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
             WHERE be.external_id = b.external_id
               AND be.parallel_name IS NOT NULL
               AND be.parallel_name NOT IN ('', 'Standard')
             LIMIT 1),
          (SELECT pc.variant FROM public.pinnacle_catalog pc
             WHERE pc.render_id = b.render_id
               AND pc.variant IS NOT NULL
               AND pc.variant <> 'Standard'
             LIMIT 1)
        )
      ) AS d
      FROM (
        SELECT * FROM tmp_deal_pool p
        WHERE p.pool = CASE WHEN v_price_only THEN 'price' ELSE 'deals' END
          -- An ask nobody has re-confirmed inside ASK_STALE_HOURS does not get
          -- to wake a human. This is the ONLY predicate standing between the
          -- 2026-09-09 $0.50 Lillard ask and its fourth consecutive nightly
          -- delivery on 09-13, by which time the floor was $1.03
          -- (audit_20260912).
          AND p.alertable
          AND p.collection_slug = ANY(v_slugs)
          -- NULL >= 0 is NULL, not true, so a price-only sub must SKIP this
          -- predicate rather than relax it.
          AND (v_price_only OR p.discount_pct >= COALESCE(v_sub.min_discount, 25))
          AND NOT COALESCE(p.low_confidence_fmv, false)
          AND (v_sub.max_price IS NULL OR p.low_ask <= v_sub.max_price)
          AND (v_sub.min_price IS NULL OR p.low_ask >= v_sub.min_price)
          AND (v_sub.tiers IS NULL OR p.tier = ANY(v_sub.tiers))
          AND (v_sub.player_names IS NULL OR lower(p.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
          -- CONTAINMENT, not equality -- "Archive" must match "Archive Set".
          AND (v_sub.set_names IS NULL OR EXISTS (
            SELECT 1 FROM unnest(v_sub.set_names) sx
            WHERE lower(p.set_name) LIKE '%' || lower(sx) || '%'
          ))
          -- audit_20261001: team + parallel filter HERE, before anything can
          -- truncate. Until now they ran AFTER a LIMIT 500 over the cheap
          -- predicates, so a team sub silently lost every match ranked below the
          -- 500th row of the WHOLE collection: live, a $0.25 Blazers rookie ask
          -- sat behind 504 cheaper Top Shot asks and was never sent.
          AND (v_sub.parallel_names IS NULL OR lower(COALESCE(
                (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                   WHERE be.external_id = p.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
                CASE WHEN p.collection_slug = 'disney_pinnacle' THEN p.tier END
              )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
          AND (v_sub.team_names IS NULL OR EXISTS (
            SELECT 1 FROM public.editions e
            JOIN public.collections c ON c.id = e.collection_id
            WHERE e.external_id = p.external_id
              AND c.slug = p.collection_slug
              AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
          ))
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        -- ⚠ OFFSET 0 is a FENCE, not a no-op: it stops the planner pushing the
        -- per-row badge function below into this scan, so badges are evaluated
        -- only on rows that survived every cheaper filter, in rank order, and
        -- the outer LIMIT 25 can stop as soon as 25 match. There is NO cap here
        -- on purpose -- a cap ahead of a filter is the defect being removed.
        OFFSET 0
      ) b
      WHERE (v_sub.badges IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
        ))
      ORDER BY b.discount_pct DESC NULLS LAST,
               (CASE WHEN v_price_only THEN b.low_ask END) ASC
      LIMIT 25
    LOOP
      v_subject := (v_deal->>'collection_slug') || ':' || (v_deal->>'external_id');
      FOREACH v_channel IN ARRAY v_sub.channels LOOP
        SELECT channel_user_id INTO v_target
        FROM public.notification_channels
        WHERE owner_key = v_sub.owner_key AND channel = v_channel
          AND verified = true AND channel_user_id IS NOT NULL
        LIMIT 1;

        IF v_target IS NULL THEN CONTINUE; END IF;

        INSERT INTO public.alert_deliveries
          (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
        VALUES (
          v_sub.owner_key, v_channel, v_target, 'deal',
          v_subject, v_bucket,
          jsonb_build_object('subscription_id', v_sub.id, 'label', v_sub.label, 'deal', v_deal)
        )
        ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

        IF FOUND THEN v_enqueued := v_enqueued + 1; END IF;
      END LOOP;
    END LOOP;
    END IF;

    -- Pass 2: per-serial underpriced deals (unchanged apart from set match).
    IF v_sub.collection_ids IS NULL OR (v_ts = ANY(v_sub.collection_ids)) THEN
      FOR v_deal IN
        SELECT jsonb_build_object(
          'external_id', b.external_id, 'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
          'collection_slug', 'nba-top-shot', 'circulation_count', b.circulation_count,
          'nft_id', b.nft_id, 'serial_number', b.serial_number,
          'kind', CASE WHEN b.serial_number = 1 THEN 'first' ELSE 'perfect' END,
          'ask_usd', b.ask_usd, 'serial_fmv_usd', b.serial_fmv_usd, 'edition_fmv_usd', b.edition_fmv_usd,
          'confidence', b.confidence, 'estimate_quality', b.estimate_quality,
          'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
          'listing_url', COALESCE(b.listing_url, 'https://dapper.market/nba/moment/' || b.nft_id),
          'moment_url', '/moment/' || b.nft_id, 'thumbnail_url', b.thumbnail_url,
          'parallel', (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                         WHERE be.external_id = b.external_id
                           AND be.parallel_name IS NOT NULL
                           AND be.parallel_name NOT IN ('', 'Standard')
                         LIMIT 1)
        ) AS d
        FROM tmp_serial_pool b
        WHERE b.alertable
          AND b.discount_pct >= COALESCE(v_sub.min_discount, 25)
          AND (v_sub.max_price IS NULL OR b.ask_usd <= v_sub.max_price)
          AND (v_sub.min_price IS NULL OR b.ask_usd >= v_sub.min_price)
          AND (v_sub.tiers IS NULL OR b.tier = ANY(v_sub.tiers))
          AND (v_sub.player_names IS NULL OR lower(b.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
          -- CONTAINMENT, not equality -- "Archive" must match "Archive Set".
          AND (v_sub.set_names IS NULL OR EXISTS (
            SELECT 1 FROM unnest(v_sub.set_names) sx
            WHERE lower(b.set_name) LIKE '%' || lower(sx) || '%'
          ))
          AND (v_sub.parallel_names IS NULL OR EXISTS (
            SELECT 1 FROM public.badge_editions be
            WHERE be.external_id = b.external_id
              AND be.parallel_name NOT IN ('','Standard')
              AND lower(be.parallel_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x))
          ))
          AND (v_sub.min_serial IS NULL OR b.serial_number >= v_sub.min_serial)
          AND (v_sub.max_serial IS NULL OR b.serial_number <= v_sub.max_serial)
          AND (NOT COALESCE(v_sub.require_last_mint, false) OR b.serial_number = b.circulation_count)
          AND (v_sub.team_names IS NULL OR EXISTS (
            SELECT 1 FROM public.editions e
            WHERE e.external_id = b.external_id
              AND e.collection_id = v_ts
              AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
          ))
          AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR EXISTS (
            SELECT 1 FROM public.editions e
            WHERE e.external_id = b.external_id
              AND e.collection_id = v_ts
              AND e.jersey_number = b.serial_number
          ))
          AND (NOT COALESCE(v_sub.require_never_sold, false) OR NOT EXISTS (
            SELECT 1 FROM public.sales s WHERE s.nft_id = b.nft_id
          ))
          AND (v_sub.badges IS NULL OR EXISTS (
            SELECT 1
            FROM public.editions e
            CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
            WHERE e.external_id = b.external_id
              AND e.collection_id = v_ts
              AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
          ))
        ORDER BY b.discount_pct DESC
        LIMIT 25
      LOOP
        v_subject := (v_deal->>'collection_slug') || ':' || (v_deal->>'external_id')
                     || ':#' || (v_deal->>'serial_number');
        FOREACH v_channel IN ARRAY v_sub.channels LOOP
          SELECT channel_user_id INTO v_target
          FROM public.notification_channels
          WHERE owner_key = v_sub.owner_key AND channel = v_channel
            AND verified = true AND channel_user_id IS NOT NULL
          LIMIT 1;

          IF v_target IS NULL THEN CONTINUE; END IF;

          INSERT INTO public.alert_deliveries
            (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
          VALUES (
            v_sub.owner_key, v_channel, v_target, 'deal',
            v_subject, v_bucket,
            jsonb_build_object('subscription_id', v_sub.id, 'label', v_sub.label, 'deal', v_deal)
          )
          ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

          IF FOUND THEN
            v_enqueued := v_enqueued + 1;
            v_serial_enqueued := v_serial_enqueued + 1;
          END IF;
        END LOOP;
      END LOOP;
    END IF;

    UPDATE public.alert_subscriptions SET last_run_at = now() WHERE id = v_sub.id;
    EXIT WHEN v_enqueued >= p_max;
  END LOOP;

  RETURN jsonb_build_object(
    'subscriptions_scanned', v_subs,
    'enqueued', v_enqueued,
    'serial_enqueued', v_serial_enqueued,
    'deal_pool_size', v_deal_pool,
    'serial_pool_size', v_serial_pool,
    'price_pool_size', v_price_pool,
    'deal_pool_unconfirmed', v_deal_pool_unconfirmed,
    'serial_pool_unconfirmed', v_serial_pool_unconfirmed,
    'price_pool_unconfirmed', v_price_pool_unconfirmed,
    'bucket', v_bucket,
    'ran_at', now()
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.build_deal_alerts_for_subscription(p_subscription_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub public.alert_subscriptions%ROWTYPE;
  v_slugs text[];
  v_deals jsonb;
  v_serial_deals jsonb;
  v_price_only boolean;
BEGIN
  SELECT * INTO v_sub FROM public.alert_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND OR NOT v_sub.active THEN
    RETURN jsonb_build_object('error','not eligible');
  END IF;

  IF v_sub.collection_ids IS NULL THEN
    v_slugs := ARRAY(SELECT slug FROM public.collections WHERE is_active = true);
  ELSE
    v_slugs := ARRAY(SELECT slug FROM public.collections WHERE id = ANY(v_sub.collection_ids));
  END IF;

  -- "Just a price, no FMV condition."
  v_price_only := (v_sub.max_price IS NOT NULL AND COALESCE(v_sub.min_discount, 25) = 0);

  -- Pass 1 preview: edition-grain deals. Mirrors dispatch_due_deal_alerts
  -- (2026-07-11): team_names + badges filter here too; serial_only skips it.
  IF NOT COALESCE(v_sub.serial_only, false) THEN
    SELECT jsonb_agg(d ORDER BY (d->>'discount_pct')::numeric DESC NULLS LAST,
                                (d->>'low_ask')::numeric ASC)
    INTO v_deals
    FROM (
      SELECT jsonb_build_object(
        'external_id', b.external_id, 'name', b.name,
        'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
        'collection_slug', b.collection_slug, 'collection_name', b.collection_name,
        'circulation_count', b.circulation_count, 'fmv_usd', b.fmv_usd, 'confidence', b.confidence,
        'low_ask', b.low_ask, 'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
        'detail_url', b.detail_url, 'thumbnail_url', b.thumbnail_url, 'ask_updated_at', b.ask_updated_at,
        'price_only', (b.pool = 'price')
      ) AS d
      FROM (
        SELECT * FROM (
          -- The two pools are mutually exclusive per subscription: exactly one
          -- of these branches has a true guard, so the other is a One-Time
          -- Filter. A price-only sub never sees a deals row and vice versa.
          SELECT 'deals'::text AS pool, dl.*
            FROM public.cross_collection_deals_board dl
           WHERE NOT v_price_only AND dl.low_ask > 0 AND dl.fmv_usd > 0
          UNION ALL
          SELECT 'price'::text, pr.*
            FROM public.edition_current_ask pr
           WHERE v_price_only AND pr.low_ask > 0 AND pr.low_ask <= v_sub.max_price
        ) p
        WHERE p.collection_slug = ANY(v_slugs)
          -- Never preview an ask the sender is barred from sending
          -- (audit_20260912).
          AND public.ask_is_alertable(p.collection_slug, p.ask_updated_at)
          -- A price-only sub has no discount condition at all. Note this is not
          -- the same as ">= 0": discount_pct is NULL in the price pool, and
          -- NULL >= 0 is NULL, which filters the row out. That NULL is the bug.
          AND (v_price_only OR p.discount_pct >= COALESCE(v_sub.min_discount, 25))
          AND (v_sub.max_price IS NULL OR p.low_ask <= v_sub.max_price)
          AND (v_sub.min_price IS NULL OR p.low_ask >= v_sub.min_price)
          AND (v_sub.tiers IS NULL OR p.tier = ANY(v_sub.tiers))
          AND (v_sub.player_names IS NULL OR lower(p.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
          -- CONTAINMENT, not equality -- "Archive" must match "Archive Set".
          AND (v_sub.set_names IS NULL OR EXISTS (
            SELECT 1 FROM unnest(v_sub.set_names) sx
            WHERE lower(p.set_name) LIKE '%' || lower(sx) || '%'
          ))
          -- audit_20261001: team + parallel filter HERE, before anything can
          -- truncate. Until now they ran AFTER a LIMIT 500 over the cheap
          -- predicates, so a team sub silently lost every match ranked below the
          -- 500th row of the WHOLE collection: live, a $0.25 Blazers rookie ask
          -- sat behind 504 cheaper Top Shot asks and was never sent.
          AND (v_sub.parallel_names IS NULL OR lower(COALESCE(
                (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                   WHERE be.external_id = p.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
                CASE WHEN p.collection_slug = 'disney_pinnacle' THEN p.tier END
              )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
          AND (v_sub.team_names IS NULL OR EXISTS (
            SELECT 1 FROM public.editions e
            JOIN public.collections c ON c.id = e.collection_id
            WHERE e.external_id = p.external_id
              AND c.slug = p.collection_slug
              AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
          ))
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        -- ⚠ OFFSET 0 is a FENCE, not a no-op: it stops the planner pushing the
        -- per-row badge function below into this scan, so badges are evaluated
        -- only on rows that survived every cheaper filter, in rank order, and
        -- the outer LIMIT 25 can stop as soon as 25 match. There is NO cap here
        -- on purpose -- a cap ahead of a filter is the defect being removed.
        OFFSET 0
      ) b
      WHERE (v_sub.badges IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
        ))
      ORDER BY b.discount_pct DESC NULLS LAST,
               (CASE WHEN v_price_only THEN b.low_ask END) ASC
      LIMIT 25
    ) x;
  END IF;

  -- Serial-pass preview: special-serial underpriced board (Top Shot only).
  -- Deliberately NOT given a price-only branch: that board is derived from a
  -- serial-vs-edition FMV comparison, so "no FMV condition" has no meaning
  -- there -- every row on it exists because of an FMV gap. A price-only sub
  -- still gets these, bounded by its max_price, as a strict addition.
  IF v_sub.collection_ids IS NULL OR (v_ts = ANY(v_sub.collection_ids)) THEN
    SELECT jsonb_agg(d ORDER BY (d->>'discount_pct')::numeric DESC)
    INTO v_serial_deals
    FROM (
      SELECT jsonb_build_object(
        'external_id', b.external_id, 'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
        'collection_slug', 'nba-top-shot', 'circulation_count', b.circulation_count,
        'nft_id', b.nft_id, 'serial_number', b.serial_number,
        'kind', CASE WHEN b.serial_number = 1 THEN 'first' ELSE 'perfect' END,
        'ask_usd', b.ask_usd, 'serial_fmv_usd', b.serial_fmv_usd, 'edition_fmv_usd', b.edition_fmv_usd,
        'confidence', b.confidence, 'estimate_quality', b.estimate_quality,
        'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
        'listing_url', COALESCE(b.listing_url, 'https://dapper.market/nba/moment/' || b.nft_id),
        'thumbnail_url', b.thumbnail_url
      ) AS d
      FROM public.topshot_underpriced_serials_board b
      WHERE b.estimate_quality = 'tight' AND b.ask_usd > 0
        -- ⚠ 'nba_top_shot:serial' (audit_20260930), the same token as the
        -- sender's serial pool: this board's stamp comes from a 3-hourly sweep,
        -- so it keeps the 12 h window while Top Shot EDITION asks get 1 h. Never
        -- the payload's 'nba-top-shot' hyphen spelling.
        AND public.ask_is_alertable('nba_top_shot:serial', b.last_seen_at)
        AND b.discount_pct >= COALESCE(v_sub.min_discount, 25)
        AND (v_sub.max_price IS NULL OR b.ask_usd <= v_sub.max_price)
        AND (v_sub.min_price IS NULL OR b.ask_usd >= v_sub.min_price)
        AND (v_sub.tiers IS NULL OR b.tier = ANY(v_sub.tiers))
        AND (v_sub.player_names IS NULL OR lower(b.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
        AND (v_sub.set_names IS NULL OR EXISTS (
          SELECT 1 FROM unnest(v_sub.set_names) sx
          WHERE lower(b.set_name) LIKE '%' || lower(sx) || '%'
        ))
        AND (v_sub.min_serial IS NULL OR b.serial_number >= v_sub.min_serial)
        AND (v_sub.max_serial IS NULL OR b.serial_number <= v_sub.max_serial)
        AND (NOT COALESCE(v_sub.require_last_mint, false) OR b.serial_number = b.circulation_count)
        AND (v_sub.team_names IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          WHERE e.external_id = b.external_id
            AND e.collection_id = v_ts
            AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
        ))
        AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR EXISTS (
          SELECT 1 FROM public.editions e
          WHERE e.external_id = b.external_id
            AND e.collection_id = v_ts
            AND e.jersey_number = b.serial_number
        ))
        AND (v_sub.badges IS NULL OR EXISTS (
          SELECT 1
          FROM public.editions e
          CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
          WHERE e.external_id = b.external_id
            AND e.collection_id = v_ts
            AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
        ))
      ORDER BY b.discount_pct DESC
      LIMIT 25
    ) y;
  END IF;

  RETURN jsonb_build_object(
    'subscription_id', p_subscription_id, 'owner_key', v_sub.owner_key, 'channels', v_sub.channels,
    'generated_at', now(), 'min_discount', COALESCE(v_sub.min_discount, 25),
    'min_price', v_sub.min_price, 'max_price', v_sub.max_price, 'tiers', v_sub.tiers,
    'player_names', v_sub.player_names, 'set_names', v_sub.set_names, 'collections', v_slugs,
    'team_names', v_sub.team_names, 'badges', v_sub.badges, 'serial_only', COALESCE(v_sub.serial_only, false),
    'price_only', v_price_only,
    'deals_count', COALESCE(jsonb_array_length(v_deals), 0) + COALESCE(jsonb_array_length(v_serial_deals), 0),
    'deals', COALESCE(v_deals, '[]'::jsonb),
    'serial_deals_count', COALESCE(jsonb_array_length(v_serial_deals), 0),
    'serial_deals', COALESCE(v_serial_deals, '[]'::jsonb)
  );
END;
$function$;
-- ── 5. re-check what is about to alert ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.alert_candidate_verify_dispatch(p_max integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_bucket text := to_char(now(), 'YYYY-MM-DD');
  v_sub record;
  v_prev jsonb;
  v_ext text[] := '{}';
  v_subs int := 0;
  v_cands int := 0;
  v_due int := 0;
  v_n int := 0;
  v_req bigint;
  r record;
  v_err text;
BEGIN
  BEGIN
    -- 1. What WOULD each subscription be sent, at any ask age? The preview is the
    --    sender's own filter set (pinned against it), so this lane cannot drift
    --    from what alerts. The scan flag is transaction-local and only widens the
    --    age gate; nothing here writes an alert.
    PERFORM set_config('rpc.alert_candidate_scan', 'on', true);
    FOR v_sub IN
      SELECT s.id, s.owner_key FROM public.alert_subscriptions s
       WHERE s.active AND NOT COALESCE(s.serial_only, false)
         AND (s.collection_ids IS NULL OR v_ts = ANY (s.collection_ids))
    LOOP
      v_subs := v_subs + 1;
      v_prev := public.build_deal_alerts_for_subscription(v_sub.id);
      -- Top Shot edition rows not already delivered to this owner today (the
      -- sender's daily dedup bucket: re-checking those buys nothing).
      v_ext := v_ext || ARRAY(
        SELECT d->>'external_id'
          FROM jsonb_array_elements(COALESCE(v_prev->'deals', '[]'::jsonb)) d
         WHERE d->>'collection_slug' = 'nba_top_shot'
           AND NOT EXISTS (
             SELECT 1 FROM public.alert_deliveries ad
              WHERE ad.owner_key = v_sub.owner_key AND ad.alert_kind = 'deal'
                AND ad.subject_key = 'nba_top_shot:' || (d->>'external_id')
                AND ad.dedup_bucket = v_bucket));
    END LOOP;
    PERFORM set_config('rpc.alert_candidate_scan', 'off', true);

    -- 2. Re-check, on Atlas, every candidate whose ask was not confirmed in the
    --    last 30 min and that no probe has covered in 30 min. Oldest first. The
    --    settle + sync path turns the answer into a fresh low_ask_confirmed_at
    --    (still listed) or a new floor / NULL (gone) — both inside ~5 min.
    FOR r IN
      WITH inflight AS MATERIALIZED (
        SELECT q.error FROM public.topshot_atlas_market_requests q
         WHERE q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes'
      ), c AS (
        SELECT DISTINCT m.atlas_edition_id, eo.low_ask_confirmed_at, v.verified_at
          FROM unnest(v_ext) AS x(ext)
          JOIN public.edition_offers eo ON eo.collection_id = v_ts AND eo.external_id = x.ext
          JOIN public.topshot_atlas_edition_map m ON m.external_id = x.ext
          LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = m.atlas_edition_id
         WHERE m.atlas_edition_id IS NOT NULL
      ), due AS (
        SELECT c.*, count(*) OVER () AS n_cands,
               count(*) FILTER (WHERE (c.low_ask_confirmed_at IS NULL OR c.low_ask_confirmed_at < now() - interval '30 minutes')
                                  AND (c.verified_at IS NULL OR c.verified_at < now() - interval '30 minutes')) OVER () AS n_due
          FROM c
      )
      SELECT d.atlas_edition_id, d.n_cands, d.n_due,
             ((d.low_ask_confirmed_at IS NULL OR d.low_ask_confirmed_at < now() - interval '30 minutes')
              AND (d.verified_at IS NULL OR d.verified_at < now() - interval '30 minutes')
              AND i.error IS NULL) AS go
        FROM due d
        LEFT JOIN inflight i ON i.error = '__edition__' || d.atlas_edition_id
       ORDER BY 4 DESC, d.low_ask_confirmed_at ASC NULLS FIRST
    LOOP
      v_cands := r.n_cands;
      v_due := r.n_due;
      EXIT WHEN NOT r.go OR v_n >= GREATEST(p_max, 0);
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', 'nba', 'editionId', r.atlas_edition_id, 'limit', 200),
        headers := public.atlas_market_headers('nba'),
        timeout_milliseconds := 20000);
      INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
      VALUES (v_req, 'nba', -4, '__edition__' || r.atlas_edition_id);
      v_n := v_n + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('ts-alert-candidate-verify', v_started, v_cands, v_n, 0, v_err IS NULL, v_err,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('subscriptions', v_subs, 'candidates', v_cands, 'due', v_due, 'dispatched', v_n,
                       'via', 'pg_cron', 'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('subscriptions', v_subs, 'candidates', v_cands, 'due', v_due, 'dispatched', v_n, 'error', v_err);
END
$function$;

REVOKE ALL ON FUNCTION public.alert_candidate_verify_dispatch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alert_candidate_verify_dispatch(integer) TO service_role;

-- :02/:07/… — between the listing tick (:01/:06) and the undercut lane (:04/:09), so the three
-- Atlas dispatchers never fire in the same minute.
SELECT cron.schedule('rpc-ts-alert-candidate-verify', '2-57/5 * * * *', 'SELECT public.alert_candidate_verify_dispatch(6);');
