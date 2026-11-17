-- TWO OWED ITEMS, BATCHED DELIBERATELY so they cost ONE ~10-20 s PGRST002
-- schema-cache burst instead of two. Both belong to register #101.
--
-- ── 1. PROVENANCE ON topshot_misattrib_onchain_map ────────────────────────
-- #101's drain is dead (it fetches public-api.nbatopshot.com, measured 530), so
-- 1,315 Moments display under the wrong owner. `moments` was validated
-- NON-CIRCULARLY as a substitute source at 99.8% (515 of 516 rows whose
-- moments.updated_at PREDATES the map row's resolved_at, so they cannot have been
-- written by it) — but the 612 resolvable rows were NOT written, for one reason:
--
--   ⛔ THIS TABLE HAD NO PROVENANCE. Its columns are (nft_id, set_id_onchain,
--   play_id_onchain, serial_number, resolved_at) — nothing records where a row
--   came from. The map feeds remap_topshot_from_onchain_map() and
--   remap_topshot_wmc_from_onchain_map(), BOTH drift-pinned and BOTH mutating
--   `sales` and `moments`, so a wrong row does not merely fail to fix a Moment —
--   it REWRITES that NFT's identity. Without provenance such a row is
--   unfindable and the write is irreversible in practice.
--
-- This column is the stated precondition for that fix, shipped so the next session
-- is unblocked rather than re-deriving it.
--
-- ⚠ EXISTING ROWS ARE LEFT NULL ON PURPOSE — NULL means "pre-provenance, therefore
-- host-derived (all 49,206 rows resolved 2026-06-21..2026-08-28, before the host
-- died)". That is documented in the column comment rather than paid for with a
-- 49k-row bulk UPDATE that changes no semantics.
--
-- ⭐ SAFE TO ADD, verified rather than assumed — a new column breaks a reader only
-- if something does `SELECT *` or `INSERT` without a column list. Checked all four
-- functions that reference this table: ZERO `SELECT *`, ZERO inserts of either
-- shape (they insert into other tables; an earlier loose ILIKE suggested otherwise
-- and was wrong). The only writer is app/api/admin/drain-topshot-misattribution,
-- which upserts through supabase-js with explicit object keys.
--
-- ── 2. #101's SUPPRESSION RECORDS THAT ITS OWN PREDICATE HAS FAILED ───────
-- The topshot-misattrib-drain suppression carries a self-test: "count(*) <= 500 …
-- must stay TRUE or this suppression is wrong — delete it, do not renew". Measured
-- 1,315. ⛔ It is NOT deleted, deliberately: the drain is unscheduled because its
-- host is dead, so deleting would create a permanently-red arm for a lane with no
-- caller — the same mistake #102 nearly caused. The honest move is to record the
-- failure in the row itself so the next reader is not misled by a predicate that
-- silently stopped holding.
--
-- REVERT:
--   ALTER TABLE public.topshot_misattrib_onchain_map DROP COLUMN IF EXISTS source;
--   UPDATE public.pipeline_alert_suppression s SET reason = b.reason
--     FROM public.audit_20260913_suppression_stale_net_claims_backup b
--     WHERE s.pipeline = b.pipeline AND s.pipeline = 'topshot_misattrib_drain';

ALTER TABLE public.topshot_misattrib_onchain_map
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.topshot_misattrib_onchain_map.source IS
  'Where this resolution came from. NULL = pre-provenance, i.e. host-derived via '
  'public-api.nbatopshot.com before that host died (all rows resolved 2026-06-21..2026-08-28 '
  'are this). Any row written from a substitute source MUST set this — e.g. ''moments_v1'' — '
  'so derived rows are distinguishable and reversible as a set. This table feeds '
  'remap_topshot_from_onchain_map() and remap_topshot_wmc_from_onchain_map(), which MUTATE '
  'sales and moments, so an unattributable wrong row rewrites an NFT identity with no way '
  'to find it again. Added 2026-09-13 as the stated precondition for re-pointing the drain.';

INSERT INTO public.audit_20260913_suppression_stale_net_claims_backup (pipeline, reason, added_at, expires_at, backed_up_at)
SELECT pipeline, reason, added_at, expires_at, now()
FROM public.pipeline_alert_suppression
WHERE pipeline = 'topshot-misattrib-drain'
  AND NOT EXISTS (
    SELECT 1 FROM public.audit_20260913_suppression_stale_net_claims_backup b
    WHERE b.pipeline = 'topshot-misattrib-drain'
  );

UPDATE public.pipeline_alert_suppression
SET reason = reason || E'\n\n[CORRECTION 2026-09-13] THIS SUPPRESSION''S OWN PREDICATE HAS FAILED. '
  || 'It requires count(*) <= 500 on the open backlog and says "delete it, do not renew" if that '
  || 'stops holding. Measured 2026-09-13: 1,315 open of 18,959 candidates (93.1% mapped, down from '
  || '98.0%), and the candidate set SHRANK 20,128 -> 18,959 while the open pile grew, so this is '
  || 'not an inflow artifact. IT IS DELIBERATELY NOT DELETED: the drain is unscheduled because it '
  || 'fetches public-api.nbatopshot.com, which is measured dead, so deleting this would create a '
  || 'permanently-red arm for a lane with no caller. The real fix is to re-point the drain; '
  || '`moments` was validated non-circularly at 99.8% (515/516) as a substitute and covers 612 of '
  || 'the 1,315, and the preconditions are recorded in register #101. '
  || 'NOTE the backlog figure is a ONCE-DAILY snapshot (mv refreshed by pg_cron jobid 70, '
  || '"35 23 * * *"), so re-reading it within a day cannot show movement.'
WHERE pipeline = 'topshot-misattrib-drain';
