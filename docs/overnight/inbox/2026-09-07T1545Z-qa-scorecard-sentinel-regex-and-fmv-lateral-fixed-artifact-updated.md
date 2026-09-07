# `rpc-qa-scorecard` FIXED — the Sentinel card's pre-subedition regex (608 false amber → 0) and, found on contact, the FMV card's per-edition `LIMIT 1` lateral (77K → 16K buffers)

*Cowork (Trevor's laptop), 2026-09-06 ~16:45 PT, artifact published on Trevor's approval ~19:42 PT; this filing stamped 2026-09-07 08:45 PT (DB clock) · ARTIFACT-ONLY ship — no code, no DB, no schema · push skipped (Trevor declined the device flow), so this file is the ledger record until a pushing session splices it. Resolves inbox `2026-09-06T0315Z-qa-scorecard-sentinel-card-uses-a-pre-subedition-regex-and-flags-608-valid-rows.md`.*

## Ledger entry (splice verbatim at the first `^### ` of `docs/overnight/ledger.md`, under 2026-09-06)

### 2026-09-06 · ✅ `rpc-qa-scorecard` — Sentinel card allows the `::subedition` external_id format (608 valid rows were amber), FMV card reads `edition_fmv_current` instead of a 77K-buffer lateral · Cowork (Trevor's laptop), Trevor: "work on what you can"

**Found (inbox `2026-09-06T0315Z`, confirmed live):** the artifact's `sentinel` leg used `^[0-9]+:[0-9]+$` where `rpc_ops_snapshot()` / `rpc-live-health` use `^[0-9]+:[0-9]+(::[0-9]+)?$`; strict 563 vs canonical **0** at 23:44Z on the same rows, every flagged row a well-formed `setID:playID::subeditionID`. **Found on contact:** the `fmv` leg was the R50-class shape (`editions CROSS JOIN LATERAL (… fmv_snapshots_2026 … ORDER BY computed_at DESC LIMIT 1)`) — **77,203 buffers / 4.73 s** (11,480 heap fetches) for 20,441 TS editions.

**Shipped (artifact `rpc-qa-scorecard`, `update_artifact`):** `sentinel` regex aligned to the canonical one (card detail now names the rule); `fmv.hm` = `count(*) FROM edition_fmv_current WHERE collection_id = TS AND confidence IN ('HIGH','MEDIUM')` — **16,181 buffers / 0.42 s**, hm 7,687 vs the lateral's 7,689 (FMV drift, not a defect); `fmv.fresh` = `max(computed_at) FROM fmv_snapshots_2026 WHERE collection_id = TS` (**5 buffers**, the true last write — deliberately NOT the denorm's `computed_at`, which lagged it by 40 min and would false-amber the 60-min gate). Both cards now `throw` on a missing count instead of rendering `0` (the `Number(x)||0` shape). Verified by the artifact's own render: `sentinel.n = 0`, `fmv.hm = 7441`, payload 1.7 s warm; the other seven cards unchanged.

**Not changed, noted:** the `offsan` card reads `v_offer_sanity_flags` (1,254 rows, 788 `gql_blank_chain_has`, rank info) and its copy says the gap "self-clears as the offers-sweep GREATEST-raises" — with the GQL host dead since ~08-28 that leg may now be a permanently-info instrument; not measured this pass.

**Revert:** `update_artifact` with the prior body (the 2026-06-25 version: strict regex on line 127, the lateral on lines 123–125). Nothing else reads the artifact's SQL.

## Also this session (read-only, from the 11:00 PT `panini-freshness-check`)

Panini ✅ — 6/6 walks, 1,592 editions/24h, yesterday 22.9 % of the 4,911-edition catalogue (168 % of the 8–28 d baseline). Enumeration now stops on `budget` at 141–158 grid pages with `wc_share_pct` ~33–34 % (well under the ~48 % page-1 read) — the cardset-scoped grid URL remains the eventual lever, NOT pulled: throughput is above baseline and the runner is a single point of Panini ingest with no syntax-check path from Cowork. 09-04 was a weak day (487 editions, three short walks) and fully recovered — one-off, not a pattern.

## INDEX.md

Add under `## 2026-09-07`:

- [✅ **`rpc-qa-scorecard` FIXED — Sentinel card regex (608 → 0) and the FMV card's 77K-buffer lateral, artifact-only**](2026-09-07T1545Z-qa-scorecard-sentinel-regex-and-fmv-lateral-fixed-artifact-updated.md) — *(Cowork, Trevor's laptop. SHIPPED to the artifact; ledger entry inside, unpushed — splice it.)*
