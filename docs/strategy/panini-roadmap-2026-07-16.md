# Panini — go-live roadmap (2026-07-16)

Status: **infrastructure staged in prod, inert.** DB tables + read views are live and empty; the
push-ingest route ships behind no cron; the residential runner is ready to schedule. Nothing is
user-visible. The only remaining lift is Trevor's (a logged-in residential box) + a product decision
to actually turn it on. This roadmap supersedes the two-captures TODO in
[docs/drafts/panini/panini-golive-buildkit.md](../drafts/panini/panini-golive-buildkit.md) — both G1
captures are now DONE (below).

## What shipped this session (2026-07-16, Cowork)

- **DB (applied, reversible):** `audit_20260716_panini_schema_inert` (tables `panini_editions`,
  `panini_fmv_snapshots`, `panini_pack_state`) + `audit_20260716_panini_read_views`
  (`panini_squeeze_board`, `panini_pack_ev_board`). Verified: all 3 tables RLS-on, no anon write
  policy, no anon non-SELECT grant beyond harmless REFERENCES; both views `security_invoker=on`,
  anon-SELECT. Tables are empty (no consumer yet).
  **Revert:** `drop view if exists public.panini_pack_ev_board, public.panini_squeeze_board;`
  then `drop table if exists public.panini_pack_state, public.panini_fmv_snapshots, public.panini_editions;`
  (leave the `panini_blockchain` collections row — it predates this).
- **Code (main):** `app/api/cron/panini-ingest/route.ts` (push ingest, INERT — 401 without INGEST
  bearer, 202 no-op on empty body), `scripts/ingest-panini-runner.mjs` (residential Playwright
  runner, updated with both live pack IDs), `__tests__/api-cron-panini-ingest.test.ts` (auth guard +
  empty-body no-op + happy-path accept).
- **Recon (Chrome, logged-in session):** both G1 captures closed — see below.

## G1 captures — DONE (Chrome recon, 2026-07-16)

Recon done against Trevor's live logged-in `nft.paniniamerica.net` session.

- **FOTL WC Prizm pack (the missing capture):** `subpack-5294230-1039` → **pack_id 1039**.
- **Hobby WC Prizm pack (confirms buildkit):** `subpack-5270763-1038` → **pack_id 1038**. Live pack
  detail: 50,480 total, ~9,504 unopened remaining (≈81% ripped, up from ~54% on 06-27), 195 active
  listings, floor $249, avg sale $106.23, top $265.
- **Product:** "2026 Panini NFT Prizm World Cup Soccer".
- **psku format (live):** `packcard-<setId>_<playerId>_<cardId>_<parallelId>`; card image URLs append
  `__<serial>_<cap>` (e.g. `..._13__72_90` = serial 72 of /90).
- **Pack pool / odds (from the live Hobby pack detail — feeds pack-EV):** 2 base silver (each #/259)
  + 1 base non-silver parallel (#/124 → 1/1) + 1 other; an insert falls 7 of every 20 packs
  (replacing a base non-silver); bonus slot = either another base non-silver parallel or an insert
  (#/25 or #/49 → 1/1).
- **Rarity → cap (observed):** Uncommon = base silver /259; Rare ≈ /90 base non-silver; Epic = /25
  insert (validates the ingest tier map Uncommon→COMMON, Rare→RARE, Epic→LEGENDARY).
- **Enumeration:** the Soccer grid mixes ≥5 products (setIds seen: 2332, 2300, 1585, 2002, 1733), so
  the runner must SCOPE to the WC Prizm setId. Confirming which setId = WC Prizm is a 1-minute
  runner-time step (filter the grid to the product, read the setId off any card psku).
- **Key architecture finding:** a page-context `fetch`/XHR override does NOT intercept `/onepanini`
  (the SPA closes over `fetch` before injection). The runner's Playwright `page.on("response")` works
  at the network layer and is therefore the *only* correct capture path — this validates the runner
  design and is why there is no server-side pull option.

## Remaining phases

### R1 — Residential box (Trevor; unblocks everything)
A machine with a Chrome profile logged into Panini, left signed in. `npm i -D playwright`. Set env:
`PANINI_USER_DATA_DIR`, `RPC_PANINI_INGEST_URL=https://www.rippackscity.com/api/cron/panini-ingest`,
`INGEST_SECRET_TOKEN` (lives only on the box), optional `PANINI_PSKU_FILE`. Same class as the
existing home-machine schedulers (Deal Board / AllDay badges / Pinnacle render-cache). Known hazard:
Task Scheduler ingests are silent when the machine is logged off — register `panini-ingest` in
`pipeline_cadence_watchlist` so a stall pages.

### R2 — First reconciled run
Run the runner once. Verify: each edition `pulled_count + still_in_packs (+ burned) = mint_cap`;
Hobby `packs_remaining/packs_total` ≈ the ~81% ripped seen live; `panini_editions` row count ≈ the
checklist (players × parallels). Fix the WC-Prizm setId scope if other products leak in.

### R3 — Schedule + FMV
Schedule the runner every few hours on the box; add periodic re-login on auth errors. Wire a
`panini-fmv-recalc` pass (the `panini-1.0.0` sales-first / ASK-floor model already stubbed inline in
the ingest route; the fuller serial-aware model is a v2). Retire the superseded pull-model
scaffolding (`lib/chains/panini/{feed,normalize}.ts`, `app/api/cron/panini-{circulation-refresh,fmv-recalc}`).

### R4 — Public surfaces (gated)
Build squeeze / pack-EV / FMV / special-serials pages on the read views, behind the existing feature
gate, routes OUT of `isPublicPath`. QA with `rpc-insights-qa`. Special-serials needs a
`panini_card_serials` table (the runner already captures `getPskuTotalCardsList.nft_type` =
`number 1`/`jersey mint`/`perfect mint`).

### R5 — Go public
`collections.panini_blockchain.is_active=true`, publish the registry entry, add routes to
`isPublicPath` + sitemap + OG. Smoke + security-invariant + post-ship watch.

### Optional — Plane B (Ethereum/OpenSea provenance)
Bridge contract `0x23ae7a05f598fc234ee9dbef04033080dea8ab19` (floor ~0.0008 ETH = thin). The evm_*
plane was RETIRED 07-13, so this now means REVIVING that plane (+ a new ETH-mainnet RPC = infra
cost). Wire only if a real secondary/provenance consumer appears. `panini-schema.sql` §4 is ready.

## Sequencing guardrail
Chain two is still Candy/Solana ("never parallel"). This infrastructure makes Panini a fast start when
its turn comes; standing it up inert does **not** greenlight flipping it public ahead of the Candy gate.
