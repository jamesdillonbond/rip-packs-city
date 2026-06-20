# RPC Claude Code handoff — extend the conflation interim guard to the public serial/premium boards (2026-06-20)

Surface/view logic → low-risk, mirrors the guard CC already shipped on `cross_collection_deals_board`. Read-only findings below (measured Cowork 2026-06-20). All of this SELF-HEALS once Stage B (historical subedition remap) re-keys parallels — this is purely an interim cleanup for the ~weeks until then.

## Context

CC guarded `cross_collection_deals_board` against `topshot_conflated_editions` (741 flagged) so the Traoré-class fake deals stopped reaching the board/alerts. But the OTHER public, edition-keyed FMV/serial surfaces were NOT guarded and are still exposed to the same parallel-conflation contamination (a "#1" or "perfect" serial is ambiguous when 2+ parallels share one setID:playID key).

## Exposure measured (rows on conflated editions)

| Board (public route) | rows | on conflated | % | harm |
|---|---|---|---|---|
| `topshot_serial_premiums_board` (/insights/serial-premiums) | 305 | 245 | **80%** | #1 premium blends parallels |
| `topshot_underpriced_serials_board` (/insights/underpriced-serials) | 16 | 4 | 25% | fake "underpriced #1" deal signals |
| `topshot_perfect_mint_premiums_board` | 11 | 2 | 18% | perfect-serial premium blends |
| `topshot_squeeze_board` (/insights/squeeze) | 9,102 | 730 | 8% | circ-vs-holdings skew |
| `special_serial_targets` (internal) | 44,269 | 1,632 | 3.7% | feeds owners/serial work |

Mechanism on the serial-premiums board: `premium_multiple = no1_last_sale_usd / edition_median_usd`. On a conflated edition both legs blend parallels — `no1_last_sale_usd` picks ONE parallel's #1 (Standard or Jukebox/Hexwave, whichever sale is tagged serial 1), and `edition_median_usd` blends all parallels' sales. So the multiple + which-parallel attribution are unreliable. The DIRECTIONAL signal (#1s carry trophy premiums) is still real — e.g. LeBron "Top Shot This: Playoffs" 245:8426 shows #1 $3,064 vs $2 median (1532×), plausibly a real #1-trophy premium but computed on a conflated edition.

## Recommended interim treatment (per board)

- **`topshot_underpriced_serials_board` — SUPPRESS conflated rows.** It's a DEAL surface; fake "underpriced #1" signals cause real bad buys (the exact Traoré class). Add the same `AND NOT EXISTS (SELECT 1 FROM topshot_conflated_editions c WHERE c.edition_id = <board>.edition_id)` guard CC used on the deal board. Only 4 rows drop.
- **`topshot_serial_premiums_board` + `topshot_perfect_mint_premiums_board` — CAVEAT, don't suppress (product call).** Suppressing would gut 80% of the serial-premiums board, and the directional #1-premium signal is real. Preferred: a board/UI note ("Editions with multiple parallels blend subeditions; precise per-parallel premiums land after the subedition split") + optionally a per-row "parallel'd" badge keyed on `EXISTS topshot_conflated_editions`. If Trevor prefers a smaller-but-clean board, exclude conflated rows instead. Trevor's call on suppress-vs-caveat.
- **`topshot_squeeze_board` — note/monitor only.** 8% exposure, different metric (lock/burn vs circulation); revisit post-Stage-B. Don't change now.
- **`special_serial_targets` — no action.** Internal; the Stage B owners rebuild covers it.

## Guardrails
- These are public `/insights/*` surfaces — rpc-insights-qa applies. A WHERE-filter / caveat change doesn't touch backing-view security, but the boards are `security_invoker` views: a CREATE OR REPLACE preserves grants — re-verify `check_public_security_invariants()` = 0 and `check_secdef_anon_execute_violations()` = [] after, and smoke the routes. Don't alter sitemap/canonical/OG.
- Read-only verify the exposure counts before + after (the per-board query is in this session's transcript). All boards self-heal after Stage B; consider deleting the interim guards then.
- Direct-to-main, PowerShell git, rev-list 0, tsc clean.
