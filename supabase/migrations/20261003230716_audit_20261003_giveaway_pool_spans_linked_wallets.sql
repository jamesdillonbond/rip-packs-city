-- audit_20261003: a giveaway pool can draw from the sponsor's Flow Wallet AND every
-- account linked to it (Trevor, 2026-10-03: "instead of me providing my wallet address
-- when I'm setting up a pack, I should just sign in with my flow wallet there, so then
-- it pulls all my assets across both wallets when it's providing options for what to
-- stuff the packs with").
--
--   * giveaway_pack_moments.source_wallet: the account each pool moment sits in (the
--     sponsor's Flow Wallet, or a Hybrid Custody child it has redeemed, e.g. the Dapper
--     account). Existing rows are backfilled from their drop's admin_wallet, which is
--     where every v1 moment came from.
--   * NEW create_giveaway_draft_multi(... p_moment_ids, p_source_wallets): one source per
--     moment (NULL = every moment from p_admin_wallet). Each (moment, source) pair is checked
--     against THAT source's cache rows (held, unlocked, same collection). Whether a
--     source really is linked to the sponsor is a CHAIN fact, verified by the server
--     (Hybrid Custody, redeemed status) before it calls this and again at seal.
--   * create_giveaway_draft keeps its signature and becomes a pass-through to
--     create_giveaway_draft_multi with NULL sources, so the deployed v1 code keeps
--     working unchanged. (No DROP: the Supabase MCP holds any DROP for interactive
--     confirmation, which timed out three times on 2026-10-03.)
--   * claim_giveaway_pack also refuses a recipient that is any of the pool's source
--     accounts (the sponsor can't win their own pack via their linked account).
--
-- Revert: re-apply create_giveaway_draft and claim_giveaway_pack from
--   20260929192842_audit_20260929_community_pack_giveaways.sql, then remove
--   create_giveaway_draft_multi and the giveaway_pack_moments.source_wallet column
--   (both removals need an interactively confirmed statement).

ALTER TABLE public.giveaway_pack_moments ADD COLUMN IF NOT EXISTS source_wallet text;

UPDATE public.giveaway_pack_moments m
   SET source_wallet = d.admin_wallet
  FROM public.giveaway_drops d
 WHERE d.id = m.drop_id AND m.source_wallet IS NULL;

ALTER TABLE public.giveaway_pack_moments ALTER COLUMN source_wallet SET NOT NULL;

ALTER TABLE public.giveaway_pack_moments
  ADD CONSTRAINT giveaway_pack_moments_source_wallet_format CHECK (source_wallet ~ '^0x[0-9a-f]{16}$');

CREATE OR REPLACE FUNCTION public.create_giveaway_draft_multi(
  p_slug text,
  p_title text,
  p_description text,
  p_sponsor_name text,
  p_collection_id uuid,
  p_admin_wallet text,
  p_pack_count int,
  p_moments_per_pack int,
  p_moment_ids text[],
  p_source_wallets text[]
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_wallet text := lower(trim(p_admin_wallet));
  v_ids text[] := ARRAY(SELECT DISTINCT unnest(p_moment_ids));
  v_sources text[];
  v_found int;
  v_missing text[];
  v_locked text[];
BEGIN
  IF cardinality(v_ids) <> cardinality(p_moment_ids) THEN
    RAISE EXCEPTION 'giveaway: the pool lists a moment twice' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) <> p_pack_count * p_moments_per_pack THEN
    RAISE EXCEPTION 'giveaway: % moments selected; % packs of % need %',
      cardinality(v_ids), p_pack_count, p_moments_per_pack, p_pack_count * p_moments_per_pack
      USING ERRCODE = '22023';
  END IF;

  IF p_source_wallets IS NULL THEN
    v_sources := array_fill(v_wallet, ARRAY[cardinality(p_moment_ids)]);
  ELSE
    IF cardinality(p_source_wallets) <> cardinality(p_moment_ids) THEN
      RAISE EXCEPTION 'giveaway: % moments but % source wallets', cardinality(p_moment_ids), cardinality(p_source_wallets)
        USING ERRCODE = '22023';
    END IF;
    v_sources := ARRAY(SELECT lower(trim(s)) FROM unnest(p_source_wallets) WITH ORDINALITY AS u(s, n) ORDER BY n);
    IF EXISTS (SELECT 1 FROM unnest(v_sources) s WHERE s IS NULL OR s !~ '^0x[0-9a-f]{16}$') THEN
      RAISE EXCEPTION 'giveaway: a source wallet is not a Flow 0x address' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT ARRAY(SELECT p.mid || '@' || p.src FROM unnest(p_moment_ids, v_sources) AS p(mid, src)
                WHERE NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                                   WHERE w.wallet_address = p.src
                                     AND w.collection_id = p_collection_id
                                     AND w.moment_id = p.mid))
    INTO v_missing;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'giveaway: not held per the cache (moment@wallet): %', array_to_string(v_missing, ',')
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT DISTINCT w.moment_id FROM unnest(p_moment_ids, v_sources) AS p(mid, src)
                 JOIN public.wallet_moments_cache w
                   ON w.wallet_address = p.src
                  AND w.collection_id = p_collection_id
                  AND w.moment_id = p.mid
                WHERE w.is_locked IS NOT FALSE)
    INTO v_locked;
  IF cardinality(v_locked) > 0 THEN
    RAISE EXCEPTION 'giveaway: locked (or lock unknown), cannot be gifted: %', array_to_string(v_locked, ',')
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.giveaway_drops
    (slug, title, description, sponsor_name, collection_id, admin_wallet, pack_count, moments_per_pack)
  VALUES
    (lower(trim(p_slug)), trim(p_title), nullif(trim(p_description), ''), trim(p_sponsor_name),
     p_collection_id, v_wallet, p_pack_count, p_moments_per_pack)
  RETURNING id INTO v_id;

  INSERT INTO public.giveaway_pack_moments
    (drop_id, moment_id, source_wallet, edition_key, player_name, set_name, team_name, tier, serial_number, fmv_usd, image_url)
  SELECT DISTINCT ON (p.mid)
         v_id, p.mid, p.src, w.edition_key, w.player_name, w.set_name, w.team_name, w.tier,
         w.serial_number, w.fmv_usd, w.image_url
    FROM unnest(p_moment_ids, v_sources) AS p(mid, src)
    JOIN public.wallet_moments_cache w
      ON w.wallet_address = p.src
     AND w.collection_id = p_collection_id
     AND w.moment_id = p.mid
   ORDER BY p.mid, w.last_seen_at DESC NULLS LAST;

  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'giveaway: copied % of % pool moments', v_found, cardinality(v_ids) USING ERRCODE = 'P0001';
  END IF;
  RETURN v_id;
