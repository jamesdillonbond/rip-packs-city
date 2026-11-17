> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 90% of every uncached moment-image load 502s, and the route's own instrumentation now names the cause: our 8-second abort, not a dead object

**Filed 2026-08-31 07:1xZ (2026-08-31 00:1x PT), cloud pass.** DB `now()` read from the database, not the container clock.
**Repo read at `origin/main` `a1e0fd0a`, cloned 06:58Z.** ⚠ A concurrent Claude Code session is committing several times an hour; re-fetch before acting.

> ⚠ **This pass could not push.** `git push --dry-run` → *"jamesdillonbond/rip-packs-city is not in this session's authorized repository set"* (403). That blocker is **specific to this cloud session** — Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit these files as usual.**

---

## The number

`/api/public/ipfs-media/[cid]` — the same-origin IPFS proxy that serves UFC Strike and legacy `ipfs.io` edition art — over
**cache-MISS invocations only** (Vercel runtime logs, `prj_YBJ6…`, grouped by `statusCode`, full-text `ipfs-media`):

| window | 502 | 200 | 302 (oversize redirect) | fail share |
|---|---|---|---|---|
| **24 h to 07:05Z** | **105** | 10 | 2 | **89.7 %** |
| **8 h to 07:05Z** | **45** | 9 | 1 | **81.8 %** |

The route's own header records the baseline it was instrumented against on 2026-08-24: **99 × 502 / 26 × 200 / 5 × 302 over 72 h ≈ 76 %.**
It has not improved; it has got worse.

⚠ **Carry the denominator, and carry which one.** These are *cache-MISS* invocations. A cached image never invokes the
function, so this is not "90 % of moment art is broken on the site" — it is **90 % of the loads that actually reach
upstream**, i.e. every first view of an image the edge has not already stored. Platform-wide the 502s are 105 of 81,995
logged responses in 24 h (0.13 %). Both numbers are true and they answer different questions.

## The cause, from the instrumentation that was added to answer exactly this

The 08-24 observability change split two outcomes the route used to spell identically. Every 502 in the 8 h window is the
**first** branch:

```
[ipfs-media] upstream fetch failed cid=bafybeib7wljzw… reason=abort_timeout name=TimeoutError elapsedMs=8002
[ipfs-media] upstream fetch failed cid=bafybeidkrpwyd… reason=abort_timeout name=TimeoutError elapsedMs=7837
```

**`reason=abort_timeout` on every one. Not a single `[ipfs-media] upstream not ok` line.** So this is *our* 8 s
`AbortSignal.timeout` firing — never `ipfs.io` answering and saying no. The elapsed times cluster at **7,837–8,006 ms**,
i.e. hard against `UPSTREAM_TIMEOUT_MS = 8_000`.

## ⭐ Four positive controls in the same 17 seconds — the objects are fine

One page load fires ~8 CIDs; the browser's `<img onError>` chain re-requests them. Both waves are in the log:

| cid (truncated) | 06:04:36 | 06:04:53 |
|---|---|---|
| `bafybeiawoywjm2t73…` | **502** @ 7,837 ms | **200**, image/png, 2,253,121 B @ **5,449 ms** |
| `bafybeiefnx67yi5…` | **502** @ 7,838 ms | **200**, image/png, 2,719,126 B @ **2,712 ms** |
| `bafybeibzpp6kave…` | **502** @ 7,998 ms | **200**, image/png, 2,462,918 B @ **4,185 ms** |
| `bafybeihqleph53d…` | **502** @ 7,841 ms | **200**, image/png, 2,293,146 B @ **65 ms** |

**The CIDs are not dead.** They are ~2.3–2.7 MB PNGs that came back whole seconds later — one of them in 65 ms. The
aborted first request is what pulled the object into `ipfs.io`'s own cache; we throw that request away and hand the user a
broken image, then a retry we did not plan for collects the benefit. **Successful fetches in the window run 65 ms →
5,598 ms; the abort sits at 8,000 ms.** The budget is not miles above the success distribution — it is on its shoulder.

## What this costs a collector

A wave of blank tiles on first view of a set / team / wallet page, filling in only if something re-requests. On a platform
whose product *is* the art, that is the most visible defect currently measurable.

## Two fixes, and the honest trade between them — ⛔ NOT shipped (route code; a cloud pass cannot push)

1. **Raise `UPSTREAM_TIMEOUT_MS` 8 s → ~15 s.** One fetch, no new request shape. ⚠ **The header's invariant is
   load-bearing and survives**: the abort must fire *before* the platform's own 25 s initial-response cutoff, or the 502
   soft-fail becomes dead code again (that already happened once — 205 such 504s in a 40-minute window, 2026-07-27).
   15 s keeps 10 s of margin. Cost: a slow miss holds the function ~7 s longer.
2. **Retry once after `abort_timeout`.** Exploits the priming effect the table above measures directly, and bounds the
   worst case at 2 × 8 s = 16 s. Costs a second upstream request on every genuine failure.

⚠ **Neither is a cure, and the bound must be stated.** The route's own 08-24 note records residential measurements where
`ipfs.io` returned **504 from the gateway itself after ~28 s**, and a 36 MB object still streaming at 40 s. For that
class, 15 s will still 502 — correctly. This change converts the **4–8 s shoulder**, not the 28 s tail.

**Exit (24 h after either ships):** the `ipfs-media` cache-MISS split moves from ~90 % 502 toward ≤ 40 %, with the
residual 502s still reading `reason=abort_timeout` at the *new* cap.
**Falsifier:** the 502 share stays ≳ 75 % → the aborted fetches are in the ~28 s gateway-504 class, not the shoulder, and
the lever is not the budget at all — it is pinning RPC's own copies of this art (or a durable object store), which is a
build, not a constant.
**Revert:** restore the constant.

ⓘ **Not a lever, recorded so nobody re-derives it:** the 302 oversize-redirect path is working (2 in 24 h) and the CID
allowlist regex is untouched by any of this — it is the SSRF guard and must stay exactly as it is.
