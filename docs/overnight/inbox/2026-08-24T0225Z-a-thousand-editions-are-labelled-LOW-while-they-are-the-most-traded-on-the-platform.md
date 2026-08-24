# 🚨 ~1,000 editions are labelled **LOW confidence** while their own row records them as the **most-traded editions on the platform** — in every collection, the LOW cohort trades ~2× the MEDIUM cohort

**Filed:** 2026-08-23 ~19:25 PT (2026-08-24 02:25Z) · **By:** Claude Code, interactive · **Status:** MEASURED, read-only. Nothing shipped — this is FMV route logic, off-limits to autonomous change, and one reading of it is a *display* bug rather than a pricing one. **The discriminator is named at the bottom and it is one debug read.**

This came out of the bounded question left by the [22:05Z accuracy capture](2026-08-23T2205Z-priority-1-captured-wau-is-zero-and-the-accuracy-gate-is-30-percent.md) §6.
It is bigger than that question was.

## The measurement

Rows on the current algo (`algo_version = '1.7.0'`) whose own `fmv_current.sales_count_30d` is **≥ 5** — the
documented MEDIUM volume floor — grouped by the confidence actually published:

| collection | **LOW** | avg count | MEDIUM | avg count | HIGH | avg count |
|---|---:|---:|---:|---:|---:|---:|
| `nba_top_shot` | **499** | **28.9** | 4,108 | 15.2 | 2,119 | 14.0 |
| `nfl_all_day` | **454** | **15.6** | 992 | 9.3 | 184 | 9.4 |
| `candy_mlb` | 44 | **48.1** | 71 | 38.9 | 9 | 22.0 |
| `laliga_golazos` | 3 | 14.7 | 0 | — | 0 | — |
| **total** | **~1,000** | | | | | |

🚨 **In every collection the LOW cohort is the MOST-traded of the three** — roughly **2× the MEDIUM cohort**
and **2× HIGH** on Top Shot (28.9 vs 15.2 vs 14.0). That is not a gradient with noise at the edges; it is the
ordering inverted, consistently, across four independent collections.

**The canonical rule says this cannot happen.** `lib/fmv-confidence.ts`:

```ts
export function computeConfidence(salesCount: number): FmvConfidence {
  if (salesCount >= MIN_SALES_30D_MEDIUM) return "MEDIUM"   // MIN_SALES_30D_MEDIUM = 5
  return "LOW"
}
```
LOW is the *floor* case. Nothing downstream (`escalateConfidence`, `gateHighToRecentVolume`) demotes below it —
the gate only caps HIGH→MEDIUM.

**Controls run, so this is not the obvious artifacts:**
- **Not stale rows.** On All Day, **145 of 150** were computed in the last 24 h; `days_since_sale` averages
  **5.8** for the LOW cohort against **5.4** for MEDIUM. Both are fresh, and equally so.
- **Not a legacy algo.** Split by `algo_version`: **137 of the 150 are `1.7.0`, the same version as the 481
  MEDIUM**. The other 13 are `1.7.0_haircut` with an average count of **1.5** — those are correctly LOW.
- **Not my own sales query.** The count in the table above is the pipeline's **own recorded column**, not
  something I derived.

## Two readings, and BOTH are defects

**(a) The LABEL is wrong.** These editions cleared the volume floor and should be at least MEDIUM. If so the
accuracy gate is understated: ~1,000 editions is roughly **+2 points** on the 30.1% headline, and — far more
importantly — **the platform is publishing its lowest confidence on the editions users look up most.**

**(b) The COLUMN is wrong.** `sales_count_30d` may not be the count the rule consumed. Two concrete reasons to
suspect it: `computeConfidence` is called with `sales.length` — the **cleaned** set after `dampenGrailSpike`
— and the route separately widens a thin edition's window to **90 days** *"so it can price + earn MEDIUM off
the wider set"*, passing the true 30-day count to `gateHighToRecentVolume` as a distinct value. ⚠ **On All
Day the column averaged 12.7 where my own raw 30-day count averaged 7.6 — the column reads HIGHER than a real
30-day count, which is what a 90-day number in a `_30d` field would do.**

⛔ **Reading (b) does not make this benign.** A row that publishes `confidence = LOW` beside
`sales_count_30d = 29` is self-contradicting wherever both are surfaced, and this repo's own canon is that a
number a reader can act on must not disagree with the label next to it.

## 🎯 The discriminator — one debug read, and it is not mine to make

Log, for a handful of these editions, **`sales.length` at the moment `computeConfidence` is called** next to
the `sales_count_30d` being written. That single pair settles it:

- `sales.length < 5` while the column says 29 → **reading (b)**: the label is honest and the column is
  mis-derived (fix the column, or rename it to what it holds).
- `sales.length >= 5` and the row still lands LOW → **reading (a)**: something after the volume floor is
  writing LOW, and the write path needs finding.

⛔ **Not attempted here.** `/api/fmv-recalc` is FMV route logic — explicitly off-limits to autonomous change —
and instrumenting a route that already burns 72.7% of its ticks on wall-kills is not a change to make
speculatively. ⚠ **Nor should the label simply be "fixed" to MEDIUM before the discriminator runs:** if (b) is
true, promoting ~1,000 editions on a 90-day count would publish confidence the 30-day market does not support
— the fabricated-confidence trap, at scale.

## Why this matters more than its size

The [22:05Z capture](2026-08-23T2205Z-priority-1-captured-wau-is-zero-and-the-accuracy-gate-is-30-percent.md)
established that the accuracy gate is **mostly a liquidity ceiling** — most editions simply do not trade often
enough to price confidently, and no engineering changes that. **This cohort is the exception**: ~1,000
editions that *do* trade, more than any other cohort, and are labelled as though they do not. ⭐ **If the
roadmap's thesis is that accuracy is the gate, this is the one measured population where the data already
exists and only the label is in question.**

⚠ Every figure is a dated sample from 2026-08-24 02:20Z. ⚠ **The population churns fast** — an All Day count
taken 4 h earlier read 167 where the re-measure read 150, because `fmv_current` is delete-then-insert and the
recalc sweep rewrites continuously. **Re-derive before quoting, and expect ±10%.**
