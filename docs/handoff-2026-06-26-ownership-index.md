# Handoff — TopShot ownership index (2026-06-26)

Trevor greenlit BOTH approaches (Dune + on-chain walk). This unlocks the two marquee rookie-tracker features RPC currently can't do: **per-player collector leaderboards (#1)** and **set completers (#4)**. Both are blocked by the same gap — RPC has no complete on-chain ownership graph (measured: Cooper Flagg "Rookie Debut" = 1,149 circulating, RPC knows 8 owners; `wallet_moments_cache` = ~241 tracked wallets; `moments.owner_address` is shallow last-trade-owner).

This is a Claude Code + worker + operator build (Cowork can't push worker/route code). Cowork has shipped the **shared destination contract** so both writers and both read-surfaces agree on one schema.

## Shipped by Cowork (live)
`public.topshot_ownership` — canonical current ownership, one row per held NFT. Migration `audit_20260626_topshot_ownership_contract_table` (+ `_revoke_anon_select`). RLS on, service_role only, not in the anon API.

```
nft_id              text PRIMARY KEY     -- flow NFT / moment id
edition_external_id text NOT NULL        -- joins editions.external_id (setID:playID or ::subID)
owner_address       text NOT NULL
serial_number       integer
source              text NOT NULL        -- 'dune' | 'onchain_walk'
observed_at         timestamptz NOT NULL DEFAULT now()
```
Indexes: `(edition_external_id)`, `(owner_address)`. Upsert on `nft_id`. **Revert:** `DROP TABLE public.topshot_ownership;`

---

## Pipeline A — Dune (fast parity, `source='dune'`)
The tracker pulls TopShot on-chain ownership from Dune (observed queryIds 6397249 + 6775165 in its `/api/dune` calls — use as reference, write our own). Build:
1. A Dune query returning current ownership: `nft_id, set_id, play_id, sub_edition_id, owner_address, serial_number`. Derive `edition_external_id = set_id:play_id` (append `::sub_edition_id` when >0).
2. A `dune-proxy` Cloudflare Worker (own auth secret `DUNE_PROXY_SECRET` + `DUNE_API_KEY` — never share `TS_PROXY_SECRET`; see the 3-rotation-domain note in CLAUDE.md) fronting the Dune Query Results API. Mirrors the existing worker pattern.
3. A route `/api/cron/sync-topshot-ownership-dune` (Bearer INGEST/CRON) that pages the result and **upserts into `topshot_ownership`** (`onConflict: nft_id`, `source='dune'`). `after()`-wrapped, logs `pipeline_runs` (`pipeline='ownership-sync-dune'`). Cron daily (operator, cron-job.org, off the :00 rush).
4. Cost: Dune free/Plus tier — confirm row volume (~300k+ TS NFTs) fits the plan before committing. This is the cost-flat decision point.

## Pipeline B — on-chain owner walk (fully owned, `source='onchain_walk'`)
No external dependency; extend RPC's own machinery. Heavier compute.
1. Walk ownership via Flow Cadence reads through `topshot-proxy` (and `spork-proxy` for historical if needed) — the same path `snapshot-institutional-wallets` and the wallet-backfill routes already use, but across the whole owner set rather than tracked wallets. Practical approach: enumerate moment IDs (RPC already has `moment-ids` coverage) and resolve current owner per moment, or walk per-edition holder lists where the contract exposes them.
2. Writes the same `topshot_ownership` rows with `source='onchain_walk'`. Chunked + budgeted like the existing paginated backfills (`runPaginatedDetailsBackfill`), `maxDuration<=800`, logs `pipeline_runs`.
3. Cron lower-frequency (weekly/daily) — it's the source-of-truth refresh; Dune is the fast daily top-up.

## Reconciliation
Both write the same PK (`nft_id`), so they naturally converge — last writer wins per NFT, `observed_at` records freshness, `source` records origin. If both run, suggested precedence: on-chain walk is authoritative; Dune fills the gaps between walks. No separate merge step needed (upsert on `nft_id`).

---

## Read surfaces — apply once `topshot_ownership` is populated + verified (ready-to-run SQL)

### #1 Collector leaderboard MV (re-keyed from the dropped 2026-06-26 build)
```sql
CREATE MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv AS
WITH rookie_eds AS (
  SELECT e.external_id, e.player_name, e.id AS edition_id
  FROM public.editions e
  JOIN public.topshot_2025_rookie_players rp ON rp.player_name = e.player_name
  WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
),
ed_val AS (
  SELECT re.external_id, re.player_name,
    COALESCE((SELECT fs.fmv_usd FROM public.fmv_snapshots fs
              WHERE fs.edition_id=re.edition_id ORDER BY fs.computed_at DESC LIMIT 1),0) AS unit_fmv
  FROM rookie_eds re
),
h AS (
  SELECT ev.player_name, o.owner_address AS wallet_address,
    count(*) AS moments_held, round(sum(ev.unit_fmv),2) AS est_value_usd
  FROM public.topshot_ownership o
  JOIN ed_val ev ON ev.external_id = o.edition_external_id
  GROUP BY ev.player_name, o.owner_address
)
SELECT player_name, wallet_address, moments_held, est_value_usd,
  rank() OVER (PARTITION BY player_name ORDER BY est_value_usd DESC, moments_held DESC) AS rnk
FROM h;
CREATE UNIQUE INDEX ix_rclb_pk ON public.topshot_rookie_collector_leaderboard_mv (player_name, wallet_address);
CREATE INDEX ix_rclb_rank ON public.topshot_rookie_collector_leaderboard_mv (player_name, rnk);
GRANT SELECT ON public.topshot_rookie_collector_leaderboard_mv TO service_role;
-- pg_cron: SELECT cron.schedule('rpc-refresh-rookie-collector-lb','17 3,9,15,21 * * *','REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_rookie_collector_leaderboard_mv');
```
Score = `est_value_usd` (sum of latest per-edition FMV across held moments) + `moments_held`. Resolve `wallet_address`→username at render time (RPC already does this via `getUserProfile`). **Do not ship until `topshot_ownership` is populated** — on shallow data it ranks a "top collector" at 6 moments (the reason the first build was dropped).

### #4 Set completers MV (base-play completion, population-wide)
```sql
CREATE MATERIALIZED VIEW public.topshot_set_completers_mv AS
WITH base_eds AS (
  SELECT e.set_id, e.set_name, e.external_id
  FROM public.editions e
  WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.external_id ~ '^[0-9]+:[0-9]+$'          -- base plays only; drop parallels
),
set_totals AS (
  SELECT set_id, set_name, count(DISTINCT external_id) AS total_plays FROM base_eds GROUP BY set_id, set_name
),
owner_set AS (
  SELECT be.set_id, o.owner_address, count(DISTINCT be.external_id) AS owned_plays
  FROM public.topshot_ownership o JOIN base_eds be ON be.external_id = o.edition_external_id
  GROUP BY be.set_id, o.owner_address
)
SELECT st.set_id, st.set_name, st.total_plays,
  count(*) FILTER (WHERE os.owned_plays >= st.total_plays) AS completers,
  count(os.owner_address) AS holders_with_any
FROM set_totals st LEFT JOIN owner_set os ON os.set_id = st.set_id
GROUP BY st.set_id, st.set_name, st.total_plays;
```
**Completion definition decision (Trevor):** this uses **base-play** completion (own ≥1 of each play, ignoring parallels) — matches the tracker's counts. RPC's existing `check_set_completion(wallet)` is STRICTER (requires every parallel `::` too). Pick one and keep both consistent. The completion **over-time curve** the tracker shows needs ownership history — defer until `topshot_ownership` has accumulated daily snapshots (or add a `topshot_ownership_daily` snapshot table fed by the same cron).

---

## Frontends (after the MVs land; run the rpc-insights-qa gate)
- Collector leaderboard: a "Top Collectors" panel on each rookie/player surface, top-N by `rnk`, username-resolved, movement deltas once 2+ snapshots exist. Label honestly: "based on indexed ownership, refreshed daily."
- Set completers: a board of rookie sets with `completers` / `total_plays` + (later) the completion curve.

## Suggested sequence
1. Pipeline A (Dune) first — fastest to populate `topshot_ownership` and light up both features. Confirm Dune plan/row-cost before building (cost-flat gate).
2. Verify population (e.g., Cooper Flagg Rookie Debut owners ≈ its circulating supply, not 8), then apply the two MVs + crons.
3. Pipeline B (on-chain walk) as the owned source-of-truth refresh.
4. Build the two frontends.

---

## Pipeline A — Dune go-config (rookie scope + incremental; sized 2026-06-26)

Scope the Dune query to the **9 rookie setIDs** so it returns ~92k rows, not all-TopShot (~300k+). Rookie cohort = 92,182 NFTs:

| setID | set | NFTs |
|---|---|---|
| 219 | Rookie Debut | 77,341 |
| 223 | Origins | 5,685 |
| 238 | Freshman Gems | 5,365 |
| 233 | Metallic Gold LE | 1,990 |
| 243 | Rookie Revelation | 1,165 |
| 246 | 2026 Playoff Premieres | 562 |
| 261 | 2026 NBA Finals | 35 |
| 220 | 2025 Rookie Ultimates | 24 |
| 241 | Signature Series | 15 |

setID filter list: `219, 220, 223, 233, 238, 241, 243, 246, 261`. Re-derive each season as new rookie sets drop: `SELECT DISTINCT set_id_onchain FROM editions WHERE player_name IN (SELECT player_name FROM topshot_2025_rookie_players) AND set_id_onchain IS NOT NULL;`

**Cost-flat config (recommended):**
- **Bootstrap:** one full ownership pull for those setIDs (~92k rows) → seed `topshot_ownership`.
- **Steady-state: INCREMENTAL** — query Dune for TopShot Deposit/Withdraw (ownership-change) events since the last synced block/cursor, NOT the full snapshot. Upsert by `nft_id` (table PK handles it). Deltas are small (only moments that traded), so ongoing datapoints stay tiny → very plausibly inside the Free tier's 2,500 credits/mo.
- **Cadence:** daily incremental is cheap; re-run the full pull only occasionally (weekly/monthly) as a consistency backstop. Avoid daily FULL pulls (~30×92k ≈ 16.5M datapoints/mo — the expensive pattern). Note Rookie Debut (219) is 77k of the 92k; if cost ever bites, that giant common base is the first thing to drop from tracking.
- Confirm Dune's current datapoints-per-credit rate at dune.com/pricing against the incremental volume before committing — the incremental design exists specifically to keep it free/cheap.

**Dune query shape** (author against Dune's live Flow/TopShot schema — exact table/column names must be confirmed in Dune's data explorer; CC has Dune access): reduce TopShot `Deposit`/`Withdraw` events (or MomentMinted + transfers) to current owner per `nft_id`, filtered to the setIDs above, returning `nft_id, set_id, play_id, sub_edition_id, owner_address, serial_number`. Map `edition_external_id = set_id || ':' || play_id` (append `'::' || sub_edition_id` when sub_edition_id > 0) so it joins `editions.external_id`.

**Post-population check (DB side, ready):** after the bootstrap lands, confirm coverage — `Cooper Flagg Rookie Debut` (edition `219:7408`) should show owners in the hundreds, not 8 — then apply the collector-leaderboard + set-completers MVs above. Set-completion = base-play (recommended).
