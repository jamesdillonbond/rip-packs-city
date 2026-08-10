-- audit_20260810_sargable_wmc_wallet_predicates_d3b
--
-- Deep-audit register D3b (P1): 6 prod functions carried the same non-sargable
-- `lower(wmc.wallet_address) = …` predicate that made the Set Trackers unusable (D3).
-- Wrapping the COLUMN in lower() defeats every wallet_address index, so a single-wallet
-- read seq-scans the 2.2M-row wallet_moments_cache. Live-measured 2026-08-10: even a
-- normal wallet timed out (>60s) on these; the sargable form returns instantly.
--
-- SAFETY — the naive rewrite `lower(col)=lower(p)` → `col=lower(p)` SILENTLY BREAKS CANDY
-- (Solana base58 is case-sensitive; 25,375 wmc rows are non-lowercase, all candy_mlb).
-- Two equivalence-preserving forms are used here, both proven against live data
-- (`lower(wallet_address)` is UNIQUE per distinct stored value — 0 colliding lowercase
-- groups over 2,211,030 rows — so for any correctly-cased input the row set is identical):
--   * cross-collection / user-facing single-wallet reads → `col IN (raw, lower(raw))`
--     (keeps Flow case-insensitivity AND matches the exact Candy base58; sargable via
--     Bitmap/Index Cond, not a Filter).
--   * predicates provably scoped to a Flow-only collection (all rows lowercase) → keep the
--     lowered RHS and drop lower() off the COLUMN only: `col = lower(p)` / `col = v_wallet`.
--   * JOIN against the all-lowercase seeded_wallets → `wmc.wallet_address = LOWER(sw.wallet_address)`.
--
-- Not touched (measured negligible — <10k-row tables, or wmc join driven by a different key):
--   get_user_profile (user_profiles), holdings_summary (seeded_wallets, also DB-pinned),
--   analytics_resolve_usernames / discover_and_seed_active_wallets / tg_capture_topshot_insider_marketplace_buyback
--   (seeded_wallets/wallet_usernames), backfill_pinnacle_mint_acquisitions (wmc join driven by moment_id),
--   sync_seeded_wallet_to_username_cache (false positive — lowercases a scalar for INSERT, not a scan).
--
-- Behaviour-preserving; forward-only (no data change). Revert: replace each predicate back.

