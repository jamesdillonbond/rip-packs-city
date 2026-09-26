-- 2026-09-25 (PT) — reverses 20260926023037. Trevor: "keep their internal
-- packs visible if they're legitimate and hold any moments."
--
-- Every one of the 33 excluded All Day distributions holds moments: minted
-- packs 3–39,984 and a non-empty drop pool of 1–342 editions each (measured
-- ~8:05 PM PT from pack_distributions.total_minted + pack_drop_pool). Under
-- that rule none of them is hidden, so the exclusion mechanism has nothing to
-- do; it is removed rather than left idle. The readers (/api/packs, the pack
-- sitemap) are reverted in the same push and fail open until it deploys.
--
-- Revert: re-apply 20260926023037.

DROP VIEW IF EXISTS public.v_pack_distribution_exclusions_active;
DROP TABLE IF EXISTS public.pack_distribution_exclusions;
