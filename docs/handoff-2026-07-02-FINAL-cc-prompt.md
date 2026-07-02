# Claude Code — final remaining work after the 2026-07-01/02 audit

Paste this whole doc to Claude Code. Everything from the audit is shipped and verified **except the three items below**. The detailed history lives in `docs/handoff-2026-07-02-claude-code-remaining.md` + the ledger — this is the tight, do-it list.

**Working agreement (non-negotiable):** commit + push directly to `main`, no branches, no PRs. `apply_migration` for DDL, `execute_sql` for reads. Run `SELECT public.check_public_security_invariants();` (must stay `[]`) after any migration. Verify each item live before calling it done. Every migration gets a revert path. Supabase project `bxcqstmqfzmuolpuynti`; TS collection `95f28a17-224a-4025-96ad-adf8a4c63bfd`; AllDay `dee28451-5d62-409e-a1ad-a83f763ac070`. Never hand-write FMV values.

---

## 1. P8 — F1 collider moments — DRAIN FIRED ✅, 169 on-chain-conflict residual (LOW; optional)

> **FIRED 2026-07-02** (`?p8=1&rekey=1`): **174/174 resolved on-chain** (0 GQL fail), 77 sales + 7 moments re-keyed, corrupt moments **176 → 169**. Health green after: `check_public_security_invariants()` `[]`, impossible *sales* 0, `topshot_impossible_parallel_serials` sentinel ok. **The 169 that remain are genuine on-chain CONFLICTS** — every one's true base slot `(base_edition, serial)` is already occupied by a *base* moment (verified: **169/169 occupied-by-base, 0 free, 0 parallel-cascade**), i.e. two distinct nfts resolve to the same base serial, so the free-slot-safe remap correctly declined to overwrite (`moments_deferred_conflict`). **This is display-only + static** (writer guarded → no growth; sales/deal boards unaffected; sentinel watches sales). **Re-firing `?p8=1` now no-ops (`targets_exhausted`).** Fully resolving the 169 is OPTIONAL and needs a careful **on-chain conflict-resolver**: for each conflict, `getMintedMoment` BOTH nfts, decide the true owner of that base serial, and move the loser to *its* true edition — never overwrite blindly (that would re-introduce the conflation the `::`-split fixed). Otherwise leaving the 169 quarantined is acceptable. The original context + fire instructions are kept below for reference.

**State (historical — writer fixed + drain built):** the F1 parallel-mis-attribution *writer* is fixed and verified — `topshot-moments-hydrator`'s `resolveEditions()` was landing Standard moments on `::` parallels because the 2026-06-20 subedition catalog cloned base on-chain ids onto every parallel (non-unique `(set_id_onchain, play_id_onchain)` → PostgREST row-order wins), and CC guarded the write chokepoint `replace_topshot_moments_batch` (`1cd46de`) → **0 new corrupt since 21:02Z**. The **288 non-collider** corrupt moments were already reversibly redirected to base (`audit_20260702_rekey_noncollider_corrupt_moments`). What's left is **176 colliders** whose base `(edition_id, serial_number)` slot is already claimed, so table inference can't place them — they need on-chain `getMintedMoment`.

**Fastest close (operator, one command — Trevor can run this himself):**
```
GET https://www.rippackscity.com/api/admin/drain-topshot-misattribution?p8=1&rekey=1
Authorization: Bearer <CRON_SECRET | RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
```
One `maxDuration=300` run covers all 176; the route resolves each nft via the topshot-proxy, writes `topshot_misattrib_onchain_map`, and `remap_topshot_from_onchain_map()` re-keys free-slot-safely (defers any genuine conflict as `moments_deferred_conflict`, never guesses).

**If you want it hands-off (CC):** add a **one-shot** Vercel cron to `vercel.json` for `/api/admin/drain-topshot-misattribution?p8=1&rekey=1` (Vercel injects `Bearer CRON_SECRET` automatically), let it fire once, then remove the cron object + redeploy. Do NOT leave it recurring (finite backfill; it no-ops once drained).

