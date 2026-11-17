# Handoff — Flowty-independence for the ASK/listing leg of FMV

**Author:** Cowork (monthly-strategy-review pass, 2026-10-03 ~07:46 PDT)
**Status:** SCOPE + DESIGN. Nothing shipped. Flowty is still alive; no teardown date (Trevor, 2026-10-03). Build and stage the replacement so FMV's ASK leg does not regress when Flowty goes dark — do **not** rip out the live path yet.
**Push path from the authoring session:** none (`git push --dry-run` failed — repo not attached, no cred). This is route/worker/edge code anyway, so it was always a Claude-Code-on-your-box job. Commit direct to `main` as usual.

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## 1. Context — why this is the #1 strategic build

Trevor noted 2026-09-25 that **Flowty will turn its API endpoints off "soon."** The listing-cache lanes read Flowty's GraphQL through the `flowty-proxy` edge function and write `cached_listings` / `cached_listings_v2` with `source='flowty'`. That data feeds the **ASK leg of FMV** (`fmv-recalc`, `lib/cross-market-floor.ts`). When Flowty dies, the ASK-corroborated confidence tiers (ASK_ONLY, and the ask half of MEDIUM) regress on exactly the collections already weakest on the accuracy gate — which is the one metric the roadmap makes the go-live gate. So this is a **dependency cliff on the headline metric**, not a feature.

Roadmap thesis it serves: *accuracy is the gate.* Losing the ASK leg quietly drops HIGH/MED share → moves RPC away from "more accurate than the native site."

## 2. The dependency, mapped (verified by grep 2026-10-03)

**Single choke point:** `supabase/functions/flowty-proxy/` — every Flowty fetch goes through it.

**Lanes that fetch Flowty → write `source='flowty'`:**
- `app/api/topshot-listing-cache/route.ts` (TS, via `FLOWTY_PROXY_URL`, page 100 × 20)
- `app/api/allday-listing-cache/route.ts`
- `app/api/golazos-listing-cache/route.ts`
- `app/api/ufc-listing-cache/route.ts`
- `app/api/listing-cache/route.ts` (shared/legacy)
- `app/api/pinnacle-ingest/route.ts` (historical; confirm current source)

**Consumers of the Flowty-sourced floor (the blast radius):**
- `lib/cross-market-floor.ts` — `chooseCrossMarketFloor(tsFloor, flowtyFloor)` picks the lower of Top Shot's own floor and the Flowty floor. Type `CrossMarketSource = "topshot" | "flowty" | null`.
- `app/api/fmv-recalc/route.ts` — ASK-corroboration leg reads `cached_listings`.
- `app/api/edition-floor/route.ts`, `lib/cross-market-floor.ts`, the Market/Sniper clients.

**Per-collection reality (this is the key insight — most collections already have a non-Flowty path):**
- **Top Shot** — already has a native path independent of Flowty (Top Shot GQL / Atlas / `edition_offers`, `topshot_atlas_market_events`). Flowty is a *second* floor source, not the only one. Lowest risk.
- **All Day** — has an on-chain storefront indexer already: `app/api/allday-listings-indexer/route.ts` + `allday-listings-retry` writing `cached_listings_v2`. Non-Flowty path exists.
- **Golazos** — `app/api/cron/golazos-storefront-reconcile/route.ts` writes `cached_listings_v2` from chain. Non-Flowty path exists.
- **UFC** — only `ufc-listing-cache` (Flowty) found; **no on-chain storefront indexer**. This is the real gap. (Note: UFC FMV is currently 100% STALE/NO_DATA regardless — see §5 — so the user-facing cost of UFC losing Flowty is near zero today.)
- **Pinnacle** — uses `pinnacle_catalog.floor_ask` written by `pinnacle_catalog_set_floor_asks` and `pinnacle-listings-reconcile` (`ask_source='pinnacle_direct'`), not Flowty. Confirm `pinnacle-ingest`'s Flowty use is dead (`pinnacle_cached_listings` is the frozen Flowty $1-floor cache per rpc-data skill).

## 3. Proposed design — "on-chain storefront index is the source of truth; Flowty is a fallback that can be switched off"

The replacement is **not new infrastructure** for most collections — it is promoting the on-chain storefront listing index (the `NFTStorefrontV2` `ListingAvailable`/`ListingCompleted` events already ingested for All Day and Golazos) to be the *primary* ASK source, and making the Flowty source a clean, removable fallback.

