-- DB invariant: public.build_deal_alerts_for_subscription(uuid) → jsonb — the
-- PREVIEW half of the deal-alert pipeline (the dispatcher calls the same two
-- pools). Pins the two defects the 2026-08-16 migration fixed, both of which
-- made a saved, "live"-looking alert structurally incapable of firing:
--
--   1. PRICE-ONLY ROUTING. `max_price` set with `min_discount = 0` means "just a
--      price, no FMV condition". Before the fix both passes read
--      cross_collection_deals_board, which is a DEALS board by construction
--      ($5 floor, low_ask < fmv, confidence IN (HIGH,MEDIUM)) — so a $0.60 alert
--      intersected an empty set while 2,640 Top Shot asks at or below $0.60
--      existed. A price-only sub must read edition_current_ask, the raw ask
--      universe, and must see a row whose fmv_usd/confidence are NULL.
--   2. SET-NAME CONTAINMENT. `set_names` matched with `lower(set_name) = ANY(…)`
--      — exact equality — so the saved filter "Archive" never matched the real
--      catalogue set "Archive Set". Set filters are containment now.
--      ⚠ `player_names` stays EXACT, deliberately, and that asymmetry is pinned
--      here too: a fix that "tidied" both to LIKE would pass a test that only
--      checked the set case, and would silently widen every player alert.
--
-- Also pinned: the two pools are MUTUALLY EXCLUSIVE per subscription (a
-- price-only sub sees no deals-board row and vice versa), an inactive or
-- unknown subscription returns {"error":"not eligible"} rather than an empty
-- result set, and deals_count is the SUM of both passes.
--
-- ⚠ NOT pinned here, and recorded so nobody adds a vacuous version: the UNION
-- ALL between the two pools requires their column lists to be IDENTICAL in the
-- same order (verified live 2026-08-17 — both are the same 20 columns). This
-- file BUILDS both fixtures, so asserting they match would only assert that the
-- fixture matches itself. That check belongs against the live catalog, not here.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261113184535_audit_20261113_deal_alert_serial_filters_bind_pass_one.sql since
-- 2026-11-13; before it 20261011022738, then 20261001030000_audit_20260930_topshot_alert_asks_are_rechecked_before_they_are_sent.sql
-- since 2026-10-01; originally 20260816161500_audit_20260816_price_only_alerts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from
-- it. Verified 2026-08-17 that the migration's body is byte-identical to the
-- LIVE prosrc (md5 f17cfe05e4ab8d88e05fd56f7ce021c8, 8,943 chars) — a pin
-- against a stale migration would pin something production does not run.
-- Re-verified 2026-09-30 PT after the audit_20261001 apply: live = migration =
-- this copy, md5 26cffec8dc8ea4bd4ab92b2e39f57c6c, 10,291 chars.
--
-- ⚠ ALSO PINNED (2026-10-01, audit_20261001, #165): team and badge filters
-- find their match from behind 501 cheaper unrelated asks — the old body capped
-- the pool at 500 BEFORE those filters and fails both assertions.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

-- ⚠ ALSO PINNED HERE (2026-09-13, audit_20260912): THE PREVIEW HONOURS THE
-- SENDER'S FRESHNESS GATE. An ask nobody has re-confirmed inside ASK_STALE_HOURS
-- is not previewed, on either pass, and the re-stamped row is previewed again —
-- both directions, because a preview that lists rows `dispatch_due_deal_alerts`
-- will never enqueue is this function's ORIGINAL defect in a new costume: a
-- subscription that looks live and cannot fire.
-- Mutation-verified 2026-09-13: removing either `ask_is_alertable` predicate
-- fails a named assertion ('not previewed either' / 'last_seen_at IS a
-- confirmation').
--
-- ⛔ CORRECTED 2026-09-13 (audit_20260913_the_ask_stamp_means_three_different_things):
-- "re-confirmed" is TRUE for Pinnacle and FALSE for Top Shot. `edition_offers.updated_at`
-- is bumped ONLY WHEN THE FLOOR CHANGES (the Atlas writer's ON CONFLICT carries an
-- IS DISTINCT FROM guard), so on that arm this file pins "the floor CHANGED inside
-- ASK_STALE_HOURS". The assertions and the body are unchanged and still correct; the
-- WORD was wrong. It was a confirmation stamp until offers-sweep died on 2026-08-28 —
-- the column's meaning changed with its WRITER while its name stayed put.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text, is_active boolean);

CREATE TABLE editions (
  id              uuid PRIMARY KEY,
  collection_id   uuid,
  external_id     text,
  player_name     text,
  set_name        text,
  team_name       text,
  jersey_number   integer
);

CREATE TABLE badge_editions (external_id text, parallel_name text);

CREATE TABLE alert_subscriptions (
  id                     uuid PRIMARY KEY,
  owner_key              text,
  label                  text,
  channels               text[],
  collection_ids         uuid[],
  min_discount           numeric,
  max_price              numeric,
  tiers                  text[],
  cadence                text,
  active                 boolean,
  created_at             timestamptz,
  updated_at             timestamptz,
  last_run_at            timestamptz,
  player_names           text[],
  set_names              text[],
  team_names             text[],
  min_price              numeric,
  min_serial             integer,
  max_serial             integer,
  require_jersey_serial  boolean,
  require_last_mint      boolean,
  require_never_sold     boolean,
  require_low_ask        boolean,
  badges                 text[],
  parallel_names         text[],
  serial_only            boolean
);

-- The two alert pools. In production these are VIEWS with identical column
-- lists (that is what makes the UNION ALL legal); here they are tables of the
-- same shape and order, taken from the live catalog on 2026-08-17.
CREATE TABLE cross_collection_deals_board (
  external_id text, name text, player_name text, set_name text, tier text,
  circulation_count integer, fmv_usd numeric, confidence text, low_ask numeric,
  discount_pct numeric, discount_usd numeric, ask_updated_at timestamptz,
  collection_slug text, collection_name text, render_id text, detail_url text,
  thumbnail_url text, low_ask_serial integer, low_ask_nft_id text,
  low_confidence_fmv boolean
);

CREATE TABLE edition_current_ask (
  external_id text, name text, player_name text, set_name text, tier text,
  circulation_count integer, fmv_usd numeric, confidence text, low_ask numeric,
  discount_pct numeric, discount_usd numeric, ask_updated_at timestamptz,
  collection_slug text, collection_name text, render_id text, detail_url text,
  thumbnail_url text, low_ask_serial integer, low_ask_nft_id text,
  low_confidence_fmv boolean
);

CREATE TABLE topshot_underpriced_serials_board (
  edition_id uuid, edition_key text, external_id text, player_name text,
  set_name text, tier text, circulation_count integer, thumbnail_url text,
  nft_id text, serial_number integer, ask_usd numeric, listing_resource_id text,
  listing_url text, listed_at timestamptz, last_seen_at timestamptz,
  edition_fmv_usd numeric, confidence text, serial_bucket text,
  serial_fmv_usd numeric, serial_multiplier numeric, discount_usd numeric,
  discount_pct numeric, estimate_quality text
);

-- Dependency stub. The badge branches are guarded by `v_sub.badges IS NULL`,
-- but plpgsql PLANS the whole statement on first execution, so the function must
-- EXIST or every case fails on planning rather than on its invariant. Returning
-- an empty array keeps it inert; no case below sets `badges`.
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT '[]'::jsonb $$;

-- audit_20261114 (pass 3, exact-serial listings): the relations topshot_exact_serial_alert_deals reads,
-- and its two functions VERBATIM from 20261114171316 (registered in the drift guard for this file).
ALTER TABLE editions ADD COLUMN tier text, ADD COLUMN circulation_count integer, ADD COLUMN thumbnail_url text;
CREATE TABLE topshot_atlas_market_events (
  uuid text PRIMARY KEY DEFAULT gen_random_uuid()::text, product text, kind text, nft_id text, price_cents bigint,
  listed_at timestamptz, last_seen_at timestamptz, serial_number integer, atlas_edition_id text, parallel text,
  tier text, completed boolean DEFAULT false
);
CREATE TABLE topshot_atlas_edition_map (atlas_edition_id text PRIMARY KEY, rpc_edition_id uuid, external_id text);
CREATE TABLE fmv_snapshots (collection_id uuid, edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE topshot_thin_fmv_editions (edition_id uuid);
CREATE TABLE topshot_conflated_editions (edition_id uuid);
CREATE TABLE IF NOT EXISTS sales (nft_id text);

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

-- >>> BEGIN verbatim build_deal_alerts_for_subscription (keep byte-identical to the migration) >>>
-- The gate the scanner below calls. Verbatim from the same migration and
-- registered in __tests__/db-invariants-drift-guard.test.ts under its own PINS
-- entry for THIS file, so this copy cannot drift either.
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
-- <<< END verbatim build_deal_alerts_for_subscription <<<

-- ── fixture data ───────────────────────────────────────────────────────────
INSERT INTO collections (id, slug, is_active) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', true);

-- A DEALS-board row: a real discount, well above the board's $5 floor.
INSERT INTO cross_collection_deals_board
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:2785', 'Lillard Deal', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   40.00, 'HIGH', 20.00, 50.0, 20.00, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A2785', NULL,
   NULL, NULL, false);

-- A RAW-ASK row: the shape the price-only alert exists for — cheap, and with NO
-- fmv/confidence at all, so it can never appear on the deals board.
INSERT INTO edition_current_ask
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:9001', 'Cheap Lillard', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   NULL, NULL, 0.33, NULL, NULL, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A9001', NULL,
   NULL, NULL, false);

-- Subscriptions. Every one is Top-Shot-scoped and serial_only = false unless
-- stated; `badges` stays NULL throughout so the stub above never has to matter.
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, max_price, active, serial_only)
VALUES
  -- (1) PRICE-ONLY: a price and no FMV condition. The motivating subscription.
  ('11111111-1111-1111-1111-111111111111', 'owner-a', ARRAY['email'],
   ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 0, 0.60, true, false),
  -- (2) ORDINARY DEALS: a discount floor, no price cap.
  ('22222222-2222-2222-2222-222222222222', 'owner-b', ARRAY['email'],
   ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, NULL, true, false),
  -- (3) INACTIVE.
  ('33333333-3333-3333-3333-333333333333', 'owner-c', ARRAY['email'],
   ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, NULL, false, false);

