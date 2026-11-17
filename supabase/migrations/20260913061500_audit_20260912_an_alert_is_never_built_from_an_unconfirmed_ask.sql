-- audit_20260912_an_alert_is_never_built_from_an_unconfirmed_ask
--
-- A TELEGRAM ALERT TOLD TREVOR A MOMENT WAS $0.50 WHEN THE FLOOR WAS $1.03, AND
-- IT DID SO FOUR NIGHTS RUNNING. Reported 2026-09-12 PT with the screenshot.
-- Measured from `alert_deliveries` the same night -- the SAME row, four times:
--
--   built 09-09 23:14Z  ask $0.60  ask_updated_at 09-09 23:08Z   (6 min old -- REAL)
--   built 09-10 00:14Z  ask $0.60  ask_updated_at 09-09 23:08Z
--   built 09-11 02:27Z  ask $0.50  ask_updated_at 09-10 04:48Z   (21.6 h old)
--   built 09-12 02:31Z  ask $0.50  ask_updated_at 09-10 04:48Z   (45.7 h old)
--   built 09-13 01:16Z  ask $0.50  ask_updated_at 09-10 04:48Z   (68.5 h old)
--
-- and the live row at 09-13 06:02Z reads `low_ask 1.03, low_ask_serial 8442,
-- updated_at 09-13 04:50Z`. So the listing the alert pointed at was gone -- it is
-- the one Trevor bought -- and the price it quoted was wrong by 2x.
--
-- ⚠ THE MESSAGE WAS NOT LYING, AND THAT IS WHY THIS IS A SCANNER FIX RATHER THAN
-- A COPY FIX. `lib/alerts/format.ts` already rendered "ask seen 3d ago -- may be
-- gone" on that line, from the same `ask_updated_at` this migration now gates on.
-- The freshness marker shipped 2026-09-04 and its own header says the DROP
-- threshold was left as "a product threshold (Trevor's)". This is that decision,
-- taken: a notification is the one surface that cannot report-and-let-the-reader
-- judge. The boards report; an alert tells you to go buy something. **If the site
-- would stamp an ask stale, we do not wake anyone up about it.**
--
-- ⭐ THE THRESHOLD IS NOT A NEW NUMBER. It is `ASK_STALE_HOURS` = 12 from
-- `lib/market/ask-freshness.ts`, the marker every ask-age caption on the site
-- already uses, so an alert and the board it links to cannot disagree about what
-- "stale" means. `__tests__/alert-ask-gate-matches-the-site-wide-stale-marker.test.ts`
-- fails if the two drift apart.
--
-- ⭐ THE GATE ALSO FIXES THE REPEAT, WITHOUT TOUCHING THE DEDUPE, and that is the
-- reason to prefer it to a dedupe change. `dedup_bucket` is
-- `to_char(now(),'YYYY-MM-DD')` -- one calendar day -- so ANY row that stays in
-- the pool re-fires every night forever. The rows that do that are exactly the
-- rows nobody is re-confirming: a live ask changes, sells, or gets re-priced, and
-- a frozen one does not. Gating on confirmation removes the only rows capable of
-- repeating. The 09-09 alert -- ask 6 minutes old -- still fires, unchanged.
--
-- ── WHY THE ASKS WENT STALE (context; NOT fixed here) ───────────────────────
-- `offers-sweep`, the lane that wrapped the whole Top Shot catalogue 8-18x/day,
-- has written NOTHING since 2026-08-28: `public-api.nbatopshot.com` answers 530 /
-- Cloudflare 1033 (register #81), and it stopped running at all after 09-07.
-- `edition_offers.low_ask` is now maintained by `sync_edition_offers_from_atlas()`
-- (pg_cron 466, every 2 min) whose verify lane re-reads ~2 editions a tick --
-- ~1,440/day against 12,940 rows with an ask, i.e. a ~9-DAY WRAP. Atlas cannot
-- simply be cranked: #65 measured Cloudflare's managed challenge on that egress as
-- burst-sensitive (a 60-request burst took it to 100% 403 for ~4 minutes).
-- MEASURED 2026-09-13 06:02Z, `edition_offers` Top Shot, 12,940 rows with an ask:
-- median age 63.8 h, 1,634 (12.6%) within 12 h, 8,701 (67%) older than 48 h.
-- ⭐ So a 3-day-old Top Shot ask is not an anomaly today -- it is the DESIGN
-- CADENCE, which is exactly why the alert path must stop treating one as news.
--
-- ── THE ASYMMETRY BETWEEN ARMS IS DELIBERATE. DO NOT "FIX" IT. ──────────────
-- 🚨 The four arms' timestamps do not mean the same thing, and a blanket recency
-- predicate would be WRONG on half of them:
--   * Top Shot   `edition_offers.updated_at`        = LAST CONFIRMED. Gated.
--   * Pinnacle   `pinnacle_catalog.floor_ask_updated_at` = LAST CONFIRMED. Gated.
--   * All Day    `cached_listings_v2.listed_at`     = WHEN THE SELLER LISTED IT.
--   * Golazos    `cached_listings_v2.listed_at`     = same.
-- The All Day and Golazos arms are `DISTINCT ON (edition_id)` over an
-- event-sourced OPEN-listing index (`completed_at IS NULL AND (expiry_at IS NULL
-- OR expiry_at > now())`): a row LEAVES the book when the listing sells, so a
-- 6-week-old `listed_at` describes a listing that is still open, not one nobody
-- checked. MEASURED the same night on the ≤$0.60 price pool: All Day 1,956 rows,
-- median `listed_at` age 814.7 h, only 19 inside 12 h. A blanket gate would have
-- deleted 1,937 CORRECT rows to fix 3,118 wrong Top Shot ones. Their freshness
-- question is "is the INDEXER running" (allday-offers-indexer: 191 runs/72 h,
-- healthy), which is a lane-level question and not this predicate's job.
-- ⚠ `format.ts` records the same split in the other direction -- it says "seen"
-- rather than "verified" precisely because the stamp means two things.
--
-- ⭐ THE GATE FAILS CLOSED, BY CONSTRUCTION. The CASE lists the EXEMPT arms and
-- gates everything else, rather than listing the gated ones. So a new collection,
-- a typo, or the OTHER collection-string convention (`nba-top-shot` with hyphens
-- -- both spellings are live in this codebase and the scanners' own payloads carry
-- the hyphen form) is GATED, not waved through. Writing it the obvious way round
-- would mean a misspelling silently disables the gate, which is the failure this
-- estate keeps paying for. A NULL stamp is likewise NOT alertable: "unknown is not
-- stale" is the right rule for RENDERING a marker (`isAskStale`) and the wrong one
-- for DECIDING TO WAKE SOMEONE UP.
--
-- ── WHAT CHANGES, MEASURED 2026-09-13 06:0xZ ────────────────────────────────
--   price pool (≤$0.60): Top Shot 3,850 -> 732 alertable; All Day 1,956 -> 1,956.
--   deals board:         Top Shot    87 ->  12 alertable; Pinnacle 81 -> 81
--                        (median 4.4 h -- the gate is a NO-OP on a healthy arm,
--                         which is the property to want); All Day 19 -> 19.
--   serial board:        16 rows, all `last_seen_at` within 1.6 h -> 16.
-- ⚠ Blast radius is TWO subscriptions, both Trevor's, both telegram (the only
-- active rows in `alert_subscriptions` on 2026-09-13).
--
-- ⭐ THE SUPPRESSION IS COUNTED, NOT SILENT. Three new keys --
-- `deal_pool_unconfirmed`, `price_pool_unconfirmed`, `serial_pool_unconfirmed` --
-- ride the dispatcher's return jsonb into `pipeline_runs.extra`, so "the alerts
-- went quiet" can be told apart from "the alerts went quiet BECAUSE 86% of the
-- Top Shot board is unconfirmed". Fixing a guard without fixing the field an
-- observer keys on leaves the incidence unmeasurable. `*_pool_size` keeps its old
-- meaning (rows BUILT) so its history stays comparable.
--
-- ROLLBACK -- one statement, no deploy, and it restores the old behaviour exactly:
--
--   CREATE OR REPLACE FUNCTION public.ask_is_alertable(text, timestamptz, timestamptz)
--   RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
--   AS 'SELECT true';
--
-- Both scanners then admit every row again, the counters read 0, and nothing else
-- needs touching. The full code revert is `git revert` on this migration's commit
-- (find it by message -- pre-2026-08-03 shas no longer resolve) plus
-- `DROP FUNCTION public.ask_is_alertable(text, timestamptz, timestamptz);`.

