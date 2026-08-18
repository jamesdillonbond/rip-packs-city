# `topshot-misattrib-drain` resolves fine but has NOT applied a re-key since 2026-08-07 — and my first severity read was 6.5x too high

Filed 2026-08-17 17:50 PT / 2026-08-18 00:50Z (Claude Code, interactive). Last of the five unwatched
zero-success pipelines from the same session's coverage audit.

## The split: resolver healthy, applier stalled

| half | state |
|---|---|
| resolve → `topshot_misattrib_onchain_map` | **48,201 rows, +888 in 2 days, newest 2026-08-17 11:00Z** — healthy |
| apply → `remap_topshot_from_onchain_map()` | `audit_topshot_sale_drain_remap_20260621` newest **2026-08-07 11:01Z**; `audit_topshot_moment_…` the same |

**The authoritative map keeps growing; nothing has been re-keyed from it in 10 days.** Every run ends
`rekey: upstream request timeout`.

⚠ **The error string is load-bearing and I nearly drew the wrong conclusion from it.** `upstream request
timeout` is the **Supabase GATEWAY** giving up (~125 s), NOT `canceling statement due to statement timeout`
from Postgres — the documented pair that produce the same duration and mean different things. Because a
gateway timeout leaves the server-side statement running, *"it probably completed and we just stopped
listening"* is a genuinely plausible read. **It is wrong here:** the audit tables are the record of what was
applied, and they stop dead at 08-07.

## ⚠ Severity: ~1%, not 6.5% — and the 6.5% was my own measurement error

First measurement: of 800 recently-mapped `nft_id`s, **52 (6.5%)** had sales pointing at an edition whose
`external_id` differs from the map's `setID:playID`.

**That was wrong by 6.5x.** Re-measured comparing only the `setID:playID` prefix:

| comparison | count |
|---|---|
| naive `external_id <> 'set:play'` | 52 |
| prefix-aware (`split_part(external_id,'::',1)`) | **8 (1.0%)** |
| rows whose `external_id` carried a `::sub` suffix | **44** |

**44 of the 52 were legitimate `::subedition` keys** that the naive equality counted as mis-keyed. This is
the documented Top Shot subedition footgun, and it inflates any check that compares an edition key by
equality rather than by prefix. ⚠ **Any future audit of edition keying must split on `'::'` first.**

**So the honest severity is: a real but small and slowly-accruing backlog (~1% of recently-mapped ids, order
a few hundred sales across the 48,201-row map), not a live crisis.** It still matters because these sales
feed edition-keyed FMV, and the backlog only grows while the applier is stalled.

## What to look at next

1. **Why `remap_topshot_from_onchain_map()` exceeds ~125 s.** The map has grown to 48,201 rows and the RPC
   appears to re-key from the FULL map every call rather than from the delta — which would make its cost
   grow monotonically with the map, i.e. it will never recover on its own. **Verify that before optimising**;
   it is a hypothesis from the timing shape, not a measurement.
2. **If it is full-map, chunk it** — a `p_limit`/cursor over unapplied rows, the same shape the sibling
   `?wmc=1` leg uses, so each call fits inside the gateway budget.
3. ⛔ **Do not raise a declared `statement_timeout` to fix this** — the bound here is the GATEWAY, not
   Postgres, so a function-level timeout change is the documented guaranteed no-op.
4. **It is on no watchlist** (one of the 5 in the coverage audit), and its `rows_written > 0` also places it
   outside the `Pipeline Success Coverage` arm's third term — so nothing would have surfaced this.