-- (4) and (5) exercise the set/player filters against the deals pool.
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, set_names)
VALUES ('44444444-4444-4444-4444-444444444444', 'owner-d', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, ARRAY['Archive']);

INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, player_names)
VALUES ('55555555-5555-5555-5555-555555555555', 'owner-e', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, ARRAY['Damian']),
       ('66666666-6666-6666-6666-666666666666', 'owner-f', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, ARRAY['Damian Lillard']);

-- ── assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  -- (1) PRICE-ONLY reads the RAW ASK pool, not the deals board.
  r := public.build_deal_alerts_for_subscription('11111111-1111-1111-1111-111111111111');
  PERFORM _assert_eq((r->>'price_only'), 'true', 'a max_price with min_discount=0 is price-only');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'the $0.33 raw ask is visible to a $0.60 price-only alert');
  PERFORM _assert_eq((r->'deals'->0->>'external_id'), '73:9001', 'the row comes from edition_current_ask');
  PERFORM _assert((r->'deals'->0->>'fmv_usd') IS NULL,
                  'a price-only row carries NO fmv — that is the whole point of the pool');
  PERFORM _assert_eq((r->'deals'->0->>'price_only'), 'true', 'the row is flagged as price-pool');
  -- ⚠ The exclusion is the half that regresses silently: a "fix" that unioned
  -- both pools would still satisfy every assertion above.
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '73:2785'),
    'a price-only sub must NOT also receive deals-board rows');

  -- (2) An ordinary discount sub reads the deals board, and ONLY that.
  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'price_only'), 'false', 'min_discount=25 is not price-only');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'the discounted edition alerts');
  PERFORM _assert_eq((r->'deals'->0->>'external_id'), '73:2785', 'and it is the deals-board row');
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '73:9001'),
    'the raw-ask pool must not leak into a normal deals subscription');

  -- (3) Not eligible — an inactive or unknown subscription must SAY so, not
  -- return an empty deal list that reads as "nothing matched".
  r := public.build_deal_alerts_for_subscription('33333333-3333-3333-3333-333333333333');
  PERFORM _assert_eq((r->>'error'), 'not eligible', 'an inactive subscription is not eligible');
  PERFORM _assert(r->'deals' IS NULL, 'and it returns no deals key at all, rather than deals: []');
  r := public.build_deal_alerts_for_subscription('99999999-9999-9999-9999-999999999999');
  PERFORM _assert_eq((r->>'error'), 'not eligible', 'an unknown subscription id is not eligible');

  -- (4) SET NAMES ARE CONTAINMENT: "Archive" must match "Archive Set".
  r := public.build_deal_alerts_for_subscription('44444444-4444-4444-4444-444444444444');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'a set filter of "Archive" matches the catalogue set "Archive Set"');

  -- (5) PLAYER NAMES STAY EXACT — the deliberate asymmetry.
  r := public.build_deal_alerts_for_subscription('55555555-5555-5555-5555-555555555555');
  PERFORM _assert_eq((r->>'deals_count'), '0',
    'a player filter of "Damian" must NOT match "Damian Lillard" — player names are exact');
  r := public.build_deal_alerts_for_subscription('66666666-6666-6666-6666-666666666666');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'the full player name does match (so the case above is a real filter, not a broken fixture)');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription invariants pass';
