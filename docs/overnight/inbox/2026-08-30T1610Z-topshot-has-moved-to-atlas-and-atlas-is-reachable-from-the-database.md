# 🚨 Top Shot has moved to ATLAS — and Atlas is reachable from the DATABASE, with no operator action

---

## ⛔ CORRECTION 2026-08-30 ~09:5x PT (16:5xZ), BY THE SESSION THAT FILED THIS — §5's RECOMMENDATION RESTED ON A FALSE PREMISE

**What §5 says: the board ingest "currently fails ~83% on the blocked GHA IP" and moving it "immediately un-starves three live surfaces". That is WRONG. The board is NOT starved. It is fully fed, right now, and has been all week.**

⚠ **The error is the two-caller-arm trap, committed in full.** `topshot-active-listings-ingest` has TWO callers and I measured the pooled rate, which is neither arm's rate:

| arm | runs (7 d) | ok | **% ok** | egress_blocked | Atlas calls | rows written |
|---|---:|---:|---:|---:|---:|---:|
| **residential — Windows Task Scheduler on Trevor's box, `29 */3`→:13** | **18** | **18** | **100 %** | 0 | 26,584 | 4,719 |
| GitHub Actions (`.github/workflows/topshot-active-listings-ingest.yml`, `29 */3`) | 9 | **0** | **0 %** | 9 | 0 | 0 |
| *pooled (what I quoted)* | 27 | 18 | *66.7 %* | 9 | — | — |

**Attribution is confirmed, not inferred:** `gh run list` shows **12/12 scheduled GHA runs `failure`**, and their start times match the `egress_blocked` rows to the minute. The two *successful* off-anchor runs are NOT GHA — they are residential catch-ups, because the task is registered `-StartWhenAvailable`, so a sleeping box fires it late at a non-:13 minute. Attributing by MINUTE was itself wrong; attribute by MECHANISM (`atlas_calls > 0`).

Latest residential sweep: **2026-08-30 09:13 PT, ok=true, 674 targets, 1,348 Atlas calls, 233 listings, 36 deactivated.**

### What survives, and what does not

- ❌ **DEAD: "moving the board ingest un-starves three live surfaces."** Nothing is starved. There is no user-visible outage to fix, and this is no longer a priority-1 build.
- ✅ **ALIVE, and now the real reason:** the board's ONLY working feeder is **a scheduled task on Trevor's personal desktop that "runs only while the user is logged on."** That is a single point of failure on a machine that is not a server. `pg_net` reaching Atlas is valuable because it is a **datacenter-independent, always-on** second feeder — resilience, not rescue. That reframing is *less* urgent and *more* durable.
- ✅ **The pg_net→Atlas finding itself stands**, and is now measured harder — see the sustained-rate block below.

### Sustained rate — the measurement §3 said was missing (120 calls, ~20 min, paced ~20/min)

| batch | ok | **403 Cloudflare challenge** | empty-200 |
|---|---:|---:|---:|
| 1 | 23 | **7 (23.3 %)** | 0 |
| 2 | 25 | **5 (16.7 %)** | 0 |
| 3 | 30 | 0 | 1 |
| 4 | 30 | 0 | 1 |
| **total** | **108 (90 %)** | **12 (10 %)** | **2** |

- ⭐ **The failure mode is NOT the feared silent empty-200 — it is a LOUD `403` Cloudflare "Just a moment…" interstitial.** Loud is good: it is trivially distinguishable from "no listing", so it cannot cause the ask-wipe §3 warns about.
- ⭐ **The 403s are SCATTERED, not clustered at the tail** (seq 2,4,5,12,16,21,23) ⇒ probabilistic challenge, **not** rate-triggered exhaustion. Pacing does not help; **retry does**.
- ⭐ **The rate IMPROVED across the run (23 % → 17 % → 0 % → 0 %) ⇒ no progressive IP burn.** The earlier 48/48 was a favourable window, not a different regime.
- ⚠ **Evidence AGAINST the empty-200-as-throttle reading, at this pacing:** the empties are **anti-correlated** with load — batches 1–2 carried all 12 challenges and **zero** empties; the clean batches 3–4 produced both empties. At n=2 that is evidence, **not proof**, so the conservative rule STANDS: **an empty Atlas response is UNKNOWN, never "no listing."**

