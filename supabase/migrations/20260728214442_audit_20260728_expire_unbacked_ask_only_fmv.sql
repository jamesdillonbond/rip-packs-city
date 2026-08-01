-- audit_20260728_expire_unbacked_ask_only_fmv
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260728214442, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. This is the highest-stakes item in the 2026-07-31 recovery set:
-- a PROD FMV DATA MUTATION (inserts NO_DATA/NULL expiry snapshots) that ran with
-- no revert path on disk. See docs/overnight/ledger.md 2026-07-31.
--
-- Revert (self-identifying by algo_version):
--   DELETE FROM public.fmv_snapshots WHERE algo_version = 'ask-only-expiry-2026-07-28';

-- Expire ASK_ONLY FMV prices whose backing ask is PROVABLY gone (Option A of
-- claude/ask-only-fmv-decision-2026-07-25.md; evidence refreshed in
-- claude/ask-only-fmv-recheck-2026-07-28.md). Approved by Trevor 2026-07-28.
--
-- WHY. These editions have ZERO lifetime sales and no live ask on their
-- collection's ask surface, yet still publish an ASK_ONLY price derived from an
-- ask that has since vanished -- e.g. Donovan Mitchell 245:8605::22, circulation
-- 1, zero sales, no ask, publishing $1,350. The rpc-data skill already states the
-- rule: "Zero-lifetime-sale editions with a lone ask = troll listings -- never
-- auto-price them." This ENFORCES an existing rule; it is not new policy.
--
-- NOT a mutation of history. fmv_snapshots is partitioned and its daily
-- duplicates are INTENTIONAL history, so this INSERTs a fresh NO_DATA / NULL
-- snapshot per target -- exactly how drain_fmv_cold_tail's own expiry path falls
-- through -- and lets the canonical DISTINCT ON (edition_id) ORDER BY computed_at
-- DESC read pick it up. No existing row is updated or deleted.
--
-- ASK SURFACE IS PER-COLLECTION (the trap that produced the wrong 214-row claim
-- on 07-25): edition_offers.low_ask for Top Shot (covers BOTH printings --
-- badge_editions holds zero '::' parallel rows so its NULL is structural, not
-- evidence), badge_editions.low_ask for All Day + Golazos, neither for UFC.
-- Top Shot additionally filtered to canonical '^[0-9]+:[0-9]+(::[0-9]+)?$'.
--
-- SAFETY, verified before applying: all four wallet_moments_cache FMV writers
-- (populate_wmc_fmv_from_snapshots both branches, refresh_wmc_fmv_changed,
-- refresh_wmc_fmv_drift_active, backfill_wmc_fmv_via_editions) filter
-- 'fmv_usd IS NOT NULL' and none can set NULL -- so this CANNOT cascade into wmc.
-- The 209 held moments / 89 wallets ($518.88 total) keep their cached values
-- unchanged. Wallet totals do not move; the edition + board surfaces get honest.
--
-- REVERT (one statement): the inserted rows are self-identifying by algo_version.
--   DELETE FROM public.fmv_snapshots
--    WHERE algo_version = 'ask-only-expiry-2026-07-28';
-- The prior ASK_ONLY snapshot is untouched underneath and immediately becomes the
-- latest again. audit_20260728_ask_only_expiry_targets holds the full pre-state.

CREATE TABLE IF NOT EXISTS public.audit_20260728_ask_only_expiry_targets AS
WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd, confidence, computed_at, collection_id
  FROM public.fmv_snapshots ORDER BY edition_id, computed_at DESC
)
SELECT l.edition_id, e.external_id, c.slug AS collection_slug, l.collection_id,
       l.fmv_usd AS prior_fmv_usd, l.confidence::text AS prior_confidence,
       l.computed_at AS prior_computed_at, now() AS captured_at
FROM latest l
JOIN public.editions e ON e.id = l.edition_id
JOIN public.collections c ON c.id = l.collection_id
WHERE l.confidence = 'ASK_ONLY'
  AND (c.slug <> 'nba_top_shot' OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
  AND l.computed_at < now() - interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.edition_id = l.edition_id)
  AND CASE
        WHEN c.slug = 'nba_top_shot'
          THEN NOT EXISTS (SELECT 1 FROM public.edition_offers eo
                            WHERE eo.external_id = e.external_id AND eo.low_ask IS NOT NULL)
        WHEN c.slug IN ('nfl_all_day','laliga_golazos')
          THEN NOT EXISTS (SELECT 1 FROM public.badge_editions be
                            WHERE be.external_id = e.external_id
                              AND be.collection_id = l.collection_id
                              AND be.low_ask IS NOT NULL)
        ELSE true
      END;

-- Every new public audit_* table lands with RLS off + anon SELECT by default
-- (root cause of the recurring smoke alert, 2026-07-26). Close it explicitly
-- rather than waiting for the hourly self-heal.
ALTER TABLE public.audit_20260728_ask_only_expiry_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260728_ask_only_expiry_targets FROM anon, authenticated;

-- Insert the expiry snapshots FROM the frozen audit set, so the write cannot
-- drift from what was captured and reviewed.
INSERT INTO public.fmv_snapshots
  (edition_id, collection_id, collection, fmv_usd, confidence, algo_version, computed_at)
SELECT t.edition_id, t.collection_id, t.collection_slug, NULL::numeric, 'NO_DATA'::text::fmv_confidence,
       'ask-only-expiry-2026-07-28', now()
FROM public.audit_20260728_ask_only_expiry_targets t;