END $$;

-- deals_count must be the SUM of both passes, not just the edition pass. Added
-- as its own block so the serial fixture cannot perturb the cases above.
INSERT INTO topshot_underpriced_serials_board
  (edition_id, edition_key, external_id, player_name, set_name, tier,
   circulation_count, thumbnail_url, nft_id, serial_number, ask_usd,
   listing_resource_id, listing_url, listed_at, last_seen_at, edition_fmv_usd,
   confidence, serial_bucket, serial_fmv_usd, serial_multiplier, discount_usd,
   discount_pct, estimate_quality)
VALUES
  (gen_random_uuid(), '73:2785', '73:2785', 'Damian Lillard', 'Archive Set', 'COMMON',
   12000, NULL, 'nft-1', 1, 50.00, NULL, NULL, now(), now(), 40.00,
   'HIGH', 'first', 100.00, 2.5, 50.00, 50.0, 'tight');

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'serial_deals_count'), '1', 'the serial pass finds the tight-estimate row');
  PERFORM _assert_eq((r->>'deals_count'), '2',
    'deals_count SUMS the edition pass and the serial pass');

  -- ⚠ And the serial pass is a strict ADDITION for a price-only sub: it has no
  -- price-only branch by design (every row on that board exists because of an
  -- FMV gap), but it is still bounded by max_price. At $0.60 the $50 serial is
  -- out, so the price-only preview stays at its single raw-ask row.
  r := public.build_deal_alerts_for_subscription('11111111-1111-1111-1111-111111111111');
  PERFORM _assert_eq((r->>'serial_deals_count'), '0', 'max_price still bounds the serial pass');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'so a price-only preview is unchanged by it');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription deals_count invariants pass';