**Verify → 0 (or only genuine `moments_deferred_conflict` left):**
```sql
SELECT count(*) FROM moments m JOIN editions e ON e.id=m.edition_id
WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e.external_id ~ '::' AND e.circulation_count>0 AND m.serial_number>e.circulation_count;
```
**Revert:** the non-collider redirect via `audit_20260702_rekey_noncollider_corrupt_moments`; the on-chain remap via the existing `audit_topshot_moment_drain_remap_20260621` / `audit_topshot_sale_drain_remap_20260621` tables. **If you'd rather not fire it, leaving the 176 quarantined is acceptable** — it's display-only (a moment shows under the wrong parallel), invisible on the sales/deal boards, and the `topshot_impossible_parallel_serials` sentinel watches the *sales* class (currently 0/ok).

---

## 2. P4 — AllDay enrichment (LOW; needs external data + deployed proxy routes)

All three legs need a deployed, proxy-credentialed route (Cloudflare WAF blocks Cowork/MCP egress), so they can't run from an MCP session. Ship by priority:

**(a) Jersey-match special serial — `editions.jersey_number` is 0/6191 for AllDay (verified live).** `players.jersey_number` is also empty. Source jersey numbers from the AllDay studio-platform GraphQL (per-moment metadata; same worker path as the AllDay studio history) or an NFL-roster dataset keyed by (player, season), build a `backfill-allday-jersey` pipeline that populates `editions.jersey_number`, and the existing special-serials RPC picks up jersey matches automatically (mirrors the TopShot jersey path). Watch the season nuance: NFL players change numbers, so key jersey to the edition's season, not just the player.

**(b) Buyer recovery — 4,068 of 30,808 AllDay 90d sales (13.2%) have an unresolved buyer (verified live): 1,579 = Flowty-router `0x3cdbb3d569211ff3`, 2,489 = null.** Recover the real buyer via `fetchTxBuyers` / a forward-`Deposit` scan — AllDay's real buyer is `A.e4cf4bdc1751c65d.AllDay.Deposit.to` (do NOT trust the contract-address parenthetical for V2 Flowty-fork sales). Run from a deployed route with proxy creds. The same class applies to Golazos historical sales (`— —` buyers).

**(c) Username-resolver tail — operational.** Raise the `wallet-username-resolver` batch size / frequency and prioritize high-value + parallel buyers (TS is ~97.7% resolved; the tail skews to parallel buyers). This one is a cron/param tweak, not a build.

---

## 3. P5 — Pinnacle Pack EV (GATED — build only when Pinnacle drops another pack AND Trevor greenlights)

Fully investigated (`docs/handoff-2026-07-01-pinnacle-pack-ev-measured-finding.md`): the source (`searchDistributions` GraphQL) works, the **supply-weighted** model is validated ($4.99 pack → ~$27.87 EV / 5.6×), and **uniform is garbage (531× on parallels — never ship it).** But Pinnacle has had **exactly one pack drop ever ("Summer Splash", mostly sold out)**, so the payoff is ~zero today — the value is auto-coverage of the *next* drop. When greenlit: Pinnacle pack indexer → `pack_distributions` + pool with supply-weighted (`∝ total_supply`) drop weights, group facets into the parent pack by title+price, flag `low_confidence` on ASK_ONLY/thin parallels, then add the Packs tab. Reasonable to defer until Pinnacle drops packs again.

---

## Everything else — DONE this engagement (do NOT redo)
P1 fake-deal de-fake (display guard `dc8e103` + market-key `c5ed36d` + model clamp `78501ba`), P2 AllDay cross-source dedup trigger (`6b7cda1`), P3 UFC ipfs proxy (`249d580`), P6 buyback names (`27a0d07`), P7 offer_fill writer guard (`61f5a7c`), the F1 sales class (4 writers guarded, detector 0) + the `topshot_impossible_parallel_serials` trust-health sentinel, Item 2 AllDay circulation-weighted Pack EV (edge fn v8 / `107a897`), Item 5/7 Pinnacle enrichment (`7fb73d5`/`9052976`), and the P8 writer guard + 288-non-collider redirect. Full evidence: `docs/handoff-2026-07-02-claude-code-remaining.md`.
