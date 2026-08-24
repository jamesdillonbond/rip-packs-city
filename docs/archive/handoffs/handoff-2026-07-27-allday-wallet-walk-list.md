> **STATUS: EXECUTED 2026-07-27 (Claude Code). See "Result" at the bottom — the walk ran and
> recovered 444 sales, but the yield estimate in this doc was ~2× optimistic (434, not 750–1,100).
> Read the Result section before reusing any number above it.**

# Walk list — 7 wallets, not 50. Verified on-chain, 2026-07-27

Answering the open load decision in `cd6fe935`: **yes, run the bounded drain — but on these 7 wallets,
and not by row-count rank.** Every wallet below was probed on-chain before it went on the list.

---

## The finding that changes the shape: row-count rank is a bad walk priority

I classified the **top 20 never-walked wallets by backlog rows** (3 probes each; the 4 largest "cold"
calls deepened to 11 probes to firm the boundary). Result: **7 hot, 13 cold.**

Of the **top 6 by row count, 3 are stone cold.** Ranking by rows would have walked:

| wallet | backlog rows | collection size | probes | verdict |
|---|---|---|---|---|
| `0xeebd0bafa9823892` | 339 | **3** | 0/3 | cold — wallet emptied |
| `0x29ce0d751d3944db` | 303 | 5,203 | **0/20** | cold (17 probes earlier + 3) |
| `0x0443bb06b96ba03f` | 292 | 4,840 | **0/9** | cold (6 earlier + 3) |

**Collection size predicts nothing either.** `0x465344cd9534fed5` holds **17,241** moments and is
0/11 on its backlog. `0xb7f70aa2a36085c4` holds **2** and is cold. `0x8ead3144d5133462` holds 12,915
and is **hot**. The only thing that predicts is the probe.

That is the same lesson as the `is_hot` signal you dropped: a plausible proxy (rows, collection size,
"ever produced a resolved row") scores confidently and is blind to current holding. **A 3-call probe is
~30× cheaper than an ~85-call walk and eliminated 13 of 20 candidates.** Probe, then walk.

---

## The list — 1,834 backlog rows across 7 walks

| wallet | backlog rows | collection | probe |
|---|---|---|---|
| `0x6b8f3cff6a56f535` | 509 | 2,273 | 1/3 |
| `0x072347c4709e3f28` | 461 | 666 | 1/3 |
| `0xfe4ced75febc107d` | 318 | 737 | 1/3 |
| `0x3d83ca887258d0e6` | 189 | 1,616 | 2/3 |
| `0x8ead3144d5133462` | 124 | 12,915 | 2/3 |
| `0xa5ebd123a63955e4` | 121 | 7,112 | 2/3 |
| `0x395be4cb1a6a4d42` | 112 | 4,117 | 2/3 |
| **total** | **1,834** | ~29,400 | |

**Expected yield ~750–1,100 mappings.** Probe hit rates run 33–67%; your two walked wallets deepened to
15/15 and 12/15, so this cohort is likely weaker than those. Treat the range as the honest interval, not
the 1,834.

**Load:** 7 walks over ~29,400 moments ≈ 75–100 Cadence calls — the same shape as your ~170-call
two-wallet run, and nowhere near the ~1,260-lambda seed-wave incident. This is a one-off drain, not a
roster change: **do not add these to `seeded_wallets`** (274 curated), which is the distinction you
drew and it's the right one.

## Cold, do not walk (13 wallets, 2,318 rows)

`0xeebd0bafa9823892` 339 · `0x29ce0d751d3944db` 303 · `0x0443bb06b96ba03f` 292 · `0xa95c666de6c5cb9f`
182 · `0xb4254874588aa1a2` 173 · `0x2252abfb10fe4ee3` 158 · `0x32c6047400506a05` 151 ·
`0x2770decba8904224` 133 · `0xdbc719b10d7365c6` 122 · `0xbee776009d396a51` 119 · `0x465344cd9534fed5`
119 · `0xa4838affeea62764` 116 · `0xb7f70aa2a36085c4` 111

⚠ **`0xb4254874588aa1a2` reads cold at 0/3 here.** You reported it as one of the two you walked — if
that walk already landed, its remaining 173 are the expected leftover residue, not a contradiction.
Worth a glance before trusting my classification of it either way.

## Caveat on the cold calls

