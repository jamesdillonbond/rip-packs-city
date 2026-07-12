-- Challenge tracker RPCs: operator/GraphQL seed seam + the intelligence layer.
--   upsert_challenge()      — atomic seed/update of a challenge + its required-edition list.
--   get_challenge_plan()    — per-challenge owned/missing split, cost-to-complete, reward value, netEv.
--   get_active_challenges() — active board ranked by netEv (reward value − cost-to-complete).
-- All SECURITY DEFINER; anon EXECUTE explicitly revoked (Supabase default-privileges grant
-- anon/authenticated on new fns, and REVOKE FROM PUBLIC does not remove those role grants).
-- Reward valuation: reward-pack gross_ev from pack_ev_latest, or reward-moment latest FMV.
-- Revert: DROP FUNCTION upsert_challenge(...); DROP FUNCTION get_challenge_plan(text,uuid);
--         DROP FUNCTION get_active_challenges(text,uuid);

-- ── seed seam ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_challenge(
  p_slug                     text,
  p_name                     text,
  p_challenge_type           text DEFAULT 'set_locking',
  p_description              text DEFAULT NULL,
  p_reward_kind              text DEFAULT NULL,
  p_reward_pack_dist_id      text DEFAULT NULL,
  p_reward_moment_external_id text DEFAULT NULL,
  p_reward_label             text DEFAULT NULL,
  p_starts_at                timestamptz DEFAULT NULL,
  p_ends_at                  timestamptz DEFAULT NULL,
  p_total_reward_allocation  integer DEFAULT NULL,
  p_completed_count          integer DEFAULT NULL,
  p_status                   text DEFAULT 'active',
  p_source                   text DEFAULT 'operator',
  p_external_id              text DEFAULT NULL,
  p_image_url                text DEFAULT NULL,
  p_editions                 jsonb DEFAULT '[]'::jsonb,
  p_collection_id            uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.challenges AS c (
    collection_id, slug, name, challenge_type, description, reward_kind,
    reward_pack_dist_id, reward_moment_external_id, reward_label,
    starts_at, ends_at, total_reward_allocation, completed_count,
    status, source, external_id, image_url
  ) VALUES (
    p_collection_id, p_slug, p_name, p_challenge_type, p_description, p_reward_kind,
    p_reward_pack_dist_id, p_reward_moment_external_id, p_reward_label,
    p_starts_at, p_ends_at, p_total_reward_allocation, p_completed_count,
    COALESCE(p_status,'active'), COALESCE(p_source,'operator'), p_external_id, p_image_url
  )
  ON CONFLICT (collection_id, slug) DO UPDATE SET
    name = EXCLUDED.name, challenge_type = EXCLUDED.challenge_type,
    description = EXCLUDED.description, reward_kind = EXCLUDED.reward_kind,
    reward_pack_dist_id = EXCLUDED.reward_pack_dist_id,
    reward_moment_external_id = EXCLUDED.reward_moment_external_id,
    reward_label = EXCLUDED.reward_label, starts_at = EXCLUDED.starts_at,
    ends_at = EXCLUDED.ends_at, total_reward_allocation = EXCLUDED.total_reward_allocation,
    completed_count = EXCLUDED.completed_count, status = EXCLUDED.status,
    source = EXCLUDED.source, external_id = EXCLUDED.external_id, image_url = EXCLUDED.image_url
  RETURNING c.id INTO v_id;

  DELETE FROM public.challenge_editions WHERE challenge_id = v_id;
  INSERT INTO public.challenge_editions (challenge_id, external_id, play_id_onchain, required)
  SELECT v_id, e->>'external_id', NULLIF(e->>'play_id_onchain','')::integer,
         COALESCE((e->>'required')::boolean, true)
  FROM jsonb_array_elements(COALESCE(p_editions, '[]'::jsonb)) AS e
  WHERE COALESCE(e->>'external_id','') <> ''
  ON CONFLICT (challenge_id, external_id) DO NOTHING;

  RETURN v_id;
END $$;

-- ── per-challenge plan ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_challenge_plan(
  p_wallet text, p_challenge_id uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE id = p_challenge_id),
req AS (
  SELECT ce.external_id, ce.play_id_onchain
  FROM public.challenge_editions ce WHERE ce.challenge_id = p_challenge_id
),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask, 0)) AS low_ask,
         MAX(be.lock_rate_pct) AS lock_rate_pct, MAX(be.burn_rate_pct) AS burn_rate_pct
  FROM public.badge_editions be
  WHERE be.collection_id = (SELECT collection_id FROM ch)
    AND be.external_id IN (SELECT external_id FROM req)
  GROUP BY be.external_id
),
owned AS (
  SELECT DISTINCT wmc.edition_key FROM public.wallet_moments_cache wmc
  WHERE lower(wmc.wallet_address) = lower(p_wallet)
    AND wmc.collection_id = (SELECT collection_id FROM ch)
    AND wmc.edition_key IN (SELECT external_id FROM req)
),
base AS (
  SELECT r.external_id, r.play_id_onchain, e.id AS edition_id, e.player_name,
         e.tier::text AS tier, e.thumbnail_url, fmv.fmv_usd, fl.low_ask,
         fl.lock_rate_pct, fl.burn_rate_pct, (o.edition_key IS NOT NULL) AS owned
  FROM req r
  LEFT JOIN public.editions e
    ON e.external_id = r.external_id AND e.collection_id = (SELECT collection_id FROM ch)
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd FROM public.fmv_snapshots fs
    WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1) fmv ON true
  LEFT JOIN floor fl ON fl.external_id = r.external_id
  LEFT JOIN owned o  ON o.edition_key = r.external_id
),
reward AS (
  SELECT CASE
    WHEN ch.reward_kind = 'pack' AND ch.reward_pack_dist_id IS NOT NULL THEN (
      SELECT pe.gross_ev FROM public.pack_ev_latest pe
      WHERE pe.dist_id = ch.reward_pack_dist_id AND pe.collection_id = ch.collection_id LIMIT 1)
    WHEN ch.reward_kind = 'moment' AND ch.reward_moment_external_id IS NOT NULL THEN (
      SELECT fs.fmv_usd FROM public.editions e2
      JOIN public.fmv_snapshots fs ON fs.edition_id = e2.id
      WHERE e2.external_id = ch.reward_moment_external_id AND e2.collection_id = ch.collection_id
      ORDER BY fs.computed_at DESC LIMIT 1)
    ELSE NULL END AS reward_value
  FROM ch
),
agg AS (
  SELECT COUNT(*) AS total_required, COUNT(*) FILTER (WHERE owned) AS owned_count,
    COALESCE(SUM(CASE WHEN NOT owned THEN COALESCE(low_ask, fmv_usd) ELSE 0 END), 0)::numeric(12,2) AS cost_to_complete,
    COALESCE(SUM(CASE WHEN owned THEN fmv_usd ELSE 0 END), 0)::numeric(12,2) AS owned_value
  FROM base
)
SELECT jsonb_build_object(
  'challengeId', ch.id, 'slug', ch.slug, 'name', ch.name, 'challengeType', ch.challenge_type,
  'description', ch.description, 'status', ch.status, 'startsAt', ch.starts_at, 'endsAt', ch.ends_at,
  'totalRewardAllocation', ch.total_reward_allocation, 'completedCount', ch.completed_count,
  'rewardKind', ch.reward_kind, 'rewardLabel', ch.reward_label, 'imageUrl', ch.image_url,
  'wallet', p_wallet, 'totalRequired', a.total_required, 'ownedCount', a.owned_count,
  'missingCount', a.total_required - a.owned_count,
  'completionPct', ROUND(100.0 * a.owned_count::numeric / NULLIF(a.total_required, 0), 1),
  'costToComplete', a.cost_to_complete, 'ownedValue', a.owned_value, 'rewardValue', rw.reward_value,
  'netEv', CASE WHEN rw.reward_value IS NULL THEN NULL ELSE ROUND(rw.reward_value - a.cost_to_complete, 2) END,
  'worthIt', CASE WHEN rw.reward_value IS NULL THEN NULL ELSE (rw.reward_value - a.cost_to_complete) > 0 END,
  'owned', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('externalId', b.external_id, 'playId', b.play_id_onchain,
      'playerName', b.player_name, 'tier', b.tier, 'thumbnailUrl', b.thumbnail_url,
      'fmvUsd', b.fmv_usd, 'lockRatePct', b.lock_rate_pct) ORDER BY b.player_name)
    FROM base b WHERE b.owned), '[]'::jsonb),
  'missing', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('externalId', b.external_id, 'playId', b.play_id_onchain,
      'playerName', b.player_name, 'tier', b.tier, 'thumbnailUrl', b.thumbnail_url,
      'fmvUsd', b.fmv_usd, 'lowAsk', b.low_ask, 'lockRatePct', b.lock_rate_pct, 'burnRatePct', b.burn_rate_pct,
      'editionUrl', '/nba-top-shot/edition/' || b.external_id)
      ORDER BY COALESCE(b.low_ask, b.fmv_usd) ASC NULLS LAST, b.player_name)
    FROM base b WHERE NOT b.owned), '[]'::jsonb)
)
FROM ch CROSS JOIN reward rw CROSS JOIN agg a;
$function$;