END $$;

-- ── THE PREVIEW MUST NOT SHOW WHAT THE SENDER IS BARRED FROM SENDING ───────
--
-- 🚨 A preview that lists rows `dispatch_due_deal_alerts` will never enqueue is
-- the 2026-08-16 defect one level up: a subscription that looks live and cannot
-- fire. So the freshness gate (audit_20260912) is asserted on BOTH halves of the
-- pipeline, in both directions, and the two must agree row for row.
INSERT INTO edition_current_ask
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:9002', 'Stale Lillard', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   NULL, NULL, 0.40, NULL, NULL, now() - interval '3 days',
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A9002', NULL,
   NULL, NULL, false);

-- A second serial row whose listing was last SEEN 20 h ago. The board's
-- `last_seen_at` IS a confirmation stamp (unlike All Day's listed_at), so this
-- one is barred while the fresh fixture above stays.
INSERT INTO topshot_underpriced_serials_board
  (edition_id, edition_key, external_id, player_name, set_name, tier,
   circulation_count, thumbnail_url, nft_id, serial_number, ask_usd,
   listing_resource_id, listing_url, listed_at, last_seen_at, edition_fmv_usd,
   confidence, serial_bucket, serial_fmv_usd, serial_multiplier, discount_usd,
   discount_pct, estimate_quality)
VALUES
  (gen_random_uuid(), '73:2785', '73:2785', 'Damian Lillard', 'Archive Set', 'COMMON',
   12000, NULL, 'nft-2', 2, 50.00, NULL, NULL, now() - interval '20 hours',
   now() - interval '20 hours', 40.00,
   'HIGH', 'first', 100.00, 2.5, 50.00, 60.0, 'tight');

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('11111111-1111-1111-1111-111111111111');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'a raw ask last confirmed 3 days ago is not previewed either');
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '73:9002'),
    'and it is that row specifically that is absent');

  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'serial_deals_count'), '1',
    'a serial listing last seen 20 h ago is not previewed -- last_seen_at IS a confirmation');

  -- THE OTHER DIRECTION. Nothing changes but the stamps.
  UPDATE edition_current_ask SET ask_updated_at = now() WHERE external_id = '73:9002';
  UPDATE topshot_underpriced_serials_board SET last_seen_at = now() WHERE nft_id = 'nft-2';

  r := public.build_deal_alerts_for_subscription('11111111-1111-1111-1111-111111111111');
  PERFORM _assert_eq((r->>'deals_count'), '2',
    'the re-confirmed raw ask is previewed again -- the gate is freshness, not the row');
  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'serial_deals_count'), '2',
    'and so is the re-confirmed serial listing');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription: the preview honours the freshness gate';
