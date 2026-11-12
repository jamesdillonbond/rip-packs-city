# Top Shot box / case drop day — give it an EV the day it lands

Written 2026-11-12 (Cowork cloud) after the Rookie Debut 2026-27 Box (8917) and Case (8916) sat a day with no EV.

## Why this is needed

A box or case is a PackNFT that yields PackNFTs, so it has no Moment pool. `refresh_container_pack_ev()` (pg_cron `:28` hourly) prices it as Σ count × inner-pack EV, but **only from a `pack_container_recipes` row**, and recipes are `observed` from opened containers. A new drop has no opened container, so it has no recipe and no EV until someone opens one. Background: `docs/reference/packs.md`, "Top Shot boxes and cases — the product model".

## What tells you

The trust arm **`topshot_container_missing_recipe_count`** (`v_rpc_trust_health`, migration `20261112153211`) counts Top Shot dists that are a box or case (typed `pack_type` box|case, or the title ends in "Box"/"Case"), first seen in the last 30 days, with no recipe. It breaches at 1, and the sentinel lists it in its Trust Health warning every tick until it clears.

## Steps

1. **Find the containers and their inner packs.**
   ```sql
   SELECT pd.dist_id, pd.title, pd.metadata->>'number_of_pack_slots' AS slots, pd.metadata->>'description' AS description
   FROM pack_distributions pd
   WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND pd.first_seen_at > now() - interval '30 days'
   ORDER BY pd.dist_id;
   ```
   The container's description names its contents ("holds 5 packs and 18 Moments: a Box Topper and 4 … Collector Packs"). The inner packs are the same drop's other dists (Collector Pack, Box Topper, Case Topper, Premium Pack…), each with its own `number_of_pack_slots`.
2. **Write the seed migration** from the template `supabase/migrations/20261112144751_audit_20261112_rookie_debut_2026_box_and_case_recipes.sql`: one `('95f28a17-…', '<container>', '<inner>', <count>, 'description')` row per inner pack, `ON CONFLICT DO NOTHING`. Keep its DO block, so the migration fails if Σ count ≠ the container's `number_of_pack_slots`, or if the Moment total ≠ the number the description states.
3. **Apply it** (`apply_migration`), rename the file to the version the DB assigned, commit it with a ledger entry.
4. **Price it now** instead of waiting for `:28`: `SELECT public.refresh_container_pack_ev();` then `SELECT public.refresh_mv_pack_ev_latest();`. Confirm `mv_pack_ev_latest` has a row for each container. Then confirm on the next **scheduled** run as well (`pipeline_runs` `topshot-container-pack-ev`, `containers` up by the number seeded). A manual run does not prove the scheduled one.
5. **Check the page.** `/nba-top-shot/pack/dist/<container>` shows "What's inside this box/case" with Rip EV and Sealed value. Its hero EV reads `/box` or `/case`.

## What to expect

- The container's `fmv_coverage_pct` is the **minimum** inner coverage. A topper whose chase editions have not sold yet keeps the container under `pack_table_rows`' 25 % gate (the 2026-27 Case read 21 % on drop day). That is correct: the page panel shows each inner pack's EV and the sealed value, and withholds the Rip EV total. Nothing to fix; it publishes once the topper prices.
- The first opened container replaces the `description` recipe with an `observed` one (step 1 of the writer).
- No description, nothing to seed from (e.g. 8426 "2025-26 NBA Playoffs Mega Box": one pack NFT, no metadata). Leave it; the arm's 30-day window lets it age out instead of reading red forever.
