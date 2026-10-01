-- DB invariant: public.ask_is_alertable(text, timestamptz, timestamptz) → boolean
-- — the one predicate standing between an unconfirmed ask and a push
-- notification. Its two consumers are pinned separately
-- (supabase/tests/dispatch_due_deal_alerts.sql, the sender; and
-- supabase/tests/build_deal_alerts_for_subscription.sql, the preview), and both
-- embed this same DDL; all three copies are registered in
-- __tests__/db-invariants-drift-guard.test.ts.
--
-- 🚨 WHY A SIX-LINE FUNCTION IS WORTH A PIN FILE. It is six lines that decide
-- whether a human is woken up, and every way it can be wrong is SILENT:
--   · widen the window and the 2026-09-12 defect returns (a $0.50 ask delivered
--     for the fourth night from a stamp frozen three days earlier, floor $1.03);
--   · gate the exempt arms and 1,937 of 1,956 CORRECT All Day rows vanish
--     (measured 2026-09-13) — an alert stream that goes quiet, which nothing
--     else in the estate can distinguish from a quiet market;
--   · invert the CASE so it LISTS the gated arms, and a new collection or the
--     other collection-string convention silently disables the gate.
-- None of those reds anything. All of them are pinned below.
--
--
-- ⛔ CORRECTED 2026-09-13 (audit_20260913_the_ask_stamp_means_three_different_things):
-- "re-confirmed" is TRUE for Pinnacle and FALSE for Top Shot. `edition_offers.updated_at`
-- is bumped ONLY WHEN THE FLOOR CHANGES (the Atlas writer's ON CONFLICT carries an
-- IS DISTINCT FROM guard), so on that arm this file pins "the floor CHANGED inside
-- ASK_STALE_HOURS". The assertions and the body are unchanged and still correct; the
-- WORD was wrong. It was a confirmation stamp until offers-sweep died on 2026-08-28 —
-- the column's meaning changed with its WRITER while its name stayed put.
-- Pinned here:
--   1. THE THRESHOLD IS 12 h, AND IT IS A THRESHOLD. 11 h alertable, 13 h not,
--      and exactly 12 h not — asserted as a pair so a widened window cannot pass
--      on a now() fixture alone. ⚠ 12 h is ASK_STALE_HOURS from
--      lib/market/ask-freshness.ts, the marker the boards already render;
--      __tests__/alert-ask-gate-matches-the-site-wide-stale-marker.test.ts fails
--      if the two ever drift apart.
--   2. UNKNOWN FAILS CLOSED. A NULL stamp is NOT alertable. "Unknown is not
--      stale" is correct for RENDERING an age marker (isAskStale) and wrong for
--      deciding to send a notification, and the two rules live one import apart.
--   3. THE EXEMPT ARMS ARE EXEMPT AT ANY AGE. nfl_all_day and laliga_golazos
--      read `cached_listings_v2.listed_at` — when the SELLER listed it — over an
--      event-sourced OPEN-listing index a row LEAVES when the listing closes. A
--      six-week-old listed_at describes a live listing, not a neglected one.
--   4. THE CASE LISTS THE EXEMPTIONS, SO EVERYTHING ELSE FAILS CLOSED — an
--      unknown collection, and specifically the hyphen spelling
--      ('nba-top-shot'), which is live in this codebase: the serial pass's own
--      payload carries it. Written the other way round, a typo would disable the
--      gate and nothing would say so.
--   5. `p_now` IS INJECTABLE, which is what makes 1 and 3 testable at all
--      without sleeping.
--
-- Mutation-verified 2026-09-13, five run and five killed. The named assertion
-- each one trips:
--   • `interval '12 hours'` → `'24 hours'`      → 'an ask confirmed 13 h ago is NOT alertable'
--   • `>` → `>=` on the window                  → 'exactly 12 h is NOT alertable'
--   • drop `p_ask_at IS NOT NULL AND`           → 'a NULL stamp is NOT alertable'
--   • the CASE written the WRONG WAY ROUND
--     (listing the GATED arms, `ELSE true`)     → 'the HYPHEN spelling is gated'
--   • exempt list gains 'nba_top_shot'          → 'an ask confirmed 13 h ago is NOT alertable'
-- ⭐ The fourth is the one to keep: it is the SPELLING a careless rewrite would
-- reach for, it passes cases 1-3 intact, and only the hyphen case sees it.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261001030000_audit_20260930_topshot_alert_asks_are_rechecked_before_they_are_sent.sql).

BEGIN;

