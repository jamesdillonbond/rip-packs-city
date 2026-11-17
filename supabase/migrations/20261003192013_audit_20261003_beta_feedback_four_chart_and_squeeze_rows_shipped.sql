-- 2026-10-03 (Trevor: "Do everything mentioned" / "You should be able to
-- handle these"): the four beta_feedback_inbox rows the afternoon block shipped
-- against are flipped, with an admin_note naming the ship and — for the chart
-- overlay asks — naming plainly which parts were NOT built and why (there is
-- no ask/offer price history in the estate to plot; candlesticks need
-- open/close the estate does not keep, so RANGE is a low–high band). 10261 is
-- the same ask as 10259 from the same session, one minute later: duplicate.
-- A plain UPDATE through execute_sql is refused by the cloud session's
-- permission layer; recorded as a migration, same as 20261003184026.
-- No schema change. Revert: set feedback_status='new', shipped_at=NULL,
-- duplicate_of=NULL on the four ids and strip the note text added here.

UPDATE public.beta_feedback_inbox
SET feedback_status = CASE id WHEN 10261 THEN 'duplicate' ELSE 'shipped' END,
    shipped_at = CASE id WHEN 10261 THEN shipped_at ELSE now() END,
    duplicate_of = CASE id WHEN 10261 THEN 10259 ELSE duplicate_of END,
    updated_at = now(),
    admin_note = COALESCE(admin_note || ' · ', '') || CASE id
      WHEN 10256 THEN '2026-10-03: "Top 5 hold" column on the squeeze board — the five largest collector wallets'' combined share of circulation from the on-chain owner census (Top Shot''s pack-distribution and buyback accounts excluded); shown only where the census covers >= 98% of the edition, "—" otherwise; sortable. Migration 20261003184843.'
      WHEN 10259 THEN '2026-10-03: shipped ASP, RANGE (low–high sale prints per day), VOLUME bars, MA 7 (trailing, states the window used) as toggles on the edition FMV chart. NOT built: low-ask / high-offer history (no table keeps a listing-price series — fmv_snapshots.top_shot_ask is populated on ~3% of rows) and candlesticks (no open/close kept; RANGE is the honest band). Stated in the chart''s Methodology caption.'
      WHEN 10261 THEN '2026-10-03: duplicate of #10259 (same ask, same session, one minute later) — see that row.'
      WHEN 10263 THEN '2026-10-03: MY BUYS toggle on the edition FMV chart plots the tracked wallet''s own purchases of the edition (price + date, serial in the tooltip); shows only when the site already tracks a wallet; an empty answer is stated, not blank. Migration 20261003185621.'
    END
WHERE id IN (10256, 10259, 10261, 10263)
  AND feedback_status = 'new';

DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.beta_feedback_inbox WHERE id IN (10256, 10259, 10263) AND feedback_status = 'shipped') <> 3 THEN
    RAISE EXCEPTION 'expected three shipped rows';
  END IF;
  IF (SELECT duplicate_of FROM public.beta_feedback_inbox WHERE id = 10261) IS DISTINCT FROM 10259 THEN
    RAISE EXCEPTION 'expected 10261 to point at 10259';
  END IF;
END
$verify$;
