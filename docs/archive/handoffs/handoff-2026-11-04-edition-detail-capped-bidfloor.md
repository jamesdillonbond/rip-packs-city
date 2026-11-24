# Handoff → Cowork — edition page keeps "capped at sales" after the bid floor (2026-11-04, ~10:50 PM PT)

## Context

`get_edition_detail` sets `basis_capped` with the regex `algo_version ~ '_(salescap|histcap)$'`. Tonight's Top Shot offer floor (`20261105033000`) adds `_bidfloor` to the end of `algo_version`.

So a price that was capped at the edition's sales and then lifted by a live bid now ends in `…_salescap_bidfloor`. It no longer matches the regex, and the edition page reverts to "from asks — no corroborating sales". That is wrong: the edition's sales and a live bid set that price.

Read at ~10:35 PM PT: **71** latest Top Shot ASK_ONLY rows are affected.

The TypeScript twin, `isSalesCappedAlgo` in `lib/fmv-basis.ts`, is fixed in the same push and deploys with it. It covers wallet-search, the moment page and `lib/fmv-capped`. The SQL half needs DDL, and this Claude Code cloud session can't run production DDL.

## Item — apply `20261105063000_audit_20261104_edition_detail_capped_survives_bid_floor`

**What changes:** only that one regex. It becomes `'_(salescap|histcap)(_bidfloor)?$'`. The rest of the body is byte-identical to `20261029164512`.

**Guard:** it expects the live body md5 `377eb913…`, read 10:30 PM PT, which matches `20261029164512`. If the guard raises, re-read the live body and re-base.

**Post-checks:**
1. The md5 changed.
2. `has_function_privilege('anon', 'public.get_edition_detail(uuid,text)', 'EXECUTE')` is unchanged from before the apply.
3. Spot-check one edition whose latest snapshot is `…_salescap_bidfloor`. Its `get_edition_detail(…)->'fmv'->>'basis_capped'` should return `true`, and the edition page should render "capped at sales".
4. Add a ledger entry. To revert, re-apply the body from `20261029164512`.

## Verified

- The parse check finds 0 errors.
- The pin `supabase/tests/pinnacle_readers_use_the_pin_catalog.sql` was re-pinned:
  - `_histcap_salescap_bidfloor` → `true`;
  - `cold-tail-1.0_bidfloor` (uncapped) → `false`.
- The planted old regex turns the test red.
- The full DB suite passes 291/291.
- The `fmv-basis` unit test has the same four new cases, and the drift guard passes.

## Also still waiting, from earlier tonight

`20261105050000` (All Day LOW haircut 0.75): see `docs/handoff-2026-11-04-allday-low-haircut-075.md`. Both migrations can be applied in either order.