### ⚠ Self-inflicted alerts, so nobody chases them

This measurement raised `pg_net_http_403` (**critical**, 12 calls) and `pg_net_http_422` (high, 2 calls) in `get_pipeline_alerts()`. **Both are mine** — the 403s are these Atlas probes, the 422s the earlier Studio schema probe. The arm's own text anticipates this ("SELF-INFLICTED — a strict upstream rejecting one of our schema probes"). They age out of the 2 h window on their own.

**Durable lesson: [[measuring-one-arm-of-a-two-caller-pipeline]] fired exactly as written, and I still walked into it — because the pooled number was plausible and flattered a build I already wanted to do. A rate quoted for a two-caller pipeline is meaningless until the arms are split, and the split must be by MECHANISM, not by schedule minute.**

---

**Filed 2026-08-30 ~09:10 PT (16:10Z) by the Claude Code interactive session. MEASURED, DECISION-GRADE, NOTHING SHIPPED.**

**Origin: Trevor's hypothesis** — *"it feels like Top Shot is shifting away from their own and moving the endpoint to Atlas."* It is correct, and testing it produced a second finding that changes what is blocked.

---

## 1. The hypothesis is confirmed by three independent readings

| endpoint | Top Shot | sibling collections | reading |
|---|---|---|---|
| `public-api.nbatopshot.com` (Top Shot's own) | **530 / `error code: 1033`, ~41 h** | n/a | decommissioning-shaped |
| Studio `searchTopShotNft` | **totalCount 0** | `searchAllDayNft` **10,670,740** | Top Shot is **not** on Studio; AllDay/Golazos/Pinnacle are |
| **Atlas `MarketplaceService`** | **LIVE, full listing rows** | — | **this is where Top Shot now lives** |

⭐ **The Studio zero stops being a mystery once you accept the hypothesis.** Studio has `searchAllDayEditions`, `searchGolazosEditions`, `searchPinnacleEditions` and **no Top Shot editions field at all** — previously read as an odd gap. Under Trevor's reading it is the expected shape: **Top Shot is being served by Atlas (`dapper.market`), not by Studio and not by its own legacy host.** A live Atlas row carries everything the legacy `searchMarketplaceEditions` did — `priceCents`, `nftId`, `editionId`, `serialNumber`, `listedAt`, `edition.{seriesId,setId,editionTemplateId,tier}`.

## 2. 🚨 The finding that changes what is blocked: **pg_net reaches Atlas**

The record says Atlas is hard to reach: its WAF **403s Node/undici** (verified from a real Vercel function), the **GHA runner IP is `egress_blocked` (~83 % fail)**, and `workers/atlas-proxy` is **INERT pending an operator `wrangler deploy`** with Cloudflare-egress-to-Atlas **unverified**. That is why #20 is filed as operator-gated.

**`pg_net` is libcurl, and Atlas allows curl.** Measured today, using the byte-identical request shape the production runner uses:

| batch | n | HTTP 200 | **non-empty transactions** | timeouts / 4xx |
|---|---:|---:|---:|---:|
| A (spread) | 8 | 8 | **8** | 0 / 0 |
| B (**burst — 40 dispatched, all answered in 7 s**) | 40 | 40 | **39** | 0 / 0 |

**48 probes, 48 × HTTP 200, 47 non-empty.** ⭐ **So there is a THIRD egress to Atlas that works today and needs nobody's approval** — not the blocked GHA IP, not the undeployed worker.

⚠ **A control was required and it fired first.** My initial probe **timed out at 25 s** and looked exactly like a WAF hang. The discriminator was a second probe with a real `editionId` — that returned 200 with data in the same conditions. **The timeout was my query (an unfiltered sweep Atlas will not serve), not the egress.** Without that control this filing would have concluded the opposite.

## 3. ⛔ THE HAZARD ANY IMPLEMENTATION MUST HANDLE FIRST

`scripts/backfill-atlas-edition-map.mjs` records it in its own header: **Atlas "soft-throttles under rapid calls (HTTP 200 with empty results)"** — not a 429, not an error.

🚨 **That is this platform's top defect class arriving from outside, and it is pointed at the ask column.** A sweep that treats `{"transactions":[]}` as *"this edition has no listing"* would **rewrite live asks to null under throttle** — the identical data-destroying shape the 2026-08-29T2200Z filing caught before it shipped against Studio. **An empty Atlas response is UNKNOWN, never "no listing".** Any writer must carry that distinction or it will quietly wipe the board it is meant to feed.

⚠ **My burst test does NOT clear this.** 40-in-7 s showed no material throttling (39/40 non-empty, and the 1 empty is indistinguishable from a genuinely unlisted edition), but the script's warning is about **sustained** rate, which is untested. **Do not read 5.7 req/s as a safe sustained rate.**

## 4. Sizing, honestly

- **Map coverage is the real cap:** `topshot_atlas_edition_map` holds **9,080 of 19,913** Top Shot editions = **45.6 %**. It is extendable via Atlas `EditionService/SearchEditions` over the same egress, so this is a backlog, not a ceiling.
- At the observed burst rate: **9,080 calls ≈ 27 min**; ×2 for the ASC+DESC boundary protocol ≈ **53 min**.
- The **existing board sweep** (~1,080 targets × 2 = ~2,160 calls) ≈ **6 min**.

⚠ **The cost is not the calls, it is where they land.** This puts egress *and* write load on a database already measured at **104.6 % pg_cron duty cycle** and IO-bound (R46). The roadmap says no infra spend pre-revenue, so "it fits in 27 minutes" is not the same as "it is free".

## 5. Recommendation — and the reasoning, not just the verdict

⛔ **Do NOT build the full catalogue sweep as the first move.** It is a new **asynchronous** pipeline (pg_net dispatches and you collect later, so it needs request→edition correlation, partial-completion handling, and the throttle rule above) on a saturated instance, touching a user-facing accuracy path. Improvising that at the end of a long session is how the wipe happens.

⛔ **THE BULLET BELOW IS REFUTED — see the CORRECTION at the top of this file. The board is NOT starved: the residential arm is 18/18 (100%) and the ~83% figure is the OTHER arm. Kept verbatim so the error stays legible.**

✅ **The clearly net-positive first step is to move the EXISTING board ingest to this egress.** It runs 8×/day and currently fails ~83 % on the blocked GHA IP. Moving it **adds no load — it replaces a broken path with a working one**, it is ~6 min per sweep, and it immediately un-starves three live surfaces: the Underpriced #1s board, the concierge's `search_serial_deals`, and the serial pass of the alert dispatcher. It also yields a real sustained-rate measurement as a by-product, which is exactly what the full sweep needs before it can be sized.

👉 **Then, with that number in hand,** decide the catalogue sweep and the map backfill — and that one is genuinely Trevor's, because it is a standing load increase on a saturated instance.

## What this closes and re-opens

- ⛔ **#20's framing is no longer the only path.** It is filed as *"needs an operator `wrangler deploy` + a Cloudflare-egress probe"*. That is still the tidiest architecture (it keeps fetch off the IO-bound DB), but it is **no longer the blocker it is written as** — there is a verified alternative available today.
- ⭐ It also **raises the prior** that the worker route would work: Atlas evidently does not blanket-block datacentre IPs, since Supabase's works. **Not proof** — different provider, different WAF verdict — but it makes the one-line probe in `workers/atlas-proxy/README.md` much more likely to succeed.
- ✅ **The 1530Z filing's conclusion stands and is now better explained.** "No viable source for broad Top Shot asks" was right *about Studio and about Atlas-as-currently-configured*; the correction is that **Atlas-as-an-API is viable, and the barrier was egress, which is now solved.**
