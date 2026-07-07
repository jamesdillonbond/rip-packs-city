# Claude Code — GREENLIT builds (Trevor approved 2026-07-02)

Paste this whole doc to Claude Code. Trevor green-lit **all three** builds below. Each is a real deployed-route / on-chain build that can't run or be verified from an MCP session — build it, commit+push to `main`, deploy, and **verify on the next production run** (not in-session). This supersedes the "gated/optional" framing in `docs/handoff-2026-07-02-FINAL-cc-prompt.md` for these three items.

**Working agreement (non-negotiable):** commit + push directly to `main`, no branches/PRs. `apply_migration` for DDL, `execute_sql` for reads. Run `SELECT public.check_public_security_invariants();` (must stay `[]`) after any migration. Every migration + route gets a revert path. Never hand-write FMV/buyer/jersey values — build the pipeline and let it populate. Windows/Git-Bash caveats apply (PowerShell for Vercel REST; full-file writes). Supabase `bxcqstmqfzmuolpuynti`; AllDay collection `dee28451-5d62-409e-a1ad-a83f763ac070`; TS `95f28a17-224a-4025-96ad-adf8a4c63bfd`; Golazos `06248cc4-b85f-47cd-af67-1855d14acd75`.

Verify each mutating route/worker respects the destructive-op circuit-breaker + logs a `pipeline_runs` row, and put any new pipeline on `pipeline_cadence_watchlist` once it has ≥2 clean ticks.

---

## BUILD 1 — AllDay buyer recovery (deployed route; on-chain) — ✅ SHIPPED 2026-07-06

> **SHIPPED 2026-07-06 (Claude Code).** Built `/api/admin/backfill-allday-buyers` exactly as specced: GET/POST, `Bearer INGEST_SECRET_TOKEN | CRON_SECRET | ?token=`, `maxDuration≤800`, `after()` long walk, self-logs `pipeline_runs` (`allday-buyer-backfill`), cursor in `extra->>cursor_sold_at` (sold_at DESC, recent-first, wraps to walk back). Per row: `decodeV1SaleTx` → `AllDay.Deposit.to` (primary), unambiguous tx-authorizer fallback for V2 Flowty envelopes; UPDATE gated on buyer still unresolved (`NULL` or an intermediary), also fills NULL seller. Fully reversible via `audit_20260706_allday_buyer_backfill` (per-row before-state). Parameterized for **Golazos** (`?collection=golazos`). Two Vercel crons: AllDay `15 */3 * * *`, Golazos `25 6 * * *`. Verify next production run: the 90d gap (`buyer='0x3cdbb3d569211ff3' OR buyer IS NULL`) trends down from 4,882; spot-check recovered buyers on Flowscan against Deposit.to. Revert: `git revert` route+crons; `UPDATE sales s SET buyer_address=a.old_buyer_address FROM audit_20260706_allday_buyer_backfill a WHERE s.id=a.sale_id;` then drop the audit table. (Note: the 07-05 serial recovery was a DIFFERENT column — `serial_number`, not `buyer_address`; this build was genuinely outstanding.)

**Gap (verified live 2026-07-02; re-verified 2026-07-06 = 4,882 in 90d, 299,843 all-time):** 4,068 of 30,807 AllDay 90d sales (13.2%) have an unresolved buyer — **1,579 = Flowty-router `0x3cdbb3d569211ff3`**, **2,489 = NULL**. (Whole-history count is larger; scope the first pass to recent + high-value, then walk back.)

**Why deployed-only:** recovery reads the on-chain transaction result, which needs Flow REST / `spork-proxy` egress (WAF-blocked from MCP). Same decode the forward sales-indexer already does — this is the historical backfill of it.

**Mechanism (already established in the codebase — reuse, don't reinvent):**
- AllDay's real buyer = the `A.e4cf4bdc1751c65d.AllDay.Deposit.to` field (the moment's Deposit recipient). Do **NOT** trust the event's `buyer` for V2 Flowty-fork sales — that's the fee router `0x3cdbb3d569211ff3`.
- For V2 Flowty-fork txs, recover via `fetchTxBuyers` (proposer / authorizers / payer minus `EXCLUDED_ADDRESSES`) — the helper already exists (see `lib/chains/flow/` + the AllDay notes in `CLAUDE.md` → "Per-collection Cadence gotchas / AllDay").
- Trade contract (buyer=contract addr) is `0xedf9df96c92f4595`; AllDay contract `0xe4cf4bdc1751c65d`.