END;
$function$;

-- anon-exec: revoked (create_giveaway_draft_multi) — new function; service_role only, like create_giveaway_draft (verified anon=false 2026-10-03).
REVOKE EXECUTE ON FUNCTION public.create_giveaway_draft_multi(text, text, text, text, uuid, text, int, int, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_giveaway_draft_multi(text, text, text, text, uuid, text, int, int, text[], text[]) TO service_role;

-- anon-exec: unchanged (create_giveaway_draft) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false 2026-10-03.
CREATE OR REPLACE FUNCTION public.create_giveaway_draft(
  p_slug text,
  p_title text,
  p_description text,
  p_sponsor_name text,
  p_collection_id uuid,
  p_admin_wallet text,
  p_pack_count int,
  p_moments_per_pack int,
  p_moment_ids text[]
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- v1 call: every moment comes from the admin wallet
  RETURN public.create_giveaway_draft_multi(p_slug, p_title, p_description, p_sponsor_name, p_collection_id,
                                            p_admin_wallet, p_pack_count, p_moments_per_pack, p_moment_ids, NULL);
END;
$function$;

-- anon-exec: unchanged (claim_giveaway_pack) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false 2026-10-03.
CREATE OR REPLACE FUNCTION public.claim_giveaway_pack(
  p_drop_id uuid,
  p_user_id uuid,
  p_username text,
  p_recipient text
)
RETURNS TABLE (pack_no int, outcome text)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_drop public.giveaway_drops;
  v_pack int;
  v_recipient text := lower(trim(p_recipient));
BEGIN
  -- serialises every claim on this drop: two claims can never pick the same pack
  SELECT * INTO v_drop FROM public.giveaway_drops d WHERE d.id = p_drop_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::int, 'not_found'::text; RETURN;
  END IF;

  SELECT c.pack_no INTO v_pack
    FROM public.giveaway_claims c
   WHERE c.drop_id = p_drop_id AND c.user_id = p_user_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_pack, 'already_claimed'::text; RETURN;
  END IF;

  IF v_drop.status <> 'open' THEN
    RETURN QUERY SELECT NULL::int, 'not_open'::text; RETURN;
  END IF;

  -- the sponsor's own wallet, or any account the pool is drawn from
  IF v_recipient = v_drop.admin_wallet
     OR EXISTS (SELECT 1 FROM public.giveaway_pack_moments m
                 WHERE m.drop_id = p_drop_id AND m.source_wallet = v_recipient) THEN
    RETURN QUERY SELECT NULL::int, 'admin_recipient'::text; RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.giveaway_claims c
              WHERE c.drop_id = p_drop_id AND c.recipient_address = v_recipient) THEN
    RETURN QUERY SELECT NULL::int, 'recipient_taken'::text; RETURN;
  END IF;

  -- a uniformly random unclaimed pack (gen_random_uuid draws from the OS CSPRNG)
  SELECT g.n INTO v_pack
    FROM generate_series(1, v_drop.pack_count) AS g(n)
   WHERE NOT EXISTS (SELECT 1 FROM public.giveaway_claims c
                      WHERE c.drop_id = p_drop_id AND c.pack_no = g.n)
   ORDER BY gen_random_uuid()
   LIMIT 1;
  IF v_pack IS NULL THEN
    RETURN QUERY SELECT NULL::int, 'all_claimed'::text; RETURN;
  END IF;

  INSERT INTO public.giveaway_claims (drop_id, pack_no, user_id, topshot_username, recipient_address)
  VALUES (p_drop_id, v_pack, p_user_id, trim(p_username), v_recipient);

  RETURN QUERY SELECT v_pack, 'claimed'::text;
END;
$function$;
