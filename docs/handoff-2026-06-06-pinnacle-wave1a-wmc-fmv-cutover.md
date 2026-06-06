# Wave 1a — populate_pinnacle_wmc_fmv cutover to render FMV (ready to apply live, Trevor eyeballs)

The one Wave-1 item with ZERO caller changes: `populate_pinnacle_wmc_fmv(p_limit)` keeps its signature and return shape (its caller, the populate-pinnacle-wmc-fmv cron route, is untouched), but reads `pinnacle_catalog.fmv_usd` by `wmc.render_id` instead of the blended `pinnacle_fmv_snapshots` by `edition_key`, and becomes a true SYNC (IS DISTINCT FROM) instead of fill-only. Effect: every wallet's displayed Pinnacle FMV (dashboard / share / profile) moves to per-render pricing — Dumbo previews $1,030 → ~$1,405 (+36%), Genie's Lamp $247→$538, Spinning Wheel $247→$164 (matches the $165 live floor). Cowork applies via apply_migration on Trevor's go, runs to convergence, verifies together; revert is the captured body below.

## Apply (one migration: audit_20260606_pinnacle_wmc_fmv_render_cutover)

CREATE OR REPLACE FUNCTION public.populate_pinnacle_wmc_fmv(p_limit integer DEFAULT 5000)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp' SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_collection_id uuid; v_updated int := 0; v_examined int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = 'disney_pinnacle';
  WITH candidates AS (
    SELECT wmc.wallet_address, wmc.moment_id, wmc.collection_id, pc.fmv_usd AS new_fmv
    FROM wallet_moments_cache wmc
    JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.collection_id = v_collection_id
      AND wmc.render_id IS NOT NULL
      AND pc.fmv_usd IS NOT NULL
      AND wmc.fmv_usd IS DISTINCT FROM pc.fmv_usd
    LIMIT p_limit
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc SET fmv_usd = c.new_fmv
    FROM candidates c
    WHERE wmc.wallet_address = c.wallet_address AND wmc.moment_id = c.moment_id
      AND wmc.collection_id = c.collection_id
    RETURNING wmc.moment_id
  )
  SELECT (SELECT COUNT(*) FROM candidates), (SELECT COUNT(*) FROM upd) INTO v_examined, v_updated;
  RETURN json_build_object('examined', v_examined, 'updated', v_updated,
    'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0');
END;
$function$;

Notes: same signature → CREATE OR REPLACE PRESERVES the existing grants (the new-signature-resets-grants trap does not apply); SECDEF + search_path + 300s timeout retained; algo tag bumped so wmc writes are attributable.

## The one product decision (pick before convergence)

~290 renders have no per-render price yet (no sales 90d). Their wmc rows currently carry BLENDED legacy values (Dumbo holds 28 such pins).
- Option A (recommended — honest, matches the TS NO_DATA convention): null them in the transition pass:
  UPDATE wallet_moments_cache wmc SET fmv_usd = NULL
  FROM pinnacle_catalog pc
  WHERE wmc.collection_id = (SELECT id FROM collections WHERE slug='disney_pinnacle')
    AND pc.render_id = wmc.render_id AND pc.fmv_usd IS NULL AND wmc.fmv_usd IS NOT NULL;
- Option B: leave the stale blended values until those renders trade (they linger indefinitely; a Dapper-savvy eye could catch a wrong-character-priced pin).

## Run-to-convergence + verify (Cowork does this live, Trevor eyeballs)

1. SELECT populate_pinnacle_wmc_fmv(5000); repeat until updated=0 (~8 calls for the ~36k-row first sync; hourly cron keeps it synced after).
2. (Option A) run the null pass; expect ~a few hundred rows.
3. Verify: Dumbo snapshot total ~$1,405; Genie's Lamp moment $537.78; Spinning Wheel $163.60; a second wallet spot; /share/0x37a7e864611c7a85 renders the new total (5-min CDN).
4. Trevor eyeballs dashboard + share. Bad vibes → revert below, re-run legacy populate, values restore within minutes.

## Revert (captured current body, verbatim)

CREATE OR REPLACE FUNCTION public.populate_pinnacle_wmc_fmv(p_limit integer DEFAULT 5000)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp' SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_collection_id uuid;
  v_updated int := 0;
  v_examined int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = 'disney_pinnacle';
  WITH
  latest_snap AS (
    SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
    FROM pinnacle_fmv_snapshots WHERE fmv_usd IS NOT NULL
    ORDER BY edition_id, computed_at DESC
  ),
  candidates AS (
    SELECT wmc.wallet_address, wmc.moment_id, wmc.collection_id, wmc.edition_key
    FROM wallet_moments_cache wmc
    WHERE wmc.collection_id = v_collection_id
      AND (wmc.fmv_usd IS NULL OR wmc.fmv_usd = 0)
      AND wmc.edition_key IS NOT NULL
    LIMIT p_limit
  ),
  resolved AS (
    SELECT c.wallet_address, c.moment_id, c.collection_id, ls.fmv_usd
    FROM candidates c JOIN latest_snap ls ON ls.edition_id = c.edition_key
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc SET fmv_usd = r.fmv_usd
    FROM resolved r
    WHERE wmc.wallet_address = r.wallet_address AND wmc.moment_id = r.moment_id
      AND wmc.collection_id = r.collection_id
    RETURNING wmc.moment_id
  )
  SELECT (SELECT COUNT(*) FROM candidates), (SELECT COUNT(*) FROM upd) INTO v_examined, v_updated;
  RETURN json_build_object('examined', v_examined, 'updated', v_updated,
    'collection', 'disney_pinnacle', 'algo', 'direct-edition-key-1.0');
END;
$function$;

(Plus, on revert: re-fill values via the legacy NULL-only semantics — set the nulled/changed rows back by running the restored function after a one-time `UPDATE wmc SET fmv_usd=NULL WHERE collection=pinnacle` if a full restore is wanted.)

## Wave 1b (CC handoff, after 1a is eyeballed)

Pin page (app/pinnacle/moment/[id] → render_id-keyed), get_pinnacle_edition_fmv (callers pass legacy keys — needs render-aware callers), pinnacle_scarcity_board view + /insights page (rows become per-render). Each needs the per-surface render-key product call; packaged once 1a looks right live.
