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

---

## FOLLOW-UP 2026-08-23 20:35Z (13:35 PT) — ⛔ OPTION A DOES NOT EXIST, and the reason strengthens option C

Settled by **measurement** — `GET /v1/projects/{ref}/billing/addons` on the Supabase Management API — not by the dashboard look the brief recommended.

### The 22 MB/s is not a disk signature. It is `ci_small`'s own budget.

The API reports, for the selected compute instance:

```
ci_small: { memory_gb: 2, cpu_cores: 2, cpu_dedicated: false,
            baseline_disk_io_mbs: 174, max_disk_io_mbs: 2085 }
```

⚠ **The API field is MEGABITS and reads like megabytes.** 174 / 8 = **21.75 MB/s**; 2085 / 8 =
**260.6 MB/s**. The published Compute-and-Disk table lists Small as **22 MB/s baseline / 261 MB/s
max** — both sides agree, and 21.75 is exactly the "22 MB/s baseline, burst-credit model" CLAUDE.md
records.

So that number is **tied to the COMPUTE TIER, not to the disk.** It is not a gp2 signature. gp3 is
Supabase's default disk type and ships 125 MB/s (raisable to 1,000), but that is a **second,
stacked** constraint, and the docs are explicit: *"effective IOPS and throughput will be limited by
the compute instance size."*

👉 **The brief compared two different axes and read the gap as an opportunity.** A gp2→gp3 migration
— if the disk were even gp2 — could not lift this instance above 22 MB/s baseline, because
`ci_small`'s own budget binds first. **Strike row A. There is no $0 lever.**

⚠ **I could not read the provisioned disk type, and it no longer matters.** No Management API
endpoint exposes it (`/disk`, `/disk-attributes`, `/infra` all 404). The dashboard look would answer
a question whose answer changes nothing.

ⓘ Corroboration in passing: the brief's measured **8.9 MB/s sustained** against a **22 MB/s**
ceiling is the ~40% it reported. **The ceiling number was right; only its cause was wrong.**

### Option C buys three things, not one

| | Small (now) | Medium | Large |
|---|---|---|---|
| RAM | 2 GB | 4 GB | **8 GB** |
| cores | 2 | 2 | 2 |
| dedicated CPU | ❌ burstable | ❌ burstable | ✅ **dedicated** |
| baseline disk IO | 22 MB/s | 43 MB/s | **79 MB/s** |
| burst ceiling | 261 MB/s | 261 MB/s | **594 MB/s** |
| price | $15 | $60 | **$111** ($0.1517/hr) |

The brief argued C on RAM alone. Baseline disk IO also **3.6×**es, the burst ceiling **2.3×**es, and
`cpu_dedicated` flips **false → true** at Large. Every one of those sits on a constraint this box has
actually been measured against.

### ⚠ CLAUDE.md's rule is wrong in a second way, not just mis-scoped

*"fix expensive queries, don't upgrade (Medium is the same 2 cores for 4×)"*

- **Accurate about Medium's cores** — 2 burstable, same as Small. But Medium also doubles RAM *and*
  doubles baseline disk IO, neither of which the rule mentions.
- **Wrong at Large**, which is where the RAM measurement points: Large is 2 **dedicated** cores.
  Not "the same 2 cores".

The brief called the rule "factually right and on the wrong axis." Half holds: it is on the wrong
axis, and it is **not** factually right about the tier that matters.

### What this does NOT change

The RAM measurement, the refusal to credit any option with "ending the band" absent a before/after,
and the warning about the 97.96% hit ratio all stand untouched. This **narrows** the option set; it
does not decide it. **C at $111/mo remains Trevor's call**, now against A being void rather than free.

**Method note:** the value was only trustworthy once it reproduced the docs' published MB/s figure.
A units check, not a lookup — `baseline_disk_io_mbs` names megabits and would have read as a 8×
overstatement of headroom taken at face value.

---

## CORROBORATION 2026-08-23 ~13:50 PT — the published table confirms the API reading, and adds four things

The follow-up above rests on one API field with an 8× unit trap in it, caught only by reproduction. I read the **published** [Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk) table as an independent second instrument. **It agrees exactly** — Small 22 MB/s baseline / 261 max / 1,000 IOPS; Large 79 / 594 / 3,600, `2-core (dedicated)` vs Small and Medium's `2-core (shared)`. The refutation stands on two instruments now, not one. Four additions:

**1. ⛔ A SECOND, INDEPENDENT REASON OPTION A IS VOID — you cannot buy disk throughput on Small at all.** The docs, on provisioning extra IOPS/throughput: *"**This requires Large compute size or above.**"* So even setting aside the compute budget binding first, the purchase is **not offered** at this tier. Two independent kills; the row is void either way, which is stronger than the single argument above.

