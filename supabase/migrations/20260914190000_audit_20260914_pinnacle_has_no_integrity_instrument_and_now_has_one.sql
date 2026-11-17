-- audit_20260914: Pinnacle had NO integrity instrument at all — now it has one
--
-- ⚠ THE GAP. `v_edition_integrity_flags` groups over `editions`, and Pinnacle
-- keeps its catalog in `pinnacle_editions` — 0 rows in `editions`, 570 in its own
-- table. So the view emits five collections and is SILENT about a sixth, live one,
-- and the `edition_integrity_flags` arm of `v_rpc_trust_health` (which sums
-- circulation + tier + thumbnail across whatever rows that view emits) has never
-- been able to see a single Pinnacle defect. The 2026-07-28 migration that fixed
-- that arm documents its OTHER exclusion (the structurally-null candy/ufc
-- on-chain-id columns) but says nothing about a whole uncovered collection —
-- an exclusion nobody stated is the kind that expires silently.
--
-- 📊 WHAT IT COULD NOT SEE, measured 2026-09-14 over 570 rows:
--     155  unhydrated STUB rows — no edition_key AND no mint_count AND no
--          series_year AND no ask, all in one set_name, created 2026-04-16 →
--          2026-08-23. Perfectly correlated across every column, which is the
--          tell for un-run hydration rather than 155 broken products.
--      64  REAL editions (keyed, minted) with no thumbnail_url.
--       2  real editions with a null/zero mint_count (157 total minus the stubs).
--       0  missing character_name, variant_type or set_name.
--
-- ⛔ WHY THIS IS A NEW VIEW AND NOT A SIXTH ROW IN THE EXISTING ONE. Adding
-- Pinnacle to `v_edition_integrity_flags` would push the trust arm from ~104 to
-- ~320 against a breach_at of 250 — an immediate page on a FIVE-MONTH-OLD
-- backlog, not on a deterioration. An alarm that fires the moment you widen its
-- vision teaches people to silence it. The threshold is also explicitly Trevor's
-- call (ledger 2026-07-28, "Trevor's call to include thumbnails"), so this view
-- makes the number VISIBLE and leaves the wiring + threshold to that decision.
-- Wiring note for whoever does it: add a Pinnacle arm with its own breach_at
-- ABOVE the then-current stub backlog, or drain the stubs first and set it at 0.
--
-- ⛔ WHAT I DELIBERATELY DID NOT DO. The 64 thumbnails look backfillable from
-- `wallet_moments_cache`, and they are not: those images are PER-MOMENT render
-- paths (`/api/public/pinnacle-image/<renderId>`), 60 of the 64 resolve to more
-- than one distinct image, and they are relative paths rather than URLs. Picking
-- one would pin a single collector's pin as the edition's canonical art —
-- a fabricated pairing. An edition-grain source is needed, not a moment-grain one.
--
-- security_invoker=on + anon/authenticated SELECT to match the sibling view.
-- Verified after applying, AS ANON: 570 / 155 stubs / 2 bad mint / 64 no thumb /
-- 0 missing variant / 0 missing character / oldest stub 2026-04-16.
--
-- REVERT: DROP VIEW public.v_pinnacle_integrity_flags;

CREATE OR REPLACE VIEW public.v_pinnacle_integrity_flags AS
SELECT
  'disney_pinnacle'::text AS collection,
  count(*)                                                            AS total_editions,
  -- A stub is the perfectly-correlated cluster above, not a broken edition.
  -- Counted separately so a real defect can never hide inside the backlog.
  count(*) FILTER (
    WHERE (edition_key IS NULL OR edition_key = '')
      AND (mint_count IS NULL OR mint_count = 0)
  )                                                                   AS unhydrated_stubs,
  count(*) FILTER (
    WHERE NOT ((edition_key IS NULL OR edition_key = '') AND (mint_count IS NULL OR mint_count = 0))
      AND (mint_count IS NULL OR mint_count = 0)
  )                                                                   AS real_bad_mint_count,
  count(*) FILTER (
    WHERE NOT ((edition_key IS NULL OR edition_key = '') AND (mint_count IS NULL OR mint_count = 0))
      AND (thumbnail_url IS NULL OR thumbnail_url = '')
  )                                                                   AS real_missing_thumbnail,
  count(*) FILTER (
    WHERE NOT ((edition_key IS NULL OR edition_key = '') AND (mint_count IS NULL OR mint_count = 0))
      AND (variant_type IS NULL OR variant_type = '')
  )                                                                   AS real_missing_variant,
  count(*) FILTER (
    WHERE NOT ((edition_key IS NULL OR edition_key = '') AND (mint_count IS NULL OR mint_count = 0))
      AND (character_name IS NULL OR character_name = '')
  )                                                                   AS real_missing_character,
  min(created_at) FILTER (
    WHERE (edition_key IS NULL OR edition_key = '')
      AND (mint_count IS NULL OR mint_count = 0)
  )                                                                   AS oldest_stub_created_at
FROM public.pinnacle_editions;

ALTER VIEW public.v_pinnacle_integrity_flags SET (security_invoker = on);

GRANT SELECT ON public.v_pinnacle_integrity_flags TO anon, authenticated;

COMMENT ON VIEW public.v_pinnacle_integrity_flags IS
  'Integrity counts for the Pinnacle catalog, which lives in pinnacle_editions and is therefore INVISIBLE to v_edition_integrity_flags (that view groups over `editions`, where Pinnacle has 0 rows). Splits the unhydrated stub backlog from real defects so one cannot hide inside the other. NOT yet wired into v_rpc_trust_health: doing so would move the edition_integrity_flags arm from ~104 to ~320 against breach_at 250 and page on a five-month-old backlog. audit_20260914.';