-- ── active board ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_active_challenges(
  p_wallet text DEFAULT NULL,
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' SET statement_timeout TO '25s'
AS $function$
WITH ch AS (
  SELECT * FROM public.challenges WHERE collection_id = p_collection_id AND status = 'active'
),
ce AS (
  SELECT c.id AS challenge_id, ce.external_id
  FROM ch c JOIN public.challenge_editions ce ON ce.challenge_id = c.id
),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask, 0)) AS low_ask
  FROM public.badge_editions be
  WHERE be.collection_id = p_collection_id AND be.external_id IN (SELECT external_id FROM ce)
  GROUP BY be.external_id
),
fmv AS (
  SELECT DISTINCT ON (e.external_id) e.external_id, fs.fmv_usd
  FROM public.editions e JOIN public.fmv_snapshots fs ON fs.edition_id = e.id
  WHERE e.collection_id = p_collection_id AND e.external_id IN (SELECT external_id FROM ce)
  ORDER BY e.external_id, fs.computed_at DESC
),
owned AS (
  SELECT DISTINCT wmc.edition_key FROM public.wallet_moments_cache wmc
  WHERE p_wallet IS NOT NULL AND lower(wmc.wallet_address) = lower(p_wallet)
    AND wmc.collection_id = p_collection_id AND wmc.edition_key IN (SELECT external_id FROM ce)
),
per_challenge AS (
  SELECT ce.challenge_id, COUNT(*) AS total_required,
    COUNT(*) FILTER (WHERE o.edition_key IS NOT NULL) AS owned_count,
    COALESCE(SUM(CASE WHEN o.edition_key IS NULL THEN COALESCE(fl.low_ask, fv.fmv_usd) ELSE 0 END), 0)::numeric(12,2) AS cost_to_complete
  FROM ce
  LEFT JOIN floor fl ON fl.external_id = ce.external_id
  LEFT JOIN fmv fv   ON fv.external_id = ce.external_id
  LEFT JOIN owned o  ON o.edition_key = ce.external_id
  GROUP BY ce.challenge_id
),
reward AS (
  SELECT c.id AS challenge_id, CASE
    WHEN c.reward_kind = 'pack' AND c.reward_pack_dist_id IS NOT NULL THEN (
      SELECT pe.gross_ev FROM public.pack_ev_latest pe
      WHERE pe.dist_id = c.reward_pack_dist_id AND pe.collection_id = c.collection_id LIMIT 1)
    WHEN c.reward_kind = 'moment' AND c.reward_moment_external_id IS NOT NULL THEN (
      SELECT fs.fmv_usd FROM public.editions e2 JOIN public.fmv_snapshots fs ON fs.edition_id = e2.id
      WHERE e2.external_id = c.reward_moment_external_id AND e2.collection_id = c.collection_id
      ORDER BY fs.computed_at DESC LIMIT 1)
    ELSE NULL END AS reward_value
  FROM ch c
)
SELECT jsonb_build_object(
  'wallet', p_wallet, 'generatedAt', now(), 'activeCount', (SELECT COUNT(*) FROM ch),
  'challenges', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'challengeId', c.id, 'slug', c.slug, 'name', c.name, 'challengeType', c.challenge_type,
      'status', c.status, 'endsAt', c.ends_at, 'imageUrl', c.image_url,
      'rewardKind', c.reward_kind, 'rewardLabel', c.reward_label,
      'totalRewardAllocation', c.total_reward_allocation, 'completedCount', c.completed_count,
      'totalRequired', pc.total_required, 'ownedCount', pc.owned_count,
      'missingCount', pc.total_required - pc.owned_count,
      'completionPct', ROUND(100.0 * pc.owned_count::numeric / NULLIF(pc.total_required, 0), 1),
      'costToComplete', pc.cost_to_complete, 'rewardValue', rw.reward_value,
      'netEv', CASE WHEN rw.reward_value IS NULL THEN NULL ELSE ROUND(rw.reward_value - pc.cost_to_complete, 2) END,
      'worthIt', CASE WHEN rw.reward_value IS NULL THEN NULL ELSE (rw.reward_value - pc.cost_to_complete) > 0 END)
      ORDER BY (rw.reward_value - pc.cost_to_complete) DESC NULLS LAST, c.ends_at ASC NULLS LAST)
    FROM ch c
    JOIN per_challenge pc ON pc.challenge_id = c.id
    JOIN reward rw ON rw.challenge_id = c.id), '[]'::jsonb)
)
$function$;

-- ── grants: anon revoked on all; authenticated read-only; write is service_role/operator ──
REVOKE ALL ON FUNCTION public.upsert_challenge(text,text,text,text,text,text,text,text,timestamptz,timestamptz,integer,integer,text,text,text,text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_challenge(text,text,text,text,text,text,text,text,timestamptz,timestamptz,integer,integer,text,text,text,text,jsonb,uuid) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.get_challenge_plan(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_plan(text,uuid) TO service_role, authenticated, postgres;

REVOKE ALL ON FUNCTION public.get_active_challenges(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_challenges(text,uuid) TO service_role, authenticated, postgres;