**2. Supabase's own stated upgrade criterion, and this project meets it.** Verbatim: *"If the `Disk IO % consumed` stat is more than 1%, it indicates that your workload has exceeded the baseline IO throughput during the day. If this metric goes to 100%, the workload has used up all available disk IO budget. **Projects that use any disk IO budget are good candidates for upgrading to a larger compute instance with higher throughput.**"* RPC does not merely dip into the budget — **exhausting it is the documented 22 MB/s throttle**, i.e. the band itself. By the vendor's own published criterion this instance is an upgrade candidate. ⓘ Recorded as an *input* to the decision, not an argument for it: a vendor's upgrade criterion is not disinterested, and it is still Trevor's call.

**3. ⚠ Medium and Large are different REGIMES, not just different numbers — which makes option B weaker than its row suggests.** The docs: *"Smaller compute instances like Nano, Micro, Small, and Medium can burst above baseline for short periods. Once burst capacity is exhausted, performance returns to baseline. If you need consistent disk performance, consider upgrading your compute size."* **Medium keeps Small's 261 MB/s burst ceiling and its shared, burstable CPU** — so B doubles RAM and baseline IO but stays inside the same burst-exhaustion mechanism that produces the band. Large is the first tier that changes the mechanism (dedicated CPU, 594 MB/s ceiling). **Read B as "the same failure mode, later" rather than as half of C.**

**4. 💡 Why this went unnoticed for months, worth recording so it is not re-derived.** Supabase's sizing guidance is **`Max DB Size (Recommended)` = 50 GB for Small**, and RPC is at **13.5 GB** — comfortably inside, at 27% of the recommendation. **The vendor's own sizing metric is DATABASE SIZE, not WORKING SET**, so by the number anyone would naturally check, this box looks correctly provisioned. The 6.5 GB hot set against 2 GB RAM is invisible to that metric. ⚠ **Generalisable: a "you are within the recommended size" reading says nothing about whether the hot set is resident.**

⚠ **What this does NOT do:** it does not decide anything, and it does not make C safe to credit with ending the band absent a before/after measurement. Every caution in the original filing and the follow-up stands.

---

## ✅ THE PROBE TREVOR ASKED FOR — read 2026-08-23 14:31 PT from the Supabase dashboard

Trevor's instruction was *"read `Disk IO % consumed` first, then decide."* Read via Chrome on `/observability/database`, window **Aug 23 1:31pm → 2:31pm PT (60 min)**.

### Supabase is displaying the answer as a banner, unprompted

> ⚠ **"Your project is about to deplete its Disk IO Budget."**
> *"Once exhausted, disk throughput will return to its baseline of 22 MB/s until the budget resets. **Upgrade your compute** or use the AI Assistant to identify and optimize disk-intensive queries."*
> Buttons offered: `Troubleshoot` · **`Upgrade compute`**

The vendor's banner names the same two remedies this filing identified, in the same order, and states the 22 MB/s baseline as a **compute** property — independently confirming the follow-up's refutation of the gp2 theory.

### The numbers

| panel | reading | tier baseline | verdict |
|---|---:|---:|---|
| **Disk throughput** | **22.4 MB/s** | 22 MB/s | ⚠ **Pinned AT the baseline** — not approaching it, sitting on it |
| **Disk IOPS** | **2,067** | 1,000 | **2.1× baseline**, bars ranging ~1.5K–4K |
| CPU usage | ~25% ceiling, **overwhelmingly `IOwait`** | — | IO-bound, not CPU-bound — visually unambiguous |
| Database Connections | **11 / 90** | — | ⓘ Rules out connection exhaustion as a contributor |

⚠⚠ **The throughput panel is itself an instance of the trap this filing is about.** Its dotted "Max throughput" reference line sits at **125 MB/s** — the *gp3 disk's* capability — while actual sits at 22.4 and the banner says 22 is the ceiling. **A reader looking only at the chart sees 82% headroom that does not exist.** The disk can do 125; the compute tier sustains 22; the lower number binds. Anyone re-deriving this from the dashboard alone will reach the wrong conclusion, which is roughly how the original "$0 disk lever" error happened.

### What this settles, and what it does not

**Settles:** the budget is being consumed, continuously, at the ceiling — this is not an intermittent spell, matching the 10-day `pg_stat_statements` finding from a completely different instrument. By Supabase's published criterion (*"projects that use any disk IO budget are good candidates for upgrading"*) this instance qualifies, and by its own dashboard it is being told so.

⚠ **Does not settle:** this is a **single 60-minute window** — a snapshot, not a distribution. It corroborates the 10-day measurement rather than standing alone, and it still does not license crediting any upgrade with "ending the band" absent a before/after reading of the same panel. **Take the same screenshot after any tier change; that is the before/after this filing has been asking for, and it costs nothing.**

