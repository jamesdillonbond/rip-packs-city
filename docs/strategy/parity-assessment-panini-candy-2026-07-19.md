# Feature parity: Panini + Candy vs Top Shot / All Day — 2026-07-19

Every figure here was measured live against `bxcqstmqfzmuolpuynti` on 2026-07-19. Figures move (the Panini index grew 1,647 → 1,923 during this session alone); the *conclusions* are structural and stable.

---

## The one thing that matters

**Panini and Candy are not two instances of the same problem. They sit on opposite sides of the shared data plane, and that single fact determines everything else.**

| | Candy MLB | Panini WC Prizm |
|---|---|---|
| `editions` (shared) | **125** | **0** |
| `wallet_moments_cache` (shared) | **25,375** | **0** |
| `sales` (shared) | 0 *(no market yet)* | **0** |
| `fmv_snapshots` (shared) | 0 *(no market yet)* | **0** |
| Lives in | the shared plane | a parallel `panini_*` plane (1,923 editions, 8,201 serials, 2,542 FMV rows) |

Candy is **inside** the house with the lights off. Panini is a **complete, working house next door** that shares no plumbing.

So "parity" means two completely different jobs:

- **Candy** — the wiring is already there. It inherits shared surfaces the moment it has data and a UI. The work is small and mostly waiting.
- **Panini** — it has *more* real data than Candy in several dimensions, but **every shared RPC, entity page, wallet surface, badge system and concierge tool is structurally blind to it.** The work is a bridge, or a deliberate decision to stay standalone.

---

## Candy — near-parity, three concrete gaps

### Proven: it already inherits shared analytics

Not theory. `analytics_sets_directory(ARRAY['candy_mlb'], …)` returns today:

```json
{"set_name": "2026 MLB Base Series ICONs", "collection": "candy_mlb",
 "edition_count": 125, "set_external_id": "candy-mlb-base-icons-2026",
 "series": 1, "coverage_pct": 0.0, "avg_fmv_usd": null, "total_fmv_usd": null}
```

That row exists **because of this morning's metadata backfill** — creating the `sets`/`players` rows and filling `tier`/`set_id`/`player_id` directly lit up a shared surface with no code change. That is what being inside the plane buys.

### Gap 1 — the slug-normalization `CASE` drops Candy (latent, will bite silently)

