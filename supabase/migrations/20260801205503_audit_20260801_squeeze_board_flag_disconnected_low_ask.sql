-- audit_20260801_squeeze_board_flag_disconnected_low_ask
--
-- CAUSE
--   The PUBLIC /insights/squeeze board rendered a raw troll ask as if it were a
--   market price: "2022-23 Season Rewind" LEGENDARY (circulation 40) showed
--   Low ask $5000k next to FMV $200. The FMV pipeline clamps disconnected asks
--   (audit_20260702_fmv_clamp_disconnected_ask_topshot); the DISPLAYED low-ask
--   column had no such guard.
--
-- EVIDENCE (measured 2026-08-01, live, public.topshot_squeeze_board)
--   8,859 rows carry a low_ask. Only TEN exceed 10x their own FMV:
--     27,777.8x  Season Rewind: Signature Victory  LEGENDARY  $5,000,000 / $180    STALE
--     25,000.0x  2022-23 Season Rewind             LEGENDARY  $5,000,000 / $200    STALE
--        570.0x  Giannis "Cosmic"                  LEGENDARY      $3,249 / $5.70   ASK_ONLY
--         69.4x  LeBron "2023-24 Honors"           RARE              $59 / $0.85   LOW
--         33.5x  Jeremiah Fears "Rookie Ultimates" ULTIMATE      $57,000 / $1,700  STALE
--         24.9x / 23.0x / 17.8x / 14.2x / 11.0x   (five more, all LOW/SALES_ONLY/MEDIUM)
--   7 of the 10 fall inside the board's default view (squeeze_pct >= 50).
--   Every one of them has a weak FMV basis, so the honest statement is "this ask
--   is disconnected from our FMV" — which covers BOTH a troll listing and a
--   stale FMV — not "this ask is fake".
--
-- FIX
--   Mirror the Candy board's already-shipped precedent
--   (audit_20260724_candy_troll_floor_guard: exclude listings above a 10x
--   ceiling AND expose excluded_troll_count so the UI can footnote it) — but
--   FLAG rather than drop, because the QA requirement is to never silently
--   remove a row. Append a boolean `low_ask_disconnected` (low_ask > 10 * FMV);
--   `low_ask` itself is UNCHANGED so API consumers still see the raw number.
--   The client renders an em-dash + an explicit "ask is >10x FMV" note for a
--   flagged row and states the 10x rule on the page.
--   Column is APPENDED, so CREATE OR REPLACE VIEW accepts it and every existing
--   consumer's column positions are untouched.
--
-- REVERT SQL (exact): re-apply this same CREATE OR REPLACE VIEW with the final
--   `low_ask_disconnected` expression removed, then re-run
--   ALTER VIEW public.topshot_squeeze_board SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_squeeze_board TO anon, authenticated, service_role;

CREATE OR REPLACE VIEW public.topshot_squeeze_board AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    COALESCE(e.circulation_count, be.circulation_count) AS circulation,
    be.locked,
    be.burned,
    round(100.0 * COALESCE(be.locked, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS lock_pct,
    round(100.0 * COALESCE(be.burned, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS burn_pct,
    round(100.0 * (COALESCE(be.locked, 0) + COALESCE(be.burned, 0))::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS squeeze_pct,
    GREATEST(COALESCE(e.circulation_count, be.circulation_count, 0) - COALESCE(be.locked, 0) - COALESCE(be.burned, 0), 0) AS effectively_buyable,
        CASE
            WHEN fs.fmv_usd IS NULL THEN NULL::numeric
            ELSE be.low_ask
        END AS low_ask,
    fs.fmv_usd,
    fs.confidence,
    e.game_date,
    e.thumbnail_url,
    -- Disconnected-ask flag (2026-08-01). TRUE when the listed low ask is more
    -- than 10x this edition's FMV — the same 10x ceiling the Candy listing floor
    -- uses. It means "do not read this as a market price"; the cause is either a
    -- troll listing or a stale FMV, and we do not claim to know which.
    (fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0 AND be.low_ask IS NOT NULL
       AND be.low_ask > 10::numeric * fs.fmv_usd) AS low_ask_disconnected
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     LEFT JOIN LATERAL ( SELECT fs2.fmv_usd,
            fs2.confidence::text AS confidence
           FROM fmv_snapshots fs2
          WHERE fs2.edition_id = e.id
          ORDER BY fs2.computed_at DESC
         LIMIT 1) fs ON true
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND COALESCE(e.circulation_count, be.circulation_count) IS NOT NULL AND COALESCE(e.circulation_count, be.circulation_count) > 0;

ALTER VIEW public.topshot_squeeze_board SET (security_invoker = on);
GRANT SELECT ON public.topshot_squeeze_board TO anon, authenticated, service_role;

COMMENT ON VIEW public.topshot_squeeze_board IS
  'Public Top Shot lock/burn squeeze board. low_ask is the RAW listed ask; low_ask_disconnected marks asks >10x FMV so a surface never renders a troll listing as a market price (audit_20260801_squeeze_board_flag_disconnected_low_ask).';
