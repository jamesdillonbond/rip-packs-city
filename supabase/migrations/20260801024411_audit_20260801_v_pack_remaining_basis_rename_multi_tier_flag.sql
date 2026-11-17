-- Rename tier_scaling_would_help -> is_multi_tier. The column only ever measured
-- whether the publisher reports 2+ tiers with remaining stock; it does NOT imply
-- tier-scaling is applicable, which additionally requires an existing pool to scale
-- (not the case for the 679 'pool_missing' dists, of which 150 are multi-tier).
-- Encoding that judgement in the name would repeat the mistake this view just fixed.
-- REVERT: ALTER VIEW public.v_pack_remaining_basis RENAME COLUMN is_multi_tier TO tier_scaling_would_help;
ALTER VIEW public.v_pack_remaining_basis RENAME COLUMN tier_scaling_would_help TO is_multi_tier;

COMMENT ON VIEW public.v_pack_remaining_basis IS
'Per-distribution statement of WHAT the remaining-pull pool is derived from and whether it can be trusted. Cheap by design (no pack_rips scan). remaining_basis: publisher_remaining (Top Shot only, true per-edition remaining) | original_supply (AllDay/Golazos weight by minted circulation) | original_supply_mislabelled (gql_historical writes count/totalCount but the RPC reports ev_basis=remaining) | placeholder_uniform | depleted | pool_missing (genuine gap) | collection_models_no_pool (Pinnacle, by design). is_multi_tier is a primitive, not a recommendation: tier-scaled remaining is a no-op on single-tier dists and also requires an existing pool to scale, so combine it with remaining_basis. Built 2026-07-31; see docs/overnight/ledger.md.';