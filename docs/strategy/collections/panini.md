# Panini Blockchain — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file). Older plan: [panini-roadmap-2026-07-16.md](../panini-roadmap-2026-07-16.md).

## Where it stands

Live reads ~6:00 PM PT 10-17 unless marked otherwise.

- **Published, but not `is_active`.** The registry (`lib/collections.ts`) has `published: true` and 7 tabs (overview, market, collection, packs, sets, sniper, analytics), with `dbChain: null`. The DB row `collections.panini_blockchain` still reads `is_active=false` and `chain='ethereum'`. `false` is a decision (#64), and so is the registry/DB chain split (registry corrected 09-20, see [schema-truth.md](../../reference/schema-truth.md)). `sales` holds **0** Panini rows in the last 30 d, which is why #64 keeps the flag off.
- **Catalogue:** 34,790 editions, 154 products. **0 editions are last-seen more than 6 d ago** (the 10-10 7-day line holds). The latest snapshot per edition is p50 61 h old, p90 98 h.
- **Accuracy (the gate):** the `panini_fmv_high_med_share_pct` leg exists **only since 10-14 ~8 PM PT** (`20261015025957`). Before that, Panini's confidence share had no instrument at all ([roadmap-status.md](../../reference/roadmap-status.md), 09-20 block). Daily means: 23.8 (10-14) · 24.8 · 28.0 · **31.8 (10-17)**. The rise is the `panini-1.3.0` re-grade working through the catalogue. No pricing changed.
  - Re-graded so far (1.3.0): 17,235 of 34,790 editions, of which HIGH 7,698, MEDIUM 485, LOW 8,239.
  - Not yet re-graded (1.2.0): 17,554, with HIGH+MEDIUM at about 17 %.
  - 1 stray `panini-1.0.0` row remains.
- **The published-FMV backtest has almost no 1.3.0 rows yet** (re-read 7:20 PM PT 10-17: n = 1). Read again ~10-24, once a week of sales has landed past the ~4-day sale lag. `panini_published_fmv_backtest` scores 1.2.0 only (45 d window, covered editions): HIGH 67.7 %, MEDIUM 44.5 %, LOW 55.9 % within ±25 %. Panini sales reach the DB days after `sold_at`, so no 1.3.0 snapshot has met its next sale. On sales sold 10-03..10-10 the lag was p50 98 h and p90 223 h. The earlier "53 h" figure came from a different sample.
- **Pipelines (48 h):** `panini-ingest` 10,090/10,090 ok; bridge, products bridge, squeeze MV, pack-EV, sales-analytics and THP legs all 100 % ok. `panini-collector-walk` 20/21 ok (R131, resolved 10-15).
- **Packs:** 351 packs on the board, 28 modelled. **2 show a positive net rip edge**, both 2026 WC Soccer: FOTL +$25 on $209 (the typical pull is $38) and the guaranteed-contents pack +$8. The 10-10 handoff's "0 positive" is stale. Both edges are mean-EV, carried by the tail.
- **Demand:** Google brings anonymous visitors to Panini edition pages, mostly `packcard-…` card editions. Raw `usage_events`: 13 visits (10-08..14), 14 visits (10-15..17). The 10-14 username band has 3 `wallet_paste` events in `funnel_events` (not split internal vs external).

## Shipped recently (since mid-September)

- **09-19..09-24** — The walk goes stalest-first ([panini-go-live-2026-09-19.md](../panini-go-live-2026-09-19.md)). The runner reads RECENT sales. FMV `panini-1.1.0` was backfilled over 5,093 editions (09-24). The Sentinel got a Panini arm. The team-walk rotation runs on the laptop.
- **09-25** — **Published** (Overview + Market) on the shared routes (#64). The FMV write became insert-then-supersede.
- **09-27..09-28** — Entity pages (edition/player/set), the Collection tab by username plus the collector walk, Sets, Packs and Sniper tabs, card art, the trophy case, and the per-product pricing bridge ([panini-multi-product-2026-09-28.md](../panini-multi-product-2026-09-28.md)).
- **09-29** — `Common` rarity mapped to the COMMON tier ([handoff](../../handoff-2026-09-29-panini-common-tier-map.md)). Fixed a phantom Silver card in the WC pack EV. WNBA packs captured.
- **09-30 (week-one review)** — Found LOW priced ~1.7–2.3× high, plus duplicate same-batch rows. Shipped `panini-1.2.0` (LOW = median of the last ≤3 sales), one row per edition per batch, and the `panini_published_fmv_backtest` instrument. Admitted 2420 WNBA.
- **10-02..10-04** — Tier-1 product admission, a 2-hour run cadence, secondary-market packs, the stall watchdog, and the board covering indexes (deal board 23.8 s → 0.99 s). A delisted ask retires its price (NO_DATA).
- **10-09..10-10** — Walk-order truncation fixed (`01776cd21`). Every surface went all-product: Tier 2, NASCAR, and the 9 pack-bearing products were admitted. Shipped `/insights/panini-premiums`, the guaranteed-contents pack EV (job 723), and aged-edition safety rails.
- **10-14** — Shipped the FMV-share THP leg and a public accuracy row on `/legal/fmv-methodology`. Search now returns Panini players, cards and sets (`20261015042434`, `…052846`; #64 addendum). Also: username band, `panini-publish-routes` guard, SEO pass (sitemap shards 5–8) and copy fixes.
- **10-15** — **FMV engine `panini-1.3.0`** grades confidence by spread; prices are unchanged and `PANINI_FMV_ENGINE=1.2` is the kill switch (`20261015133349`, verified 7:35 AM PT). Also: rotation-targets index (36 s → 157 ms), squeeze MV hourly, the "shown under another owner" exclusion (`20261015185129`), R131 fix.
- **10-17** — The freshness-check routine prompt had fallen 13 days behind its source file; it is re-synced (ledger 10-17, [cowork afternoon handoff](../../handoff-2026-10-17-cowork-afternoon-pass.md)).

## Open issues

- **#64 (closed, with a residue by design):** the smoke, readiness, market-summary and wallet-stats rollups have no Panini arm. `is_active` stays `false` until Panini sales land in `sales` or those four get a Panini arm.
- **#58 (shelved):** there is no `OPENSEA_API_KEY`, so the OpenSea bridge is monitor-only. The WC Prizm plane is the collection (decided 09-06).
- **#66 (partial):** the SEO Search Console re-read is due **10-28**. Panini edition pages are the main organic landing.
- **Sale-ingest latency** is the real accuracy lever (10-14 review). It is bound to the laptop runner's walk age, so it is not an estimator problem.
- **ASK_ONLY** (760 + 864 editions) is the least accurate class: 30 % within ±25 %, median ratio 1.5. The cap was measured and refuted (10-10). An outlier cap is waiting on ≥ 50 big-ask sales.
- **WC-only on purpose:** `/insights/panini-squeeze` and `panini_coverage_summary`.

## Next — prioritized

**Now**
1. **Read 1.3.0 against real sales once the backtest has rows.** *Why:* 1.3.0 MEDIUM is rare (485 against 7,698 HIGH), which is not the mix the proposal sized. HIGH now carries most of the share. *Falsifier:* 1.3.0 HIGH within-25 % below ~65 %, or the grades not ordered HIGH > MEDIUM > LOW. If so, roll back with `PANINI_FMV_ENGINE=1.2`. *Gate:* about 10-20, once the ~4-day sale lag clears.
2. ⚠ **READ 2026-10-18 ~9:55 AM PT (Claude Code cloud): the re-grade will NOT finish on its own by ~10-19 — the WC rotation has slowed ~2.5×.** Latest snapshots: 21,019 on `panini-1.3.0` (46.4 % HIGH/MED), **14,626 still on `panini-1.2.0`** (14.6 %), incl. **2,630 World Cup** editions. FMV is written only for cards in an ingest batch, and those 14,626 have not been walked since ~10-14 (0 seen in 24 h; `last_seen_at` == FMV time for every edition, so the writer is not lagging — the walk is). Cause: the walk set is now **35,646 pskus across every product**, "stalest-first, interleaved" (`panini-ingest-enum` 8:03 AM PT), so WC `edition_age_p50_h` rose from ~30 h (10-14) to **77 h** (p90 106 h). The page's coverage note renders those live ages, so no surface overstates freshness. **Lever (Trevor's call, runner on his box):** weight WC — the only modeled product — ahead of the other 30k pskus in `scripts/ingest-panini-runner.mjs`'s walk order (e.g. walk WC stalest-first first each pass, then interleave the rest), or accept ~3-day WC ages. Until then, read the share per engine, never the blended leg.
   - (original item) **Let the re-grade finish, then read the share.** *Why:* the leg's mean blends two engines. *Gate:* about 10-19, when 0 rows are still on `panini-1.2.0`. Sized ~42 % on 10-14; the 1.3.0 subset reads ~47 %, but it is a walk-order sample.
3. **Run the 10-22 demand re-read** (roadmap-status 10-15 block). *Why:* the Panini band and the Google one-page share are the baselines. *Falsifier:* band lookups reach no Collection view.

**Next**
4. ✅ **RE-MEASURED 2026-10-18 ~8:00 AM PT (Claude Code cloud; 40,000 simulated packs from the model's own odds and remaining-pool weights, reproducing the board means 138/234): no +EV claim survives the typical-pull gate.**

   | pack | price | mean EV | median pack | P(pull ≥ price) | EV from LOW + ASK_ONLY |
   |---|---:|---:|---:|---:|---:|
   | 1038 WC Hobby | $135 | $138 (+3) | $18 | 12.7 % | 76.6 % (ASK_ONLY 12.5 %) |
   | 1039 WC FOTL | $209 | $234 (+25) | $53 | 17.7 % | 73.8 % (ASK_ONLY 16.7 %) |
   | 1043 WC White Sparkle /8 | $214 | $221.51 (+8) | $10 | 9.1–12.2 % | sale-based |
   | 1056 / 1055 WNBA | $27 / $74 | $17 / $40 | — | moot (negative mean) | sales model |

   HIGH+MEDIUM-only EV: Hobby $32, FOTL $61. **Four LOW chase editions (10 copies, priced from July–August sales: Messi Gold $65k, Messi White Sparkle $25k, Yamal Zebra $17.5k, Ronaldo Gold $16k) add ~$33/pack; without them both edges go negative.** 1043's single $25k Messi sale carries 61 % of its mean and leaves the 90-day window ~10-23. Compared with 09-24/09-29, means are down 4–9 % and typical pulls are flat: the 1.2.0 LOW repricing did not remove the tail, because those last sales ARE the chase sales. **Shipped same pass:** the Pack Market's mean tile no longer shows a positive "vs cost" edge alone (it adds "on the mean only · typical pull −$X" when the typical pull is under cost), and the page note's false "priced from real sales, not asks" sentence is corrected (`panini_pack_ev_model` takes each card's latest FMV with no confidence filter). **FOTL supply mismatch EXPLAINED and GATED 2026-10-18 ~8:55 AM PT (`20261018155404`):** `packs_remaining` (1,416) is right; Σ`still_in_packs` (740) is a FLOOR — only 1,004 of the 1,996 expected FOTL-exclusive editions (499 players × 4) are indexed, because Panini exposes a card only once it is listed. Every other family is fully covered (Silver 101 %, base parallel 105 %, insert 95 % of expected in-pack supply). The missing exclusives skew cheap (Red FMV mean $3.21 vs $6.19), so the leg's $96 mean was biased UP and the +$25 FOTL edge unsupported. `panini_pack_ev_board` now withholds 1039's EV, legs and edge (`ev_modeled=false`, note states "740 of the 1416") while exclusive coverage < 90 %; the Hobby row no longer carries the FOTL-only `fotl_exclusive_ev`. **Still open:** feed the uncovered FOTL pskus (499-player checklist × 4 parallel names) to the runner's priority walk to close the gap; add a simulated median pack and P(profit) to the board. Gate unchanged: no "+EV" copy unless P(profit) ≥ 50 %.
   - (original item) **Re-measure the pack EV with the LOW tier repriced.** *Why:* the 09-30 decision asked for a pack-EV re-measure at the "10-07 review". No dated 10-07 re-measure appears in the ledger; the 10-14 review re-measured FMV labels, not pack EV. The 2 positive WC edges are mean-driven. *Gate:* a typical-pull check before any "+EV" copy.
5. **Add a Panini arm to one #64 rollup (wallet stats or readiness).** *Why:* this is the path to `is_active`. *Gate:* the arm must produce real rows, never zeros. Keep the flag off until all four pass.
   - ⚠ **Design constraint, measured 2026-10-18 ~8:00 AM PT (Claude Code cloud): do NOT copy readiness's Pinnacle arm.** That arm counts `sold_at > now() - 24 h`. Panini sales land in `panini_sales` a median **12–160 h after `sold_at`**, depending on the day (10-06 → 10-17; it is the laptop runner's walk age). So a 24 h `sold_at` probe reads 7 rows on a day the market settles at ~400–2,700. `/api/ready`'s `thin_volume` drives the Market tab's thin-volume notice, so that arm would publish a **false "thin volume"** on Panini every day. A readiness arm must count by `first_seen_at` (indexed: today `panini_sales` has indexes on `sold_at` and `(edition_external_id, sold_at)` only, so add one) or disclose the lag. `last_sale_at` = `max(sold_at)` stays honest either way. Same caution for `analytics_smoke_run` freshness.

**Later**
6. **Ingest latency.** Options are a runner change on Trevor's box or infra (held: no spend before revenue).
7. **Re-open the serials-vs-`panini_sales` FMV input** once covered n is materially larger or the 09-30 tie breaks.
8. **External links / outreach.** Held by the accuracy gate (#66). No paid tier until 100 WAU.

## Decisions on record (do not re-litigate)

- **09-06:** WC Prizm plane = the collection; the OpenSea bridge is monitor-only (#64, chain-strategy).
- **09-25:** published via the registry; `is_active=false` (#64).
- **09-30 (Trevor):** keep serials as the HIGH/MEDIUM input; LOW → `panini-1.2.0` ([roadmap-status.md](../../reference/roadmap-status.md)). The earlier `[SUPERSEDED]` blocks there are stale; the first blocks are current.
- **10-10:** no LOW→MEDIUM promotion for 31–90-day sales; no Panini Market Pulse row (sale lag); no "Either A or B" pack parser arm; no ASK_ONLY family cap ([methodology](../panini-fmv-packev-methodology.md)).
- **10-14:** the between-walk repricer was refuted (gate on `first_seen_at`, not `sold_at`).
- **10-15:** `panini-1.3.0` spread grading shipped (Trevor: "Do what makes sense"). Public per-edition confidence chips stay banned.
- **Product rules:** read-only; accuracy is the gate; no paid tier until 100 WAU; no infra spend before revenue.

## Needs Trevor

- **`OPENSEA_API_KEY` (#58):** only Trevor can create the account and secret.
- **The runner box:** Panini ingest runs from his logged-in residential PC. Box pulls, wake/schedule health and any latency change all go through him.
- **Any ingest-latency spend** (a hosted browser or residential proxy) is a pre-revenue spend decision.

## Where the detail lives

- Plans and threads: [go-live 09-19](../panini-go-live-2026-09-19.md) · [multi-product 09-28](../panini-multi-product-2026-09-28.md) (start at the 10-10 HANDOFF) · [FMV & pack-EV methodology](../panini-fmv-packev-methodology.md)
- Rules: [chain-strategy.md § Panini](../../reference/chain-strategy.md) · [schema-truth.md](../../reference/schema-truth.md) ("Panini plane") · [roadmap-status.md](../../reference/roadmap-status.md) (Panini FMV decisions, 10-14 review, 10-15 demand read)
- History: [ledger](../../overnight/ledger.md) · [sessions 2026-10](../../sessions/2026-10.md)
- Instruments: `rpc_trust_health_history` · `panini_published_fmv_backtest` · `panini_pack_ev_board` · `pipeline_runs`