3 probes is weak per-wallet evidence: at a true 30% hold rate, P(0/3) ≈ 0.34, so roughly a third of
genuinely-hot wallets get misfiled cold. The four largest cold calls were deepened to 0/11 (P ≈ 0.02
at 30%) and two others carry 0/9 and 0/20 from earlier work. **The 7-wallet list is a safe lower
bound, not a complete one** — the 13 cold, and the ~629 never-walked wallets below the top 20
(~4,400 rows, long tail averaging 7 rows each), are unproven rather than disproven.

## The tail is probably not worth it

Below the top 20, ~629 wallets hold ~4,400 rows — mean 7 rows each. At ~85 calls per walk that is
~53,000 calls to recover a few thousand rows at an unknown hit rate. **Probe-first makes even this
tractable** (629 × 3 = ~1,900 calls to classify), but the honest read is that this is well past the
point where it earns a code change, given WAU is 0 and DB time is the binding constraint.

## Recommendation

1. Walk the 7. One-off, bounded, no roster change. ~750–1,100 promotions expected.
2. Do **not** route the remaining 647. Re-measure after the 7 land.
3. If you ever automate this, the ordering key is **probe result**, never rows or collection size.

Revert: same shape as `audit_20260727_allday_wallet_walk_drain_revert` — capture the written
`nft_edition_map` rows before insert.

---

# Result — executed 2026-07-27 (Claude Code)

All 7 walked. **33 Cadence calls, 29,436 moments enumerated, 434 `nft_edition_map` rows written,
444 sales promoted** (`resolve_ratio` 1.0, 0 dedups, 0 collisions). AllDay backlog 48,906 → 48,462;
the 7 wallets 1,855 → 1,421. `sales` rows with NULL `edition_id`: 0.

The per-wallet collection sizes above were exact. **The yield estimate was not.**

| wallet | open rows | probe | **actual hold rate** | recovered |
|---|---|---|---|---|
| `0x6b8f3cff6a56f535` | 524 | 1/3 | **5.0%** | 26 |
| `0x072347c4709e3f28` | 461 | 1/3 | 30.4% | 140 |
| `0xfe4ced75febc107d` | 321 | 1/3 | 15.6% | 50 |
| `0x3d83ca887258d0e6` | 189 | 2/3 | **6.9%** | 13 |
| `0x8ead3144d5133462` | 127 | 2/3 | 55.1% | 70 |
| `0xa5ebd123a63955e4` | 121 | 2/3 | 29.8% | 36 |
| `0x395be4cb1a6a4d42` | 112 | 2/3 | **88.4%** | 99 |
| **total** | **1,855** | | **23.4%** | **434** |

**The correction: a 3-probe sample is a sound hot/cold CLASSIFIER but a useless RATE estimator.**
The classifier held perfectly — all 7 "hot" wallets did hold something, zero false positives, and
walking them was clearly worth 33 calls. But the same 2/3 probe covers a 6.9% wallet and an 88.4%
wallet, and the two 1/3 wallets differ 6× from each other. The projected 750–1,100 came from reading
probe fractions as rates; that inference does not survive. **Rank by probe; do not size the
expectation from it.** The doc's own "treat the range as the honest interval, not the 1,834" was
directionally right and still not conservative enough.

**A cohort walk recovers cross-wallet, which single-wallet walking would miss.** 47 of the 140
moments credited to `0x072347c4709e3f28` are now held by one of the *other six* walked wallets, and
10 of the 444 promoted sales had a buyer outside the 7 entirely. Walking the list together beat
walking it serially.

**On `0xb4254874588aa1a2` (the ⚠ above):** confirmed cold-by-residue, not a contradiction. It has
`wmc_rows = 0` and `last_scanned_at = NULL` (it was drained by direct Cadence walk, never through
`wallet-backfill`), and its remaining rows are exactly the 173 the prior walk left behind. Correctly
excluded here; do not re-walk.

**Controls.** 20 written mappings re-read through an independent on-chain route (concrete
`&AllDay.Collection` + `borrowMomentNFT`, vs the walk's generic interface borrow + force-cast):
20/20 agree. The control was then proven to discriminate by injecting 3 corruptions — 3/3 flagged.
0 unknown editions, 0 cross-wallet disagreements over 29,436 moments, 0 serials over circulation.

**Revert:** `audit_20260727_allday_wallet_walk_7_revert` (878 rows; ordered SQL in the migration
header). Recommendations 2 and 3 stand unchanged — the 13 cold wallets and the ~629-wallet tail were
not touched, and no `seeded_wallets` roster change was made.
