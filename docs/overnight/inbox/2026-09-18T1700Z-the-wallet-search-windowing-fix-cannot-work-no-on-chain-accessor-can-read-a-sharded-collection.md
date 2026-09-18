# ⛔ The `/api/wallet-search` windowing fix CANNOT WORK — and no on-chain accessor can read a sharded Top Shot collection at all

*Filed 2026-09-18 ~10:0x AM PT by Claude Code (desktop). **READ-ONLY — nothing changed.** Supersedes §5 of [`2026-09-14T1749Z-wallet-search-cannot-read-a-mega-wallet-and-tells-the-user-to-try-again.md`](2026-09-14T1749Z-wallet-search-cannot-read-a-mega-wallet-and-tells-the-user-to-try-again.md). Measured against **deployed mainnet** via the Cadence MCP, not inferred.*

---

## 1 · What this withdraws

That filing's §5 is headed **"The fix already exists in this codebase"** and its pickup item 2 says:

> **Point `getOwnedMomentIds` / `getAllDayOwnedIds` at the windowed scripts**, paging until short — the All Day one exists

⛔ **That cannot work, and the reason is visible in the repo without touching the chain.** `wallet-search`'s two helpers do **exactly one thing** — `return col!.getIDs()`. There is no per-NFT loop to bound. And `lib/chains/flow/allday-cadence.ts`'s `GET_UNLOCKED_MOMENT_DETAILS_RANGE`, the "windowed variant" it points at, **still calls `ref!.getIDs()` in full** and only then slices:

```cadence
let ids = ref!.getIDs()        // <- the whole array, every time
let window = ids.slice(from: start, upTo: endVal)
for id in window { ... borrowNFT ... }
```

⭐ **Its windowing bounds the `borrowNFT` loop, not `getIDs()`** — which is correct for the job it was written for (detail fetches, where per-NFT `borrowNFT` dominates) and useless here, where `getIDs()` **is** the whole cost. **A fix copied from it would have shipped, changed nothing, and looked like it should have worked.**

## 2 · 📏 Measured against deployed mainnet — three accessors, all of them

Deployed `TopShotShardedCollection` (`0xef4d8b44dd7f7ef6`, read via Cadence MCP) exposes only three ways to see ids, and **`collections` is `access(contract)`, so a script cannot reach an individual shard at all:**

| accessor | result on `0xe1f2a091f7bb5245` |
|---|---|
| `getIDs()` | ⛔ **1110 computation limit exceeded** (`TopShotShardedCollection:137` → `TopShot:1309`) |
| `getLength()` | ⛔ same — its body is literally `return self.getIDs().length` |
| `forEachID(f)` full walk | ⛔ **1110 computation limit exceeded** (`TopShotShardedCollection:58`) |

🚨 **`getIDs()` is expensive by construction, and it is not the array SIZE:** the sharded wrapper rebuilds the whole array once per shard — `ids = ids.concat(collectionIDs)` in a loop.

⛔ **And `forEachID` is not a pagination primitive either.** Its early-exit only stops the **current shard**; the wrapper's outer loop then re-enters the next one. A callback asking for the **first 5 ids returned 754.** So "walk a window with forEachID" does not bound anything.

✅ **POSITIVE CONTROL (the method is sound, and the failure is SHARDING, not size):** the same script against the largest **non-sharded** wallet `0xf77bf547fccf6656` returns **38,642** ids fine. ⚠ The 09-14 filing recorded **39,955** for that wallet — re-derived today it is **38,642**, so treat both as dated samples.

## 3 · 🚨 The "0.13 % over" number is NOT a measurement, and it changes the conclusion

The 09-14 filing reasons from the error's `used:` figure:

> **The Top Shot case is 100,134 against a limit of 100,000 — 0.13 % over.** This is a *threshold*, not a cliff

⛔ **`used:` in a 1110 error is the ABORT POINT, not the requirement.** Run today on the same wallet, the same instrument reports **`used: 100,001` for `getIDs()`** and **`used: 100,002` for the `forEachID` walk** — two different accessors, two nearly identical numbers, both simply the ceiling. **They say where execution stopped, never how much the wallet needs.**

⭐ **So "just barely over, a small optimisation will clear it" is unsupported.** The true cost is unknown and may be far above the budget. **Do not size this work from that number** — it is the same class as reading a duration instead of an error string, one level in.

## 4 · What is actually left

- ✅ **The shipped copy is already the honest terminal state** for this wallet class — *"We could not read this wallet in one pass … retrying will not help."* **Nothing about the message needs changing**, and the transport layer was correct all along (HTTP 500 + explicit `error`, never a fabricated empty wallet).
- ⛔ **There is no on-chain fix.** Any real repair has to get ids from somewhere other than a single script: an off-chain source (Atlas / `wallet_moments_cache` / an indexer), or a chain read that never needs the full set.
- ⚠ **Population still NOT established, and it is NOT `cached_moment_count`** — the 09-14 correction already withdrew that yardstick. The affected set is *"wallets whose Top Shot collection is SHARDED"*, which is not a column in this database. **Size it before building anything**, and note that a sharded wallet has **zero** rows in `wallet_moments_cache` precisely *because* the backfill cannot complete — so it is invisible to exactly the table you would count it with.

⚠ Every figure here is a dated sample (2026-09-18, mainnet). **Re-derive before quoting.**
