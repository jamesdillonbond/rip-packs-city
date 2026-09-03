# D25 is TWO populations, and the big one is a unit mismatch — 895 of 895, with the obvious remedy measured dead

**Filed 2026-09-03 ~04:30Z (2026-09-02 PT) by Claude Code. NOTHING SHIPPED — the remaining decision
is a product call, and the obvious code fix is refuted below.**

D25 has read *"wmc rows rendering an impossible serial — 66 (TS 62 · Pinnacle 4)"* since run 4. Re-run
today at the grain the row names (`w.serial_number > w.mint_count`), the count is **2,353**.

⛔ **That is NOT a 35× regression, and reading it as one is the trap.** Split by edition key:

| population | rows | editions |
|---|---:|---:|
| **BASE editions** (no `::`) | **62** | 4 |
| **PARALLEL editions** (`::N`) | **2,291** | 895 |

⭐ **The 62 IS the register's number.** Run 4's 62-for-Top-Shot was measured over the base population;
the parallels were never in it. The register already warns *"grain changed; not comparable"* — this is
a THIRD grain, and the row's own number is intact.

## The parallels are a unit mismatch, and the evidence is total

For every offending `::N` key, take the largest serial we hold and compare it to the **BASE** edition's
circulation rather than the parallel's:

| | keys |
|---|---:|
| offending parallel keys | 895 |
| base edition row missing | **0** |
| **largest serial fits inside the BASE run** | **895** |
| still impossible against the base | **0** |

**895 of 895, no exceptions.** The parallel row carries the BASE moment's serial; the denominator
beside it is the PARALLEL's own circulation. Spot-checks agree: `90:3410::1` max serial 7,585 against
base `90:3410` circulation 16,000; `224:8241::17` max 5,244 against base 5,373; `124:4344::1` max
7,962 against base 8,500.

**So the data is not corrupt — the RENDER pairs two different units**, and "#7,585 / 500" is the
arithmetic of that pairing, not a bad row.

## ⛔ The obvious remedy is measured dead

*"`wmc.mint_count` is denormalised and drifted; copy `editions.circulation_count` over it"* is the fix
anyone would reach for. Measured across all 899 offending keys:

| | keys |
|---|---:|
| no `editions` row | 0 |
| `circulation_count` NULL | 0 |
| **`editions.circulation_count` would fix it** | **2** |
| **`editions.circulation_count` is ALSO smaller than our largest serial** | **897** |

**Two out of 899.** Both stores disagree with the serials in the same direction, because both describe
the parallel run while the serial describes the base one. ⚠ **An afternoon spent syncing that column
would move 0.2% of the population and leave the sentence on screen unchanged.**

## ⚠ A SEPARATE, LARGER integrity problem found on the way — and it is not the same thing

**1,095 of 2,853 Top Shot parallel `edition_key`s (38%) carry MORE THAN ONE distinct `mint_count` in
`wallet_moments_cache`, across 28,164 rows, with up to FOUR distinct values for a single key.**

The same edition cannot have two circulation counts, so this is a real violation whichever value is
right — and the "impossible serial" rows are only the subset where the wrong denominator happened to
land *below* the serial. ⚠ **The disagreement runs in BOTH directions and this filing does not pick a
side:** `90:3410::1` has `editions.circulation_count = 500` while wmc rows carry 16,000 (the base's);
`51:1885` has `editions` at 4,000 while wmc carries 8,500 and real serials reach 7,944 — there
**`editions` is the odd one out**.

## What is actually left to decide

**What should "#N / M" mean on a parallel?** Both answers are defensible — the base serial with the
base run (what the collector's moment actually is), or the parallel serial with the parallel run — and
picking one changes a number on every parallel moment card. **That is a product call, not a cleanup**,
which is why nothing was changed here.

⚠ Two measurements this pass could NOT take, so nobody inherits them as settled: the full-table
mint_count conflict count for BASE Top Shot keys (the query times out at 60 s against
`wallet_moments_cache`), and which writer puts which value in — `mint_count` has multiple writers and
this filing did not enumerate them.

ⓘ Pinnacle's 4 rows from run 4 are **gone**; the whole current population is Top Shot.
