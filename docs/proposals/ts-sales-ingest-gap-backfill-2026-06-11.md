# Plan (review-gated): close the TopShot ASK_ONLY sales-ingest gap

Status: **Phase 1 TRIED + REVERTED 2026-06-11 (failed its acceptance test). Phase 2 is the path.** This is a `sales`-table change that feeds fmv-recalc, so it is NOT auto-shippable. Discovered while reviewing the ASK_ONLY sanity-cap proposal — see `docs/proposals/ask-only-sanity-cap-2026-06-11.md` and memory `ask-only-is-a-sales-ingest-gap`.

---

## Phase 1 RESULT (2026-06-11) — DISPROVEN, reverted

Trevor green-lit Phase 1 with guards. Shipped `audit_20260611_promote_ask_only_acquisition_sales_v1` (185 rows / 134 editions, tagged `acq_promotion_v1`), then ran the acceptance test (LiveToken comparison on the matched subset) **before** green-lighting Phase 2 — and it **failed**:

| metric (41 matched editions) | old ASK_ONLY (ask×0.9) | new promoted WAP |
|---|---|---|
| median \|ratio−1\| vs LiveToken | **0.363** | 0.401 (worse) |
| severe-high (>4×) | 1 | 4 (worse) |

Recency-restricting to buys ≤180d did not help (n=8, abs-err 0.965 — worse still). **Root cause:** a single recorded *purchase* price (old peak-era buy, or one idiosyncratic deal/overpay) is **noisier** than the **current ask**, which already tracks the live-market consensus LiveToken reflects (old ASK_ONLY median ratio was 0.984 on these). So the premise "a real recorded buy beats a lone ask" is **disproven** for the measurable (liquid, ask-having) editions. **Reverted:** `DELETE FROM public.sales WHERE source='acq_promotion_v1';` (0 rows remain; production FMV input back to baseline). The guards worked (absolute $50k ceiling, no cohort-relative cut); the *data source* was the problem, not the mechanism.

**Implication:** `moment_acquisitions` (individual purchase prices) is NOT a usable FMV-improving source. Skip the acquisitions promotion entirely. Go straight to **Phase 2** — real *market sales* (consensus of many transactions, the same class of data LiveToken uses), gated on its own acceptance test.

---

## The problem (proven)

`ASK_ONLY` is, to first approximation, the bucket of TopShot editions whose real sales we never ingested — not a market-reality "troll-ask tail."

- LiveToken crosscheck (`audit_lt_matches`, 989 rows): editions LiveToken values but we have **0 sales** for — ASK_ONLY **68%** (115/169) vs LOW/MEDIUM/HIGH ~0%.
- Live TS ASK_ONLY: **785/1005 (78%)** have zero rows in `sales`.
- Concrete proof: Trevor's own Grant `103:3792` marketplace buys ($67 2024-09-01, $79 2025-07-03) live in `moment_acquisitions` but were never mirrored into `sales`; fmv-recalc saw 0 sales → fell back to ask×0.9 ASK_ONLY at a stale $99 ask.

Editions with captured sales price correctly (LOW/MEDIUM/HIGH). The fix is to feed the missing sales, not to cap the ask.

## Two-phase fix

### Phase 1 — Quick win: promote `moment_acquisitions` marketplace buys into `sales`

Sizing (live): ~**134** TS ASK_ONLY-with-0-sales editions have a `moment_acquisitions` row with `acquisition_method='marketplace' AND buy_price>0`; 243 have *some* acquisition record. Bridge `moment_acquisitions.nft_id → wallet_moments_cache.moment_id → edition_key → editions.id` (NOT via `moments`, which is empty for these illiquid editions).

This is bounded by what *tracked* wallets hold (wmc only covers our ~tracked population), so it's a partial recovery — but it's free, already-collected real purchase data, and a clean way to measure how far closing the gap moves ASK_ONLY before investing in Phase 2.

**`sales` schema facts (verified 2026-06-11):**
- NOT NULL: `edition_id`, `serial_number`, `price_usd`, `sold_at`, `collection` (default `nba_top_shot`), `collection_id` (default TS UUID).
- Year-partitioned by `sold_at` (sales_2020 … sales_2027 — 2024/2025 partitions exist, so old buys route fine).
- Dedup: `UNIQUE (transaction_hash, sold_at) WHERE transaction_hash IS NOT NULL` per partition → a synthetic unique `transaction_hash` makes the insert idempotent.

