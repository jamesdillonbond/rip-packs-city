RPC Claude Code handoff — F4-SWEEP-WIRE: expand Special-Serial-Owners board coverage beyond organically-seeded wallets (2026-07-04)

CONTEXT / GOAL

The Special Serial Owners board (`/special-serial-owners`, RPC `get_special_serial_owners_board` → view `topshot_special_serial_owners`) identifies the current tracked-wallet holder of every canonical Top Shot special serial: the #1 mint, the perfect mint (#N/N), and the jersey-match serial. The view reads `wallet_moments_cache` (wmc), so it can only surface a special serial if some already-seeded wallet happens to hold it.

Measured coverage today (2026-07-04, authoritative — the MV is fresh, cron `rpc-refresh-special-serial-owners-mv` @ `13 4,16 * * *` ran ~4s with 0 serial-1 staleness delta): **5,318 / 11,009 canonical editions** have ≥1 special owner surfaced (#1: 2,800, jersey: 2,080, perfect: 2,124). The remaining ~5,691 editions are NOT a metadata gap (the jersey_number backfill on 2026-07-04 already closed the DB-fixable slice — see the ledger) — they are a **wallet-coverage gap**: the holders of those special serials are wallets RPC has never seeded into wmc. There is no live resolver filling them; the two `special-serial-*` edge functions that were built for exactly this are deployed but are **no-op stubs** (every resolver returns null).

This handoff wires that gap closed. It is a **real feature build with a proxy/data-path dependency + a security-sensitive view change** — NOT an autonomous trigger, which is why the overnight passes have kept it queued. Nothing here touches FMV / pricing / auth / ingest-route logic. Claude Code's direct file/DB inspection wins over this doc on any disagreement — verify every path, RPC signature, and view definition live before editing.

────────────────────────────────────────────────────────
WHAT EXISTS TODAY
────────────────────────────────────────────────────────

1. The two stub edge functions (deployed, verify_jwt=false, Bearer INGEST_SECRET_TOKEN):

   - `supabase/functions/special-serial-sweep/index.ts` — the backfill sweep. Ad-hoc curl trigger (not on a cron). Pages `get_special_serial_targets(p_collection_id, p_limit, p_offset, p_force_refresh)` for each non-Pinnacle collection, calls `resolveOwnership(target)` per row, and upserts into `special_serial_holders` on conflict `(edition_id, badge_type, serial_number)`. The four per-collection resolvers (`lookupTopShotOwner`, `lookupAllDayOwner`, `lookupGolazosOwner`, `lookupUfcOwner`, at ~lines 110–140) are **all no-ops returning `{nft_id:null, holder_address:null}`**. Because `upsertHolder` early-returns when `holder_address` is null, the stub writes nothing — safe to run, does nothing. Pinnacle is intentionally excluded (separate ownership mechanic).

   - `supabase/functions/special-serial-delta/index.ts` — the daily refresh. Cron-scheduled (external cron-job.org, ~every 30 min) with the INGEST bearer. Calls `get_recently_traded_special_serials(p_hours:=24)` (with a JS fallback join over `special_serial_holders` × `sales_2026` if the RPC path fails), then re-resolves ownership for tracked NFTs that traded in the last 24h. **Same no-op resolvers.** So the cron currently burns ~48 invocations/day doing nothing — harmless but wasted until the resolvers land.

   Both files comment that the resolvers should be lifted into a shared module once the wiring lands (do that — see step B).

2. The target/refresh RPCs (all live, confirmed):
   - `get_special_serial_targets(p_collection_id uuid, p_limit int, p_offset int, p_force_refresh bool)` — feeds the sweep.
   - `get_recently_traded_special_serials(p_hours int)` — feeds the delta.
   - `get_special_serial_owners_board(p_tag text, p_tier text, p_player text, p_holder text, p_sort text, p_limit int, p_offset int)` — the board read RPC (service_role-defined, anon+authenticated-executable, read-only; the one intentional SECDEF-anon read).
   - `refresh_topshot_special_serial_owners_mv()` — refreshes the MV (forces hashjoin, ~4s; cron `rpc-refresh-special-serial-owners-mv`).

3. `special_serial_holders` table (the write target — exists, currently ~empty/unused): columns `id uuid, collection_id uuid, edition_id uuid, badge_type (enum), serial_number int, nft_id text, holder_address text, last_verified_at timestamptz, last_traded_at timestamptz, created_at, updated_at`. Unique/conflict key is `(edition_id, badge_type, serial_number)`. RLS on; confirm it stays service-role-write / non-anon-readable (it holds wallet addresses — see the holder-exposure constraint).

4. The board data path:
   - View `public.topshot_special_serial_owners` (migration `audit_20260619_topshot_special_serial_owners_view`, `security_invoker=on`) — reads wmc, one row per canonical special serial with its current tracked holder. Columns: `edition_id, edition_key (setID:playID), player_name, set_name, tier, series, team_name, circulation_count, serial, tag ('#1'|'perfect'|'jersey'), holder_address, nft_id, holder_seen_at, edition_fmv`.
   - MV `topshot_special_serial_owners_mv` — materialized copy refreshed by the cron above; `get_special_serial_owners_board` reads the view and/or the MV. **VERIFY which of the two the board RPC actually SELECTs (`pg_get_functiondef`) before you change the union point** — you must union `special_serial_holders` into whichever object the RPC reads (and if it's the MV, the refresh fn must pull the union in too).
   - `lib/special-serial-owners-board.ts` — shared normalized `OwnerRow` shape + `fetchSpecialSerialOwners`. The page `/special-serial-owners` is **auth-gated** (Trevor's 2026-06-19 holder-exposure decision — see constraint). The route `app/api/public/special-serial-owners/route.ts` calls the RPC via the service-role client.

5. The proxy reality (probed 2026-07-04, commit `d13eafd`; corroborated by the worker's own 2026-06-15 comments):
   - `workers/topshot-proxy/index.js` is a **pure passthrough** — it has NO per-operation safelist of its own. It forwards POST bodies to the upstream Dapper GQL endpoint for the matched route (`/topshot` → `public-api.nbatopshot.com/graphql`), gated only by the `X-Proxy-Secret` header. So "add owner-by-serial to the proxy safelist" is NOT a worker code edit in the usual sense — the gate is elsewhere (see below).
   - The app-side operation set RPC actually sends lives in `lib/chains/flow/topshot-graphql.ts` — and it only exposes `fetchEditionStats` (searchEditions/stats), `fetchRecentSales` (sales), and `fetchEditionMarketMap` (listings). **None return an owner for a `(setID, playID, serial)` triple.**
   - Upstream Dapper enforces a persisted-query / operation allowlist. The 2026-06-15 investigation (documented in the worker header) found `searchMintedMoments` returns generic "unknown field" through `public-api` even with browser headers — the gate is an operation allowlist, NOT UA/header-based, and header spoofing to the marketplace endpoint hits a Cloudflare managed bot challenge. `getMintedMoment(momentId)` DOES work through the proxy, but it is keyed by **moment/nft id**, not by serial.

────────────────────────────────────────────────────────
THE FEASIBILITY FORK (resolve this FIRST — it decides the whole build)
────────────────────────────────────────────────────────

The sweep/delta stubs are designed around a direct `(collection, edition, serial) → (nft_id, holder_address)` resolver. For TopShot that direct lookup is the hard part, because there is no confirmed server-side GQL path from a serial to its current owner:

  PATH A — GQL owner-by-serial (`searchMintedMoments{ ... owner{ flowAddress } }`).
    Cleanest IF it works, but it was VERIFIED INEFFECTIVE on 2026-06-15 (upstream allowlist rejects the op). Re-probe before betting on it: POST the op through `topshot-proxy /topshot` with a valid `X-Proxy-Secret` and check for a real result vs "unknown field". If Dapper has since allowlisted it, wire it and you're done. If it still 400s, Path A is dead and there is no worker/app edit that revives it — the allowlist is Dapper's, not ours.

  PATH B — serial → nft_id (ours) → `getMintedMoment(nft_id){ owner{ flowAddress } }` (works via proxy).
    We already map many special-serial nft_ids in `moments` / wmc / sales (any special serial we've ever seen trade has a known nft_id). For those, `getMintedMoment(nft_id)` returns the CURRENT owner — refreshing holders for serials-we-know even when the holder wallet was never seeded. Gap: special serials we've NEVER observed on-chain have no nft_id, so Path B can't reach them. First VERIFY (Cadence MCP or a live probe) that TopShot's `getMintedMoment` payload actually exposes `owner.flowAddress` before building on it.

  PATH C — holder discovery instead of serial→owner.
    Sidestep the per-serial lookup: harvest candidate wallets (recent special-serial sale buyers, offer-fill counterparties, institutional wallets, linked children) and SEED them through the existing wallet-backfill (Cadence collection walk → wmc). The `topshot_special_serial_owners` view then surfaces their special serials for free — no new GQL op, no view union, reuses proven ingest. Highest coverage-per-effort for the wallet-coverage gap, but it's ingest-adjacent (seeding load) and its yield is probabilistic, not targeted.

  For AllDay / Golazos / UFC the resolvers are on-chain Cadence (per the stub comments + CLAUDE.md per-collection gotchas): AllDay `borrowNFT(id)! as! &AllDay.NFT` → editionID/serial; UFC borrow as generic `NonFungibleToken.CollectionPublic`; etc. These are also nft-id-keyed (Path-B-shaped) — you still need serial→nft_id first, which again comes from our `moments`/sales maps. **Before writing ANY Cadence, fetch the live contract source via the Cadence MCP and verify the fields/among the per-collection gotchas in CLAUDE.md.**

RECOMMENDATION: Path B (getMintedMoment) as the primary resolver for the serials we can key, because it needs no upstream allowlist change and reuses a proxy op that already works; optionally combine with Path C for the long tail. Treat Path A as a cheap re-probe only. **This fork is an operator/Trevor decision — do not silently pick one and ship a partial-coverage board that looks complete. Whatever you choose, log in the board / ledger which serials are covered vs unreachable (no silent caps).**

────────────────────────────────────────────────────────
WHAT NEEDS TO CHANGE, AND IN WHAT ORDER
────────────────────────────────────────────────────────

STEP 0 — Decide the resolver path (above). Re-probe Path A; confirm Path B's `getMintedMoment` exposes owner; pick B (±C). Get Trevor's sign-off on the path and on any wallet-seeding load (Path C).

STEP A — Owner-by-serial resolver primitive.
  A1. If Path A revives: add the `searchMintedMoments{ ... owner{ flowAddress } }` op to `lib/chains/flow/topshot-graphql.ts` as a new exported fetch (mirror `fetchEditionStats`'s proxy call + `X-Proxy-Secret` handling). No `topshot-proxy` worker edit is needed for the passthrough itself; only Dapper's allowlist matters.
  A2. If Path B: add a `getMintedMoment(nft_id){ owner{ flowAddress }, serialNumber, ... }` fetch to `topshot-graphql.ts`, plus a serial→nft_id resolver that reads our `moments`/wmc/sales maps (a small RPC `get_special_serial_nft_ids(collection_id, edition_id, serial[])` is cleaner than baking the join into the edge fn — mirror the existing target RPCs). For AllDay/Golazos/UFC add the Cadence-script resolvers (MCP-verified) behind the same interface.
  Keep the resolver signature identical to the stub's `resolveOwnership` so the edge functions barely change.

STEP B — Wire the stubs (shared module).
  Create a shared resolver module both edge functions import (the files already say to do this), replace the four no-op `lookup*Owner` bodies with the Step-A resolver, and populate `special_serial_holders` (nft_id, holder_address.toLowerCase(), last_verified_at, and last_traded_at on the delta path). The upsert plumbing, throttle (REQ_THROTTLE_MS=50), paging, and auth are already correct — only the resolver bodies change. Redeploy both via `deploy_edge_function` (preserve verify_jwt=false). Run the sweep once per collection (`POST …/special-serial-sweep` with the INGEST bearer, `{collection_id, batch_size}`) and confirm rows land in `special_serial_holders`.

STEP C — Union `special_serial_holders` into the board (migration).
  Extend whichever object `get_special_serial_owners_board` reads (the view `topshot_special_serial_owners`, and/or the MV + its refresh fn — VERIFY first) to UNION the resolved rows from `special_serial_holders` with the existing wmc-derived rows, de-duplicated by `(edition_id, tag, serial)` with a clear precedence (freshest `last_verified_at`/`holder_seen_at` wins). Keep `security_invoker=on` on the view. After the migration: re-run `check_public_security_invariants()` (expect 0) and `check_secdef_anon_execute_violations()` (expect ONLY `get_special_serial_owners_board`, unchanged — you are not adding a new anon read). If you touched the MV, refresh it via `refresh_topshot_special_serial_owners_mv()` and re-measure coverage.

STEP D — Verify (below). STEP E — Revert paths (below).

────────────────────────────────────────────────────────
HOLDER-EXPOSURE CONSTRAINT (2026-06-19 Trevor decision — do NOT regress)
────────────────────────────────────────────────────────

The board is effectively a rich-list of who holds every #1 / perfect / jersey special serial. Trevor's 2026-06-19 call: wallets are public on-chain and RPC already shows holders on moment/profile pages, so the board is acceptable — BUT the dedicated directory stays **auth-gated**:
  - The PAGE `/special-serial-owners` is NOT in `proxy.ts` `isPublicPath` and NOT in `app/sitemap.ts` — it is a logged-in-user feature. Keep it that way. There is a documented one-line switch (add `isPublicPath` + sitemap entries) to make it a public SEO board ONLY once Trevor signs off; this handoff does NOT flip it.
  - `special_serial_holders` and the board view expose `holder_address`. Data reaches anon callers ONLY through the SECDEF board RPC, which the auth-gated page calls server-side via the service-role client. When you union the holders table in, do NOT add any new anon/public/sitemap surface, do NOT grant anon SELECT on `special_serial_holders`, and do NOT change the RPC's grants. The net exposure of holder wallets must be identical to today's — just with more rows behind the same auth gate.
  - If Path C seeds new wallets, that only adds wmc rows (already the platform's normal state); it introduces no new exposure surface.

────────────────────────────────────────────────────────
VERIFICATION STEPS
────────────────────────────────────────────────────────

1. Resolver correctness (spot-check before trusting the sweep): pick 3–5 special serials whose holder you can independently confirm (Flowscan / an owned wallet / a known moment page), run the resolver, and confirm `holder_address` matches on-chain truth. A wrong resolver silently poisons the board with confident-but-wrong owners — verify before bulk-running.
2. Rows land: after a sweep, `SELECT count(*), count(DISTINCT edition_id) FROM special_serial_holders;` climbs from ~0; `holder_address` populated, lowercased; no null `nft_id` where the resolver claimed a holder.
3. Coverage moved: re-measure `SELECT count(DISTINCT edition_id) FROM <board object>` (the view/MV the RPC reads) — expect it to rise from the 5,318 baseline toward 11,009 by the count Step A can actually reach. Record covered-vs-unreachable explicitly (no silent cap).
4. Security unchanged: `check_public_security_invariants()` = 0 rows; `check_secdef_anon_execute_violations()` lists only `get_special_serial_owners_board`; `SELECT relrowsecurity FROM pg_class WHERE relname='special_serial_holders'` = true; no anon/authenticated SELECT grant on `special_serial_holders`.
5. Board still auth-gated: `/special-serial-owners` absent from `sitemap.ts` and not in `proxy.ts` isPublicPath; anon GET of the page redirects to the auth funnel; the `/api/public/special-serial-owners` route returns data only via the service-role RPC.
6. No duplicate/blended rows: the union de-dupes by `(edition_id, tag, serial)` — no edition shows two conflicting holders for the same serial; freshest wins.
7. Deploy + tsc: `npx tsc --noEmit` clean (filter to changed files); edge functions redeployed with verify_jwt=false; delta cron now does real work (its next tick logs `refreshed > 0` when trades occurred, instead of a perpetual no-op).
8. Delta cron sanity: after wiring, confirm the ~30-min `special-serial-delta` invocations stop being pure no-ops (they should re-verify recently-traded tracked serials) and don't error.

────────────────────────────────────────────────────────
REVERT PATHS
────────────────────────────────────────────────────────

- STEP C view/MV union (migration): `CREATE OR REPLACE VIEW public.topshot_special_serial_owners AS …` back to the pre-union definition (the wmc-only body from `audit_20260619_topshot_special_serial_owners_view` in migration history); if the MV/refresh fn was changed, `CREATE OR REPLACE FUNCTION refresh_topshot_special_serial_owners_mv …` back and re-refresh. This alone reverts the board to today's 5,318-coverage behavior even if the edge functions keep writing.
- STEP B edge functions: redeploy the current stub bodies (git revert the resolver commit + `deploy_edge_function`), OR just stop invoking the sweep and pause the delta cron-job.org entry — the no-op stubs are inert.
- STEP A `topshot-graphql.ts` additions: git revert the commit (additive exports, safe to remove).
- Clear resolved rows if abandoning entirely: `DELETE FROM public.special_serial_holders;` (per the destructive-op circuit-breaker in CLAUDE.md, this table is NOT among the guarded irreplaceable tables — `special_serial_holders` is regenerable by re-running the sweep — but still scope/confirm before a bulk delete).
- Path C wallet seeding: no revert needed (seeded wmc rows are normal platform state).

────────────────────────────────────────────────────────
GUARDRAILS (repeat every time)
────────────────────────────────────────────────────────

- Work directly on `main`. NO branches, NO PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first. Re-verify with `git rev-list --count origin/main..HEAD` (expect 0 after push).
- Commit via PowerShell git on Windows (Git Bash `git commit` can silently no-op). curl fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Before ANY Cadence (`.cdc`, inline cadence template literals, FCL query/mutate): fetch the live mainnet contract source via the Cadence MCP and verify fields/args against the per-collection gotchas in CLAUDE.md. Training-data Cadence 1.0 APIs are frequently wrong.
- Production reads route through the worker proxies — never call `public-api.nbatopshot.com` / `rest-mainnet.onflow.org` directly from a Vercel/Supabase egress path.
- After any SECDEF/view change: `check_secdef_anon_execute_violations()` + `check_public_security_invariants()` — confirm only the intended fn appears and base-table invariants stay 0.
- Supabase MCP: `apply_migration` for DDL, `execute_sql` for reads; single statement per call (multi-statement returns only the last result); `CREATE INDEX CONCURRENTLY` must be standalone.
- Don't broad-read secret-bearing console pages (cron-job.org job-edit Authorization header, env/secret settings).

EXPECTED END STATE

The sweep + delta resolvers are wired to a real owner-by-serial primitive (Path B ± A/C), `special_serial_holders` is populated for the serials Step A can reach, and the board view/MV unions that table in behind the unchanged auth gate — moving distinct-edition coverage above the 5,318 baseline with holder exposure identical to today. The delta cron does real work. Security invariants unchanged (0; only `get_special_serial_owners_board` as the intentional anon read). Covered-vs-unreachable is recorded, not silently capped. tsc clean, edge functions redeployed (verify_jwt=false), migration reversible.