> 🚨 **CORRECTED 2026-09-20 — THE MECHANISM BELOW IS WRONG, AND A SESSION ACTING ON IT WOULD DO THE WRONG WORK.** Re-derived against live `pg_proc` this morning rather than re-read. The claim "there is **no arm for `candy_mlb`**, and no `ELSE`. It evaluates to NULL and the row is silently dropped" does not hold: **every slug-normalizing `CASE` in that family carries `ELSE c.slug`** — verified line by line in `analytics_fmv_tier_pulse`, `analytics_liquidity_distribution`, `analytics_listings_summary` (both arms), `analytics_sales_summary` (both arms), `analytics_sets_detail`, `analytics_sets_directory`, `analytics_sets_series_overview`, `analytics_sets_summary`, `flowty_normalize_collection` (`ELSE c`), `get_platform_stats` (`ELSE replace(c.slug,'_','-')`) and `get_collection_stats` (`replace('-','_')` + `ELSE v_slug_norm`). **Candy is not dropped — it falls through keyed by its LONG slug `candy_mlb`.** Proven by payload, not by predicate: `analytics_liquidity_distribution(ARRAY['candy_mlb'])` returns 125 editions; `analytics_fmv_tier_pulse` returns LEGENDARY 24 / COMMON 100; `analytics_sales_leaderboard` returns 60+ base58 wallets. `lib/analytics-sets-dashboard-compute.ts` has labelled that exact key since 2026-07-31 — the fall-through was already load-bearing when this document said the rows were being discarded.
>
> 👉 **THE REAL DEFECT WAS ON THE OTHER SIDE OF THE WIRE, and it was the mirror of the one described here.** The RPCs key Candy correctly; the FRONTEND asked with the wrong key. `shortSlug()` in `lib/analytics/format.ts` was a five-entry hardcoded map beside the registry, so `shortSlug("candy-mlb")` returned the HYPHEN slug — which matches nothing in any of those functions. Fixed 2026-09-20 by deriving arm 2 from `toDbSlug`, i.e. by mirroring `ELSE c.slug` in TypeScript instead of listing collections.
>
> 📌 **What IS still a genuine Candy exclusion, and it is an explicit `IN`-list rather than a `CASE`** — so "add the `CASE` arms" would not have touched any of it: ~~`get_market_pulse_all` and `get_market_pulse_windows`~~ **✅ CLOSED the same day (migration `20260920175000`)** — and ⚠ **the parenthetical I wrote here, "excludes Pinnacle too, so it is a wider question than Candy", WAS WRONG**: both functions give Pinnacle its OWN union arm off `pinnacle_sales`, because its sales are not in `sales` at all. **Only Candy was missing**, from three surfaces at once (the homepage 24 h stats, the public `/insights/market-pulse` board, the email digest) — and `getVolume24hFromPulse` turned its missing row into a measured-looking **$0** via `?? 0`. Live after the fix: Candy 129 sales / $181.47 in 24 h, 4th of 6 by 7-day volume. 🚨 **AND THE OTHER TWO ARE NOT GAPS EITHER — verified 2026-09-20, which CLOSES this item rather than leaving two phantom TODOs.** I named them from a static grep; checking each against its CALLERS and its DATA refutes both:
>
>  * **`capture_institutional_wallet_snapshot` is DORMANT** — no `cron.job` row, no route, no edge caller. The function that actually writes `wallet_holdings_snapshot` is the edge fn `snapshot-institutional-wallets`, and **it is already collection-agnostic**: it aggregates `wallet_moments_cache` by `collection_id` with no slug filter (its `COLLECTION_SLUG = "nba_top_shot"` is only a `log_pipeline_run` LABEL, not a data predicate). ⛔ **Worse, adding Candy to the dormant SQL one WITHOUT fixing it first would be actively harmful:** its first line is `lower(trim(p_wallet_address))`, and lower-casing a CASE-SENSITIVE base58 key matches zero `wallet_moments_cache` rows — so it would INSERT a snapshot row reading `moment_count 0, total_fmv_usd 0` for a wallet that holds Candy. **A fabricated zero written to a table is worse than the exclusion.**
>
>  * **`claim_sales_counterparty_batch` excludes Candy CORRECTLY.** It exists to recover counterparties that are NULL by decoding **Flow** transactions (`workers/sales-counterparty-backfill/decode.ts`). Measured: Candy's **1,554 sales in 30 days carry 0 NULL buyers and 0 NULL sellers** — the Magic Eden indexer supplies both at write time. There is nothing for it to recover, and its Flow decoder could not read a Solana signature anyway. (It does also exclude Golazos and Pinnacle, which is a separate question about those two, not about Candy.)
>
> 👉 **So the market-pulse pair was the ONLY real `IN`-list exclusion, and it is closed. Do not re-open the other two for Candy.**
>
> ⚠ **And one gap this document did not have, because it did not exist in July: a table split.** `analytics_listings_summary` read only `cached_listings`, where Candy has **0** rows — its asks are indexed into `candy_listings` (1,983 active and priced on 2026-09-20). So that one function really did report nothing for Candy, and the Order Book card rendered it as the words **"No live listings."** Fixed the same day by a Candy arm (migration `20260920153900`), verified at 1,939 asks / median $4.44.


`analytics_liquidity_distribution`, `analytics_packs_summary`, `analytics_sets_summary`, `analytics_fmv_tier_pulse` and others all normalize slugs with:

```sql
CASE c.slug WHEN 'nba_top_shot' THEN 'topshot'
            WHEN 'nfl_all_day'  THEN 'allday'
            WHEN 'laliga_golazos' THEN 'golazos' ... END
```

There is **no arm for `candy_mlb`**, and no `ELSE`. It evaluates to NULL and the row is silently dropped downstream. This is the two-vocabularies footgun from CLAUDE.md.