**Mapping `moment_acquisitions` → `sales` row:**
| sales col | source | note |
|---|---|---|
| `edition_id` | `editions.id` via the wmc bridge | required |
| `serial_number` | `wmc.serial_number` | required |
| `price_usd` | `ma.buy_price` | required; only `buy_price > 0` |
| `sold_at` | `ma.acquired_date` | routes the partition |
| `buyer_address` | `ma.wallet` | |
| `seller_address` | `ma.seller_address` | usually null |
| `nft_id` | `ma.nft_id` | |
| `transaction_hash` | `'acq:' || ma.nft_id || ':' || extract(epoch from ma.acquired_date)::bigint` | synthetic, unique, idempotent |
| `marketplace` | `'top_shot'` | |
| `source` | **`'acq_promotion_v1'`** | NEW distinct tag → trivially reversible |
| `currency` | `'USD'` | default |

**Guards (must all hold per row):** `acquisition_method='marketplace'`, `buy_price>0`, edition resolves to a canonical int-keyed TS edition, serial present, and NOT EXISTS a real `sales` row for that `(nft_id, sold_at)` already. Scope strictly to `collection_id = 95f28a17…` for v1.

**Implementation:** one-time guarded `INSERT … SELECT … ON CONFLICT DO NOTHING` migration (read-only dry-run first: SELECT the candidate rows and eyeball ~10 against dapper.market like we did for Clingan). Not a cron — it's a backfill. Reversible: `DELETE FROM sales WHERE source='acq_promotion_v1'`.

**Measurement harness (run before + 1 fmv-recalc sweep after):**
- TS ASK_ONLY count (latest-snapshot) — expect it to drop by up to ~134.
- For the promoted editions: confidence transition ASK_ONLY → LOW/SALES_ONLY/STALE (recency-appropriate; a 2024 buy correctly lands STALE/LOW, not HIGH).
- Re-run the `audit_lt_matches` ratio on the promoted set (needs a fresh LiveToken pull to be meaningful) — sanity that we didn't introduce a new bias.

### Phase 2 — Fuller historical backfill (only if Phase 1 proves out)

Our `sales` history is shallow for illiquid editions; LiveToken's is deep. To genuinely close the 785-edition gap, backfill real historical sales per ASK_ONLY edition from a deep source:
- **TS marketplace GQL** `searchMarketplaceTransactions` (already used in `lib/topshot-market-truth.ts` `probeRecentSales` — extend to walk full history per edition via the topshot-proxy; integer setID/playID → needs the UUID form the marketplace API wants, per the CLAUDE.md UUID-vs-int note). Highest-confidence (it's Top Shot's own ledger) but rate-limited → a paced per-edition backfill cron scoped to the ASK_ONLY set.
- **LiveToken activity feed** — already a `moment_acquisitions` source (`source='livetoken_activity'`); could be widened to a sales source, but is second-hand.

Phase 2 is a real ingest workstream (new cron + edition-set cursor + the UUID-resolution detail) — scope it after Phase 1 measures the ceiling of the free win.

## Decision Trevor must make before Phase 1 ships

**Decision A — source confidence.** `moment_acquisitions` rows being promoted carry `source IN ('browser_backfill','livetoken_activity')`. Are those `buy_price` values trustworthy enough to enter `sales` (which feeds FMV)? Spot-check says yes (Clingan's $2,100 matched dapper.market exactly; Grant's $67/$79 are plausible 2024-25 marketplace prices), but it's your call whether to:
- (a) promote all marketplace-method `buy_price>0` rows, or
- (b) promote only the higher-confidence subset (e.g. exclude `livetoken_activity`, or only `acquisition_confidence` ≥ some bar — column exists on `moment_acquisitions`), or
- (c) Phase-2-only (skip the acquisitions promotion entirely and backfill straight from TS GQL).

**Recommendation:** (a) with the strict guards above as a measured one-time backfill tagged `acq_promotion_v1` (fully reversible), *then* decide on Phase 2 based on how far it moves ASK_ONLY. Low blast radius (≤134 editions, all currently ask-only guesses), real data, instantly revertible, and it tells us the ceiling of the free win before we build a GQL backfill.

Revert (any phase): `DELETE FROM sales WHERE source='acq_promotion_v1';` (Phase 1) / drop the cron + cursor (Phase 2). fmv-recalc self-heals the affected editions on its next sweep.
