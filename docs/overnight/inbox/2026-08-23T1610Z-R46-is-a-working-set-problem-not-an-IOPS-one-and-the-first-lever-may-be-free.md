# R46 decision brief — the saturation is a WORKING-SET problem, not an IOPS one, and the first lever may cost $0

**Filed 2026-08-23 09:10 PT (16:10Z), Cowork.** Read-only: catalogue reads, two Supabase doc pages, no writes, no plan changes, no infra changes. R46 is the blocking decision behind **R6, R50, R52, R53** and the series-detail latency, so this exists to make it decidable rather than to decide it.

---

## What is already settled, and I am not re-deriving it

- **The saturation is structural, not a spell.** 8,227 GB read in 10d 18h with `dealloc = 0`; 1,171 hours of query execution in 258 hours of wall clock ⇒ **≈4.5 backends busy at all times on a 2-core instance**. Nothing has to go wrong for this box to be saturated.
- **Query optimisation is not the lever, and that was tested rather than assumed.** `/api/ready` returned **504 after its work was cut ~330×** (8,000 buffers → 24) — same endpoint, same conditions, before and after. No optimisation available inside the codebase survives a severe spell.

Both stand. What follows is the part that had not been measured.

---

## The new measurement: the working set does not fit in RAM, and it is not close

| | |
|---|---:|
| database size | **13.5 GB** |
| instance RAM (Small) | **2 GB** |
| `shared_buffers` | **512 MB** |
| `effective_cache_size` | 1.5 GB |
| hot set — `wallet_moments_cache` + `sales_2026` + `fmv_snapshots_2026` + `editions` + `pack_rips` | **6.5 GB** |
| measured read volume | **765 GB/day** |
| buffer cache hit ratio | **97.96%** |

**765 GB/day against a 13.5 GB database means the database is being read from disk roughly 57 times per day.** That is not a workload reading a lot of distinct data — it is the *same* data being re-read because it cannot stay resident. A 6.5 GB hot set cannot be cached in 512 MB of `shared_buffers`, so every sweep evicts the previous one.

⚠ **The 97.96% hit ratio is exactly the trap this repo keeps recording.** It reads as healthy and is the wrong denominator: at this volume the residual ~2% *is* the 765 GB/day. **A ratio cannot tell you the absolute miss volume — quote the bytes.**

**So the constrained resource is RAM, not IOPS and not CPU.** More disk throughput makes the same 765 GB/day arrive faster; more RAM means it is never requested.

---

## ⚠ CLAUDE.md's standing objection is correct and is on the wrong axis

CLAUDE.md says: *"fix expensive queries, don't upgrade (Medium is the same 2 cores for 4×)"*. Verified against current Supabase pricing — **it is factually right and it is a CPU argument**:

| size | CPU | RAM | $/mo |
|---|---|---:|---:|
| Small *(current)* | 2-core ARM | **2 GB** | $15 |
| Medium | 2-core ARM | **4 GB** | $60 |
| Large | 2-core ARM | **8 GB** | $110 |
| XL | 4-core ARM | 16 GB | $210 |

"Same 2 cores" is the *objection*; it is also the *point*. Small → Large buys **4× the RAM with zero extra cores**, which is precisely the resource that is short. The instance has never been CPU-bound — CLAUDE.md says so itself. **The rule should be re-scoped to "don't upgrade for CPU", because as written it blocks the one axis that matters.**

At 8 GB the 6.5 GB hot set fits with room for `work_mem`; at 4 GB most of it fits. The 57×/day re-read collapses either way.

---

## 🟢 The first lever may cost nothing — check this before spending anything

Supabase's current default disk is **gp3, whose 125 MB/s baseline throughput is included on Pro at no charge** (you are billed only above 125 MB/s, at $0.095/MB/s/mo).

**CLAUDE.md documents this instance throttling to a 22 MB/s baseline on a burst-credit model.** 125 MB/s is not a burst-credit model and 22 MB/s is not a gp3 number — **22 MB/s with burst credits is a gp2 signature.** The project was created 2026-03-22, plausibly before the disk default moved.

**INFERRED, and deliberately labelled so.** If this project is still on a legacy **gp2** disk, migrating to **gp3** raises the sustained floor from ~22 MB/s to **125 MB/s — about 5.7× — for $0/month**, on exactly the constrained axis, with no compute change and no code change.

**Refutation is one look, not an experiment:** Dashboard → Project Settings → **Compute and Disk** shows the disk type. If it already reads gp3, this lever does not exist and the paragraph is void. The Supabase MCP does not expose disk type, which is why this is inferred rather than measured — I could not settle it from here.

⚠ Against the measured **8.9 MB/s sustained average**, a 125 MB/s floor would put the average at ~7% of capacity instead of ~40%. That does not make the peaks disappear, but it moves the ceiling far above them.

---

## The options, with what each actually buys

| option | Δ cost/mo | buys | honest limitation |
|---|---:|---|---|
| **A. gp2 → gp3 disk migration** *(if applicable)* | **$0** | sustained floor ~22 → 125 MB/s | Does nothing about the 765 GB/day itself; raises the ceiling above the peaks. **Check the disk type first.** |
| **B. Small → Medium (4 GB)** | +$45 | most of the 6.5 GB hot set resident | Hot set still exceeds RAM; partial relief |
| **C. Small → Large (8 GB)** | +$95 | whole hot set resident; the 57×/day re-read collapses | The structural fix on the measured constraint |
| **D. Cut the 765 GB/day** | $0 | fewer reads at source | **Measured as unavailable to code**: a 330× reduction on `/api/ready` still 504'd. Remaining levers (`refresh_wmc_fmv_changed`'s UPDATE fan-out, the two board pairs) are decision- or off-limits-gated |
| **E. Accept it** | $0 | nothing | The current state: 5 open register items, ~110 s in-band page latency, a daily reader stall on a public page |

A and C are not exclusive. A is the one to test first because it is free and reversible in effect.

---

## ⚠ The collision this forces, which is why it is Trevor's call and not mine

Two standing rules point opposite ways and R46 is where they meet:

- **"No infra spend pre-revenue" / cost-flat infra** says E, or A only.
- **"Accuracy is the gate"** — and its recorded tie-breaker, *when a cost saving trades against data freshness or coverage, the accuracy side wins* — points at C. The band is currently costing freshness directly: cross-collection mats went 132 h stale, `fmv-recalc` does ~92% of its work in 5–6 hours of 24, and the series-detail latency is the same denominator.

**$95/month is the price of the disagreement.** Nobody but Trevor can settle whether the accuracy gate outranks the spend gate at that number, and the honest framing is that it is a trade, not an optimisation anyone has failed to find.

---

## ⚠ What must NOT be concluded from this filing

1. **Do not credit any of these with "ending the band" without measuring the band before and after.** The band is a peak phenomenon; the 8.9 MB/s average is survivable and the peaks are not. Every option above changes a *capacity*, and capacity is not the same measurement as the symptom.
2. **Do not read the 97.96% hit ratio as health** in any future filing — see above.
3. **Do not treat option A as verified.** The gp2 inference rests on a number in CLAUDE.md, not on a reading of the disk. One dashboard look settles it, and if it is already gp3 the option is void.
4. **This says nothing about whether the queries are good.** It says the instance cannot cache its own working set, which is a separate fact from whether the workload should be that large.

---

**Sources:** [Supabase compute add-on sizes and pricing](https://supabase.com/pricing) · [Manage Disk Throughput usage](https://supabase.com/docs/guides/platform/manage-your-usage/disk-throughput) · [Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk)
