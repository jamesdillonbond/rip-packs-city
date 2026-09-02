# Dune ownership-index — build-book (finisher)

**✅ SHIPPED & LIVE 2026-07-06.** The Dune ownership pipeline is fully wired and the two MVs
are built. This doc is the finisher for the TopShot ownership-index feature scaffolded in
[docs/handoff-2026-06-26-ownership-index.md](../archive/handoffs/handoff-2026-06-26-ownership-index.md).
Remaining: the two **frontends** (Top Collectors panel + Set Completers board) and the
steady-state **freshness** follow-up (see bottom).

Read the 2026-06-26 handoff for the full rationale + the frontend specs.

---

## Live state (2026-07-06, post-bootstrap)

| Signal | Value | Meaning |
|---|---|---|
| `public.topshot_ownership` rows | **102,417** | Full bootstrap from Dune query `7899011`; run `ok=true / exhausted=true` in 5.2 min |
| Distinct owners / editions covered | **4,468 / 824** | Across the 10 rookie setIDs |
| Cooper Flagg `219:7408` owners | **1,000** (was 79 / ~8%) | Full minted circulation — the coverage gap is closed |
| `topshot_rookie_collector_leaderboard_mv` | **built** (34,908 rows) | Per-player collector board, canonical-owner deduped |
| `topshot_set_completers_mv` | **built** (rookie-scoped) | e.g. Rookie Debut 138 completers / 3,642 holders |
| pipeline: worker → Vercel envs → bootstrap → daily cron | **all live** | `dune-proxy` deployed; envs set; cron `40 11 * * *`; MV refreshes jobids 40/41 (`15/20 12`) |

Security after the MVs: `check_public_security_invariants()` **0**, `check_secdef_anon_execute_violations()` **[]**, MVs granted `service_role` only (no anon).

**Route hardening (`0e8c07a`):** the walk was capped at 20k by Dune's free-tier 15-40 req/min
rate limit (429 at offset 20000, aborted, restarted at offset 0 each run). Fixed with a 2.5s
inter-page throttle + per-page 429 retry/backoff so one run drains all ~103 pages in budget.

**Revert:** `DROP MATERIALIZED VIEW public.topshot_rookie_collector_leaderboard_mv;`
`DROP MATERIALIZED VIEW public.topshot_set_completers_mv;`
`SELECT cron.unschedule('rpc-refresh-rookie-collector-lb'); SELECT cron.unschedule('rpc-refresh-set-completers');`
`TRUNCATE public.topshot_ownership;` (+ revert `0e8c07a` for the route).

---

## Drift caught: rookie setID scope is now 10 sets, not 9

The 2026-06-26 handoff scoped the Dune query to `219, 220, 223, 233, 238, 241, 243, 246, 261`.
Live re-derivation on 2026-07-06 returns **`219, 220, 223, 233, 238, 241, 243, 246, 260, 261`**
— **`260` is a new rookie set** since the handoff. Use the 10-set list below in the Dune query.

Re-derive each season before re-scoping:
```sql
SELECT DISTINCT set_id_onchain
FROM editions
WHERE player_name IN (SELECT player_name FROM topshot_2025_rookie_players)
  AND set_id_onchain IS NOT NULL
ORDER BY set_id_onchain;
```
setID filter list (2026-07-06): **`219, 220, 223, 233, 238, 241, 243, 246, 260, 261`**

Note Rookie Debut (`219`) is the giant common base (~77k of ~92k NFTs). If Dune cost ever
bites, `219` is the first set to drop from tracking.

---

## The sequence (who does what)

1. **You (local) — finish MCP wiring** with a real Dune key
   (`claude mcp add --scope user --transport http dune https://api.dune.com/mcp/v1 --header "x-dune-api-key: <key>"`).
   Confirms the account/key exists (the shared blocker for both the MCP and the cron).

2. **You + Dune MCP (local) — author the ownership query** (see draft below). This is the one
   step that genuinely needs Dune's live Flow schema — the MCP's data-explorer/table-discovery
   tools are exactly the tool for it. Confirm the real table + column names, save the query,
   note its numeric `query_id`. **Confirm the incremental datapoint volume fits Dune's free
   2,500 credits/mo before committing** (cost-flat gate).

