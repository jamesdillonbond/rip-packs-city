# Ownership Index — Pipeline A built (2026-06-26, Claude Code)

Follow-on to `docs/handoff-2026-06-26-ownership-index.md`. The **code** for Pipeline A (Dune)
is now committed and live (inert). What remains is operator/cost-gated. This doc is the exact
remaining lever set.

## Shipped this session (code, inert until configured)
- `workers/dune-proxy/` — Cloudflare Worker fronting the Dune Query Results API. Holds the Dune
  API key (never reaches Vercel logs). **4th independent auth surface** (`DUNE_PROXY_SECRET`) —
  does NOT share `TS_PROXY_SECRET` / `INGEST_SECRET_TOKEN` / `SPORK_PROXY_SECRET`. Routes:
  `GET /results?query_id=&limit=&offset=` (injects `X-Dune-API-Key`, pass-through) + `GET /health`.
- `app/api/cron/sync-topshot-ownership-dune/route.ts` — pages the Dune result set through the
  worker and upserts `public.topshot_ownership` (`onConflict nft_id`, `source='dune'`), `after()`-
  wrapped, logs `pipeline_runs` (`pipeline='ownership-sync-dune'`), Bearer INGEST/CRON, `maxDuration=800`
  bounded by a 750s wall-clock budget. **INERT**: until `DUNE_PROXY_URL` + `DUNE_PROXY_SECRET` +
  `DUNE_OWNERSHIP_QUERY_ID` are all set it logs `skipped:'dune_not_configured'` and writes nothing.
- `topshot_ownership` contract table already live (Cowork): `nft_id PK, edition_external_id,
  owner_address, serial_number, source, observed_at`. RLS on, service_role only.

## Remaining gates (operator / Trevor)
1. **Cost-flat decision (Trevor).** Create a Dune account + API key. Confirm the ownership query's
   row volume (~300k+ TS NFTs) fits the chosen plan/credits BEFORE committing. This is the gate the
   whole pipeline waits on.
2. **Author the Dune query** returning current ownership, one row per held NFT. Target columns
   (the route maps these, with a few aliases):
   ```
   nft_id, set_id, play_id, sub_edition_id, owner_address, serial_number
   ```
   Reference (do NOT copy blind — write our own): the rookie-tracker competitor's Dune calls used
   queryIds 6397249 + 6775165. Note the numeric query id of our query.
3. **Worker secrets + deploy:**
   ```
   cd workers/dune-proxy
   wrangler secret put DUNE_PROXY_SECRET --name dune-proxy
   wrangler secret put DUNE_API_KEY      --name dune-proxy
   wrangler deploy
   curl https://dune-proxy.<subdomain>.workers.dev/health   # {"ok":true}
   ```
4. **Vercel env** (PowerShell `Invoke-WebRequest`): `DUNE_PROXY_URL`, `DUNE_PROXY_SECRET` (== worker),
   `DUNE_OWNERSHIP_QUERY_ID`.
5. **Wire the cron** (cron-job.org): daily `POST https://www.rippackscity.com/api/cron/sync-topshot-ownership-dune`,
   header `Authorization: Bearer <INGEST_SECRET_TOKEN>`, off the :00 rush. Confirm the first run logs
   `ok=true` + `exhausted=true`; if `exhausted=false`, the row volume exceeded the 750s budget — raise
   cron frequency or add offset-cursor persistence (the route already reports `offset_reached`).

## Verify population before applying the read MVs
```sql
select count(*) total, count(distinct owner_address) owners, count(distinct edition_external_id) eds
from public.topshot_ownership where source='dune';
-- sanity: Cooper Flagg "Rookie Debut" (219:7408) owners should ≈ its circulating supply (~1,149),
-- not the 8 RPC knows today:
select count(distinct owner_address) from public.topshot_ownership where edition_external_id='219:7408';
```

## Post-population read surfaces (apply ONLY after the table is populated + verified)
Both are cheap MVs over `topshot_ownership`. **Security:** MVs are not RLS-aware — grant `service_role`
only and read them through a service-role route (never anon-grant a raw MV). Refresh via pg_cron.

