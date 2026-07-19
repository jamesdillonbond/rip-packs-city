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
- **A `collections` row already exists and is wrong for this data**: `panini_blockchain`, `chain=ethereum`, `is_active=false` — that describes the *old OpenSea bridge plane*, not the private-Sawtooth WC Prizm data the runner actually collects. Bridging would first need a decision about whether that row represents this dataset or a new one is needed.
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