-- 1) get_wallet_portfolio(text) — cross-collection, 4 predicates → IN (raw, lower(raw))
CREATE OR REPLACE FUNCTION public.get_wallet_portfolio(p_wallet_address text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet TEXT;
  v_wallet_raw TEXT;
  v_total_moments INT;
  v_total_fmv NUMERIC;
  v_last_seen TIMESTAMPTZ;
  v_per_collection JSONB;
  v_top_moments JSONB;
BEGIN
  v_wallet_raw := trim(p_wallet_address);
  v_wallet := lower(v_wallet_raw);

  -- Total counts and FMV
  SELECT
    COUNT(*),
    COALESCE(SUM(fmv_usd), 0),
    MAX(last_seen_at)
  INTO v_total_moments, v_total_fmv, v_last_seen
  FROM wallet_moments_cache
  WHERE wallet_address IN (v_wallet_raw, v_wallet);

  -- Per-collection breakdown.
  -- Two-stage rollup via CTEs to avoid nested aggregates
  -- (jsonb_object_agg(tier, COUNT(*)) is not allowed inline).
  WITH tier_counts AS (
    SELECT
      wmc.collection_id,
      COALESCE(wmc.tier, 'UNKNOWN') AS tier_key,
      COUNT(*) AS tier_count
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address IN (v_wallet_raw, v_wallet)
    GROUP BY wmc.collection_id, COALESCE(wmc.tier, 'UNKNOWN')
  ),
  tier_rollup AS (
    SELECT
      collection_id,
      jsonb_object_agg(tier_key, tier_count) AS tiers
    FROM tier_counts
    GROUP BY collection_id
  ),
  collection_stats AS (
    SELECT
      wmc.collection_id,
      c.slug,
      c.name,
      COUNT(*) AS moment_count,
      ROUND(COALESCE(SUM(wmc.fmv_usd), 0), 2) AS total_fmv,
      COUNT(*) FILTER (WHERE wmc.is_locked = true) AS locked_count
    FROM wallet_moments_cache wmc
    JOIN collections c ON c.id = wmc.collection_id
    WHERE wmc.wallet_address IN (v_wallet_raw, v_wallet)
    GROUP BY wmc.collection_id, c.slug, c.name
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'collection_id', cs.collection_id,
      'collection_slug', cs.slug,
      'collection_name', cs.name,
      'moment_count', cs.moment_count,
      'total_fmv', cs.total_fmv,
      'locked_count', cs.locked_count,
      'tier_breakdown', COALESCE(tr.tiers, '{}'::jsonb)
    )
    ORDER BY cs.name
  ) INTO v_per_collection
  FROM collection_stats cs
  LEFT JOIN tier_rollup tr ON tr.collection_id = cs.collection_id;

  -- Top 10 moments by FMV
  SELECT jsonb_agg(m ORDER BY m.fmv_usd DESC NULLS LAST) INTO v_top_moments
  FROM (
    SELECT
      wmc.moment_id,
      wmc.edition_key,
      wmc.edition_name,
      wmc.player_name,
      wmc.character_name,
      wmc.set_name,
      wmc.tier,
      wmc.serial_number,
      wmc.fmv_usd,
      wmc.is_locked,
      wmc.collection_id,
      c.slug AS collection_slug,
      wmc.image_url
    FROM wallet_moments_cache wmc
    JOIN collections c ON c.id = wmc.collection_id
    WHERE wmc.wallet_address IN (v_wallet_raw, v_wallet)
      AND wmc.fmv_usd IS NOT NULL
    ORDER BY wmc.fmv_usd DESC NULLS LAST
    LIMIT 10
  ) m;

  RETURN jsonb_build_object(
    'wallet_address', p_wallet_address,
    'total_moments', v_total_moments,
    'total_fmv_usd', ROUND(v_total_fmv, 2),
    'last_seen_at', v_last_seen,
    'per_collection', COALESCE(v_per_collection, '[]'::jsonb),
    'top_moments', COALESCE(v_top_moments, '[]'::jsonb),
    'computed_at', NOW()
  );
END;
$function$;

-- 2) get_active_challenges(text,uuid) — collection-scoped; keep case-insensitivity → IN (p, lower(p))
CREATE OR REPLACE FUNCTION public.get_active_challenges(p_wallet text DEFAULT NULL::text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE collection_id = p_collection_id AND status = 'active' AND (ends_at IS NULL OR ends_at > now())),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask,0)) AS low_ask
  FROM public.badge_editions be WHERE be.collection_id = p_collection_id GROUP BY be.external_id
),
slot AS (
  SELECT cse.challenge_id, cse.slot_order,
         MIN(COALESCE(fl.low_ask, mv.fmv_usd)) AS slot_cost,
         bool_or(p_wallet IS NOT NULL AND o.edition_key IS NOT NULL) AS owned
  FROM public.challenge_slot_editions cse
  JOIN ch ON ch.id = cse.challenge_id
  LEFT JOIN floor fl ON fl.external_id = cse.external_id
  LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = cse.external_id
  LEFT JOIN public.wallet_moments_cache o
    ON o.edition_key = cse.external_id AND o.collection_id = p_collection_id
   AND p_wallet IS NOT NULL AND o.wallet_address IN (p_wallet, lower(p_wallet))
  GROUP BY cse.challenge_id, cse.slot_order
),
totals AS (
  SELECT cs.challenge_id, count(*) AS total_slots FROM public.challenge_slots cs
  WHERE cs.challenge_id IN (SELECT id FROM ch) GROUP BY cs.challenge_id
),
agg AS (
  SELECT s.challenge_id,
    count(*) AS resolved_slots,
    count(*) FILTER (WHERE s.owned) AS filled_slots,
    SUM(s.slot_cost) FILTER (WHERE NOT s.owned)::numeric(12,2) AS cost_to_complete
  FROM slot s GROUP BY s.challenge_id
)
SELECT jsonb_build_object(
  'wallet', p_wallet, 'generatedAt', now(), 'activeCount', (SELECT COUNT(*) FROM ch),
  'challenges', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'challengeId', c.id, 'slug', c.slug, 'name', c.name, 'challengeType', c.challenge_type,
      'status', c.status, 'endsAt', c.ends_at, 'imageUrl', c.image_url, 'setName', c.set_name,
      'rewardKind', c.reward_kind, 'rewardLabel', c.reward_label,
      'totalRewardAllocation', c.total_reward_allocation, 'completedCount', c.completed_count,
      'packsPerUser', ROUND(c.total_reward_allocation::numeric / NULLIF(c.completed_count, 0), 2),
      'totalRequired', COALESCE(t.total_slots, 0),
      'ownedCount', COALESCE(a.filled_slots, 0),
      'missingCount', COALESCE(t.total_slots,0) - COALESCE(a.filled_slots,0),
      'unresolvedSlots', COALESCE(t.total_slots,0) - COALESCE(a.resolved_slots,0),
      'completionPct', ROUND(100.0 * COALESCE(a.filled_slots,0)::numeric / NULLIF(t.total_slots,0), 1),
      'costToComplete', a.cost_to_complete, 'entryFloor', c.cached_entry_floor,
      'rewardValue', c.cached_reward_value,
      'netEv', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                    ELSE ROUND(c.cached_reward_value * GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) - a.cost_to_complete, 2) END,
      'worthIt', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                      ELSE (c.cached_reward_value * GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) - a.cost_to_complete) > 0 END)
      ORDER BY (c.cached_reward_value * GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) - a.cost_to_complete) DESC NULLS LAST, c.ends_at ASC NULLS LAST)
    FROM ch c LEFT JOIN totals t ON t.challenge_id = c.id LEFT JOIN agg a ON a.challenge_id = c.id), '[]'::jsonb)
)
$function$;

