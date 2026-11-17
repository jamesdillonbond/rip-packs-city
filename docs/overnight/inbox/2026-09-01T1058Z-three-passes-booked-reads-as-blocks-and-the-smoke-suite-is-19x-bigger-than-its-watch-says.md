> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T1058Z — three passes booked `shared_blks_read` and called it "blocks", and the #4 consumer is 19× bigger than its own post-ship watch says

**Pass:** cloud, 10:58Z fire (`58 */2`), DB `now()` 10:59:10Z = 03:59 PT. No device bridge, no push.
**Instrument:** `public.audit_20260830_pgss_snap`, diffed on the full `(userid, dbid, toplevel, queryid)` key. `pg_stat_statements.track = top`, so a top-level row's buffer counters include all nested work — the number is the whole function.

---

## The error

The standing rule is **A/B on TOTAL BUFFERS TOUCHED** — because a wall-clock ratio can be faked by a warm cache and a plan change cannot. Three consecutive passes (the 08-31 ledger ship, the 08:00Z desktop confirmation, the 10:30Z cloud confirmation) reported **`shared_blks_read` alone** under the label "blocks/call".

The tell is arithmetic, not opinion: the pre-ship figure quoted for `refresh_wmc_fmv_drift_active` is **30,993 "blocks"**, and the measured pre-ship **reads**/call is **31,603** — within 2 %. Total buffers/call over the same window is **46,773**. Likewise `analytics_smoke_run`'s quoted pre-ship "70,019 blocks" against measured pre-ship reads/call **68,849** and total buffers/call **797,943**.

## What changes when you use the right metric

### `refresh_wmc_fmv_drift_active` — same hours, same band, one day apart

`queryid 7627399264726125981` · 08-31 04:10–11:20Z vs 09-01 04:10–11:20Z (ship was 04:04:45Z on 09-01, so both windows are quiet-band and neither straddles it):

| | PRE (n=122) | POST (n=82) | |
|---|---|---|---|
| **total buffers/call** | 46,773 | **68,272** | **1.46× WORSE** |
| disk reads/call | 31,603 | **5,911** | 5.35× better |
| ms/call | 16,136 | **4,511** | 3.58× faster |

⭐ **The ship is still right and should stay.** On an instance whose top consumers are all cold reads of one table, trading 21,500 extra cache hits for 25,700 fewer disk reads and an 11.6 s latency cut is a good trade. But the booked headline — "1.87× fewer blocks" — is not true on the metric the rule names, and the exit condition ("well below 30,993") was checked against reads.

⚠ A naive whole-day PRE/POST split on this queryid gives 44,929 → 67,871 blocks/call and 16,135 → 4,770 ms/call — **but that comparison is contaminated**: the PRE window straddles the 19:30–01:00Z saturation band and the POST window is entirely quiet. Same-state buckets, above, are the honest form.

### `analytics_smoke_run` — the gate worked; the function is still enormous

`queryid 8379160562588901637` · PRE = up to the 05:17:46Z ship (n=35), POST = 05:22–11:14Z (n=11):

| | PRE | POST |
|---|---|---|
| **total buffers/call** | 797,943 | **766,544** (−3.9 %) |
| disk reads/call | 68,849 | 39,915 (−42 %) |
| ms/call | 30,724 | 25,100 (−18 %) |

The clock gate removed **~31,400 total buffers/call**, which matches the 28,862 → 310 it claimed for the drift check almost exactly. **The 08-31 entry was accurate about what it fixed.** What the post-ship watch line ("40,131 blocks/call, holding") hides is the scale of what remains:

🔥 **`analytics_smoke_run` costs 766,544 buffers and 25.1 s per call, 48×/day ≈ 36.8 M buffers and ~20 minutes of DB time per day.** `shared_buffers = 512 MB` = 65,536 buffers, so **one call touches 11.7× the entire buffer pool**. 96 % of those touches are hits, which is exactly why a reads-only view kept it looking cheap.

**Not taken this pass** — one lever per pass, and this pass's lever was the seeded-wallets reconciler. Filed as the next saturation candidate. The decomposition to do first: the function is 21 KB / 62 FROM clauses, and the 08-31 entry's editing method (read `pg_get_functiondef()`, assert the anchor appears exactly once, `EXECUTE` the result) is the only safe way to touch it.

## Transferable rules

1. **Report `read + hit`, and label reads as reads.** If a diff query selects `shared_blks_read` alone, the word "blocks" must not appear next to it.
2. **Both halves are load-bearing.** Reads measure I/O pressure; total buffers measure buffer-pool and lock work. A change can improve one and worsen the other — this one does — and only saying both makes the trade visible.
3. **Bucket PRE and POST into the same hours of day.** A whole-day split across a fix that landed at 04:05Z puts the saturation band on one side only.