END $$;

-- ── (8) A FILTER MUST NOT RUN BEHIND A CAP (audit_20261001) ────────────────
--
-- 🚨 THE LIVE MISS, REPRODUCED. Until 2026-10-01 pass 1 took the collection-wide
-- top 500 of the cheap predicates and only THEN applied team / parallel /
-- badges, so a filtered sub saw only the matches ranked inside that 500. On
-- 2026-09-30 a "Blazers rookie ≤ $0.50" sub missed a $0.25 Greg Brown III ask
-- because 504 cheaper Top Shot asks filled every slot.
--
-- ⚠ 501 FILLER ROWS, NOT 500: the target must rank strictly OUTSIDE the old cap
-- or this case passes against the defect. The fillers belong to no team and
-- carry no badge, so only the filters stand between them and the two subs.
-- Mutation-verified: restoring the 20260913061500 body fails BOTH assertions.
INSERT INTO edition_current_ask
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
SELECT '900:' || g, 'Filler', 'Filler Player ' || g, 'Base Set', 'COMMON', 50000,
       NULL, NULL, 0.05, NULL, NULL, now(),
       'nba_top_shot', 'NBA Top Shot', NULL, NULL, NULL, NULL, NULL, false
FROM generate_series(1, 501) g;

INSERT INTO edition_current_ask
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('901:1', 'Team Target', 'Greg Brown III', 'Hustle and Show', 'COMMON', 9000,
   NULL, NULL, 0.25, NULL, NULL, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, NULL, NULL, NULL, NULL, false),
  ('901:2', 'Badge Target', 'Some Rookie', 'Base Set', 'COMMON', 9000,
   NULL, NULL, 0.26, NULL, NULL, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, NULL, NULL, NULL, NULL, false);