-- 3) get_challenge_plan(text,uuid) — collection-scoped; keep case-insensitivity → IN (p, lower(p))
CREATE OR REPLACE FUNCTION public.get_challenge_plan(p_wallet text, p_challenge_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE id = p_challenge_id AND (ends_at IS NULL OR ends_at > now())),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask,0)) AS low_ask,
         MAX(be.lock_rate_pct) AS lock_rate_pct, MAX(be.burn_rate_pct) AS burn_rate_pct
  FROM public.badge_editions be
  WHERE be.collection_id = (SELECT collection_id FROM ch)
  GROUP BY be.external_id
),
owned AS (
  SELECT DISTINCT wmc.edition_key FROM public.wallet_moments_cache wmc
  WHERE wmc.wallet_address IN (p_wallet, lower(p_wallet)) AND wmc.collection_id = (SELECT collection_id FROM ch)
),
elig AS (
  SELECT cse.slot_order, cse.external_id, e.player_name, e.tier::text AS tier, e.thumbnail_url,
         mv.fmv_usd, fl.low_ask, fl.lock_rate_pct, fl.burn_rate_pct,
         COALESCE(fl.low_ask, mv.fmv_usd) AS cost,
         (o.edition_key IS NOT NULL) AS owned
  FROM public.challenge_slot_editions cse
  LEFT JOIN public.editions e ON e.external_id = cse.external_id AND e.collection_id = (SELECT collection_id FROM ch)
  LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = cse.external_id
  LEFT JOIN floor fl ON fl.external_id = cse.external_id
  LEFT JOIN owned o ON o.edition_key = cse.external_id
  WHERE cse.challenge_id = p_challenge_id
),
sm AS (SELECT slot_order, label, play_category, help_text FROM public.challenge_slots WHERE challenge_id = p_challenge_id),
slot_state AS (
  SELECT sm.slot_order, sm.label, sm.play_category, sm.help_text,
         COALESCE(bool_or(el.owned), false) AS filled,
         count(el.external_id) AS eligible_count,
         MIN(el.cost) FILTER (WHERE NOT el.owned) AS cheapest_unowned_cost
  FROM sm LEFT JOIN elig el ON el.slot_order = sm.slot_order
  GROUP BY sm.slot_order, sm.label, sm.play_category, sm.help_text
),
pick AS (  -- cheapest eligible moment per slot (the buy recommendation)
  SELECT DISTINCT ON (el.slot_order) el.slot_order, el.external_id, el.player_name, el.tier,
         el.thumbnail_url, el.fmv_usd, el.low_ask, el.lock_rate_pct, el.burn_rate_pct
  FROM elig el
  ORDER BY el.slot_order, el.cost ASC NULLS LAST, el.external_id
),
agg AS (
  SELECT
    count(*) AS total_slots,
    count(*) FILTER (WHERE filled) AS filled_slots,
    count(*) FILTER (WHERE eligible_count = 0) AS unresolved_slots,
    SUM(cheapest_unowned_cost) FILTER (WHERE NOT filled)::numeric(12,2) AS cost_to_complete
  FROM slot_state
)
SELECT jsonb_build_object(
  'challengeId', ch.id, 'slug', ch.slug, 'name', ch.name, 'challengeType', ch.challenge_type,
  'description', ch.description, 'status', ch.status, 'startsAt', ch.starts_at, 'endsAt', ch.ends_at,
  'setName', ch.set_name, 'totalRewardAllocation', ch.total_reward_allocation, 'completedCount', ch.completed_count,
  'rewardKind', ch.reward_kind, 'rewardLabel', ch.reward_label, 'imageUrl', ch.image_url,
  'wallet', p_wallet,
  'totalRequired', a.total_slots, 'ownedCount', a.filled_slots,
  'missingCount', a.total_slots - a.filled_slots, 'unresolvedSlots', a.unresolved_slots,
  'completionPct', ROUND(100.0 * a.filled_slots::numeric / NULLIF(a.total_slots, 0), 1),
  'costToComplete', a.cost_to_complete, 'rewardValue', ch.cached_reward_value,
  'netEv', CASE WHEN ch.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL ELSE ROUND(ch.cached_reward_value * GREATEST(COALESCE(ch.total_reward_allocation::numeric / NULLIF(ch.completed_count,0), 1), 1) - a.cost_to_complete, 2) END,
  'worthIt', CASE WHEN ch.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL ELSE (ch.cached_reward_value * GREATEST(COALESCE(ch.total_reward_allocation::numeric / NULLIF(ch.completed_count,0), 1), 1) - a.cost_to_complete) > 0 END,
  'slots', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'slotOrder', ss.slot_order, 'label', ss.label, 'playCategory', ss.play_category, 'helpText', ss.help_text,
      'filled', ss.filled, 'eligibleCount', ss.eligible_count,
      'pick', CASE WHEN p.external_id IS NULL THEN NULL ELSE jsonb_build_object(
        'externalId', p.external_id, 'playerName', p.player_name, 'tier', p.tier,
        'thumbnailUrl', p.thumbnail_url, 'fmvUsd', p.fmv_usd, 'lowAsk', p.low_ask,
        'lockRatePct', p.lock_rate_pct, 'burnRatePct', p.burn_rate_pct,
        'editionUrl', '/nba-top-shot/edition/' || p.external_id) END)
      ORDER BY ss.filled ASC, ss.cheapest_unowned_cost ASC NULLS LAST, ss.slot_order)
    FROM slot_state ss LEFT JOIN pick p ON p.slot_order = ss.slot_order), '[]'::jsonb)
)
FROM ch CROSS JOIN agg a;
$function$;

