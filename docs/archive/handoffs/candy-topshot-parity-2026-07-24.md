# Candy ↔ Top Shot feature parity — assessment + build handoff

**Date:** 2026-07-24 · **Author:** Cowork · **For:** Claude Code (Trevor's machine) · **Repo HEAD:** verify with `git rev-parse HEAD`.

**Green-lit scope (2026-07-24, Trevor): ALL of Items A–E** — the listings indexer (A) + the deals family (A2), special-serials + scarcity/sealed (B/C), holder-concentration + player (D), and parallel-premium (E, staged now despite thin Rainbow FMV — Trevor's explicit call, against the hold recommendation). Build in the order below; everything stays behind the gated `/insights/candy*` wall + `is_active=false`.

## TL;DR

Candy now has the data spine RPC's intelligence layer needs: 125 editions (player / team / tier / Rainbow-colour), 25,375 clean on-chain serials, ownership via `wallet_moments_cache` across 247 wallets, 54+ Magic Eden sales, a bid book, and FMV (46/125, LOW). A solid slice of the Top Shot feature set is portable **now** as aggregation boards — **no new pricing engine required**. **One structural gap governs the rest:** Candy has **no ask/listing feed** — only bids (`candy_offers`). Every listing table in the DB (`ts_listings`, `topshot_active_listings`, `topshot_offer_ask_spread`, `cached_listings*`, `pinnacle_*`) is Flow/Pinnacle. So the **deals / sniper / offer-spread family — RPC's signature — is blocked until a `candy-listings-indexer` exists.** Everything user-facing stays behind the gated `/insights/candy-*` wall + `candy_mlb.is_active=false` until the go-live flip.

All figures below were verified live against Supabase `bxcqstmqfzmuolpuynti` (collection_id `209ade70-32c5-4470-bc7c-4793d660f713`) on 2026-07-24.

## Parity matrix

### A. Ship-now — data verified, aggregation only (no new pricing)

| Board | Top Shot analog | Candy data | Verified today |
|---|---|---|---|
| **Special serials** (#1 / last-mint / low-serial owners) | `special_serial_owners_board` (wmc-backed; AllDay shipped 07-06) | `serial_number` + wmc owners | **125 #1s, 125 last-mints, 375 serials ≤ #3**, all 125 editions covered. ⚠ **jersey-match N/A** — `jersey_number` is null for Candy players |
| **Scarcity / sealed-vs-circulating** (squeeze analog) | `squeeze` / `allday-scarcity` / `pinnacle-scarcity` | wmc + treasury wallet | Treasury `BhA2Bfd8…` holds **18,684 / 25,375** serials → only **26.4% circulating** (6,691) across **246** real holders. Per-edition circulating-% = the squeeze ranking |
| **Holder concentration / cohort** | `new-collectors` / cohort | wmc | Top collector 165 serials / 82 editions; steep long tail; treasury cleanly separable |
| **Player board** (per-athlete rollup) | `panini_player_board` | `player_name` / `team_name` on every edition | present |
| **Top sales** | `top-sales` | `sales` | 54 sales live (may already accept any collection — CC check) |
| **Market pulse** (volume / movers) | `market-pulse` | `sales` | live |
| **Parallel (Rainbow-colour) premiums** | `parallel-premiums` | `badges` carry the colour (`["Rainbow (Blue)"]`, Green, Pink, …), `tier` | Rainbow avg FMV **$170** vs Core **$6** (~28×). **Thin (2/25 Rainbows priced), grows.** Premium multiple = pricing-flavored → your call per `fmv-pipeline-patch-restraint` |

**Recommended packaging:** add these as **sections on the existing `/insights/candy-mlb` board** (+ a few backing views) rather than spawning N new routes — mirrors how Panini put squeeze / pack-reality / deals / player boards on one surface. Lighter to build, one gate to manage.

### B. Needs `candy-listings-indexer` first (new pipeline → then these unlock)

| Board | Top Shot analog | Blocker |
|---|---|---|
| **Deals / underpriced** (ask < FMV) — RPC's signature | `deals` / `underpriced-serials` | no ask feed |
| **Offer-spread** (bid ↔ ask) | `offer-spread` / `topshot_offer_ask_spread` | no ask feed |
| **Pack-sniper / floor-ask** | `pack-sniper` | no ask feed |
| **Market floor / ask display** | `market` | no ask feed |

Unlock = **Item A below**: a `candy-listings-indexer` off Magic Eden `/v2/collections/{symbol}/listings` (symbol `2026_mlb_base_series_icons_candy_digital`), mirroring `app/api/candy-sales-indexer/route.ts`, landing a `candy_listings` table + per-edition floor. After that, deals / spread / sniper are all aggregation boards (ask vs the FMV we already have).

### C. Gated / not applicable

- **Jersey-match specials** — Candy players have no `jersey_number` (N/A, not just missing).
- **Rookies board** — no rookie flag on editions; needs an external RC mapping (defer).
- **Play-based** (game date, play type, first-mint timing) — N/A; Candy ICONs are player cards, `play_*`/`game_date`/`first_minted_at` all null.
- **Trophy case / user profile / concierge-Candy** — gated on the Candy-aware wallet resolver (June handoff Items 4/5/7) + go-live.
- **Badges image pipeline** — text badges exist; the rendered-image pipeline is a big lift, defer.
- **Set-completers / cross-collection** — single set; cross-collection needs Candy in the shared plane (`is_active`).
- **Serial-position FMV power-law** — too thin now; revisit at volume.

---

## Build items (priority order)

> Precedents cited are verified to exist on disk (2026-07-24). **Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.** Confirm each precedent view's exact columns and the `/insights/candy-mlb` page structure before mirroring.

### Item A — `candy-listings-indexer` (unlocks the entire deals/sniper family) — route/worker, CC; TIME-SENSITIVE if wanted around Drop 3 (07-29)

- **New:** `app/api/candy-listings-indexer/route.ts` (mirror `app/api/candy-sales-indexer/route.ts`), reading Magic Eden `GET /v2/collections/2026_mlb_base_series_icons_candy_digital/listings` (public, paginated). Land a `candy_listings` table (mint, edition_id, seller, price_sol, price_usd via the same `sol_usd` the sales indexer uses, listed_at, is_active) + a per-edition floor rollup, keyed to editions like `candy_offers`.
- **Cron:** add a `pipeline_cadence_watchlist` row + a Vercel cron slot (stagger off :00/:20/:40 per `docs/operations/cron-schedule.md`), same cadence class as `candy-sales-indexer` (~every 3h).
- **Migration:** `candy_listings` table — RLS on, `REVOKE … FROM anon, authenticated`, verify with `has_table_privilege` (route-gating ≠ data-gating).
- **Revert:** drop the table + cron row + `git revert` the route commit.

### Item A2 — deals / offer-spread / floor boards (sit on the Item A feed) — views + `/insights/candy-mlb` sections, CC

Once `candy_listings` exists these are pure aggregation over listings × the FMV we already have — no new pricing:
- **`candy_deals_board`** (mirror `deals` / `underpriced-serials`): active listings priced below FMV, ranked by discount = `1 − ask/FMV`; restrict to FMV-backed editions (46/125 today, grows), min-$ threshold to cut dust. RPC's signature surface.
- **`candy_offer_spread_board`** (mirror `topshot_offer_ask_spread`): per edition, best bid (`candy_best_offers`) vs floor ask (Item A) → spread; flags liquid vs wide-spread editions.
- **Floor / market**: per-edition floor ask on the secondary board + a small market view (floor, 24h volume, movers).
- All `security_invoker`, anon/authenticated REVOKED, gated. **Note the illiquidity caveat** — with ~1 sale/edition, "deals" are indicative until depth builds; label accordingly.
- **Revert:** drop views + `git revert`.

### Item B — Candy special-serials board — view + `/insights/candy-mlb` section, CC

- **View** `candy_special_serials_board` (mirror `special_serial_owners_board`): per special serial — edition, player, tier, serial, kind (`first_mint` #1 / `last_mint` serial==circ / `low_serial` ≤3), owner wallet (from wmc), latest FMV, last sale. `security_invoker`, anon/authenticated REVOKED.
- **Verified feasible:** 125 #1s + 125 last-mints + 375 ≤#3 across all editions. Frame around **#1 + serial-position rarity** (Candy's honest analog); jersey/perfect-count don't exist here.
- **Revert:** drop view + `git revert`.

### Item C — Candy scarcity / sealed-vs-circulating board — view + section, CC

- **View** `candy_scarcity_board` (mirror `pinnacle-scarcity` / `allday-scarcity`): per edition — circulation_count, sealed count (treasury-held), circulating count, **circulating_% = circulating / circulation**, holders, latest FMV. Exclude the treasury wallet (the max-holder; `BhA2Bfd8…` today, but compute it dynamically — don't hardcode). Lowest circulating-% = most squeezed.
- **Verified feasible:** 26.4% circulating overall (18,684 sealed / 6,691 out); per-edition breakdown is the board.
- **Revert:** drop view + `git revert`.

### Item D — Candy holder-concentration / cohort board — view + section, CC

- **View** `candy_holder_board`: per non-treasury wallet — serials held, distinct editions, est. portfolio FMV, top holding; plus a concentration summary (treasury % vs collector %). Mirror the `new-collectors` / cohort pattern.
- **Verified feasible:** 246 holders, clean treasury separation.
- **Revert:** drop view + `git revert`.

### Item E — parallel-premium + player board — pricing-flavored, YOUR CALL

- **Rainbow-colour premium** (Core vs each Rainbow colour multiple) mirrors `parallel-premiums` + the Panini serial-premium work. Data is present (`badges` colour + tier), but pricing multiples on 2/25 priced Rainbows are not yet meaningful — **hold until Rainbow coverage fills** (Drop 3 + time). Player board (`candy_player_board`, mirror `panini_player_board`) is safe aggregation and can ship with B–D.
- **Revert:** drop views + `git revert`.

---

## Guardrails (repeat every handoff)

- Direct to `main`. No branches, no PRs. If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** (Git Bash `git commit` can silently no-op). Re-verify: `git rev-list --count origin/main..HEAD` (expect 0).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`. Vercel `maxDuration` cap 800s.
- CRLF: full-file writes, not string-replace patches.
- New views/tables: `REVOKE … FROM anon, authenticated` + `has_table_privilege` verify; keep everything behind the existing `/insights/candy*` proxy wall + `noindex`; `candy_mlb` stays `is_active=false`.
- Log every main/prod change to `docs/overnight/ledger.md` (newest-at-top, re-read from disk immediately before writing) with its revert path.
- Verify pages by rendered DOM, not HTTP 200. `npx tsc --noEmit` clean + Vercel READY before any item is "done."
- No `docs/FREEZE.md` needed (additive + gated). No collision with the last 24–48h (Candy work to date is ingest + the 07-24 board/pack-EV ship).

## Expected end state

`candy-listings-indexer` live + secured (Item A) → deals/spread/sniper unblocked; Candy special-serials, scarcity/sealed, holder-concentration (+ player) boards live as gated `/insights/candy-mlb` sections (Items B–D); parallel-premium held until Rainbow FMV fills (Item E). `candy_mlb` still `is_active=false`; all behind the gate; each change ledgered with a revert path. This brings Candy to rough parity with the Top Shot insights surface for everything the current data honestly supports.