INSERT INTO editions (id, collection_id, external_id, player_name, set_name, team_name)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd',
   '901:1', 'Greg Brown III', 'Hustle and Show', 'Portland Trail Blazers'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd',
   '901:2', 'Some Rookie', 'Base Set', 'Somewhere Else');

-- The stub above returns '[]' for every edition; give exactly ONE a badge.
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_edition_id = 'aaaaaaaa-0000-0000-0000-000000000002'
              THEN '[{"title":"Rookie Year"}]'::jsonb ELSE '[]'::jsonb END $$;

INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, max_price, active, serial_only, team_names, badges)
VALUES ('88888888-8888-8888-8888-888888888881', 'owner-team', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 0, 0.50, true, false,
        ARRAY['Portland Trail Blazers'], NULL),
       ('88888888-8888-8888-8888-888888888882', 'owner-badge', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 0, 0.50, true, false,
        NULL, ARRAY['rookieyear']);

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('88888888-8888-8888-8888-888888888881');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'a team-filtered preview finds its match behind 501 cheaper asks -- and only it');
  PERFORM _assert_eq((r->'deals'->0->>'external_id'), '901:1', 'and it is the Blazers row');

  r := public.build_deal_alerts_for_subscription('88888888-8888-8888-8888-888888888882');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'a badge-filtered preview finds its match behind the same 501 rows -- and only it');
  PERFORM _assert_eq((r->'deals'->0->>'external_id'), '901:2', 'and it is the badged row');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription: filters run before any truncation';
END $$;

-- ── (9) audit_20260930: 1 h FOR TOP SHOT EDITION ASKS, 12 h FOR THE SERIAL BOARD ─────────────
-- The preview must apply the sender's windows, arm by arm: an edition ask confirmed 2 h ago is
-- no longer previewed (it was under the old 12 h), one confirmed 59 min ago is; and a serial
-- listing seen 11 h ago IS previewed — the serial board passes 'nba_top_shot:serial' and keeps
-- 12 h. Mutation-verified 2026-09-30: passing 'nba_top_shot' on the serial arm fails the last.
DO $$
DECLARE r jsonb;
BEGIN
  UPDATE edition_current_ask SET ask_updated_at = now() - interval '2 hours' WHERE external_id = '901:1';
  r := public.build_deal_alerts_for_subscription('88888888-8888-8888-8888-888888888881');
  PERFORM _assert_eq((r->>'deals_count'), '0',
    'a Top Shot edition ask confirmed 2 h ago is not previewed -- the 1 h window');
  UPDATE edition_current_ask SET ask_updated_at = now() - interval '59 minutes' WHERE external_id = '901:1';
  r := public.build_deal_alerts_for_subscription('88888888-8888-8888-8888-888888888881');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'and at 59 min it is');

  UPDATE topshot_underpriced_serials_board SET last_seen_at = now() - interval '11 hours' WHERE nft_id = 'nft-2';
  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'serial_deals_count'), '2',
    'a serial listing seen 11 h ago IS previewed -- the serial board keeps 12 h under its own token');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription: per-arm freshness windows';
END $$;