-- 4) mcp_find_set_completion(text,text,text) — wmc block gated to TS/AllDay (Flow, all-lowercase) → col = v_wallet
CREATE OR REPLACE FUNCTION public.mcp_find_set_completion(p_wallet text, p_collection_slug text, p_set_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_slug text := lower(trim(p_collection_slug));
  v_wallet text := lower(trim(p_wallet));
  v_collection_id uuid;
  v_set_uuid uuid;
  v_overview jsonb;
  v_set_obj jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_total_completion numeric;
  v_gaps text[] := array[]::text[];
  v_null_ask_gaps text[];
begin
  if p_wallet is null or p_wallet = '' then
    return jsonb_build_object('supported', false, 'reason', 'wallet_required',
                              'gaps', to_jsonb(array['wallet_required']));
  end if;
  if p_set_id is null or p_set_id = '' then
    return jsonb_build_object('supported', false, 'reason', 'set_id_required',
                              'gaps', to_jsonb(array['set_id_required']));
  end if;

  if v_slug = 'disney_pinnacle' or v_slug = 'ufc_strike' then
    return jsonb_build_object(
      'supported', false,
      'reason', 'deferred_pending_consistent_signature',
      'collection_slug', v_slug,
      'set_id', p_set_id,
      'gaps', to_jsonb(array['set_completion_deferred_for_' || v_slug])
    );
  elsif v_slug = 'laliga_golazos' then
    return jsonb_build_object(
      'supported', false,
      'reason', 'set_progress_rpc_not_implemented',
      'collection_slug', v_slug,
      'set_id', p_set_id,
      'gaps', to_jsonb(array['set_completion_unavailable_for_laliga_golazos'])
    );
  end if;

  select id into v_collection_id from public.collections where slug = v_slug;
  if v_collection_id is null then
    return jsonb_build_object('supported', false, 'reason', 'unknown_collection_slug',
                              'collection_slug', v_slug, 'set_id', p_set_id,
                              'gaps', to_jsonb(array['unknown_collection_slug_' || coalesce(v_slug,'null')]));
  end if;

  begin
    v_set_uuid := p_set_id::uuid;
  exception when invalid_text_representation then
    v_set_uuid := null;
    v_gaps := array_append(v_gaps, 'set_id_not_uuid_full_missing_list_skipped');
  end;

  if v_slug = 'nba_top_shot' then
    v_overview := public.get_topshot_set_progress(v_wallet, v_collection_id);
  elsif v_slug = 'nfl_all_day' then
    v_overview := public.get_allday_set_progress(v_wallet, v_collection_id);
  else
    return jsonb_build_object('supported', false, 'reason', 'unsupported_collection_for_set_completion',
                              'collection_slug', v_slug, 'set_id', p_set_id,
                              'gaps', to_jsonb(array['set_completion_only_supports_topshot_and_allday']));
  end if;

  select s into v_set_obj
    from jsonb_array_elements(coalesce(v_overview->'sets', '[]'::jsonb)) s
    where s->>'setId' = p_set_id
    limit 1;

  if v_set_obj is null then
    v_gaps := array_append(v_gaps, 'set_not_in_wallet_progress_payload');
  end if;

  if v_set_uuid is not null then
    if v_slug = 'nba_top_shot' then
      with owned_external_ids as (
        select wmc.edition_key
          from public.wallet_moments_cache wmc
         where wmc.collection_id = v_collection_id
           and wmc.wallet_address = v_wallet
           and wmc.edition_key is not null
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'edition_id', e.id,
               'external_id', e.external_id,
               'player_name', e.player_name,
               'tier', e.tier::text,
               'thumbnail_url', e.thumbnail_url,
               'cheapest_ask', be.low_ask,
               'cheapest_ask_source', case when be.low_ask is not null then 'topshot' else null end
             ) order by be.low_ask asc nulls last), '[]'::jsonb)
        into v_missing
        from public.editions e
        left join public.badge_editions be
          on be.collection_id = v_collection_id and be.external_id = e.external_id
       where e.collection_id = v_collection_id
         and e.set_id = v_set_uuid
         and not exists (
           select 1 from owned_external_ids o where o.edition_key = e.external_id
         );
    elsif v_slug = 'nfl_all_day' then
      with owned_external_ids as (
        select wmc.edition_key
          from public.wallet_moments_cache wmc
         where wmc.collection_id = v_collection_id
           and wmc.wallet_address = v_wallet
           and wmc.edition_key is not null
      ),
      asks as (
        select cl.set_name, cl.player_name,
               min(cl.ask_price) as cheapest_ask,
               (array_agg(cl.source order by cl.ask_price asc nulls last))[1] as cheapest_ask_source
          from public.cached_listings cl
         where cl.collection_id = v_collection_id and cl.ask_price is not null
         group by cl.set_name, cl.player_name
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'edition_id', e.id,
               'external_id', e.external_id,
               'player_name', e.player_name,
               'tier', e.tier::text,
               'thumbnail_url', e.thumbnail_url,
               'cheapest_ask', a.cheapest_ask,
               'cheapest_ask_source', a.cheapest_ask_source
             ) order by a.cheapest_ask asc nulls last), '[]'::jsonb)
        into v_missing
        from public.editions e
        left join asks a on a.set_name = e.set_name and a.player_name = e.player_name
       where e.collection_id = v_collection_id
         and e.set_id = v_set_uuid
         and not exists (
           select 1 from owned_external_ids o where o.edition_key = e.external_id
         );
    end if;
  end if;

  select coalesce(sum((elem->>'cheapest_ask')::numeric), 0)
    into v_total_completion
    from jsonb_array_elements(v_missing) elem
   where elem->>'cheapest_ask' is not null;

  select array(
    select 'cheapest_ask_unavailable_for_' || (elem->>'external_id')
      from jsonb_array_elements(v_missing) elem
     where elem->>'cheapest_ask' is null
  ) into v_null_ask_gaps;
  v_gaps := v_gaps || coalesce(v_null_ask_gaps, array[]::text[]);

  return jsonb_build_object(
    'supported', true,
    'collection_slug', v_slug,
    'set_id', p_set_id,
    'set_name', v_set_obj->>'setName',
    'set_tier', v_set_obj->>'setTier',
    'series', (v_set_obj->>'series')::int,
    'owned_count', (v_set_obj->>'ownedPlays')::int,
    'total_count', (v_set_obj->>'totalPlays')::int,
    'missing_count', (v_set_obj->>'missingPlays')::int,
    'completion_pct', nullif(v_set_obj->>'completionPct','')::numeric,
    'estimated_cost_to_complete_rpc', nullif(v_set_obj->>'estimatedCostToComplete','')::numeric,
    'total_completion_usd', v_total_completion,
    'missing_editions', v_missing,
    'gaps', to_jsonb(v_gaps)
  );
