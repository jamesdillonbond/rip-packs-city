-- audit_20261108_top_owned_moments_force_custom_plan
--
-- Dame Time, 2026-11-08 ~9:10 PM PT, follow-up to
-- 20261109050827_audit_20261108_trophy_picker_panini_name_filter_first.
-- Applied as a PRECAUTION, and the hypothesis that prompted it was NOT confirmed:
-- right after that migration, rigged's Panini-tab call read 14k blocks and ran
-- 22.7 s, and I suspected a cached GENERIC plan reading all 47,665 of his
-- wallet_moments_cache rows (a generic plan cannot index
-- `(p_collection_id IS NULL OR wmc.collection_id = p_collection_id)`). Measured
-- afterwards: the same call WARM runs 240 ms on 91k buffer hits and 3 reads,
-- the same work as the body run as literal SQL (85k hits). The slow runs were
-- cold reads (panini_card_serials lookups per held card), not the plan.
-- force_custom_plan is kept because it guarantees the collection filter can use
-- the (wallet, collection) index on every call, for a few ms of planning on a
-- one-statement function. It is not the fix for the 11-08 timeout.
--
-- Revert: ALTER FUNCTION public.get_user_top_owned_moments(uuid, integer, text, uuid, text, integer) RESET plan_cache_mode;

ALTER FUNCTION public.get_user_top_owned_moments(uuid, integer, text, uuid, text, integer)
  SET plan_cache_mode = force_custom_plan;