Right now this is invisible because Candy has no FMV/sales to show. **The trap is that it stays invisible after Candy gets data** — the surfaces will simply keep returning nothing, and it will look like an ingest problem rather than a missing `CASE` arm. 28 shared RPCs reference `nba_top_shot` + `nfl_all_day`; **none mention `candy_mlb` or `panini`**.

Fix when Candy has data: add the `CASE` arms. Cheap, but do it *with* the FMV work so it is verified against real rows, not shipped blind.

### Gap 2 — no price signal (external, cannot be engineered)

0 sales, 0 listings (`listedCount: 0`, quest-hold), 0 FMV. The only live signal is bids: **47 standing offers, 2 bidders, 24 editions, $0.23–$3.04**, captured by `candy-offers-indexer`. Rational internally (LEGENDARY /15 averages $2.74 vs COMMON /250 at $0.34 — an ~8× premium for a 16.7×-scarcer tier) but far too thin to be FMV.

### Gap 3 — no UI at all

`candy-mlb` has **zero route dirs**. Its `pages: ["overview","collection","packs","sniper"]` in `lib/collections.ts` is aspirational. `is_active=false`. So even with perfect data there is nothing to render.

**Candy verdict:** genuinely close. Ordered dependency: first sale → FMV → `CASE` arms → route dirs → `is_active`. Only the first is outside our control, and it gates everything after it.

---

## Panini — richer data than expected, zero structural parity

### It has far more than a listings scraper implies

| Signal | Coverage |
|---|---|
| Per-serial **ownership** | **8,201 / 8,201 (100%)**, **1,011 distinct owners** |
| Real **sales** | 2,968 serials with `last_sale_usd`, across **1,193 editions** |
| **Special serials** | 1,194 flagged (`is_number_one` / `is_jersey_mint` / `is_perfect_mint`) |
| **Best offers** | 7,239 serials |
| **FMV** | 2,542 rows, 99.5% of the board priced |

That is enough to support wallet/portfolio views, special-serial boards, offer surfaces and sales history — the same feature set Top Shot has.

### Two hard caveats

1. **Owners are usernames, not wallet addresses** (`EZGOLF`, `lepwn`, `poy` — no `0x`). RPC's entire wallet stack is address-keyed. A Panini "wallet" surface would key on a different identity space, and there is no way to link a Panini username to a Flow address.
2. **Serial coverage is 6.21%** — 8,201 held of **132,080** total supply across discovered editions (avg 4.3 serials per edition, and remember the edition list itself is listing-gated at ~46% trustworthy). Ownership-derived surfaces would therefore be a *sample*, not a census — the same disclosure problem as the squeeze board, but worse, because a portfolio view that shows 6% of someone's holdings is actively misleading in a way an incomplete leaderboard is not.

### The bridge decision

Bridging `panini_editions` → shared `editions` is **schema-feasible**: every required column maps (`external_id`, `collection_id`, `player_name`, `set_name`, `tier`, `mint_cap` → `circulation_count`, `thumbnail_url`, `video_url`, `first_minted_at`).

What a bridge would buy: entity pages (edition/player/set), shared analytics, concierge reachability, sets surfaces, badge plumbing.

What it would **not** buy, and the reason to be cautious:

- **Wallet/portfolio surfaces stay broken** — no address-keyed ownership (caveat 1), and 6% coverage (caveat 2).
- **CORRECTED 2026-07-19 — the `collections` row is NOT wrong, and this is NOT a go-live blocker.** An earlier draft of this doc called `panini_blockchain` (`chain=ethereum`, `is_active=false`, `contract_address` NULL) a stale row describing a *retired* plane, and asserted the WC Prizm data sits on a *private Sawtooth chain*. **Both claims were unsupported.** Our own verified research ([handoff-2026-06-25-panini-blockchain-buildout.md](../archive/handoffs/handoff-2026-06-25-panini-blockchain-buildout.md)) establishes that the runner's data IS the Panini Blockchain product — "2026 Panini Prizm FIFA World Cup" — the same product that row was created for (2026-06-08, five weeks before the first `panini_editions` row). ~~**Nothing in any RPC research names Sawtooth**; that was invented.~~

