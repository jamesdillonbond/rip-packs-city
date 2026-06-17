# Handoff 2026-06-16 — Underpriced #1s deal board: ingest route + public page (GREENLIT; Cowork DB scaffolding shipped)

Trevor **greenlit the build 2026-06-16** — this overrides the standing 2026-06-08 Atlas-defer decision. The Atlas feed is fully captured (no schema guessing left), the DB foundation + a clean set of service-role helpers are shipped and verified live, and the enumeration design is settled. What remains is route/.tsx code (CC's domain): the ingest, the public page, and the alert filters.

Companion docs (read first): `docs/handoff-2026-06-16-dapper-atlas-listings-source.md` (the captured Atlas spec — method/body/response/headers/egress), `docs/handoff-2026-06-16-buyer-backfill-maxduration.md` (the after()/maxDuration lesson — apply it here).

---

## DB interfaces ready (Cowork-shipped this session, live + verified, service_role-only)

Migration `audit_20260616_deal_board_ingest_scaffolding`. All three are `SECURITY DEFINER`, `service_role`-only (no anon/public leak — `check_secdef_anon_execute_violations` stays `[]`).

1. **`topshot_serial_board_candidates(p_min_no1_estimate numeric DEFAULT 0)`** → `TABLE(rpc_edition_id uuid, external_id text, set_id_onchain int, play_id_onchain int, series smallint, tier text, circulation_count int, edition_fmv_usd numeric, confidence text, no1_estimate_usd numeric, perfect_estimate_usd numeric)`. The ingest's "what to query" source — board-eligible TS editions (latest FMV HIGH/MEDIUM, `set_id_onchain`+`play_id_onchain` NOT NULL so the inert UUID dupes are excluded, circ>0), with the #1 and perfect serial-FMV estimates (same `serial_fmv_estimate` gating the board view uses). Scoped by a $-floor on the #1 estimate to bound Atlas volume. **Counts: 3,067 at $0 · 1,977 at ≥$50 · 1,078 at ≥$100.**
2. **`upsert_topshot_active_listings(p_rows jsonb)`** → `int` (rows upserted). Bulk upsert on the PK `(edition_id, serial_number)`; sets `active=true, last_seen_at=now()`. Each array element: `{edition_id(uuid), edition_key, serial_number(int), nft_id, ask_usd(numeric), serial_fmv_usd(optional), listing_resource_id, listing_url, listed_at(optional ts)}`. **Verified end-to-end**: seeded a Curry `2:147` #1 at $6,576.93 → surfaced on the board at 50% discount vs its $13,153.85 estimate → cleaned; table back to 0.
3. **`deactivate_stale_topshot_active_listings(p_max_age interval DEFAULT '6 hours')`** → `int`. Flips `active=false` on listings not re-seen within the window (call once at sweep end so delisted serials drop off the board).

The board view **`topshot_underpriced_serials_board`** (CC, prior) reads `topshot_active_listings` + `serial_fmv_estimate`, surfaces active `serial=1 OR serial=circulation_count` rows where `ask_usd < estimate_usd`, ranked by `discount_pct`. It's inert until the ingest fills the table.

Revert (DB scaffolding): `DROP FUNCTION public.topshot_serial_board_candidates(numeric); DROP FUNCTION public.upsert_topshot_active_listings(jsonb); DROP FUNCTION public.deactivate_stale_topshot_active_listings(interval);`

---

## Atlas feed — new findings this session (beyond the captured-spec doc)

- **Serial sort works; there is NO server-side serial *filter*.** `sortByOption:"SERIAL_NUMBER"` + `sortByDirection` is honored (DESC `limit:1` → highest listed serial = perfect when `==numMinted`, live-verified serial 35000; ASC `limit:1` → lowest listed serial = #1 when `==1`). But a `{serialNumber:1}` filter is **silently ignored** (Connect-RPC drops unknown fields — tested int and string, both returned non-#1 rows). **Do not look for a serial filter; it isn't there.** → per-edition boundary queries are required; you can't stream "all #1s" in one call.
- **The global query (no `editionId`) works** (`{product:"nba",completed:false,...}` returns cross-edition listings), but **`pagination.totalCount` is unreliable at global scope** (returned "3" for the whole NBA market). Don't size anything off it.
- **Atlas `setId` == RPC `set_id_onchain`** — VERIFIED (Atlas edition 2017 = Base Set/Series 2 `setId:26`; RPC Base Set S2 = `set_id_onchain 26`, 533 editions). This is the basis for the edition-id map below.

---

## Enumeration design (settled): scoped per-candidate, serial-boundary

1. `topshot_serial_board_candidates($floor)` — **recommend `$100` (1,078 editions) to start**, or `$50` (1,977) for wider coverage; tune to the Atlas budget. (A $3 common's #1 isn't a deal-board entry, so a floor is correct, not just a perf hack.)
2. Per candidate: **one ASC `limit:1`** (the #1 end) **+ one DESC `limit:1`** (the perfect end) on `SearchMarketplaceTransactions{completed:false, editionId, sortByOption:"SERIAL_NUMBER"}`. Accept the ASC row only if its `serialNumber == "1"`; accept the DESC row only if `serialNumber == numMinted` (else that special serial simply isn't listed → no row). ~2 calls/candidate → ~2,156 calls/sweep at the $100 floor.
3. **Atlas-`editionId` map** (the one build-time piece): the candidate gives `(set_id_onchain, play_id_onchain)`, but Atlas queries need Atlas's integer `editionId`. Build the map once via Atlas `EditionService/SearchEditions{product:"nba", limit:"50", offset paginated}` (returns per edition: `id, setId, seriesId, editionTemplateId, tier, numMinted`), joined to RPC `editions` on `set_id_onchain = setId` **AND** `play_id_onchain = editionTemplateId`. **Confirm `editionTemplateId == play_id_onchain` with one `GetEdition` against a known RPC edition before trusting the join** (`setId==set_id_onchain` is already verified; the play-level half is the only unconfirmed bit). Persist as a tiny table `(rpc_edition_id uuid, atlas_edition_id text, …)`, refreshed occasionally for new editions. *Fallback:* every listing row carries `nftId` (RPC's indexed moment id), so listing→RPC-edition resolution at write time works even if the edition map is imperfect — but you still need `atlas_edition_id` to *target* the per-candidate query, so build the map.
4. **Cadence/fragility**: Atlas rate-limits (6 rapid probes → HTTP 200 with empty `transactions`). Be gentle: ~1–2 calls/sec, chunk candidates, self-budget under ~250s/run, **resumable cursor** (offset into the candidate list, stored in `pipeline_runs.extra`), multiple runs per full sweep.

---

## Ingest route — `/api/cron/topshot-active-listings-ingest`

- Auth `Bearer INGEST_SECRET_TOKEN`/`CRON_SECRET`. Mirror the **buyer-backfill/tshb** safety pattern — and heed `handoff-2026-06-16-buyer-backfill-maxduration.md`: if you `after()`-wrap, make sure the background work finishes under `maxDuration` (set `maxDuration` with headroom, ≤ 800); a synchronous self-budgeted route is also fine. Log `pipeline_runs` (`pipeline='topshot-active-listings-ingest'`) on every path; support `?dryRun`.
- Per run: resume cursor → next N candidates → resolve each to `atlas_edition_id` → 2 Atlas calls → keep matching #1/perfect rows → `upsert_topshot_active_listings(jsonb)` → advance cursor. At end of a full sweep, call `deactivate_stale_topshot_active_listings('6 hours')`.
- **Headers** (egress confirmed from a plain Vercel server POST — no Worker needed): `connect-protocol-version: 1`, `content-type: application/json`, `Origin: https://dapper.market`, `Referer: https://dapper.market/`, a real browser `User-Agent`.
- **Write mapping**: `serialNumber→serial_number`, `priceCents/100→ask_usd`, `nftId→nft_id`, `uuid→listing_resource_id`, `listedAt→listed_at`; `edition_key` = RPC `external_id`; `listing_url` = a dapper.market deep link. Optionally stash the candidate's `no1_estimate_usd`/`perfect_estimate_usd` into `serial_fmv_usd` at write time (the board recomputes it live anyway).
- **PII**: the row's `seller` object carries `dapperId`(auth0)/`username`/`profileImageUrl` — **store only `sellerAddress`** (the table has no seller column today; if you add one, address-only).

## Operator (after the route ships)
- Add a cron-job.org entry (Bearer `INGEST_SECRET_TOKEN`, **www** host, fire-and-forget 202), low cadence (every 30–60 min). The board is inert until it runs once — same activation pattern as the omni-channel alerts.

## Public surface (after the table fills)
- `/api/public/insights/underpriced-serials` — read `topshot_underpriced_serials_board` via `supabaseAdmin`, mirror `/api/public/insights/serial-premiums` (tier 400-on-invalid, `min_discount`, `headline=no1|perfect`, sort, `limit` clamp ≤100, 15-min `s-maxage`).
- `/insights/underpriced-serials` page + `layout.tsx` (metadata/JSON-LD, param-stripped self-canonical) + OG route + `sitemap.ts` entry. **Run the `rpc-insights-qa` checklist.** Drill-downs: `nft_id → /moment/<id>` + the outbound `listing_url`. Honest empty state (the board can legitimately be empty when nothing's underpriced).

## Alert filters (second payoff, lower priority, higher risk)
- Once the feed exists, wire the saved-but-inert subscription serial filters (`min_serial`/`max_serial`/`require_jersey_serial`/`require_last_mint`/`require_never_sold`/`require_low_ask`) into `build_deal_alerts_for_subscription`. Do after the board ships.

## Guardrails
Atlas spec is capture-verified — **don't re-guess param names** (the serial filter is confirmed absent). Gentle Atlas cadence (it rate-limits). Direct-to-`main`, PowerShell git, full-file writes, `maxDuration ≤ 800`. Insights surface → `rpc-insights-qa`. CC's direct inspection wins over this doc.
