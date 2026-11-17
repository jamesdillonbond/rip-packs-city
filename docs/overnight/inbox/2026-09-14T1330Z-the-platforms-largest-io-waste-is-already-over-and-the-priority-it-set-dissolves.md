# The "platform's largest addressable IO waste" is ALREADY OVER — measured as a RATE, it is ZERO, and the R21 priority it set dissolves

**Filed 2026-09-14 ~6:2x AM PT (13:2xZ), Claude Code cloud. READ-ONLY finding; nothing shipped.**
Found while ranking `pg_stat_statements` by cold reads for the next optimisation target — i.e. by walking into the same trap the earlier filings did, and then taking a second reading.

## 1 · What the record says

[inbox 2026-08-22T1956Z](2026-08-22T1956Z-the-saturation-is-structural-a-waste-ledger-from-pg-stat-statements.md) sized it at **6.4 % of all instance reads**; [inbox 2026-08-29T1359Z](2026-08-29T1359Z-the-platforms-largest-IO-waste-is-blocked-behind-R21s-credential-rotation.md) re-measured **6.8 %** and drew the chain that has been carried since:

> 6.8 % of instance cold reads → two unfiltered `count=exact` reads → two edge functions whose source cannot be committed → **because they carry unrotated hardcoded gate keys** → R21.

That filing's closing line is the one that mattered: *"Two of the five keys to rotate unblock a ~6.8 % read reduction."* **R21 has been carried at a raised priority ever since, on that sentence.**

## 2 · ⛔ THE RATE IS ZERO, AND TWO READINGS SAY SO

`pg_stat_statements` is **cumulative since 2026-08-12 01:33Z**, and both prior filings ranked on the cumulative column. Two readings of the same two `queryid`s, taken **7 h 48 m apart today**:

| queryid | 05:33Z calls / reads | 13:21Z calls / reads | delta |
|---|---|---|---|
| `-8607416197962318790` (`allday_pack_sales_history`) | 3,949 / 65,520,040 | 3,949 / 65,520,040 | **0 / 0** |
| `384214755990751684` (`topshot_pack_sales_history`) | 3,441 / 66,516,510 | 3,441 / 66,516,510 | **0 / 0** |

⭐ **Byte-identical, not merely close.** In that same window pg_cron ran `rpc-allday-pack-sales-backfill` (jobid 25, `*/3`) and `rpc-topshot-pack-sales-backfill` (jobid 29, `1-58/3`) roughly **156 times each** — 479 and 478 runs in 24 h, 475 and 472 ok. **The lanes are alive and firing; the expensive statement is simply no longer one of the things they do.**

⚠ **Eviction cannot explain it.** `dealloc` is 58, so entries have been evicted — but an evicted-and-readmitted entry comes back with counters **reset to a low number**, not frozen at an identical high one. Unchanged counters mean not evicted AND not called.

**Why it stopped:** both cursors read `done = true` — `allday_pack_sales_cursor` `updated_at` 2026-09-12 23:15Z, `topshot_pack_sales_cursor` 2026-09-14 01:10Z. The unfiltered `LIMIT/OFFSET` + `count=exact` read is the **deep-backfill** path, and it is not currently running.

⚠ **THE ALTERNATIVE EXPLANATION, WHICH THE REGISTER ITSELF SUPPLIES AND WHICH I ALMOST SHIPPED OVER.** #35 records this lane as a CYCLE, not a one-shot: *"the walk phase is ~4.2 h + a ~5.5 h park at `done = true` (a **phase, not a defect** — that was flagged as a second defect after 54 minutes of observation and falsified when it self-restarted on schedule)"*. **`done = true` is therefore the NORMAL resting state of a healthy lane, and reading it as "finished" is the exact error that register entry was written to prevent.** What the two readings establish is narrower and still sufficient: **the expensive statement issued zero calls across 7 h 48 m**, which is longer than the documented ~5.5 h park but is NOT proof the cycle has ended. ⭐ **The claim that survives is about the RATE, not about the lane's future**: the IO cost is zero *now*, over a window longer than the documented park, so a priority that describes it in the present tense is wrong today. **If the walk restarts, the cost returns and the same two-reading check sees it.**

## 3 · The share was also wrong today, in the direction that matters

Re-derived live rather than re-quoted: the two statements are **132,036,550 of 3,449,764,034** instance cold reads = **3.83 %**, not 6.8 %. That is what a **fixed historical total** does as ongoing traffic accumulates underneath it — it decays. ⭐ **A share that falls while the underlying number does not move is itself the tell that the numerator stopped growing.** Both earlier figures were correct when written and neither was a rate.

