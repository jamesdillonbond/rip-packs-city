# ✅ FALSIFIER PASS 18:55Z — leg 324 fired, the arm CLEARED to 11.84. ⏰ The predicted RE-BREACH at ~20:07Z is still ahead.

Cowork **cloud** session, 2026-08-16 18:55Z / 11:55 PT.

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally. **Commit as usual.**

## The falsifier, as set at 16:15Z

**PASS.** Both halves landed where predicted:

| | predicted (16:15Z) | measured (18:55Z) |
|---|---|---|
| jobid 324 fires | ~18:48Z | **18:48:00.63Z, `succeeded`, 6 m 06.5 s** |
| arm clears | yes, max becomes leg 325 at **~11.7 h** | **11.84** vs breach 13 → **`ok`** |

The failure condition — *"still ~15.9 h and no 324 run since 15:08Z"* — did **not** occur. **The 15:08Z eight-leg split is working.** Six of eight legs have now fired since the split, all `succeeded`.

## ⏰ STILL AHEAD — do not treat this as a regression

The arm is expected to **RE-BREACH from ~20:07:21Z to ~20:48Z** (13:07–13:48 PT). Leg **326 `rpc_thp_leg_board_liveness`** last wrote at **07:07:21Z** — a pre-split timestamp — and crosses 13 h at exactly 20:07:21Z, but does not fire until **20:48Z** (`48 2,8,14,20 * * *`). Between those two moments the arm reads **13.0 → 13.7**.

⛔ **Do NOT revert the split, re-point the arm, or open an incident on that reading.** It is the last pre-split timestamp ageing out. Green for good after ~20:48Z, at a steady-state max of ~5.7 h.

ⓘ Intermediate step: leg **325 `fmv_coverage`** is the current max at 11.85 h and fires at **19:48Z**, dropping to 0. It stays under 13 throughout (12.72 h at its own fire time), so the window between 18:48Z and 20:07Z should read green.

## ⚠ A correction to what I shipped 80 minutes ago — one warm timing is not a cost

The 17:38Z filing and the first patch quoted the full-pass cost as **928,611 ms**, from a single observation. **That was one sample presented as a constant** — the exact habit this repo's memory flags. Second full observation at 18:55Z:

| leg | obs A (17:38Z) | obs B (18:55Z) |
|---|---:|---:|
| `impossible_parallel` | 421,471 | **366,500** |
| `serial_supply` | 164,763 | 164,763 |
| `pinnacle_fmv_share` | 128,777 | 128,777 |
| `fmv_coverage` | 121,225 | 121,225 |
| `pack_ev` | 75,080 | 68,726 |
| `panini` | 12,468 | 9,489 |
| `fmv_sanity` | 4,707 | 4,707 |
| `board_liveness` | 120 | 120 |
| **TOTAL** | **928,611** | **864,307** |

**The conclusion strengthens rather than weakens: 864–929 s against a 600 s single-statement budget — 44–55% over on BOTH observations.** The monolith's incapacity does not rest on one timing. `impossible_parallel` swings 13% run to run and is still **42–45% of the whole pass**.

**The patch on disk (`freshness-view-applied-2026-08-16.patch`) has been regenerated with the range.** Same filename, same comments-only change, SQL still byte-identical (md5 `f3c8337f…` unchanged). **Use the current copy** — if the earlier one was already applied, the difference is comment text only.
