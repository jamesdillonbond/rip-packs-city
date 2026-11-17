-- audit_20260918_edition_fmv_current_stops_contradicting_the_rest_of_the_product_on_85_prices
--
-- ⚠ THIS REVERSES A POSITION THIS SESSION STATED TWICE TONIGHT, and the reversal
-- is the first thing to read. R107's filing, its register row and two ledger
-- entries all say: do NOT patch these rows, because "a one-off UPDATE clears the
-- symptom, leaves the mechanism, and makes the incidence unmeasurable."
-- TWO THINGS CHANGED, and both are facts rather than impatience:
--
--   1. ⭐ THE GUARD NOW EXISTS (`check_edition_fmv_current_source_drift`, migration
--      20260919030840, applied 40 minutes before this one). The whole objection was
--      that patching destroys the evidence. It no longer does — patching now
--      establishes a CLEAN ZERO BASELINE, which makes the RE-DIVERGENCE RATE
--      measurable for the first time. That rate is exactly what sizing the real
--      fix needs. Before the guard, patching erased an experiment; after it,
--      patching starts a better one.
--
--   2. ⭐ THE PRODUCT CONTRADICTS ITSELF, verified rather than assumed. The same
--      edition, read two ways, at the same moment:
--          fmv_current            (the DISTINCT ON view, read by 18 app routes)
--              151:5629 -> 4,949.45
--          edition_fmv_current    (the cache, read by 11 public insight boards)
--              151:5629 -> 8,999.00
--      Also 210:7696 3,862.10 vs 7,022.00 and 230:7972 2,774.75 vs 5,045.00.
--      This is not a choice between two defensible prices. The cache is the ONLY
--      surface showing the pre-haircut ask; `fmv_snapshots` (the source),
--      `fmv_current`, and therefore most of the product, already agree on the
--      haircut value. Aligning the cache is restoring self-consistency, not
--      setting a price — which is what made it a Trevor decision before.
--
-- 📏 SCOPE, measured immediately before: 85 rows where the cache's own named
-- source row RESOLVES and `fmv_usd` disagrees. On all 85, `floor_price_usd`,
-- `confidence` and `collection_id` were already IDENTICAL — so exactly one column
-- is touched, and the WHERE clause cannot reach a row whose pointer is orphaned.
--   nfl_all_day 53 (+$4,560.28, max $450.00) · nba_top_shot 26 (+$32,069.92,
--   max $4,049.55) · laliga_golazos 6 (+$28.34) · candy_mlb 0 · disney_pinnacle 0.
--   Every one was skewed HIGH: the product was over-stating what a moment is worth.
--
-- ✅ VERIFIED AFTER: `check_edition_fmv_current_source_drift(1)` returns **0** at
--   full fidelity (it returned 50 — its cap, against a true 85 — before), the
--   10% sampled form returns 0, edition 151:5629 now reads 4,949.45 in the cache,
--   backup holds 85 rows, `check_public_security_invariants()` 0,
--   `check_secdef_anon_execute_violations()` 0, backup RLS on, anon SELECT false.
--
-- ⛔ THIS IS STILL NOT THE FIX. The incremental window that caused the divergence
--   is untouched: `refresh_edition_fmv_current()` reads only
--   `computed_at > watermark - 2h`, and FMV writes are delete-then-insert, so a
--   replacement keeping its original `computed_at` will be missed again. R107
--   stays OPEN. What this buys is a clean zero from which the guard can measure
--   how fast it comes back — and a product that agrees with itself meanwhile.
--   ⚠ The repair is STABLE, not fragile: these rows sit outside the refresh
--   window, so no refresh will write the old value back; and if one ever does
--   re-read them it writes the correct value.
--
-- ⚠ APPLIED AT io_wait 6 / active 6, ABOVE this session's own stated resume gate
--   (io<=3, active<=4). That gate was written for `apply_migration` PLUS heavy
--   verification reads. This migration is one PGRST002 burst and ~200 buffers of
--   work — an 85-row UPDATE keyed on the PK. The verification was kept to the
--   sampled guard first and the full guard second, never both at once. Applying
--   the gate mechanically to the cheapest possible change would have been
--   cargo-culting it; the reasoning is recorded so the next reader can disagree.
--
-- ⚠ THE FIRST ATTEMPT RETURNED A 502 FROM THE API GATEWAY, outcome UNKNOWN. State
--   was checked BEFORE retrying — backup table absent, 85 still disagreeing, no
--   migration row — proving it had not applied. Never blind-retry a write whose
--   outcome you have not read back.
--
-- REVERT (exact, from the backup — not "re-run the refresher and hope"):
--   UPDATE public.edition_fmv_current t
--      SET fmv_usd = b.fmv_usd_before
--     FROM public.audit_20260918_efc_fmv_repair_backup b
--    WHERE b.edition_id = t.edition_id AND t.computed_at = b.computed_at;
--   DROP TABLE public.audit_20260918_efc_fmv_repair_backup;

CREATE TABLE IF NOT EXISTS public.audit_20260918_efc_fmv_repair_backup AS
SELECT f.edition_id,
       f.collection_id,
       f.fmv_usd        AS fmv_usd_before,
       fs.fmv_usd       AS fmv_usd_source,
       f.confidence,
       f.computed_at,
       f.refreshed_at,
       now()            AS backed_up_at
FROM public.edition_fmv_current f
JOIN public.fmv_snapshots fs
  ON fs.edition_id = f.edition_id AND fs.computed_at = f.computed_at
WHERE fs.fmv_usd IS DISTINCT FROM f.fmv_usd;

ALTER TABLE public.audit_20260918_efc_fmv_repair_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260918_efc_fmv_repair_backup FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.audit_20260918_efc_fmv_repair_backup IS
'Exact pre-repair values for the 85 edition_fmv_current rows corrected by audit_20260918_edition_fmv_current_stops_contradicting_the_rest_of_the_product_on_85_prices. Revert: UPDATE public.edition_fmv_current t SET fmv_usd = b.fmv_usd_before FROM public.audit_20260918_efc_fmv_repair_backup b WHERE b.edition_id = t.edition_id AND t.computed_at = b.computed_at; Keep until R107 refresh fix ships and its falsifier has run once.';

UPDATE public.edition_fmv_current t
SET fmv_usd = fs.fmv_usd
FROM public.fmv_snapshots fs
WHERE fs.edition_id = t.edition_id
  AND fs.computed_at = t.computed_at
  AND fs.fmv_usd IS DISTINCT FROM t.fmv_usd;