-- ── (10) A 1-OF-1 IS NOT A PERFECT MINT (audit_20261010) ───────────────────
-- `require_last_mint` ("perfect mints only") tested `serial = circulation`
-- with no `circulation > 1`, so a /1 edition's serial 1 — the #1, not a last
-- mint — matched. The canonical rule is specialCats() in lib/badges/glyphs.ts
-- (and the binder's SerialBadge since 10-10). The real perfect mint is the
-- positive control: without it this case passes against a filter that matches
-- nothing at all.
INSERT INTO topshot_underpriced_serials_board
  (edition_id, edition_key, external_id, player_name, set_name, tier,
   circulation_count, thumbnail_url, nft_id, serial_number, ask_usd,
   listing_resource_id, listing_url, listed_at, last_seen_at, edition_fmv_usd,
   confidence, serial_bucket, serial_fmv_usd, serial_multiplier, discount_usd,
   discount_pct, estimate_quality)
VALUES
  (gen_random_uuid(), '950:1', '950:1', 'Last Mint Test', 'LM Set', 'ULTIMATE',
   1, NULL, 'nft-one-of-one', 1, 50.00, NULL, NULL, now(), now(), 40.00,
   'HIGH', 'first', 100.00, 2.5, 50.00, 50.0, 'tight'),
  (gen_random_uuid(), '950:2', '950:2', 'Last Mint Test', 'LM Set', 'RARE',
   50, NULL, 'nft-perfect', 50, 50.00, NULL, NULL, now(), now(), 40.00,
   'HIGH', 'perfect', 100.00, 2.5, 50.00, 50.0, 'tight');

INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, player_names, require_last_mint)
VALUES ('99999999-9999-9999-9999-999999999991', 'owner-lastmint', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false,
        ARRAY['Last Mint Test'], true);

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('99999999-9999-9999-9999-999999999991');
  PERFORM _assert_eq((r->>'serial_deals_count'), '1',
    'perfect-mints-only previews exactly one serial row');
  PERFORM _assert_eq((r->'serial_deals'->0->>'nft_id'), 'nft-perfect',
    'and it is the real perfect mint (#50/50), never the 1-of-1');
  RAISE NOTICE '✓ build_deal_alerts_for_subscription: a 1-of-1 is not a perfect mint';
END $$;

-- ── A SERIAL FILTER BINDS PASS 1 (audit_20261113) ─────────────────────────
-- The preview's half: what /alerts shows a "serial 111" alert must be what the
-- sender would send — the edition whose low ask IS serial 111 (positive
-- control), never one whose low ask is serial 222 or unknown (73:2785).
INSERT INTO cross_collection_deals_board
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:5111', 'Serial Hit', 'Serial Test', 'Serial Set', 'COMMON', 4000,
   40.00, 'HIGH', 20.00, 50.0, 20.00, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A5111', NULL,
   111, 'nft-s111', false),
  ('73:5222', 'Serial Miss', 'Serial Test', 'Serial Set', 'COMMON', 4000,
   40.00, 'HIGH', 20.00, 50.0, 20.00, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A5222', NULL,
   222, 'nft-s222', false);

INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, min_serial, max_serial)
VALUES ('99999999-9999-9999-9999-999999999992', 'owner-serial', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, 100, 200);
-- ⚠ 2026-11-14: was 111..111 — now pass 3's territory (the case below); a WIDE window keeps pass 1's
-- serial binding exercised.

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('99999999-9999-9999-9999-999999999992');
  PERFORM _assert(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '73:5111'),
    'the preview shows the edition whose low ask IS serial 111');
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' IN ('73:5222', '73:2785')),
    'and not one whose low ask is another serial, or an unknown one');
  RAISE NOTICE '✓ build_deal_alerts_for_subscription: a serial filter binds pass 1';
END $$;

-- ── PASS 3: EXACT-SERIAL LISTINGS (audit_20261114) ─────────────────────────
-- "Tell me when #111 is listed" is served from EVERY open listing of #111, not just each edition's
-- low ask (the 11-13 limit). Edition 80:111's LOW ASK is a different listing (x-lowask, on the deals
-- board) — pass 1 must NOT send it to this sub (it would arrive twice under two keys); pass 3 sends
-- x-hit, a #111 that is NOT the low ask. Every other row is one reason pass 3 must refuse.
INSERT INTO editions (id, collection_id, external_id, player_name, set_name, team_name, jersey_number, tier, circulation_count)
VALUES ('aaaaaaaa-0000-0000-0000-000000000111', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '80:111', 'Exact Hit', 'Exact Set', 'Team X', NULL, 'COMMON', 4000),
       ('aaaaaaaa-0000-0000-0000-000000000222', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '80:222', 'Exact Other', 'Exact Set', 'Team X', NULL, 'COMMON', 4000),
       ('aaaaaaaa-0000-0000-0000-000000000333', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '80:333', 'Exact Thin', 'Exact Set', 'Team X', NULL, 'COMMON', 4000);