3. **You (operator) — light it up:**
   ```
   cd workers/dune-proxy
   wrangler secret put DUNE_PROXY_SECRET --name dune-proxy   # fresh secret (4th rotation surface)
   wrangler secret put DUNE_API_KEY      --name dune-proxy   # the Dune API key
   wrangler deploy
   curl https://dune-proxy.<subdomain>.workers.dev/health    # -> {"ok":true}
   ```
   Vercel envs (PowerShell `Invoke-WebRequest`, per CLAUDE.md):
   `DUNE_PROXY_URL`, `DUNE_PROXY_SECRET` (same value), `DUNE_OWNERSHIP_QUERY_ID` (from step 2).
   Wire the daily cron (cron-job.org, off the :00 rush) hitting
   `/api/cron/sync-topshot-ownership-dune` with `Bearer INGEST/CRON`. The inert route goes live
   and bootstraps `topshot_ownership`.

4. **Claude Code / Cowork — the back half (ready to fire the moment step 3 populates the table):**
   verify coverage → apply the two MVs + pg_cron below → build the frontends. None of this can
   run on an empty table, which is why it's staged here rather than shipped.

---

## DuneSQL — ownership query (STEP 2 — schema confirmed live via Dune MCP 2026-07-06)

**Table:** `flow.cadence_events` (partition key `block_date`). Confirmed the only surface —
`flow.cadence_token_transfers` returns 0 rows for TopShot even over 30d, so it does not cover
Cadence-native NFT contracts. All events are raw JSON in `data`; extract with
`json_extract_scalar(data, '$.field')` + `CAST`.

**Confirmed event payloads (measured on the live Dune schema):**

| Event `topics[1]` | `data` payload | Use |
|---|---|---|
| `A.0b2a3299cc857e29.TopShot.Deposit` | `{id, to}` | Latest = current owner. NO set/play/serial. |
| `A.0b2a3299cc857e29.TopShot.Withdraw` | `{id, from}` | Ownership-change signal (redundant with Deposit for the index). |
| `A.0b2a3299cc857e29.TopShot.MomentMinted` | `{setID, playID, momentID, serialNumber, subeditionID}` | Canonical metadata source. `momentID` = NFT id used by Deposit/Withdraw. `subeditionID=0` = base printing; `>0` = parallel. |
| `A.0b2a3299cc857e29.TopShot.SubeditionAddedToMoment` | `{setID, playID, momentID, subeditionID}` | **Strict duplicate** of `MomentMinted`'s subedition info (same `n_30d`, same `tx_hash`). Do not join. |
| `A.0b2a3299cc857e29.TopShot.NFT.ResourceDestroyed` | `{id, setID, playID, serialNumber}` | Burns. Ignore for ownership; the destroyed NFT can't be owned. |

Current owner per NFT = the `to` address of the **most recent Deposit** event for that NFT
(every transfer emits Withdraw-from-old + Deposit-to-new, so latest Deposit wins).

**Bootstrap (one-time full pull, ~92k rows for the 10 rookie setIDs):**
```sql
-- Confirmed against Dune's flow.cadence_events on 2026-07-06.
-- Free-tier sanity check (30d window): 20 rows in 0.473 credits, no set-ID leaks,
--   subedition semantics correct (0=base, 21/22=parallels of the same play).
WITH mint AS (
  SELECT
    CAST(json_extract_scalar(data, '$.momentID')     AS bigint)  AS nft_id,
    CAST(json_extract_scalar(data, '$.setID')        AS integer) AS set_id,
    CAST(json_extract_scalar(data, '$.playID')       AS integer) AS play_id,
    CAST(json_extract_scalar(data, '$.subeditionID') AS integer) AS sub_edition_id,
    CAST(json_extract_scalar(data, '$.serialNumber') AS integer) AS serial_number
  FROM flow.cadence_events
  WHERE block_date >= DATE '2020-10-01'                     -- TopShot genesis
    AND cardinality(topics) > 0
    AND topics[1] = 'A.0b2a3299cc857e29.TopShot.MomentMinted'
    AND CAST(json_extract_scalar(data, '$.setID') AS integer)
        IN (219, 220, 223, 233, 238, 241, 243, 246, 260, 261)
),
dep AS (
  SELECT
    CAST(json_extract_scalar(e.data, '$.id') AS bigint) AS nft_id,
    json_extract_scalar(e.data, '$.to')                 AS owner_address,
    e.block_height,
    row_number() OVER (
      PARTITION BY CAST(json_extract_scalar(e.data, '$.id') AS bigint)
      ORDER BY e.block_height DESC
    ) AS rn
  FROM flow.cadence_events e
  WHERE e.block_date >= DATE '2020-10-01'
    AND cardinality(e.topics) > 0
    AND e.topics[1] = 'A.0b2a3299cc857e29.TopShot.Deposit'
    AND CAST(json_extract_scalar(e.data, '$.id') AS bigint) IN (SELECT nft_id FROM mint)
)
SELECT d.nft_id, m.set_id, m.play_id, m.sub_edition_id, d.owner_address, m.serial_number
FROM dep d
JOIN mint m ON m.nft_id = d.nft_id            -- USING(nft_id) collapses the alias in Trino; use ON.
WHERE d.rn = 1;
```