> ⛔ **THAT STRUCK SENTENCE IS ITSELF FALSE — corrected 2026-09-20 by grep, not by memory.** Three places in this repo name it, one of them marked *Verified*: [`docs/research/candy-panini-integration-research-2026-06-08.md`](../research/candy-panini-integration-research-2026-06-08.md) ("a **private/permissioned Hyperledger Sawtooth** chain … archived upstream"), [`docs/research/panini-prizm-wc2026-data-sourcing-2026-06-25.md`](../research/panini-prizm-wc2026-data-sourcing-2026-06-25.md) ("Panini Blockchain runs on private **Hyperledger Sawtooth**", listed under *Verified*), and `lib/collections.ts` in code. **So Sawtooth was researched, not invented.** This retraction over-corrected, and the false half propagated into `docs/health/PROJECT_HEALTH_2026-07-20.md` (frozen, left as-is) and back out again — the 2026-09-19 go-live doc re-asserted Sawtooth as fact, unaware it had been called a fabrication here.
>
> ⭐ **What survives, and it is the part that matters:** the *practical* conclusion below is correct and now measured rather than argued. `collections.chain` and the `collection_chains` view have **zero consumers** — 0 of 176 views/matviews, 0 `pg_proc` bodies, 0 code paths (2026-09-20). No `chain_type` value is needed and the DB row gates nothing. ⚠ **But "gates nothing" was over-read too:** the hardcoded `dbChain` in `lib/collections.ts` *did* gate a site-wide claim — see [panini-go-live-2026-09-19.md §5 gap 1](panini-go-live-2026-09-19.md).
>
> 📏 **The class: a correction has a shelf life, and an over-broad correction is re-corrected by the next reader who checks — usually by re-asserting the original error.** Retract the claim, not more than the claim. What IS true and worth recording: `chain=ethereum` describes the **BRIDGE** plane (opened 2026-03-30, OpenSea-exclusive, bridge contract `0x23ae7a05f598fc234ee9dbef04033080dea8ab19` on mainnet), not the native Panini platform the runner scrapes — and WC2026 may not be bridged at all. So the row records a real, discovered chain, just the secondary one, and **the native platform's chain identity is simply not established in our research.** Practical consequence: nothing in the bridge depends on `collections.chain`, no `chain_type` enum value is needed, and this does not gate anything. Open minor gap: `contract_address` is NULL even though we discovered the bridge contract — left unset deliberately, since it is ambiguous whether that row denotes the native plane or the bridge.
- **It multiplies the coverage-disclosure obligation.** Right now one gated board carries one honest disclosure. Bridging pushes listing-gated data into shared surfaces that have no notion of partial coverage — the entity pages, concierge answers and analytics would all silently inherit a 46%-complete index with no place to say so.

**Panini verdict:** the honest recommendation is **do not bridge yet**. Panini's data is good enough to be a strong *standalone* board set and too incomplete to be a trustworthy citizen of the shared plane. Bridge only if/when coverage stops being listing-gated — which per the 2b finding is a platform limit, not an engineering one.

---

## What to actually do, in order

1. **Nothing for Panini's plumbing.** Ship or hold the squeeze board on its merits (decision A2/A3 in `manual-steps-2026-07-19.md`). If shipped, the 5 built-but-unsurfaced boards (`deal` 148, `player` 567, `nation` 73, `special_serials` 1,086, `pack_ev` 2 rows) are cheap follow-ons using the squeeze page as a 3-file template — **but each needs the same coverage disclosure**, and `special_serials` is the worst offender since special serials live in the thin scarce tail.
2. **Candy: wait for the first sale.** Everything downstream is ordered behind it and the indexer captures it automatically.
3. **When Candy gets FMV, add the `CASE` arms in the same change** — otherwise the analytics surfaces will silently return nothing and look like an ingest bug.
4. **Do not build Candy route dirs before there is data to render.** Empty tabs are worse than an absent collection.

## What I deliberately did not do

- **Did not add `candy_mlb` to the shared analytics `CASE` arms.** It would surface an unpublished, `is_active=false` collection into analytics with zero data behind it, and could not be verified against real rows. It is queued to ship *with* the FMV work.
- **Did not bridge Panini.** Reasoning above — this is a strategy decision with a real honesty cost, not a refactor.
