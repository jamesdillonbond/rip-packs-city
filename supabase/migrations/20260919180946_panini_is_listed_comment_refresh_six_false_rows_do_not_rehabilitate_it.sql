-- COMMENT-ONLY. No behaviour, no columns, no grants. 2026-09-19 (Cowork cloud).
--
-- The existing comment (2026-08-04) says `is_listed` is "true on all 59,425 rows, zero false,
-- zero NULL". Re-measured today the population is 108,042 and **six rows are now false**. The
-- column is therefore no longer literally constant — and that is exactly the trap worth writing
-- down, because the obvious re-check ("is it still a constant?") now answers NO and would license
-- a reader to treat it as informative again.
--
-- It is not. Measured 2026-09-19: 108,036 / 108,042 true (99.994%), and **73,776 of those true
-- rows have no positive ask**. The six falses are 0.006% of the table, far below the 68% of rows
-- the column misdescribes. A predicate that is wrong about two thirds of its population has not
-- become usable by acquiring six exceptions.
--
-- ⭐ The durable shape: a "known constant" warning that cites CONSTANCY as its evidence expires
-- the moment one counter-example appears, even though the defect it warned about is unchanged.
-- State the DEFECT (it disagrees with the ask on most rows), not the symptom that made it obvious.
--
-- Also corrected in passing: the old comment's claim that `panini_special_serials_board` "no
-- longer passes it through" is right, and worth keeping explicit — that board computes
-- `COALESCE(s.price_usd, 0) > 0 AS is_listed`, i.e. it publishes the honest quantity under the
-- same name. A reader who greps for `is_listed` finds both and must not conflate them.
--
-- REVERT (exact): re-run `comment on column public.panini_card_serials.is_listed is '<the
-- 2026-08-04 text>'` — it is preserved verbatim in this migration's git history.
--
-- Not a function: no anon-exec marker applies.

comment on column public.panini_card_serials.is_listed is
  'DO NOT USE AS A PREDICATE OR PUBLISH -- it disagrees with the ask on most rows. Measured 2026-09-19: 108,036 of 108,042 rows true (99.994%), and 73,776 of those true rows have NO positive ask. ⚠ It is no longer literally constant (6 false rows, up from 0 on 2026-08-04), so a "is it still a constant?" re-check now answers NO -- that does NOT rehabilitate it: six exceptions at 0.006% do not fix a column that misdescribes 68% of the table. Use COALESCE(price_usd,0) > 0 instead. panini_special_serials_board publishes exactly that expression UNDER THE NAME is_listed (honest, derived -- do not conflate it with this column); panini_deal_board references this column harmlessly, as a no-op term beside its own price_usd > 0.';