# 🚨 R50's numbers are measured at the FASTEST hour — the liveness probe samples 4 fixed slots, 42 % of them at 00Z, and latency is **5× worse at 18Z**

**Filed 2026-08-27 19:3xZ PT (2026-08-28 02:3xZ) by Claude Code, cloud session (push-capable).**
Qualifies **R50** (*11 public board views run persistently over their own latency budgets*) and explains
why **R6**'s owed degraded-band re-measure cannot be answered from existing history.

⛔ **NOTHING SHIPPED.** Read-only. ⛔ **R50's own instruction still stands: do NOT raise the budgets.**
This finding makes that instruction stronger, not weaker.

---

## 1. The probe does not sample the day

`public_board_liveness_history` looks like a 12-day distribution. It is **four fixed hours**, sampled
unevenly:

| hour (UTC) | samples | days | share |
|---:|---:|---:|---:|
| **00** | **810** | 18 | **42 %** |
| 06 | 562 | 13 | 29 % |
| 18 | 296 | 11 | 15 % |
| 12 | 248 | 8 | 13 % |

⭐ **42 % of every sample R50 pooled comes from 00Z**, and there are no samples at any other hour.

## 2. And the hour dominates the reading

| hour | n | p50 | p90 | avg |
|---:|---:|---:|---:|---:|
| 00 | 810 | **126 ms** | 5,633 | 2,956 |
| 06 | 562 | 323 | 19,109 | 7,783 |
| 12 | 248 | 442 | 41,301 | 16,306 |
| 18 | 296 | **520 ms** | **42,441** | **19,994** |

**p50 ×4.1, p90 ×7.5, mean ×6.8** from the best hour to the worst — monotonically.

## 3. ✅ The paired control — this is not a day-mix artifact

The hours were sampled on different numbers of days (18 vs 8), so a naive hour split could just be
reading a different mix of good and bad days. Controlled **within subject**: only days that sampled
**both** 00Z and 18Z, compared **board by board, day by day**:

| | |
|---|---:|
| paired samples (same board, same day) | **296** |
| boards · days | 45 · 11 |
| **slower at 18Z** | **273 (92.2 %)** |
| faster at 18Z | 23 (7.8 %) |
| p50 | **101 ms → 520 ms (5.1×)** |

**Within the same day and the same board, 18Z is slower 92 % of the time.** The gradient is real.

## 4. 🚨 So R50 understates its own finding

Per-board, the over-budget share climbs monotonically with the hour. R50's pooled figure sits between
the 00Z and 06Z values, because that is where the samples are:

| board (budget 8,300 ms) | 00Z | 06Z | 12Z | 18Z | **R50 pooled** |
|---|---:|---:|---:|---:|---:|
| `allday_scarcity_board` p50 | 14,922 | 19,109 | 25,651 | **169,448** | 23,429 |
| …% over budget | 61 % | 85 % | 88 % | **91 %** | 86.1 % |
| `candy_pack_market` p50 | **3,661** | 16,064 | 42,555 | 25,865 | 16,064 |
| …% over budget | 28 % | 77 % | 88 % | **90 %** | 80.0 % |
| `topshot_set_squeeze_board` % over | 28 % | 50 % | 50 % | **80 %** | 30.8 % |

⭐ **`allday_scarcity_board`'s p50 at 18Z is 169 seconds — 20× its budget and 11× its own 00Z p50.**
R50 called it the highest-value single target on a pooled p50 of 23.4 s; **that call is confirmed and
the gap is far larger than the number it was made on.**

⚠ **Note `candy_pack_market` is UNDER budget at 00Z (3,661 ms)** — a board can look healthy and be 90 %
over at 18Z. **A single-hour reading of any of these boards is not evidence of health.**

## 5. What this does and does not change

- ✅ **Corroborates #42's "the hour decides the outcome" from a completely independent instrument.**
  #42 measured pg_cron busy time and timeout waste; this measures public board view latency. Two
  instruments, same conclusion — not one instrument read twice.
- ✅ **Strengthens R50's "do NOT raise the budgets".** The budgets are not merely too tight; the same
  board meets them at 00Z and misses by 20× at 18Z, so no single threshold can be right for both.
- ⛔ **Does NOT establish user-facing latency, and R50's refusal to claim it still stands.** These pages
  are ISR; a visitor gets a cached render and the cost lands on regeneration and the production build.
- ⛔ **Does NOT answer R6.** `get_collection_stats` is not in this table at all, and the probe never
  samples 16:20–18:05Z, so **R6's owed degraded-band re-measure cannot be served from history** — it
  still needs a live reading inside the band.

## 6. ⚠ Limitations

- **Per-cell n is small** (4–18). The strength is the *monotonicity across 4 boards × 4 hours* and the
  296-pair control, not any single cell.
- **`err` is NULL on all 2,916 samples**, so this says nothing about failures — only latency.
- **Why 18Z is worst is not established here.** It is consistent with the instance's structural IO
  saturation (R46), but this measurement does not attribute cause.

## 7. Revert path

Docs only.