end;
$function$;

-- 5) pick_verification_target(text,int) — TS-hardcoded (all lowercase) → IN (raw, lower(raw))
CREATE OR REPLACE FUNCTION public.pick_verification_target(p_wallet text, p_limit integer DEFAULT 5)
 RETURNS TABLE(moment_id text, edition_key text, serial_number integer, player_name text, set_name text, image_url text, fmv_usd numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT w.moment_id, w.edition_key, w.serial_number, w.player_name,
         w.set_name, w.image_url, w.fmv_usd
  FROM wallet_moments_cache w
  WHERE w.wallet_address IN (trim(p_wallet), lower(trim(p_wallet)))
    AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND w.fmv_usd > 0 AND w.fmv_usd < 1
    AND w.image_url IS NOT NULL
    AND coalesce(w.is_locked, false) = false
  ORDER BY w.fmv_usd ASC
  LIMIT greatest(coalesce(p_limit, 5), 1);
$function$;

-- 6) update_fully_enriched_flags(numeric) — JOIN vs all-lowercase seeded_wallets → wmc.wallet_address = LOWER(sw.wallet_address)
CREATE OR REPLACE FUNCTION public.update_fully_enriched_flags(p_threshold_pct numeric DEFAULT 95.0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated int := 0;
BEGIN
  -- Compute actual cached counts per wallet from wmc, then set the flag where threshold is met
  WITH actual_counts AS (
    SELECT
      sw.id,
      sw.expected_moment_count,
      COUNT(wmc.id) AS actual_cached
    FROM seeded_wallets sw
    LEFT JOIN wallet_moments_cache wmc ON wmc.wallet_address = LOWER(sw.wallet_address)
    WHERE sw.fully_enriched_at IS NULL
      AND sw.expected_moment_count IS NOT NULL
      AND sw.expected_moment_count > 0
      AND sw.is_active = true
    GROUP BY sw.id, sw.expected_moment_count
  )
  UPDATE seeded_wallets sw
  SET fully_enriched_at = NOW()
  FROM actual_counts ac
  WHERE sw.id = ac.id
    AND ac.actual_cached >= GREATEST(50, (ac.expected_moment_count * p_threshold_pct / 100.0)::int);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Also keep cached_moment_count fresh — useful for the snapshot RPC
  UPDATE seeded_wallets sw
  SET cached_moment_count = ac.actual_cached
  FROM (
    SELECT
      sw2.id,
      COUNT(wmc.id) AS actual_cached
    FROM seeded_wallets sw2
    LEFT JOIN wallet_moments_cache wmc ON wmc.wallet_address = LOWER(sw2.wallet_address)
    WHERE sw2.is_active = true
    GROUP BY sw2.id
  ) ac
  WHERE sw.id = ac.id
    AND (sw.cached_moment_count IS NULL OR sw.cached_moment_count != ac.actual_cached);

  RETURN jsonb_build_object(
    'wallets_marked_fully_enriched', v_updated,
    'threshold_pct', p_threshold_pct,
    'computed_at', NOW()
  );
END;
$function$;
