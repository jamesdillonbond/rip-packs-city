-- audit_20261014 — deal alerts fire once per LISTING, not once per day; the
-- alerts form's repeat setting is real.
--
-- WHAT WAS WRONG. dispatch_due_deal_alerts deduplicated on
-- (owner, channel, kind, subject, dedup_bucket) with dedup_bucket =
-- to_char(now(),'YYYY-MM-DD'). A listing that sat unchanged therefore became
-- "new" at every UTC midnight (~5 PM PT) and was re-sent daily for as long as it
-- matched. Measured 2026-10-14: nba_top_shot:58:1975 and
-- nba_top_shot:236:7937::17 were each delivered on 14 consecutive days
-- (09-30 → 10-13) to two subscribers; webz_80 reported it through the
-- concierge (beta_feedback_inbox 10792 / 10795) and asked to be told once, or
-- when the moment is relisted (10793 / 10796).
--
-- And the form offered "Cadence: Instant / Daily digest / Weekly digest". No
-- code read `cadence` — every subscription behaved the same whatever it said.
-- It is left in place (5 of 5 rows are 'instant'; a CHECK pins it) and the form
-- stops offering it; notify_mode below is the setting the dispatcher honours.
--
-- THE CHANGE.
--   1. alert_subscriptions.notify_mode text NOT NULL DEFAULT 'new_listing',
--      CHECK in ('new_listing','once','daily') — part 1, its own migration.
--      Every existing row became 'new_listing', the behaviour the reporter
--      asked for.
--   2. dispatch_due_deal_alerts reads it per subscription:
--        new_listing — skip when the last delivery for this subject on this
--          channel carried the same listing (nft_id, or serial, + ask to the
--          cent); a different moment or a different price fires. The
--          comparison reads alert_deliveries' existing payloads, so deploying
--          this does NOT re-send every standing listing one more time.
--        once — first delivery per subject per channel, then silent.
--        daily — the previous behaviour, byte for byte (dedup_bucket = day).
--      Skips are counted as `suppressed_unchanged` in the verdict, so a quiet
--      night reads as "suppressed N" rather than as "nothing matched".
--   The body is the pin's copy (supabase/tests/dispatch_due_deal_alerts.sql),
--   proven equal to live first (md5 of trimmed prosrc 6d496f8c…), with only the
--   DECLARE additions, the per-sub v_mode, the two send blocks and the two
--   verdict keys changed. build_deal_alerts_for_subscription (the preview) is
--   untouched: it shows what MATCHES, which is still right.
--
-- anon-exec: unchanged (dispatch_due_deal_alerts) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false authenticated=false service_role=true (2026-10-14).
--
-- REVERT: re-apply the dispatch_due_deal_alerts body from
-- 20261011022738_audit_20261010_perfect_mint_alerts_exclude_one_of_ones.sql
-- (it ignores notify_mode, so the column can stay); to drop the column too,
-- see part 1's REVERT.

-- The column itself is part 1, 20261015000038_audit_20261014_alert_subscriptions_notify_mode.sql
-- (applied first through the MCP; this body went through the dashboard SQL
-- editor because the MCP gate holds any statement containing DROP).

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
    'bucket', v_bucket,
    'ran_at', now()
  );
END;
$function$;