1. **Introduce a `source`-agnostic floor read.** `cross-market-floor.ts` should choose `min(onchainFloor, flowtyFloor)` with `CrossMarketSource = "topshot" | "onchain" | "flowty" | null`, so the consumer no longer hard-depends on `"flowty"`. When Flowty goes dark, `flowtyFloor` is simply `null` and the function already handles null (returns the other source). **This is the single change that makes the teardown a non-event** rather than a regression.
2. **Build the UFC on-chain storefront indexer** (the one genuine gap), modelled on `allday-listings-indexer`: scan the UFC Strike `NFTStorefrontV2` storefront via Flow REST, upsert `cached_listings_v2` with `source='onchain'`. Zero-downtime pattern: ship it writing `source='onchain'` alongside the Flowty rows; verify parity; then flip precedence.
3. **Add a freshness/parity guard** that, per collection, compares the on-chain floor count vs the Flowty floor count over a 24h window, so you can *prove* the on-chain source is complete before relying on it (don't flip precedence until the counts agree — this is the "diff the SET, not the count" discipline; compare per-edition set membership, not totals).
4. **Flip precedence collection-by-collection** once (3) is green, leaving Flowty as fallback. Keep the Flowty lanes running until the teardown date; they cost little and are the safety net.
5. **When the teardown date lands:** disable the `*-listing-cache` crons and the `flowty-proxy` fetches; `cross-market-floor` already degrades cleanly. Retire `flowty-proxy` with the house 410-stub pattern after proving zero invocations.

## 4. Files touched / to create

- **Edit** `lib/cross-market-floor.ts` — widen `CrossMarketSource`, make `chooseCrossMarketFloor` source-agnostic (min of available floors, deterministic tie-break to on-chain). Mutation-check: the existing unit tests must be updated to add an `"onchain"` case and still pin the null-handling.
- **Edit** `app/api/fmv-recalc/route.ts` and `app/api/edition-floor/route.ts` — read the agnostic floor; stop assuming `source='flowty'`.
- **Create** `app/api/ufc-listings-indexer/route.ts` (model on `allday-listings-indexer`) + a cron slot (see cron-schedule.md; respect the stagger ban).
- **Create** a parity check: `scripts/qa/listing-source-parity.mjs` or a `check_listing_source_parity()` SQL fn feeding `rpc_ops_snapshot()`.
- **Migration** (if the parity check is SQL): standard header + anon-exec marker + revert SQL.

## 5. Scope note — UFC and Golazos are weak on *demand*, not plumbing

Live read 2026-10-02: UFC 100% STALE/NO_DATA (518 editions), Golazos 1.0% HIGH/MED / 80% ASK_ONLY. These are thin markets — the ASK leg is most of what Golazos *has*, so Golazos is the collection that most needs its on-chain ask source solid before Flowty dies. UFC has essentially no market data either way; don't spend the UFC indexer effort ahead of Golazos parity.

## 6. Revert path

- `cross-market-floor.ts` + consumers: revert the commit; the `"flowty"`-only behaviour returns.
- UFC indexer: `cron.unschedule('<ufc-listings-indexer slot>')` + revert the route commit; nothing else reads `source='onchain'` for UFC until precedence is flipped.
- No destructive DB ops in this plan — `cached_listings_v2` gains `source='onchain'` rows alongside existing ones.

## 7. Verification

`npx tsc --noEmit` clean (laptop VM, `--max-old-space-size=3072`) · updated `cross-market-floor` unit tests green (mutation-check by inverting the tie-break) · Vercel deploy READY · the parity check reporting per-collection on-chain-vs-Flowty set agreement before any precedence flip · a real cron tick of the UFC indexer writing `cached_listings_v2` rows (verify by the next `pipeline_runs` row, not the manual run).

## Guardrails (repeat every handoff)
- Direct to `main`, no branches/PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op); re-verify `git rev-list --count origin/main..HEAD` == 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap 800s.
- CRLF: full-file writes, not string-replace patches.
- This no-push note is specific to the Cowork cloud session; your machine + Claude Code push normally via Git Credential Manager. Never re-embed a PAT in `remote.origin.pushurl` (dead since 2026-08-16).

**End state:** `cross-market-floor` is source-agnostic and degrades cleanly to `null` Flowty; Golazos (then All Day, TS) on-chain ask parity proven; UFC indexer staged; Flowty teardown becomes a config flip, not an accuracy regression. Ledger entry per shipped piece.

---

## Disposition — NOT BUILT: the end state is already true (Claude Code, 2026-10-03 ~8:00 AM PT)

Re-derived against code + live DB before acting. FMV's ASK leg reads **no** Flowty data today, so "Flowty goes dark" is already a non-event for it — this matches `docs/reference/roadmap-status.md` (2026-09-25 note: "no data dependency remains"), which this handoff missed.

- `lib/cross-market-floor.ts` exports `selectCrossMarketFloor` (not `choose…`); its only caller `app/api/edition-floor/route.ts` already stubs `fetchFlowtyFloor()` to `{floor:null}`.
- `fmv-recalc` reads `edition_offers` (Top Shot, Atlas), `allday_edition_floor_ask` (on-chain v2), `cached_listings_v2` (liveness only), `topshot_parallel_asks`, `badge_editions`. Current HIGH/MEDIUM/ASK_ONLY editions carrying a Flowty-derived ask algo: **0**.
- Per collection, non-Flowty ask paths are live and fresh: Top Shot (Atlas → `edition_offers`), All Day (v2 `direct_v2`/`storefront_v2` + 6-hourly pg_cron), Golazos (`refresh_golazos_ask_fmv_from_listings`, `golazos-listing-ask-v1` on 296 editions — §5's "Golazos depends on the Flowty ask" is false), Pinnacle (`direct` + indexer). UFC has no ask source from anyone, Flowty included (`ufc-listing-cache` has not run; no UFC sales since 2026-05-13).
- `flowty-proxy` is not the single choke point: `ufc-listing-cache`, `seed-ufc-editions` and `lib/pinnacle/*` call `api2.flowty.io` directly.
- Live Flowty lanes: `topshot-`, `allday-`, `golazos-listing-cache` (~144 runs / 48 h each) → v1 `cached_listings` only (~100 rows per collection).

**Not to build:** §3 steps 1–4 (source-agnostic floor, UFC indexer, parity check, precedence flip).
**Teardown on the day Flowty goes dark** (unchanged from the 09-25 note): retire the three sweeps and their schedulers (All Day + Golazos are presumably cron-job.org — not visible from pg_cron/vercel.json/GHA), then `flowty-proxy`; check the v1 display readers (`get_cross_collection_deals`, `get_platform_stats`).
**One open observation, not actioned (FMV-adjacent, needs a decider):** `golazos-listing-cache` still calls `update_badge_low_ask_from_cached_listings` (route.ts ~418–445), a SECOND writer of Golazos `badge_editions.low_ask` beside the on-chain `refresh_golazos_badge_low_ask` (pg_cron :10/:40), which overwrites it. Removing the Flowty call would leave one writer; Flowty dying removes it anyway.
