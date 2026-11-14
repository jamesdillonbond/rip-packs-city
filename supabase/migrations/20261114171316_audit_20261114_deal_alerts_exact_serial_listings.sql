-- audit_20261114_deal_alerts_exact_serial_listings
--
-- Claude Code cloud, 2026-11-14 ~9:20 AM PT (Trevor: "build the concierge serial alert follow-up").
--
-- WHAT. A deal alert with a NARROW serial window on Top Shot ("tell me when #111 is listed": min_serial =
-- max_serial = 111, or any window of up to 10 serials) is now matched against EVERY open listing of those
-- serials, not just each edition's lowest ask. 20261113184535 had to state the limit: "a single-serial
-- alert now fires only when that serial IS the edition's lowest ask; RPC has no per-listing pool for
-- arbitrary serials". That pool now exists: topshot_atlas_market_events + idx_tame_open_listing_serial
-- (built 2026-11-14 for #12359, the Sniper's Serial # search).
--
--   alert_sub_is_exact_serial(min, max, collection_ids)  — the ONE narrow-window test both callers use.
--   topshot_exact_serial_alert_deals(subscription_id)    — pass 3's pool, as per-serial deal payloads:
--     • open Atlas listing rows for the window, one per Moment (newest listing), edition via
--       topshot_atlas_edition_map;
--     • NEW listings only: listed in the last 24 h (a "when it is listed" alert, not a digest of the book);
--     • confirmed inside the serial-board alert window: ask_is_alertable('nba_top_shot:serial', last_seen_at)
--       — 12 h; an older sighting never wakes a human;
--     • a discount sub is priced against the EDITION FMV (latest snapshot) and only where pass 1 would trust
--       it: HIGH/MEDIUM, not thin (topshot_thin_fmv_editions), not conflated (topshot_conflated_editions).
--       A price-only sub (max_price + min_discount 0) needs no FMV, as everywhere else;
--     • every other subscription filter, as pass 2 applies them; LIMIT 25, best discount then cheapest.
--   dispatch_due_deal_alerts — pass 3 after pass 2; same subject key ('nba-top-shot:<ext>:#<serial>') and
--     fingerprint (nft@ask) as pass 2, so a listing both find collapses on the unique index / suppression;
--     pass 1 stops offering Top Shot edition low asks to an exact-serial sub (that listing reaches it via
--     pass 3, and would otherwise arrive twice under two subject keys). New return key exact_serial_enqueued.
--   build_deal_alerts_for_subscription — the same, for the /alerts preview + concierge: pass-3 rows are
--     merged into serial_deals (a Moment pass 2 already lists is not repeated); exact_serial_deals_count.
--
-- Bases verified before writing (prosrc md5, live = 20261113184535's bodies):
--   dispatch_due_deal_alerts           8291ad36ef2507a98995593bf1c2721d
--   build_deal_alerts_for_subscription 7cedbaa71445d01b5bfd6d0dceacb06d
-- The DO block refuses if either moved since.
--
-- The nine subscriptions this was built for (support_conversations 12524) stay PAUSED: resuming them is the
-- owner's call. Nothing else changes behaviour: no other active subscription has a serial window.
--
-- anon-exec: unchanged (dispatch_due_deal_alerts) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- anon-exec: unchanged (build_deal_alerts_for_subscription) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- anon-exec: false (topshot_exact_serial_alert_deals) — revoked FROM PUBLIC, anon, authenticated below; service_role only.
-- anon-exec: false (alert_sub_is_exact_serial) — revoked FROM PUBLIC, anon, authenticated below; service_role only.
--
-- REVERT: re-apply both bodies from 20261113184535; then
--   drop function public.topshot_exact_serial_alert_deals(uuid); drop function public.alert_sub_is_exact_serial(integer, integer, uuid[]);

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.dispatch_due_deal_alerts(integer)'::regprocedure)
     <> '8291ad36ef2507a98995593bf1c2721d' THEN
    RAISE EXCEPTION 'dispatch_due_deal_alerts changed since it was read; re-derive this migration';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.build_deal_alerts_for_subscription(uuid)'::regprocedure)
     <> '7cedbaa71445d01b5bfd6d0dceacb06d' THEN
    RAISE EXCEPTION 'build_deal_alerts_for_subscription changed since it was read; re-derive this migration';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.alert_sub_is_exact_serial(p_min_serial integer, p_max_serial integer, p_collection_ids uuid[])
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- A NARROW serial window (1–10 serials) on a subscription that includes Top Shot.
  SELECT p_min_serial IS NOT NULL AND p_max_serial IS NOT NULL
     AND p_max_serial >= p_min_serial AND p_max_serial - p_min_serial < 10
     AND (p_collection_ids IS NULL OR '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid = ANY(p_collection_ids))
$function$;

CREATE OR REPLACE FUNCTION public.topshot_exact_serial_alert_deals(p_subscription_id uuid)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub public.alert_subscriptions%ROWTYPE;
  v_price_only boolean;
BEGIN
  SELECT * INTO v_sub FROM public.alert_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND OR NOT public.alert_sub_is_exact_serial(v_sub.min_serial, v_sub.max_serial, v_sub.collection_ids) THEN
    RETURN;
  END IF;
  v_price_only := (v_sub.max_price IS NOT NULL AND COALESCE(v_sub.min_discount, 25) = 0);

  RETURN QUERY
  WITH ev AS (
    -- Every open Atlas listing of the window's serials, one per Moment (its newest listing —
    -- the ts_listings rule), seen in the last 24 h (idx_tame_open_listing_serial).
    SELECT DISTINCT ON (x.nft_id)
           x.nft_id, x.price_cents, x.listed_at, x.last_seen_at, x.serial_number, x.atlas_edition_id, x.parallel, x.tier
      FROM public.topshot_atlas_market_events x
     WHERE x.product = 'nba' AND x.kind = 'listing' AND NOT x.completed AND x.nft_id IS NOT NULL
       AND x.price_cents > 0
       AND x.serial_number BETWEEN v_sub.min_serial AND v_sub.max_serial
       AND x.last_seen_at > now() - interval '24 hours'
     ORDER BY x.nft_id, x.listed_at DESC NULLS LAST, x.last_seen_at DESC
  ),
  cand AS (
    SELECT ev.*, round(ev.price_cents::numeric / 100, 2) AS ask_usd,
           m.external_id AS ext, e.id AS edition_id, e.player_name, e.team_name, e.set_name,
           e.tier::text AS e_tier, e.circulation_count, e.jersey_number, e.thumbnail_url
      FROM ev
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
      JOIN public.editions e ON e.id = m.rpc_edition_id AND e.collection_id = c_ts
     -- A NEW listing only (listed in the last 24 h): this is a "tell me when it is listed" alert,
     -- not a digest of the standing book (that is the Sniper's Serial # search).
     WHERE ev.listed_at > now() - interval '24 hours'
       -- Confirmed recently enough to wake a human: the serial-board window (12 h).
       AND public.ask_is_alertable('nba_top_shot:serial', ev.last_seen_at)
  ),
  priced AS (
    SELECT c.*, f.fmv_usd, f.confidence,
           (EXISTS (SELECT 1 FROM public.topshot_thin_fmv_editions tf WHERE tf.edition_id = c.edition_id)
            OR EXISTS (SELECT 1 FROM public.topshot_conflated_editions cf WHERE cf.edition_id = c.edition_id)) AS fmv_untrusted
      FROM cand c
      LEFT JOIN LATERAL (
        SELECT fs.fmv_usd, fs.confidence
          FROM public.fmv_snapshots fs
         WHERE fs.collection_id = c_ts AND fs.edition_id = c.edition_id AND fs.computed_at <= now()
         ORDER BY fs.computed_at DESC
         LIMIT 1
      ) f ON true
  ),
  scored AS (
    SELECT p.*,
           CASE WHEN p.fmv_usd > 0 THEN round((p.fmv_usd - p.ask_usd) / p.fmv_usd * 100, 1) END AS discount_pct,
           CASE WHEN p.fmv_usd > 0 THEN round(p.fmv_usd - p.ask_usd, 2) END AS discount_usd
      FROM priced p
  )
  SELECT jsonb_build_object(
           'external_id', s.ext, 'player_name', COALESCE(s.player_name, s.team_name), 'set_name', s.set_name,
           'tier', COALESCE(s.tier, s.e_tier), 'collection_slug', 'nba-top-shot',
           'circulation_count', s.circulation_count, 'nft_id', s.nft_id, 'serial_number', s.serial_number,
           'kind', 'exact_serial',
           'ask_usd', s.ask_usd,
           -- Edition FMV: an arbitrary serial carries no serial premium model; the discount is vs this.
           'fmv_usd', CASE WHEN v_price_only THEN NULL ELSE s.fmv_usd END,
           'edition_fmv_usd', s.fmv_usd,
           'discount_pct', CASE WHEN v_price_only THEN NULL ELSE s.discount_pct END,
           'discount_usd', CASE WHEN v_price_only THEN NULL ELSE s.discount_usd END,
           'price_only', v_price_only,
           'listing_url', 'https://dapper.market/nba/moment/' || s.nft_id,
           'moment_url', '/moment/' || s.nft_id,
           'thumbnail_url', s.thumbnail_url,
           'ask_updated_at', s.last_seen_at,
           'listed_at', s.listed_at,
           'parallel', NULLIF(NULLIF(s.parallel, ''), 'Standard')
         )
    FROM scored s
   WHERE (v_price_only OR (
            s.fmv_usd > 0 AND s.confidence IN ('HIGH', 'MEDIUM') AND NOT s.fmv_untrusted
            AND s.discount_pct >= COALESCE(v_sub.min_discount, 25)))
     AND (v_sub.max_price IS NULL OR s.ask_usd <= v_sub.max_price)
     AND (v_sub.min_price IS NULL OR s.ask_usd >= v_sub.min_price)
     AND (v_sub.tiers IS NULL OR COALESCE(s.tier, s.e_tier) = ANY(v_sub.tiers))
     AND (v_sub.player_names IS NULL OR lower(COALESCE(s.player_name, s.team_name)) = ANY(ARRAY(SELECT lower(y) FROM unnest(v_sub.player_names) y)))
     AND (v_sub.set_names IS NULL OR EXISTS (
       SELECT 1 FROM unnest(v_sub.set_names) sx WHERE lower(s.set_name) LIKE '%' || lower(sx) || '%'
     ))
     AND (v_sub.parallel_names IS NULL OR lower(s.parallel) = ANY(ARRAY(SELECT lower(y) FROM unnest(v_sub.parallel_names) y)))
     AND (v_sub.team_names IS NULL OR lower(s.team_name) = ANY(ARRAY(SELECT lower(y) FROM unnest(v_sub.team_names) y)))
     AND (NOT COALESCE(v_sub.require_last_mint, false) OR (s.circulation_count > 1 AND s.serial_number = s.circulation_count))
     AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR s.jersey_number = s.serial_number)
     AND (NOT COALESCE(v_sub.require_never_sold, false) OR NOT EXISTS (
       SELECT 1 FROM public.sales sa WHERE sa.nft_id = s.nft_id
     ))
     AND (v_sub.badges IS NULL OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(public.get_edition_badges_unified(s.edition_id)) AS bj(elem)
        WHERE regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
     ))
   ORDER BY s.discount_pct DESC NULLS LAST, s.ask_usd ASC, s.nft_id
   LIMIT 25;
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
  -- audit_20261014: per-subscription repeat policy (alert_subscriptions.notify_mode).
  v_mode text;
  v_fp text;
  v_dedup text;
  v_prev jsonb;
  v_suppressed int := 0;
  -- audit_20261114: pass 3 (exact-serial listings, Top Shot) — see topshot_exact_serial_alert_deals.
  v_exact boolean;
  v_exact_enqueued int := 0;
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
      'suppressed_unchanged', 0,
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
    -- 🚨 audit_20261014 — THE REPEAT. dedup_bucket alone is the UTC calendar day,
    -- so a listing that never changed was "new" every midnight: two subscribers
    -- got the same edition 14 days running (nba_top_shot:58:1975 and
    -- 236:7937::17, 09-30 → 10-13), and webz_80 reported it twice (beta 10792,
    -- 10795). The alerts form offered "Daily / Weekly digest" and nothing read
    -- it. notify_mode is now the honoured policy:
    --   new_listing (default) — fire when the LISTING differs from the last one
    --     sent for this subject on this channel: another moment (nft_id, or
    --     serial when no id is on the row) or another ask price. Unchanged ⇒
    --     suppressed and counted. Read from alert_deliveries, so the switch-over
    --     did not re-send every standing listing once more.
    --   once — first delivery per subject per channel, never again.
    --   daily — the old behaviour, kept for whoever wants the reminder.
    v_mode := COALESCE(v_sub.notify_mode, 'new_listing');

    IF v_sub.collection_ids IS NULL THEN
      v_slugs := ARRAY(SELECT slug FROM public.collections WHERE is_active = true);
    ELSE
      v_slugs := ARRAY(SELECT slug FROM public.collections WHERE id = ANY(v_sub.collection_ids));
    END IF;

    -- "Just a price, no FMV condition."
    v_price_only := (v_sub.max_price IS NOT NULL AND COALESCE(v_sub.min_discount, 25) = 0);
    -- audit_20261114: a NARROW serial window (<= 10 serials) on Top Shot is served by pass 3 from
    -- every open listing of those serials, so pass 1 stops offering Top Shot edition low asks to it
    -- (the same listing would otherwise arrive twice under two subject keys).
    v_exact := public.alert_sub_is_exact_serial(v_sub.min_serial, v_sub.max_serial, v_sub.collection_ids);

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
          AND NOT (v_exact AND p.collection_slug = 'nba_top_shot')
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
          -- audit_20261113: a SERIAL constraint binds pass 1 too. Pass 1 sends the
          -- edition's lowest ask and labels it with that listing's serial, but it
          -- never read min_serial / max_serial / require_last_mint /
          -- require_jersey_serial — so a "serial 111" alert received every
          -- discounted edition in the collection, each with a random serial
          -- (support_conversations 12524, 11-11). The listing pass 1 offers is the
          -- low ask, so the constraint is tested on low_ask_serial; a NULL serial
          -- (unknown, e.g. most Pinnacle asks) cannot satisfy one, so nothing is
          -- sent rather than a guess. Same predicates as pass 2.
          AND (v_sub.min_serial IS NULL OR p.low_ask_serial >= v_sub.min_serial)
          AND (v_sub.max_serial IS NULL OR p.low_ask_serial <= v_sub.max_serial)
          AND (NOT COALESCE(v_sub.require_last_mint, false)
               OR (p.circulation_count > 1 AND p.low_ask_serial = p.circulation_count))
          AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR EXISTS (
            SELECT 1 FROM public.editions e
            JOIN public.collections c ON c.id = e.collection_id
            WHERE e.external_id = p.external_id
              AND c.slug = p.collection_slug
              AND e.jersey_number = p.low_ask_serial
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

        -- The listing's identity: the moment on the ask (pass 2 always has
        -- nft_id; pass 1 has low_ask_nft_id where the board carries one) and the
        -- ask itself (low_ask in pass 1, ask_usd in pass 2), to the cent.
        v_fp := COALESCE(v_deal->>'nft_id', '#' || COALESCE(v_deal->>'serial_number', ''))
                || '@' || COALESCE(round(COALESCE(v_deal->>'low_ask', v_deal->>'ask_usd')::numeric, 2)::text, '');
        IF v_mode = 'daily' THEN
          v_dedup := v_bucket;
        ELSE
          SELECT d.payload->'deal' INTO v_prev
          FROM public.alert_deliveries d
          WHERE d.owner_key = v_sub.owner_key AND d.channel = v_channel
            AND d.alert_kind = 'deal' AND d.subject_key = v_subject
            AND d.status IS DISTINCT FROM 'failed'
          ORDER BY d.created_at DESC
          LIMIT 1;
          IF v_prev IS NOT NULL AND (
               v_mode = 'once'
               OR (COALESCE(v_prev->>'nft_id', '#' || COALESCE(v_prev->>'serial_number', ''))
                   || '@' || COALESCE(round(COALESCE(v_prev->>'low_ask', v_prev->>'ask_usd')::numeric, 2)::text, '')) = v_fp
             ) THEN
            v_suppressed := v_suppressed + 1;
            CONTINUE;
          END IF;
          -- The day stays in the key so two overlapping ticks still collide on
          -- the unique index; the fingerprint lets a CHANGED listing through the
          -- same day.
          v_dedup := CASE WHEN v_mode = 'once' THEN 'once' ELSE v_bucket || ':' || v_fp END;
        END IF;

        INSERT INTO public.alert_deliveries
          (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
        VALUES (
          v_sub.owner_key, v_channel, v_target, 'deal',
          v_subject, v_dedup,
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
          AND (NOT COALESCE(v_sub.require_last_mint, false) OR (b.circulation_count > 1 AND b.serial_number = b.circulation_count))
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

          -- The listing's identity: the moment on the ask (pass 2 always has
          -- nft_id; pass 1 has low_ask_nft_id where the board carries one) and the
          -- ask itself (low_ask in pass 1, ask_usd in pass 2), to the cent.
          v_fp := COALESCE(v_deal->>'nft_id', '#' || COALESCE(v_deal->>'serial_number', ''))
                  || '@' || COALESCE(round(COALESCE(v_deal->>'low_ask', v_deal->>'ask_usd')::numeric, 2)::text, '');
          IF v_mode = 'daily' THEN
            v_dedup := v_bucket;
          ELSE
            SELECT d.payload->'deal' INTO v_prev
            FROM public.alert_deliveries d
            WHERE d.owner_key = v_sub.owner_key AND d.channel = v_channel
              AND d.alert_kind = 'deal' AND d.subject_key = v_subject
              AND d.status IS DISTINCT FROM 'failed'
            ORDER BY d.created_at DESC
            LIMIT 1;
            IF v_prev IS NOT NULL AND (
                 v_mode = 'once'
                 OR (COALESCE(v_prev->>'nft_id', '#' || COALESCE(v_prev->>'serial_number', ''))
                     || '@' || COALESCE(round(COALESCE(v_prev->>'low_ask', v_prev->>'ask_usd')::numeric, 2)::text, '')) = v_fp
               ) THEN
              v_suppressed := v_suppressed + 1;
              CONTINUE;
            END IF;
            -- The day stays in the key so two overlapping ticks still collide on
            -- the unique index; the fingerprint lets a CHANGED listing through the
            -- same day.
            v_dedup := CASE WHEN v_mode = 'once' THEN 'once' ELSE v_bucket || ':' || v_fp END;
          END IF;

          INSERT INTO public.alert_deliveries
            (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
          VALUES (
            v_sub.owner_key, v_channel, v_target, 'deal',
            v_subject, v_dedup,
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

    -- Pass 3 (audit_20261114): EXACT-SERIAL LISTINGS. A narrow serial window on Top Shot
    -- ("alert me when #111 is listed") is matched against every open Atlas listing of those
    -- serials (topshot_exact_serial_alert_deals), not just each edition's lowest ask. Same
    -- subject key and fingerprint as pass 2, so a listing both passes find is sent once.
    IF v_exact THEN
      FOR v_deal IN SELECT x FROM public.topshot_exact_serial_alert_deals(v_sub.id) x LOOP
        v_subject := (v_deal->>'collection_slug') || ':' || (v_deal->>'external_id')
                     || ':#' || (v_deal->>'serial_number');
        FOREACH v_channel IN ARRAY v_sub.channels LOOP
          SELECT channel_user_id INTO v_target
          FROM public.notification_channels
          WHERE owner_key = v_sub.owner_key AND channel = v_channel
            AND verified = true AND channel_user_id IS NOT NULL
          LIMIT 1;

          IF v_target IS NULL THEN CONTINUE; END IF;

          v_fp := COALESCE(v_deal->>'nft_id', '#' || COALESCE(v_deal->>'serial_number', ''))
                  || '@' || COALESCE(round(COALESCE(v_deal->>'low_ask', v_deal->>'ask_usd')::numeric, 2)::text, '');
          IF v_mode = 'daily' THEN
            v_dedup := v_bucket;
          ELSE
            SELECT d.payload->'deal' INTO v_prev
            FROM public.alert_deliveries d
            WHERE d.owner_key = v_sub.owner_key AND d.channel = v_channel
              AND d.alert_kind = 'deal' AND d.subject_key = v_subject
              AND d.status IS DISTINCT FROM 'failed'
            ORDER BY d.created_at DESC
            LIMIT 1;
            IF v_prev IS NOT NULL AND (
                 v_mode = 'once'
                 OR (COALESCE(v_prev->>'nft_id', '#' || COALESCE(v_prev->>'serial_number', ''))
                     || '@' || COALESCE(round(COALESCE(v_prev->>'low_ask', v_prev->>'ask_usd')::numeric, 2)::text, '')) = v_fp
               ) THEN
              v_suppressed := v_suppressed + 1;
              CONTINUE;
            END IF;
            v_dedup := CASE WHEN v_mode = 'once' THEN 'once' ELSE v_bucket || ':' || v_fp END;
          END IF;

          INSERT INTO public.alert_deliveries
            (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
          VALUES (
            v_sub.owner_key, v_channel, v_target, 'deal',
            v_subject, v_dedup,
            jsonb_build_object('subscription_id', v_sub.id, 'label', v_sub.label, 'deal', v_deal)
          )
          ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

          IF FOUND THEN
            v_enqueued := v_enqueued + 1;
            v_exact_enqueued := v_exact_enqueued + 1;
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
    'suppressed_unchanged', v_suppressed,
    'exact_serial_enqueued', v_exact_enqueued,
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
  v_exact boolean;
  v_exact_deals jsonb;
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
  -- audit_20261114: mirrors the sender — a narrow Top Shot serial window is served by pass 3.
  v_exact := public.alert_sub_is_exact_serial(v_sub.min_serial, v_sub.max_serial, v_sub.collection_ids);

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
          AND NOT (v_exact AND p.collection_slug = 'nba_top_shot')
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
          -- audit_20261113: a SERIAL constraint binds pass 1 too. Pass 1 sends the
          -- edition's lowest ask and labels it with that listing's serial, but it
          -- never read min_serial / max_serial / require_last_mint /
          -- require_jersey_serial — so a "serial 111" alert received every
          -- discounted edition in the collection, each with a random serial
          -- (support_conversations 12524, 11-11). The listing pass 1 offers is the
          -- low ask, so the constraint is tested on low_ask_serial; a NULL serial
          -- (unknown, e.g. most Pinnacle asks) cannot satisfy one, so nothing is
          -- sent rather than a guess. Same predicates as pass 2.
          AND (v_sub.min_serial IS NULL OR p.low_ask_serial >= v_sub.min_serial)
          AND (v_sub.max_serial IS NULL OR p.low_ask_serial <= v_sub.max_serial)
          AND (NOT COALESCE(v_sub.require_last_mint, false)
               OR (p.circulation_count > 1 AND p.low_ask_serial = p.circulation_count))
          AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR EXISTS (
            SELECT 1 FROM public.editions e
            JOIN public.collections c ON c.id = e.collection_id
            WHERE e.external_id = p.external_id
              AND c.slug = p.collection_slug
              AND e.jersey_number = p.low_ask_serial
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
        AND (NOT COALESCE(v_sub.require_last_mint, false) OR (b.circulation_count > 1 AND b.serial_number = b.circulation_count))
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

  -- Pass 3 preview (audit_20261114): exact-serial listings, merged into serial_deals (same
  -- per-serial payload shape); a Moment pass 2 already lists is not repeated.
  IF v_exact THEN
    SELECT jsonb_agg(x) INTO v_exact_deals
    FROM public.topshot_exact_serial_alert_deals(p_subscription_id) x
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_serial_deals, '[]'::jsonb)) s
      WHERE s->>'nft_id' = x->>'nft_id'
    );
    IF v_exact_deals IS NOT NULL THEN
      v_serial_deals := COALESCE(v_serial_deals, '[]'::jsonb) || v_exact_deals;
    END IF;
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
    'serial_deals', COALESCE(v_serial_deals, '[]'::jsonb),
    'exact_serial', COALESCE(v_exact, false),
    'exact_serial_deals_count', COALESCE(jsonb_array_length(v_exact_deals), 0)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.alert_sub_is_exact_serial(integer, integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alert_sub_is_exact_serial(integer, integer, uuid[]) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.topshot_exact_serial_alert_deals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_exact_serial_alert_deals(uuid) TO postgres, service_role;