--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⛔ CORRECTED 2026-09-13 by audit_20260913_the_ask_stamp_means_three_different_things.
-- RESTATED RATHER THAN DELETED, because the failure mode is the lesson.
--
-- THE HEADER ABOVE SAYS THIS GATE MEANS "nobody has re-confirmed this ask". That
-- is TRUE for Pinnacle and FALSE for Top Shot, the biggest arm. Read from the
-- writers rather than the column name: `sync_edition_offers_from_atlas()` upserts
-- under `WHERE low_ask IS DISTINCT FROM EXCLUDED.low_ask`, so
-- `edition_offers.updated_at` is bumped ONLY WHEN THE FLOOR CHANGES — it is a
-- LAST-CHANGED stamp with a last-confirmed name — and
-- `raise_edition_offers_from_chain()` bumps the same column when the OFFER moves.
-- It WAS a confirmation stamp until 2026-08-28, when `offers-sweep` (which stamped
-- every row it wrapped) died and the Atlas writer replaced it: the meaning changed
-- because the WRITER changed, and nothing reds when a name stays put.
--
-- ✅ THE BODY BELOW IS UNCHANGED AND CORRECT AS SHIPPED. Its Top Shot rule reads
-- "the floor CHANGED inside 12 h", which still removes the defect it was built for
-- (one frozen row re-sent four nights running) and still fires on discoveries — a
-- new cheap listing bumps the stamp at the moment we learn of it. Only the STATED
-- REASON was wrong, and the live COMMENT ON FUNCTION now says so.
--
-- ⚠ ALSO CORRECTED: the "~9-DAY WRAP" figure below describes the per-edition
-- VERIFY lane (~2 editions / 2 min), not the ask writer. The Atlas sync is a BULK
-- upsert from the firehose every 2 min; what it does not do is stamp a row whose
-- price has not moved. The median-age numbers are unaffected — they were measured,
-- not derived — but they measure age-since-CHANGE, so do not read "median 63.8 h"
-- as "nobody has looked at these in 63.8 h".
-- ═══════════════════════════════════════════════════════════════════════════
-- ── 1. The predicate, in ONE place ──────────────────────────────────────────
--
-- ⚠ ONE SPELLING, ON PURPOSE. The repo's standing rule is that a duplicated
-- expression spreads by copy-paste (five times and counting) and that a comment
-- is only read by someone already in that file. This predicate is needed in FIVE
-- places across two functions, so it is a function, and the threshold appears
-- exactly once in the estate's SQL.
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
    -- EXEMPT: event-sourced open-listing books. The stamp is the seller's
    -- listing date, not a confirmation, and the row leaves the view when the
    -- listing closes. See the header -- gating these deletes correct rows.
    WHEN p_collection_slug IN ('nfl_all_day', 'laliga_golazos') THEN true
    -- Everything else must have been CONFIRMED inside ASK_STALE_HOURS (12 h,
    -- lib/market/ask-freshness.ts). Unknown (NULL) is not alertable.
    ELSE p_ask_at IS NOT NULL AND p_ask_at > p_now - interval '12 hours'
  END
