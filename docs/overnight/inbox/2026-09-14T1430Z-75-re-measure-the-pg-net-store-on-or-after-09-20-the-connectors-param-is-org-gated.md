# 🟡 #75's exit condition needs an owner that HAS Supabase MCP — the `connectors` parameter that would have fixed it is **gated at the organization level**, so this is the pickup mechanism

*Filed 2026-09-14 ~07:30 AM PT by Claude Code (cloud). **Read-only measurement + one confirmed negative about tooling.** Not a new defect — this exists so a DECISION NOT TO ACT does not become the kind nobody re-checks.*

## What #75 decided, and why it needs a re-check at all

Register **#75** is `🟢 DECIDED`: the `VACUUM FULL` on `net._http_response` is **REJECTED**, with numbers on both sides. The TOAST is a **high-water mark, not a leak** — plain vacuum made ~12.7 GB reusable without returning it to the OS, and pg_net's churn reuses it through the FSM that autovacuum now maintains. The reclaim would spend ~10 minutes of the entire instance's 22 MB/s IO budget holding `ACCESS EXCLUSIVE` on the async-HTTP backbone, to fix a disk figure nobody has costed.

**That decision is sound and this filing does not reopen it.** But CLAUDE.md is explicit that *a filed DECISION NOT TO ACT is a hypothesis too, and that is the one nobody re-checks*. #75 set an exit condition precisely so it would not be: **re-measure `pg_total_relation_size('net._http_response')` on 2026-09-20.**

## 🚨 The confirmed negative: I tried to arm it and the org blocks it

#75 recorded that it *"could not arm the re-check"* — a fresh-session Routine comes back **with no MCP connectors**, so the session firing on 09-20 would have no Supabase tool and could not take the measurement, and *"a scheduled check that fires blind is worse than none, because it reads as covered."*

⭐ **That claim is now re-verified with a sharper reason, which is the only new thing here.** `create_trigger` today exposes a **`connectors` parameter** that looks like exactly the fix. Passing `connectors: ["Supabase"]` (the connector resolves: `installState: connected`, `connected: true`, `enabledInChat: true`) returns:

> `create_trigger: the connectors parameter is not available for this organization. Omit the connectors parameter.`

⛔ **So it is not a matter of remembering to pass the parameter — it is org-gated.** A future session reading #75's "comes back with no connectors" could reasonably assume the parameter had since closed the gap and arm a blind check. **It has not.** `send_later` is no help either: it binds to THIS session, which is ephemeral and will not exist on 09-20.

## 👉 THE PICKUP — this is what the filing is FOR

**`rpc-nightly-autonomous-pass` runs in Cowork, HAS Supabase MCP, and DRAINS this directory.** That is the one mechanism on hand that satisfies both halves (fires on a schedule AND can take the measurement). #75 itself names it: *"or let the nightly pass pick it up from this item."* This filing makes that concrete rather than hopeful.

**Night pass: on or after 2026-09-20, run this and resolve #75.** Before that date, skip it — the measurement is only meaningful against a ~week-long baseline.

```sql
select pg_total_relation_size('net._http_response')                      as total_bytes,
       pg_size_pretty(pg_total_relation_size('net._http_response'))      as total_pretty,
       (select count(*) from net._http_response)                         as rows_now,
       (select min(created) from net._http_response)                     as oldest,
       (select max(created) from net._http_response)                     as newest,
       (select round(sum(pg_column_size(content))/1024.0/1024.0,1)
          from net._http_response)                                       as live_content_mb;

select relname, n_live_tup, n_dead_tup, vacuum_count, autovacuum_count, last_autovacuum
from pg_stat_all_tables
where relid = (select reltoastrelid from pg_class c
               join pg_namespace ns on ns.oid = c.relnamespace
               where ns.nspname = 'net' and c.relname = '_http_response');
```

⛔ **Do NOT run `pgstattuple` or a plain `VACUUM` on this table.** Either scans all ~13 GB on an IO-bound Small instance and **your own probe becomes the load** — CLAUDE.md records 55 s scans killing three lanes, and #75 records a plain `VACUUM` here being cancelled at the 2-minute budget. `pg_freespacemap` is not installed (checked); `pgstattuple` is, which is exactly the trap.

## 📏 Baseline — same instrument at both ends, so the delta is real

⚠ The 09-13 figure in #75 is **rounded**, so "13 GB → 13 GB" would be a delta between two imprecise stocks and proves nothing. **Measured exactly 2026-09-14 ~07:25 AM PT:**

| field | value |
|---|---|
| `pg_total_relation_size` | **13,554,974,720 bytes** (12.6 GiB) |
| rows | 3,910 |
| retention window | `oldest` 08:24Z → `newest` 14:22Z ≈ **6 h** (self-pruning, as designed) |
| live content | **522.5 MB** (avg 136.8 kB/row, max 0.66 MB) |
| parent heap / indexes | 5,272 kB / 2,672 kB — **the 13 GB is essentially ALL toast** |
| toast `pg_toast_51873` | `n_live_tup` 153,732 · `n_dead_tup` 9,838 (**6.0 %, not runaway**) |
| toast vacuum state | `vacuum_count` 1 · `autovacuum_count` 1 · `last_autovacuum` 2026-09-13 19:04Z |

⭐ **Two of #75's own stated facts have MOVED since it was filed, and both move in the direction of its decision being right:**
1. The original filing's headline defect was *"autovacuum had NEVER run on this toast"* (`autovacuum_count` 0, `last_autovacuum` NULL). **It has now run** — so the mechanism that makes the space reusable is live.
2. #75's resolution says live toast data is *"only ~300 MB inside the 13 GB file"*. Measured today by `pg_column_size(content)`: **522.5 MB**. Same order, different number — **re-derive, do not quote** (CLAUDE.md). Either way the file is ~4 % live.

## The verdict to reach on 09-20

- **≈13–14 GB ⇒ reuse is working. CLOSE #75**, stating the measured bytes and the delta from the 09-14 baseline above.
- **Materially larger (say >18 GB) ⇒ autovacuum is not keeping up.** ⛔ Do **not** run the reclaim off that reading alone — size it from a **measured** bytes/day across the two datapoints, re-open #75 with that number, and put it to Trevor. A cheaper **retention** change may beat `VACUUM FULL` entirely. ⚠ #75 records that the two written outage estimates for the reclaim **disagreed 30-fold** ("~1 min" vs "10–30 min") and neither was measured — *running it on that spread would itself have been the error.*
- **Materially smaller ⇒ something reclaimed it. Find out what** (check `vacuum_count`, and whether Supabase platform maintenance ran) before concluding. **An unexplained improvement is not a pass.**

## Scope — what this is NOT

⛔ This does not claim the store is a problem. The sentinel's `pg_net Dispatch` arm warns at ≥8 GiB and is **correctly** reporting a real 13 GB store that is simply not an emergency — a permanently-warning arm is its own defect class, and if the 09-20 reading closes #75, **consider whether that threshold should move to match the decided-acceptable size**, so the arm stops being permanently amber (CLAUDE.md: *a permanently-red or -zero instrument is indistinguishable from a broken one*).