INSERT INTO topshot_atlas_edition_map VALUES
  ('A111', 'aaaaaaaa-0000-0000-0000-000000000111', '80:111'),
  ('A222', 'aaaaaaaa-0000-0000-0000-000000000222', '80:222'),
  ('A333', 'aaaaaaaa-0000-0000-0000-000000000333', '80:333');
INSERT INTO fmv_snapshots VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000111', 40, 'HIGH', now() - interval '1 hour'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000222', 40, 'HIGH', now() - interval '1 hour'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000333', 40, 'HIGH', now() - interval '1 hour');
INSERT INTO topshot_thin_fmv_editions VALUES ('aaaaaaaa-0000-0000-0000-000000000333');
INSERT INTO topshot_atlas_market_events (product, kind, nft_id, price_cents, listed_at, last_seen_at, serial_number, atlas_edition_id, parallel, tier, completed) VALUES
  ('nba', 'listing', 'x-hit',      2000, now() - interval '2 hours',  now() - interval '10 minutes', 111, 'A111', 'Standard', 'COMMON', false), -- SENT: 50% under
  ('nba', 'listing', 'x-serial112',2000, now() - interval '2 hours',  now() - interval '10 minutes', 112, 'A111', 'Standard', 'COMMON', false), -- other serial
  ('nba', 'listing', 'x-old',      2000, now() - interval '3 days',   now() - interval '10 minutes', 111, 'A222', 'Standard', 'COMMON', false), -- not a NEW listing
  ('nba', 'listing', 'x-stale',    2000, now() - interval '20 hours', now() - interval '13 hours',   111, 'A222', 'Standard', 'COMMON', false), -- not seen in 12 h
  ('nba', 'listing', 'x-pricey',   3900, now() - interval '1 hour',   now() - interval '5 minutes',  111, 'A222', 'Standard', 'COMMON', false), -- 2.5% < 25%
  ('nba', 'listing', 'x-closed',   1000, now() - interval '1 hour',   now() - interval '5 minutes',  111, 'A222', 'Standard', 'COMMON', true),  -- closed
  ('nba', 'listing', 'x-thin',     1000, now() - interval '1 hour',   now() - interval '5 minutes',  111, 'A333', 'Standard', 'COMMON', false), -- thin FMV
  ('nfl', 'listing', 'x-nfl',      1000, now() - interval '1 hour',   now() - interval '5 minutes',  111, 'A111', 'Standard', 'COMMON', false); -- All Day row
INSERT INTO cross_collection_deals_board
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES ('80:111', 'Exact Hit', 'Exact Hit', 'Exact Set', 'COMMON', 4000,
   40.00, 'HIGH', 15.00, 62.5, 25.00, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/80%3A111', NULL,
   111, 'x-lowask', false);
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, min_serial, max_serial)
VALUES ('99999999-9999-9999-9999-999999999994', 'owner-exact', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, 111, 111);

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('99999999-9999-9999-9999-999999999994');
  PERFORM _assert(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'serial_deals') d WHERE d->>'nft_id' = 'x-hit'),
    'the preview shows the #111 listing that is not the low ask');
  PERFORM _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(r->'serial_deals') d WHERE d->>'kind' = 'exact_serial'), '1',
    'and only it among the exact-serial candidates');
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '80:111'),
    'pass 1 does not also preview the edition low ask for an exact-serial sub');
  PERFORM _assert_eq((r->>'exact_serial'), 'true', 'the preview says the sub is served by pass 3');
  PERFORM _assert_eq((r->>'exact_serial_deals_count'), '1', 'exact_serial_deals_count');
  RAISE NOTICE '✓ build_deal_alerts_for_subscription: pass 3 previews every new listing of the exact serial';
END $$;

ROLLBACK;
