# ⚠ `/api/wallet-search` cannot read a mega-wallet at all, and tells the user to **"Please try again"** — a retry that can never succeed

> 🚨 **CORRECTION, SAME DAY (~13:05 PT) — THE HEADLINE CAUSE BELOW IS REFUTED, BY MEASUREMENT, AND THE WORD "mega-wallet" IN THE FILENAME IS PART OF THE ERROR.** I inferred from the words *"computation limit exceeded"* that the trigger was wallet SIZE. It is not. Run against mainnet via `pg_net` (the plane production calls on), the **largest saved Top Shot wallet — `0xf77bf547fccf6656`, 39,955 moments — SUCCEEDS**: HTTP 200, a 1.9 MB body of ids. The failing wallet `0xe1f2a091f7bb5245` returns HTTP 400 at **100,134** units.
>
> ⭐ **THE DISCRIMINATOR WAS IN THE ERROR STRING THE WHOLE TIME AND I READ PAST IT: the failing trace goes through `ef4d8b44dd7f7ef6.TopShotShardedCollection:137:36`.** A **sharded** collection's `getIDs()` walks its shards, and that is what exceeds the budget — the succeeding wallet is nearly 40k moments on a plain `MomentCollection`. **CLAUDE.md's rule is "read the ERROR STRING, not the duration"; the failure mode here is reading *part* of the error string and inferring the rest.**
>
> ⛔ **WHAT THIS INVALIDATES BELOW:** §1's framing ("on a large enough collection"), the §2 phrase "a property of the wallet's size", §3's "mega-wallet" framing, and the §4 population work — **`cached_moment_count` is the WRONG YARDSTICK**, so the "8 saved wallets ≥5,000" number sizes a set that is not the affected set. ⚠ **The real population is "wallets whose Top Shot collection is SHARDED", which is not a column in this database and was not measured.**
>
> ✅ **WHAT SURVIVES, and it is the part that mattered:** the failure is deterministic, the old copy's "Please try again" was a false promise, and the shipped fix stands — **with its own cause removed.** The message first read *"holds too many moments"*, which is this same inference shipped as user-facing copy; it now says only *"We could not read this wallet in one pass … retrying will not help."* A test forbids re-asserting the refuted cause.

*Filed 2026-09-14 ~10:49 AM PT by Claude Code (desktop). **READ-ONLY — nothing changed.** Found in a production runtime-error sweep, not by an alarm.*

---

## 1 · What is happening

`/api/wallet-search` fetches a wallet's holdings with an **unpaginated** Cadence `col!.getIDs()`, for both
Top Shot and All Day (`app/api/wallet-search/route.ts`, `getOwnedMomentIds` / `getAllDayOwnedIds`). On a
large enough collection the execution node refuses it:

```
[Error Code: 1110] computation limit exceeded (used: 100134, limit: 100000)   --> TopShot:1309
[Error Code: 1110] computation limit exceeded (used: 217993, limit: 100000)   --> AllDay:1243
```

**24 h production counts:** `/api/wallet-search` **2** (2 users) · `/api/wallet-backfill` **6** (6 users)
· `/api/wallet-backfill-allday` **2**.

⭐ **The Top Shot case is 100,134 against a limit of 100,000 — 0.13 % over.** This is a *threshold*, not a
cliff: wallets sit just the wrong side of it, so the affected set grows silently as collections grow.

## 2 · ⭐ The honesty problem is the COPY, not the plumbing

**Credit where due — the transport layer is honest.** The catch returns **HTTP 500 with an explicit
`error`**, so a client discriminating on `ok` cannot mistake it for an empty wallet. This is *not* the
"failed read rendered as an answer" defect; the route was written correctly.

⛔ **But the message is `"Failed to fetch wallet data. Please try again."`, and for this failure a retry is
DETERMINISTIC — it can never succeed.** The computation limit is a property of the wallet's size and the
script, not of the moment in time. Telling a user to retry something structurally impossible is the same
family as an empty state that concludes: **the claim implied by the copy ("transient") is false.**

⚠ The cache makes it worse in a small way: `getOrSetCache` only caches on success, so every retry is a
fresh, failing chain call.

## 3 · 📏 The evidence that it is total, not partial

`0xe1f2a091f7bb5245` — the wallet the Top Shot error names — has **ZERO rows in `wallet_moments_cache`,
across every collection.** The failure is *why* it has no data: the backfill cannot complete, so nothing
is ever cached, so the wallet is invisible to the platform. It has been retried and failing for at least
24 h.

By contrast `0xb6f2481eba4df97b` holds **11,969 Pinnacle** rows (last seen 2026-09-12) — because the
**Pinnacle** path already paginates — while its **All Day** fetch is the one that 400s. ⭐ **That is the
control: the same wallet succeeds on the collection that windows its reads and fails on the one that does
not.** The defect is the unpaginated call, not the wallet and not the chain.

## 4 · ⚠ Who generated it — and why this is NOT a P1

**Neither wallet is saved by any user** (`saved_wallets` → 0 for both). These are anonymous lookups of
whale addresses, most likely someone scouting rather than a user whose own wallet is broken. This repo has
been burned the other way (#69: seventeen "user-facing" client errors were one headless crawler), so the
provenance is stated before the severity.

⛔ **POPULATION NOT ESTABLISHED, and I stopped rather than force it.** The obvious query — wallets by
moment count over `wallet_moments_cache` — **timed out twice** (the table is ~1.58 M rows and CLAUDE.md
already records that heavy wmc aggregates need a bounded or precomputed source). ⚠ **My own probe is load
on a saturation-bound instance**, which this estate has paid for before, so the count is left open rather
than bought at that price. **Anyone sizing this should use a bounded/precomputed source, not a fleet
aggregate.**

⚠ **One vacuous result caught on the way, recorded so it is not repeated:** a first attempt at the
saved-wallet population returned `[]` because I left a `join … on false` placeholder in it. **An empty
result from a malformed query reads exactly like "no wallets affected".** It was not reported as one.

## 5 · The fix already exists in this codebase

⭐ **`lib/chains/flow/allday-cadence.ts` already carries the windowed variant** — its own comment says
`getIDs()[start..start+count] instead of the full array so mega-wallets …` — and
`lib/chains/flow/cadence/pinnacle-wallet.ts` does the same. **`wallet-search` simply does not use it.**
Known chunk sizes are recorded in memory as All Day **1000**, Pinnacle **500**.

👉 **Pickup, cheapest first:**

1. **Make the copy honest even before the plumbing changes** — detect `computation limit exceeded` /
   Flow error `1110` in the catch and say *"This wallet is too large for us to scan in one pass"*, not
   *"Please try again."* Small, safe, and removes a false claim today.
2. **Point `getOwnedMomentIds` / `getAllDayOwnedIds` at the windowed scripts**, paging until short — the
   All Day one exists; Top Shot needs the same shape against `TopShot.MomentCollectionPublic`.
3. ⚠ **Before either, size it from a bounded source** — an eligibility count is not a gain count, and this
   may be a handful of whale addresses nobody has saved.

⚠ Every figure here is a dated sample (2026-09-14, 24 h window). **Re-derive before quoting.**