**The decision remains Trevor's.** Every input either of us can produce is now in.

---

## ⛔ DECIDED 2026-08-23 20:48 PT — Trevor: **option E, stay on Small.** No spend.

Asked directly with all four options and the numbers above in front of him. **The answer is E.** This closes R46 as a decision; it does not close it as a measurement.

⚠ **This section exists because of a standing rule in CLAUDE.md: a filed DECISION NOT TO ACT is the one nobody re-checks, because declining reads as the conservative choice, and the tell is a cost stated with no number in it.** So the cost is stated with numbers.

### What was NOT bought: $96/mo (Large, $111 vs $15) = **$1,152/year**

### What that $1,152/year buys instead — every figure already measured, none re-derived here

| the cost being accepted | measurement | source |
|---|---|---|
| the instance cannot cache its own working set | 6.5 GB hot set vs **512 MB** `shared_buffers` / 2 GB RAM; 765 GB/day read against a 13.5 GB database ⇒ **≈57 full re-reads per day** | this filing |
| the IO budget is not dipped into, it is **exhausted** | throughput pinned at **22.4 MB/s** against a 22 MB/s baseline; IOPS **2,067** against 1,000; CPU ~25% and overwhelmingly `IOwait` | 14:31 PT probe |
| the box is saturated at rest | **≈4.5 backends busy at all times** on 2 cores (1,171 exec-hours in 258 wall-hours, `dealloc = 0`) | R46 |
| FMV freshness | `fmv-recalc` **72.7% wall-kills**, ~92% of its work done in 5–6 hours of 24 | cron-and-schedulers |
| ingest completeness | **131 of 196 (66.8%)** sales-history-backfill ticks skip on saturation | R20 |
| board freshness | 11 public board views persistently over budget; `allday_scarcity_board` **p50 23,429 ms** against an 8,300 ms budget, **max 725,799 ms**; cross-collection mats went **132 h** stale | R50 |
| ⚠ **build risk, not just latency** | **6 of those 11 have a p90 above 60 s**, and prerendered `/insights` pages get **60 s each** — a slow board can fail the whole production build | R50 |
| public-page reads | `readiness_collection_stats()` **24,523 ms as `anon` with the instance QUIET** (not in a spell), overshooting an 8 s `statement_timeout` | R44 |
| SEO page latency | `get_series_editions(allday, series-9)` **97,443 ms**; the Top Shot series-7 call **timed out even as `postgres`** | R52 |
| work not done | **R52 stays unbuilt**, and R6 / R50 / R53 stay downstream of a constraint that is now permanent by choice | register |

### ⚠ Three things E does NOT decide, stated so they are not swept up with it

1. **E declines the SPEND. It does not decline the free work.** R52's piggyback on `refresh_series_detail_rollup()` costs near-zero extra IO *because that pass already computes latest-FMV per edition* — it was deferred pending R46, and R46 is now answered "no capacity change," so it must be re-litigated **on its own merits**, not left gated on a gate that has opened. Same for the read-path attribution in [2026-08-23T2235Z](2026-08-23T2235Z-the-read-path-attributed-and-two-severity-corrections.md).
2. 🚨 **The budget is at 100%, so every new recurring job now spends someone else's headroom.** Before E it was possible to argue "add the rollup, capacity is coming." It is not coming. **Any proposal that adds a cron, a refresh, or an index build must now state its steady-state IO cost and what it displaces** — the 15-minute cadence already rejected at 97 min/day of full-tilt IO is the worked example.
3. **Nothing here says the queries are good.** R46 said the instance cannot cache its working set; that is a separate fact from whether the workload should be that large. Reducing the 765 GB/day remains the only lever E leaves standing, and it is *harder* now, not moot.

### ⛔ Do not re-suggest the upgrade. These are the conditions that expire this decision.

Re-open R46 **only** on one of these, and bring the reading with you:

- **A production build fails on a prerendered `/insights` board read.** That is outage class, not latency class, and it is the nearest measured hard failure — 6 of 11 boards sit above the 60 s per-page budget at p90.
- **First revenue, or 50+ weekly active users** — the "no infra spend pre-revenue" premise expires by its own terms, and CLAUDE.md already names 50 WAU as the monetization threshold.
- **A public page serves degraded or error copy to anonymous visitors for a sustained window** (not a blip). The honesty layer currently absorbs these; when it starts publishing them, the trade has changed.
- **The hot set grows past ~8 GB.** That does not argue for Large — it argues that Large would *also* be insufficient, which is a different decision than the one made here.

⚠ **And if the tier ever does change: take the `/observability/database` screenshot BEFORE and AFTER, same 60-minute window shape.** Without it nothing licenses crediting the change with ending the band. That requirement survives this decision unchanged.