### #1 — per-player collector leaderboard
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
-- SELECT cron.schedule('rpc-refresh-rookie-collector-lb','17 3,9,15,21 * * *',
--   'REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_rookie_collector_leaderboard_mv');
```
DO NOT ship the frontend until populated — on shallow data this ranked a "top collector" at 6 moments
(why the first build was dropped 2026-06-26).

### #4 — set completers (base-play completion)
```sql
CREATE MATERIALIZED VIEW public.topshot_set_completers_mv AS
WITH base_eds AS (
  SELECT e.set_id, e.set_name, e.external_id
  FROM public.editions e
  WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.external_id ~ '^[0-9]+:[0-9]+$'           -- base plays only; drop parallels
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
GRANT SELECT ON public.topshot_set_completers_mv TO service_role;
```
**Completion-definition decision (Trevor):** this uses base-play completion (own ≥1 of each play,
ignore parallels) to match the tracker. RPC's existing `check_set_completion(wallet)` is STRICTER
(requires every `::` parallel). Pick one; keep both consistent. The completion-over-time curve needs
ownership **history** — defer until daily `topshot_ownership` snapshots accumulate (or add a
`topshot_ownership_daily` snapshot table fed by the same cron).

## Read-MV SQL — schema-VERIFIED apply-ready (2026-06-26, CC follow-up)
Both MV definitions above were run against the LIVE schema (inner SELECTs, read-only — no DDL
applied) and compile + join cleanly. Confirmed live (`topshot_ownership` still 0 rows, so the
MVs are correct-but-empty until Dune populates — exactly the gate):
- **#1 collector leaderboard:** the rookie join matches **431 rookie editions across 61 rookie
  players** (`editions ⋈ topshot_2025_rookie_players ON player_name`, canonical `setID:playID(::sub)`
  predicate); 0 leaderboard rows on current (empty-ownership) data.
- **#4 set completers:** **9,256 base-play editions across 255 sets**; the LEFT JOIN yields all 255
  set rows even with empty ownership (`completers=0`, `holders_with_any=0`) — correct shape.
- Columns referenced all exist: `editions.{external_id,player_name,set_id,set_name,id}`,
  `fmv_snapshots.{edition_id,fmv_usd,computed_at}`, `topshot_ownership.{owner_address,edition_external_id}`,
  `topshot_2025_rookie_players.player_name`.
→ Apply the two `CREATE MATERIALIZED VIEW` blocks + their pg_cron refresh VERBATIM once the
population check above passes; no schema changes needed first. Do NOT apply earlier (empty/shallow
MVs ranked a "top collector" at 6 moments — the reason the first build was dropped).

## Pipeline B (on-chain walk) — accurate framing, NOT yet built
Trevor greenlit it, but it is **a refresh layer, not an independent bootstrap**. TopShot exposes no
contract view that lists all holders of an edition, so you cannot cheaply *discover* the owner set
on-chain — you can only resolve the current owner of a *known* NFT/wallet (which RPC's wallet-backfill
+ `snapshot-institutional-wallets` already do for tracked wallets). So:
- **Dune (Pipeline A) is the discovery/bootstrap.** Build + populate it first.
- Pipeline B then becomes "re-resolve current owner for the NFT/wallet set Dune surfaced" via
  `topshot-proxy` Cadence reads, writing `source='onchain_walk'` (authoritative; upsert on `nft_id`
  naturally reconciles with Dune rows). Worth it as the source-of-truth refresh once an owner set
  exists; not worth scaffolding as a standalone walker now (it would imply a discovery path that
  doesn't exist). Revisit after Dune populates.

## Revert
- Code: `git revert <this commit>` (worker + route are inert, so reverting is zero-impact).
- Worker: `wrangler delete --name dune-proxy` (only if deployed).
- Table/MVs: `DROP MATERIALIZED VIEW ...`; `DROP TABLE public.topshot_ownership;` (Cowork's).