**Build:** a deployed admin route `/api/admin/backfill-allday-buyers` (mirror the drain route's shape + auth: `Bearer INGEST_SECRET_TOKEN | CRON_SECRET`, `maxDuration≤300`, `after()` for the long walk, self-logs `pipeline_runs` pipeline `allday-buyer-backfill`). Per run: select N unresolved AllDay sales (`buyer_address='0x3cdbb3d569211ff3' OR buyer_address IS NULL`, newest first), decode each tx's `AllDay.Deposit.to` (fall back to `fetchTxBuyers`), `UPDATE sales SET buyer_address=<recovered>` where recovered. Idempotent (only touches unresolved rows). Drive it with a daily Vercel cron until the backlog drains, then it no-ops.

**Also:** the same class applies to **Golazos** historical sales (`— —` buyers, contract `0x87ca73a41bb50ad5`, trade contract `0xedf9df96c92f4595`) — parameterize the route by collection or clone it once AllDay is proven.

**Verify (next production run):** `SELECT count(*) FROM sales WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND sold_at>now()-interval '90 days' AND (buyer_address='0x3cdbb3d569211ff3' OR buyer_address IS NULL);` trends down from 4,068; spot-check 3 recovered buyers on Flowscan against the tx's Deposit.to. **Revert:** `git revert` the route + remove the cron; the writes are additive (unresolved→resolved) — to fully undo, restore from a pre-run `audit_*` snapshot if you take one (recommended: back up the touched `(id, buyer_address)` before first run).

---

## BUILD 2 — AllDay jersey backfill → unlocks jersey-match special serials — ❌ DECLINED-SUPERSEDED 2026-07-06 (do NOT build)

> **DECLINED-SUPERSEDED 2026-07-06.** A measurement one day after this greenlight invalidated the premise: **AllDay does not price serial position.** Running the existing serial-FMV fit for AllDay (`compute_serial_fmv_multipliers`/`_power_model`, both already `p_collection_id`-parameterized) returned multipliers ≈ **1.000** for every reliable bucket (a #10/1000 sells the same as a #900/1000), both power models `is_reliable=false` (r≈0.18, n=5-6), and there are only ~54 serial-#1 AllDay sales/365d (vs TS ~1,786). BUILD 2's entire purpose was to "unlock jersey-match special serials" — but with no serial premium there is nothing to unlock, and the `allday_special_serial_owners` board (shipped `8e967e8`) already hides the jersey tag for AllDay by design. `editions.jersey_number` stays 0/6190 for AllDay intentionally. Memory `[[allday-no-serial-premium-and-data-limited-fmv]]`. **Do not build the AllDay jersey backfill, an AllDay serial-FMV model, or "extend ingest" for AllDay FMV — the data isn't there.**

**Gap (verified live; still 0/6190 by design as of 2026-07-06):** `editions.jersey_number` is **0/6191** for AllDay (`players.jersey_number` also 0/1517). TopShot uses `editions.jersey_number` as the canonical source for the jersey-match leg of special serials, so AllDay currently can't surface jersey matches at all.

**Source (pick one; studio GQL is more accurate):**
- **(preferred) AllDay studio-platform GraphQL** — the per-moment metadata carries the player's jersey for that play. Same worker/proxy path as the AllDay studio history ingest (WAF-blocked from MCP → must run from the worker/deployed route). This gives the *moment's actual* jersey, season-correct by construction.
- **(fallback) NFL-roster dataset** keyed by `(player, season)`. Cheaper but season-sensitive — **players change numbers between seasons**, so you MUST key jersey to the edition's season (`editions.series` / `game_date`), never just the player, or you'll mis-tag.

**Build:** a `backfill-allday-jersey` pipeline (route or worker, `pipeline_runs` logged) that resolves jersey per edition and `UPDATE editions SET jersey_number=<n>` for AllDay. The existing special-serials RPC then picks up jersey matches automatically (no RPC change — mirrors the TS path; jersey-perfect = serial == jersey_number). Daily/one-shot cron.

**Verify:** `editions.jersey_number` non-null coverage for AllDay rises from 0; the AllDay special-serials surface shows jersey matches; spot-check a known case (e.g. a QB whose #serial == his jersey). Sanity: jersey ceiling is ~18% of editions having any in-print jersey match — a plausible coverage, not 100%. **Revert:** back up `(edition_id, jersey_number)` (all NULL now, so revert = set back to NULL for the touched rows) + `git revert` the pipeline.

---

## BUILD 3 — P8 conflict-resolver for the 169 (deployed route; on-chain) — ✅ APPEARS DONE (verify first)

> **UPDATE 2026-07-07: corrupt moments = 0 (verified live) — this build appears already done.** The 169 cleared since the 07-02 fire (re-keyed off the `::` editions; circ unchanged, remaining serials all ≤circ — a legit resolution, not a circ-fudge). **Verify before building:** run the detector below — if it's 0, SKIP this build (a conflict-resolver already ran, or the `getMintedMoment` unmapped-drain resolved them). If it's climbed back, build the resolver as specced below. Minor: watch `impossible_parallel_sales` (was 0, ticked to 1 — under the sentinel's breach-3).

**State (historical):** the F1 writer is fixed (`1cd46de`), the drain was fired (174 resolved), and **169 corrupt moments remain — ALL genuine on-chain conflicts** (verified 169/169: the moment's true base slot `(base_edition, serial)` is already occupied by a *base* moment; 0 free, 0 parallel-cascade). The drain (`?p8=1&rekey=1`) **cannot** clear these — its free-slot-safe remap defers them (`moments_deferred_conflict`) and re-firing no-ops (`targets_exhausted`), because it never overwrites an occupied slot. This is display-only (sales/deal/EV boards clean; the `topshot_impossible_parallel_serials` sentinel is 0/ok) — LOW, but Trevor green-lit clearing it.

**The conflict:** for each of the 169, two distinct nfts resolve to the same base `(set:play, serial)` — the corrupt moment's nft (currently on a `::` parallel) and the occupant (currently on base). Exactly one is truly that base serial; the other is genuinely something else (a different parallel, or a different serial). **Resolve BOTH on-chain, then place each on its true edition — never overwrite blindly** (that re-introduces the conflation the `::`-split fixed).

**Build (extend the existing drain, reuse its on-chain map):**
1. For each deferred conflict, `getMintedMoment` the **occupant** nft too (not just the corrupt one) via topshot-proxy, and write it into `topshot_misattrib_onchain_map` (already 21,973 rows). Now both sides' true `(setID, playID, parallelID, serial)` are known.
2. Re-key each nft to its **true** edition (base `setID:playID` or `::parallelID`): if the occupant is itself mis-attributed (its true edition ≠ where it sits), move it first → frees the slot → then place the deferred moment. If the corrupt moment's true edition is actually a *different* `::` parallel (not base), move it there and leave the occupant.
3. **Iterate** — moving an occupant can create a downstream conflict; loop until stable or only genuinely-irreconcilable pairs remain (a true on-chain duplicate serial would be a real Dapper data anomaly — log it, don't force).
4. Do it in `remap_topshot_from_onchain_map()`'s free-slot-safe style but with the occupant-resolution step added; keep everything reversible via per-row `audit_*` tables (mirror `audit_topshot_moment_drain_remap_20260621`).

**Verify:** corrupt-moments detector → 0 (or only a tiny irreconcilable-on-chain-dupe residual, itemized): `SELECT count(*) FROM moments m JOIN editions e ON e.id=m.edition_id WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id ~ '::' AND e.circulation_count>0 AND m.serial_number>e.circulation_count;` Also confirm `impossible_parallel_sales` stays 0 and `check_public_security_invariants()` `[]`. **Revert:** restore from the `audit_*` re-key tables.

---

## Not greenlit — P5 (Pinnacle Pack EV) stays GATED
Build only when Pinnacle drops another pack AND Trevor greenlights (payoff ≈ 0 today — one pack drop ever). Spec: `docs/handoff-2026-07-01-pinnacle-pack-ev-measured-finding.md` (supply-weighted `∝ total_supply`; uniform is 531× wrong — never ship it).

## Already done (do NOT redo)
P1/P2/P3/P6/P7 shipped; F1 sales class fully guarded (4 writers) + `topshot_impossible_parallel_serials` sentinel (detector 0); P8 writer guard (`1cd46de`) + 288 non-collider redirect + the 174-resolved drain; Item 2 AllDay circ-weighted Pack EV (v8/`107a897`); Item 5/7 Pinnacle enrichment; P4(c) AllDay username tail (backlog 1, resolver healthy — do not "raise batch", nothing to drain). Full evidence: `docs/handoff-2026-07-02-claude-code-remaining.md`.
