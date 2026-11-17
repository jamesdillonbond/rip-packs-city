# UFC Strike has recorded ZERO sales for 96 days, and `ufc-sales-indexer` reports 112/113 ok while writing 0 rows

Filed 2026-08-17 15:10 PT / 22:10Z (Claude Code, interactive). Surfaced while fixing the cold-tail drain's
collection-blind phantom guard — **a separate and larger question, deliberately not folded into that fix.**

## The state

| fact | value |
|---|---|
| newest UFC sale in `sales` | **2026-05-13 17:06:58Z** (96 days ago) |
| UFC sales in last 30 d / 90 d | **0 / 0** |
| UFC sales total (historical) | 813,934 |
| `ufc-sales-indexer`, 7 d | **113 runs, 112 ok, 0 rows written** |
| `ufc-sales-history-backfill`, 7 d | 27 runs, 27 ok, **0 rows written** |
| `ufc-studio-sales-history-backfill`, 7 d | 3 runs, 3 ok, **0 rows written** |

Three independent UFC sales pipelines, all reporting success, all writing nothing, for at least a week —
against a collection whose last recorded sale is over three months old.

## Why this is NOT self-evidently a bug

⚠ **State the honest alternative first, because it is plausible and it decides the whole disposition.**
UFC Strike may simply be **dormant** — the collection wound down, the marketplace is quiet, and an indexer
that correctly finds nothing is *supposed* to write nothing. On that reading all three pipelines are
healthy and `rows_written = 0` is the correct output of the correct input.

⚠ **This is exactly the documented `rows_written = 0` null instrument** — three incompatible meanings
(correct-and-broken, wrong-and-healthy, correct-and-failing) — and the standing rule is to read `extra` and
`last_error`, never `rows_written`. **I did not do that here**; this filing reports the shape, not a verdict.

## ✅ UPDATE, same session — step 2 below WAS run, and it largely resolves this in the indexer's favour

Read `ufc-sales-indexer`'s `extra` rather than its `rows_written`, per the standing rule. **The indexer is
healthy and the market looks genuinely dormant:**

| signal (two consecutive runs) | value |
|---|---|
| `blocks_scanned` | **1,347** and **2,986** — the cursor is advancing, not wedged |
| `raw_v1_events` | 5 and 40 — it IS finding sale events |
| `v1_non_ufc` | **5 and 40** — i.e. *every* event found was correctly rejected as non-UFC |
| `raw_v2_dapper_events` | 52 and 208 |
| `v2_dapper_typeids_seen` | `TopShot.NFT`, `AllDay.NFT`, `Pinnacle.NFT`, `Golazos.NFT`, `PackNFT.NFT`, `MFLPack.NFT` — **no UFC type id at all** |

⚠ **That is a genuine POSITIVE CONTROL, which is why it is worth more than the zero:** the indexer observes
other collections' sales in the very same scans, so it is demonstrably not blind, not wedged, and not
mis-filtering. A broken indexer and a dormant market both produce `rows_written = 0`; **only the positive
control separates them**, and it points at dormancy.

**Revised disposition: this is very likely NOT an engineering bug.** UFC Strike appears genuinely dormant
on-chain. The remaining action is a **product/positioning decision** — whether a collection with no trades in
96 days should still be presented as one of the five live collections — plus a dormancy note or suppression so
`ufc_fmv_stale_hours` stops reading as an unfixed fault.

⚠ **Residual uncertainty, stated rather than closed over:** `raw_v2_flowty_events` is **0** in both samples.
That is across ALL collections, so it is probably a quiet window rather than a UFC-specific gap — but it means
this control covers the Dapper/v1 venues, **not** Flowty. If UFC trades anywhere the indexer does not watch,
the control would not see it. The one upstream query below still closes that gap definitively.

## The decisive test, which I did not run

**Does the UFC marketplace have ANY sale after 2026-05-13?** One check against the upstream source
(Flowty / the UFC Strike marketplace API) answers it:

- **Upstream shows sales after 2026-05-13** ⇒ the indexer is silently broken. Its cursor or its query is
  wedged, and `ok: true` is masking it. That would also mean the platform has been serving a 5-collection
  claim on 4 live collections.
- **Upstream shows nothing either** ⇒ the collection is genuinely dormant, all three pipelines are correct,
  and the right action is a **suppression or a documented dormancy note**, not a fix — plus a decision about
  whether UFC should still be presented as a live collection.

⚠ **Do not skip straight to "fix the indexer."** The two outcomes point at opposite actions, and one of them
is a product/positioning decision rather than an engineering one.

## What it already changes, regardless of which answer

- **The cold-tail drain fix shipped today gives UFC `ASK_ONLY` / `STALE` prices, not current ones** — 316 UFC
  editions currently carry `fmv_usd = NULL` at ~76 days old. That fix improves *coverage*; it cannot improve
  freshness while no sales arrive. Do not let a greener FMV-coverage number be read as UFC recovering.
- ⚠ **`ufc_fmv_stale_hours` is a trust arm on a collection with no sales.** If it is breached, it is breached
  for a reason no ingest fix can clear, which is the "training the operator to skim" cost this repo has
  already paid once.
- **No UFC pipeline is on `pipeline_cadence_watchlist`**, so a genuine indexer failure here would page nothing —
  the same structural gap found on `sync-nba-projections` and `topshot-wmc-fossil-drain` this week. That is
  now **three** unwatched pipelines found by three unrelated investigations, which suggests the watchlist's
  membership was never derived from a complete enumeration.

## Cheap next steps, in order

1. One upstream query for UFC sales after 2026-05-13 (decides everything above).
2. Read `ufc-sales-indexer`'s `extra` / cursor — is it advancing, or pinned at a date near 2026-05-13?
   A cursor frozen at the last real sale looks identical to "no new sales" from the outside.
3. Only then: fix, suppress, or document dormancy.