-- >>> BEGIN verbatim ask_is_alertable (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.ask_is_alertable(
  p_collection_slug text,
  p_ask_at          timestamptz,
  p_now             timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    -- CANDIDATE SCAN ONLY (audit_20260930): alert_candidate_verify_dispatch()
    -- sets this transaction-locally to ask the preview which asks WOULD match a
    -- subscription at any age, so it can re-check them on Atlas BEFORE they are
    -- sent. It never sends anything; the sender never sets it.
    WHEN current_setting('rpc.alert_candidate_scan', true) = 'on' THEN true
    -- EXEMPT: event-sourced open-listing books. The stamp is the seller's
    -- listing date, not a confirmation, and the row leaves the view when the
    -- listing closes. See the header -- gating these deletes correct rows.
    WHEN p_collection_slug IN ('nfl_all_day', 'laliga_golazos') THEN true
    -- Top Shot EDITION asks: confirmed within ALERT_TOPSHOT_ASK_MAX_AGE_HOURS
    -- (1 h, lib/market/ask-freshness.ts). The stamp is
    -- edition_offers.low_ask_confirmed_at, which the alert-candidate re-check
    -- lane refreshes. Both spellings, so a convention slip is STRICTER, not looser.
    WHEN p_collection_slug IN ('nba_top_shot', 'nba-top-shot') THEN
      p_ask_at IS NOT NULL AND p_ask_at > p_now - interval '1 hours'
    -- Everything else (Pinnacle, the Top Shot serial board 'nba_top_shot:serial',
    -- anything new) must have been CONFIRMED inside ASK_STALE_HOURS (12 h,
    -- lib/market/ask-freshness.ts). Unknown (NULL) is not alertable.
    ELSE p_ask_at IS NOT NULL AND p_ask_at > p_now - interval '12 hours'
  END
$function$;
-- <<< END verbatim ask_is_alertable <<<

-- ── assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE t timestamptz := '2026-09-13 06:00:00+00';
BEGIN
  -- (1) THE TOP SHOT EDITION WINDOW IS 1 h (audit_20260930), from both sides and ON the edge
  PERFORM _assert(public.ask_is_alertable('nba_top_shot', t - interval '59 minutes', t),
    'a Top Shot edition ask confirmed 59 min ago is alertable');
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot', t - interval '61 minutes', t),
    'a Top Shot edition ask confirmed 61 min ago is NOT alertable');
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot', t - interval '1 hour', t),
    'exactly 1 h is NOT alertable -- same edge convention as isAskStale (>=)');
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot', t - interval '11 hours', t),
    'an 11 h Top Shot edition ask -- legal under the old 12 h gate -- is NOT alertable');
  PERFORM _assert(public.ask_is_alertable('nba_top_shot', t, t),
    'and one confirmed this instant is');
  PERFORM _assert(NOT public.ask_is_alertable('nba-top-shot', t - interval '2 hours', t),
    'the HYPHEN spelling gets the 1 h window too -- a convention slip is STRICTER, never looser');

  -- (1b) EVERY OTHER GATED ARM KEEPS 12 h, incl. the Top Shot SERIAL board under its own token
  PERFORM _assert(public.ask_is_alertable('nba_top_shot:serial', t - interval '11 hours', t),
    'a serial listing seen 11 h ago is alertable -- its sweep runs every 3 h, it keeps 12 h');
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot:serial', t - interval '13 hours', t),
    'a serial listing seen 13 h ago is NOT alertable');
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot:serial', t - interval '12 hours', t),
    'exactly 12 h is NOT alertable -- the boundary matches isAskStale (>= ASK_STALE_HOURS)');
  PERFORM _assert(public.ask_is_alertable('disney_pinnacle', t - interval '11 hours', t),
    'Pinnacle: 11 h alertable');
  PERFORM _assert(NOT public.ask_is_alertable('disney_pinnacle', t - interval '13 hours', t),
    'Pinnacle: 13 h NOT alertable');

  -- (1c) THE CANDIDATE-SCAN FLAG: widens the age test ONLY when exactly 'on', and only
  -- transaction-locally (alert_candidate_verify_dispatch sets it; nothing that sends does).
  PERFORM set_config('rpc.alert_candidate_scan', 'on', true);
  PERFORM _assert(public.ask_is_alertable('nba_top_shot', t - interval '40 hours', t),
    'under the candidate scan a 40 h ask is a CANDIDATE -- that is what gets re-checked');
  PERFORM set_config('rpc.alert_candidate_scan', 'true', true);
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot', t - interval '40 hours', t),
    'any value but exactly ''on'' is ignored');
  PERFORM set_config('rpc.alert_candidate_scan', 'off', true);
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot', t - interval '40 hours', t),
    'and switched off, the gate is the gate again');

  -- (2) unknown fails CLOSED
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot', NULL, t),
    'a NULL stamp is NOT alertable -- unknown must not be treated as fresh HERE');
  PERFORM _assert(NOT public.ask_is_alertable('disney_pinnacle', NULL, t),
    'on every gated arm, not just Top Shot');

  -- (3) the exempt arms, at an age that would fail any recency test
  PERFORM _assert(public.ask_is_alertable('nfl_all_day', t - interval '42 days', t),
    'an All Day listing listed six weeks ago is still alertable -- listed_at is not a confirmation');
  PERFORM _assert(public.ask_is_alertable('laliga_golazos', t - interval '42 days', t),
    'same for Golazos -- both read the same open-listing index');
  -- ⚠ and their exemption is about the ARM, not about having a stamp: a NULL on
  -- an exempt arm is alertable too, because the predicate never applied there.
  PERFORM _assert(public.ask_is_alertable('nfl_all_day', NULL, t),
    'the exemption is unconditional -- an exempt arm is not secretly gated on NULL');

  -- (4) everything else fails CLOSED
  PERFORM _assert(NOT public.ask_is_alertable('nba-top-shot', t - interval '13 hours', t),
    'the HYPHEN spelling is gated -- a convention slip must not disable the gate');
  PERFORM _assert(NOT public.ask_is_alertable('nba_top_shot:serial', NULL, t),
    'the serial token is gated too -- NULL is not alertable there either');
  PERFORM _assert(NOT public.ask_is_alertable('some_new_collection', t - interval '13 hours', t),
    'and so is a collection nobody has added to this function yet');
  -- The positive half of the same property: fail-closed must not mean
  -- fail-always, or a new collection could never alert at all.
  PERFORM _assert(public.ask_is_alertable('some_new_collection', t - interval '1 hour', t),
    'a collection this function has never heard of still alerts on a FRESH ask');

  RAISE NOTICE '✓ ask_is_alertable: 1 h Top Shot editions, 12 h elsewhere, scan flag, fail-closed, two exempt arms';
END $$;

ROLLBACK;