**Steady-state (INCREMENTAL — the cheap path):** query only Deposit events since the last synced
`block_height` cursor, reduce to latest owner per changed `nft_id`, return the same columns. The
`mint` CTE only needs a fresh delta scan for sets that mint new rows (mostly `260`/`261` right
now); older rookie sets can be cached client-side after bootstrap. Deltas are tiny (only moments
that traded). Never run daily FULL pulls (~30×92k ≈ 16.5M datapoints/mo = the expensive pattern).
Re-run the full bootstrap weekly/monthly as a consistency backstop.

The cron route derives `edition_external_id = set_id || ':' || play_id`
(append `'::' || sub_edition_id` when `sub_edition_id > 0`) to join `editions.external_id`.

---

## Post-bootstrap SQL (STEP 4 — VALIDATED 2026-07-06, apply only after `topshot_ownership` populates)

**Coverage check first** — do NOT apply the MVs until this passes:
```sql
-- Cooper Flagg Rookie Debut 219:7408 should jump from 79 -> hundreds (circ 1,000)
SELECT count(DISTINCT owner_address) AS flagg_owners
FROM topshot_ownership WHERE edition_external_id = '219:7408';
```

### #1 Collector leaderboard MV (compile-validated)
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
-- pg_cron: SELECT cron.schedule('rpc-refresh-rookie-collector-lb','17 3,9,15,21 * * *',
--   'REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_rookie_collector_leaderboard_mv');
```

### #4 Set completers MV (base-play completion; compile-validated)
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
CREATE UNIQUE INDEX ix_tscm_pk ON public.topshot_set_completers_mv (set_id);
GRANT SELECT ON public.topshot_set_completers_mv TO service_role;
-- pg_cron: SELECT cron.schedule('rpc-refresh-set-completers','37 3,9,15,21 * * *',
--   'REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_set_completers_mv');
```
> **Completion = base-play** (own ≥1 of each play, parallels ignored) — matches the tracker.
> RPC's `check_set_completion(wallet)` is stricter (requires every `::` parallel too). Keep
> whichever definition ships consistent across surfaces.

### Revert
```sql
DROP MATERIALIZED VIEW IF EXISTS public.topshot_rookie_collector_leaderboard_mv;
DROP MATERIALIZED VIEW IF EXISTS public.topshot_set_completers_mv;
SELECT cron.unschedule('rpc-refresh-rookie-collector-lb');
SELECT cron.unschedule('rpc-refresh-set-completers');
```
`topshot_ownership` itself: `DROP TABLE public.topshot_ownership;` (see the handoff).

---

## Frontends (after the MVs land — run the rpc-insights-qa gate)
- **Top Collectors** panel on each rookie/player surface: top-N by `rnk`, username-resolved
  (`getUserProfile`), movement deltas once 2+ snapshots exist. Label honestly: "based on indexed
  ownership, refreshed daily."
- **Set Completers** board: rookie sets with `completers` / `total_plays`; the completion
  over-time curve needs ownership history — add a `topshot_ownership_daily` snapshot fed by the
  same cron, or defer.

## Also worth Dune (parallel, exploratory — via the MCP)
The same key unlocks ad-hoc reconciliation: cross-check `sales`/`evm_nft_transfers` counts against
Dune, and — highest strategic value — scope **Candy MLB (Solana / Metaplex Core, Magic Eden)**
sales history + edition/serial schema for the chain-two July-8 tripwire, before building Helius
ingest. See CLAUDE.md → chain strategy.
