-- audit_20260913_the_ask_stamp_means_three_different_things
--
-- 🚨 A CORRECTION TO THE MIGRATION SHIPPED FOUR HOURS EARLIER, AND TO A PREMISE
-- THE WHOLE ESTATE HAS BEEN BUILDING ON SINCE 2026-09-04. No function body
-- changes here — this migration writes COMMENTS, because what was wrong was the
-- STATED REASON, and in this repo a wrong-but-plausible stated reason is the
-- expensive kind.
--
-- ⛔ WHAT I CLAIMED, IN audit_20260912_an_alert_is_never_built_from_an_unconfirmed_ask:
-- that `edition_offers.updated_at` means "the ask was LAST CONFIRMED at this
-- time", and that gating alerts on it therefore means "never alert on an ask
-- nobody has re-confirmed". ⛔ **That is FALSE for Top Shot, the biggest arm.**
--
-- ⭐ WHAT THE WRITERS ACTUALLY DO — read from `pg_get_functiondef`, not inferred:
--   · `sync_edition_offers_from_atlas()` (pg_cron 466, every 2 min) upserts under
--     `ON CONFLICT … DO UPDATE … WHERE public.edition_offers.low_ask IS DISTINCT
--     FROM EXCLUDED.low_ask OR … low_ask_nft_id IS DISTINCT FROM …`. The stamp is
--     bumped ONLY WHEN THE FLOOR CHANGES. Re-observing the same price a thousand
--     times writes nothing.
--   · `raise_edition_offers_from_chain()` (pg_cron 216, hourly) bumps the same
--     column when the OFFER side rises — which is not the ask at all.
--   So the column is **LAST CHANGED**, wearing a **LAST CONFIRMED** name.
--
-- 🚨 AND THE MEANING CHANGED WITHOUT ANYONE EDITING ANYTHING. Until 2026-08-28
-- `offers-sweep` wrapped the catalogue 8–18x a day and stamped every row it
-- touched, so "last confirmed" was TRUE and the 12 h marker in
-- `lib/market/ask-freshness.ts` was calibrated against it. That lane has written
-- nothing since (register #81) and the Atlas writer that replaced it does not
-- stamp on re-observation. ⭐ **PROMOTE: a column's contract lives in its WRITER,
-- so replacing the writer can silently redefine the column — and nothing reds,
-- because the NAME did not change.** This is the sharpest instance yet of
-- CLAUDE.md's "a `*_at` name is not its contract — `col_description()` before
-- trusting a stamp as freshness"; `edition_offers.updated_at` had NO comment at
-- all, which is why three separate pieces of work read the name and believed it.
--
-- ⭐ THE OTHER ARMS ARE GENUINELY DIFFERENT, AND THAT IS WHY ONE SENTENCE COULD
-- NEVER HAVE BEEN TRUE OF ALL OF THEM:
--   · `pinnacle_catalog.floor_ask_updated_at` — `pinnacle_catalog_set_floor_asks()`
--     writes `floor_ask_updated_at = p_checked_at` on EVERY row every sweep; its
--     own inline comment says `= freshness`. A REAL confirmation stamp.
--   · All Day / Golazos — `cached_listings_v2.listed_at`, when the SELLER posted
--     it, over an event-sourced index a row LEAVES when the listing closes.
--
-- ✅ WHY THE GATE ITSELF STANDS, RATHER THAN BEING REVERTED. Its Top Shot rule is
-- really "the floor CHANGED within 12 h", and for a deal alert that is defensible
-- on its own terms — arguably better than freshness, since an unchanged week-old
-- price is not news, and a NEW cheap listing necessarily bumps the stamp at the
-- moment we learn of it, so discoveries still fire. The 2026-09-12 defect it was
-- built for (one frozen row re-sent on four consecutive nights) is removed either
-- way. Pinnacle keeps exactly the semantics claimed; All Day / Golazos stay exempt.
--
-- ⚠ WHAT I COULD NOT ESTABLISH, STATED RATHER THAN GLOSSED. Whether the rows the
-- gate blocks are LIVE is still unmeasured. The obvious control — "does an open
-- listing for this edition appear in `topshot_atlas_market_events`" — reads 57 of
-- 3,092 blocked and 211 of 769 passed, but that instrument covers only **2,794
-- distinct editions in 24 h against 12,940 rows with an ask (~22%)**, so it is
-- measuring FIREHOSE COVERAGE, not liveness, and neither number supports a
-- conclusion. A control whose population is a proxy that does not cover the set is
-- not a control. The honest answer needs a per-edition verify, which is the ~2
-- editions / 2 min lane, i.e. days.
--
-- ROLLBACK: comments only — `COMMENT ON … IS NULL` restores the previous state
-- (the function comment's prior text is in this file's sibling migration).

COMMENT ON COLUMN public.edition_offers.updated_at IS
  'LAST CHANGED, NOT LAST CONFIRMED — and not necessarily about the ASK. Bumped by '
  'sync_edition_offers_from_atlas() only when low_ask/low_ask_nft_id actually change '
  '(its ON CONFLICT carries an IS DISTINCT FROM guard), by the same function when it '
  'NULLs an ask verified gone, and by raise_edition_offers_from_chain() when the '
  'HIGHEST_OFFER rises. So a fresh stamp can describe an offer move on an ask nobody '
  'has looked at, and an old stamp can describe a price that has simply been stable. '
  'It was a true confirmation stamp until 2026-08-28, when offers-sweep (which '
  'stamped every row it wrapped, 8-18x/day) died and the Atlas writer replaced it '
  '(#81) — the meaning changed, the name did not. Surfaces must say "last changed" '
  'for Top Shot: lib/market/ask-freshness.ts askStampKind() (audit_20260913).';

COMMENT ON COLUMN public.pinnacle_catalog.floor_ask_updated_at IS
  'LAST CHECKED — a real confirmation stamp, unlike its Top Shot counterpart. '
  'pinnacle_catalog_set_floor_asks() writes floor_ask_updated_at = p_checked_at on '
  'EVERY row on every sweep, whether or not floor_ask changed, so an old value here '
  'does mean nobody has looked. Contrast edition_offers.updated_at, which is bumped '
  'only on CHANGE (audit_20260913).';

COMMENT ON FUNCTION public.ask_is_alertable(text, timestamptz, timestamptz) IS
  'Gates what may be sent as a NOTIFICATION. ⚠ CORRECTED 2026-09-13: this function '
  'does NOT mean "confirmed recently" on every arm, because the stamp it reads does '
  'not mean the same thing on every arm. nba_top_shot: edition_offers.updated_at is '
  'LAST CHANGED (bumped only when the floor moves), so the rule there is really "the '
  'floor changed inside 12 h" — defensible for an alert (a new cheap listing bumps '
  'the stamp when we learn of it; an unchanged week-old price is not news) but NOT '
  'the freshness claim the original comment made. disney_pinnacle: '
  'floor_ask_updated_at IS a last-checked stamp, so there the freshness reading is '
  'exact. nfl_all_day / laliga_golazos are EXEMPT: their stamp is listed_at over an '
  'event-sourced OPEN-listing index, and gating them would drop 1,937 of 1,956 '
  'correct rows (measured 2026-09-13). 12 h mirrors ASK_STALE_HOURS in '
  'lib/market/ask-freshness.ts. The CASE lists the EXEMPT arms so an unknown or '
  'misspelled slug fails CLOSED; a NULL stamp is not alertable. Boards must keep '
  'RENDERING these asks with an age marker that says which of the three the stamp is '
  '(askStampKind) — this function is only about what may be SENT '
  '(audit_20260912, corrected by audit_20260913).';