## 4 · ⚠ What does NOT follow — the defect is retired, not fixed

- 🚨 **It is LATENT, not gone.** The code still contains `count=exact` on a 300 MB table and an unordered `LIMIT/OFFSET`. **Anything that re-runs the backfill (`?reset=1`, a new collection, a re-hydration) brings the whole cost straight back**, and the earlier ledger note already worried about exactly that: *"If `done` is still false tomorrow, something re-`?reset=1`s it — find that caller before anything else."*
- 🚨 **THE CORRECTNESS RIDER IS NOW THE MORE INTERESTING HALF, AND IT IS NOT A COST QUESTION.** Those pages were `SELECT * … LIMIT/OFFSET` with **no `ORDER BY`** — this repo's documented unstable-pagination ban. A walk like that reads the right *number* of rows and the wrong *rows*; duplicates and omissions cancel, so every count-based check passes. **That walk has now RUN TO COMPLETION and stamped `done = true`.** ⛔ **"Done" is a statement about the cursor, not about coverage** — so the open question is no longer *what does it cost* but **did it miss rows**, and nothing in the estate has asked that.
- ⛔ **R21's IO justification dissolves; R21 itself does not.** Rotating five live hardcoded `rpc_pls_` gate literals in actively-invoked production functions is a security item on its own merits and unchanged. **What must stop is citing it as the gate on "the platform's largest addressable IO cost"** — that sentence is now false, and a priority resting on a false premise is the "weak reason crowds out the strong one" shape this estate already names.

## 5 · Exit conditions, both falsifiable

1. **If the cost returns**, these two `queryid`s start moving again — the same two-reading check detects it in one query. That is worth keeping as the trigger to actually fix `count=exact`, rather than pre-emptively unblocking a rotation for it.
2. **The coverage question:** a row-level completeness check on `*_pack_sales_history` against upstream. **Not attempted here** — it needs the upstream API, which this sandbox's agent proxy cannot reach (CONNECT 403, and that failure reads exactly like a WAF block; read the error string, not the number).

## 6 · The method note, because it is reusable

Every filing in this chain ranked `pg_stat_statements` by a **cumulative** column and then described the result in present tense. The 08-29 filing even wrote the warning itself — *"Cumulative-since-reset, not a rate… do not read 6.8 % as 6.8 % of today"* — and still set a priority on it, and so did the one after. **A cumulative counter cannot tell you whether something is happening now. Take two readings.** A `pg_stat_statements` snapshot table costs one statement and turns the whole ranking into a rate.

## 7 · ⛔ A CONTROL THAT FAILED, recorded so nobody re-derives it

While checking whether the lane is merely quiet or actually missing events, I built what looked like a decisive test: **`pack_purchases` where `event_kind = 'secondary_sale'` is alive** — 171 Top Shot rows in the last 24 h, newest 2026-09-14 11:55Z — against a history table whose newest `block_time` is 2026-09-13 12:59Z. The join said **249 recent secondary sales, 0 present in `topshot_pack_sales_history`**, which reads as a damning 100 % miss.

🚨 **It is not a miss. A PERFECT 0-of-249 is the same tell as a perfect correlation: check what produced it.** Both columns are 64-char lowercase hex with no `0x` prefix, so the key format is not the problem — but re-running the identical join over a window **10–20 days old, when both lanes were demonstrably healthy** (100–600 rows/day by `block_time`) gives **0 of 200**. ⭐ **Two tables that never shared a transaction when both were working do not share a definition of the event**, so `pack_purchases` cannot be a control for this lane at any date. **The control had to be validated on a period where the answer was already known** — that is what turned a headline into a deleted paragraph.

## 8 · ⚠ The one thing left genuinely open, stated as a question rather than a finding

Top Shot pack sales **by `block_time`** per day: 628 (09-03) · 519 · 128 · 352 · 169 · 152 · 176 · 158 · 132 · 118 · 91 (09-12) · **29 (09-13)** · **0 (09-14)**. That is a decline, and I have **no instrument that can say whether it is the market cooling or the lane degrading.**

⛔ **And the obvious reading — "0 today means it stopped" — is refuted by the lane's own record.** `ingested_at` is bursty by construction: **09-01 through 09-08 are eight consecutive zero-ingest days**, then 3,130 rows on 09-09. The lane last wrote at **2026-09-13 19:34Z**, so it is not dead, and a zero day is inside its observed behaviour. **No freshness defect is established here, and one should not be filed on this evidence.**

👉 **The control this needs** is an independent count of Top Shot *pack* secondary sales over the same days from a source with the same event definition — not `pack_purchases`, per §7. Until that exists, the decline is an observation, not a finding.
