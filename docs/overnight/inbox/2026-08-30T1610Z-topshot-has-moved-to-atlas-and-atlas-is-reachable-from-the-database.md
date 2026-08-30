# 🚨 Top Shot has moved to ATLAS — and Atlas is reachable from the DATABASE, with no operator action

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

✅ **The clearly net-positive first step is to move the EXISTING board ingest to this egress.** It runs 8×/day and currently fails ~83 % on the blocked GHA IP. Moving it **adds no load — it replaces a broken path with a working one**, it is ~6 min per sweep, and it immediately un-starves three live surfaces: the Underpriced #1s board, the concierge's `search_serial_deals`, and the serial pass of the alert dispatcher. It also yields a real sustained-rate measurement as a by-product, which is exactly what the full sweep needs before it can be sized.

👉 **Then, with that number in hand,** decide the catalogue sweep and the map backfill — and that one is genuinely Trevor's, because it is a standing load increase on a saturated instance.

## What this closes and re-opens

- ⛔ **#20's framing is no longer the only path.** It is filed as *"needs an operator `wrangler deploy` + a Cloudflare-egress probe"*. That is still the tidiest architecture (it keeps fetch off the IO-bound DB), but it is **no longer the blocker it is written as** — there is a verified alternative available today.
- ⭐ It also **raises the prior** that the worker route would work: Atlas evidently does not blanket-block datacentre IPs, since Supabase's works. **Not proof** — different provider, different WAF verdict — but it makes the one-line probe in `workers/atlas-proxy/README.md` much more likely to succeed.
- ✅ **The 1530Z filing's conclusion stands and is now better explained.** "No viable source for broad Top Shot asks" was right *about Studio and about Atlas-as-currently-configured*; the correction is that **Atlas-as-an-API is viable, and the barrier was egress, which is now solved.**
