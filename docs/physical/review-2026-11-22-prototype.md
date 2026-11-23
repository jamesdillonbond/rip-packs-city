# Physical-cards prototype: fresh-eyes review (2026-11-22, ~10:50 PM PT)

Claude Code cloud, evening autonomous pass. This reviews commit `4d3593864`, which is off by default (`PHYSICAL_CARDS` + `HCI_API_KEY`). Everything below is **latent**: nothing is mounted or enabled.

**Fixed here:** finding 9 (later, with route coverage that put CI's statement ratchet back over its floor) and finding 2 (`physicalTotal` totals are `null`, not `$0`, when nothing is priced). The old assertion that pinned the `0` was inverted, a case was added, and both fail on the old body.

**Left for the physical-cards thread.** These are design calls or code that thread is actively changing.

**2026-11-23 ~7:30 AM PT (Cowork cloud, physical-cards thread): findings 1, 3, 4, 5, 6, 7 and 8 are fixed.** Each fix has a test that fails on the old body; the draft SQL was re-applied to a scratch Postgres 16 with Supabase-style default privileges (signed-in role: SELECT only; anon: nothing; truncate and insert refused; RLS shows a user only their rows; the 1,001st row refused; raw-with-grade, grade 11 and negative cost refused).

**What holds up:**
- **Flag check:** every route checks it before any work.
- **Holdings:** they require a session, and `user_id` comes from the session on GET, POST and DELETE.
- **Cert caps:** they live in a shared DB counter, are bumped before the HCI call, and fail closed.
- **Keys:** they are sent only in headers and never echoed.
- **Input:** cert numbers must be digits (≤ 12) and are encoded; `cardId` must be a UUID.
- **Draft SQL:** RLS is on, the holdings policies use `(select auth.uid())`, and UPDATE has both USING and WITH CHECK.

## Findings, most important first

1. ✅ **Fixed 11-23.** Results carry `fetchedAt`; `getPaperListings` refuses anything older than 6 h (or unstamped) at read, the cache refreshes at 5 h, and the inner fetch is `no-store`. **eBay listings can be served older than 6 h.** `lib/physical/ebay-listings-cached.ts:10-23` with `ebay-listings-server.ts:99-102`. *Medium.*
   - Two caches are stacked: `unstable_cache` (6 h) wraps a fetch that has its own 6 h `revalidate`.
   - Both are stale-while-revalidate, so a refresh that throws (eBay down, or the cap refused) keeps serving the stale entry.
   - So the "never older than 6 h / render nothing over the cap" promise behind §8.1(c) does not hold.
2. ✅ **Fixed here.** An all-unpriced portfolio totalled `$0` (`lib/physical/portfolio.ts`).
3. ✅ **Fixed 11-23 (documented).** Cost basis is the total paid for the row (the whole lot), stated in `holding-input.ts`, `portfolio.ts` and the SQL column, which also gained `CHECK (cost_basis_usd >= 0)`. **Cost basis ignores quantity.** `portfolio.ts:68`. *Medium.*
   - Values are multiplied by `quantity`; `cost += costBasisUsd` is not.
   - The test fixture reads it as a per-lot total. Document that meaning in `holding-input.ts` and the SQL, or multiply.
4. ✅ **Fixed 11-23.** POST counts first and refuses at 1,000 (409; an unreadable count refuses too), a `BEFORE INSERT` trigger in the draft SQL backstops the race, and GET returns `complete` + `total` with a unique `id` tiebreak. **GET holdings cuts off silently at 1,000 rows.** `app/api/physical/holdings/route.ts:47,51`. *Low–medium.*
   - POST has no per-user cap, and GET returns a truncated list without `complete:false`.
   - Cap POST, or page with a unique `.order()` and report completeness.
5. ✅ **Fixed 11-23.** A typed date is stored or refused (format, real calendar day, not in the future); an FK miss answers 400. **Dates and card ids are handled badly on POST.** `holding-input.ts:38`, `route.ts:86`. *Low.*
   - A date in the wrong format becomes `null` and the POST still returns 201, so the user's date is lost.
   - `2026-02-31` and an unknown `cardId` hit DB errors and surface as 500s instead of 400s.
6. ✅ **Fixed 11-23.** DELETE selects the deleted id and answers 404 when none. **DELETE answers `{ok:true}` when 0 rows were deleted.** `holdings/route.ts:103-105`. *Low.* Add `.select("id")` and return 404 on an empty result.
7. ✅ **Fixed 11-23.** An HCI 429 now answers 429 with `Retry-After: 60`. The per-user-first cap order is kept on purpose (a user over their own cap never spends the paid site-wide budget) and is commented at the call. **Cert caps over-count.** `cert/route.ts:41-44`. *Low, safe direction.*
   - The user bucket is bumped before the global one, so a global refusal still spends a user lookup.
   - An HCI 429 becomes a 502 that also spends one.
8. ✅ **Fixed 11-23.** One `REVOKE … FROM PUBLIC, anon, authenticated`; signed-in clients get SELECT only (writes go through the route); `grade` CHECK and raw ⇔ grade 'raw' CHECK added. **Draft grants are wider than the comment says.** `docs/physical/physical-holdings-draft.sql:75-79`. *Low.*
   - It revokes only from `PUBLIC, anon`, but this DB's default privileges give `authenticated` full rights on new tables. TRUNCATE ignores RLS. Revoke from `authenticated` too (CLAUDE.md: `REVOKE … FROM PUBLIC, anon, authenticated` in one statement).
   - The INSERT grant on `physical_holdings` lets a client skip the route's validation. `grade` has no DB CHECK, and there is no row cap.
9. ✅ **Fixed ~11 PM PT.** A non-JSON 200 from HCI threw (`hci-client.ts`): `await res.json()` sat outside the try/catch, so the route answered an unhandled 500 instead of its 502. It now returns `{ok:false, code:"BAD_JSON"}`; `__tests__/physical-hci-client.test.ts` fails on the old body.