$function$;

COMMENT ON FUNCTION public.ask_is_alertable(text, timestamptz, timestamptz) IS
  'True when an ask has been CONFIRMED recently enough to wake a human about. '
  '12 h mirrors ASK_STALE_HOURS in lib/market/ask-freshness.ts, so an alert and '
  'the board it links to cannot disagree about "stale". nfl_all_day and '
  'laliga_golazos are EXEMPT because their stamp is listed_at over an '
  'event-sourced OPEN-listing index, not a confirmation -- gating them would drop '
  '1,937 of 1,956 correct rows (measured 2026-09-13). The CASE lists the EXEMPT '
  'arms so an unknown or misspelled slug fails CLOSED; a NULL stamp is not '
  'alertable. Boards must keep RENDERING stale asks with their age marker -- this '
  'is only about what may be sent as a notification (audit_20260912).';

REVOKE EXECUTE ON FUNCTION public.ask_is_alertable(text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ask_is_alertable(text, timestamptz, timestamptz)
  TO postgres, service_role;

-- ── 2. The SENDING half ─────────────────────────────────────────────────────
--
-- anon-exec: unchanged — dispatch_due_deal_alerts is RE-CREATED here, not
-- created, and `CREATE OR REPLACE` does not reset a function ACL, so a REVOKE in
-- this file would change production rather than describe it. VERIFIED LIVE after
-- applying (has_function_privilege): anon EXECUTE false, authenticated EXECUTE
-- false, service_role true — which is what a cron-only SECDEF scanner should
-- have, so there is nothing to change. Same for
-- build_deal_alerts_for_subscription in section 3.
--
-- Re-read from the live prosrc immediately before writing this file (md5
-- 24ab9e7953c0005b10e987cbea62307e, 13,203 chars -- byte-identical to the md5 the
-- 2026-08-17 pin recorded, so no other session had touched it). The ONLY changes
-- against that body are the `alertable` column on both temp pools, the three
-- unconfirmed counters, and `AND p.alertable` / `AND b.alertable` in the two
-- selection passes.
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
  CREATE TEMP TABLE tmp_serial_pool ON COMMIT DROP AS
    SELECT s.*,
           public.ask_is_alertable('nba_top_shot', s.last_seen_at) AS alertable
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
    -- Cheap predicates narrow to 500 candidates first so the per-row badge fn
    -- is bounded; team/badge EXISTS then applies before the final LIMIT 25.
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
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        LIMIT 500
      ) b
      WHERE (v_sub.parallel_names IS NULL OR lower(COALESCE(
              (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                 WHERE be.external_id = b.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
              CASE WHEN b.collection_slug = 'disney_pinnacle' THEN b.tier END
            )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
        AND (v_sub.team_names IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
        ))
        AND (v_sub.badges IS NULL OR EXISTS (
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

-- ── 3. The PREVIEW half ─────────────────────────────────────────────────────
--
-- anon-exec: unchanged — build_deal_alerts_for_subscription is RE-CREATED, not
-- created; see section 2. Verified live after applying: anon EXECUTE false,
-- authenticated EXECUTE false, service_role true.
--
-- Re-read from the live prosrc immediately before writing this file (md5
-- f17cfe05e4ab8d88e05fd56f7ce021c8, 8,943 chars). The ONLY changes are the two
-- `ask_is_alertable` predicates.
--
-- ⚠ THE PREVIEW MUST AGREE WITH THE DISPATCHER OR IT BECOMES THE LIE. It answers
-- "what would this subscription send me right now", and a preview listing rows
-- the sender is gated against would be a promise nothing keeps -- the same shape
-- as the 2026-08-16 defect this function was pinned for, one level up.
--
-- ⚠ STATED LIMITATION, so nobody reads its absence as zero: this function does
-- NOT report how many rows the gate hid. Counting them exactly needs a second
-- pass over the same union (the LIMIT 25 is applied before aggregation, so a
-- carried flag would let unconfirmed rows eat the preview's slots), and an
-- approximate count computed from the cheap predicates only would OVERSTATE.
-- The exact numbers are on the dispatcher, in `pipeline_runs.extra`
-- (`deal_pool_unconfirmed` / `price_pool_unconfirmed` / `serial_pool_unconfirmed`).
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
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        LIMIT 500
      ) b
      WHERE (v_sub.parallel_names IS NULL OR lower(COALESCE(
              (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                 WHERE be.external_id = b.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
              CASE WHEN b.collection_slug = 'disney_pinnacle' THEN b.tier END
            )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
        AND (v_sub.team_names IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
        ))
        AND (v_sub.badges IS NULL OR EXISTS (
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
        -- ⚠ The LONG-FORM slug on purpose: this board's payload says
        -- 'nba-top-shot' (hyphens) and the gate's exempt-list is long-form, so
        -- passing the payload's spelling would gate correctly by accident here
        -- and read as an endorsement of mixing the two conventions.
        AND public.ask_is_alertable('nba_top_shot', b.last_seen_at)
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
