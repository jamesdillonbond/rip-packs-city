# The All Day sniper 403 hypothesis is REFUTED from code, and the post-fix number in the 09-04 ledger was measured at a parameter the route does not default to

**Filed 2026-09-04 18:30 PT (2026-09-05 01:30Z) · Claude Code (cloud sandbox) · MEASUREMENT + a CODE READ. Nothing shipped: the one thing this suggests changing is a product default, not a defect.**

Two open items closed, one of them my own predecessor's and one of them a correction to a number recorded yesterday.

## 1 · ✅ §5 of [inbox 2026-09-03T0850Z](2026-09-03T0850Z-sniper-feed-is-a-latency-problem-and-not-a-cost-one-and-none-of-its-reads-is-bounded.md) is REFUTED — and it needed no telemetry at all

That filing recorded a **300×** call-count gap (`get_topshot_sniper_deals` 6,746 vs `get_allday_sniper_deals` 22, now **7,168 vs 29**) and offered a candidate: *"the AllDay leg 403s upstream first, so its RPC never runs, and a 'fix' aimed at that 20 s mean would be tuning a function almost nobody reaches."* It called this a hypothesis, not a finding, and said *"the discriminating measurement is a per-collection request count on the route, which nothing currently records."*

⭐ **It does not need one. The control flow answers it, and it answers the OPPOSITE way.** `app/api/sniper-feed/route.ts`:

- `fetchAlldayPool()` returns `{ edges: [], endCursor: null, hasNextPage: false }` on **every** failure path — HTTP non-200 (the 403), a GraphQL `errors` array, a missing `searchMarketplaceEditions`, and the `catch`. All four also `sink.note("allday-marketplace")`.
- The caller then does `const nodes = await fetchAlldayPool(sink); if (nodes.length === 0) { … get_allday_sniper_deals … }`.

**So a 403 produces an empty pool, and an empty pool is precisely the condition that TRIGGERS the RPC.** The upstream block *causes* an RPC call; it cannot prevent one. ⛔ **Do not carry the "AllDay short-circuits before its RPC" reading forward.**

**The 300× is instead two ordinary multiplicative factors, neither a defect:** the All Day leg is gated by collection (`if (collection === "nfl-all-day")`), so it never runs on a Top Shot request; and within All Day requests the RPC is a **fallback**, reached only when the live GQL pool comes back empty. A working GQL path is the common case, so the RPC is rare *by design*.

⭐ **This also discharges §6's *"do not tune `get_allday_sniper_deals` before §5 is answered"*** — which had already been overtaken by events: it was rewritten on 09-03 (migration `20260904052858`).

## 2 · 🚨 The 09-04 ledger's post-fix number is measured at `p_min_discount = 10`; the route defaults to `0`

The ledger entry for migration `20260904052858` records the rewrite as **"Now 204 ms / 19.5K buffers (warm count 385 ms)"**, against a pre-fix **16,767 ms / 170K buffers**. The rewrite is real and large. **But the probe's first argument is not the one production sends.**

`app/api/sniper-feed/route.ts:929` — `minDiscount: z.coerce.number().min(0).max(100).default(0)`. An All Day sniper load with no discount filter set — the default view — calls the function with **`p_min_discount = 0`**.

**Measured tonight, warm-vs-warm, same instance, same session, each parameter run twice and the second reading taken:**

| `p_min_discount` | buffers (hit / read) | execution |
|---|---:|---:|
| **10** — what the ledger measured | 10,584 / 3 = **10,587** | **131 ms** |
| **0** — what the route DEFAULTS to | 120,561 / 5,894 = **126,455** | **2,548 ms** |

⭐ **12× the buffers and ~19× the time**, on the code path a user gets by simply opening the page.

⚠ **This is the rule CLAUDE.md already states, met in the wild:** *"a control must use the PRODUCTION CALLER"*, and *"a probe whose HARNESS differs from production in the ONE dimension the answer depends on is not a measurement of production."* The discount floor **is** that dimension here — it is the predicate that decides how many open listings survive to be ranked.

⛔ **What this is NOT:** it is not a claim the fix failed. Against the *same* default parameter the pre-fix body measured 16,767 ms, so the rewrite is still a **~6.6× improvement on the production path** (16,767 → 2,548 ms). The correction is to the recorded MAGNITUDE, not to the direction.

## 3 · The practical consequence, and why it is worth knowing rather than acting on tonight

The route bounds this read at **8 s** (`boundedRead`, shipped 09-03). At 2,548 ms warm the default fits — with ~3× headroom. **But 126K buffers is a large working set on a SMALL instance whose IO budget is the standing root cause**, and the same instance was measured today turning a *23-buffer* read into 3 s under contention. A 126K-buffer read under that contention is exactly the shape that re-breaches an 8 s bound and puts "COULDN'T LOAD THE FLOOR" back on the page.

**Nothing shipped, because the obvious lever is a PRODUCT decision, not a fix:** raising the default discount floor above 0 would cut the working set by ~12× and would also change what the board shows by default. That is Trevor's call, and it is a different question from whether the function is correct.

## Falsifiers

- §1: if `fetchAlldayPool` ever gains a path that THROWS instead of returning an empty pool, the short-circuit reading becomes true again — re-read the four return sites before quoting this.
- §2: re-run both parameters in a quiet window. **If `p_min_discount = 0` comes back near 10K buffers, my reading is the contended one and the ledger's number stands** — buffers, not timings, are the discriminator, because saturation moves timings both ways.
- §3: the claim that this can breach the 8 s bound is a PREDICTION, not an observation. The falsifier is a `[sniper-feed/get_allday_sniper_deals] read exceeded 8000ms` line in the Vercel error table. **None was present in the 5 h to 2026-09-05 01:00Z** — the only sniper-feed error in that window is the known `AD GQL FAILED: HTTP 403` (2 events / 2 users).
